#!/usr/bin/env bash
# Probe the Supabase Postgres image for the supautils EXECUTE-denial crash, on a disposable DB only.
#
# supautils 3.2.0 / 3.2.1 (bundled in supabase/postgres 17.6.1.099-.112, including the CLI 2.101.0
# default 17.6.1.106) crash the backend with SIGSEGV instead of raising 42501 when a role listed in
# supautils.hint_roles calls a function it has no EXECUTE on. The crash takes the whole instance into
# recovery. Upstream: supabase/postgres#2112, supabase/supautils#214, fixed by supabase/supautils#190
# (3.2.2).
#
# A different supautils bug crashes GRANT/REVOKE <role> with a CURRENT_USER, SESSION_USER or PUBLIC
# grantee run by a non-superuser such as the image's postgres (supabase/supautils#205 and #207; tag v3.2.3
# points at the #205 merge commit, and #207 still reproduced it on 17.6.1.147). The probe must not trip it
# while preparing, so the fixture names its member ("postgres", the role this script connects as) and never
# uses those keywords.
#
#   scripts/test-db-execute-denial.sh --container supabase_db_irori --expect clean
#   scripts/test-db-execute-denial.sh --image supabase/postgres@sha256:<digest> --expect crash|clean
#
# Fixture: a NOLOGIN role outside hint_roles granted to postgres, and a trivial SQL function with EXECUTE
# revoked from PUBLIC and every probed role; has_function_privilege must confirm both before any call.
# Each probed role then calls the function in a session of its own:
#   denied: SQLSTATE 42501, the same session keeps working, the server log gains this denial (so the log
#           is live and "no crash" is an observation) and no "terminated by signal" line.
#   crash:  the session is lost after becoming the role, and the server log reports this backend's PID
#           terminated by signal 11 together with the call as the statement it was running.
# Before PASS, the server log since the first probe must hold exactly the expected crashes.
#
# --image starts a throwaway container from that exact digest and removes it on exit; only --image may
# expect a crash. Its fixture is committed by a session of its own first, so a crash while preparing fails
# as "fixture" and can never pass for the crash being probed; the calls follow in separate sessions and a
# last session drops the fixture again.
# --container probes an already running isolated local stack and always expects clean. There every session
# builds the fixture inside one transaction, calls and rolls back: nothing is ever committed, so nothing can
# persist even if the database crashes or the script is killed. After each passing session the script also
# confirms that no probe role or function is left. Never point this at a shared, linked or hosted database.
# clean: denied for irori_execute_denial_plain, anon, authenticated and service_role.
# crash: denied for irori_execute_denial_plain (the control outside hint_roles), crash for anon and
#        authenticated.
set -euo pipefail

usage() {
  echo "usage: $0 (--container NAME | --image supabase/postgres@sha256:DIGEST) --expect clean|crash" >&2
  exit 2
}

container=""
image=""
expect=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --container | --image | --expect)
      [ "$#" -ge 2 ] || usage
      case "$1" in
        --container) container="$2" ;;
        --image) image="$2" ;;
        --expect) expect="$2" ;;
      esac
      shift 2
      ;;
    *) usage ;;
  esac
done

