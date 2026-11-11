import { describe, expect, it } from "vitest"

import { evaluateRecipe, buildExclusionSet } from "../exclusions"
import { suggestNow, type SuggestNowInput } from "../suggest-now"
import type { DishFeedback, PantryItem } from "../types"
import { CATALOG, exclusion, q, STAPLES, stock, TODAY } from "./fixtures"

function input(pantry: PantryItem[], overrides: Partial<SuggestNowInput> = {}): SuggestNowInput {
  return {
    today: TODAY,
    servings: 2,
    pantry,
    exclusions: [],
    stapleIngredientIds: STAPLES,
    catalog: CATALOG,
    ...overrides,
  }
}

/** 主菜 4 つ・副菜 2 つが揃う在庫。 */
function richPantry(): PantryItem[] {
  return [
    stock("pork", { id: "pork", quantity: q(400, "g") }),
    stock("onion", { id: "onion", quantity: q(3, "piece") }),
    stock("chicken_thigh", { id: "chicken", quantity: q(250, "g") }),
    stock("salmon", { id: "salmon", quantity: q(2, "slice") }),
    stock("tofu", { id: "tofu", quantity: q(1, "block") }),
    stock("tomato", { id: "tomato", quantity: q(2, "piece") }),
    stock("cabbage", { id: "cabbage", quantity: q(300, "g") }),
  ]
}

const ids = (list: { recipe: { id: string } }[]) => list.map((s) => s.recipe.id)

describe("V-C1 今あるもので: 揃う 3 案", () => {
  it("必要な食材と量が揃う候補を基本 3 案返す（全件数も返す）", () => {
    const result = suggestNow(input(richPantry()))
    expect(result.ready).toHaveLength(3)
    expect(result.readyTotal).toBeGreaterThan(3)
    expect(result.ready.every((s) => s.level === "ready" && s.match.missing.length === 0)).toBe(true)
    expect(result.hints).toEqual([])
  })

  it("3 つの枠は混ざらない（C-23 / C-24: 必須食材が欠ける候補を ready に入れない）", () => {
    const result = suggestNow(input(richPantry(), { limit: 50 }))
    expect(result.ready.every((s) => s.level === "ready")).toBe(true)
    expect(result.check.every((s) => s.level === "check")).toBe(true)
    expect(result.buy.every((s) => s.level === "buy" && s.match.missing.length > 0)).toBe(true)
    const all = [...ids(result.ready), ...ids(result.check), ...ids(result.buy)]
    expect(new Set(all).size).toBe(all.length)
  })

  it("買い足し案は不足している食材と量を明示する", () => {
    const result = suggestNow(input(richPantry(), { limit: 50 }))
    const shrimp = result.buy.find((s) => s.recipe.id === "shrimp_egg")
    expect(shrimp?.match.missing.map((m) => [m.name, m.shortBy])).toEqual([
      ["えび", q(150, "g")],
      ["卵", q(2, "piece")],
    ])
  })

  it("数量不明の在庫だけで作れる料理は「分量要確認」の枠へ入れ、理由を返す（C-27）", () => {
    const result = suggestNow(input([stock("salmon")], { limit: 50 }))
    expect(ids(result.ready)).toEqual([])
    const salmon = result.check.find((s) => s.recipe.id === "salmon_grill")
    expect(salmon?.match.toCheck.map((c) => [c.name, c.reasons])).toEqual([["鮭", ["quantity_unknown"]]])
  })

  it("主食（ご飯）は既定の対象に含めない。区分を指定すれば含められる", () => {
    const pantry = [stock("rice", { quantity: q(4, "bowl") })]
    expect(ids(suggestNow(input(pantry)).ready)).toEqual([])
    expect(ids(suggestNow(input(pantry, { roles: ["staple"] })).ready)).toEqual(["rice_plain"])
  })
})

