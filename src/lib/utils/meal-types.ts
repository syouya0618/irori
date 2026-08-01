import type { MealType } from "@/lib/types/database"

export const MEAL_TYPE_LABELS: Record<MealType, string> = {
  breakfast: "朝食",
  lunch: "昼食",
  dinner: "夕食",
  snack: "間食",
}

export const MEAL_TYPE_SHORT_LABELS: Record<MealType, string> = {
  breakfast: "朝",
  lunch: "昼",
  dinner: "夕",
  snack: "間",
}

/**
 * 週ビュー(meal-day-row)が描画する食事タイプ。
 * フォームの選択肢(MEAL_TYPES)もこれと一致させる — 一致させないと、選べるが
 * 表示されない不可視データが生まれ、UNIQUE(household_id, date, meal_type) と
 * 組み合わさって「既に登録されています」の原因不明エラーになる(削除手段も無い)。
 *
 * DB の meal_type ENUM には 'snack' が残っている(既存データ・将来の
 * 間食対応のため)。MEAL_TYPE_LABELS も全種別を保持し、既存の間食データを表示できる。
 */
export const WEEK_VIEW_MEAL_TYPES: MealType[] = ["breakfast", "lunch", "dinner"]

/** フォームの選択肢 = 週ビューが描画できる種別(上のコメント参照)。 */
export const MEAL_TYPES: MealType[] = WEEK_VIEW_MEAL_TYPES