if [ -n "$container" ] && [ -n "$image" ]; then usage; fi
if [ -z "$container" ] && [ -z "$image" ]; then usage; fi
case "$expect" in clean | crash) ;; *) usage ;; esac
if [ -n "$container" ] && ! [[ "$container" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then usage; fi
if [ -n "$image" ] && ! [[ "$image" =~ ^supabase/postgres@sha256:[0-9a-f]{64}$ ]]; then usage; fi
if [ "$expect" = "crash" ] && [ -z "$image" ]; then
  echo "probe: --expect crash is only allowed with --image (a throwaway container)" >&2
  exit 2
fi

# Both modes run these inside an open transaction.
FIXTURE_STATEMENTS="$(cat <<'SQL'
CREATE ROLE irori_execute_denial_plain NOLOGIN;
GRANT irori_execute_denial_plain TO postgres;
CREATE FUNCTION public.irori_execute_denial_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';
REVOKE ALL ON FUNCTION public.irori_execute_denial_probe()
  FROM PUBLIC, anon, authenticated, service_role, irori_execute_denial_plain;
SQL
)"
FIXTURE_STATE="$(cat <<'SQL'
SELECT 'irori-probe-fixture:'
  || string_agg(r || '=' || has_function_privilege(r, 'public.irori_execute_denial_probe()', 'EXECUTE')::text, ',' ORDER BY r)
  || ',postgres_can_set_role=' || pg_has_role('postgres', 'irori_execute_denial_plain', 'SET')::text
  FROM unnest(ARRAY['anon', 'authenticated', 'irori_execute_denial_plain', 'service_role']::name[]) AS r;
SQL
)"
FIXTURE_EXPECTED="irori-probe-fixture:anon=false,authenticated=false,irori_execute_denial_plain=false,service_role=false,postgres_can_set_role=true"
CALL_STATEMENTS="$(cat <<'SQL'
SET LOCAL ROLE :"probe_role";
SELECT 'irori-probe-as:' || current_user;
SELECT public.irori_execute_denial_probe();
SQL
)"
LEFT_QUERY="SELECT 'irori-probe-left:' || ((SELECT count(*) FROM pg_proc WHERE proname = 'irori_execute_denial_probe') + (SELECT count(*) FROM pg_roles WHERE rolname = 'irori_execute_denial_plain'))"

# --image: the fixture session commits, each call session rolls back only its own call, teardown drops.
FIXTURE_SQL="$(printf '%s\n' '\set VERBOSITY verbose' 'BEGIN;' "$FIXTURE_STATEMENTS" 'COMMIT;' \
  "SELECT 'irori-probe-fixture-committed';" "$FIXTURE_STATE")"
CALL_SQL="$(printf '%s\n' '\set VERBOSITY verbose' "SELECT 'irori-probe-pid:' || pg_backend_pid();" 'BEGIN;' \
  "$CALL_STATEMENTS" 'ROLLBACK;' "SELECT 'irori-probe-session-alive';")"
TEARDOWN_SQL="$(printf '%s\n' '\set VERBOSITY verbose' 'BEGIN;' 'DROP FUNCTION public.irori_execute_denial_probe();' \
  'DROP ROLE irori_execute_denial_plain;' 'COMMIT;' "$LEFT_QUERY;")"
# --container: one transaction builds the fixture, calls and rolls back; nothing is ever committed.
ROLLBACK_SQL="$(printf '%s\n' '\set VERBOSITY verbose' "SELECT 'irori-probe-pid:' || pg_backend_pid();" 'BEGIN;' \
  "$FIXTURE_STATEMENTS" "$FIXTURE_STATE" "$CALL_STATEMENTS" 'ROLLBACK;' "SELECT 'irori-probe-session-alive';")"

