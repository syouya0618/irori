import { describe, expect, it } from "vitest"

import {
  buildExclusionSet,
  evaluateDish,
  evaluateRecipe,
  findPlanConflicts,
  partitionRecipes,
} from "../exclusions"
import { toCatalogView } from "../lookup"
import type { FoodExclusion, RecipeDef } from "../types"
import { CATALOG, exclusion, ing, INGREDIENTS, planEntry, recipeById, RECIPES } from "./fixtures"

function evaluate(recipeId: string, exclusions: FoodExclusion[]) {
  return evaluateRecipe(recipeById(recipeId), buildExclusionSet(exclusions, CATALOG))
}

const EGG_ALLERGY = exclusion("x-egg", "allergy", { kind: "allergen", allergenId: "egg" })
const PORK_DISLIKE = exclusion("x-pork", "dislike", { kind: "ingredient", ingredientId: "pork" })

describe("除外なし", () => {
  it("何も登録していなければ、全ての料理が通る（確認不要）", () => {
    const set = buildExclusionSet([], CATALOG)
    expect(set.isEmpty).toBe(true)
    for (const recipe of RECIPES) {
      expect(evaluateRecipe(recipe, set)).toEqual({
        allowed: true,
        verdict: "ok",
        blockedBy: [],
        needsLabelCheck: false,
        unverifiable: [],
      })
    }
  })
})

describe("C-54 アレルゲンは構造化情報で判定する（派生食材・調味料を含む）", () => {
  it("卵アレルギー: 卵を直接使う料理を除外する", () => {
    const result = evaluate("egg_roll", [EGG_ALLERGY])
    expect(result.allowed).toBe(false)
    expect(result.verdict).toBe("blocked")
    expect(result.blockedBy).toContainEqual({
      exclusionId: "x-egg",
      reason: "allergy",
      ingredientId: "egg",
      via: "allergen",
    })
  })

  it("卵アレルギー: マヨネーズ（卵の派生・調味料）を使う料理も除外する", () => {
    const result = evaluate("potato_salad", [EGG_ALLERGY])
    expect(result.verdict).toBe("blocked")
    expect(result.blockedBy.map((hit) => hit.ingredientId)).toEqual(["mayonnaise"])
  })

  it("対照: 卵を含まない料理は通る", () => {
    expect(evaluate("salmon_grill", [EGG_ALLERGY]).allowed).toBe(true)
  })

  it("由来の食材が持つアレルゲンも引き継ぐ（辞書の本人に書き漏れがあっても）", () => {
    const view = toCatalogView({
      ingredients: [
        ...INGREDIENTS,
        // allergens を書き漏らした加工品。由来（牛乳）から乳を引き継ぐ
        { id: "cream", name: "生クリーム", aliases: [], section: "egg_dairy", allergens: [], allergenInfo: "known", derivedFrom: ["milk"] },
      ],
      recipes: [],
    })
    const set = buildExclusionSet([exclusion("x-milk", "allergy", { kind: "allergen", allergenId: "milk" })], view)
    const result = evaluateDish(
      { title: "クリーム煮", ingredients: [ing("cream", 100, "ml")], allergenStatus: "from_ingredients" },
      set,
    )
    expect(result.blockedBy).toEqual([
      { exclusionId: "x-milk", reason: "allergy", ingredientId: "cream", via: "allergen" },
    ])
  })

  it("小麦アレルギー: しょうゆ（小麦を含む調味料）を使う料理を除外する", () => {
    const wheat = exclusion("x-wheat", "allergy", { kind: "allergen", allergenId: "wheat" })
    expect(evaluate("spinach_ohitashi", [wheat]).verdict).toBe("blocked")
    expect(evaluate("salmon_grill", [wheat]).verdict).toBe("ok")
  })
})

