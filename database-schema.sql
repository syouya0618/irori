-- ============================================================
-- 「うちのログ」DBスキーマ — Phase 1 + 1.5
-- Supabase (PostgreSQL) + RLS
-- ============================================================

-- ============================================================
-- 0. Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. ENUM Types
-- ============================================================

-- 献立タイプ
CREATE TYPE meal_type AS ENUM ('breakfast', 'lunch', 'dinner', 'snack');

-- 献立リアクション
CREATE TYPE meal_reaction AS ENUM ('good', 'ok', 'bad');
-- 😋 = good, 😐 = ok, 🙅 = bad

-- 買い物アイテムの店タイプ
CREATE TYPE store_type AS ENUM ('supermarket', 'drugstore', 'convenience', 'online', 'other');

-- 食材・日用品カテゴリ
CREATE TYPE item_category AS ENUM (
  -- 食材
  'vegetable',    -- 野菜
  'fruit',        -- 果物
  'meat',         -- 肉
  'fish',         -- 魚介
  'dairy',        -- 乳製品
  'egg',          -- 卵
  'grain',        -- 穀物・米・パン・麺
  'seasoning',    -- 調味料
  'frozen',       -- 冷凍食品
  'snack_food',   -- お菓子・飲料
  'other_food',   -- その他食品
  -- 日用品
  'baby',         -- ベビー用品（おむつ・おしりふき等）
  'cleaning',     -- 洗剤・掃除用品
  'hygiene',      -- 衛生用品（ティッシュ・トイレットペーパー等）
  'other_daily'   -- その他日用品
);

-- 世帯メンバーの役割
CREATE TYPE household_role AS ENUM ('owner', 'member', 'viewer');
-- owner: 作成者（管理権限）, member: 配偶者, viewer: 将来の祖父母閲覧用

-- 招待ステータス
CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired');

-- ============================================================
-- 2. Core Tables
-- ============================================================