started=""
errfile="$(mktemp)"
cleanup() {
  rm -f "$errfile"
  if [ -n "$started" ]; then
    docker rm -f "$started" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

fail() {
  echo "probe: FAIL: $*" >&2
  exit 1
}

if [ -n "$image" ]; then
  container="irori-execute-denial-probe-$$-${RANDOM}"
  # Throwaway fixture password for a container that never leaves this runner; not a hosted credential.
  docker run -d --name "$container" -e POSTGRES_PASSWORD=postgres "$image" >/dev/null
  started="$container"
fi

psql_in() {
  docker exec -i "$container" psql -X -qAt -U postgres -d postgres "$@"
}

# The server log is the postmaster's stderr (the image sets logging_collector = off). Checks only look at
# the lines after a mark taken when their step began. Variables are matched with here-strings, not
# `printf | grep -q`, so that pipefail cannot turn an early grep exit into a false failure.
server_log() {
  docker logs "$container" 2>&1
}

log_mark() {
  local logs
  logs="$(server_log)" || fail "cannot read the server log of $container"
  if [ -z "$logs" ]; then echo 0; else wc -l <<<"$logs" | tr -d ' '; fi
}

log_since() {
  local logs
  logs="$(server_log)" || fail "cannot read the server log of $container"
  if [ -n "$logs" ]; then tail -n "+$(($1 + 1))" <<<"$logs"; fi
}

# $1: mark, $2: psql status. psql exits 2 when the connection is lost: then give the crash line time to
# reach the log before anything reports on it.
log_since_settled() {
  local new deadline
  new="$(log_since "$1")"
  if [ "$2" -eq 2 ]; then
    deadline=$((SECONDS + 15))
    while ! grep -q 'terminated by signal' <<<"$new" && [ "$SECONDS" -lt "$deadline" ]; do
      sleep 1
      new="$(log_since "$1")"
    done
  fi
  printf '%s\n' "$new"
}

# A --container stack may hold other sessions' statements, so only the count is printed there. A
# throwaway --image container runs nothing but this probe, so its crash lines (with the statement that was
# running) are printed in full.
report_crashes() {
  local new="$1" count
  count="$(grep -c 'terminated by signal' <<<"$new" || true)"
  echo "probe:   server log: $count backend crash line(s) in this step" >&2
  if [ -n "$started" ] && [ "$count" != 0 ]; then
    grep -E 'terminated by signal|Failed process was running' <<<"$new" | sed 's/^/probe:   /' >&2 || true
  fi
}

wait_ready() {
  local deadline=$((SECONDS + 240)) health ready
  while :; do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    ready=""
    # The image's HEALTHCHECK (and the CLI's) uses TCP pg_isready, which the entrypoint's init-time
    # temporary server (listen_addresses='') never answers, so "healthy" means the final server.
    if [ "$health" = "healthy" ] || [ "$health" = "none" ]; then
      ready="$(psql_in -c "SELECT (NOT pg_is_in_recovery() AND (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) = 3)::text" 2>/dev/null || true)"
    fi
    if [ "$ready" = "true" ]; then
      return 0
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      docker logs --tail 40 "$container" >&2 || true
      fail "database in $container did not become ready (health=$health)"
    fi
    sleep 2
  done
}

# --image only: commit the fixture in a session of its own, so that preparing and calling never share one.
setup_fixture() {
  local mark out status new
  mark="$(log_mark)"
  set +e
  out="$(printf '%s\n' "$FIXTURE_SQL" | psql_in -v ON_ERROR_STOP=1 2>"$errfile")"
  status=$?
  set -e
  new="$(log_since_settled "$mark" "$status")"
  if [ "$status" -ne 0 ] || ! grep -Fqx 'irori-probe-fixture-committed' <<<"$out"; then
    cat "$errfile" >&2
    report_crashes "$new"
    case "$status" in
      2) fail "fixture: the connection was lost while preparing, before any EXECUTE call; this is not the crash being probed" ;;
      3) fail "fixture: a preparing statement failed, before any EXECUTE call" ;;
      *) fail "fixture: preparing did not complete (status $status)" ;;
    esac
  fi
  if grep -q 'terminated by signal' <<<"$new"; then
    report_crashes "$new"
    fail "fixture: a backend crashed while preparing; this is not the crash being probed"
  fi
  grep -Fqx "$FIXTURE_EXPECTED" <<<"$out" ||
    fail "fixture: EXECUTE is not revoked as intended, or postgres cannot become irori_execute_denial_plain ($(grep '^irori-probe-fixture:' <<<"$out" || echo 'no fixture state'))"
  echo "probe: fixture committed: no probed role has EXECUTE, and postgres can become irori_execute_denial_plain"
}

