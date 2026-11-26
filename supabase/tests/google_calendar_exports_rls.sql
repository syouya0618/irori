BEGIN;
SELECT plan(5);
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.google_calendar_exports'::regclass), 'export settings use RLS');
SELECT is((SELECT count(*)::int FROM pg_policy WHERE polrelid = 'public.google_calendar_exports'::regclass), 0, 'no client policies');
SELECT ok(NOT has_table_privilege('anon', 'public.google_calendar_exports', 'SELECT,INSERT,UPDATE,DELETE'), 'anon denied');
SELECT ok(NOT has_table_privilege('authenticated', 'public.google_calendar_exports', 'SELECT,INSERT,UPDATE,DELETE'), 'authenticated denied');
SELECT ok(has_table_privilege('service_role', 'public.google_calendar_exports', 'SELECT') AND has_table_privilege('service_role', 'public.google_calendar_exports', 'UPDATE'), 'server can read and update');
SELECT * FROM finish();
ROLLBACK;
