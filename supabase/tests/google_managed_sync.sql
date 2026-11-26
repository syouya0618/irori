BEGIN;
SELECT plan(22);
INSERT INTO households(id,name) VALUES('10000000-0000-4000-8000-000000000001','sync fixture');
INSERT INTO auth.users(id,email) VALUES('20000000-0000-4000-8000-000000000001','one@example.test'),('20000000-0000-4000-8000-000000000002','two@example.test');
UPDATE profiles SET household_id='10000000-0000-4000-8000-000000000001',is_approved=true,role='member'
 WHERE id IN ('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002');
INSERT INTO google_connections(id,user_id,household_id,google_account_id,google_email)
 SELECT id,id,household_id,id::text,'sync@example.test' FROM profiles WHERE household_id='10000000-0000-4000-8000-000000000001';
INSERT INTO google_calendar_exports(connection_id,household_id,calendar_id,enabled,bidirectional,lease_until)
 SELECT id,household_id,google_account_id,true,true,now()+interval '10 minutes' FROM google_connections WHERE household_id='10000000-0000-4000-8000-000000000001';
INSERT INTO google_managed_calendars(calendar_id,household_id,user_id,google_account_id,marker)
 SELECT google_account_id,household_id,user_id,google_account_id,id FROM google_connections WHERE household_id='10000000-0000-4000-8000-000000000001';
CREATE FUNCTION pg_temp.observe(id text, state text, doc jsonb, etag text) RETURNS text LANGUAGE sql AS $$
 SELECT google_managed_exchange('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes',id,state,doc,etag)->>'action'
$$;
CREATE FUNCTION pg_temp.doc(t text, offset_days integer DEFAULT 0) RETURNS jsonb LANGUAGE sql AS $$
 SELECT jsonb_build_object('title',t,'timing',jsonb_build_object('start',current_date+offset_days,'end',current_date+offset_days+1))
$$;
SELECT ok(NOT has_table_privilege('authenticated','google_managed_events','SELECT,UPDATE'),'mapping unavailable to browsers');
SELECT ok(NOT has_function_privilege('anon','google_managed_exchange(text,timestamptz,text,text,jsonb,text,uuid,uuid)','EXECUTE'),'worker RPC denied to anon');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('initial'),'v1'),'none','Google create materializes a family event');
SELECT is((SELECT count(*) FROM calendar_events WHERE source='native' AND title='initial'),1::bigint,'Google event is editable native');
SELECT is((SELECT count(*) FROM google_managed_events WHERE event_id=(SELECT id FROM calendar_events WHERE title='initial')),2::bigint,'both spouses point to same native row');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('initial'),'v1'),'none','replayed create remains idempotent');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('updated'),'v2'),'none','Google update applies');
SELECT is((SELECT title FROM calendar_events WHERE title='updated'),'updated','updated family title');
UPDATE calendar_events SET title='from irori' WHERE title='updated';
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('updated',2),'v3'),'patch','disjoint edits merge');
SELECT is((SELECT start_date FROM calendar_events WHERE title='from irori'),current_date+2,'remote dates were preserved');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('from irori',2),'v4'),'none','lost write reply recovered by durable intent');
UPDATE calendar_events SET title='local race' WHERE title='from irori';
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('Google race',2),'v5'),'conflict','concurrent title edit conflicts');
SELECT is((SELECT title FROM calendar_events WHERE title='local race'),'local race','no overwrite on conflict');
SELECT ok(google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE remote_id='google-a'),'google'),'owner may choose exact conflict');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('Google race',2),'v5'),'none','chosen Google revision applied');
-- An earlier committed version. All statements in a pgTAP transaction share now().
UPDATE google_managed_events SET common_version=common_version-interval '1 second' WHERE remote_id='google-a';
SELECT is(pg_temp.observe('google-a','cancelled',NULL,'v6'),'conflict','delete cannot erase a newer irori version');
SELECT ok(google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE remote_id='google-a'),'local'),'choose to retain local after remote delete');
SELECT is(pg_temp.observe('google-a','cancelled',NULL,'v6'),'none','retaining local retires cancelled identity');
SELECT is((SELECT count(*) FROM google_retired_event_ids WHERE remote_id='google-a'),1::bigint,'cancelled ID cannot be recreated');
SELECT is(pg_temp.observe('google-a','present',pg_temp.doc('stale replay'),'v1'),'none','obsolete identity ignored');
SELECT is((SELECT count(*) FROM calendar_events WHERE title='stale replay'),0::bigint,'no revival from old page');
SELECT ok(NOT google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',gen_random_uuid(),'google'),'spouse cannot resolve another connection');
SELECT * FROM finish();
ROLLBACK;