describe("C-54 成分を確かめられない料理は、アレルギーの除外があれば自動確定しない", () => {
  it("原材料が商品により異なる材料（カレールウ）を含む料理は「原材料の確認が必要」", () => {
    const result = evaluate("pork_curry", [EGG_ALLERGY])
    expect(result.allowed).toBe(false)
    expect(result.verdict).toBe("label_check")
    expect(result.needsLabelCheck).toBe(true)
    expect(result.blockedBy).toEqual([])
    expect(result.unverifiable).toEqual([{ reason: "varies_ingredient", ingredientId: "curry_roux" }])
  })

  it("対照: アレルギーの除外が無ければ（苦手だけなら）、同じ料理は確認不要で通る", () => {
    const result = evaluate("pork_curry", [exclusion("x-tomato", "dislike", { kind: "ingredient", ingredientId: "tomato" })])
    expect(result.allowed).toBe(true)
    expect(result.needsLabelCheck).toBe(false)
  })

  it("アレルゲン情報が未確認のレシピは自動確定しない", () => {
    const unconfirmed: RecipeDef = { ...recipeById("salmon_grill"), id: "mystery", allergenStatus: "unconfirmed" }
    const set = buildExclusionSet([EGG_ALLERGY], CATALOG)
    const result = evaluateRecipe(unconfirmed, set)
    expect(result.verdict).toBe("label_check")
    expect(result.unverifiable).toEqual([{ reason: "allergen_unconfirmed", ingredientId: null }])
    // 対照: 確認済みなら通る
    expect(evaluateRecipe(recipeById("salmon_grill"), set).verdict).toBe("ok")
  })

  it("辞書に無い材料を「不使用」と見なさない", () => {
    const set = buildExclusionSet([EGG_ALLERGY], CATALOG)
    const result = evaluateDish(
      { title: "謎の炒め物", ingredients: [ing("unknown_sauce", 1, "tbsp")], allergenStatus: "from_ingredients" },
      set,
    )
    expect(result.verdict).toBe("label_check")
    expect(result.unverifiable).toEqual([{ reason: "unknown_ingredient", ingredientId: "unknown_sauce" }])
  })

  it("材料が未登録の手動料理は自動確定しない", () => {
    const set = buildExclusionSet([EGG_ALLERGY], CATALOG)
    const result = evaluateDish({ title: "外で買うお惣菜", ingredients: null, allergenStatus: "from_ingredients" }, set)
    expect(result.verdict).toBe("label_check")
    expect(result.unverifiable).toEqual([{ reason: "no_ingredients", ingredientId: null }])
  })

  it("除外に当たる料理は、確認待ちではなく除外として返す（除外が優先）", () => {
    const pork = exclusion("x-pork-allergy", "allergy", { kind: "allergen", allergenId: "pork" })
    const result = evaluate("pork_curry", [pork])
    expect(result.verdict).toBe("blocked")
    expect(result.needsLabelCheck).toBe(true)
  })
})

describe("C-52 苦手として登録したものも必須除外", () => {
  it("豚肉が苦手: 豚肉を使う料理を除外する（点数ではなく除外）", () => {
    const result = evaluate("pork_ginger", [PORK_DISLIKE])
    expect(result.allowed).toBe(false)
    expect(result.blockedBy).toEqual([
      { exclusionId: "x-pork", reason: "dislike", ingredientId: "pork", via: "ingredient" },
    ])
  })

  it("食材の除外は派生食材へ及ぶ（豚肉 → 豚バラ・ベーコン）", () => {
    expect(evaluate("pork_belly_cabbage", [PORK_DISLIKE]).blockedBy).toEqual([
      { exclusionId: "x-pork", reason: "dislike", ingredientId: "pork_belly", via: "derived" },
    ])
    expect(evaluate("bacon_cabbage", [PORK_DISLIKE]).verdict).toBe("blocked")
  })

  it("対照: 派生の向きは一方向（豚バラが苦手でも豚肉そのものは除外しない）", () => {
    const belly = exclusion("x-belly", "dislike", { kind: "ingredient", ingredientId: "pork_belly" })
    expect(evaluate("pork_belly_cabbage", [belly]).verdict).toBe("blocked")
    expect(evaluate("pork_ginger", [belly]).verdict).toBe("ok")
  })

  it("任意材料に含まれる場合も除外する", () => {
    const carrot = exclusion("x-carrot", "dislike", { kind: "ingredient", ingredientId: "carrot" })
    // ポテトサラダのにんじんは任意材料
    expect(evaluate("potato_salad", [carrot]).verdict).toBe("blocked")
    const negi = exclusion("x-negi", "dislike", { kind: "ingredient", ingredientId: "negi" })
    expect(evaluate("hiyayakko", [negi]).verdict).toBe("blocked")
  })

  it("素の食材をアレルギーとして登録したら、そのアレルゲンを含む加工品にも及ぶ（牛乳 → バター）", () => {
    const milkIngredient = exclusion("x-milk-ing", "allergy", { kind: "ingredient", ingredientId: "milk" })
    const set = buildExclusionSet([milkIngredient], CATALOG)
    const dish = { title: "バター炒め", ingredients: [ing("butter", 10, "g")], allergenStatus: "from_ingredients" as const }
    const vias = evaluateDish(dish, set).blockedBy.map((hit) => hit.via).sort()
    expect(vias).toEqual(["allergen", "derived"])
  })
})

