-- ============================================================
-- いつものミルク量（設定）: households.bottle_default_ml を追加
--
-- クイック記録の「ミルク」を 1 タップで押した時に amount_ml へ入れる量（ml）。
-- 赤子の成長に合わせて夫婦どちらの端末からでも変えられ、世帯で共有する。
--
-- - NULL = 未設定。既定値は**置かぬ**（勝手な既定量で記録させぬ。未設定の間は
--   クイック記録が量の入力を求める）。既存の世帯は NULL のまま始まる（backfill しない）
-- - 値は 1〜999 の整数。0 ml の「いつもの量」は意味を持たず、上限は baby_logs.amount_ml
--   の CHECK（0〜999）に収まる値に揃える。サーバ（updateBottleDefault）・クライアント
--   （src/lib/domain/bottle-default.ts）は同じ範囲のミラー
-- - 設定は**次の記録から**効く。baby_logs の既存行（amount_ml NULL を含む）には触れぬ
--
-- RLS: households は既存の households_select / households_update（自世帯のみ・
-- SELECT と UPDATE を分けたポリシー）がこの列もそのまま守る。INSERT / DELETE は
-- 20261002100001 で authenticated から剥がし済みゆえ、新しいポリシーも GRANT も要らぬ。
-- Realtime の publication には足さぬ（他端末への反映は画面復帰時の取り直しで行う）。
--
-- 冪等性: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS で再適用しても落ちぬ。
-- ============================================================

ALTER TABLE public.households
  ADD COLUMN IF NOT EXISTS bottle_default_ml SMALLINT;

ALTER TABLE public.households DROP CONSTRAINT IF EXISTS chk_bottle_default_ml;
ALTER TABLE public.households ADD CONSTRAINT chk_bottle_default_ml
  CHECK (bottle_default_ml IS NULL OR bottle_default_ml BETWEEN 1 AND 999);

COMMENT ON COLUMN public.households.bottle_default_ml IS
  'いつものミルク量（ml）。クイック記録の「ミルク」が amount_ml に入れる量（1〜999・NULL は未設定）';
