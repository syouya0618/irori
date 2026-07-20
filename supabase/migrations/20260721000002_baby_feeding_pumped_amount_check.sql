-- ============================================================
-- 授乳: 搾乳（pumped）にも amount_ml を許可（パート2: CHECK制約）
-- ============================================================

-- 搾乳は哺乳瓶で量を測って与えるため amount_ml を伴う。
-- ENUM への 'pumped' 追加（20260721000001）とは別トランザクションで適用する必要がある
-- （新 ENUM 値を参照する CHECK は ADD VALUE と同一トランザクション内で使えない）。
ALTER TABLE baby_logs DROP CONSTRAINT IF EXISTS chk_amount_ml;
ALTER TABLE baby_logs ADD CONSTRAINT chk_amount_ml
  CHECK (amount_ml IS NULL OR feeding_type IN ('bottle', 'solid', 'pumped'));
