BEGIN;
SELECT plan(59);
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
SELECT ok(NOT has_function_privilege('anon','google_managed_exchange(text,timestamptz,text,text,jsonb,text,uuid,uuid,boolean,text)','EXECUTE'),'worker RPC denied to anon');
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
-- A master and two native materialized occurrences use separate identities.
INSERT INTO calendar_events(id,household_id,series_id,title,is_all_day,start_date,end_date,source)
 SELECT gen_random_uuid(),'10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','weekly',true,current_date+n,current_date+n,'native'
 FROM unnest(ARRAY[1,8]) n;
SELECT is((SELECT count(*) FROM google_series_occurrences WHERE series_id='40000000-0000-4000-8000-000000000001'),2::bigint,'two immutable original occurrence anchors');
SELECT is((SELECT count(*) FROM google_managed_events WHERE is_master),2::bigint,'one parent per spouse');
SELECT ok((SELECT doc#>>'{rule,lines,0}' FROM google_family_series WHERE series_id='40000000-0000-4000-8000-000000000001') LIKE 'RDATE;VALUE=DATE:%','real Google recurrence payload for finite irori series');
CREATE FUNCTION pg_temp.master(title text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT pg_temp.doc(title)||'{"rule":{"lines":["RRULE:FREQ=WEEKLY"],"startZone":"Asia/Tokyo","endZone":"Asia/Tokyo"}}'::jsonb
$$;
SELECT is(google_managed_exchange('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','g-master','present',pg_temp.master('原本'),'g1',null,
 '40000000-0000-4000-8000-000000000002',true)->>'action','none','Google-created series retains master rule');
CREATE FUNCTION pg_temp.series_obs(remote text,title text) RETURNS text LANGUAGE sql AS $$
 SELECT google_managed_exchange('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes',remote,'present',pg_temp.doc(title),'i1',null,
 '40000000-0000-4000-8000-000000000002',false,current_date::text)->>'action'
$$;
SELECT is(pg_temp.series_obs('g-instance','例外'),'none','Google occurrence becomes native');
SELECT is((SELECT count(*) FROM calendar_events WHERE series_id='40000000-0000-4000-8000-000000000002'),1::bigint,'one native instance');
SELECT is((SELECT count(*) FROM google_managed_events m JOIN google_family_series s ON m.event_id=s.root_id WHERE s.series_id='40000000-0000-4000-8000-000000000002'),2::bigint,'foreign Google parent fans out to spouse');
SELECT is(google_managed_exchange('20000000-0000-4000-8000-000000000002',now()+interval '10 minutes','other-instance','present',pg_temp.doc('例外'),'sp1',null,
 '40000000-0000-4000-8000-000000000002',false,current_date::text)->>'action','none','spouse occurrence binds to original meeting');
SELECT is((SELECT count(*) FROM calendar_events WHERE series_id='40000000-0000-4000-8000-000000000002'),1::bigint,'spouse echo creates no duplicate');
SELECT is((SELECT event_id FROM google_managed_events WHERE remote_id='other-instance'),(SELECT event_id FROM google_managed_events WHERE remote_id='g-instance'),'both Google IDs point at same irori occurrence');
SELECT set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000001',true);
SELECT set_config('request.jwt.claims','{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
CREATE TEMP TABLE reviewed AS SELECT e.id,e.updated_at,e.series_id,public.calendar_series_revision(e.series_id) AS revision FROM calendar_events e
 WHERE series_id='40000000-0000-4000-8000-000000000001' ORDER BY start_date LIMIT 1;
SELECT ok((SELECT revision IS NOT NULL FROM reviewed),'editor can capture series revision');
INSERT INTO calendar_events(id,household_id,series_id,title,is_all_day,start_date,end_date,source)
 SELECT gen_random_uuid(),'10000000-0000-4000-8000-000000000001',series_id,'concurrent addition',true,current_date+15,current_date+15,'native' FROM reviewed;
SELECT throws_ok('SELECT delete_managed_calendar_series(series_id,id,updated_at,revision) FROM reviewed','40001','series changed','another occurrence invalidates reviewed series delete');
SELECT is((SELECT count(*) FROM calendar_events WHERE series_id=(SELECT series_id FROM reviewed)),3::bigint,'stale request retained all occurrences');
SELECT ok(NOT has_function_privilege('anon','calendar_series_revision(uuid)','EXECUTE'),'anonymous callers cannot learn series revision');
SELECT is(google_managed_exchange('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','g-master','cancelled',NULL,'g2',null,
 '40000000-0000-4000-8000-000000000002',true)->>'action','conflict','a master cancellation cannot cascade across spouses');
SELECT is(pg_temp.observe('g-instance','cancelled',NULL,'g2'),'deferred','sparse child cancellation held while parent awaits resolution');
SELECT is((SELECT count(*) FROM calendar_events WHERE title='例外'),1::bigint,'parent review preserves editable child and spouse mapping');
SELECT ok(google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE remote_id='g-master'),'local'),'owner may keep the series');
SELECT is(google_managed_exchange('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','g-master','cancelled',NULL,'g2',null,
 '40000000-0000-4000-8000-000000000002',true)->>'action','none','new generation allocated for retained master');
SELECT ok(EXISTS(SELECT 1 FROM google_retired_event_ids WHERE remote_id='g-instance'),'old occurrence ID retired together with old master');
SELECT is(pg_temp.series_obs('replacement-instance','例外'),'none','new occurrence can bind to existing native row');
SELECT is((SELECT count(*) FROM calendar_events WHERE series_id='40000000-0000-4000-8000-000000000002'),1::bigint,'generation change cannot duplicate occurrences');
INSERT INTO calendar_events(id,household_id,series_id,title,is_all_day,start_date,end_date,source)
 VALUES(gen_random_uuid(),'10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','far future',true,current_date+800,current_date+800,'native');
SELECT is((SELECT google_managed_exchange(m.calendar_id,now()+interval '10 minutes',m.remote_id,'missing',NULL,NULL,null,s.series_id,true)->>'action'
 FROM google_managed_events m JOIN google_family_series s ON s.root_id=m.event_id WHERE s.series_id='40000000-0000-4000-8000-000000000003' LIMIT 1),'none','no outbound parent for a wholly out-of-window series');
SELECT ok(public.google_managed_sync_ready(),'managed schema readiness includes triggers and required RPC');
SELECT is(google_managed_series_context('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','g-instance')->>'kind','retired','replayed old instance cannot requeue an orphan parent');
SELECT pg_temp.observe('missing-probe','present',pg_temp.doc('kept after full rescan'),'v1');
SELECT is(pg_temp.observe('missing-probe','missing',NULL,NULL),'conflict','a missing point GET cannot erase a family event');
SELECT ok(NOT google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE remote_id='missing-probe'),'google'),'cannot confirm deletion using ambiguous 404');
SELECT pg_temp.observe('stable-'||n,'present',pg_temp.doc('stable'),'unchanged') FROM generate_series(1,200) n;
SELECT google_managed_cursor('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes',NULL,'page2',current_date-90,current_date+366,NULL,
 (SELECT jsonb_agg(jsonb_build_object('id','stable-'||n,'etag','unchanged','cancelled',false)) FROM generate_series(1,100) n));
