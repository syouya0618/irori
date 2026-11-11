-- ごはん（献立・在庫・買い物）: 世帯分離・直接 DML 拒否・保存契約（saved / replayed / conflict）・
-- 個人設定の境界・献立の固定枠と版・買い物の冪等同期・在庫補充の二重適用防止・AI 回数計上。
--
-- 登場人物（UUID 接頭辞 f5000000）
--   世帯 A = …01: A1（owner）…03 / A2（member）…04 / 子 …07
--   世帯 B = …02: B1（owner）…05 / 子 …08
--   U6 = …06: どの世帯にも属さず、世帯 A の子の閲覧招待だけを受諾する人
-- 権限は migration が入れたものだけを検証する（このファイルは public の表・関数へ GRANT を足さない）。
BEGIN;
SELECT plan(464);

INSERT INTO households(id,name) VALUES
 ('f5000000-0000-4000-8000-000000000001','synthetic dinner household A'),
 ('f5000000-0000-4000-8000-000000000002','synthetic dinner household B');
INSERT INTO auth.users(id,email) VALUES
 ('f5000000-0000-4000-8000-000000000003','dinner-a1@example.invalid'),
 ('f5000000-0000-4000-8000-000000000004','dinner-a2@example.invalid'),
 ('f5000000-0000-4000-8000-000000000005','dinner-b1@example.invalid'),
 ('f5000000-0000-4000-8000-000000000006','dinner-share-viewer@example.invalid');
UPDATE profiles SET household_id='f5000000-0000-4000-8000-000000000001',is_approved=true,role='owner' WHERE id='f5000000-0000-4000-8000-000000000003';
UPDATE profiles SET household_id='f5000000-0000-4000-8000-000000000001',is_approved=true,role='member' WHERE id='f5000000-0000-4000-8000-000000000004';
UPDATE profiles SET household_id='f5000000-0000-4000-8000-000000000002',is_approved=true,role='owner' WHERE id='f5000000-0000-4000-8000-000000000005';
INSERT INTO children(id,household_id,name) VALUES
 ('f5000000-0000-4000-8000-000000000007','f5000000-0000-4000-8000-000000000001','synthetic dinner child A'),
 ('f5000000-0000-4000-8000-000000000008','f5000000-0000-4000-8000-000000000002','synthetic dinner child B');

-- RPC の戻り値や行 ID を役割の切替を跨いで持ち回す。
CREATE TEMP TABLE fx(k text PRIMARY KEY, v jsonb);
GRANT ALL ON fx TO authenticated;
-- 今日（JST）からの相対日。
CREATE FUNCTION pg_temp.jd(n integer) RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Asia/Tokyo')::date + n $$;
CREATE FUNCTION pg_temp.pantry(p_name text, p_qty numeric) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('ingredient_id','carrot','name',p_name,'quantity',p_qty,'unit','piece','status','have','use_soon',false,'storage','fridge','expires_on',NULL,'confirmed_on',pg_temp.jd(0)::text) $$;
CREATE FUNCTION pg_temp.entry(p_day integer, p_role text, p_recipe text, p_pinned boolean, p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('plan_date',pg_temp.jd(p_day)::text,'role',p_role,'position',0,'recipe_id',p_recipe,'recipe_version',1,'servings',2,'pinned',p_pinned,'status',p_status,'origin','auto') $$;
CREATE FUNCTION pg_temp.need(p_ingredient text, p_family text, p_qty numeric, p_unit text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('item_key',p_ingredient||'|'||p_family,'ingredient_id',p_ingredient,'name','synthetic '||p_ingredient,'required_quantity',p_qty,'unit',p_unit,'required_note',NULL,'needs_stock_check',false,
  'sources',jsonb_build_array(jsonb_build_object('date',pg_temp.jd(0)::text,'recipeId','curry_rice','title','synthetic curry','quantity',jsonb_build_object('amount',p_qty,'unit',p_unit)))) $$;
-- 世帯単位 8 表の、いま見えている行数。
CREATE FUNCTION pg_temp.visible() RETURNS bigint[] LANGUAGE sql STABLE AS $$
 SELECT ARRAY[(SELECT count(*) FROM dinner_settings),(SELECT count(*) FROM pantry_items),(SELECT count(*) FROM food_exclusions),(SELECT count(*) FROM food_preferences),
  (SELECT count(*) FROM dish_feedback),(SELECT count(*) FROM dinner_plan_state),(SELECT count(*) FROM dinner_plan_entries),(SELECT count(*) FROM grocery_items)] $$;
-- 買い物リスト全体の指紋（行数と全列。updated_at を含む）。
CREATE FUNCTION pg_temp.grocery_print() RETURNS text LANGUAGE sql STABLE AS $$
 SELECT count(*)::text || ':' || md5(coalesce(string_agg(to_jsonb(g)::text, ',' ORDER BY g.item_key), '')) FROM grocery_items g $$;
CREATE FUNCTION pg_temp.dinner_tables() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['dinner_settings','pantry_items','food_exclusions','food_preferences','dish_feedback','dinner_plan_state','dinner_plan_entries','grocery_items','dinner_ai_usage','dinner_ai_provider_state'] $$;
CREATE FUNCTION pg_temp.dinner_rpcs() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT ARRAY['save_dinner_settings','save_pantry_item','delete_pantry_item','add_pantry_items','save_food_exclusion','delete_food_exclusion','save_food_preference','delete_food_preference',
  'save_dish_feedback','delete_dish_feedback','apply_dinner_plan','save_dinner_entry','delete_dinner_entry','confirm_dinner_entries','sync_grocery_auto_items','save_grocery_manual_item','delete_grocery_item',
  'set_grocery_purchase','update_grocery_item_meta','restock_pantry_from_grocery','claim_dinner_ai_call','dinner_ai_status','mark_dinner_ai_exhausted'] $$;

-- ── 0. 構造: RLS・GRANT・ポリシー・EXECUTE（migration が入れた ACL そのもの）──
SELECT is((SELECT count(*) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname=ANY(pg_temp.dinner_tables()) AND c.relrowsecurity),10::bigint,'all ten dinner tables have RLS enabled');
SELECT ok(NOT EXISTS(SELECT 1 FROM unnest(pg_temp.dinner_tables()) t, unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('anon','public.'||t,p)),'anon has no privilege on any dinner table');
SELECT is((SELECT array_agg(t ORDER BY t) FROM unnest(pg_temp.dinner_tables()) t WHERE has_table_privilege('authenticated','public.'||t,'SELECT')),
 ARRAY['dinner_plan_entries','dinner_plan_state','dinner_settings','dish_feedback','food_exclusions','food_preferences','grocery_items','pantry_items'],'authenticated may SELECT exactly the eight household tables (AI tables are deny-all)');
SELECT ok(NOT EXISTS(SELECT 1 FROM unnest(pg_temp.dinner_tables()) t, unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE']) p WHERE has_table_privilege('authenticated','public.'||t,p)),'authenticated has no write privilege on any dinner table');
SELECT is((SELECT array_agg(tablename::text||':'||cmd ORDER BY tablename) FROM pg_policies WHERE schemaname='public' AND tablename=ANY(pg_temp.dinner_tables())),
 ARRAY['dinner_plan_entries:SELECT','dinner_plan_state:SELECT','dinner_settings:SELECT','dish_feedback:SELECT','food_exclusions:SELECT','food_preferences:SELECT','grocery_items:SELECT','pantry_items:SELECT'],'only SELECT policies exist (no FOR ALL, no write policy)');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(pg_temp.dinner_rpcs())),23::bigint,'all 23 dinner RPCs exist exactly once');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(pg_temp.dinner_rpcs()) AND p.prosecdef AND p.proconfig @> ARRAY['search_path=""']),23::bigint,'every dinner RPC is SECURITY DEFINER with an empty search_path');
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(pg_temp.dinner_rpcs()) AND has_function_privilege('anon',p.oid,'EXECUTE')),'anon cannot execute any dinner RPC');
SELECT is((SELECT array_agg(p.proname::text ORDER BY p.proname) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname=ANY(pg_temp.dinner_rpcs()) AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')),
 ARRAY['mark_dinner_ai_exhausted'],'authenticated may execute every dinner RPC except the provider-exhaustion marker');
SELECT ok(has_function_privilege('service_role','public.mark_dinner_ai_exhausted(timestamptz)','EXECUTE'),'service_role may mark provider exhaustion');
SELECT is((SELECT count(*) FROM pg_proc p WHERE p.pronamespace='irori_private'::regnamespace AND p.proname LIKE 'dinner\_%'),25::bigint,'internal dinner helpers exist (control for the next assertion)');
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='irori_private'::regnamespace AND p.proname LIKE 'dinner\_%' AND (has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('anon',p.oid,'EXECUTE'))),'internal dinner helpers are not executable by API roles');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);

-- ── 1. 設定 ──
SELECT is((save_dinner_settings(NULL,3,true,30,ARRAY['soy_sauce','rice','rice'],'{"f5000000-0000-4000-8000-000000000007":"toddler_2y_plus"}')->>'status'),'saved','A1 creates household dinner settings');
SELECT is((SELECT staples FROM dinner_settings),ARRAY['rice','soy_sauce'],'staples are stored distinct and sorted');
SELECT is((save_dinner_settings(NULL,3,true,30,ARRAY['rice','soy_sauce'],'{"f5000000-0000-4000-8000-000000000007":"toddler_2y_plus"}')->>'status'),'replayed','same settings replay without a version');
SELECT is((save_dinner_settings('2020-01-01T00:00:00Z',4,true,30,ARRAY['rice'],'{}')->>'status'),'conflict','stale version cannot overwrite settings');
SELECT is((SELECT servings FROM dinner_settings),3::smallint,'conflicting save left settings unchanged');
SELECT throws_ok($$SELECT save_dinner_settings((SELECT updated_at FROM dinner_settings),3,true,30,ARRAY['rice'],'{"f5000000-0000-4000-8000-000000000008":"toddler_2y_plus"}')$$,'42501',NULL,'child of another household is rejected in child stages');
SELECT throws_ok($$SELECT save_dinner_settings((SELECT updated_at FROM dinner_settings),13,true,30,ARRAY['rice'],'{}')$$,'22023',NULL,'servings above 12 rejected');
SELECT throws_ok($$SELECT save_dinner_settings((SELECT updated_at FROM dinner_settings),3,true,4,ARRAY['rice'],'{}')$$,'22023',NULL,'cook time below 5 minutes rejected');
SELECT throws_ok($$SELECT save_dinner_settings((SELECT updated_at FROM dinner_settings),3,true,30,ARRAY['bad|id'],'{}')$$,'22023',NULL,'staple id with a separator rejected');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT servings FROM dinner_settings),3::smallint,'A2 reads the same household settings');
SELECT is((save_dinner_settings((SELECT updated_at FROM dinner_settings),4,false,NULL,ARRAY['rice'],'{}')->>'status'),'saved','A2 edits shared settings with the current version');
SELECT is((SELECT updated_by FROM dinner_settings),'f5000000-0000-4000-8000-000000000004'::uuid,'settings record who changed them');

