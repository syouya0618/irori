-- updateMeal の「献立更新 + 食材の全入替」を単一トランザクションに畳む RPC。
--
-- 背景 (issue #49):
-- 旧 server action は (1) meals.update → (2) meal_ingredients.delete →
-- (3) meal_ingredients.insert を 3 つの独立した自動コミットで実行していた。
--   (a) 先頭の meals.update が Realtime (meals テーブルのみ購読) を発火し、
--       クライアントの refetch SELECT が delete↔insert の窓に割り込むと
--       ingredients が空の中間状態を読んでしまう (一時的な表示劣化)。
--   (b) delete 成功→insert 失敗で ingredients が無音で全消失する (データ欠損)。
-- 関数本体は単一トランザクションで走るため、中間状態は他セッションから不可視と
-- なり、いずれかの操作が失敗すれば全ロールバックされる。これで (a)(b) を共に根治する。
--
-- SECURITY INVOKER (既定): 呼び出しユーザーの RLS が UPDATE/DELETE/INSERT すべてに
-- 適用され、世帯スコープが DB 層でも担保される (server action の所有権チェックに
-- 加えた多層防御)。SET search_path = public で関数内の参照を固定する。
CREATE OR REPLACE FUNCTION update_meal_with_ingredients(
  p_meal_id       UUID,
  p_date          DATE,
  p_meal_type     meal_type,
  p_title         TEXT,
  p_is_eating_out BOOLEAN,
  p_ingredients   JSONB
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  UPDATE public.meals
  SET date = p_date,
      meal_type = p_meal_type,
      title = p_title,
      is_eating_out = p_is_eating_out
  WHERE id = p_meal_id;

  DELETE FROM public.meal_ingredients WHERE meal_id = p_meal_id;

  IF p_ingredients IS NOT NULL AND jsonb_array_length(p_ingredients) > 0 THEN
    INSERT INTO public.meal_ingredients (meal_id, name, quantity, category)
    SELECT
      p_meal_id,
      ing->>'name',
      ing->>'quantity',
      COALESCE(NULLIF(ing->>'category', ''), 'other_food')::item_category
    FROM jsonb_array_elements(p_ingredients) AS ing;
  END IF;
END;
$$;