# $1: role to become; $2: denied | crash
call_as() {
  local role="$1" want="$2" sql mark out status pid new pair deadline
  if [ -n "$started" ]; then sql="$CALL_SQL"; else sql="$ROLLBACK_SQL"; fi
  mark="$(log_mark)"
  set +e
  out="$(printf '%s\n' "$sql" | psql_in -v ON_ERROR_STOP=0 -v probe_role="$role" 2>"$errfile")"
  status=$?
  set -e
  pid="$(sed -n 's/^irori-probe-pid:\([0-9][0-9]*\)$/\1/p' <<<"$out")"
  if [ -z "$pid" ]; then
    cat "$errfile" >&2
    new="$(log_since_settled "$mark" "$status")"
    report_crashes "$new"
    fail "$role: the probe session did not start (status $status)"
  fi
  # --container builds the fixture in this same transaction, before becoming the role. Without the expected
  # state (or with a crash while preparing) the call proves nothing, and it is reported as a fixture failure.
  if [ -z "$started" ] && ! grep -Fqx "$FIXTURE_EXPECTED" <<<"$out"; then
    cat "$errfile" >&2
    new="$(log_since_settled "$mark" "$status")"
    report_crashes "$new"
    fail "$role: the fixture was not prepared as intended in this session (status $status; $(grep '^irori-probe-fixture:' <<<"$out" || echo 'no fixture state')), so the EXECUTE call does not count"
  fi
  if ! grep -Fqx "irori-probe-as:$role" <<<"$out"; then
    cat "$errfile" >&2
    new="$(log_since_settled "$mark" "$status")"
    report_crashes "$new"
    fail "$role: the call session did not become $role (status $status), so the EXECUTE call was never reached"
  fi
  if [ "$want" = "denied" ]; then
    if [ "$status" -ne 0 ] || ! grep -Fqx 'irori-probe-session-alive' <<<"$out" ||
      ! grep -q '42501: permission denied for function irori_execute_denial_probe' "$errfile"; then
      cat "$errfile" >&2
      new="$(log_since_settled "$mark" "$status")"
      report_crashes "$new"
      fail "$role: expected SQLSTATE 42501 with the session kept (status $status, backend $pid)"
    fi
    # The server logs the denial. Seeing it proves this log is live, so the missing crash line below is an
    # observation rather than a log that could not be read.
    deadline=$((SECONDS + 15))
    while :; do
      new="$(log_since "$mark")"
      if grep -q 'permission denied for function irori_execute_denial_probe' <<<"$new"; then break; fi
      [ "$SECONDS" -lt "$deadline" ] ||
        fail "$role: the server log never showed this denial, so it could not show a crash either"
      sleep 1
    done
    if grep -q 'terminated by signal' <<<"$new"; then
      report_crashes "$new"
      fail "$role: a backend crashed while $role was refused"
    fi
    echo "probe: ok: $role is refused with 42501; its session and the server stay up (backend $pid)"
    return 0
  fi
  if [ "$status" -eq 0 ] || grep -Fqx 'irori-probe-session-alive' <<<"$out" ||
    ! grep -Eq 'server closed the connection unexpectedly|connection to server was lost' "$errfile"; then
    cat "$errfile" >&2
    fail "$role: expected the known supautils crash, but the session was not lost (status $status)"
  fi
  # Attribute the crash: this backend's PID with signal 11, and, in the DETAIL line the postmaster writes
  # right after it, the call as the statement that backend was running.
  deadline=$((SECONDS + 30))
  while :; do
    new="$(log_since "$mark")"
    pair="$(grep -A1 -F "server process (PID $pid) was terminated by signal 11" <<<"$new" || true)"
    if grep -Fq 'Failed process was running: SELECT public.irori_execute_denial_probe(' <<<"$pair"; then break; fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      report_crashes "$new"
      fail "$role: the session was lost, but the server log does not show backend $pid terminated by signal 11 while calling the function"
    fi
    sleep 1
  done
  echo "probe: ok: $role crashes its backend $pid with signal 11 on the denied call, as upstream reports for this image"
  wait_ready
}

