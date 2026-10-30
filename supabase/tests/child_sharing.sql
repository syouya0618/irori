BEGIN;
SELECT plan(35);
INSERT INTO public.households(id,name,baby_name) VALUES
 ('d1000000-0000-4000-8000-000000000001','synthetic share household A','synthetic share child A1'),
 ('d1000000-0000-4000-8000-000000000002','synthetic share household B','synthetic share child B1');
INSERT INTO auth.users(id,email) VALUES
 ('d1000000-0000-4000-8000-000000000003','share-owner@example.invalid'),
 ('d1000000-0000-4000-8000-000000000004','share-member@example.invalid'),
 ('d1000000-0000-4000-8000-000000000005','share-viewer@example.invalid'),
 ('d1000000-0000-4000-8000-000000000006','share-other@example.invalid');
UPDATE profiles SET household_id='d1000000-0000-4000-8000-000000000001',is_approved=true,role='owner' WHERE id='d1000000-0000-4000-8000-000000000003';
UPDATE profiles SET household_id='d1000000-0000-4000-8000-000000000001',is_approved=true,role='member' WHERE id='d1000000-0000-4000-8000-000000000004';
INSERT INTO children(id,household_id,name) VALUES ('d1000000-0000-4000-8000-000000000007','d1000000-0000-4000-8000-000000000001','synthetic sibling A2');
INSERT INTO baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml,memo) VALUES
 ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003','feeding','bottle',90,'private feeding memo');
INSERT INTO baby_logs(household_id,logged_by,log_type,temperature,memo) VALUES
 ('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000003','temperature',36.5,'private medical memo');
INSERT INTO baby_diaries(household_id,diary_date,content) VALUES
 ('d1000000-0000-4000-8000-000000000001',(now() AT TIME ZONE 'Asia/Tokyo')::date,'private diary');