-- ── 2. 在庫 ──
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_pantry_item('f5000000-0000-4000-8000-000000000010',NULL,pg_temp.pantry('  合成にんじん ',2))#>>'{item,name}'),'合成にんじん','pantry item created with a client id; Japanese name stored trimmed');
SELECT is((save_pantry_item('f5000000-0000-4000-8000-000000000010',NULL,pg_temp.pantry('合成にんじん',2))->>'status'),'replayed','same id and content replays');
SELECT is((save_pantry_item('f5000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z',pg_temp.pantry('合成にんじん',5))->>'status'),'conflict','stale version cannot overwrite a pantry item');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry(repeat('あ',41),1))$$,'22023',NULL,'name longer than 40 characters rejected');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry(E'synthetic\nline break',1))$$,'22023',NULL,'control characters in a name rejected');
SELECT is((SELECT quantity FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000010'),2::numeric,'conflicting save left the quantity unchanged');
SELECT is((save_pantry_item('f5000000-0000-4000-8000-000000000019','2020-01-01T00:00:00Z',pg_temp.pantry('synthetic ghost',1))),'{"status":"conflict","item":{"id":"f5000000-0000-4000-8000-000000000019","deleted":true}}'::jsonb,'versioned save of a missing row is a conflict carrying a deleted marker (and creates nothing)');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry('synthetic bad',-1))$$,'22023',NULL,'negative quantity rejected');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry('synthetic bad',1)||jsonb_build_object('confirmed_on',pg_temp.jd(1)::text))$$,'22023',NULL,'future confirmation date rejected');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry('synthetic bad',1)||'{"household_id":"f5000000-0000-4000-8000-000000000002"}')$$,'22023',NULL,'client-supplied household_id is not an accepted field');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry('synthetic bad',1)||'{"unit":null}')$$,'22023',NULL,'quantity without a unit rejected');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000019',NULL,pg_temp.pantry('synthetic bad',1)||'{"status":"gone"}')$$,'22023',NULL,'unknown status rejected');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((save_pantry_item('f5000000-0000-4000-8000-000000000010',(SELECT updated_at FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000010'),pg_temp.pantry('合成にんじん',1))->>'status'),'saved','A2 edits the item A1 created');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
INSERT INTO fx VALUES('bulk',add_pantry_items(jsonb_build_array(pg_temp.pantry('synthetic onion',3)||'{"id":"f5000000-0000-4000-8000-000000000011"}',pg_temp.pantry('synthetic potato',4)||'{"id":"f5000000-0000-4000-8000-000000000012"}')));
SELECT is((SELECT (v->>'status')||':'||(v->>'saved')||':'||(v->>'replayed') FROM fx WHERE k='bulk'),'saved:2:0','bulk add inserts both items');
SELECT is((SELECT (r->>'status')||':'||(r->>'saved')||':'||(r->>'replayed') FROM add_pantry_items(jsonb_build_array(pg_temp.pantry('synthetic onion',3)||'{"id":"f5000000-0000-4000-8000-000000000011"}',pg_temp.pantry('synthetic potato',4)||'{"id":"f5000000-0000-4000-8000-000000000012"}')) r),'replayed:0:2','resending the same bulk add only replays');
SELECT is((SELECT count(*) FROM pantry_items),3::bigint,'bulk replay did not duplicate rows');
SELECT throws_ok($$SELECT add_pantry_items(jsonb_build_array(pg_temp.pantry('synthetic leek',1)||'{"id":"f5000000-0000-4000-8000-000000000014"}',pg_temp.pantry('synthetic onion',9)||'{"id":"f5000000-0000-4000-8000-000000000011"}'))$$,'23505',NULL,'bulk add refuses to change an existing id');
SELECT is((SELECT count(*) FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000014'),0::bigint,'failed bulk add is atomic (earlier element rolled back)');
SELECT throws_ok($$SELECT add_pantry_items((SELECT jsonb_agg(pg_temp.pantry('synthetic many',1)||jsonb_build_object('id',gen_random_uuid())) FROM generate_series(1,51)))$$,'22023',NULL,'bulk add above 50 items rejected');
SELECT is((delete_pantry_item('f5000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z')->>'status'),'conflict','stale version cannot delete');
SELECT is((delete_pantry_item('f5000000-0000-4000-8000-000000000010',(SELECT updated_at FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000010'))->>'status'),'saved','delete with the current version');
SELECT is((delete_pantry_item('f5000000-0000-4000-8000-000000000010','2020-01-01T00:00:00Z')->>'status'),'replayed','deleting again replays');

-- ── 3. 必須除外（正規メンバーなら誰でも登録・削除できる）──
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000020','child',NULL,'f5000000-0000-4000-8000-000000000007','allergy','allergen','egg',NULL)->>'status'),'saved','allergy registered for a child of the household');
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000020','child',NULL,'f5000000-0000-4000-8000-000000000007','allergy','allergen','egg',NULL)->>'status'),'replayed','same exclusion id replays');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000020','child',NULL,'f5000000-0000-4000-8000-000000000007','allergy','allergen','milk',NULL)$$,'23505',NULL,'same exclusion id cannot change its content');
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000029','child',NULL,'f5000000-0000-4000-8000-000000000007','allergy','allergen','egg',NULL)#>>'{exclusion,id}'),'f5000000-0000-4000-8000-000000000020','a duplicate under a new id returns the existing exclusion');
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000021','child',NULL,'f5000000-0000-4000-8000-000000000007','dislike','allergen','egg',NULL)->>'status'),'saved','a dislike does not block or replace an allergy on the same target');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000028','child',NULL,'f5000000-0000-4000-8000-000000000008','allergy','allergen','egg',NULL)$$,'42501',NULL,'child of another household rejected');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000028','member','f5000000-0000-4000-8000-000000000005',NULL,'allergy','allergen','egg',NULL)$$,'42501',NULL,'profile of another household rejected');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000028','household',NULL,NULL,'allergy','allergen','egg','synthetic label')$$,'22023',NULL,'allergen target cannot carry a custom label');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000028','member',NULL,NULL,'allergy','allergen','egg',NULL)$$,'22023',NULL,'member subject needs a profile');
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000022','household',NULL,NULL,'dislike','custom',NULL,'  synthetic Label ')#>>'{exclusion,custom_label}'),'synthetic Label','custom label is stored trimmed');
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000027','household',NULL,NULL,'dislike','custom',NULL,'SYNTHETIC label')->>'status'),'conflict','custom labels dedupe case-insensitively');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((save_food_exclusion('f5000000-0000-4000-8000-000000000023','member','f5000000-0000-4000-8000-000000000003',NULL,'allergy','ingredient','shrimp',NULL)->>'status'),'saved','A2 registers an allergy on behalf of A1');
SELECT is((delete_food_exclusion('f5000000-0000-4000-8000-000000000021')->>'status'),'saved','A2 deletes an exclusion A1 registered');
SELECT is((delete_food_exclusion('f5000000-0000-4000-8000-000000000021')->>'status'),'replayed','deleting the exclusion again replays');
SELECT is((SELECT array_agg(id::text ORDER BY id) FROM food_exclusions),ARRAY['f5000000-0000-4000-8000-000000000020','f5000000-0000-4000-8000-000000000022','f5000000-0000-4000-8000-000000000023'],'exactly the three registered exclusions remain');