describe("C-53 世帯の除外の和集合", () => {
  const father = exclusion("x-father", "allergy", { kind: "allergen", allergenId: "shrimp" }, { kind: "member", profileId: "father" })
  const child = exclusion("x-child", "dislike", { kind: "ingredient", ingredientId: "tomato" }, { kind: "child", childId: "kid" })

  it("2 人の異なる除外を両方とも守る（誰の除外かで絞らない）", () => {
    const set = buildExclusionSet([father, child], CATALOG)
    expect(evaluateRecipe(recipeById("shrimp_egg"), set).blockedBy.map((h) => h.exclusionId)).toEqual(["x-father"])
    expect(evaluateRecipe(recipeById("tomato_salad"), set).blockedBy.map((h) => h.exclusionId)).toEqual(["x-child"])
    expect(evaluateRecipe(recipeById("salmon_grill"), set).allowed).toBe(true)
  })

  it("除外の順序を入れ替えても結果は同じ", () => {
    const a = partitionRecipes(RECIPES, buildExclusionSet([father, child], CATALOG))
    const b = partitionRecipes(RECIPES, buildExclusionSet([child, father], CATALOG))
    expect(a.allowed.map((r) => r.id)).toEqual(b.allowed.map((r) => r.id))
    expect(a.blocked.map((r) => r.id)).toEqual(b.blocked.map((r) => r.id))
  })

  it("対照: 片方だけ登録した世帯では、もう片方の料理は通る", () => {
    const set = buildExclusionSet([father], CATALOG)
    expect(evaluateRecipe(recipeById("tomato_salad"), set).allowed).toBe(true)
  })
})

describe("自由入力の除外", () => {
  it("アレルゲン名に一致すれば、アレルゲンとして判定する（限界の印は付けない）", () => {
    const set = buildExclusionSet([exclusion("c1", "allergy", { kind: "custom", label: "エビ" })], CATALOG)
    expect(set.limited).toEqual([])
    expect(evaluateRecipe(recipeById("shrimp_egg"), set).blockedBy).toContainEqual({
      exclusionId: "c1",
      reason: "allergy",
      ingredientId: "shrimp",
      via: "allergen",
    })
  })

  it("かっこ付きの公式名称の片方（ピーナッツ）でも解決する", () => {
    const set = buildExclusionSet([exclusion("c2", "allergy", { kind: "custom", label: "ピーナッツ" })], CATALOG)
    expect(set.limited).toEqual([])
    expect(set.allergenRules.map((rule) => rule.allergenId)).toEqual(["peanut"])
  })

  it("食材名に一致すれば、食材として判定する", () => {
    const set = buildExclusionSet([exclusion("c3", "dislike", { kind: "custom", label: "にんじん" })], CATALOG)
    expect(set.limited).toEqual([])
    expect(evaluateRecipe(recipeById("carrot_kinpira"), set).blockedBy).toEqual([
      { exclusionId: "c3", reason: "dislike", ingredientId: "carrot", via: "ingredient" },
    ])
  })

  it("辞書へ解決できなければ名前の一致で除外し、判定に限界がある旨を返す", () => {
    const set = buildExclusionSet([exclusion("c4", "dislike", { kind: "custom", label: "キャベ" })], CATALOG)
    expect(set.limited).toEqual([{ exclusionId: "c4", label: "キャベ" }])
    // 除外は広く倒す側が安全なので、名前に含むものを除外する（材料名と料理名の両方に照らす）
    expect(evaluateRecipe(recipeById("cabbage_salad"), set).blockedBy).toEqual([
      { exclusionId: "c4", reason: "dislike", ingredientId: "cabbage", via: "name" },
      { exclusionId: "c4", reason: "dislike", ingredientId: null, via: "name" },
    ])
    // 料理名に語が無くても、材料名に含めば除外する
    expect(evaluateRecipe(recipeById("pork_belly_cabbage"), set).blockedBy).toContainEqual({
      exclusionId: "c4",
      reason: "dislike",
      ingredientId: "cabbage",
      via: "name",
    })
    // 対照: 名前に含まない料理は通る
    expect(evaluateRecipe(recipeById("salmon_grill"), set).allowed).toBe(true)
  })

  it("解決できない語は、料理名にも照らす", () => {
    const set = buildExclusionSet([exclusion("c5", "dislike", { kind: "custom", label: "きんぴら" })], CATALOG)
    expect(evaluateRecipe(recipeById("carrot_kinpira"), set).blockedBy).toEqual([
      { exclusionId: "c5", reason: "dislike", ingredientId: null, via: "name" },
    ])
  })

  it("材料の無い手動料理は、登録した品目の名前を料理名に照らして除外する", () => {
    const set = buildExclusionSet([EGG_ALLERGY], CATALOG)
    const result = evaluateDish({ title: "たまごサンド", ingredients: null, allergenStatus: "from_ingredients" }, set)
    expect(result.verdict).toBe("blocked")
    expect(result.blockedBy.every((hit) => hit.via === "name")).toBe(true)
  })
})

