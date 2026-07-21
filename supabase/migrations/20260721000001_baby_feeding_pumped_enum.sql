-- ============================================================
-- 授乳: 搾乳（pumped）を feeding_type ENUM に追加（パート1: ENUM拡張）
-- ============================================================

-- NOTE: ALTER TYPE ... ADD VALUE はトランザクション外で実行される。
-- 同一トランザクションで新しい値を参照する CHECK 制約（chk_amount_ml の再定義）は
-- 次のマイグレーション 20260721000002 に分離する。
ALTER TYPE feeding_type ADD VALUE IF NOT EXISTS 'pumped';