# --container only: nothing of the fixture may outlive a session.
assert_nothing_left() {
  local left
  left="$(psql_in -c "$LEFT_QUERY")" || fail "cannot read whether the $1 session left anything in $container"
  [ "$left" = "irori-probe-left:0" ] || fail "the $1 session left the probe role or function in $container ($left)"
}

# --image only.
teardown_fixture() {
  local out status
  set +e
  out="$(printf '%s\n' "$TEARDOWN_SQL" | psql_in -v ON_ERROR_STOP=1 2>"$errfile")"
  status=$?
  set -e
  if [ "$status" -ne 0 ] || ! grep -Fqx 'irori-probe-left:0' <<<"$out"; then
    cat "$errfile" >&2
    fail "teardown: the fixture is still in $container (status $status)"
  fi
  echo "probe: fixture removed; neither irori_execute_denial_plain nor irori_execute_denial_probe() is left"
}

wait_ready

# Preconditions: without supautils and its hint_roles the probe would not reach the crash path at all, and
# the fixture grants its role to postgres by name, so the probe has to run as postgres.
runtime="$(psql_in -c "SELECT version()" -c "SHOW session_preload_libraries" -c "SHOW supautils.hint_roles" \
  -c "SELECT current_user || ' superuser=' || rolsuper::text FROM pg_roles WHERE rolname = current_user")" ||
  fail "cannot read the runtime settings"
echo "probe: runtime of $container"
printf '%s\n' "$runtime" | sed 's/^/probe:   /'
docker inspect --format 'probe:   image={{.Config.Image}} image_id={{.Image}}' "$container"
# PostgreSQL 17 builds of supautils carry no version in the module magic (PG_MODULE_MAGIC_EXT is 18+),
# so record which library file is loaded; the version itself comes from the image's nix/ext/supautils.nix.
docker exec "$container" sh -c 'for f in $(find /nix/store -maxdepth 3 -name supautils.so 2>/dev/null); do echo "$(sha256sum "$f" | cut -c1-64) $(readlink -f "$f")"; done' 2>/dev/null |
  sed 's/^/probe:   supautils.so sha256=/' || echo "probe:   supautils.so: not inspected"
preload="$(sed -n '2p' <<<"$runtime")"
hint_roles="$(sed -n '3p' <<<"$runtime")"
session_role="$(sed -n '4p' <<<"$runtime")"
[[ "$preload" == *supautils* ]] || fail "supautils is not in session_preload_libraries ($preload)"
[[ "$hint_roles" == *anon* && "$hint_roles" == *authenticated* ]] ||
  fail "supautils.hint_roles does not list anon and authenticated ($hint_roles)"
[[ "$session_role" == "postgres superuser="* ]] || fail "the probe must connect as postgres ($session_role)"

start_mark="$(log_mark)"
expected_crashes=0
if [ -n "$started" ]; then setup_fixture; fi
if [ "$expect" = "clean" ]; then
  for role in irori_execute_denial_plain anon authenticated service_role; do
    call_as "$role" denied
    if [ -z "$started" ]; then assert_nothing_left "$role"; fi
  done
else
  call_as irori_execute_denial_plain denied
  call_as anon crash
  call_as authenticated crash
  expected_crashes=2
fi
if [ -n "$started" ]; then teardown_fixture; fi
# Every backend crash logged since the first probe must be one of the attributed ones.
new="$(log_since "$start_mark")"
crashes="$(grep -c 'terminated by signal' <<<"$new" || true)"
if [ "$crashes" != "$expected_crashes" ]; then
  report_crashes "$new"
  fail "the server log since the first probe holds $crashes backend crash line(s); expected $expected_crashes"
fi
echo "probe: PASS ($expect)"