describe("C-55 設定変更後の既存予定・固定枠との衝突（findPlanConflicts）", () => {
  const entries = [
    planEntry({ id: "e1", date: "2026-11-12", recipeId: "pork_ginger", pinned: true }),
    planEntry({ id: "e2", date: "2026-11-13", recipeId: "salmon_grill", status: "proposed" }),
    planEntry({ id: "e3", date: "2026-11-14", recipeId: "pork_curry" }),
    planEntry({ id: "e4", date: "2026-11-10", recipeId: "pork_belly_cabbage", status: "cooked" }),
    planEntry({ id: "e5", date: "2026-11-15", customTitle: "豚しゃぶ", status: "confirmed" }),
    planEntry({ id: "e6", date: "2026-11-16", recipeId: "pork_ginger", status: "skipped" }),
  ]

  it("除外が無ければ衝突は無い", () => {
    expect(findPlanConflicts(entries, buildExclusionSet([], CATALOG))).toEqual([])
  })

  it("固定枠でも新しい除外を無視しない。置換はせず一覧で返す", () => {
    const conflicts = findPlanConflicts(entries, buildExclusionSet([PORK_DISLIKE], CATALOG))
    expect(conflicts.map((c) => [c.entryId, c.verdict, c.pinned])).toEqual([
      ["e1", "blocked", true],
      ["e3", "blocked", false],
      // 材料が未登録の手動料理（豚しゃぶ）は、苦手だけの世帯でも「含まない」と言えない = 未確認（2026-11-11 ⑤）
      ["e5", "label_check", false],
    ])
    // 入力の枠は変えていない
    expect(entries[0].recipeId).toBe("pork_ginger")
  })

  it("作り終えた枠・作らなかった枠は対象にしない", () => {
    const conflicts = findPlanConflicts(entries, buildExclusionSet([PORK_DISLIKE], CATALOG))
    expect(conflicts.some((c) => c.entryId === "e4" || c.entryId === "e6")).toBe(false)
  })

  it("アレルギーを登録すると、成分を確かめられない枠（手動料理・ルウ）も見えるようにする", () => {
    const pork = exclusion("x-pork-allergy", "allergy", { kind: "allergen", allergenId: "pork" })
    const conflicts = findPlanConflicts(entries, buildExclusionSet([pork], CATALOG))
    const byId = new Map(conflicts.map((c) => [c.entryId, c]))
    expect(byId.get("e1")?.verdict).toBe("blocked")
    expect(byId.get("e3")?.verdict).toBe("blocked")
    // 「豚しゃぶ」は材料未登録だが、料理名に「豚」を含む別名は無い → 名前では当たらず、確認待ちになる
    expect(byId.get("e5")?.verdict).toBe("label_check")
    expect(byId.has("e2")).toBe(false)
  })

  it("カタログに無いレシピの枠は確かめられない（除外が 1 件でもあれば見えるようにする）", () => {
    const orphan = [planEntry({ id: "o1", date: "2026-11-12", recipeId: "removed_recipe" })]
    const conflicts = findPlanConflicts(orphan, buildExclusionSet([PORK_DISLIKE], CATALOG))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].unverifiable).toEqual([{ reason: "unknown_recipe", ingredientId: null }])
    // 対照: 除外が無ければ衝突にしない
    expect(findPlanConflicts(orphan, buildExclusionSet([], CATALOG))).toEqual([])
  })
})
