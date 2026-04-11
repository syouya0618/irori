-- ============================================================
-- Phase 3.2: 機能連携（買い物→在庫自動追加 + 消耗品ペース算出）
-- ============================================================

-- 1. households テーブルに自動在庫追加対象カテゴリを追加
-- デフォルトは baby, cleaning, hygiene（日用消耗品）
ALTER TABLE households
  ADD COLUMN auto_stock_categories JSONB NOT NULL DEFAULT '["baby","cleaning","hygiene"]';

-- バリデーション: JSONB配列であること
ALTER TABLE households
  ADD CONSTRAINT chk_auto_stock_categories
  CHECK (jsonb_typeof(auto_stock_categories) = 'array');