-- ── 4. 好み（personal は本人だけ / household は正規メンバー）──
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000030',NULL,'personal','recipe','curry_rice','like')->>'status'),'saved','A1 saves a personal preference');
SELECT is((SELECT profile_id FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000030'),'f5000000-0000-4000-8000-000000000003'::uuid,'personal preference is bound to the caller');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000030',NULL,'personal','recipe','curry_rice','like')->>'status'),'replayed','same personal preference replays');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000031',NULL,'household','tag','fish','like')->>'status'),'saved','A1 saves a household preference');
SELECT throws_ok($$SELECT save_food_preference('f5000000-0000-4000-8000-000000000039',NULL,'personal','recipe','Bad Id','like')$$,'22023',NULL,'invalid target id rejected');
SELECT throws_ok($$SELECT save_food_preference('f5000000-0000-4000-8000-000000000031',(SELECT updated_at FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000031'),'personal','tag','fish','like')$$,'22023',NULL,'a household preference cannot be turned into a personal one');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM food_preferences),2::bigint,'A2 can read household and personal preferences of the household');
SELECT throws_ok($$SELECT save_food_preference('f5000000-0000-4000-8000-000000000030',(SELECT updated_at FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000030'),'personal','recipe','curry_rice','dislike')$$,'42501',NULL,'A2 cannot change the personal preference of A1 even with the current version');
SELECT throws_ok($$SELECT delete_food_preference('f5000000-0000-4000-8000-000000000030')$$,'42501',NULL,'A2 cannot delete the personal preference of A1');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000032',NULL,'personal','recipe','curry_rice','dislike')->>'status'),'saved','A2 keeps an own personal preference on the same target');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000031',(SELECT updated_at FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000031'),'household','tag','fish','dislike')->>'status'),'saved','A2 edits the household preference with the current version');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000031','2020-01-01T00:00:00Z','household','tag','fish','like')->>'status'),'conflict','stale version cannot overwrite the household preference');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000033',NULL,'household','tag','fish','like')#>>'{preference,id}'),'f5000000-0000-4000-8000-000000000031','a duplicate household target under a new id returns the existing row');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((SELECT sentiment FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000030'),'like','personal preference of A1 survived the attempts of A2');
SELECT is((save_food_preference('f5000000-0000-4000-8000-000000000030',(SELECT updated_at FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000030'),'personal','recipe','curry_rice','dislike')->>'status'),'saved','the owner can change the own personal preference (control)');
SELECT is((delete_food_preference('f5000000-0000-4000-8000-000000000030')->>'status'),'saved','the owner can delete the own personal preference');
SELECT is((delete_food_preference('f5000000-0000-4000-8000-000000000030')->>'status'),'replayed','deleting the preference again replays');

-- ── 5. 食後評価（本人・料理・日付。本人だけが書ける）──
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000040',NULL,'curry_rice','synthetic curry',pg_temp.jd(0),3,2,true,false)->>'status'),'saved','A1 records feedback for today');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000040',NULL,'curry_rice','synthetic curry',pg_temp.jd(0),3,2,true,false)->>'status'),'replayed','same feedback replays');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000040','2020-01-01T00:00:00Z','curry_rice','synthetic curry',pg_temp.jd(0),1,2,true,false)->>'status'),'conflict','stale version cannot overwrite feedback');
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000049',NULL,'curry_rice','synthetic curry',pg_temp.jd(1),3,2,true,false)$$,'22023',NULL,'feedback for a future day rejected');
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000049',NULL,'curry_rice','synthetic curry','infinity',3,2,true,false)$$,'22023',NULL,'infinite date rejected');
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000049',NULL,'curry_rice','synthetic curry',pg_temp.jd(-1),4,2,true,false)$$,'22023',NULL,'taste outside 1..3 rejected');
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000040',(SELECT updated_at FROM dish_feedback WHERE id='f5000000-0000-4000-8000-000000000040'),'curry_rice','synthetic curry',pg_temp.jd(-1),3,2,true,false)$$,'22023',NULL,'feedback cannot be moved to another day');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000048',NULL,'curry_rice','another title',pg_temp.jd(0),1,1,false,false)#>>'{feedback,id}'),'f5000000-0000-4000-8000-000000000040','a second feedback for the same person, dish and day returns the existing row');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000040',(SELECT updated_at FROM dish_feedback WHERE id='f5000000-0000-4000-8000-000000000040'),'curry_rice','synthetic curry',pg_temp.jd(0),1,1,false,false)$$,'42501',NULL,'A2 cannot change the feedback of A1 even with the current version');
SELECT throws_ok($$SELECT delete_dish_feedback('f5000000-0000-4000-8000-000000000040')$$,'42501',NULL,'A2 cannot delete the feedback of A1');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000041',NULL,'curry_rice','synthetic curry',pg_temp.jd(0),1,NULL,NULL,true)->>'status'),'saved','A2 records an own feedback for the same dish and day');
SELECT is((SELECT count(*) FROM dish_feedback),2::bigint,'household members read each other''s feedback');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((SELECT taste FROM dish_feedback WHERE id='f5000000-0000-4000-8000-000000000040'),3::smallint,'feedback of A1 survived the attempts of A2');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000040',(SELECT updated_at FROM dish_feedback WHERE id='f5000000-0000-4000-8000-000000000040'),'curry_rice','synthetic curry',pg_temp.jd(0),2,2,true,false)->>'status'),'saved','the owner can edit the own feedback (control)');
SELECT is((save_dish_feedback('f5000000-0000-4000-8000-000000000047',NULL,NULL,'synthetic manual dish',pg_temp.jd(-1),NULL,3,NULL,false)->>'status'),'saved','feedback for a manual dish is keyed by its title');
SELECT is((delete_dish_feedback('f5000000-0000-4000-8000-000000000047')->>'status'),'saved','the owner can delete the own feedback');

-- ── 6. 献立（固定枠の保持・版の競合・操作の再送）──
INSERT INTO fx VALUES('plan1',apply_dinner_plan('f5000000-0000-4000-8000-000000000080',0,pg_temp.jd(-1),pg_temp.jd(1),jsonb_build_array(
 pg_temp.entry(-1,'main','recipe_a',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000050"}',
 pg_temp.entry(0,'main','recipe_b',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000051"}',
 pg_temp.entry(0,'side','recipe_c',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000052"}',
 pg_temp.entry(1,'main','recipe_d',false,'confirmed')||'{"id":"f5000000-0000-4000-8000-000000000053"}')));
SELECT is((SELECT (v->>'status')||':'||(v->>'revision')||':'||jsonb_array_length(v->'entries') FROM fx WHERE k='plan1'),'saved:1:4','first plan applies four entries at revision 1');
SELECT is((apply_dinner_plan('f5000000-0000-4000-8000-000000000080',0,pg_temp.jd(-1),pg_temp.jd(1),jsonb_build_array(
 pg_temp.entry(-1,'main','recipe_a',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000050"}',
 pg_temp.entry(0,'main','recipe_b',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000051"}',
 pg_temp.entry(0,'side','recipe_c',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000052"}',
 pg_temp.entry(1,'main','recipe_d',false,'confirmed')||'{"id":"f5000000-0000-4000-8000-000000000053"}'))->>'status'),'replayed','same operation id and payload replays');
SELECT is((SELECT revision FROM dinner_plan_state),1::bigint,'replay did not advance the revision');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000080',0,pg_temp.jd(-1),pg_temp.jd(1),jsonb_build_array(pg_temp.entry(0,'main','recipe_x',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000059"}'))$$,'23505',NULL,'same operation id cannot carry a different payload');
INSERT INTO fx VALUES('plan_stale',apply_dinner_plan('f5000000-0000-4000-8000-000000000081',0,pg_temp.jd(-1),pg_temp.jd(1),jsonb_build_array(pg_temp.entry(0,'main','recipe_x',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000059"}')));
SELECT is((SELECT (v->>'status')||':'||(v->>'revision') FROM fx WHERE k='plan_stale'),'conflict:1','stale expected revision conflicts and reports the latest revision');
SELECT is((SELECT count(*) FROM dinner_plan_entries),4::bigint,'conflicting plan changed nothing');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000051',(SELECT updated_at FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000051'),pg_temp.entry(0,'main','curry_rice',true,'confirmed'))->>'revision'),'2','pinning an entry saves and advances the revision');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000051','2020-01-01T00:00:00Z',pg_temp.entry(0,'main','curry_rice',true,'confirmed'))->>'status'),'replayed','resending the same entry replays even with an old version');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000051','2020-01-01T00:00:00Z',pg_temp.entry(0,'main','recipe_z',true,'confirmed'))->>'status'),'conflict','stale version cannot overwrite an entry');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000050',(SELECT updated_at FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000050'),pg_temp.entry(-1,'main','recipe_a',false,'cooked'))->>'revision'),'3','marking yesterday as cooked saves');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-000000000053',(SELECT updated_at FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000053'),pg_temp.entry(1,'main','recipe_d',false,'cooked'))$$,'22023',NULL,'a future dish cannot be marked cooked');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-000000000058',NULL,pg_temp.entry(1,'soup','recipe_s',false,'proposed')||'{"custom_title":"synthetic both"}')$$,'22023',NULL,'recipe and custom dish are exclusive');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-000000000058',NULL,pg_temp.entry(0,'side','recipe_s',false,'proposed'))$$,'23505',NULL,'an occupied slot is not silently replaced');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-000000000058',NULL,pg_temp.entry(1,'side',NULL,false,'proposed')||'{"recipe_version":null,"custom_title":"synthetic manual","custom_ingredients":[{"ingredientId":"carrot","quantity":{"amount":-1,"unit":"g"}}]}')$$,'22023',NULL,'manual ingredients with a negative amount rejected');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000055',NULL,pg_temp.entry(1,'side',NULL,false,'proposed')||'{"recipe_version":null,"origin":"manual","custom_title":"synthetic manual","custom_ingredients":[{"ingredientId":"carrot","quantity":{"amount":100,"unit":"g"}},{"ingredientId":"salt","quantity":{"amount":null,"unit":"pinch"},"optional":true}]}')->>'revision'),'4','manual dish with ingredients saves');
INSERT INTO fx VALUES('plan2',apply_dinner_plan('f5000000-0000-4000-8000-000000000082',4,pg_temp.jd(-1),pg_temp.jd(1),jsonb_build_array(
 pg_temp.entry(-1,'main','new_a',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000060"}',
 pg_temp.entry(0,'main','new_b',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000061"}',
 pg_temp.entry(0,'side','new_c',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000062"}',
 pg_temp.entry(1,'soup','new_d',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000063"}')));
SELECT is((SELECT (v->>'status')||':'||(v->>'revision') FROM fx WHERE k='plan2'),'saved:5','second plan applies at the current revision');
SELECT is((SELECT array_agg((s->>'id')||':'||(s->>'reason') ORDER BY s->>'id') FROM fx, jsonb_array_elements(v->'skipped') s WHERE k='plan2'),
 ARRAY['f5000000-0000-4000-8000-000000000060:cooked','f5000000-0000-4000-8000-000000000061:pinned'],'entries aimed at cooked and pinned slots are reported as skipped');
SELECT is((SELECT recipe_id||':'||pinned::text||':'||status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000051'),'curry_rice:true:confirmed','pinned slot kept its dish');
SELECT is((SELECT recipe_id||':'||status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000050'),'recipe_a:cooked','cooked slot kept its dish');
SELECT is((SELECT array_agg(right(id::text,2) ORDER BY id) FROM dinner_plan_entries),ARRAY['50','51','62','63'],'unpinned slots in the range were replaced, protected ones kept');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000052','2020-01-01T00:00:00Z',pg_temp.entry(0,'side','recipe_c',true,'confirmed'))#>>'{entry,deleted}'),'true','editing an entry that a new plan replaced is a conflict with a deleted marker');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000089',5,pg_temp.jd(0),pg_temp.jd(7),'[]')$$,'22023',NULL,'range longer than seven days rejected');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000089',5,pg_temp.jd(-1),pg_temp.jd(0),jsonb_build_array(pg_temp.entry(-1,'soup','recipe_x',false,'cooked')||'{"id":"f5000000-0000-4000-8000-000000000059"}'))$$,'22023',NULL,'a generated plan cannot mark dishes as cooked');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000089',5,pg_temp.jd(0),pg_temp.jd(1),jsonb_build_array(pg_temp.entry(2,'main','recipe_x',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000059"}'))$$,'22023',NULL,'entry outside the range rejected');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000089',5,pg_temp.jd(0),pg_temp.jd(1),jsonb_build_array(pg_temp.entry(0,'soup','recipe_x',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000059"}',pg_temp.entry(0,'soup','recipe_y',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000058"}'))$$,'22023',NULL,'two entries for one slot rejected');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*) FROM dinner_plan_entries),4::bigint,'A2 reads the same plan');
SELECT is((delete_dinner_entry('f5000000-0000-4000-8000-000000000063','2020-01-01T00:00:00Z')->>'status'),'conflict','stale version cannot delete an entry');
SELECT is((delete_dinner_entry('f5000000-0000-4000-8000-000000000063',(SELECT updated_at FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000063'))->>'revision'),'6','A2 deletes an entry and the revision advances');
SELECT is((delete_dinner_entry('f5000000-0000-4000-8000-000000000063','2020-01-01T00:00:00Z')->>'status'),'replayed','deleting the entry again replays');
SELECT is((SELECT revision FROM dinner_plan_state),6::bigint,'replayed delete did not advance the revision');

-- ── 7. 買い物（冪等な同期・手動項目と購入の保持・補充は一度だけ）──
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000083',6,jsonb_build_array(pg_temp.need('carrot','mass',300,'g'),pg_temp.need('egg','count_piece',4,'piece'),pg_temp.need('onion','mass',200,'g')))->>'status'),'saved','auto items synced for the current plan revision');
SELECT is((SELECT array_agg(item_key ORDER BY item_key) FROM grocery_items WHERE origin='auto'),ARRAY['carrot|mass','egg|count_piece','onion|mass'],'three auto items keyed by ingredient and unit family');
INSERT INTO fx SELECT 'carrot',to_jsonb(id) FROM grocery_items WHERE item_key='carrot|mass';
INSERT INTO fx SELECT 'egg',to_jsonb(id) FROM grocery_items WHERE item_key='egg|count_piece';
-- 手動項目は 2 種類置く: 記録の無いもの（…70）と、購入の印が付いたもの（…71）。同期の「削除」と「不要化」の両方が手動項目を避けることを見る。
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000070',NULL,'synthetic detergent',1,'bag',NULL,NULL)->>'status'),'saved','manual item added');
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000070',NULL,'synthetic detergent',1,'bag',NULL,NULL)->>'status'),'replayed','same manual item replays');
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000070','2020-01-01T00:00:00Z','synthetic detergent',2,'bag',NULL,NULL)->>'status'),'conflict','stale version cannot overwrite a manual item');
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000071',NULL,'synthetic tissue',NULL,NULL,'other',NULL)->>'status'),'saved','manual item without a quantity added');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000071',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000071'),0,true)->>'status'),'saved','non-numeric item ticked as purchased');
SELECT throws_ok($$SELECT save_grocery_manual_item((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),(SELECT updated_at FROM grocery_items WHERE item_key='egg|count_piece'),'synthetic hijack',1,'bag',NULL,NULL)$$,'22023',NULL,'an auto item cannot be rewritten as a manual item');
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'),300,false)->>'status'),'saved','300 g of carrot purchased');
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),'2020-01-01T00:00:00Z',300,false)->>'status'),'replayed','resending the same purchase replays');
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),'2020-01-01T00:00:00Z',100,false)->>'status'),'conflict','stale version cannot overwrite a purchase');
SELECT throws_ok($$SELECT set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'),-1,false)$$,'22023',NULL,'negative purchased quantity rejected');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000079',now(),1,false)#>>'{item,deleted}'),'true','ticking an item that no longer exists is a conflict with a deleted marker');
SELECT is((update_grocery_item_meta((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'),'synthetic memo','vegetable')->>'status'),'saved','note and section override saved');
SELECT is((update_grocery_item_meta((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),'2020-01-01T00:00:00Z','synthetic other memo',NULL)->>'status'),'conflict','stale version cannot overwrite the note');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000084',6,jsonb_build_array(pg_temp.need('carrot','mass',500,'g'),pg_temp.need('egg','count_piece',4,'piece'),pg_temp.need('onion','mass',200,'g')))->>'status'),'saved','required quantity grows from 300 to 500');
SELECT is((SELECT ARRAY[required_quantity,purchased_quantity,required_quantity-purchased_quantity] FROM grocery_items WHERE item_key='carrot|mass'),ARRAY[500,300,200]::numeric[],'purchase of 300 is kept, so 200 remains to buy');
SELECT is((SELECT note||':'||section FROM grocery_items WHERE item_key='carrot|mass'),'synthetic memo:vegetable','sync preserved the note and the section override');
INSERT INTO fx VALUES('print',to_jsonb(pg_temp.grocery_print()));
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000085',6,jsonb_build_array(pg_temp.need('carrot','mass',500,'g'),pg_temp.need('egg','count_piece',4,'piece'),pg_temp.need('onion','mass',200,'g')))->>'status'),'saved','syncing the same needs again under a new operation succeeds');
SELECT is(pg_temp.grocery_print(),(SELECT v#>>'{}' FROM fx WHERE k='print'),'second identical sync changed neither the row count nor any column (versions included)');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000085',6,jsonb_build_array(pg_temp.need('carrot','mass',500,'g'),pg_temp.need('egg','count_piece',4,'piece'),pg_temp.need('onion','mass',200,'g')))->>'status'),'replayed','same sync operation id replays');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-000000000085',6,jsonb_build_array(pg_temp.need('carrot','mass',900,'g')))$$,'23505',NULL,'same sync operation id cannot carry a different payload');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000086',5,jsonb_build_array(pg_temp.need('carrot','mass',900,'g')))->>'status'),'conflict','sync computed from an older plan revision conflicts');
SELECT is(pg_temp.grocery_print(),(SELECT v#>>'{}' FROM fx WHERE k='print'),'replayed and conflicting syncs changed nothing');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-000000000087',6,jsonb_build_array(pg_temp.need('carrot','mass',1,'g')||'{"item_key":"manual|f5000000-0000-4000-8000-000000000070"}'))$$,'22023',NULL,'auto sync cannot address a manual item key');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-000000000087',6,jsonb_build_array(pg_temp.need('carrot','mass',1,'g')||'{"purchased_quantity":0}'))$$,'22023',NULL,'auto sync cannot carry purchase fields');
SELECT is((SELECT array_agg(name||':'||still_needed::text||':'||purchased::text ORDER BY name) FROM grocery_items WHERE origin='manual'),ARRAY['synthetic detergent:true:false','synthetic tissue:true:true'],'manual items untouched by every sync');
INSERT INTO fx VALUES('restock',restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'),'f5000000-0000-4000-8000-000000000013',300));
SELECT is((SELECT v->>'status' FROM fx WHERE k='restock'),'saved','confirmed quantity restocked into the pantry');
SELECT is((restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),'2020-01-01T00:00:00Z','f5000000-0000-4000-8000-000000000013',300)->>'status'),'replayed','resending the same restock replays');
SELECT is((restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'),'f5000000-0000-4000-8000-000000000013',300)->>'status'),'replayed','resending the restock after a reload (current version) still replays');
SELECT is((SELECT ARRAY[restocked_quantity,purchased_quantity] FROM grocery_items WHERE item_key='carrot|mass'),ARRAY[300,300]::numeric[],'restock counted once and purchase left as it was');
SELECT is((SELECT array_agg(name||':'||quantity::int||':'||unit) FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000013'),ARRAY['synthetic carrot:300:g'],'exactly one pantry row was created by the restock');
SELECT is((restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),'2020-01-01T00:00:00Z','f5000000-0000-4000-8000-000000000015',100)->>'status'),'conflict','a new restock with a stale version conflicts');
SELECT is((SELECT count(*) FROM pantry_items WHERE id='f5000000-0000-4000-8000-000000000015'),0::bigint,'conflicting restock created no pantry row');
SELECT throws_ok($$SELECT restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),(SELECT updated_at FROM grocery_items WHERE item_key='egg|count_piece'),'f5000000-0000-4000-8000-000000000011',2)$$,'23505',NULL,'restock cannot reuse the id of an existing pantry row');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-000000000088',6,jsonb_build_array(pg_temp.need('egg','count_piece',4,'piece')))->>'status'),'saved','plan no longer needs carrot or onion');
SELECT is((SELECT array_agg(item_key||':'||still_needed::text ORDER BY item_key) FROM grocery_items WHERE origin='auto'),ARRAY['carrot|mass:false','egg|count_piece:true'],'purchased item is kept as not needed, untouched item is removed');
SELECT is((SELECT array_agg(name||':'||still_needed::text||':'||purchased::text ORDER BY name) FROM grocery_items WHERE origin='manual'),ARRAY['synthetic detergent:true:false','synthetic tissue:true:true'],'manual items are neither removed nor marked as not needed when auto items go away');
SELECT throws_ok($$SELECT delete_grocery_item((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),(SELECT updated_at FROM grocery_items WHERE item_key='egg|count_piece'))$$,'23514',NULL,'a still-needed auto item cannot be deleted');
SELECT is((delete_grocery_item((SELECT (v#>>'{}')::uuid FROM fx WHERE k='carrot'),(SELECT updated_at FROM grocery_items WHERE item_key='carrot|mass'))->>'status'),'saved','a no-longer-needed auto item can be cleared');
SELECT is((delete_grocery_item('f5000000-0000-4000-8000-000000000070','2020-01-01T00:00:00Z')->>'status'),'conflict','stale version cannot delete a manual item');
SELECT is((delete_grocery_item('f5000000-0000-4000-8000-000000000070',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000070'))->>'status'),'saved','manual item deleted with the current version');
SELECT is((delete_grocery_item('f5000000-0000-4000-8000-000000000070','2020-01-01T00:00:00Z')->>'status'),'replayed','deleting the manual item again replays');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),(SELECT updated_at FROM grocery_items WHERE item_key='egg|count_piece'),0,true)#>>'{item,purchased_by}'),'f5000000-0000-4000-8000-000000000004','A2 ticks an item of the shared list and is recorded as the buyer');

-- ── 8. 直接 DML は通らない（GRANT もポリシーも無い）──
SELECT throws_ok($$UPDATE dinner_settings SET servings=9$$,'42501','permission denied for table dinner_settings','no direct UPDATE on dinner_settings');
SELECT throws_ok($$UPDATE pantry_items SET name='x'$$,'42501','permission denied for table pantry_items','no direct UPDATE on pantry_items');
SELECT throws_ok($$UPDATE food_exclusions SET reason='dislike'$$,'42501','permission denied for table food_exclusions','no direct UPDATE on food_exclusions');
SELECT throws_ok($$UPDATE food_preferences SET sentiment='like'$$,'42501','permission denied for table food_preferences','no direct UPDATE on food_preferences');
SELECT throws_ok($$UPDATE dish_feedback SET taste=1$$,'42501','permission denied for table dish_feedback','no direct UPDATE on dish_feedback');
SELECT throws_ok($$UPDATE dinner_plan_state SET revision=0$$,'42501','permission denied for table dinner_plan_state','no direct UPDATE on dinner_plan_state');
SELECT throws_ok($$UPDATE dinner_plan_entries SET pinned=false$$,'42501','permission denied for table dinner_plan_entries','no direct UPDATE on dinner_plan_entries');
SELECT throws_ok($$UPDATE grocery_items SET purchased_quantity=0$$,'42501','permission denied for table grocery_items','no direct UPDATE on grocery_items');
SELECT throws_ok($$INSERT INTO pantry_items(id,household_id,name,confirmed_on) VALUES('f5000000-0000-4000-8000-000000000016','f5000000-0000-4000-8000-000000000001','synthetic direct',pg_temp.jd(0))$$,'42501','permission denied for table pantry_items','no direct INSERT on pantry_items');
SELECT throws_ok($$DELETE FROM food_exclusions$$,'42501','permission denied for table food_exclusions','no direct DELETE on food_exclusions');
SELECT throws_ok($$DELETE FROM grocery_items$$,'42501','permission denied for table grocery_items','no direct DELETE on grocery_items');
SELECT throws_ok($$SELECT count(*) FROM dinner_ai_usage$$,'42501','permission denied for table dinner_ai_usage','AI usage is not readable by users');
SELECT throws_ok($$SELECT count(*) FROM dinner_ai_provider_state$$,'42501','permission denied for table dinner_ai_provider_state','AI provider state is not readable by users');

-- ── 9. 世帯 A の 2 人は同じ行を読める ──
SELECT is(pg_temp.visible(),ARRAY[1,3,3,2,2,1,3,2]::bigint[],'A2 sees every household row');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is(pg_temp.visible(),ARRAY[1,3,3,2,2,1,3,2]::bigint[],'A1 sees exactly the same rows');

-- ── 10. AI 補助の回数（世帯 1 日 10 回）と provider 停止 ──
SELECT throws_ok($$SELECT claim_dinner_ai_call(11)$$,'22023',NULL,'limit above the hard maximum rejected');
SELECT throws_ok($$SELECT claim_dinner_ai_call(0)$$,'22023',NULL,'limit below 1 rejected');
SELECT is((SELECT (r->>'status')||':'||(r->>'used') FROM claim_dinner_ai_call(1) r),'ok:1','the first call of the day is granted');
SELECT is((SELECT (r->>'status')||':'||(r->>'used') FROM claim_dinner_ai_call(1) r),'household_limit:1','a limit below the hard maximum is honoured');
SELECT is((SELECT array_agg(claim_dinner_ai_call(10)->>'status') FROM generate_series(1,9)),array_fill('ok'::text,ARRAY[9]),'calls two to ten of the day are granted');
SELECT is((SELECT (r->>'status')||':'||(r->>'used') FROM claim_dinner_ai_call(10) r),'household_limit:10','the eleventh call hits the household limit');
SELECT is((dinner_ai_status()->>'used'),'10','status reports the calls used today');
SELECT throws_ok($$SELECT mark_dinner_ai_exhausted(now()+interval '1 hour')$$,'42501',NULL,'users cannot mark the provider as exhausted');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT is((SELECT (r->>'status')||':'||(r->>'used') FROM claim_dinner_ai_call(10) r),'ok:1','another household has its own budget');
RESET ROLE;
SELECT is((SELECT array_agg(right(household_id::text,2)||':'||calls ORDER BY household_id) FROM dinner_ai_usage),ARRAY['01:10','02:1'],'usage is counted per household');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT mark_dinner_ai_exhausted(now()+interval '27 hours')$$,'22023',NULL,'exhaustion cannot be set further than 26 hours ahead');
SELECT throws_ok($$SELECT mark_dinner_ai_exhausted(now()-interval '1 minute')$$,'22023',NULL,'exhaustion cannot be set in the past');
SELECT lives_ok($$SELECT mark_dinner_ai_exhausted(now()+interval '1 hour')$$,'service_role marks the provider as exhausted');
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT is((claim_dinner_ai_call(10)->>'status'),'provider_exhausted','calls stop for every household while the provider is exhausted');
SELECT is((SELECT (r->>'used')||':'||(r->>'provider_exhausted') FROM dinner_ai_status() r),'1:true','status shows the stop and the unchanged count');
RESET ROLE;
SELECT is((SELECT calls FROM dinner_ai_usage WHERE household_id='f5000000-0000-4000-8000-000000000002'),1::smallint,'a refused call is not counted');

-- ── 11. 別世帯 ──
SELECT is(pg_temp.visible(),ARRAY[1,3,3,2,2,1,3,2]::bigint[],'seed check: only household A owns dinner rows at this point');
-- 世帯を移った人が、元の世帯に残した食後評価（profile_id は B1・世帯は A）。「本人か」の検査だけでは
-- 通ってしまう行なので、世帯の照合そのものを固定できる（R06）。
INSERT INTO dish_feedback(id,household_id,profile_id,recipe_id,dish_title,eaten_on,taste,exclude_from_learning)
 VALUES('f5000000-0000-4000-8000-000000000042','f5000000-0000-4000-8000-000000000001','f5000000-0000-4000-8000-000000000005','curry_rice','synthetic curry',pg_temp.jd(-5),1,false);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT is(pg_temp.visible(),ARRAY[0,0,0,0,0,0,0,0]::bigint[],'another household reads no dinner row');
-- R06: 世帯またぎの拒否（各 RPC の `household_id <> h` を、別世帯の id で撃つ）
SELECT throws_ok($$SELECT delete_dinner_entry('f5000000-0000-4000-8000-000000000051',now())$$,'42501',NULL,'another household cannot delete a plan entry');
SELECT throws_ok($$SELECT delete_grocery_item((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),now())$$,'42501',NULL,'another household cannot delete a grocery item');
SELECT throws_ok($$SELECT delete_grocery_item('f5000000-0000-4000-8000-000000000071',now())$$,'42501',NULL,'another household cannot delete a manual grocery item');
SELECT throws_ok($$SELECT update_grocery_item_meta((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),now(),'synthetic takeover','other')$$,'42501',NULL,'another household cannot change the note or section of a grocery item');
SELECT throws_ok($$SELECT save_grocery_manual_item('f5000000-0000-4000-8000-000000000071',NULL,'synthetic takeover',NULL,NULL,NULL,NULL)$$,'42501',NULL,'another household cannot write over a manual grocery item id');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000020','household',NULL,NULL,'allergy','allergen','egg',NULL)$$,'42501',NULL,'another household cannot reuse an exclusion id');
SELECT throws_ok($$SELECT save_food_preference('f5000000-0000-4000-8000-000000000031',NULL,'household','tag','fish','like')$$,'42501',NULL,'another household cannot write over a household preference id');
SELECT throws_ok($$SELECT save_dish_feedback('f5000000-0000-4000-8000-000000000042',now(),'curry_rice','synthetic curry',pg_temp.jd(-5),3,3,true,false)$$,'42501',NULL,'a former member cannot change feedback left in another household');
SELECT throws_ok($$SELECT delete_dish_feedback('f5000000-0000-4000-8000-000000000042')$$,'42501',NULL,'a former member cannot delete feedback left in another household');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000011',NULL,pg_temp.pantry('synthetic takeover',1))$$,'42501',NULL,'another household cannot write over a pantry id');
SELECT throws_ok($$SELECT delete_pantry_item('f5000000-0000-4000-8000-000000000011',now())$$,'42501',NULL,'another household cannot delete a pantry item');
SELECT throws_ok($$SELECT delete_food_exclusion('f5000000-0000-4000-8000-000000000020')$$,'42501',NULL,'another household cannot delete an allergy exclusion');
SELECT throws_ok($$SELECT delete_food_preference('f5000000-0000-4000-8000-000000000031')$$,'42501',NULL,'another household cannot delete a household preference');
SELECT throws_ok($$SELECT delete_dish_feedback('f5000000-0000-4000-8000-000000000040')$$,'42501',NULL,'another household cannot delete feedback');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-000000000051',NULL,pg_temp.entry(0,'main','recipe_x',false,'proposed'))$$,'42501',NULL,'another household cannot write over a plan entry id');
SELECT throws_ok($$SELECT set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),now(),1,true)$$,'42501',NULL,'another household cannot tick a grocery item');
SELECT throws_ok($$SELECT restock_pantry_from_grocery((SELECT (v#>>'{}')::uuid FROM fx WHERE k='egg'),now(),'f5000000-0000-4000-8000-000000000017',1)$$,'42501',NULL,'another household cannot restock from a grocery item');
SELECT is((apply_dinner_plan('f5000000-0000-4000-8000-000000000090',0,pg_temp.jd(0),pg_temp.jd(0),jsonb_build_array(pg_temp.entry(0,'main','recipe_b1',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000091"}'))->>'revision'),'1','household B plans independently from revision 0');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000092',1,pg_temp.jd(0),pg_temp.jd(0),jsonb_build_array(pg_temp.entry(0,'side','recipe_b2',false,'proposed')||'{"id":"f5000000-0000-4000-8000-000000000062"}'))$$,'42501',NULL,'a plan cannot reuse an entry id of another household');
SELECT is(pg_temp.visible(),ARRAY[0,0,0,0,0,1,1,0]::bigint[],'household B sees only its own plan');

-- ── 12. 子どもだけの閲覧招待を受諾した人 ──
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
INSERT INTO fx VALUES('share',create_child_share('f5000000-0000-4000-8000-000000000007',true,true,true,true,NULL));
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000006","role":"authenticated"}',true);
SELECT lives_ok($$SELECT accept_child_share((SELECT v->>'token' FROM fx WHERE k='share'))$$,'viewer accepts a child share with every category allowed');
SELECT is(pg_temp.visible(),ARRAY[0,0,0,0,0,0,0,0]::bigint[],'child-share viewer reads no dinner row');
SELECT ok((SELECT NOT (shared_child_snapshot((v->>'id')::uuid) ?| ARRAY['dinner','pantry','grocery','exclusions','preferences','feedback']) FROM fx WHERE k='share'),'shared snapshot exposes no dinner data');
SELECT throws_ok($$SELECT save_food_exclusion('f5000000-0000-4000-8000-000000000026','child',NULL,'f5000000-0000-4000-8000-000000000007','allergy','allergen','milk',NULL)$$,'42501',NULL,'child-share viewer cannot register an exclusion for the shared child');
SELECT throws_ok($$SELECT save_dinner_settings(NULL,2,false,NULL,ARRAY[]::text[],'{}')$$,'42501',NULL,'child-share viewer cannot write settings');
SELECT throws_ok($$SELECT claim_dinner_ai_call(10)$$,'42501',NULL,'child-share viewer cannot consume AI calls');

-- ── 13. viewer へ落とされた元メンバー ──
RESET ROLE;
UPDATE profiles SET role='viewer' WHERE id='f5000000-0000-4000-8000-000000000004';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is(pg_temp.visible(),ARRAY[0,0,0,0,0,0,0,0]::bigint[],'viewer reads no dinner row');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000018',NULL,pg_temp.pantry('synthetic viewer',1))$$,'42501',NULL,'viewer cannot write pantry');
SELECT throws_ok($$SELECT delete_food_preference('f5000000-0000-4000-8000-000000000032')$$,'42501',NULL,'viewer cannot delete even an own personal preference');
SELECT throws_ok($$SELECT apply_dinner_plan('f5000000-0000-4000-8000-000000000093',6,pg_temp.jd(0),pg_temp.jd(0),'[]')$$,'42501',NULL,'viewer cannot apply a plan');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-000000000094',6,'[]')$$,'42501',NULL,'viewer cannot sync groceries');
SELECT throws_ok($$SELECT dinner_ai_status()$$,'42501',NULL,'viewer cannot read AI status');

-- ── 14. 未認証 ──
RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
SELECT throws_ok($$SELECT count(*) FROM pantry_items$$,'42501',NULL,'anon cannot read pantry');
SELECT throws_ok($$SELECT count(*) FROM food_exclusions$$,'42501',NULL,'anon cannot read exclusions');
SELECT throws_ok($$SELECT save_pantry_item('f5000000-0000-4000-8000-000000000018',NULL,'{}')$$,'42501',NULL,'anon cannot call a write RPC');
SELECT throws_ok($$SELECT claim_dinner_ai_call(10)$$,'42501',NULL,'anon cannot consume AI calls');

-- ── 15. 拒否された操作は世帯 A の行を変えていない ──
RESET ROLE;
SELECT is((SELECT ARRAY[(SELECT count(*) FROM pantry_items WHERE household_id=h),(SELECT count(*) FROM food_exclusions WHERE household_id=h),(SELECT count(*) FROM food_preferences WHERE household_id=h),
 (SELECT count(*) FROM dish_feedback WHERE household_id=h),(SELECT count(*) FROM dinner_plan_entries WHERE household_id=h),(SELECT count(*) FROM grocery_items WHERE household_id=h)]
 FROM (SELECT 'f5000000-0000-4000-8000-000000000001'::uuid AS h) q),ARRAY[3,3,2,3,3,2]::bigint[],'household A rows are intact after every refused attempt (feedback: two of the members plus the one a former member left)');
-- 件数だけでなく中身も変わっていない（R06 で撃った 7 本の RPC の対象行）
SELECT is((SELECT array_agg(coalesce(g.name,'')||'|'||coalesce(g.note,'-')||'|'||coalesce(g.section,'-')||'|'||g.origin ORDER BY g.name) FROM grocery_items g WHERE g.household_id='f5000000-0000-4000-8000-000000000001'),
 ARRAY['synthetic egg|-|-|auto','synthetic tissue|-|other|manual'],'household A grocery names, notes and sections are untouched');
SELECT is((SELECT recipe_id||':'||status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-000000000051'),'curry_rice:confirmed','household A plan entry is untouched');
SELECT is((SELECT (SELECT target_id FROM food_exclusions WHERE id='f5000000-0000-4000-8000-000000000020')||':'||(SELECT sentiment FROM food_preferences WHERE id='f5000000-0000-4000-8000-000000000031')||':'||(SELECT taste::text FROM dish_feedback WHERE id='f5000000-0000-4000-8000-000000000042')),'egg:dislike:1','household A exclusion, preference and the former member''s feedback are untouched');
SELECT is((SELECT revision FROM dinner_plan_state WHERE household_id='f5000000-0000-4000-8000-000000000001'),6::bigint,'household A plan revision is unchanged by other callers');

-- ── 16. 作った料理への充当（R03）: 「作った」「日が過ぎた」枠が買い物へ載せていた量ぶんだけ、購入を使ったものとして扱う ──
--   枠 a1 = 今日・a2 = 2 日後・a3 = 3 日後・a4 = 7 日後（翌週）・a5 = 2 日前（確定のまま）・a6 = 3 日前（作らなかった）
--   出所は {entryId, buy} を伴う。buy = その枠が買い物へ載せた正味量。
--   購入の事実（purchased_quantity / purchased）は書き換えず、充当は台帳（consumptions / consumed_quantity）と
--   印の使い終わり（purchase_consumed）に持つ。gsum は「今の必要に充てられる購入 = 事実 − 充当」と「画面の印」を出す
--   （充当を事実から引いていた頃の purchased_quantity / purchased と同じ値になる）。
CREATE FUNCTION pg_temp.src(p_day integer, p_entry text, p_buy numeric) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('date',pg_temp.jd(p_day)::text,'recipeId','synthetic_dish','title','synthetic dish','entryId',p_entry,'buy',p_buy,
  'quantity',jsonb_build_object('amount',CASE WHEN p_buy > 0 THEN p_buy END,'unit',CASE WHEN p_buy IS NULL THEN 'pinch' ELSE 'g' END)) $$;
CREATE FUNCTION pg_temp.item(p_ingredient text, p_qty numeric, p_sources jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('item_key',p_ingredient||CASE WHEN p_qty IS NULL THEN '|none' ELSE '|mass' END,'ingredient_id',p_ingredient,'name','synthetic '||p_ingredient,
  'required_quantity',p_qty,'unit',CASE WHEN p_qty IS NOT NULL THEN 'g' END,'required_note',CASE WHEN p_qty IS NULL THEN 'synthetic pinch' END,'needs_stock_check',false,'sources',p_sources) $$;
CREATE FUNCTION pg_temp.gid(p_key text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM grocery_items WHERE item_key=p_key $$;
CREATE FUNCTION pg_temp.gver(p_key text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT updated_at FROM grocery_items WHERE item_key=p_key $$;
CREATE FUNCTION pg_temp.ever(p_id text) RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT updated_at FROM dinner_plan_entries WHERE id=p_id::uuid $$;
-- 買い物 1 行の要約: 必要か:必要量:今の必要に充てられる購入（事実 − 充当）:画面の印（事実 AND NOT 使い終えた）:出所の数
CREATE FUNCTION pg_temp.gsum(p_key text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT still_needed::text||':'||coalesce(required_quantity::text,'-')||':'||(purchased_quantity-consumed_quantity)::text||':'||(purchased AND NOT purchase_consumed)::text||':'||jsonb_array_length(sources)::text FROM grocery_items WHERE item_key=p_key $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a1',NULL,pg_temp.entry(0,'soup','pork_a',false,'confirmed'))->>'revision'),'7','R03 seed: a dish confirmed for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a2',NULL,pg_temp.entry(2,'main','pork_b',false,'confirmed'))->>'revision'),'8','R03 seed: a dish confirmed two days ahead');
-- 豚 600g（今日 300 + 2 日後 300）/ 米 150g（今日ぶんは在庫でまかなう = buy 0）/ 塩（今日だけ）・こしょう（両日）は量を追わない
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b1',8,jsonb_build_array(
 pg_temp.item('pork',600,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',300),pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',300))),
 pg_temp.item('rice',150,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',0),pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',150))),
 pg_temp.item('milk',500,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',500))),
 pg_temp.item('salt',NULL,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',NULL))),
 pg_temp.item('pepper',NULL,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',NULL),pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',NULL))),
 pg_temp.item('leek',100,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-000000000091',100)))))->>'status'),'saved','sources carrying entryId and buy are accepted');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000bf',8,jsonb_build_array(pg_temp.item('pork',600,jsonb_build_array(pg_temp.src(0,'not-a-uuid',300)))))$$,'22023',NULL,'a source with a malformed entryId is rejected');
SELECT throws_ok($$SELECT sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000bf',8,jsonb_build_array(pg_temp.item('pork',600,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a1',-1)))))$$,'22023',NULL,'a source with a negative buy is rejected');
SELECT is((set_grocery_purchase(pg_temp.gid('pork|mass'),pg_temp.gver('pork|mass'),300,false)->>'status'),'saved','300 g of the 600 g of pork purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('rice|mass'),pg_temp.gver('rice|mass'),150,true)->>'status'),'saved','150 g of rice purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('milk|mass'),pg_temp.gver('milk|mass'),500,true)->>'status'),'saved','500 g of milk purchased');
SELECT is((restock_pantry_from_grocery(pg_temp.gid('milk|mass'),pg_temp.gver('milk|mass'),'f5000000-0000-4000-8000-0000000000c1',200)->>'status'),'saved','200 g of the milk moved into the pantry');
SELECT is((set_grocery_purchase(pg_temp.gid('salt|none'),pg_temp.gver('salt|none'),0,true)->>'status'),'saved','salt ticked');
SELECT is((set_grocery_purchase(pg_temp.gid('pepper|none'),pg_temp.gver('pepper|none'),0,true)->>'status'),'saved','pepper ticked');
SELECT is((set_grocery_purchase(pg_temp.gid('leek|mass'),pg_temp.gver('leek|mass'),100,true)->>'status'),'saved','100 g of leek purchased');
-- 別世帯の枠 …91 を「作った」にしても、世帯 A の購入は消化されない（下で確かめる）
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-000000000091',pg_temp.ever('f5000000-0000-4000-8000-000000000091'),pg_temp.entry(0,'main','recipe_b1',false,'cooked'))->>'status'),'saved','household B cooks its own dish');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
-- (1) 今日の料理を作った → 今日ぶん 300g の購入を使ったものとして扱い、2 日後の 300g は未購入のまま
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a1',pg_temp.ever('f5000000-0000-4000-8000-0000000000a1'),pg_temp.entry(0,'soup','pork_a',false,'cooked'))->>'revision'),'9','today''s dish is marked cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b2',9,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',300))),
 pg_temp.item('rice',150,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',150))),
 pg_temp.item('pepper',NULL,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',NULL)))))->>'status'),'saved','needs recomputed after cooking');
SELECT is(pg_temp.gsum('pork|mass'),'true:300.000:0.000:false:1','R03: the purchase used by the cooked dish no longer offsets the remaining 300 g (300 g still to buy)');
SELECT is((SELECT purchased_quantity::text||':'||consumed_quantity::text||':'||(purchased_at IS NOT NULL)::text||':'||(purchased_by IS NOT NULL)::text FROM grocery_items WHERE item_key='pork|mass'),'300.000:300.000:true:true','a fully used purchase keeps its fact (amount, who and when); the use is recorded as consumed');
SELECT is(pg_temp.gsum('rice|mass'),'true:150.000:150.000:true:1','control: a cooked dish that was covered by stock (buy 0) uses none of the purchase');
SELECT is(pg_temp.gsum('milk|mass'),'false:500.000:200.000:false:0','a used purchase never drops below what was already moved into the pantry');
SELECT is(pg_temp.gsum('salt|none')||' / '||(SELECT purchased::text FROM grocery_items WHERE item_key='salt|none'),'false:-:0.000:false:0 / true','R03: a tick on an untracked item is used up once every dish it was for has been cooked (the tick itself stays recorded)');
SELECT is(pg_temp.gsum('pepper|none'),'true:-:0.000:true:1','control: the tick stays while another dish still needs the item');
SELECT is(pg_temp.gsum('leek|mass'),'false:100.000:100.000:true:0','a cooked dish of another household does not use up a purchase (entry lookup is household-scoped)');
-- (2) 同じ内容をもう一度同期しても、何も変わらない（二重に消化しない）
INSERT INTO fx VALUES('print16',to_jsonb(pg_temp.grocery_print()));
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b3',9,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',300))),
 pg_temp.item('rice',150,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',150))),
 pg_temp.item('pepper',NULL,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',NULL)))))->>'status'),'saved','the same needs synced again under a new operation');
SELECT is(pg_temp.grocery_print(),(SELECT v#>>'{}' FROM fx WHERE k='print16'),'R03: a second identical sync changes no row and no column (nothing is used twice)');
-- (3) C-46: 同じ週の中で 300g 購入後に必要量が 500g へ増えた → 残り 200g
SELECT is((set_grocery_purchase(pg_temp.gid('pork|mass'),pg_temp.gver('pork|mass'),(SELECT purchased_quantity FROM grocery_items WHERE item_key='pork|mass')+300,true)->>'status'),'saved','300 g more of pork purchased for the dish two days ahead (sent as the purchase total)');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a3',NULL,pg_temp.entry(3,'main','pork_c',false,'confirmed'))->>'revision'),'10','another pork dish confirmed three days ahead');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b4',10,jsonb_build_array(
 pg_temp.item('pork',500,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',300),pg_temp.src(3,'f5000000-0000-4000-8000-0000000000a3',200)))))->>'status'),'saved','required pork grows from 300 to 500 within the week');
SELECT is((SELECT ARRAY[required_quantity,purchased_quantity-consumed_quantity,required_quantity-(purchased_quantity-restocked_quantity-consumed_quantity)] FROM grocery_items WHERE item_key='pork|mass'),ARRAY[500,300,200]::numeric[],'C-46: 300 g purchased, then 500 g needed, leaves 200 g to buy');
-- (4) C-45: 献立の変更（削除・作らなかった）は購入の記録を消さない。戻せば購入は生きている
SELECT is((delete_dinner_entry('f5000000-0000-4000-8000-0000000000a3',pg_temp.ever('f5000000-0000-4000-8000-0000000000a3'))->>'revision'),'11','the extra pork dish is removed from the plan');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a2',pg_temp.ever('f5000000-0000-4000-8000-0000000000a2'),pg_temp.entry(2,'main','pork_b',false,'skipped'))->>'revision'),'12','the other pork dish is marked as not cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b5',12,'[]')->>'status'),'saved','plan no longer needs pork');
SELECT is(pg_temp.gsum('pork|mass'),'false:500.000:300.000:true:0','C-45: a plan change keeps the purchase (deleted and skipped dishes use nothing) and drops the stale sources');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a2',pg_temp.ever('f5000000-0000-4000-8000-0000000000a2'),pg_temp.entry(2,'main','pork_b',false,'confirmed'))->>'revision'),'13','the pork dish is confirmed again');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b6',13,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(2,'f5000000-0000-4000-8000-0000000000a2',300)))))->>'status'),'saved','pork is needed again');
SELECT is(pg_temp.gsum('pork|mass'),'true:300.000:300.000:true:1','C-45: the kept purchase covers the dish that came back (nothing left to buy)');
-- (5) 今週 300g 買って作った → 翌週また 300g 必要 → 未購入 300g
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a2',pg_temp.ever('f5000000-0000-4000-8000-0000000000a2'),pg_temp.entry(0,'staple','pork_b',false,'confirmed'))->>'revision'),'14','the pork dish is moved to today');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b7',14,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000a2',300)))))->>'status'),'saved','needs follow the move');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a2',pg_temp.ever('f5000000-0000-4000-8000-0000000000a2'),pg_temp.entry(0,'staple','pork_b',false,'cooked'))->>'revision'),'15','the pork dish is cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b8',15,'[]')->>'status'),'saved','nothing left to buy this week');
SELECT is(pg_temp.gsum('pork|mass'),'false:300.000:0.000:false:0','a purchase fully used by cooked dishes leaves nothing to buy or count (the row stays only as the record of the use)');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a4',NULL,pg_temp.entry(7,'main','pork_d',false,'confirmed'))->>'revision'),'16','next week''s pork dish is confirmed');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000b9',16,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(7,'f5000000-0000-4000-8000-0000000000a4',300)))))->>'status'),'saved','next week needs 300 g of pork again');
SELECT is(pg_temp.gsum('pork|mass'),'true:300.000:0.000:false:1','R03: last week''s purchase does not hide next week''s 300 g (shown as not purchased)');
-- (6) 日が過ぎた確定の枠は使ったものとして扱う。作らなかった枠は扱わない。まだ必要量に載っている間は消化しない
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a5',NULL,pg_temp.entry(-2,'main','beef_a',false,'confirmed'))->>'revision'),'17','a dish left confirmed on a past day');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a6',NULL,pg_temp.entry(-3,'main','tofu_a',false,'confirmed'))->>'revision'),'18','a dish confirmed for a past day (marked as not cooked below)');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000ba',18,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(7,'f5000000-0000-4000-8000-0000000000a4',300))),
 pg_temp.item('beef',200,jsonb_build_array(pg_temp.src(-2,'f5000000-0000-4000-8000-0000000000a5',200))),
 pg_temp.item('tofu',400,jsonb_build_array(pg_temp.src(-3,'f5000000-0000-4000-8000-0000000000a6',400))),
 pg_temp.item('lamb',250,jsonb_build_array(pg_temp.src(-1,NULL,250)))))->>'status'),'saved','items whose sources point at past days');