describe("順位: 早く使いたい・期限が近い食材、好み、時間", () => {
  it("「早く使いたい」食材を使う料理が先頭に来る", () => {
    const pantry = richPantry().map((item) => (item.id === "tofu" ? { ...item, useSoon: true } : item))
    const result = suggestNow(input(pantry))
    expect(result.ready[0].recipe.id).toBe("tofu_steak")
    expect(result.ready[0].score.useSoon).toBeGreaterThan(0)
  })

  it("期限が近い食材を使う料理を上げる", () => {
    const pantry = richPantry().map((item) => (item.id === "salmon" ? { ...item, expiresOn: "2026-11-12" } : item))
    const result = suggestNow(input(pantry))
    expect(result.ready[0].recipe.id).toBe("salmon_grill")
    expect(result.ready[0].score.expiring).toBeGreaterThan(0)
  })

  it("旧欠陥 (a) の回帰: 期限超過の食材には加点せず、材料にも数えない", () => {
    const pantry = richPantry().map((item) => (item.id === "salmon" ? { ...item, expiresOn: "2026-11-09" } : item))
    const result = suggestNow(input(pantry, { limit: 50 }))
    expect(ids(result.ready)).not.toContain("salmon_grill")
    const salmon = result.buy.find((s) => s.recipe.id === "salmon_grill")
    expect(salmon?.score.expiring).toBe(0)
    expect(salmon?.match.missing[0]).toMatchObject({ ingredientId: "salmon", reasons: ["expired"] })
  })

  it("C-74: 保存済みの評価の有無で順位が変わる（実記録に基づく理由を返す）", () => {
    const base = suggestNow(input(richPantry(), { limit: 50 }))
    const before = ids(base.ready).indexOf("chicken_teriyaki")
    const feedback: DishFeedback[] = [
      { id: "f1", profileId: "papa", recipeId: "chicken_teriyaki", eatenOn: "2026-11-01", taste: 3, effort: 3, again: true, excludeFromLearning: false },
    ]
    const after = suggestNow(input(richPantry(), { limit: 50, feedback }))
    expect(after.ready[0].recipe.id).toBe("chicken_teriyaki")
    expect(before).toBeGreaterThan(0)
    expect(after.ready[0].preferenceReasons.map((r) => r.kind)).toEqual(["taste", "effort", "again"])
    // 評価の無い料理に「前回好評」の理由は付かない
    expect(after.ready[1].preferenceReasons).toEqual([])
  })

  it("時間の希望を超える料理は順位を下げる", () => {
    const result = suggestNow(input(richPantry(), { maxMinutes: 15, limit: 50 }))
    const scores = new Map(result.ready.map((s) => [s.recipe.id, s.score.time]))
    expect(scores.get("chicken_teriyaki")).toBeLessThan(0)
    expect(scores.get("pork_ginger")).toBeGreaterThan(0)
  })

  it("同じ入力からは同じ結果", () => {
    expect(suggestNow(input(richPantry()))).toEqual(suggestNow(input(richPantry())))
  })
})

describe("C-24 ready が 0 件でも黙って緩めない", () => {
  it("在庫が空: 0 件であることと、別枠の買い足し候補・ヒントを返す", () => {
    const result = suggestNow(input([]))
    expect(result.ready).toEqual([])
    expect(result.readyTotal).toBe(0)
    expect(result.check).toEqual([])
    expect(result.buy).toHaveLength(3)
    expect(result.hints).toEqual(["pantry_empty"])
  })

  it("ready が 0 件のとき、check や buy の候補を ready に昇格させない", () => {
    const result = suggestNow(input([stock("salmon"), stock("pork", { quantity: q(50, "g") })], { limit: 50 }))
    expect(result.ready).toEqual([])
    expect(result.checkTotal).toBeGreaterThan(0)
    expect(result.buyTotal).toBeGreaterThan(0)
    expect(result.hints).toContain("quantity_unknown")
  })

  it("入力見直しのヒント: 名前を解決できていない在庫・期限超過・使い切り・古い確認日", () => {
    const result = suggestNow(
      input([
        stock(null, { name: "なぞの肉" }),
        stock("pork", { quantity: q(300, "g"), expiresOn: "2026-11-01" }),
        stock("onion", { status: "out" }),
        stock("tofu", { quantity: q(0.25, "block"), confirmedOn: "2026-09-01" }),
      ]),
    )
    expect(result.ready).toEqual([])
    expect(result.hints).toEqual(["unresolved_items", "stale_items", "expired_items", "used_up_items"])
  })

  it("対照: ready があるときはヒントを出さない", () => {
    expect(suggestNow(input(richPantry())).hints).toEqual([])
  })

  it("カタログが空（候補ゼロ）でも落ちずに 0 件を返す", () => {
    const result = suggestNow(input(richPantry(), { catalog: { ingredients: [], recipes: [] } }))
    expect(result).toMatchObject({ ready: [], check: [], buy: [], readyTotal: 0, hints: ["no_recipes"] })
  })
})