-- ------------------------------------------------------------
-- 世帯（全データの親）
-- ------------------------------------------------------------
CREATE TABLE households (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- ユーザープロフィール（Supabase Auth の auth.users と 1:1）
-- ------------------------------------------------------------
CREATE TABLE profiles (
  id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  household_id    UUID REFERENCES households(id) ON DELETE SET NULL,
  display_name    TEXT NOT NULL DEFAULT '',
  avatar_url      TEXT,
  role            household_role NOT NULL DEFAULT 'member',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_profiles_household ON profiles(household_id);

-- ------------------------------------------------------------
-- 招待リンク
-- ------------------------------------------------------------
CREATE TABLE invitations (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  invited_by      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  role            household_role NOT NULL DEFAULT 'member',
  status          invite_status NOT NULL DEFAULT 'pending',
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  accepted_by     UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invitations_token ON invitations(token);

-- ============================================================
-- 3. Phase 1: 献立 + 買い物リスト
-- ============================================================

-- ------------------------------------------------------------
-- 献立テンプレート（「先週のカレー」等を保存）
-- ------------------------------------------------------------
CREATE TABLE meal_templates (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  ingredients     JSONB DEFAULT '[]',
  -- [{"name": "豚肉", "quantity": "200g", "category": "meat"}, ...]
  created_by      UUID NOT NULL REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meal_templates_household ON meal_templates(household_id);

-- ------------------------------------------------------------
-- 献立（日付 × 食事タイプ）
-- ------------------------------------------------------------
CREATE TABLE meals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  date            DATE NOT NULL,
  meal_type       meal_type NOT NULL,
  title           TEXT NOT NULL,
  is_eating_out   BOOLEAN NOT NULL DEFAULT false,
  template_id     UUID REFERENCES meal_templates(id) ON DELETE SET NULL,
  created_by      UUID NOT NULL REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (household_id, date, meal_type)
);

CREATE INDEX idx_meals_household_date ON meals(household_id, date);

-- ------------------------------------------------------------
-- 献立リアクション（夫婦それぞれが評価）
-- ------------------------------------------------------------
CREATE TABLE meal_reactions (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meal_id     UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reaction    meal_reaction NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (meal_id, user_id)
);

CREATE INDEX idx_meal_reactions_meal ON meal_reactions(meal_id);

-- ------------------------------------------------------------
-- 献立の食材（献立 → 買い物リスト自動生成の元データ）
-- ------------------------------------------------------------
CREATE TABLE meal_ingredients (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meal_id     UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  quantity    TEXT,
  category    item_category NOT NULL DEFAULT 'other_food',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meal_ingredients_meal ON meal_ingredients(meal_id);

-- ------------------------------------------------------------
-- 買い物リスト
-- ------------------------------------------------------------
CREATE TABLE shopping_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  quantity        TEXT,
  category        item_category NOT NULL DEFAULT 'other_food',
  store_type      store_type NOT NULL DEFAULT 'supermarket',
  is_checked      BOOLEAN NOT NULL DEFAULT false,
  checked_by      UUID REFERENCES profiles(id),
  checked_at      TIMESTAMPTZ,
  meal_id         UUID REFERENCES meals(id) ON DELETE SET NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_by      UUID NOT NULL REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shopping_household ON shopping_items(household_id, is_checked);
CREATE INDEX idx_shopping_store ON shopping_items(household_id, store_type);

-- ------------------------------------------------------------
-- 外食記録（is_eating_out = true の献立に紐づく）
-- ------------------------------------------------------------
CREATE TABLE eating_out_logs (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  meal_id         UUID NOT NULL UNIQUE REFERENCES meals(id) ON DELETE CASCADE,
  restaurant_name TEXT,
  place_id        TEXT,
  photo_url       TEXT,
  memo            TEXT,
  rating          SMALLINT CHECK (rating BETWEEN 1 AND 5),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 4. Phase 1.5: 在庫管理
-- ============================================================

CREATE TABLE stock_items (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  category        item_category NOT NULL DEFAULT 'other_food',
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit            TEXT,
  expires_at      DATE,
  created_by      UUID NOT NULL REFERENCES profiles(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_stock_household ON stock_items(household_id);
CREATE INDEX idx_stock_expires ON stock_items(household_id, expires_at);

-- よく買うもの学習用（購入頻度の記録）
CREATE TABLE purchase_history (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id    UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  item_name       TEXT NOT NULL,
  category        item_category,
  store_type      store_type,
  purchased_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_household ON purchase_history(household_id);
CREATE INDEX idx_purchase_item ON purchase_history(household_id, item_name);

-- ============================================================
-- 5. RLS Policies
-- ============================================================

ALTER TABLE households ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE meals ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE meal_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE eating_out_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_history ENABLE ROW LEVEL SECURITY;

-- ヘルパー関数: 現在のユーザーの household_id を取得
CREATE OR REPLACE FUNCTION get_my_household_id()
RETURNS UUID AS $$
  SELECT household_id FROM profiles WHERE id = auth.uid();
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- --- households ---
CREATE POLICY "households_select" ON households
  FOR SELECT USING (id = get_my_household_id());

CREATE POLICY "households_insert" ON households
  FOR INSERT WITH CHECK (true);

CREATE POLICY "households_update" ON households
  FOR UPDATE USING (id = get_my_household_id());

-- --- profiles ---
CREATE POLICY "profiles_select" ON profiles
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update" ON profiles
  FOR UPDATE USING (id = auth.uid());

-- --- invitations ---
CREATE POLICY "invitations_select" ON invitations
  FOR SELECT USING (household_id = get_my_household_id());

CREATE POLICY "invitations_insert" ON invitations
  FOR INSERT WITH CHECK (household_id = get_my_household_id());

-- --- 世帯データ共通パターン ---
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'meal_templates', 'meals', 'shopping_items',
    'stock_items', 'purchase_history'
  ])
  LOOP
    EXECUTE format(
      'CREATE POLICY "%1$s_select" ON %1$s FOR SELECT USING (household_id = get_my_household_id())',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_insert" ON %1$s FOR INSERT WITH CHECK (household_id = get_my_household_id())',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_update" ON %1$s FOR UPDATE USING (household_id = get_my_household_id())',
      tbl
    );
    EXECUTE format(
      'CREATE POLICY "%1$s_delete" ON %1$s FOR DELETE USING (household_id = get_my_household_id())',
      tbl
    );
  END LOOP;
END
$$;

-- --- meal_reactions ---
CREATE POLICY "meal_reactions_select" ON meal_reactions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "meal_reactions_insert" ON meal_reactions
  FOR INSERT WITH CHECK (
    user_id = auth.uid() AND
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "meal_reactions_update" ON meal_reactions
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "meal_reactions_delete" ON meal_reactions
  FOR DELETE USING (user_id = auth.uid());

-- --- meal_ingredients ---
CREATE POLICY "meal_ingredients_select" ON meal_ingredients
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "meal_ingredients_insert" ON meal_ingredients
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "meal_ingredients_delete" ON meal_ingredients
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

-- --- eating_out_logs ---
CREATE POLICY "eating_out_logs_select" ON eating_out_logs
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "eating_out_logs_insert" ON eating_out_logs
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

CREATE POLICY "eating_out_logs_update" ON eating_out_logs
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM meals WHERE meals.id = meal_id AND meals.household_id = get_my_household_id())
  );

-- ============================================================
-- 6. Triggers
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_meals_updated_at
  BEFORE UPDATE ON meals FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_meal_templates_updated_at
  BEFORE UPDATE ON meal_templates FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_stock_items_updated_at
  BEFORE UPDATE ON stock_items FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 7. Auth Hook: 新規ユーザー作成時にprofileを自動生成
-- ============================================================

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'display_name', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