SELECT is((set_grocery_purchase(pg_temp.gid('beef|mass'),pg_temp.gver('beef|mass'),200,true)->>'status'),'saved','200 g of beef purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('tofu|mass'),pg_temp.gver('tofu|mass'),400,true)->>'status'),'saved','400 g of tofu purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('lamb|mass'),pg_temp.gver('lamb|mass'),250,true)->>'status'),'saved','250 g of lamb purchased');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000a6',pg_temp.ever('f5000000-0000-4000-8000-0000000000a6'),pg_temp.entry(-3,'main','tofu_a',false,'skipped'))->>'revision'),'19','the past tofu dish is marked as not cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000bb',19,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(7,'f5000000-0000-4000-8000-0000000000a4',300))),
 pg_temp.item('beef',200,jsonb_build_array(pg_temp.src(-2,'f5000000-0000-4000-8000-0000000000a5',200))),
 pg_temp.item('lamb',250,jsonb_build_array(pg_temp.src(-1,NULL,250)))))->>'status'),'saved','beef and lamb are still listed, tofu is not');
SELECT is(pg_temp.gsum('beef|mass')||' / '||pg_temp.gsum('lamb|mass'),'true:200.000:200.000:true:1 / true:250.000:250.000:true:1','control: a source that is still listed is not used up, even on a past day');
SELECT is(pg_temp.gsum('tofu|mass'),'false:400.000:400.000:true:0','control: a past dish that was not cooked uses none of the purchase');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000bc',19,jsonb_build_array(
 pg_temp.item('pork',300,jsonb_build_array(pg_temp.src(7,'f5000000-0000-4000-8000-0000000000a4',300)))))->>'status'),'saved','beef and lamb drop out of the needs');
