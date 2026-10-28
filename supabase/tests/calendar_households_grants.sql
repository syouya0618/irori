-- Test the privileges installed by migrations, before any fixture GRANT can hide omissions.
-- calendar_events needs DML; households only needs SELECT / UPDATE. RLS still limits rows.
BEGIN;
SELECT plan(29);

SELECT ok(has_table_privilege('authenticated', 'public.calendar_events', 'SELECT'), 'calendar: authenticated SELECT');
SELECT ok(has_table_privilege('authenticated', 'public.calendar_events', 'INSERT'), 'calendar: authenticated INSERT');
SELECT ok(has_table_privilege('authenticated', 'public.calendar_events', 'UPDATE'), 'calendar: authenticated UPDATE');
SELECT ok(has_table_privilege('authenticated', 'public.calendar_events', 'DELETE'), 'calendar: authenticated DELETE');
SELECT ok(has_table_privilege('authenticated', 'public.households', 'SELECT'), 'households: authenticated SELECT');
SELECT ok(has_table_privilege('authenticated', 'public.households', 'UPDATE'), 'households: authenticated UPDATE');
SELECT ok(NOT has_table_privilege('authenticated', 'public.households', 'INSERT'), 'households: no direct INSERT');
SELECT ok(NOT has_table_privilege('authenticated', 'public.households', 'DELETE'), 'households: no direct DELETE');
SELECT ok(NOT has_table_privilege('authenticated', 'public.households', 'TRUNCATE'), 'households: no TRUNCATE');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.calendar_events'::regclass), 'calendar: RLS enabled');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.households'::regclass), 'households: RLS enabled');

INSERT INTO households (id, name) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'grant H1'),
  ('a9999999-9999-9999-9999-999999999999', 'grant H2');
INSERT INTO auth.users (id, email) VALUES
  ('a2222222-2222-2222-2222-222222222222', 'grants-a@example.com'),
  ('a8888888-8888-8888-8888-888888888888', 'grants-b@example.com');
UPDATE profiles SET household_id = 'a1111111-1111-1111-1111-111111111111', is_approved = true
  WHERE id = 'a2222222-2222-2222-2222-222222222222';
UPDATE profiles SET household_id = 'a9999999-9999-9999-9999-999999999999', is_approved = true
  WHERE id = 'a8888888-8888-8888-8888-888888888888';
INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source, google_event_id, google_calendar_id) VALUES
  ('a3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'native A', true, '2026-11-01', '2026-11-01', 'native', NULL, NULL),
  ('a4444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', 'google A', true, '2026-11-01', '2026-11-01', 'google', 'grant-event', 'grant-calendar'),
  ('a5555555-5555-5555-5555-555555555555', 'a9999999-9999-9999-9999-999999999999', 'native B', true, '2026-11-01', '2026-11-01', 'native', NULL, NULL);

SELECT is((SELECT count(*) FROM calendar_events), 3::bigint, 'seed: three events');
SELECT is((SELECT count(*) FROM households), 2::bigint, 'seed: two households');

SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims', json_build_object(
  'sub', 'a2222222-2222-2222-2222-222222222222', 'role', 'authenticated')::text, true);

SELECT results_eq($$ SELECT title FROM calendar_events ORDER BY title $$,
  ARRAY['google A', 'native A'], 'only own native and google events are readable');
SELECT results_eq($$ SELECT name FROM households ORDER BY name $$,
  ARRAY['grant H1'], 'only own household is readable');
SELECT lives_ok($$
  INSERT INTO calendar_events (id, household_id, title, is_all_day, start_date, end_date, source)
  VALUES ('a6666666-6666-6666-6666-666666666666', 'a1111111-1111-1111-1111-111111111111',
    'new native', true, '2026-11-02', '2026-11-02', 'native')
$$, 'own native event can be created');
SELECT throws_ok($$
  INSERT INTO calendar_events (household_id, title, is_all_day, start_date, end_date, source)
  VALUES ('a9999999-9999-9999-9999-999999999999', 'denied', true, '2026-11-02', '2026-11-02', 'native')
$$, '42501', 'new row violates row-level security policy for table "calendar_events"', 'other household INSERT denied by RLS');

WITH changed AS (
  UPDATE calendar_events SET title = 'native A updated'
  WHERE id = 'a3333333-3333-3333-3333-333333333333' RETURNING id
) SELECT is(count(*), 1::bigint, 'own native UPDATE changes one row') FROM changed;
WITH changed AS (
  UPDATE calendar_events SET title = 'hacked'
  WHERE id = 'a4444444-4444-4444-4444-444444444444' RETURNING id
) SELECT is(count(*), 0::bigint, 'google UPDATE changes zero rows') FROM changed;
WITH changed AS (
  UPDATE calendar_events SET title = 'hacked'
  WHERE id = 'a5555555-5555-5555-5555-555555555555' RETURNING id
) SELECT is(count(*), 0::bigint, 'other household UPDATE changes zero rows') FROM changed;
WITH changed AS (
  UPDATE households SET name = 'grant H1 updated'
  WHERE id = 'a1111111-1111-1111-1111-111111111111' RETURNING id
) SELECT is(count(*), 1::bigint, 'own household UPDATE changes one row') FROM changed;
WITH changed AS (
  UPDATE households SET name = 'hacked'
  WHERE id = 'a9999999-9999-9999-9999-999999999999' RETURNING id
) SELECT is(count(*), 0::bigint, 'other household UPDATE changes zero rows') FROM changed;
WITH removed AS (
  DELETE FROM calendar_events WHERE id = 'a6666666-6666-6666-6666-666666666666' RETURNING id
) SELECT is(count(*), 1::bigint, 'own native DELETE removes one row') FROM removed;
WITH removed AS (
  DELETE FROM calendar_events WHERE id = 'a5555555-5555-5555-5555-555555555555' RETURNING id
) SELECT is(count(*), 0::bigint, 'other household DELETE removes zero rows') FROM removed;
WITH removed AS (
  DELETE FROM calendar_events WHERE id = 'a4444444-4444-4444-4444-444444444444' RETURNING id
) SELECT is(count(*), 0::bigint, 'google DELETE removes zero rows') FROM removed;

RESET ROLE;
SELECT is((SELECT title FROM calendar_events WHERE id = 'a5555555-5555-5555-5555-555555555555'),
  'native B', 'other household event unchanged');
SELECT is((SELECT title FROM calendar_events WHERE id = 'a4444444-4444-4444-4444-444444444444'),
  'google A', 'google event unchanged');
SELECT is((SELECT name FROM households WHERE id = 'a9999999-9999-9999-9999-999999999999'),
  'grant H2', 'other household unchanged');
SELECT is((SELECT title FROM calendar_events WHERE id = 'a3333333-3333-3333-3333-333333333333'),
  'native A updated', 'own native update persisted');

SELECT * FROM finish();
ROLLBACK;
