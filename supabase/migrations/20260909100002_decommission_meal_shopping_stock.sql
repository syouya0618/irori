-- ============================================================
-- 献立・買い物・在庫機能の廃止 — パート1: 切り離し（**データは消さない・可逆**）
-- ============================================================
--
-- アプリ側は同一 PR で献立（meals / meal_reactions / meal_ingredients / meal_templates /
-- eating_out_logs）・買い物（shopping_items / purchase_history）・在庫（stock_items）を
-- 一切読まず書かない形へ変更済み。本 migration は DB 側でそれらを**API から届かぬ
-- 状態**にし、起動時のページ設定を新しい集合へ揃える。テーブルと行はそのまま残る。
--
-- 行を消す DROP はパート2（20260909100003）へ分けてある。あちらは不可逆ゆえ、
-- 本番へ当てるかどうかは人が決める。**本 migration だけを当てた状態でもアプリは
-- 完全に動く**（残る表はどのコードからも参照されぬ）。
--
-- 戻し方: REVOKE を GRANT で戻し、publication へ ADD TABLE し直し、default_page の
-- CHECK を旧集合へ戻せば旧コードが再び動く。

-- ------------------------------------------------------------
-- 1. profiles.default_page — 起動時のページの集合を {baby, calendar} へ
-- ------------------------------------------------------------
-- 旧値 meals / shopping / stock は行き先が消えるため baby へ寄せる（アプリの
-- resolveDefaultPage も未知値を baby へ倒すが、CHECK を締める前に行を先に直す
-- ことで、締めた瞬間に既存行が CHECK 違反で UPDATE 不能になる事故を避ける）。
UPDATE profiles
SET default_page = 'baby'
WHERE default_page IS NULL
   OR default_page NOT IN ('baby', 'calendar');

ALTER TABLE profiles ALTER COLUMN default_page SET DEFAULT 'baby';

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS chk_default_page;
ALTER TABLE profiles ADD CONSTRAINT chk_default_page
  CHECK (default_page IN ('baby', 'calendar'));

-- ------------------------------------------------------------
-- 2. Realtime publication から外す（購読するコードはもう無い）
-- ------------------------------------------------------------
-- publication に無い表を DROP TABLE すると失敗せぬが、逆順（先に DROP）だと
-- 本 migration が失敗するため、存在確認つきで外す。
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['meals', 'meal_reactions', 'shopping_items', 'stock_items'])
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = tbl
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I', tbl);
    END IF;
  END LOOP;
END
$$;

-- ------------------------------------------------------------
-- 3. PostgREST（anon / authenticated）からの到達を断つ
-- ------------------------------------------------------------
-- Supabase は public の表へ anon / authenticated へ実行時 GRANT を与える。
-- コードが無くても anon キーで直叩きすれば読めるため、REVOKE で閉じる
-- （RLS は残るが、多層防御として表権限も落とす）。service_role は BYPASSRLS の
-- 管理ロールゆえ残す（Dashboard / dump / 手動確認の経路）。
REVOKE ALL ON TABLE
  meals, meal_reactions, meal_ingredients, meal_templates, eating_out_logs,
  shopping_items, purchase_history, stock_items
FROM anon, authenticated;

-- ------------------------------------------------------------
-- 4. 献立専用 RPC（データを持たぬコード）
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS update_meal_with_ingredients(UUID, DATE, meal_type, TEXT, BOOLEAN, JSONB);

-- ------------------------------------------------------------
-- 5. 外食写真 storage のポリシー（bucket と objects は残す）
-- ------------------------------------------------------------
-- 書込・列挙の経路を閉じる。objects の削除は不可逆ゆえパート2 へ。
DROP POLICY IF EXISTS "eating_out_photos_select" ON storage.objects;
DROP POLICY IF EXISTS "eating_out_photos_insert" ON storage.objects;
DROP POLICY IF EXISTS "eating_out_photos_delete" ON storage.objects;
