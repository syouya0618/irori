-- ============================================================
-- 献立・買い物・在庫機能の廃止 — パート2: DROP（**不可逆・本番の行が消える**）
-- ============================================================
--
-- ⚠️ 本 migration は本番の献立・買い物・在庫の行をバックアップ以外から戻せぬ形で消す。
--    当てる前に `supabase db dump --linked --data-only` 等で対象表の実体を控え、
--    件数を見て決めること。パート1（20260909100002）だけを当てた状態でもアプリは
--    完全に動くゆえ、急いで当てる理由は無い。
--
-- ⚠️ 当てぬと決めた場合はこのファイルをリポジトリから消すこと。残したままだと
--    次の `supabase db push` が本 migration を含めて適用する。
--
-- 依存の順: FK は meal_reactions / meal_ingredients / eating_out_logs → meals →
-- meal_templates、shopping_items.meal_id → meals。CASCADE で一括に落とす。
-- ENUM 型は依存する列が全て消えてから落とす（households.auto_stock_categories は
-- JSONB ゆえ item_category 型に依存せぬが、機能ごと消えるため同時に落とす）。

DROP TABLE IF EXISTS eating_out_logs CASCADE;
DROP TABLE IF EXISTS meal_ingredients CASCADE;
DROP TABLE IF EXISTS meal_reactions CASCADE;
DROP TABLE IF EXISTS shopping_items CASCADE;
DROP TABLE IF EXISTS meals CASCADE;
DROP TABLE IF EXISTS meal_templates CASCADE;
DROP TABLE IF EXISTS stock_items CASCADE;
DROP TABLE IF EXISTS purchase_history CASCADE;

DROP TYPE IF EXISTS meal_type;
DROP TYPE IF EXISTS meal_reaction;
DROP TYPE IF EXISTS store_type;
DROP TYPE IF EXISTS item_category;

-- 買い物→在庫の自動追加カテゴリ（設定カードごと廃止）
ALTER TABLE households DROP CONSTRAINT IF EXISTS chk_auto_stock_categories;
ALTER TABLE households DROP COLUMN IF EXISTS auto_stock_categories;

-- 外食写真 bucket の中身と bucket 本体（objects を先に消さねば bucket は消えぬ）
DELETE FROM storage.objects WHERE bucket_id = 'eating-out-photos';
DELETE FROM storage.buckets WHERE id = 'eating-out-photos';
