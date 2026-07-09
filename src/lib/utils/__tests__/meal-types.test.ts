/**
 * meal_type の「選べるのに表示されない」不整合の回帰テスト。
 *
 * フォームの選択肢(MEAL_TYPES)と週ビューが描画する種別(WEEK_VIEW_MEAL_TYPES)が
 * 一致しないと、選べるが表示されない不可視データが生まれ、UNIQUE(household_id,
 * date, meal_type) と組み合わさって「既に登録されています」の原因不明エラーになる
 * (削除手段も無い)。両者を単一の真実源から導出することを固定する。
 */

import { describe, it, expect } from "vitest"
import {
  MEAL_TYPES,
  WEEK_VIEW_MEAL_TYPES,
  MEAL_TYPE_LABELS,
} from "@/lib/utils/meal-types"

describe("meal-types: 選択肢と週ビューの整合", () => {
  it("フォームの選択肢は週ビューが描画する種別と一致する（不可視データを作らない）", () => {
    expect([...MEAL_TYPES].sort()).toEqual([...WEEK_VIEW_MEAL_TYPES].sort())
  })

  it("週ビューは朝・昼・夕の3種", () => {
    expect(WEEK_VIEW_MEAL_TYPES).toEqual(["breakfast", "lunch", "dinner"])
  })

  it("ラベルは既存の間食データ表示のため snack を残す", () => {
    // DB ENUM の snack は Flutter・既存データ・将来の間食対応のため保持する
    expect(MEAL_TYPE_LABELS.snack).toBeDefined()
  })
})
