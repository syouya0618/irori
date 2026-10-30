BEGIN;
SELECT plan(24);
INSERT INTO public.households(id,name,baby_name,baby_birth_date,bottle_default_ml) VALUES
 ('c0000000-0000-4000-8000-000000000001','synthetic household A','synthetic child A1','2026-01-01',120),
 ('c0000000-0000-4000-8000-000000000002','synthetic household B','synthetic child B1',NULL,NULL);
INSERT INTO auth.users(id,email) VALUES ('c0000000-0000-4000-8000-000000000003','child-editor@example.invalid');
UPDATE public.profiles SET household_id='c0000000-0000-4000-8000-000000000001',is_approved=true,role='owner'
 WHERE id='c0000000-0000-4000-8000-000000000003';
INSERT INTO public.children(id,household_id,name,bottle_default_ml) VALUES
 ('c0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000001','synthetic child A2',70);
SELECT is((SELECT count(*) FROM public.children WHERE is_legacy),2::bigint,'one legacy child per household');
SELECT is((SELECT bottle_default_ml::int FROM public.children WHERE is_legacy AND household_id='c0000000-0000-4000-8000-000000000001'),120,'old default is inherited');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"c0000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM public.children),2::bigint,'children of other household are invisible');
INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml,memo)
 VALUES('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','feeding','bottle',120,'legacy payload');
SELECT is((SELECT count(*) FROM public.baby_logs WHERE child_id=(SELECT id FROM public.children WHERE is_legacy)),1::bigint,'old payload binds legacy child');
SELECT set_config('request.headers','{"x-irori-child":"c0000000-0000-4000-8000-000000000004"}',true);
SELECT is((SELECT count(*) FROM public.baby_logs),0::bigint,'switch hides legacy logs');
SELECT is((SELECT count(*) FROM public.feeding_amount_history),0::bigint,'sibling starts with no borrowed candidates');
SELECT throws_ok($$INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml)
 VALUES('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','feeding','bottle',80)$$,'42501',NULL,'old payload cannot silently target selected sibling');
INSERT INTO public.baby_logs(household_id,child_id,logged_by,log_type,feeding_type,amount_ml)
 SELECT 'c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000003','feeding','bottle',n FROM generate_series(10,60,10)n;
SELECT is((SELECT count(*) FROM public.feeding_amount_history),5::bigint,'each child retains at most five');
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[60,50,40,30,20],'child-specific recency');
SELECT throws_ok($$UPDATE public.baby_logs SET child_id=(SELECT id FROM public.children WHERE is_legacy)$$,'23514',NULL,'saved child cannot be reassigned');
SELECT throws_ok($$UPDATE public.children SET is_legacy=true WHERE NOT is_legacy$$,'23514',NULL,'legacy identity cannot be stolen');
SELECT throws_ok($$INSERT INTO public.baby_logs(household_id,child_id,logged_by,log_type,memo)
 SELECT 'c0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000004','c0000000-0000-4000-8000-000000000003','memo','denied'$$,'42501',NULL,'other household write denied');
UPDATE public.children SET bottle_default_ml=75 WHERE id='c0000000-0000-4000-8000-000000000004';
SELECT is((SELECT bottle_default_ml::int FROM public.households WHERE id='c0000000-0000-4000-8000-000000000001'),120,'sibling default leaves legacy household unchanged');
SELECT set_config('irori_test.child_version',(SELECT updated_at::text FROM children WHERE id='c0000000-0000-4000-8000-000000000004'),true);
UPDATE children SET name='synthetic newer child name' WHERE id='c0000000-0000-4000-8000-000000000004';
WITH changed AS (UPDATE children SET name='stale edit' WHERE id='c0000000-0000-4000-8000-000000000004' AND updated_at=current_setting('irori_test.child_version')::timestamptz RETURNING id)
 SELECT is((SELECT count(*) FROM changed),0::bigint,'stale profile version cannot overwrite a newer edit');
SELECT is((SELECT name FROM children WHERE id='c0000000-0000-4000-8000-000000000004'),'synthetic newer child name','newer child profile survives stale save');
SELECT set_config('request.headers','{}',true);
SELECT is((SELECT count(*) FROM public.baby_logs),1::bigint,'legacy read excludes sibling logs');
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history',ARRAY[120],'legacy candidates preserved');
INSERT INTO public.baby_diaries(household_id,diary_date,content) VALUES ('c0000000-0000-4000-8000-000000000001','2026-01-01','synthetic legacy diary');
SELECT set_config('request.headers','{"x-irori-child":"c0000000-0000-4000-8000-000000000004"}',true);
INSERT INTO public.baby_diaries(household_id,child_id,diary_date,content) VALUES ('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000004','2026-01-01','synthetic sibling diary');
SELECT results_eq('SELECT content FROM public.baby_diaries',ARRAY['synthetic sibling diary'],'same date diaries remain separate');
SELECT set_config('request.headers','{"x-irori-child":"invalid"}',true);
SELECT is((SELECT count(*) FROM public.baby_logs),0::bigint,'invalid selector fails closed');
RESET ROLE;
UPDATE public.profiles SET role='viewer' WHERE id='c0000000-0000-4000-8000-000000000003';
SET LOCAL ROLE authenticated;
SELECT set_config('request.headers','{}',true);
SELECT is((SELECT count(*) FROM public.baby_logs),0::bigint,'viewer never receives raw baby data');
SELECT throws_ok($$INSERT INTO public.baby_logs(household_id,logged_by,log_type,memo)
 VALUES('c0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000003','memo','denied')$$,'42501',NULL,'viewer cannot write');
SELECT ok(NOT has_table_privilege('authenticated','public.children','DELETE'),'no destructive child deletion grant');
SELECT ok(NOT has_table_privilege('anon','public.children','SELECT'),'anon has no child select grant');
SELECT ok(NOT has_function_privilege('anon','irori_private.request_child(uuid)','EXECUTE'),'anon cannot call selector definer');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
