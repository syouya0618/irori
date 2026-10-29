#!/usr/bin/env python3
"""Exercise real two-connection races on an explicitly selected, isolated local test DB.

Only 127.0.0.1 is supported. Never point this at a shared development stack or a
production tunnel. Fixtures use random IDs and are removed even after a failure.
No Push providers are called; PGPASSWORD, if needed, belongs to the local test DB.
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


def race(held_query, contender_query, mutation=""):
    """Wait for actual PostgreSQL lock contention, then commit the competing change."""
    name = "irori-feeding-race-" + uuid.uuid4().hex
    holder = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
    contender = None
    try:
        holder.stdin.write("BEGIN; SET LOCAL ROLE service_role; " + held_query + "\n")
        holder.stdin.flush()
        if not select.select([holder.stdout], [], [], 10)[0]:
            raise AssertionError("holder did not reach the lock boundary")
        first = holder.stdout.readline().strip()
        if not first:
            raise AssertionError("holder returned no result")
        contender = subprocess.Popen(command + ["-c", "SET ROLE service_role; SET application_name='" + name + "'; " + contender_query],
                                     env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 10
        while query("SELECT count(*) FROM pg_stat_activity WHERE application_name='" + name + "' AND wait_event_type='Lock'") != "1":
            if contender.poll() is not None:
                raise AssertionError("contender did not wait on the queue lock")
            if time.monotonic() >= deadline:
                raise AssertionError("lock contention was not observed")
            time.sleep(0.025)
        holder.stdin.write(mutation + " COMMIT;\n")
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


h1, h2, user, subscription, log, newer = [str(uuid.uuid4()) for _ in range(6)]
results = []
try:
    query(f"""INSERT INTO households(id,name,feeding_interval_min) VALUES ('{h1}','feeding concurrency fixture',180),('{h2}','feeding concurrency fixture',180);
    INSERT INTO auth.users(id,email) VALUES ('{user}','feeding-race-{user}@example.com');
    UPDATE profiles SET household_id='{h1}',is_approved=true WHERE id='{user}';
    INSERT INTO notification_preferences(user_id,feeding_reminder_minutes) VALUES ('{user}',15);
    INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth) VALUES ('{subscription}','{user}','https://fcm.googleapis.com/fixture-{subscription}','fixture','fixture');
    INSERT INTO baby_logs(id,household_id,logged_by,log_type,feeding_type,amount_ml,logged_at) VALUES ('{log}','{h1}','{user}','feeding','bottle',100,now()-interval '166 minutes');""")
    logged = query(f"SELECT logged_at FROM baby_logs WHERE id='{log}'")
    scheduled = query(f"SELECT date_trunc('milliseconds',logged_at)+interval '165 minutes' FROM baby_logs WHERE id='{log}'")
    enqueue = f"SELECT enqueue_feeding_delivery('{h1}','{log}','{subscription}','{scheduled}');"
    first, second = race(enqueue, enqueue)
    assert first == second and first, (first, second)
    delivery = first
    results.append({"scenario": "concurrent enqueue", "one_row": True})
    claim = f"SELECT claim_feeding_delivery('{delivery}','{logged}',180,15,'{scheduled}');"
    first, second = race(claim, claim)
    assert (first, second) == ("t", "f"), (first, second)
    results.append({"scenario": "concurrent claim", "results": [first, second]})
    changes = {
        "new nursing during lock wait": f"INSERT INTO baby_logs(id,household_id,logged_by,log_type,feeding_type,amount_ml,logged_at) VALUES ('{newer}','{h1}','{user}','feeding','bottle',100,'{logged}'::timestamptz+interval '30 minutes');",
        "OFF during lock wait": f"UPDATE notification_preferences SET feeding_reminder_minutes=NULL WHERE user_id='{user}';",
        "lead change during lock wait": f"UPDATE notification_preferences SET feeding_reminder_minutes=10 WHERE user_id='{user}';",
        "household move during lock wait": f"UPDATE profiles SET household_id='{h2}' WHERE id='{user}';",
    }
    for scenario, mutation in changes.items():
        query(f"DELETE FROM baby_logs WHERE id='{newer}'; UPDATE notification_deliveries SET sent_at=NULL WHERE id='{delivery}'; UPDATE notification_preferences SET feeding_reminder_minutes=15 WHERE user_id='{user}'; UPDATE profiles SET household_id='{h1}' WHERE id='{user}';")
        first, second = race(f"SELECT id FROM notification_deliveries WHERE id='{delivery}' FOR UPDATE;", claim, mutation)
        assert first == delivery and second == "f", (scenario, first, second)
        results.append({"scenario": scenario, "claim": second, "lock_wait_observed": True})
    assert query(f"SELECT count(*) FROM notification_deliveries WHERE kind='feeding' AND event_key='{log}'") == "1"
    print(json.dumps({"host": "127.0.0.1", "port": args.port, "database": args.database,
                      "passed": len(results), "results": results}, indent=2))
finally:
    # All deletes are restricted to the random IDs created above, never general tables.
    query(f"DELETE FROM households WHERE id IN ('{h1}','{h2}'); DELETE FROM auth.users WHERE id='{user}';")
