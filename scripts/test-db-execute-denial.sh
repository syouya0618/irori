#!/usr/bin/env bash
# Probe the Supabase Postgres image for the supautils EXECUTE-denial crash, on a disposable DB only.
#
# supautils 3.2.0 / 3.2.1 (bundled in supabase/postgres 17.6.1.099-.112, including the CLI 2.101.0
# default 17.6.1.106) crash the backend with SIGSEGV instead of raising 42501 when a role listed in
# supautils.hint_roles calls a function it has no EXECUTE on. The crash takes the whole instance into
# recovery. Upstream: supabase/postgres#2112, supabase/supautils#214, fixed by supabase/supautils#190.
#
#   scripts/test-db-execute-denial.sh --container supabase_db_irori --expect clean
#   scripts/test-db-execute-denial.sh --image supabase/postgres@sha256:<digest> --expect crash|clean
#
# --image starts a throwaway container from that exact digest and removes it on exit. Only --image may
# expect a crash: never crash a database this script did not create.
# --container probes an already running isolated local stack. Each probe runs in one transaction that is
# rolled back, so no function or role is left behind for the pgTAP suite.
# Never point this at a shared, linked or hosted database.
#
# Every probe creates a trivial SQL function, revokes EXECUTE from PUBLIC and the probed roles, becomes
# one role and calls it:
#   clean: anon, authenticated, service_role and a role outside hint_roles all get SQLSTATE 42501, the
#          same session keeps working, and the server log gains no "terminated by signal" line.
#   crash: the role outside hint_roles still gets 42501 (control), while anon and authenticated lose the
#          connection and the server log gains "terminated by signal 11".
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

signal_count() {
  local logs
  logs="$(docker logs "$container" 2>&1)" || fail "cannot read the server log of $container"
  printf '%s\n' "$logs" | grep -c 'terminated by signal' || true
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

wait_ready

# Preconditions: without supautils and its hint_roles the probe would not reach the crash path at all.
runtime="$(psql_in -c "SELECT version()" -c "SHOW session_preload_libraries" -c "SHOW supautils.hint_roles")" ||
  fail "cannot read the runtime settings"
echo "probe: runtime of $container"
printf '%s\n' "$runtime" | sed 's/^/probe:   /'
docker inspect --format 'probe:   image={{.Config.Image}} image_id={{.Image}}' "$container"
# PostgreSQL 17 builds of supautils carry no version in the module magic (PG_MODULE_MAGIC_EXT is 18+),
# so record which library file is loaded; the version itself comes from the image's nix/ext/supautils.nix.
docker exec "$container" sh -c 'for f in $(find /nix/store -maxdepth 3 -name supautils.so 2>/dev/null); do echo "$(sha256sum "$f" | cut -c1-64) $(readlink -f "$f")"; done' 2>/dev/null |
  sed 's/^/probe:   supautils.so sha256=/' || echo "probe:   supautils.so: not inspected"
preload="$(printf '%s\n' "$runtime" | sed -n '2p')"
hint_roles="$(printf '%s\n' "$runtime" | sed -n '3p')"
[[ "$preload" == *supautils* ]] || fail "supautils is not in session_preload_libraries ($preload)"
[[ "$hint_roles" == *anon* && "$hint_roles" == *authenticated* ]] ||
  fail "supautils.hint_roles does not list anon and authenticated ($hint_roles)"

PROBE_SQL="$(cat <<'SQL'
\set VERBOSITY verbose
BEGIN;
CREATE ROLE irori_execute_denial_plain NOLOGIN;
GRANT irori_execute_denial_plain TO CURRENT_USER;
CREATE FUNCTION public.irori_execute_denial_probe() RETURNS integer LANGUAGE sql AS 'SELECT 1';
REVOKE ALL ON FUNCTION public.irori_execute_denial_probe()
  FROM PUBLIC, anon, authenticated, service_role, irori_execute_denial_plain;
SELECT 'irori-probe-ready';
SET LOCAL ROLE :"probe_role";
SELECT public.irori_execute_denial_probe();
ROLLBACK;
SELECT 'irori-probe-session-alive';
SQL
)"

# $1: role to become; $2: denied | crash
probe_role() {
  local role="$1" want="$2" before after out status deadline
  before="$(signal_count)"
  set +e
  out="$(printf '%s\n' "$PROBE_SQL" | psql_in -v ON_ERROR_STOP=0 -v probe_role="$role" 2>"$errfile")"
  status=$?
  set -e
  [[ "$out" == *irori-probe-ready* ]] || {
    cat "$errfile" >&2
    fail "$role: the probe could not set up its function (status $status)"
  }
  if [ "$want" = "denied" ]; then
    after="$(signal_count)"
    if [ "$status" -ne 0 ] || [[ "$out" != *irori-probe-session-alive* ]] ||
      ! grep -q '42501: permission denied for function irori_execute_denial_probe' "$errfile" ||
      [ "$after" != "$before" ]; then
      cat "$errfile" >&2
      fail "$role: expected SQLSTATE 42501 with the server up (status=$status, crash lines $before -> $after)"
    fi
    echo "probe: ok: $role is refused with 42501 and the server stays up"
    return 0
  fi
  if [ "$status" -eq 0 ] || [[ "$out" == *irori-probe-session-alive* ]] ||
    ! grep -Eq 'server closed the connection unexpectedly|connection to server was lost' "$errfile"; then
    cat "$errfile" >&2
    fail "$role: expected the known supautils crash (status=$status)"
  fi
  deadline=$((SECONDS + 30))
  after="$(signal_count)"
  while [ "$after" = "$before" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 1
    after="$(signal_count)"
  done
  [ "$after" != "$before" ] || fail "$role: the connection was lost but the server log shows no backend crash"
  docker logs "$container" 2>&1 | grep -q 'terminated by signal 11' ||
    fail "$role: the backend crash was not signal 11"
  echo "probe: ok: $role crashes the backend (signal 11), as upstream reports for this image"
  wait_ready
}

if [ "$expect" = "clean" ]; then
  for role in irori_execute_denial_plain anon authenticated service_role; do
    probe_role "$role" denied
  done
else
  probe_role irori_execute_denial_plain denied
  probe_role anon crash
  probe_role authenticated crash
fi
echo "probe: PASS ($expect)"