CREATE TEMP TABLE share_fixture(value jsonb); GRANT ALL ON share_fixture TO authenticated;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT throws_ok($$SELECT create_child_share((SELECT id FROM children WHERE is_legacy),true,false,false,false,NULL)$$,'42501',NULL,'member cannot grant restricted access');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT throws_ok($$SELECT create_child_share((SELECT id FROM children WHERE is_legacy),false,false,false,false,NULL)$$,'22023',NULL,'empty permissions rejected');
INSERT INTO share_fixture SELECT create_child_share((SELECT id FROM children WHERE is_legacy),true,false,false,false,now()+interval '1 day');
SELECT is((SELECT jsonb_array_length(list_child_shares(true))),1,'owner lists grant');
SELECT throws_ok($$SELECT create_child_share('d1000000-0000-4000-8000-000000000002',true,false,false,false,NULL)$$,'42501',NULL,'foreign child cannot be shared');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM invitations WHERE purpose='child_share'),0::bigint,'member cannot read restricted invitation token');
WITH changed AS (UPDATE invitations SET role='member',purpose='member' WHERE purpose='child_share' RETURNING id) SELECT is((SELECT count(*) FROM changed),0::bigint,'member cannot convert sharing to membership');
RESET ROLE;
UPDATE share_fixture f SET value=f.value || jsonb_build_object('invitation_id',s.invitation_id) FROM child_shares s WHERE s.id=(f.value->>'id')::uuid;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT throws_ok($$SELECT accept_invitation((SELECT invitation_id FROM child_shares LIMIT 1))$$,'42501',NULL,'raw share table has no authenticated SELECT grant');
SELECT throws_ok($$SELECT accept_invitation((SELECT (value->>'invitation_id')::uuid FROM share_fixture))$$,'42501',NULL,'restricted invitation cannot grant membership through old RPC');
SELECT lives_ok($$SELECT accept_child_share((SELECT value->>'token' FROM share_fixture))$$,'viewer accepts restricted invitation');
SELECT lives_ok($$SELECT accept_child_share((SELECT value->>'token' FROM share_fixture))$$,'same viewer can confirm an ambiguous acceptance');
SELECT is((SELECT household_id FROM profiles WHERE id=auth.uid()),NULL::uuid,'acceptance does not grant household membership');
SELECT is((SELECT role::text FROM profiles WHERE id=auth.uid()),'viewer','new viewer gets restricted role');
SELECT is((SELECT jsonb_array_length(list_child_shares(false))),1,'viewer sees own active share');
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'daily') FROM share_fixture),1,'only specified child daily record returned');
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'health') FROM share_fixture),0,'medical data is not implicitly shared');
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'diary') FROM share_fixture),0,'diary is not implicitly shared');
SELECT ok((SELECT NOT (shared_child_snapshot((value->>'id')::uuid)->'daily'->0 ? 'memo') FROM share_fixture),'free-form feeding memo omitted');
SELECT is((SELECT count(*) FROM baby_logs),0::bigint,'viewer cannot query raw logs');
SELECT throws_ok($$INSERT INTO baby_logs(household_id,logged_by,log_type,memo) VALUES('d1000000-0000-4000-8000-000000000001',auth.uid(),'memo','denied')$$,'42501',NULL,'viewer write denied');
SELECT throws_ok($$SELECT revoke_child_share((SELECT (value->>'id')::uuid FROM share_fixture))$$,'42501',NULL,'viewer cannot revoke as owner');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
SELECT throws_ok($$SELECT accept_child_share((SELECT value->>'token' FROM share_fixture))$$,'42501',NULL,'second viewer cannot reuse invitation');
SELECT throws_ok($$SELECT shared_child_snapshot((SELECT (value->>'id')::uuid FROM share_fixture))$$,'42501',NULL,'share id alone grants no access');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT lives_ok($$SELECT revoke_child_share((SELECT (value->>'id')::uuid FROM share_fixture))$$,'owner revokes access');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT throws_ok($$SELECT shared_child_snapshot((SELECT (value->>'id')::uuid FROM share_fixture))$$,'42501',NULL,'revoked share fails on server immediately');
SELECT is((SELECT jsonb_array_length(list_child_shares(false))),0,'revoked share removed from list');
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
TRUNCATE share_fixture;
INSERT INTO share_fixture SELECT create_child_share((SELECT id FROM children WHERE is_legacy),false,true,true,false,NULL);
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT accept_child_share((SELECT value->>'token' FROM share_fixture));
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'health') FROM share_fixture),1,'explicit health permission has a positive control');
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'diary') FROM share_fixture),1,'explicit diary permission has a positive control');
SELECT is((SELECT jsonb_array_length(shared_child_snapshot((value->>'id')::uuid)->'daily') FROM share_fixture),0,'unselected daily category is omitted');
RESET ROLE;
UPDATE child_shares SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=(SELECT (value->>'id')::uuid FROM share_fixture);
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT shared_child_snapshot((SELECT (value->>'id')::uuid FROM share_fixture))$$,'42501',NULL,'expired sharing is refused server-side');
SELECT is((SELECT jsonb_array_length(list_child_shares(false))),0,'expired share disappears from list');
RESET ROLE;
UPDATE profiles SET household_id='d1000000-0000-4000-8000-000000000001' WHERE id='d1000000-0000-4000-8000-000000000005';
SET LOCAL ROLE authenticated;
SELECT is(public.get_my_household_id(),NULL::uuid,'legacy viewer membership grants no household data authority');
SELECT is((SELECT count(*) FROM children),0::bigint,'legacy household viewer cannot enumerate children');
RESET ROLE;
UPDATE profiles SET household_id='d1000000-0000-4000-8000-000000000002',is_approved=true WHERE id='d1000000-0000-4000-8000-000000000006';
INSERT INTO app_operators(user_id) VALUES('d1000000-0000-4000-8000-000000000006');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"d1000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM baby_logs),0::bigint,'operator has no automatic authority over another household childcare data');
SELECT is(jsonb_array_length(list_child_shares(true)),0,'operator cannot manage another household sharing');
SELECT ok(NOT has_function_privilege('anon','public.shared_child_snapshot(uuid)','EXECUTE'),'anon cannot call shared data definer');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