describe("C-53 在庫提案でも世帯の除外を守る", () => {
  it("除外に当たる料理は、在庫が揃っていてもどの枠にも出さない", () => {
    const exclusions = [exclusion("x1", "dislike", { kind: "ingredient", ingredientId: "pork" })]
    const result = suggestNow(input(richPantry(), { exclusions, limit: 50 }))
    const all = [...ids(result.ready), ...ids(result.check), ...ids(result.buy)]
    expect(all).not.toContain("pork_ginger")
    expect(all).not.toContain("pork_belly_cabbage")
    expect(all).not.toContain("bacon_cabbage")
    expect(result.excludedCount).toBeGreaterThanOrEqual(4)
    const set = buildExclusionSet(exclusions, CATALOG)
    for (const s of [...result.ready, ...result.check, ...result.buy]) {
      expect(evaluateRecipe(s.recipe, set).allowed).toBe(true)
    }
  })

  it("アレルギーの除外があると、成分を確かめられない料理は候補にせず別枠で返す", () => {
    const exclusions = [exclusion("x1", "allergy", { kind: "allergen", allergenId: "shrimp" })]
    const result = suggestNow(input(richPantry(), { exclusions, limit: 50 }))
    expect(result.labelCheck.map((l) => l.recipe.id)).toEqual(["pork_curry"])
    const all = [...ids(result.ready), ...ids(result.check), ...ids(result.buy)]
    expect(all).not.toContain("pork_curry")
    expect(all).not.toContain("shrimp_egg")
  })

  it("全ての候補が除外に当たるとき: 除外を破らず 0 件とヒントを返す", () => {
    const exclusions = [
      exclusion("x1", "allergy", { kind: "allergen", allergenId: "soybean" }),
      exclusion("x2", "allergy", { kind: "allergen", allergenId: "pork" }),
      exclusion("x3", "allergy", { kind: "allergen", allergenId: "egg" }),
      exclusion("x4", "dislike", { kind: "ingredient", ingredientId: "salt" }),
      exclusion("x5", "dislike", { kind: "ingredient", ingredientId: "oil" }),
      exclusion("x6", "dislike", { kind: "ingredient", ingredientId: "honey" }),
    ]
    const result = suggestNow(input(richPantry(), { exclusions, limit: 50 }))
    expect(result.ready).toEqual([])
    expect(result.check).toEqual([])
    expect(result.buy).toEqual([])
    expect(result.hints).toContain("all_excluded")
  })
})

describe("C-25 未登録の調味料", () => {
  it("常備品の設定が無い世帯では、調味料を要する料理は「揃う」に入らない", () => {
    const result = suggestNow(input(richPantry(), { stapleIngredientIds: [], limit: 50 }))
    expect(ids(result.ready)).toEqual([])
    const ginger = result.buy.find((s) => s.recipe.id === "pork_ginger")
    expect(ginger?.match.missing.map((m) => m.ingredientId)).toEqual(["soy_sauce", "oil"])
  })
})
