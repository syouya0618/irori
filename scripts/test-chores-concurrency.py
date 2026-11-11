#!/usr/bin/env python3
"""Exercise real two-connection races on the chores RPCs, on an explicitly selected, isolated local test DB.

Only 127.0.0.1 is supported. Never point this at a shared development stack or a production
tunnel. Fixtures use random IDs and are removed even after a failure.

Unlike scripts/test-feeding-reminder-concurrency.py (service_role internals), every RPC here runs
as `authenticated` with a member's JWT claims, exactly like PostgREST: the chores RPCs authorize by
auth.uid(), take a household advisory lock, and must decide replay / conflict / already_closed
themselves. The second connection is observed waiting on that lock (pg_stat_activity) before the
first one commits, so the result is a real race, not two sequential calls.
"""
import argparse
import json
import os
import re
import select
import shutil
import subprocess
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, required=True)
parser.add_argument("--database", default="postgres")
args = parser.parse_args()
if not 1024 <= args.port <= 65535 or not re.fullmatch(r"[a-zA-Z0-9_]+", args.database):
    parser.error("invalid local port or database")
psql = shutil.which("psql")
if not psql:
    raise SystemExit("psql is required")
command = [psql, "-X", "-qAt", "-h", "127.0.0.1", "-p", str(args.port),
           "-U", "postgres", "-d", args.database, "-v", "ON_ERROR_STOP=1"]
env = {"PATH": os.environ.get("PATH", ""), "PGCONNECT_TIMEOUT": "5", "PGTZ": "UTC"}
if "PGPASSWORD" in os.environ:
    env["PGPASSWORD"] = os.environ["PGPASSWORD"]


def query(sql):
    result = subprocess.run(command + ["-c", sql], env=env, capture_output=True, text=True, timeout=15)
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


def as_user(user, local=False):
    """Become `authenticated` with this member's JWT claims (what PostgREST does per request)."""
    claims = json.dumps({"sub": user, "role": "authenticated"})
    scope = "LOCAL " if local else ""
    return f"SET {scope}ROLE authenticated; SET {scope}\"request.jwt.claims\" TO '{claims}'; "


def call(user, sql):
    return query(as_user(user) + sql)