SELECT google_managed_cursor('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','final',NULL,current_date-90,current_date+366,current_date,
 (SELECT jsonb_agg(jsonb_build_object('id','stable-'||n,'etag','unchanged','cancelled',false)) FROM generate_series(101,200) n));
SELECT is((SELECT count(*) FROM google_managed_inbox WHERE remote_id LIKE 'stable-%'),0::bigint,'unchanged 200 events on two pages produce zero redundant jobs');
SELECT ok(EXISTS(SELECT 1 FROM google_managed_inbox WHERE remote_id='missing-probe'),'only previously established missing identity scheduled for point GET');
SELECT is((SELECT count(*) FROM calendar_events WHERE title='kept after full rescan'),1::bigint,'full scan left unobserved row intact');
SELECT is((SELECT count(*) FROM google_scan_seen),0::bigint,'scan receipts released after final page');
INSERT INTO calendar_events(id,household_id,title,is_all_day,start_date,end_date,source)
 VALUES('41000000-0000-4000-8000-000000000000','10000000-0000-4000-8000-000000000001','旧版未送信',true,current_date,current_date,'native');
UPDATE google_managed_events SET legacy_unverified=true WHERE event_id='41000000-0000-4000-8000-000000000000';
SELECT is(pg_temp.observe('irori41000000000040008000000000000000','missing',NULL,NULL),'conflict','legacy missing is never silently recreated');
UPDATE google_managed_calendars SET sync_token=NULL,scanned_on=NULL WHERE calendar_id='20000000-0000-4000-8000-000000000001';
SELECT google_managed_cursor('20000000-0000-4000-8000-000000000001',now()+interval '10 minutes','full',NULL,current_date-90,current_date+366,current_date,'[]');
SELECT is(pg_temp.observe('irori41000000000040008000000000000000','missing',NULL,NULL),'conflict','full scan and missing GET still require an explicit decision');
SELECT ok(NOT google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE calendar_id='20000000-0000-4000-8000-000000000001' AND event_id='41000000-0000-4000-8000-000000000000'),'google'),'legacy 404 cannot be adopted as deletion');
SELECT ok(google_managed_choose('20000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 (SELECT conflict_id FROM google_managed_events WHERE calendar_id='20000000-0000-4000-8000-000000000001' AND event_id='41000000-0000-4000-8000-000000000000'),'local'),'owner can deliberately re-share a missing legacy copy');
SELECT is(pg_temp.observe('irori41000000000040008000000000000000','missing',NULL,NULL),'none','reserving new identity cannot delete the native event');
SELECT ok(EXISTS (SELECT 1 FROM google_managed_events WHERE calendar_id='20000000-0000-4000-8000-000000000001' AND event_id='41000000-0000-4000-8000-000000000000' AND remote_id LIKE 'r%' AND pending),'new durable ID is queued');
SELECT * FROM finish();
ROLLBACK;