SELECT is(pg_temp.gsum('beef|mass')||' / '||pg_temp.gsum('lamb|mass'),'false:200.000:0.000:false:0 / false:250.000:0.000:false:0','R03: purchases for dishes whose day has passed (confirmed entry, or a source without an entry) are used up');
SELECT is((SELECT array_agg(item_key||':'||purchased_quantity::text||':'||consumptions::text ORDER BY item_key) FROM grocery_items WHERE item_key IN ('beef|mass','lamb|mass')),
 ARRAY['beef|mass:200.000:[{"d": "'||pg_temp.jd(-2)::text||'", "k": "f5000000-0000-4000-8000-0000000000a5", "m": false, "q": 200.000, "on": true}]','lamb|mass:250.000:[{"k": "settled", "m": false, "q": 250.000, "on": true}]'],
 'the purchase facts stay; a past confirmed dish is recorded per entry, a source without an entry is settled at once');

-- ── 17. まとめて確定（R43）: 全部確定するか、何も変えないか。版は 1 回だけ進む ──
CREATE FUNCTION pg_temp.ev(p_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('id',p_id,'version',pg_temp.ever(p_id)) $$;
CREATE FUNCTION pg_temp.proposed() RETURNS text[] LANGUAGE sql STABLE AS $$ SELECT coalesce(array_agg(right(id::text,2) ORDER BY id),'{}') FROM dinner_plan_entries WHERE status='proposed' $$;
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000d1',NULL,pg_temp.entry(4,'main','recipe_p1',false,'proposed'))->>'revision'),'20','R43 seed: a proposed dish');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000d2',NULL,pg_temp.entry(5,'main','recipe_p2',false,'proposed'))->>'revision'),'21','R43 seed: another proposed dish');
SELECT is(pg_temp.proposed(),ARRAY['62','d1','d2'],'three proposed dishes before confirming');
SELECT is((SELECT (r->>'status')||':'||(r->>'detail')||':'||(r->>'revision') FROM confirm_dinner_entries(20,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'),pg_temp.ev('f5000000-0000-4000-8000-0000000000d1'))) r),'conflict:stale_plan:21','a stale plan revision confirms nothing');
SELECT is((SELECT (r->>'status')||':'||(r->>'detail') FROM confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'),jsonb_build_object('id','f5000000-0000-4000-8000-0000000000d1','version','2020-01-01T00:00:00Z'))) r),'conflict:row_changed','one stale entry version rejects the whole confirmation');
SELECT is((SELECT (r->>'status')||':'||(r->>'detail') FROM confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'),jsonb_build_object('id','f5000000-0000-4000-8000-0000000000d9','version','2020-01-01T00:00:00Z'))) r),'conflict:gone','one missing entry rejects the whole confirmation');
SELECT is((SELECT (r->>'status')||':'||(r->>'detail') FROM confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-0000000000a4'))) r),'conflict:row_changed','an entry that is not a proposal is not confirmed again');
SELECT is(pg_temp.proposed()||ARRAY[(SELECT revision::text FROM dinner_plan_state)],ARRAY['62','d1','d2','21'],'R43: refused confirmations changed no entry and did not advance the revision (all or nothing)');
SELECT throws_ok($$SELECT confirm_dinner_entries(21,'[]')$$,'22023',NULL,'an empty confirmation is rejected');
SELECT throws_ok($$SELECT confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'),pg_temp.ev('f5000000-0000-4000-8000-000000000062')))$$,'22023',NULL,'the same entry twice is rejected');
SELECT throws_ok($$SELECT confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062')||'{"status":"cooked"}'))$$,'22023',NULL,'a confirmation cannot carry other fields');
SELECT throws_ok($$SELECT confirm_dinner_entries(21,jsonb_build_array(jsonb_build_object('id','f5000000-0000-4000-8000-000000000062','version','yesterday-ish')))$$,'22023',NULL,'a malformed version is rejected');
INSERT INTO fx VALUES('confirm',confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'),pg_temp.ev('f5000000-0000-4000-8000-0000000000d1'),pg_temp.ev('f5000000-0000-4000-8000-0000000000d2'))));
SELECT is((SELECT (v->>'status')||':'||(v->>'revision')||':'||(v->>'confirmed') FROM fx WHERE k='confirm'),'saved:22:3','R43: three dishes confirmed in one transaction, the revision advances once');
SELECT is((SELECT array_agg(right(id::text,2)||':'||status ORDER BY id) FROM dinner_plan_entries WHERE right(id::text,2) IN ('62','d1','d2')),ARRAY['62:confirmed','d1:confirmed','d2:confirmed'],'every listed dish is confirmed');
SELECT is((SELECT (r->>'status')||':'||(r->>'detail') FROM confirm_dinner_entries(21,jsonb_build_array(pg_temp.ev('f5000000-0000-4000-8000-000000000062'))) r),'conflict:stale_plan','resending the confirmation with the old revision changes nothing');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000005","role":"authenticated"}',true);
SELECT throws_ok($$SELECT confirm_dinner_entries(2,jsonb_build_array(jsonb_build_object('id','f5000000-0000-4000-8000-0000000000a4','version','2020-01-01T00:00:00Z')))$$,'42501',NULL,'another household cannot confirm a plan entry');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT throws_ok($$SELECT confirm_dinner_entries(22,jsonb_build_array(jsonb_build_object('id','f5000000-0000-4000-8000-0000000000a4','version','2020-01-01T00:00:00Z')))$$,'42501',NULL,'viewer cannot confirm plan entries');
RESET ROLE;
SELECT is((SELECT revision FROM dinner_plan_state WHERE household_id='f5000000-0000-4000-8000-000000000001'),22::bigint,'household A plan revision is unchanged by the refused confirmations');

-- ── 18. 購入の事実と、作った料理への充当（作った → 取り消し）──
--   購入の事実（purchased_quantity / purchased / purchased_at / purchased_by）は「作った」でも同期でも書き換えない。
--   取り消しは、その料理が使った分だけを戻す。後から家族が足した購入は残る。在庫（pantry_items）は変えない。
--   枠 e1 = 今日の主菜（鶏 500 g・ごま）/ e4 = 今日の副菜（キャベツ 500 g）/ e5 = 今日の汁物（のり）。位置 5 で既存の枠と重ねない。
--   A2 は §13 で viewer に落としたので、ここで member に戻して「別の端末の家族」にする。
RESET ROLE;
UPDATE profiles SET role='member' WHERE id='f5000000-0000-4000-8000-000000000004';
CREATE FUNCTION pg_temp.rev() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT revision FROM dinner_plan_state $$;
CREATE FUNCTION pg_temp.slot(p_day integer, p_role text, p_recipe text, p_status text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT pg_temp.entry(p_day,p_role,p_recipe,false,p_status)||'{"position":5}'::jsonb $$;
-- 献立に残っている（まだ作っていない）枠のぶんだけを、買い物の必要量として送る
CREATE FUNCTION pg_temp.needs18(p_e1 boolean, p_e4 boolean, p_e5 boolean) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_agg(x ORDER BY o),'[]'::jsonb) FROM (VALUES
  (1, CASE WHEN p_e1 THEN pg_temp.item('chicken',500,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000e1',500))) END),
  (2, CASE WHEN p_e1 THEN pg_temp.item('sesame',NULL,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000e1',NULL))) END),
  (3, CASE WHEN p_e4 THEN pg_temp.item('cabbage',500,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000e4',500))) END),
  (4, CASE WHEN p_e5 THEN pg_temp.item('nori',NULL,jsonb_build_array(pg_temp.src(0,'f5000000-0000-4000-8000-0000000000e5',NULL))) END)) v(o,x)
 WHERE x IS NOT NULL $$;
-- 不足 = 必要量 −（購入の事実 − 在庫へ足した量 − 作った料理への充当）（後者は 0 未満にしない）。
CREATE FUNCTION pg_temp.short(p_key text) RETURNS numeric LANGUAGE sql STABLE AS $$
 SELECT required_quantity-greatest(purchased_quantity-restocked_quantity-consumed_quantity,0) FROM grocery_items WHERE item_key=p_key $$;
-- 購入の事実（量・印・いつ・誰が）と、必要量・必要か
CREATE FUNCTION pg_temp.facts(p_key text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('q',purchased_quantity,'p',purchased,'at',purchased_at,'by',purchased_by,'req',required_quantity,'need',still_needed) FROM grocery_items WHERE item_key=p_key $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e1',NULL,pg_temp.slot(0,'main','synthetic_chicken','confirmed'))->>'status'),'saved','§18 seed: a chicken dish confirmed for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e4',NULL,pg_temp.slot(0,'side','synthetic_cabbage','confirmed'))->>'status'),'saved','§18 seed: a cabbage dish confirmed for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e5',NULL,pg_temp.slot(0,'soup','synthetic_nori','confirmed'))->>'status'),'saved','§18 seed: a nori soup confirmed for today');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c1',pg_temp.rev(),pg_temp.needs18(true,true,true))->>'status'),'saved','§18 seed: needs synced (chicken 500 g, cabbage 500 g, sesame and nori untracked)');
INSERT INTO fx SELECT 'chicken18',to_jsonb(pg_temp.gid('chicken|mass'));
INSERT INTO fx SELECT 'nori18',to_jsonb(pg_temp.gid('nori|none'));
SELECT is((set_grocery_purchase(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),300,false)->>'status'),'saved','300 g of the 500 g of chicken purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('cabbage|mass'),pg_temp.gver('cabbage|mass'),300,false)->>'status'),'saved','300 g of the 500 g of cabbage purchased');
SELECT is((set_grocery_purchase(pg_temp.gid('sesame|none'),pg_temp.gver('sesame|none'),0,true)->>'status'),'saved','sesame ticked');
INSERT INTO fx SELECT 'nori_v0',to_jsonb(pg_temp.gver('nori|none'));
SELECT is((set_grocery_purchase(pg_temp.gid('nori|none'),pg_temp.gver('nori|none'),0,true)->>'status'),'saved','nori ticked');
SELECT is(ARRAY[pg_temp.short('chicken|mass'),pg_temp.short('cabbage|mass')],ARRAY[200,200]::numeric[],'500 g needed and 300 g purchased leaves 200 g to buy (chicken and cabbage)');
INSERT INTO fx SELECT 'cabbage18',pg_temp.facts('cabbage|mass');
INSERT INTO fx SELECT 'pantry18',to_jsonb((SELECT count(*) FROM pantry_items));
-- (a) 受け入れ 1: ほかに変更が無ければ、作った → 取り消しで元どおり
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e4',pg_temp.ever('f5000000-0000-4000-8000-0000000000e4'),pg_temp.slot(0,'side','synthetic_cabbage','cooked'))->>'status'),'saved','the cabbage dish is marked cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c2',pg_temp.rev(),pg_temp.needs18(true,false,true))->>'status'),'saved','needs synced after cooking the cabbage dish');
SELECT is((SELECT purchased_quantity FROM grocery_items WHERE item_key='cabbage|mass'),300::numeric,'cooking does not rewrite the purchase fact (300 g of cabbage stays recorded)');
SELECT is((SELECT consumed_quantity::text||':'||jsonb_array_length(consumptions)::text||':'||(consumptions->0->>'k') FROM grocery_items WHERE item_key='cabbage|mass'),'300.000:1:f5000000-0000-4000-8000-0000000000e4','the 300 g is recorded once as used by the cooked dish (ledger keyed by the entry)');
SELECT is((SELECT prior_status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-0000000000e4'),'confirmed','a cooked entry remembers the state to go back to (confirmed)');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e4',pg_temp.ever('f5000000-0000-4000-8000-0000000000e4'),pg_temp.slot(0,'side','synthetic_cabbage','confirmed'))->>'status'),'saved','the cabbage dish is un-cooked (undo)');
SELECT is((SELECT prior_status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-0000000000e4'),NULL,'back to confirmed, the entry forgets the state it came from');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c3',pg_temp.rev(),pg_temp.needs18(true,true,true))->>'status'),'saved','needs synced after the undo');
SELECT is(pg_temp.facts('cabbage|mass'),(SELECT v FROM fx WHERE k='cabbage18'),'acceptance 1: cooked then undone, the purchase quantity, tick, time, buyer and need are as before');
SELECT is(pg_temp.short('cabbage|mass'),200::numeric,'acceptance 1: 200 g is left to buy again');
SELECT is((SELECT consumed_quantity::text||':'||consumptions::text||':'||purchase_consumed::text FROM grocery_items WHERE item_key='cabbage|mass'),'0.000:[]:false','the undo removed exactly the record of that dish');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e4','2020-01-01T00:00:00Z',pg_temp.slot(0,'side','synthetic_cabbage','confirmed'))->>'status'),'replayed','a second undo (resent with an old version) replays');
INSERT INTO fx VALUES('print18',to_jsonb(pg_temp.grocery_print()));
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c4',pg_temp.rev(),pg_temp.needs18(true,true,true))->>'status'),'saved','the same needs synced again under a new operation');
SELECT is(pg_temp.grocery_print(),(SELECT v#>>'{}' FROM fx WHERE k='print18'),'a sync after the undo changes no row (nothing is given back twice)');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c4',pg_temp.rev(),pg_temp.needs18(true,true,true))->>'status'),'replayed','the resent sync replays');
SELECT is(pg_temp.grocery_print(),(SELECT v#>>'{}' FROM fx WHERE k='print18'),'the resent sync changes no row either');
-- (b) 受け入れ 2: 作った後に別の端末が 100 g を買い足し、元の操作を取り消す
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e1',pg_temp.ever('f5000000-0000-4000-8000-0000000000e1'),pg_temp.slot(0,'main','synthetic_chicken','cooked'))->>'status'),'saved','the chicken dish is marked cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c5',pg_temp.rev(),pg_temp.needs18(false,true,true))->>'status'),'saved','needs synced after cooking the chicken dish');
SELECT is((SELECT purchased_quantity FROM grocery_items WHERE item_key='chicken|mass'),300::numeric,'cooking does not rewrite the purchase fact (300 g of chicken stays recorded)');
SELECT is((SELECT purchased FROM grocery_items WHERE item_key='sesame|none'),true,'cooking does not erase the sesame tick (the fact of the purchase)');
SELECT is((SELECT ARRAY[purchased_quantity,consumed_quantity,greatest(purchased_quantity-restocked_quantity-consumed_quantity,0)] FROM grocery_items WHERE item_key='chicken|mass'),ARRAY[300,300,0]::numeric[],'the cooked dish used the whole 300 g (min of its 500 g and the 300 g on hand), nothing is left for other needs');
SELECT is((SELECT purchase_consumed::text||':'||(purchased AND NOT purchase_consumed)::text FROM grocery_items WHERE item_key='sesame|none'),'true:false','the sesame tick is used up (shown as not ticked) while the fact stays');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='chicken18'),pg_temp.gver('chicken|mass'),coalesce((SELECT purchased_quantity FROM grocery_items WHERE item_key='chicken|mass'),0)+100,false)->>'status'),'saved','another device (A2) buys 100 g more after the dish was cooked (sent as the purchase total)');
SELECT is((SELECT purchased_quantity FROM grocery_items WHERE item_key='chicken|mass'),400::numeric,'the purchase fact is 300 + 100 = 400 g');
SELECT is((SELECT greatest(purchased_quantity-restocked_quantity-consumed_quantity,0) FROM grocery_items WHERE item_key='chicken|mass'),100::numeric,'the 100 g bought after cooking is available, not swallowed by the cooked dish');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e1',pg_temp.ever('f5000000-0000-4000-8000-0000000000e1'),pg_temp.slot(0,'main','synthetic_chicken','confirmed'))->>'status'),'saved','A1 undoes the cooked chicken dish');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c6',pg_temp.rev(),pg_temp.needs18(true,true,true))->>'status'),'saved','needs synced after the undo');
SELECT is(ARRAY[(SELECT purchased_quantity FROM grocery_items WHERE item_key='chicken|mass'),pg_temp.short('chicken|mass')],ARRAY[400,100]::numeric[],'acceptance 2: the 100 g bought later survives the undo, and 100 g of the original 500 g is left to buy');
SELECT is((SELECT purchased_by FROM grocery_items WHERE item_key='chicken|mass'),'f5000000-0000-4000-8000-000000000004'::uuid,'the later buyer is still recorded after the undo');
SELECT is((SELECT purchased::text||':'||(purchased AND NOT purchase_consumed)::text||':'||still_needed::text FROM grocery_items WHERE item_key='sesame|none'),'true:true:true','undo gives the sesame tick back (an untracked item is reversible too)');
SELECT is((SELECT consumed_quantity::text||':'||jsonb_array_length(consumptions)::text FROM grocery_items WHERE item_key='chicken|mass')||' / '||(SELECT purchase_consumed::text||':'||jsonb_array_length(consumptions)::text FROM grocery_items WHERE item_key='sesame|none'),'0.000:0 / false:0','the undo removed the records of the chicken dish on both items');
SELECT is((SELECT count(*) FROM pantry_items),(SELECT (v#>>'{}')::bigint FROM fx WHERE k='pantry18'),'cooking, undoing and syncing never add a pantry row');
-- (c) 量を追わない項目: 使い終えた後の買い直しは、古い印の再送に吸われない
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e5',pg_temp.ever('f5000000-0000-4000-8000-0000000000e5'),pg_temp.slot(0,'soup','synthetic_nori','cooked'))->>'status'),'saved','the nori soup is marked cooked');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c7',pg_temp.rev(),pg_temp.needs18(true,true,false))->>'status'),'saved','needs synced after cooking the nori soup');
INSERT INTO fx SELECT 'nori_v1',to_jsonb(pg_temp.gver('nori|none'));
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='nori18'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='nori_v0'),0,true)->>'status'),'conflict','resending the tick that was sent before the soup was cooked is a conflict, not a new purchase');
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='nori18'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='nori_v1'),0,true)->>'status'),'saved','ticking nori again after it was used up records a new purchase');
SELECT is((set_grocery_purchase((SELECT (v#>>'{}')::uuid FROM fx WHERE k='nori18'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='nori_v1'),0,true)->>'status'),'replayed','resending that new tick replays');
SELECT is((SELECT purchased::text||':'||purchase_consumed::text FROM grocery_items WHERE item_key='nori|none'),'true:false','the new tick is shown as purchased again');
-- (d) 提案のまま作った枠は、戻す先（提案）を覚える。作った → 作らなかった の直の付け替えは受けず（§20 の 6c）、提案へ戻ると消す
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e2',NULL,pg_temp.slot(0,'staple','synthetic_rice','proposed'))->>'status'),'saved','§18 seed: a proposed dish for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e2',pg_temp.ever('f5000000-0000-4000-8000-0000000000e2'),pg_temp.slot(0,'staple','synthetic_rice','cooked'))#>>'{entry,prior_status}'),'proposed','a proposed dish marked cooked remembers it was a proposal');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-0000000000e2',pg_temp.ever('f5000000-0000-4000-8000-0000000000e2'),pg_temp.slot(0,'staple','synthetic_rice','skipped'))$$,'22023',NULL,'a cooked dish is not switched to not cooked directly');
SELECT is((SELECT status||':'||prior_status FROM dinner_plan_entries WHERE id='f5000000-0000-4000-8000-0000000000e2'),'cooked:proposed','the refused switch kept the dish cooked and the state to go back to');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-0000000000e2',pg_temp.ever('f5000000-0000-4000-8000-0000000000e2'),pg_temp.slot(0,'staple','synthetic_rice','cooked')||'{"prior_status":"confirmed"}')$$,'22023',NULL,'the state to go back to cannot be sent by the client');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e2',pg_temp.ever('f5000000-0000-4000-8000-0000000000e2'),pg_temp.slot(0,'staple','synthetic_rice','proposed'))->'entry'->'prior_status'),'null'::jsonb,'back to proposed, the entry forgets the state it came from');
-- (e) 作った枠が献立から消えても、その充当は取り消せないまま残る（'settled' へ畳む）
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000e4',pg_temp.ever('f5000000-0000-4000-8000-0000000000e4'),pg_temp.slot(0,'side','synthetic_cabbage','cooked'))->>'status'),'saved','the cabbage dish is cooked again');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c8',pg_temp.rev(),pg_temp.needs18(true,false,false))->>'status'),'saved','needs synced after cooking the cabbage dish again');
SELECT is((SELECT consumed_quantity FROM grocery_items WHERE item_key='cabbage|mass'),300::numeric,'cooked again, the 300 g is recorded as used again (once)');
SELECT is((delete_dinner_entry('f5000000-0000-4000-8000-0000000000e4',pg_temp.ever('f5000000-0000-4000-8000-0000000000e4'))->>'status'),'saved','the cooked cabbage dish is removed from the plan');
SELECT is((sync_grocery_auto_items('f5000000-0000-4000-8000-0000000000c9',pg_temp.rev(),pg_temp.needs18(true,false,false))->>'status'),'saved','needs synced after the removal');
SELECT is((SELECT purchased_quantity::text||':'||consumed_quantity::text||':'||consumptions::text FROM grocery_items WHERE item_key='cabbage|mass'),'300.000:300.000:[{"k": "settled", "m": false, "q": 300.000, "on": true}]','the use by a removed dish stays (settled), and the purchase fact is unchanged');
-- §19 在庫への補充の上限は RPC 自身が守る（Server Action を経ない直呼びでも、量で追う項目は
--   「購入 − 補充済み − 作った料理への充当」を超えて足せない。超えたら 22023。上限ちょうどは通る）。
--   キャベツ = 購入 300 g・充当 300 g（作って献立から消えた料理。settled）→ 充てられる量 0。
--   鶏 = 購入 400 g・充当 0・補充 0 → 400 g まで。手動の小麦粉 = 量 500 g の項目（まだ買っていない）。
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('cabbage|mass'),pg_temp.gver('cabbage|mass'),'f5000000-0000-4000-8000-0000000000d1',1)$$,'22023',NULL,'§19: the 300 g used by a cooked dish cannot be restocked by a direct call');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('cabbage|mass'),pg_temp.gver('cabbage|mass'),'f5000000-0000-4000-8000-0000000000d1',NULL)$$,'22023',NULL,'§19: with nothing left to restock, even an unknown quantity is rejected');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),'f5000000-0000-4000-8000-0000000000d2',400.01)$$,'22023',NULL,'§19: 0.01 g over the 400 g purchase is rejected');
SELECT is((restock_pantry_from_grocery(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),'f5000000-0000-4000-8000-0000000000d2',250)->>'status'),'saved','§19: 250 g of the 400 g of chicken restocked');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),'f5000000-0000-4000-8000-0000000000d3',150.01)$$,'22023',NULL,'§19: 150.01 g is over the 150 g left after the first restock');
SELECT is((restock_pantry_from_grocery(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),'f5000000-0000-4000-8000-0000000000d3',150)->>'status'),'saved','§19 control: exactly the 150 g left can be restocked');
SELECT is((SELECT ARRAY[purchased_quantity,restocked_quantity] FROM grocery_items WHERE item_key='chicken|mass'),ARRAY[400,400]::numeric[],'§19: restocked exactly up to the purchase, the purchase fact unchanged');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('chicken|mass'),pg_temp.gver('chicken|mass'),'f5000000-0000-4000-8000-0000000000d4',1)$$,'22023',NULL,'§19: a fully restocked purchase takes no more');
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-0000000000d5',NULL,'synthetic flour',500,'g',NULL,NULL)->>'status'),'saved','§19 seed: a manual item of 500 g, not bought yet');
SELECT throws_ok($$SELECT restock_pantry_from_grocery('f5000000-0000-4000-8000-0000000000d5',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-0000000000d5'),'f5000000-0000-4000-8000-0000000000d6',100)$$,'22023',NULL,'§19: an item that was not bought cannot be restocked');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-0000000000d5',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-0000000000d5'),500,false)->>'status'),'saved','§19 seed: the 500 g of flour bought');
SELECT is((restock_pantry_from_grocery('f5000000-0000-4000-8000-0000000000d5',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-0000000000d5'),'f5000000-0000-4000-8000-0000000000d6',500)->>'status'),'saved','§19 control: the whole 500 g in one restock passes');
SELECT is((SELECT array_agg(id::text||':'||coalesce(quantity::text,'-') ORDER BY id) FROM pantry_items WHERE id::text LIKE 'f5000000-0000-4000-8000-0000000000d%'),
 ARRAY['f5000000-0000-4000-8000-0000000000d2:250.00','f5000000-0000-4000-8000-0000000000d3:150.00','f5000000-0000-4000-8000-0000000000d6:500.00'],'§19: only the accepted restocks created pantry rows');
SELECT is((restock_pantry_from_grocery(pg_temp.gid('sesame|none'),pg_temp.gver('sesame|none'),'f5000000-0000-4000-8000-0000000000d7',NULL)->>'status'),'saved','§19 control: a ticked untracked item (no quantity) can still be restocked as an unknown quantity');
-- ── 20. 過ぎた日の枠・同期の失敗・古い画面・直接の RPC でも、充当と購入の事実が崩れない（独立レビューの指摘 2・3・4・6）──
--   h1 = 昨日の主菜（あひる 300 g）/ h2 = 昨日の副菜（がちょう 300 g）/ h3 = 今日の主菜（うずら 300 g）/ h4 = 昨日の汁物（しか 300 g）/
--   h5 = 今日の副菜（オクラ 500 g）/ h6 = 今日の汁物 / h7・h8 = 今日の主食。位置 6・7 で既存の枠と重ねない。
RESET ROLE;
CREATE FUNCTION pg_temp.slot6(p_day integer, p_role text, p_recipe text, p_status text, p_pos integer DEFAULT 6) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT pg_temp.entry(p_day,p_role,p_recipe,false,p_status)||jsonb_build_object('position',p_pos) $$;
CREATE FUNCTION pg_temp.cq(p_key text) RETURNS numeric LANGUAGE sql STABLE AS $$ SELECT consumed_quantity FROM grocery_items WHERE item_key=p_key $$;
CREATE FUNCTION pg_temp.need20(p_item text, p_day integer, p_entry text, p_qty numeric) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_array(pg_temp.item(p_item,p_qty,jsonb_build_array(pg_temp.src(p_day,p_entry,p_qty)))) $$;
CREATE FUNCTION pg_temp.sync20(p_op text, p_items jsonb) RETURNS text LANGUAGE sql AS $$
 SELECT sync_grocery_auto_items(p_op::uuid,pg_temp.rev(),p_items)->>'status' $$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
-- (i) 指摘 2: 過ぎた日の確定の枠を「作らなかった」→ 取り消し。充当は消えずに戻る
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f1',NULL,pg_temp.slot6(-1,'main','synthetic_duck','confirmed'))->>'status'),'saved','§20 seed: a dish confirmed for yesterday');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d201',pg_temp.need20('duck',-1,'f5000000-0000-4000-8000-0000000000f1',300)),'saved','§20 seed: its 300 g of duck listed');
SELECT is((set_grocery_purchase(pg_temp.gid('duck|mass'),pg_temp.gver('duck|mass'),300,false)->>'status'),'saved','§20 seed: 300 g of duck purchased');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d202','[]'),'saved','the past dish drops out of the needs');
SELECT is(pg_temp.cq('duck|mass'),300::numeric,'a dish left confirmed on a past day uses the 300 g once its need is gone');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f1',pg_temp.ever('f5000000-0000-4000-8000-0000000000f1'),pg_temp.slot6(-1,'main','synthetic_duck','skipped'))->>'status'),'saved','the past dish is marked as not cooked');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d203','[]'),'saved','synced after the skip');
SELECT is(pg_temp.cq('duck|mass'),0::numeric,'a dish not cooked uses nothing');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f1',pg_temp.ever('f5000000-0000-4000-8000-0000000000f1'),pg_temp.slot6(-1,'main','synthetic_duck','confirmed'))->>'status'),'saved','the skip is undone (back to confirmed on a past day)');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d204','[]'),'saved','synced after the undo');
SELECT is(pg_temp.cq('duck|mass'),300::numeric,'finding 2: undoing the skip of a past dish records its use again (the undo nets to zero)');
-- (ii) 指摘 2: 記録される前に「作らなかった」にした過ぎた日の枠も、取り消せば使った扱いへ戻る
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f2',NULL,pg_temp.slot6(-1,'side','synthetic_goose','confirmed'))->>'status'),'saved','§20 seed: another dish confirmed for yesterday');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d205',pg_temp.need20('goose',-1,'f5000000-0000-4000-8000-0000000000f2',300)),'saved','§20 seed: its 300 g of goose listed');
SELECT is((set_grocery_purchase(pg_temp.gid('goose|mass'),pg_temp.gver('goose|mass'),300,false)->>'status'),'saved','§20 seed: 300 g of goose purchased');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f2',pg_temp.ever('f5000000-0000-4000-8000-0000000000f2'),pg_temp.slot6(-1,'side','synthetic_goose','skipped'))->>'status'),'saved','marked as not cooked before any sync recorded its use');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d206','[]'),'saved','synced after the skip');
SELECT is(pg_temp.cq('goose|mass'),0::numeric,'the skipped past dish uses nothing');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f2',pg_temp.ever('f5000000-0000-4000-8000-0000000000f2'),pg_temp.slot6(-1,'side','synthetic_goose','confirmed'))->>'status'),'saved','the skip is undone');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d207','[]'),'saved','synced after the undo');
SELECT is(pg_temp.cq('goose|mass'),300::numeric,'finding 2: the undone past dish uses its 300 g as if it had never been skipped');
-- (iii) 指摘 3: 「作った」の後に同期が走らなくても、使った分は在庫へ足せない
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f3',NULL,pg_temp.slot6(0,'main','synthetic_quail','confirmed'))->>'status'),'saved','§20 seed: a dish confirmed for today');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d208',pg_temp.need20('quail',0,'f5000000-0000-4000-8000-0000000000f3',300)),'saved','§20 seed: its 300 g of quail listed');
SELECT is((set_grocery_purchase(pg_temp.gid('quail|mass'),pg_temp.gver('quail|mass'),300,false)->>'status'),'saved','§20 seed: 300 g of quail purchased');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f3',pg_temp.ever('f5000000-0000-4000-8000-0000000000f3'),pg_temp.slot6(0,'main','synthetic_quail','cooked'))->>'status'),'saved','cooked by a direct call, with no sync afterwards');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('quail|mass'),pg_temp.gver('quail|mass'),'f5000000-0000-4000-8000-0000000000f1',300)$$,'22023',NULL,'finding 3: the 300 g used by a dish cooked without a following sync cannot be restocked');
SELECT is(pg_temp.cq('quail|mass'),300::numeric,'cooking alone records the use (no sync needed)');
-- (iii') 同期の前（判定できないアレルギーで同期を止めている間など）の形。アプリ（rows.ts の settledSourceAmount）は
--   「出所に残る作った枠の buy」と「台帳の on の記録の k」から、今の必要量（必要量 − 作った枠の分）を出す
SELECT is((SELECT count(*) FROM grocery_items g, jsonb_array_elements(g.sources) s
           WHERE g.item_key='quail|mass' AND s.value->>'entryId'='f5000000-0000-4000-8000-0000000000f3'
             AND jsonb_typeof(s.value->'buy')='number' AND (s.value->>'buy')::numeric=300),
  1::bigint,'before a sync, the cooked dish stays in sources with its entryId and buy (the settle never rewrites sources)');
SELECT is((SELECT count(*) FROM grocery_items g, jsonb_array_elements(g.consumptions) c
           WHERE g.item_key='quail|mass' AND c.value->>'k'='f5000000-0000-4000-8000-0000000000f3'
             AND jsonb_typeof(c.value->'on')='boolean' AND (c.value->>'on')::boolean),
  1::bigint,'the ledger holds an on record keyed by the cooked entry id (the shape the app reads)');
SELECT is((SELECT required_quantity FROM grocery_items WHERE item_key='quail|mass'),300::numeric,
  'until the next sync, the needed amount still counts the cooked dish (the app subtracts it on read)');
-- (iv) 指摘 3: 日が過ぎて使った扱いになった枠も、補充の前に数える（同期が走っておらずとも）
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f4',NULL,pg_temp.slot6(-1,'soup','synthetic_venison','confirmed'))->>'status'),'saved','§20 seed: a dish confirmed for yesterday');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d209',pg_temp.need20('venison',-1,'f5000000-0000-4000-8000-0000000000f4',300)),'saved','§20 seed: its 300 g of venison still listed (the list was made before the day passed)');
SELECT is((set_grocery_purchase(pg_temp.gid('venison|mass'),pg_temp.gver('venison|mass'),300,false)->>'status'),'saved','§20 seed: 300 g of venison purchased');
SELECT is((restock_pantry_from_grocery(pg_temp.gid('venison|mass'),pg_temp.gver('venison|mass'),'f5000000-0000-4000-8000-0000000000f2',300)->>'status'),'conflict','finding 3: the use by the past dish is counted first, so a restock read before it conflicts');
SELECT throws_ok($$SELECT restock_pantry_from_grocery(pg_temp.gid('venison|mass'),pg_temp.gver('venison|mass'),'f5000000-0000-4000-8000-0000000000f2',300)$$,'22023',NULL,'with the current version the used 300 g is still not restockable');
SELECT is((SELECT count(*) FROM pantry_items WHERE id IN ('f5000000-0000-4000-8000-0000000000f1','f5000000-0000-4000-8000-0000000000f2')),0::bigint,'the refused restocks created no pantry row');
-- (v) 指摘 4: 作る前に開いた画面から、作った後に +100 g を記録できる（変わったのは充当の記録だけ）
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f5',NULL,pg_temp.slot6(0,'side','synthetic_okra','confirmed'))->>'status'),'saved','§20 seed: a dish confirmed for today');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d20a',pg_temp.need20('okra',0,'f5000000-0000-4000-8000-0000000000f5',500)),'saved','§20 seed: its 500 g of okra listed');
SELECT is((set_grocery_purchase(pg_temp.gid('okra|mass'),pg_temp.gver('okra|mass'),300,false)->>'status'),'saved','§20 seed: 300 g of the 500 g of okra purchased');
INSERT INTO fx SELECT 'okra_v1',to_jsonb(pg_temp.gver('okra|mass'));
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f5',pg_temp.ever('f5000000-0000-4000-8000-0000000000f5'),pg_temp.slot6(0,'side','synthetic_okra','cooked'))->>'status'),'saved','the okra dish is cooked');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d20b','[]'),'saved','synced after cooking (the row version moves)');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((set_grocery_purchase(pg_temp.gid('okra|mass'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='okra_v1'),400,false)->>'status'),'saved','finding 4: a screen read before cooking still records 100 g more (only the record of the use changed since)');
SELECT set_config('request.jwt.claims','{"sub":"f5000000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f5',pg_temp.ever('f5000000-0000-4000-8000-0000000000f5'),pg_temp.slot6(0,'side','synthetic_okra','confirmed'))->>'status'),'saved','the okra dish is un-cooked');
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d20c',pg_temp.need20('okra',0,'f5000000-0000-4000-8000-0000000000f5',500)),'saved','needs synced after the undo');
SELECT is((SELECT ARRAY[purchased_quantity,consumed_quantity] FROM grocery_items WHERE item_key='okra|mass')||pg_temp.short('okra|mass'),ARRAY[400,0,100]::numeric[],'finding 4: the 100 g survives the undo and 100 g of the 500 g is left to buy');
SELECT is((set_grocery_purchase(pg_temp.gid('okra|mass'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='okra_v1'),450,false)->>'status'),'conflict','control: a screen read before another purchase is still a conflict (it never overwrites a purchase)');
-- (vi) 指摘 6a: 同期は「作った」枠を必要量に載せられない。出所の量の合計は必要量を超えられない
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f6',NULL,pg_temp.slot6(0,'soup','synthetic_kelp','confirmed'))->>'status'),'saved','§20 seed: a soup confirmed for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f6',pg_temp.ever('f5000000-0000-4000-8000-0000000000f6'),pg_temp.slot6(0,'soup','synthetic_kelp','cooked'))->>'status'),'saved','the soup is cooked');
SELECT throws_ok($$SELECT pg_temp.sync20('f5000000-0000-4000-8000-00000000d20d',pg_temp.need20('kelp',0,'f5000000-0000-4000-8000-0000000000f6',100))$$,'22023',NULL,'finding 6a: a sync cannot list a cooked dish as still needed (that would give its use back)');
SELECT throws_ok($$SELECT pg_temp.sync20('f5000000-0000-4000-8000-00000000d20d',jsonb_build_array(pg_temp.item('kelp',100,jsonb_build_array(pg_temp.src(0,NULL,200)))))$$,'22023',NULL,'finding 6a: the amounts the sources put on the list cannot exceed the item''s need');
-- (vii) 指摘 6b: 直の呼出しでも、購入の合計を「補充済み + 作った料理への充当」より下げられない
SELECT throws_ok($$SELECT set_grocery_purchase(pg_temp.gid('duck|mass'),pg_temp.gver('duck|mass'),100,false)$$,'22023',NULL,'finding 6b: a direct call cannot lower the purchase below what was restocked and used');
SELECT is((set_grocery_purchase(pg_temp.gid('duck|mass'),pg_temp.gver('duck|mass'),350,false)->>'status'),'saved','control: raising the purchase total is fine');
-- (viii) 指摘 6c・6d: 画面が出さない遷移は DB も受けない
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f7',NULL,pg_temp.slot6(0,'staple','synthetic_bread','confirmed'))->>'status'),'saved','§20 seed: a staple confirmed for today');
SELECT is((save_dinner_entry('f5000000-0000-4000-8000-0000000000f7',pg_temp.ever('f5000000-0000-4000-8000-0000000000f7'),pg_temp.slot6(0,'staple','synthetic_bread','cooked'))->>'status'),'saved','the staple is cooked');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-0000000000f7',pg_temp.ever('f5000000-0000-4000-8000-0000000000f7'),pg_temp.slot6(0,'staple','synthetic_bread','skipped'))$$,'22023',NULL,'finding 6c: a cooked dish cannot be switched to not cooked directly (undo first)');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-0000000000f8',NULL,pg_temp.slot6(0,'staple','synthetic_toast','cooked',7))$$,'22023',NULL,'finding 6d: a new entry cannot start as cooked');
SELECT throws_ok($$SELECT save_dinner_entry('f5000000-0000-4000-8000-0000000000f8',NULL,pg_temp.slot6(0,'staple','synthetic_toast','skipped',7))$$,'22023',NULL,'finding 6d: nor as not cooked');
-- ── 21. 単位・品名が変わった後に、変わる前の画面から送った購入は conflict（購入の版の照合の穴）──
--   緩めた照合（purchase_updated_at ≤ 版 ≤ updated_at）は「購入の事実の意味が同じ」ことが前提。単位・品名が変われば
--   購入量の意味が変わるので、その書込でも purchase_updated_at を進め、変わる前の版の購入を通さない。
CREATE FUNCTION pg_temp.oat(p_qty numeric, p_unit text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_array(jsonb_build_object('item_key','oat|volume','ingredient_id','oat','name','synthetic oat milk','required_quantity',p_qty,
  'unit',p_unit,'required_note',NULL,'needs_stock_check',false,'sources',jsonb_build_array(pg_temp.src(0,NULL,p_qty)))) $$;
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000101',NULL,'synthetic milk',2,'本',NULL,NULL)->>'status'),'saved','§21 seed: a manual item of 2 本 of milk');
INSERT INTO fx SELECT 'milk21_v1',to_jsonb(updated_at) FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101';
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000101',(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='milk21_v1'),'synthetic milk',200,'ml',NULL,NULL)->>'status'),'saved','another device changes the unit from 本 to ml');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000101',(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='milk21_v1'),2,false)->>'status'),'conflict','a purchase of 2 from a screen read before the unit changed is a conflict (it would be recorded as 2 ml)');
SELECT is((SELECT purchased_quantity FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101'),0::numeric,'the stale purchase recorded nothing');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000101',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101'),200,false)->>'status'),'saved','control: with the version that shows ml, 200 ml is recorded');
INSERT INTO fx SELECT 'milk21_v2',to_jsonb(updated_at) FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101';
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000101',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101'),'synthetic milk',400,'ml',NULL,'synthetic memo')->>'status'),'saved','another device changes only the needed amount and the note');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000101',(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='milk21_v2'),300,false)->>'status'),'saved','control: a needed-amount or note change does not stop a screen that saw the current purchase');
INSERT INTO fx SELECT 'milk21_v3',to_jsonb(updated_at) FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101';
SELECT is((save_grocery_manual_item('f5000000-0000-4000-8000-000000000101',(SELECT updated_at FROM grocery_items WHERE id='f5000000-0000-4000-8000-000000000101'),'synthetic soy milk',400,'ml',NULL,'synthetic memo')->>'status'),'saved','another device renames the item (what was bought changes)');
SELECT is((set_grocery_purchase('f5000000-0000-4000-8000-000000000101',(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='milk21_v3'),350,false)->>'status'),'conflict','a purchase from a screen read before the rename is a conflict');
-- 自動の項目: 単位は item_key の単位族で決まるが、直の同期で同じ鍵の単位を変えられても、変わる前の画面の購入は通さない
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d221',pg_temp.oat(500,'ml')),'saved','§21 seed: an auto item of 500 ml of oat milk');
SELECT is((set_grocery_purchase(pg_temp.gid('oat|volume'),pg_temp.gver('oat|volume'),200,false)->>'status'),'saved','§21 seed: 200 ml of oat milk purchased');
INSERT INTO fx SELECT 'oat21_v1',to_jsonb(pg_temp.gver('oat|volume'));
SELECT is(pg_temp.sync20('f5000000-0000-4000-8000-00000000d222',pg_temp.oat(0.5,'l')),'saved','a direct sync changes the unit of the same key to l');
SELECT is((set_grocery_purchase(pg_temp.gid('oat|volume'),(SELECT (v#>>'{}')::timestamptz FROM fx WHERE k='oat21_v1'),300,false)->>'status'),'conflict','a purchase from a screen read before the unit changed is a conflict (auto item)');
-- (f) 台帳と印の整合は DB が守る（RPC 以外の書込でも崩せない）
RESET ROLE;
SELECT throws_ok($$UPDATE grocery_items SET consumed_quantity=consumed_quantity+1 WHERE item_key='cabbage|mass'$$,'23514',NULL,'consumed_quantity must equal the sum of the ledger');
SELECT throws_ok($$UPDATE grocery_items SET consumptions='[{"k":"not-an-entry","q":300,"m":false}]' WHERE item_key='cabbage|mass'$$,'23514',NULL,'a ledger record must name an entry id or settled');
SELECT throws_ok($$UPDATE grocery_items SET consumptions='[{"k":"settled","q":-1,"m":false}]',consumed_quantity=0 WHERE item_key='cabbage|mass'$$,'23514',NULL,'a ledger amount cannot be negative');
SELECT throws_ok($$UPDATE grocery_items SET purchase_consumed=true WHERE item_key='cabbage|mass'$$,'23514',NULL,'only a ticked purchase can be marked as used up');
SELECT throws_ok($$UPDATE dinner_plan_entries SET prior_status='confirmed' WHERE id='f5000000-0000-4000-8000-0000000000e1'$$,'23514',NULL,'only a cooked or skipped entry keeps a state to go back to');
SET LOCAL ROLE service_role;
SELECT lives_ok($$UPDATE grocery_items SET note='synthetic service note' WHERE item_key='cabbage|mass'$$,'service_role maintenance writes still pass the ledger check');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
