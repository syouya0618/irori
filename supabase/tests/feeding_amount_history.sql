BEGIN;
SELECT plan(18);
INSERT INTO public.households(id,name) VALUES
 ('a0000000-0000-4000-8000-000000000001','household-a'),
 ('b0000000-0000-4000-8000-000000000001','household-b');
INSERT INTO auth.users(id,email) VALUES
 ('a0000000-0000-4000-8000-000000000002','user-a@example.invalid'),
 ('a0000000-0000-4000-8000-000000000003','member-a@example.invalid'),
 ('b0000000-0000-4000-8000-000000000002','user-b@example.invalid');
UPDATE public.profiles SET household_id='a0000000-0000-4000-8000-000000000001',is_approved=true
 WHERE id IN ('a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003');
UPDATE public.profiles SET household_id='b0000000-0000-4000-8000-000000000001',is_approved=true
 WHERE id='b0000000-0000-4000-8000-000000000002';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM public.feeding_amount_history),0::bigint,'first use has no invented candidates');
INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml)
 SELECT 'a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','bottle',n
 FROM generate_series(12,72,12) n ORDER BY n;
SELECT is((SELECT count(*) FROM public.feeding_amount_history),5::bigint,'six writes retain exactly five');
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[72,60,48,36,24],'last distinct input first');
INSERT INTO public.baby_logs(id,household_id,logged_by,log_type,feeding_type,amount_ml)
 VALUES('a0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','bottle',36);
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[36,72,60,48,24],'reuse moves the existing value first');
SELECT throws_ok($$INSERT INTO public.baby_logs(id,household_id,logged_by,log_type,feeding_type,amount_ml)
 VALUES('a0000000-0000-4000-8000-000000000004','a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','bottle',99)$$,'23505',NULL,'replay is not another use');
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[36,72,60,48,24],'rejected replay cannot change candidates');
SELECT throws_ok($$INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml)
 VALUES('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','bottle',1000)$$,'23514',NULL,'invalid input is rejected');
DO $$BEGIN
  INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml)
  VALUES('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','bottle',88);
  RAISE EXCEPTION 'synthetic rollback';
EXCEPTION WHEN raise_exception THEN NULL;
END$$;
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[36,72,60,48,24],'rolled back write creates no use');
UPDATE public.baby_logs SET memo='synthetic note' WHERE id='a0000000-0000-4000-8000-000000000004';
SELECT results_eq('SELECT amount_ml::int FROM public.feeding_amount_history ORDER BY use_order DESC',ARRAY[36,72,60,48,24],'editing a memo is not another amount input');
INSERT INTO public.baby_logs(household_id,logged_by,log_type,feeding_type,amount_ml)
 VALUES('a0000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','feeding','pumped',90);
SELECT is((SELECT amount_ml::int FROM public.feeding_amount_history WHERE feeding_type='pumped'),90,'record kinds are isolated');
SELECT is((SELECT use_order FROM public.feeding_amount_history WHERE feeding_type='pumped'),1::bigint,'recency counters do not expose activity outside this personal record-kind scope');
SELECT is((SELECT count(*) FROM public.feeding_amount_history WHERE feeding_type='bottle'),5::bigint,'pumped does not evict bottle');
SELECT throws_ok($$DELETE FROM public.feeding_amount_history$$,'42501',NULL,'client cannot fabricate usage with direct writes');
SELECT set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM public.feeding_amount_history),0::bigint,'another member has separate personal history');
SELECT set_config('request.jwt.claims','{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM public.feeding_amount_history),0::bigint,'another household cannot read the history');
RESET ROLE;
UPDATE public.profiles SET is_approved=false WHERE id='a0000000-0000-4000-8000-000000000002';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"a0000000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM public.feeding_amount_history),0::bigint,'approval revocation denies history');
SET LOCAL ROLE anon;
SELECT ok(NOT has_table_privilege('public.feeding_amount_history','SELECT'),'anon has no table read grant');
SELECT ok(NOT has_table_privilege('public.feeding_amount_history','INSERT'),'anon cannot invent candidates');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