def race(holder_user, held_query, contender_user, contender_query):
    """Run held_query in an open transaction, wait until the contender blocks on a lock, then commit."""
    name = "irori-chores-race-" + uuid.uuid4().hex
    holder = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    contender = None
    try:
        holder.stdin.write("BEGIN; " + as_user(holder_user, local=True) + held_query + "\n")
        holder.stdin.flush()
        if not select.select([holder.stdout], [], [], 10)[0]:
            raise AssertionError("holder did not reach the lock boundary")
        first = holder.stdout.readline().strip()
        if not first:
            raise AssertionError("holder returned no result: " + holder.stderr.read())
        contender = subprocess.Popen(
            command + ["-c", f"SET application_name='{name}'; " + as_user(contender_user) + contender_query],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while query(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event_type='Lock'") != "1":
            if contender.poll() is not None:
                raise AssertionError("contender finished without waiting on the household lock: "
                                     + contender.stdout.read() + contender.stderr.read())
            if time.monotonic() >= deadline:
                raise AssertionError("lock contention was not observed")
            time.sleep(0.025)
        holder.stdin.write("COMMIT;\n")
        holder.stdin.close()
        holder.wait(timeout=10)
        stdout, stderr = contender.communicate(timeout=10)
        if holder.returncode or contender.returncode:
            raise RuntimeError(holder.stderr.read() + stderr)
        return first, stdout.strip()
    finally:
        for process in (holder, contender):
            if process is not None and process.poll() is None:
                process.terminate()
                process.wait(timeout=5)


def today_jst():
    return query("SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date")


household, owner, member = [str(uuid.uuid4()) for _ in range(3)]
results = []
try:
    query(f"""INSERT INTO households(id,name) VALUES ('{household}','chores concurrency fixture');
    INSERT INTO auth.users(id,email) VALUES ('{owner}','chores-race-{owner}@example.com'),('{member}','chores-race-{member}@example.com');
    UPDATE profiles SET household_id='{household}',is_approved=true,role='owner' WHERE id='{owner}';
    UPDATE profiles SET household_id='{household}',is_approved=true,role='member' WHERE id='{member}';""")
    today = today_jst()

    # ── 掃除: 2 人が同じ回を同時に完了しても、有効な履歴は 1 行（後着は already_closed と先着の行） ──
    routine = str(uuid.uuid4())
    version = call(owner, f"SELECT save_cleaning_routine('{routine}',NULL,'synthetic race drain',NULL,'week',1,'fixed','{today}',false)->'routine'->>'updated_at'")
    first_log, second_log = str(uuid.uuid4()), str(uuid.uuid4())
    done = "SELECT r->>'status' || '|' || coalesce(r->'log'->>'id','') FROM (SELECT record_cleaning_log('{id}','{routine}','{version}','done','{today}','{today}',NULL) r) s;"
    first, second = race(owner, done.format(id=first_log, routine=routine, version=version, today=today),
                         member, done.format(id=second_log, routine=routine, version=version, today=today))
    assert first == f"saved|{first_log}", first
    assert second == f"already_closed|{first_log}", second
    valid = query(f"SELECT count(*) FROM cleaning_logs WHERE routine_id='{routine}' AND occurrence='{today}' AND voided_at IS NULL")
    assert valid == "1", valid
    assert query(f"SELECT count(*) FROM cleaning_logs WHERE id='{second_log}'") == "0"
    results.append({"scenario": "cleaning: concurrent completion of one occurrence", "first": "saved", "second": "already_closed", "valid_rows": 1})

    # ── 掃除: 取り消し中の回を家族が完了しようとした（取り消しの確定後は新しい完了が通る） ──
    log_version = query(f"SELECT updated_at FROM cleaning_logs WHERE id='{first_log}'")
    third_log = str(uuid.uuid4())
    first, second = race(owner, f"SELECT void_cleaning_log('{first_log}','{log_version}')->>'status';",
                         member, done.format(id=third_log, routine=routine, version=version, today=today))
    assert (first, second) == ("saved", f"saved|{third_log}"), (first, second)
    assert query(f"SELECT count(*) FROM cleaning_logs WHERE routine_id='{routine}' AND occurrence='{today}' AND voided_at IS NULL") == "1"
    results.append({"scenario": "cleaning: completion while the occurrence is being voided", "void": first, "completion": "saved", "valid_rows": 1})

    # ── 掃除: 同じ版を見て 2 人が同時に名前を変えた。後着は conflict で、先着の変更を上書きしない ──
    rename = "SELECT save_cleaning_routine('{routine}','{version}','{name}',NULL,'week',1,'fixed','{today}',false)->>'status';"
    first, second = race(owner, rename.format(routine=routine, version=version, name="synthetic race first", today=today),
                         member, rename.format(routine=routine, version=version, name="synthetic race second", today=today))
    assert (first, second) == ("saved", "conflict"), (first, second)
    assert query(f"SELECT name FROM cleaning_routines WHERE id='{routine}'") == "synthetic race first"
    results.append({"scenario": "cleaning: stale version during a concurrent rename", "first": first, "second": second})

    # ── ごはん: 必要 500g・購入 300g → 作った → 別端末の +100g と「作った」の取り消しが同時 → 不足 100g ──
    entry = str(uuid.uuid4())
    def entry_payload(status):
        return json.dumps({"plan_date": today, "role": "main", "position": 0, "recipe_id": None, "recipe_version": None,
                           "custom_title": "synthetic race curry", "custom_ingredients": None, "servings": 2,
                           "pinned": False, "status": status, "origin": "manual"})

    def revision():
        return query(f"SELECT revision FROM dinner_plan_state WHERE household_id='{household}'")

    def entry_version():
        return query(f"SELECT updated_at FROM dinner_plan_entries WHERE id='{entry}'")

    def grocery(column):
        return query(f"SELECT {column} FROM grocery_items WHERE household_id='{household}' AND item_key='synthetic_onion|g'")

    def items(needed):
        if not needed:
            return "[]"
        return json.dumps([{"item_key": "synthetic_onion|g", "ingredient_id": "synthetic_onion", "name": "synthetic onion",
                            "required_quantity": 500, "unit": "g", "required_note": None, "needs_stock_check": False,
                            "sources": [{"date": today, "recipeId": None, "title": "synthetic race curry",
                                         "quantity": {"amount": 500, "unit": "g"}, "entryId": entry, "buy": 500}]}])

    def sync(user, needed, operation=None):
        operation = operation or str(uuid.uuid4())
        return call(user, f"SELECT sync_grocery_auto_items('{operation}',{revision()},'{items(needed)}'::jsonb)->>'status'")

    def remaining():
        return query(f"SELECT required_quantity - greatest(purchased_quantity - restocked_quantity - consumed_quantity, 0) "
                     f"FROM grocery_items WHERE household_id='{household}' AND item_key='synthetic_onion|g'")

    assert call(owner, f"SELECT save_dinner_entry('{entry}',NULL,'{entry_payload('confirmed')}'::jsonb)->>'status'") == "saved"
    assert sync(owner, True) == "saved"
    grocery_id = grocery("id")
    assert call(owner, f"SELECT set_grocery_purchase('{grocery_id}','{grocery('updated_at')}',300,false)->>'status'") == "saved"
    assert float(remaining()) == 200, remaining()
    assert call(owner, f"SELECT save_dinner_entry('{entry}','{entry_version()}','{entry_payload('cooked')}'::jsonb)->>'status'") == "saved"
    assert sync(owner, False) == "saved"
    assert (float(grocery("purchased_quantity")), float(grocery("consumed_quantity"))) == (300, 300), "cooking must not rewrite the purchase"

    buy_more = f"SELECT set_grocery_purchase('{grocery_id}','{grocery('updated_at')}',400,false)->>'status';"
    undo = f"SELECT save_dinner_entry('{entry}','{entry_version()}','{entry_payload('confirmed')}'::jsonb)->>'status';"
    first, second = race(member, buy_more, owner, undo)
    assert (first, second) == ("saved", "saved"), (first, second)
    resync = str(uuid.uuid4())
    assert sync(owner, True, resync) == "saved"
    assert float(grocery("purchased_quantity")) == 400, grocery("purchased_quantity")
    assert float(grocery("consumed_quantity")) == 0, grocery("consumed_quantity")
    assert float(remaining()) == 100, remaining()
    assert sync(owner, True, resync) == "replayed"
    assert sync(owner, True) == "saved"
    assert (float(grocery("purchased_quantity")), float(grocery("consumed_quantity")), float(remaining())) == (400, 0, 100), \
        "a second undo / resync must not restore the purchase twice"
    results.append({"scenario": "dinner: +100g purchase on another device while undoing 作った",
                    "purchase_fact_g": 400, "consumed_g": 0, "shortage_g": 100, "double_undo": "no change"})

    # ── ごはん: 作った後の同期と、同期前の版で送った購入（+100g）が同時。その間に変わったのは必要量と充当だけで、
    #    購入の事実は変わっていないので購入は通る。充当（作った時に記録済みの 400g）は壊さない ──
    assert call(owner, f"SELECT save_dinner_entry('{entry}','{entry_version()}','{entry_payload('cooked')}'::jsonb)->>'status'") == "saved"
    assert (float(grocery("purchased_quantity")), float(grocery("consumed_quantity"))) == (400, 400), \
        "cooking records the use at once, without waiting for a sync"
    stale_version = grocery("updated_at")
    first, second = race(owner, f"SELECT sync_grocery_auto_items('{uuid.uuid4()}',{revision()},'[]'::jsonb)->>'status';",
                         member, f"SELECT set_grocery_purchase('{grocery_id}','{stale_version}',500,false)->>'status';")
    assert (first, second) == ("saved", "saved"), (first, second)
    assert (float(grocery("purchased_quantity")), float(grocery("consumed_quantity"))) == (500, 400), \
        (grocery("purchased_quantity"), grocery("consumed_quantity"))
    results.append({"scenario": "dinner: purchase from a pre-sync screen during a concurrent post-cooking sync",
                    "sync": first, "purchase": second, "purchase_fact_g": 500, "consumed_g": 400})

    # ── ごはん: 同じ版を見た 2 人が同時に購入の合計を送った。後着は conflict で、先着の購入を上書きしない ──
    shared_version = grocery("updated_at")
    first, second = race(owner, f"SELECT set_grocery_purchase('{grocery_id}','{shared_version}',600,false)->>'status';",
                         member, f"SELECT set_grocery_purchase('{grocery_id}','{shared_version}',700,false)->>'status';")
    assert (first, second) == ("saved", "conflict"), (first, second)
    assert float(grocery("purchased_quantity")) == 600, grocery("purchased_quantity")
    results.append({"scenario": "dinner: two purchases from the same screen version", "first": first, "second": second})

    print(json.dumps({"host": "127.0.0.1", "port": args.port, "database": args.database,
                      "passed": len(results), "results": results}, indent=2, ensure_ascii=False))
finally:
    # All deletes are restricted to the random IDs created above, never general tables.
    query(f"DELETE FROM households WHERE id='{household}'; DELETE FROM auth.users WHERE id IN ('{owner}','{member}');")
