-- Real PostgreSQL: personal settings, partial-index conflict and final claim snapshot.
BEGIN;
SELECT no_plan();
INSERT INTO households(id, name, feeding_interval_min) VALUES
 ('f1000000-0000-0000-0000-000000000001', 'feeding test 1', 180),
 ('f1000000-0000-0000-0000-000000000002', 'feeding test 2', 180);
INSERT INTO auth.users(id, email) VALUES
 ('f2000000-0000-0000-0000-000000000001', 'feeding1@example.com'),
 ('f2000000-0000-0000-0000-000000000002', 'feeding2@example.com');
UPDATE profiles SET household_id = 'f1000000-0000-0000-0000-000000000001', is_approved = true
 WHERE id IN ('f2000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000002');
INSERT INTO notification_preferences(user_id, event_default_minutes, digest_time) VALUES
 ('f2000000-0000-0000-0000-000000000001', 10, '07:00'),
 ('f2000000-0000-0000-0000-000000000002', 30, '08:00');
SELECT is((SELECT feeding_reminder_minutes FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000001'), NULL::integer, 'default is OFF');
SELECT throws_like($$UPDATE notification_preferences SET feeding_reminder_minutes = 0 WHERE user_id = 'f2000000-0000-0000-0000-000000000001'$$, '%chk_notification_prefs_feeding_minutes%', 'DB rejects invalid lead');
SELECT ok(has_column_privilege('authenticated', 'notification_preferences', 'feeding_reminder_minutes', 'UPDATE'), 'own setting column is writable');
SELECT ok(NOT has_function_privilege('authenticated', 'enqueue_feeding_delivery(uuid,uuid,uuid,timestamptz)', 'EXECUTE'), 'authenticated cannot enqueue');
SELECT ok(NOT has_function_privilege('anon', 'claim_feeding_delivery(uuid,timestamptz,integer,integer,timestamptz)', 'EXECUTE'), 'anon cannot claim');
SELECT ok(NOT has_function_privilege('authenticated', 'claim_feeding_delivery(uuid,timestamptz,integer,integer,timestamptz)', 'EXECUTE'), 'authenticated cannot claim');
SELECT ok(has_function_privilege('service_role', 'claim_feeding_delivery(uuid,timestamptz,integer,integer,timestamptz)', 'EXECUTE'), 'service role can claim');
SELECT ok(NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'claim_feeding_delivery(uuid,timestamptz,integer,integer,timestamptz)'::regprocedure), 'claim is security invoker');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"f2000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
INSERT INTO notification_preferences(user_id, feeding_reminder_minutes) VALUES ('f2000000-0000-0000-0000-000000000001', 15)
 ON CONFLICT(user_id) DO UPDATE SET feeding_reminder_minutes = EXCLUDED.feeding_reminder_minutes;
SELECT is((SELECT feeding_reminder_minutes FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000001'), 15, 'RLS allows own setting');
SELECT is((SELECT count(*) FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000002'), 0::bigint, 'spouse preference is not visible');
WITH changed AS (UPDATE notification_preferences SET feeding_reminder_minutes = 5 WHERE user_id = 'f2000000-0000-0000-0000-000000000002' RETURNING user_id)
 SELECT is((SELECT count(*) FROM changed), 0::bigint, 'cannot overwrite spouse setting');
RESET ROLE;
SELECT is((SELECT digest_time FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000001'), '07:00'::time, 'digest unchanged');
SELECT is((SELECT event_default_minutes FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000001'), 10, 'event default unchanged');
SELECT is((SELECT feeding_reminder_minutes FROM notification_preferences WHERE user_id = 'f2000000-0000-0000-0000-000000000002'), NULL::integer, 'spouse remains OFF');
INSERT INTO push_subscriptions(id, user_id, endpoint, p256dh, auth) VALUES
 ('f3000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'https://fcm.googleapis.com/feeding-test-1', 'fixture-key', 'fixture-auth'),
 ('f3000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000001', 'https://fcm.googleapis.com/feeding-test-2', 'fixture-key', 'fixture-auth');
CREATE TEMP TABLE feed_clock AS SELECT now() - interval '166 minutes' AS logged_at,
 date_trunc('milliseconds', now() - interval '1 minute') AS scheduled_at;
INSERT INTO baby_logs(id, household_id, logged_by, log_type, feeding_type, amount_ml, logged_at)
 SELECT 'f4000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'feeding', 'bottle', 100, logged_at FROM feed_clock;
CREATE FUNCTION pg_temp.queue_feed(p_sub uuid DEFAULT 'f3000000-0000-0000-0000-000000000001') RETURNS uuid LANGUAGE sql AS $$
 SELECT enqueue_feeding_delivery('f1000000-0000-0000-0000-000000000001', 'f4000000-0000-0000-0000-000000000001', p_sub, scheduled_at) FROM feed_clock
$$;
CREATE TEMP TABLE feed_id AS SELECT pg_temp.queue_feed() AS id;
CREATE FUNCTION pg_temp.claim_feed() RETURNS boolean LANGUAGE sql AS $$
 SELECT claim_feeding_delivery(i.id, c.logged_at, 180, 15, c.scheduled_at) FROM feed_id i CROSS JOIN feed_clock c
$$;
SELECT isnt((SELECT id FROM feed_id), NULL::uuid, 'due current cycle queued');
SELECT is(pg_temp.queue_feed(), (SELECT id FROM feed_id), 'repeat RPC resolves same partial-index row');
SELECT is((SELECT count(*) FROM notification_deliveries WHERE household_id = 'f1000000-0000-0000-0000-000000000001' AND kind = 'feeding'), 1::bigint, 'one row after duplicate enqueue');
SELECT is(enqueue_feeding_delivery('f1000000-0000-0000-0000-000000000002', 'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', (SELECT scheduled_at FROM feed_clock)), NULL::uuid, 'cannot queue other household to this subscriber');
SELECT ok(pg_temp.claim_feed(), 'current snapshot claims (including microseconds in logged_at)');
SELECT ok(NOT pg_temp.claim_feed(), 'second claim is refused');
SELECT is(pg_temp.queue_feed(), NULL::uuid, 'sent cycle cannot be requeued');
SELECT throws_like($$INSERT INTO notification_deliveries(household_id, kind, event_key, subscription_key, scheduled_at, dedupe_day)
 SELECT 'f1000000-0000-0000-0000-000000000001', 'feeding', 'f4000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000001', scheduled_at + interval '1 day', (scheduled_at AT TIME ZONE 'Asia/Tokyo')::date + 1 FROM feed_clock$$,
 '%uq_notification_deliveries_feeding%', 'JST date change cannot create a second delivery');
SELECT throws_like($$INSERT INTO notification_deliveries(household_id, kind, event_key, subscription_key, scheduled_at, dedupe_day)
 VALUES ('f1000000-0000-0000-0000-000000000001', 'feeding', NULL, 'fixture', now(), current_date)$$,
 '%chk_notification_deliveries_feeding_key%', 'feeding key has no NULL hole');
SELECT isnt(pg_temp.queue_feed('f3000000-0000-0000-0000-000000000002'), NULL::uuid, 'a second device has its own delivery');
UPDATE notification_deliveries SET sent_at = NULL WHERE id = (SELECT id FROM feed_id);
UPDATE notification_preferences SET feeding_reminder_minutes = NULL WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'OFF before final claim suppresses');
UPDATE notification_preferences SET feeding_reminder_minutes = 10 WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'lead change suppresses old snapshot');
UPDATE notification_preferences SET feeding_reminder_minutes = 15 WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
UPDATE households SET feeding_interval_min = 210 WHERE id = 'f1000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'interval change suppresses');
UPDATE households SET feeding_interval_min = 180 WHERE id = 'f1000000-0000-0000-0000-000000000001';
UPDATE profiles SET is_approved = false WHERE id = 'f2000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'approval revoked suppresses');
UPDATE profiles SET is_approved = true, household_id = 'f1000000-0000-0000-0000-000000000002' WHERE id = 'f2000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'household move suppresses old household');
UPDATE profiles SET household_id = 'f1000000-0000-0000-0000-000000000001' WHERE id = 'f2000000-0000-0000-0000-000000000001';
UPDATE baby_logs SET logged_at = logged_at + interval '1 minute' WHERE id = 'f4000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'time edit suppresses');
UPDATE baby_logs SET logged_at = (SELECT logged_at FROM feed_clock) WHERE id = 'f4000000-0000-0000-0000-000000000001';
INSERT INTO baby_logs(id, household_id, logged_by, log_type, feeding_type, amount_ml, logged_at)
 SELECT 'f4000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'feeding', 'bottle', 100, logged_at + interval '30 minutes' FROM feed_clock;
SELECT ok(NOT pg_temp.claim_feed(), 'new nursing suppresses stale scheduled row');
DELETE FROM baby_logs WHERE id = 'f4000000-0000-0000-0000-000000000002';
INSERT INTO baby_logs(id, household_id, logged_by, log_type, feeding_type, amount_ml, logged_at)
 SELECT 'f4000000-0000-0000-0000-000000000002', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'feeding', 'pumped', 10, logged_at + interval '30 minutes' FROM feed_clock;
SELECT ok(pg_temp.claim_feed(), 'pumped does not reset the valid nursing cycle');
UPDATE notification_deliveries SET sent_at = NULL WHERE id = (SELECT id FROM feed_id);
INSERT INTO baby_logs(id, household_id, logged_by, log_type, feeding_type, amount_ml, logged_at)
 SELECT 'f4000000-0000-0000-0000-000000000003', 'f1000000-0000-0000-0000-000000000002', 'f2000000-0000-0000-0000-000000000002', 'feeding', 'bottle', 100, logged_at + interval '45 minutes' FROM feed_clock;
SELECT ok(pg_temp.claim_feed(), 'other household does not alter cycle');
UPDATE notification_deliveries SET sent_at = NULL WHERE id = (SELECT id FROM feed_id);
-- Grace is enforced even while the target itself remains in the future.
UPDATE notification_preferences SET feeding_reminder_minutes = 30 WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
UPDATE notification_deliveries SET scheduled_at = (SELECT scheduled_at - interval '15 minutes' FROM feed_clock) WHERE id = (SELECT id FROM feed_id);
SELECT ok(NOT claim_feeding_delivery(i.id,c.logged_at,180,30,c.scheduled_at - interval '15 minutes'), 'DB grace rejects a 16-minute-late reminder') FROM feed_id i CROSS JOIN feed_clock c;
-- Conversely a target that already passed is rejected even within grace.
UPDATE notification_preferences SET feeding_reminder_minutes = 5 WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
UPDATE baby_logs SET logged_at = (SELECT logged_at - interval '15 minutes' FROM feed_clock) WHERE id = 'f4000000-0000-0000-0000-000000000001';
UPDATE notification_deliveries SET scheduled_at = (SELECT scheduled_at - interval '5 minutes' FROM feed_clock) WHERE id = (SELECT id FROM feed_id);
SELECT ok(NOT claim_feeding_delivery(i.id,c.logged_at - interval '15 minutes',180,5,c.scheduled_at - interval '5 minutes'), 'past target rejected within grace') FROM feed_id i CROSS JOIN feed_clock c;
UPDATE notification_preferences SET feeding_reminder_minutes = 15 WHERE user_id = 'f2000000-0000-0000-0000-000000000001';
UPDATE baby_logs SET logged_at = (SELECT logged_at FROM feed_clock) WHERE id = 'f4000000-0000-0000-0000-000000000001';
UPDATE notification_deliveries SET scheduled_at = (SELECT scheduled_at FROM feed_clock) WHERE id = (SELECT id FROM feed_id);
DELETE FROM baby_logs WHERE id = 'f4000000-0000-0000-0000-000000000001';
SELECT ok(NOT pg_temp.claim_feed(), 'deleting origin suppresses old delivery');
INSERT INTO baby_logs(id, household_id, logged_by, log_type, feeding_type, amount_ml, logged_at)
 SELECT 'f4000000-0000-0000-0000-000000000001', 'f1000000-0000-0000-0000-000000000001', 'f2000000-0000-0000-0000-000000000001', 'feeding', 'bottle', 100, logged_at FROM feed_clock;
SELECT ok(pg_temp.claim_feed(), 'positive control: restored origin is eligible before unsubscribe');
UPDATE notification_deliveries SET sent_at = NULL WHERE id = (SELECT id FROM feed_id);
SELECT lives_ok($$DELETE FROM push_subscriptions WHERE id IN ('f3000000-0000-0000-0000-000000000001', 'f3000000-0000-0000-0000-000000000002')$$, 'two-device unsubscribe preserves history without NULL uniqueness collision');
SELECT is((SELECT count(*) FROM notification_deliveries WHERE household_id = 'f1000000-0000-0000-0000-000000000001' AND kind = 'feeding' AND subscription_id IS NULL), 2::bigint, 'history retained after unsubscribe');
SELECT ok(NOT pg_temp.claim_feed(), 'unsubscribed destination cannot be claimed');
SELECT * FROM finish();
ROLLBACK;
