BEGIN;
SELECT plan(15);
SELECT ok(has_function_privilege('authenticated', 'public.google_sharing_schema_ready()', 'EXECUTE'), 'authenticated can check rollout readiness');
SELECT ok(NOT has_function_privilege('anon', 'public.google_sharing_schema_ready()', 'EXECUTE'), 'anon cannot check readiness');
INSERT INTO households (id, name) VALUES ('11111111-1111-1111-1111-111111111111', 'H1');
INSERT INTO auth.users (id, email) VALUES
 ('22222222-2222-2222-2222-222222222222','a@example.test'),
 ('33333333-3333-3333-3333-333333333333','b@example.test');
UPDATE profiles SET household_id='11111111-1111-1111-1111-111111111111', is_approved=true, role='owner'
 WHERE id IN ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333');
INSERT INTO google_connections (id, household_id, user_id, google_account_id, google_email) VALUES
 ('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','acct-a','a@example.test'),
 ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','acct-b','b@example.test');
INSERT INTO google_calendar_subscriptions (id,connection_id,household_id,google_calendar_id,is_selected,sync_token) VALUES
 ('66666666-6666-6666-6666-666666666666','44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','same',true,'token-a'),
 ('77777777-7777-7777-7777-777777777777','55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111','same',true,'token-b');
INSERT INTO calendar_events (id,household_id,title,is_all_day,start_date,end_date,source,google_event_id,google_calendar_id,subscription_id) VALUES
 ('88888888-8888-8888-8888-888888888888','11111111-1111-1111-1111-111111111111','mirror',true,'2026-11-26','2026-11-26','google','event','same','66666666-6666-6666-6666-666666666666'),
 ('99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111','native',true,'2026-11-26','2026-11-26','native',NULL,NULL,NULL);
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);
SELECT is(public.google_sharing_schema_ready(), true, 'readiness is available after migration');
SELECT is((SELECT count(*) FROM google_calendar_subscriptions),2::bigint,'both household subscriptions visible');
UPDATE google_calendar_subscriptions SET is_selected=false WHERE id='77777777-7777-7777-7777-777777777777';
SELECT is((SELECT is_selected FROM google_calendar_subscriptions WHERE id='77777777-7777-7777-7777-777777777777'),true,'cannot toggle spouse consent');
UPDATE google_calendar_subscriptions SET is_selected=false WHERE id='66666666-6666-6666-6666-666666666666';
SELECT is((SELECT is_selected FROM google_calendar_subscriptions WHERE id='66666666-6666-6666-6666-666666666666'),false,'owner can turn off');
RESET ROLE;
SELECT is((SELECT sync_token FROM google_calendar_subscriptions WHERE id='66666666-6666-6666-6666-666666666666'),NULL::text,'token cleared');
SELECT is((SELECT count(*) FROM calendar_events WHERE source='google'),1::bigint,'other subscription preserves mirror');
UPDATE google_calendar_subscriptions SET sync_lease_until=clock_timestamp()+interval '60 seconds' WHERE id='77777777-7777-7777-7777-777777777777';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
SELECT throws_ok($$UPDATE google_calendar_subscriptions SET is_selected=false WHERE id='77777777-7777-7777-7777-777777777777'$$,'55P03','calendar sync in progress','active sync blocks opt-out');
RESET ROLE;
UPDATE google_calendar_subscriptions SET sync_lease_until=NULL WHERE id='77777777-7777-7777-7777-777777777777';
SET LOCAL role authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated"}', true);
UPDATE google_calendar_subscriptions SET is_selected=false WHERE id='77777777-7777-7777-7777-777777777777';
RESET ROLE;
SELECT is((SELECT count(*) FROM calendar_events WHERE source='google'),0::bigint,'last opt-out removes only mirror');
SELECT is((SELECT count(*) FROM calendar_events WHERE source='native'),1::bigint,'native preserved');
SELECT is((SELECT sync_token FROM google_calendar_subscriptions WHERE id='77777777-7777-7777-7777-777777777777'),NULL::text,'last token cleared');
UPDATE google_calendar_subscriptions SET is_selected=true WHERE id='77777777-7777-7777-7777-777777777777';
SELECT is((SELECT sync_token FROM google_calendar_subscriptions WHERE id='77777777-7777-7777-7777-777777777777'),NULL::text,'reenable requires full sync');
INSERT INTO google_calendar_exports (connection_id,household_id,lease_until) VALUES ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111',clock_timestamp()+interval '60 seconds');
SELECT throws_ok($$DELETE FROM google_connections WHERE id='55555555-5555-5555-5555-555555555555'$$,'55P03','calendar sync in progress','active export blocks disconnect');
UPDATE google_calendar_exports SET lease_until=NULL WHERE connection_id='55555555-5555-5555-5555-555555555555';
DELETE FROM google_connections WHERE id='55555555-5555-5555-5555-555555555555';
SELECT is((SELECT count(*) FROM google_calendar_exports),0::bigint,'disconnect removes export configuration');
SELECT * FROM finish();
ROLLBACK;
