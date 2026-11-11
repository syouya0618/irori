/**
 * 独立レビュー R01 / R02 / R23 / R25 の回帰テスト（**実カタログ**）。
 *
 * - R01: 総称・類義の自由入力（乳製品・甲殻類・魚 …）を辞書へ解決する。どこにも当たらない
 *   アレルギーの自由入力は「不使用」と見なさず、全ての料理を自動確定の候補から外す。
 * - R02: 手動料理は、材料を登録しても料理名の照合を外さない。
 * - R23: 加工品（そば・ルウ・サラダ油）のアレルギー登録を、他のアレルゲンへ広げない。
 * - R25: 片栗粉 ← じゃがいも は苦手には及ぼさない。ミニトマト ← トマト は及ぼす。
 *
 * 「そのアレルゲンを含むか」の真値は、判定の実装を使わずこのファイルの `lineage` で求める。
 */

import { describe, expect, it } from "vitest"

import { ALLERGENS, INGREDIENTS, RECIPES } from "@/lib/meals/catalog"
import {
  buildExclusionSet,
  evaluateEntry,
  evaluateRecipe,
  findPlanConflicts,
  partitionRecipes,
  resolveExclusionLabel,
} from "@/lib/meals/exclusions"
import { toCatalogView } from "@/lib/meals/lookup"
import { checkPlanAdoption, generatePlan, type PlanInput } from "@/lib/meals/planner"
import { suggestNow } from "@/lib/meals/suggest-now"
import type {
  ExclusionReason,
  FoodExclusion,
  IngredientDef,
  PlanEntry,
  RecipeDef,
  RecipeIngredient,
} from "@/lib/meals/types"

const CATALOG = toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })
const MONDAY = "2026-11-16"

const DEF: ReadonlyMap<string, IngredientDef> = new Map(INGREDIENTS.map((i) => [i.id, i]))

/** 自分と、`derivedFrom` を推移的にたどった由来の食材（判定の実装とは独立）。 */
function lineage(ingredientId: string): IngredientDef[] {
  const out: IngredientDef[] = []
  const seen = new Set<string>()
  const stack = [ingredientId]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (seen.has(current)) continue
    seen.add(current)
    const def = DEF.get(current)
    if (!def) throw new Error(`ingredient not in dictionary: ${current}`)
    out.push(def)
    stack.push(...(def.derivedFrom ?? []))
  }
  return out
}

function allergensOf(recipe: RecipeDef): Set<string> {
  return new Set(recipe.ingredients.flatMap((i) => lineage(i.ingredientId).flatMap((d) => [...d.allergens])))
}

function uses(recipe: RecipeDef, predicate: (def: IngredientDef) => boolean): boolean {
  return recipe.ingredients.some((i) => lineage(i.ingredientId).some(predicate))
}

function usesDirectly(recipe: RecipeDef, ingredientId: string): boolean {
  return recipe.ingredients.some((i) => i.ingredientId === ingredientId)
}

function custom(label: string, reason: ExclusionReason = "allergy", id = `c-${label}`): FoodExclusion {
  return { id, reason, target: { kind: "custom", label }, subject: { kind: "household" } }
}

function allergen(allergenId: string): FoodExclusion {
  return { id: `a-${allergenId}`, reason: "allergy", target: { kind: "allergen", allergenId }, subject: { kind: "household" } }
}

function ingredient(ingredientId: string, reason: ExclusionReason): FoodExclusion {
  return { id: `i-${ingredientId}`, reason, target: { kind: "ingredient", ingredientId }, subject: { kind: "household" } }
}

function partition(exclusions: FoodExclusion[]) {
  return partitionRecipes(RECIPES, buildExclusionSet(exclusions, CATALOG))
}

function ids(recipes: readonly RecipeDef[]): string[] {
  return recipes.map((r) => r.id).sort()
}

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    startDate: MONDAY,
    days: 7,
    servings: 2,
    today: MONDAY,
    existingEntries: [],
    pantry: [],
    exclusions: [],
    stapleIngredientIds: [],
    catalog: CATALOG,
    ...overrides,
  }
}

function ing(ingredientId: string): RecipeIngredient {
  return { ingredientId, quantity: { amount: 1, unit: "piece" } }
}

function manualEntry(title: string, ingredients: RecipeIngredient[] | null, id = `m-${title}`): PlanEntry {
  return {
    id,
    date: MONDAY,
    role: "main",
    position: 0,
    recipeId: null,
    recipeVersion: null,
    customTitle: title,
    customIngredients: ingredients,
    servings: 2,
    pinned: false,
    status: "confirmed",
    origin: "manual",
  }
}

const BASELINE = partition([])

// ── R01 ────────────────────────────────────────────────────────────

describe("R01 総称・類義の自由入力をアレルゲンへ解決する（アレルギー）", () => {
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ["乳製品", ["milk"]],
    ["乳成分", ["milk"]],
    ["甲殻類", ["shrimp", "crab"]],
    ["えび・かに", ["shrimp", "crab"]],
    ["エビ・カニ", ["shrimp", "crab"]],
    ["蟹", ["crab"]],
    ["卵白", ["egg"]],
    ["生卵", ["egg"]],
    ["小麦製品", ["wheat"]],
    ["グルテン", ["wheat"]],
    ["大豆製品", ["soybean"]],
    ["サーモン", ["salmon"]],
    ["山芋", ["yam"]],
    ["ナッツ", ["walnut", "cashew", "almond", "pistachio", "macadamia", "peanut"]],
    ["ナッツ類", ["walnut", "cashew", "almond", "pistachio", "macadamia", "peanut"]],
    ["木の実", ["walnut", "cashew", "almond", "pistachio", "macadamia"]],
    // 辞書に無い複合語は、入力が品目名を含むことで解決する
    ["卵料理", ["egg"]],
    ["乳飲料", ["milk"]],
  ]

  it.each(cases)("「%s」: 該当アレルゲンを含むレシピは 1 つも自動確定の候補に残らない", (label, allergenIds) => {
    const set = buildExclusionSet([custom(label)], CATALOG)
    const result = partitionRecipes(RECIPES, set)
    const leaked = result.allowed.filter((recipe) => allergenIds.some((id) => allergensOf(recipe).has(id)))
    expect(leaked.map((r) => r.title)).toEqual([])
    // 規則として入っている（カタログに該当レシピが無いアレルゲンでも、手動料理・将来のレシピに効く）
    const ruled = new Set(set.allergenRules.map((rule) => rule.allergenId))
    for (const id of allergenIds) expect(ruled.has(id), `${label} → ${id}`).toBe(true)
    // 判定できている（全料理を止める扱いにはしない）
    expect(set.undetermined).toEqual([])
    expect(set.holdsAutoConfirm).toBe(false)
  })

  it("対照: カタログに該当レシピがあるアレルゲンでは、実際に除外が増える（検査が空振りしていない）", () => {
    for (const [label, allergenId] of [["乳製品", "milk"], ["甲殻類", "shrimp"], ["卵白", "egg"], ["小麦製品", "wheat"], ["大豆製品", "soybean"], ["サーモン", "salmon"]] as const) {
      const truth = RECIPES.filter((recipe) => allergensOf(recipe).has(allergenId))
      expect(truth.length, label).toBeGreaterThan(0)
      const result = partition([custom(label)])
      expect(ids(result.blocked), label).toEqual(ids(truth))
      // 一覧から選んだときと同じ結果
      expect(ids(result.blocked), label).toEqual(ids(partition([allergen(allergenId)]).blocked))
    }
  })

  it("「乳製品」アレルギーの 7 日献立に、乳を含む料理が入らない（レビューの再現: たらのムニエル）", () => {
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = generatePlan(planInput({ exclusions: [custom("乳製品")], options: { includeSoup: true, seed } }))
      const withMilk = plan.entries.filter((entry) => {
        const recipe = RECIPES.find((r) => r.id === entry.recipeId)
        return recipe !== undefined && allergensOf(recipe).has("milk")
      })
      expect(withMilk.map((e) => e.title)).toEqual([])
      expect(plan.entries.length).toBeGreaterThan(0)
    }
  })

  it("「魚」「魚介類」（アレルギー・苦手とも）: 魚売場の食材を使う料理が候補に残らない", () => {
    const shellfish = new Set(["shrimp", "squid", "asari"])
    for (const reason of ["allergy", "dislike"] as const) {
      const fish = partition([custom("魚", reason)])
      const fishLeak = [...fish.allowed, ...fish.labelCheck].filter((recipe) =>
        uses(recipe, (def) => def.section === "fish" && !shellfish.has(def.id)),
      )
      expect(fishLeak.map((r) => r.title), `魚 ${reason}`).toEqual([])
      expect(fish.blocked.length, `魚 ${reason}`).toBeGreaterThan(0)

      for (const label of ["魚介類", "魚介", "シーフード"]) {
        const seafood = partition([custom(label, reason)])
        const leak = [...seafood.allowed, ...seafood.labelCheck].filter((recipe) => uses(recipe, (def) => def.section === "fish"))
        expect(leak.map((r) => r.title), `${label} ${reason}`).toEqual([])
      }
    }
    // えびの料理は「魚介類」で外れる
    const shrimpDish = RECIPES.find((r) => usesDirectly(r, "shrimp")) as RecipeDef
    expect(evaluateRecipe(shrimpDish, buildExclusionSet([custom("魚介類")], CATALOG)).verdict).toBe("blocked")
  })

  it("「ひき肉」「肉」（苦手）: 合いびき肉のハンバーグも外れる", () => {
    const hamburg = RECIPES.find((r) => usesDirectly(r, "ground_mixed")) as RecipeDef
    expect(hamburg).toBeDefined()
    for (const label of ["ひき肉", "挽き肉", "ミンチ", "肉"]) {
      const set = buildExclusionSet([custom(label, "dislike")], CATALOG)
      expect(evaluateRecipe(hamburg, set).verdict, label).toBe("blocked")
      expect(set.undetermined, label).toEqual([])
    }
    const meat = partition([custom("肉", "dislike")])
    expect([...meat.allowed, ...meat.labelCheck].filter((r) => uses(r, (def) => def.section === "meat"))).toEqual([])
    // 対照: 肉を使わない料理は残る
    expect(meat.allowed.length).toBeGreaterThan(0)
  })
})

describe("R01 どこにも当たらないアレルギーの自由入力は「不使用」と見なさない（fail-closed）", () => {
  const MANGO = custom("マンゴー")

  it("全てのレシピを自動確定の候補から外し、原材料の確認が必要な枠へ回す", () => {
    const set = buildExclusionSet([MANGO], CATALOG)
    expect(set.undetermined).toEqual([{ exclusionId: MANGO.id, label: "マンゴー", reason: "allergy" }])
    expect(set.holdsAutoConfirm).toBe(true)
    const result = partitionRecipes(RECIPES, set)
    expect(result.allowed).toEqual([])
    expect(result.blocked).toEqual([])
    expect(result.labelCheck).toHaveLength(RECIPES.length)
    for (const recipe of RECIPES.slice(0, 5)) {
      expect(evaluateRecipe(recipe, set)).toMatchObject({ allowed: false, verdict: "label_check", needsLabelCheck: true })
    }
  })

  it("自動献立・在庫提案・提案の採用のどれも、自動では確定しない", () => {
    const plan = generatePlan(planInput({ exclusions: [MANGO], days: 3 }))
    expect(plan.entries).toEqual([])
    expect(plan.gaps.length).toBeGreaterThan(0)
    expect(new Set(plan.gaps.map((gap) => gap.reason))).toEqual(new Set(["needs_label_check"]))

    const now = suggestNow({ today: MONDAY, servings: 2, pantry: [], exclusions: [MANGO], catalog: CATALOG })
    expect([now.readyTotal, now.checkTotal, now.buyTotal]).toEqual([0, 0, 0])
    expect(now.labelCheck.length).toBeGreaterThan(0)

    const adoption = checkPlanAdoption({
      baseRevision: 1,
      currentRevision: 1,
      startDate: MONDAY,
      days: 1,
      proposed: [{ date: MONDAY, role: "main", recipeId: "salmon_shioyaki" }],
      currentEntries: [],
      exclusions: [MANGO],
      catalog: CATALOG,
    })
    expect(adoption).toEqual({
      ok: false,
      problems: [{ problem: "needs_label_check", date: MONDAY, recipeId: "salmon_shioyaki" }],
    })
  })

  it("記号だけの入力・一覧に無い ID のアレルギーも、何も外さずに通しはしない", () => {
    for (const exclusions of [
      [custom("・")],
      [allergen("future_allergen_not_in_list")],
      [ingredient("removed_ingredient", "allergy")],
    ]) {
      const set = buildExclusionSet(exclusions, CATALOG)
      expect(set.holdsAutoConfirm, JSON.stringify(exclusions[0].target)).toBe(true)
      expect(partitionRecipes(RECIPES, set).allowed).toEqual([])
    }
  })

  it("対照: 一覧にあるアレルゲンは、該当レシピがカタログに無くても全体を止めない（カシューナッツ）", () => {
    const set = buildExclusionSet([allergen("cashew")], CATALOG)
    expect(set.holdsAutoConfirm).toBe(false)
    expect(partitionRecipes(RECIPES, set).allowed.length).toBeGreaterThan(0)
  })

  it("対照: 苦手の「判定できない」は献立を止めず、除外されないことを結果で返す", () => {
    const dislike = custom("マンゴー", "dislike")
    const set = buildExclusionSet([dislike], CATALOG)
    expect(set.undetermined).toEqual([{ exclusionId: dislike.id, label: "マンゴー", reason: "dislike" }])
    expect(set.holdsAutoConfirm).toBe(false)
    const result = partitionRecipes(RECIPES, set)
    expect(ids(result.allowed)).toEqual(ids(BASELINE.allowed))
    expect(result.blocked).toEqual([])
  })

  it("対照: 名前の一致で当たる自由入力（キャベ）は、従来どおりその料理だけを外す", () => {
    const set = buildExclusionSet([custom("キャベ")], CATALOG)
    expect(set.undetermined).toEqual([])
    expect(set.holdsAutoConfirm).toBe(false)
    expect(set.limited).toEqual([{ exclusionId: "c-キャベ", label: "キャベ" }])
    const result = partitionRecipes(RECIPES, set)
    expect(result.blocked.length).toBeGreaterThan(0)
    expect(result.blocked.every((recipe) => usesDirectly(recipe, "cabbage") || recipe.title.includes("キャベ"))).toBe(true)
    expect(result.allowed.length).toBeGreaterThan(0)
  })
})

describe("R01 設定画面のための解決結果（resolveExclusionLabel）", () => {
  it("解決した / 名前の一致のみ / 判定できない を返す", () => {
    expect(resolveExclusionLabel("卵", "allergy", CATALOG)).toMatchObject({
      status: "resolved",
      effect: "excludes",
      allergenIds: ["egg"],
      ingredientIds: ["egg"],
      via: ["exact"],
    })
    expect(resolveExclusionLabel("乳製品", "allergy", CATALOG)).toMatchObject({ status: "resolved", allergenIds: ["milk"], via: ["term"] })
    expect(resolveExclusionLabel("えび・かに", "dislike", CATALOG)).toMatchObject({ status: "resolved", allergenIds: ["shrimp", "crab"] })
    const cabbage = resolveExclusionLabel("キャベ", "allergy", CATALOG)
    expect(cabbage).toMatchObject({ status: "name_only", effect: "excludes", allergenIds: [], ingredientIds: [], via: [] })
    expect(cabbage.nameMatchedIngredientIds).toEqual(["cabbage"])
    expect(cabbage.nameMatchedRecipeIds.length).toBeGreaterThan(0)
    expect(resolveExclusionLabel("マンゴー", "allergy", CATALOG)).toEqual({
      status: "undetermined",
      effect: "holds_auto_confirm",
      allergenIds: [],
      ingredientIds: [],
      via: [],
      nameMatchedIngredientIds: [],
      nameMatchedRecipeIds: [],
    })
    expect(resolveExclusionLabel("  ", "allergy", CATALOG).status).toBe("undetermined")
  })

  it("理由ごとの効き方: 判定できないアレルギーは自動確定を止め、苦手は何も外さない", () => {
    expect(resolveExclusionLabel("マンゴー", "allergy", CATALOG).effect).toBe("holds_auto_confirm")
    expect(resolveExclusionLabel("マンゴー", "dislike", CATALOG).effect).toBe("no_effect")
    for (const label of ["乳製品", "キャベ", "卵"]) {
      expect(resolveExclusionLabel(label, "allergy", CATALOG).effect, label).toBe("excludes")
      expect(resolveExclusionLabel(label, "dislike", CATALOG).effect, label).toBe("excludes")
    }
  })

  it("入力が品目名を含むことでの解決（卵料理 ⊃ 卵）。苦手は、料理名に当たる入力を食材へ広げない", () => {
    expect(resolveExclusionLabel("卵料理", "allergy", CATALOG)).toMatchObject({
      status: "resolved",
      allergenIds: ["egg"],
      via: ["contains"],
    })
    expect(resolveExclusionLabel("ピーナッツバター", "allergy", CATALOG)).toMatchObject({ status: "resolved", via: ["contains"] })
    expect(resolveExclusionLabel("ピーナッツバター", "allergy", CATALOG).allergenIds).toContain("peanut")
    // 苦手: 「みそ汁」は料理名の一致だけ（みそを使う料理すべてへは広げない）
    const misoSoup = resolveExclusionLabel("みそ汁", "dislike", CATALOG)
    expect(misoSoup).toMatchObject({ status: "name_only", allergenIds: [], ingredientIds: [] })
    const set = buildExclusionSet([custom("みそ汁", "dislike")], CATALOG)
    const blocked = partitionRecipes(RECIPES, set).blocked
    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.every((recipe) => recipe.title.includes("みそ汁"))).toBe(true)
    // 苦手で名前の一致が 1 つも無い語は、含まれる品目へ広げる（C-52: 登録した苦手を「何も除外しない」まま残さない）
    const eggDishes = resolveExclusionLabel("卵料理", "dislike", CATALOG)
    expect(eggDishes).toMatchObject({ status: "resolved", effect: "excludes", allergenIds: ["egg"], via: ["contains"] })
    const eggSet = buildExclusionSet([custom("卵料理", "dislike")], CATALOG)
    const eggPartition = partitionRecipes(RECIPES, eggSet)
    expect(eggPartition.blocked.length).toBeGreaterThan(0)
    const usesEgg = (recipe: (typeof RECIPES)[number]) => recipe.ingredients.some((line) => line.ingredientId === "egg")
    expect(RECIPES.filter(usesEgg).length).toBeGreaterThan(0)
    expect(RECIPES.filter(usesEgg).every((recipe) => eggPartition.blocked.includes(recipe))).toBe(true)
    // 対照: 品目名を 1 つも含まない語は、苦手でも「判定できない（何も除外されない）」のまま
    expect(resolveExclusionLabel("からいもの", "dislike", CATALOG)).toMatchObject({ status: "undetermined", effect: "no_effect" })
  })

  it("画面の表示と判定がずれない: undetermined と返した語は、判定でも undetermined になる", () => {
    for (const reason of ["allergy", "dislike"] as const) {
      for (const label of ["乳製品", "甲殻類", "魚", "卵料理", "キャベ", "きんぴら", "マンゴー", "チョコ", "・"]) {
        const resolution = resolveExclusionLabel(label, reason, CATALOG)
        const set = buildExclusionSet([custom(label, reason)], CATALOG)
        expect(set.undetermined.length > 0, `${label} ${reason}`).toBe(resolution.status === "undetermined")
        expect(set.holdsAutoConfirm, `${label} ${reason}`).toBe(resolution.effect === "holds_auto_confirm")
      }
    }
  })
})

// ── R02 ────────────────────────────────────────────────────────────

describe("R02 手動料理は、材料を登録しても料理名の照合を外さない", () => {
  const cases: readonly (readonly [string, FoodExclusion, string, string[]])[] = [
    ["えび（一覧）", allergen("shrimp"), "エビフライ", ["cabbage"]],
    ["かに（一覧）", allergen("crab"), "かにクリームコロッケ", ["potato", "milk", "butter"]],
    ["卵（一覧）", allergen("egg"), "卵焼き", ["sugar"]],
    ["そば（一覧）", allergen("buckwheat"), "ざるそば", ["green_onion"]],
    ["落花生（一覧）", allergen("peanut"), "ピーナッツ和え", ["spinach"]],
    ["かに（自由入力 → アレルゲン名へ解決）", custom("かに"), "かにクリームコロッケ", ["potato"]],
    ["あわび（自由入力）", custom("あわび"), "あわびのステーキ", ["butter"]],
    ["えび（食材・苦手）", ingredient("shrimp", "dislike"), "エビフライ", ["cabbage"]],
    ["卵（食材・苦手）", ingredient("egg", "dislike"), "卵焼き", ["sugar"]],
  ]

  it.each(cases)("%s: 材料なしでも、材料ありでも除外に当たる", (_name, exclusion, title, ingredientIds) => {
    const set = buildExclusionSet([exclusion], CATALOG)
    expect(evaluateEntry(manualEntry(title, null), set).verdict).toBe("blocked")
    const withIngredients = evaluateEntry(manualEntry(title, ingredientIds.map(ing)), set)
    expect(withIngredients.verdict).toBe("blocked")
    expect(withIngredients.blockedBy.some((hit) => hit.via === "name" && hit.exclusionId === exclusion.id)).toBe(true)
  })

  it("C-55: 材料つきの手動料理も、設定変更後の衝突一覧に出る", () => {
    const entry = manualEntry("かにクリームコロッケ", ["potato", "milk", "butter"].map(ing), "croquette")
    const conflicts = findPlanConflicts([entry], buildExclusionSet([allergen("crab")], CATALOG))
    expect(conflicts.map((c) => [c.entryId, c.verdict])).toEqual([["croquette", "blocked"]])
  })

  it("対照: 料理名にも材料にも当たらない手動料理は通る", () => {
    const set = buildExclusionSet([allergen("shrimp"), allergen("crab")], CATALOG)
    expect(evaluateEntry(manualEntry("野菜炒め", [ing("cabbage")]), set).verdict).toBe("ok")
  })

  it("対照: カタログのレシピには料理名の照合を広げない（そばアレルギー × ソース焼きそば は除外にしない）", () => {
    const yakisoba = RECIPES.find((r) => r.title.includes("焼きそば")) as RecipeDef
    expect(yakisoba).toBeDefined()
    expect(allergensOf(yakisoba).has("buckwheat")).toBe(false)
    expect(evaluateRecipe(yakisoba, buildExclusionSet([allergen("buckwheat")], CATALOG)).verdict).not.toBe("blocked")
  })
})

// ── R23 ────────────────────────────────────────────────────────────

describe("R23 加工品のアレルギー登録を、他のアレルゲンへ広げない", () => {
  const byAllergenList = partition([allergen("buckwheat")])

  it("「そば」（自由入力・食材指定）は、一覧の「そば」と同じ結果になる（小麦へ化けない）", () => {
    for (const exclusion of [custom("そば"), ingredient("soba", "allergy")]) {
      const set = buildExclusionSet([exclusion], CATALOG)
      expect([...new Set(set.allergenRules.map((rule) => rule.allergenId))]).toEqual(["buckwheat"])
      const result = partitionRecipes(RECIPES, set)
      expect(ids(result.blocked)).toEqual(ids(byAllergenList.blocked))
      expect(ids(result.allowed)).toEqual(ids(byAllergenList.allowed))
    }
  })

  it.each(["curry_roux", "salad_oil", "vinegar", "chikuwa"])("%s のアレルギー登録は、その食材を使う料理だけを外す", (ingredientId) => {
    const set = buildExclusionSet([ingredient(ingredientId, "allergy")], CATALOG)
    expect(set.allergenRules).toEqual([])
    const blocked = partitionRecipes(RECIPES, set).blocked
    expect(ids(blocked)).toEqual(ids(RECIPES.filter((recipe) => uses(recipe, (def) => def.id === ingredientId))))
  })

  it("対照: 素の食材（牛乳・小麦粉・卵・ごま）のアレルギー登録は、同じアレルゲンを含む加工品へ及ぶ", () => {
    for (const [ingredientId, allergenId] of [["milk", "milk"], ["wheat_flour", "wheat"], ["egg", "egg"], ["sesame_seeds", "sesame"], ["soybean", "soybean"]] as const) {
      const blocked = partition([ingredient(ingredientId, "allergy")]).blocked
      expect(ids(blocked), ingredientId).toEqual(ids(RECIPES.filter((recipe) => allergensOf(recipe).has(allergenId))))
    }
  })
})

// ── ⑤ 品目名を含むが、その品目ではない語 ───────────────────────────

/**
 * 「含む」での解決（自由入力の `resolveByContainment`）と、手動料理の料理名の照合が、品目名の部分一致で
 * 別の品目へ化けないこと。決めた期待値（2026-11-11）:
 *
 * | 語 | 解決する先（食材。そのアレルゲン） | 解決しない先 |
 * |---|---|---|
 * | 焼きそば | 中華蒸し麺（焼きそば麺。小麦） | そば（アレルゲン・食材） |
 * | 豆乳 | 豆乳（大豆） | 乳 |
 * | 鶏もも | 鶏もも肉（鶏肉） | もも（桃） |
 * | さけるチーズ | チーズ（乳） | さけ |
 *
 * どれも食材（加工品・部位）止まりで、アレルギーでもアレルゲン全体（小麦・大豆・鶏肉・乳）へは広げない
 * （R23: 加工品のアレルギー登録から原因の成分を推測しない。辞書の豆乳・鶏もも肉と同じ扱いにそろえた）。
 * 料理名の側（手動料理）も同じ: 間違った品目の除外では当てない（理由に出さない）。本来の品目の除外では当てる。
 */
describe("⑤ 品目名を含むが、その品目ではない語（部分一致で別の品目へ化けない）", () => {
  const resolved = (label: string, reason: ExclusionReason = "allergy") => resolveExclusionLabel(label, reason, CATALOG)

  /** 食材の辞書が持つアレルゲン（解決した先が何の品目かを、判定の実装を使わずに確かめる）。 */
  const allergensOfIngredient = (id: string) => [...(DEF.get(id)?.allergens ?? [])]

  it("焼きそば: 焼きそば麺（小麦）へ解決し、そばへは解決しない", () => {
    for (const reason of ["allergy", "dislike"] as const) {
      const result = resolved("焼きそば", reason)
      expect(result, reason).toMatchObject({ status: "resolved", effect: "excludes", allergenIds: [], ingredientIds: ["chinese_noodles"] })
    }
    expect(allergensOfIngredient("chinese_noodles")).toEqual(["wheat"])
    // アレルギーでも、そば（アレルゲン）の規則を作らない
    const set = buildExclusionSet([custom("焼きそば")], CATALOG)
    expect(set.allergenRules.map((rule) => rule.allergenId)).not.toContain("buckwheat")
    expect(set.ingredientRules.map((rule) => rule.ingredientId)).toEqual(["chinese_noodles"])
    // 表記ゆれ・語を含む入力も同じ
    for (const label of ["焼そば", "ソース焼きそば", "焼きそばパン"]) {
      const result = resolved(label)
      expect(result.allergenIds, label).not.toContain("buckwheat")
      expect(result.ingredientIds, label).not.toContain("soba")
      expect(result.ingredientIds, label).toContain("chinese_noodles")
    }
  })

  it("豆乳: 豆乳（大豆）へ解決し、乳へは解決しない", () => {
    for (const label of ["豆乳", "豆乳プリン", "無調整豆乳"]) {
      const result = resolved(label)
      expect(result.status, label).toBe("resolved")
      expect(result.allergenIds, label).not.toContain("milk")
      expect(result.ingredientIds, label).toContain("soy_milk")
      expect(result.ingredientIds, label).not.toContain("milk")
    }
    expect(allergensOfIngredient("soy_milk")).toEqual(["soybean"])
    // 豆乳の料理は外れ、牛乳だけの料理は外れない（乳へ化けていない）
    const set = buildExclusionSet([custom("豆乳")], CATALOG)
    expect(evaluateEntry(manualEntry("スープ", [ing("soy_milk")]), set).verdict).toBe("blocked")
    expect(evaluateEntry(manualEntry("スープ", [ing("milk")]), set).blockedBy).toEqual([])
  })

  it("鶏もも: 鶏もも肉（鶏肉）へ解決し、もも（桃）へは解決しない", () => {
    for (const label of ["鶏もも", "鶏ももの唐揚げ", "とりもも"]) {
      const result = resolved(label)
      expect(result.status, label).toBe("resolved")
      expect(result.allergenIds, label).not.toContain("peach")
      expect(result.ingredientIds, label).not.toContain("peach")
      expect(result.ingredientIds, label).toContain("chicken_thigh")
    }
    expect(allergensOfIngredient("chicken_thigh")).toEqual(["chicken"])
  })

  it("さけるチーズ: チーズ（乳）へ解決し、さけへは解決しない", () => {
    for (const reason of ["allergy", "dislike"] as const) {
      const result = resolved("さけるチーズ", reason)
      expect(result.status, reason).toBe("resolved")
      expect(result.allergenIds, reason).not.toContain("salmon")
      expect(result.ingredientIds, reason).not.toContain("salmon")
      expect(result.ingredientIds.length, reason).toBeGreaterThan(0)
      for (const id of result.ingredientIds) expect(allergensOfIngredient(id), id).toEqual(["milk"])
    }
    expect(buildExclusionSet([custom("さけるチーズ")], CATALOG).allergenRules.map((rule) => rule.allergenId)).not.toContain(
      "salmon",
    )
  })

  it("対照: 本当にその品目を含む語は、従来どおり解決する（ざるそば → そば・牛乳プリン → 乳・ももゼリー → もも・さけ）", () => {
    expect(resolved("ざるそば").allergenIds).toContain("buckwheat")
    expect(resolved("牛乳プリン").allergenIds).toContain("milk")
    expect(resolved("ももゼリー").allergenIds).toContain("peach")
    expect(resolved("塩さけ").allergenIds.length + resolved("塩さけ").ingredientIds.length).toBeGreaterThan(0)
    expect(buildExclusionSet([custom("さけのおにぎり")], CATALOG).allergenRules.map((rule) => rule.allergenId)).toContain("salmon")
  })

  describe("料理名の側（手動料理の title）", () => {
    const cases: readonly (readonly [string, string, string, string[]])[] = [
      // [料理名, 当ててはいけないアレルゲン, 当てるべきアレルゲン, 材料（登録した場合）]
      ["焼きそば", "buckwheat", "wheat", ["cabbage", "pork_komagire"]],
      ["豆乳鍋", "milk", "soybean", ["napa_cabbage"]],
      ["鶏ももの照り焼き", "peach", "chicken", ["soy_sauce"]],
      ["さけるチーズのサラダ", "salmon", "milk", ["lettuce"]],
    ]

    it.each(cases)("「%s」: %s の除外では当てない（理由に出さない）", (title, wrong, _right, ingredientIds) => {
      const set = buildExclusionSet([allergen(wrong)], CATALOG)
      const bare = evaluateEntry(manualEntry(title, null), set)
      expect(bare.blockedBy).toEqual([])
      // 材料が無いので「問題なし」とも言わない（未確認）
      expect(bare.verdict).toBe("label_check")
      // 材料を登録すれば、それで判定する（料理名の部分一致で止めない）
      const withIngredients = evaluateEntry(manualEntry(title, ingredientIds.map(ing)), set)
      expect(withIngredients.blockedBy).toEqual([])
    })

    it.each(cases)("「%s」: 本来の品目（%s ではなく %s）の除外では当てる（見落とさない）", (title, _wrong, right, ingredientIds) => {
      const set = buildExclusionSet([allergen(right)], CATALOG)
      expect(evaluateEntry(manualEntry(title, null), set).verdict).toBe("blocked")
      // 材料にその品目を書き漏らしていても、料理名で当てる
      const partial = evaluateEntry(manualEntry(title, ingredientIds.map(ing)), set)
      expect(partial.verdict, title).toBe("blocked")
      expect(partial.blockedBy.some((hit) => hit.via === "name")).toBe(true)
    })

    it("豆乳 × 大豆アレルギー: 材料の豆乳でも、料理名の豆乳でも当てる", () => {
      const set = buildExclusionSet([allergen("soybean")], CATALOG)
      expect(evaluateEntry(manualEntry("スープ", [ing("soy_milk")]), set).blockedBy).toContainEqual(
        expect.objectContaining({ ingredientId: "soy_milk", via: "allergen" }),
      )
      expect(evaluateEntry(manualEntry("豆乳スープ", [ing("napa_cabbage")]), set).verdict).toBe("blocked")
    })

    it("対照: 本当にその品目を含む料理名は、従来どおり当てる", () => {
      for (const [title, allergenId] of [
        ["ざるそば", "buckwheat"],
        ["牛乳寒天", "milk"],
        ["鮭のムニエル", "salmon"],
        ["桃のコンポート", "peach"],
      ] as const) {
        const set = buildExclusionSet([allergen(allergenId)], CATALOG)
        expect(evaluateEntry(manualEntry(title, null), set).verdict, title).toBe("blocked")
      }
    })
  })
})

describe("⑤ 材料から確かめる（料理名に品目名が無くても当てる）", () => {
  it("卵アレルギー: 料理名に「卵」と無くても、材料のマヨネーズ（卵を含む）で当てる", () => {
    const set = buildExclusionSet([allergen("egg")], CATALOG)
    const result = evaluateEntry(manualEntry("ポテトサラダ", [ing("potato"), ing("mayonnaise")]), set)
    expect(result.verdict).toBe("blocked")
    expect(result.blockedBy).toContainEqual(
      expect.objectContaining({ exclusionId: "a-egg", ingredientId: "mayonnaise", via: "allergen" }),
    )
    // 対照: マヨネーズを使わなければ当たらない
    expect(evaluateEntry(manualEntry("ポテトサラダ", [ing("potato")]), set).verdict).toBe("ok")
  })

  it("食材で登録した苦手（豚肉）は、派生の食材（豚こま切れ肉）を材料に持つ手動料理に当てる", () => {
    const set = buildExclusionSet([ingredient("pork", "dislike")], CATALOG)
    expect(evaluateEntry(manualEntry("炒め物", [ing("pork_komagire")]), set).verdict).toBe("blocked")
  })
})

describe("⑤ 原材料が不明な料理を「含まない」と判定しない（問題なし / 当たる / 未確認）", () => {
  it("苦手だけの世帯でも、材料が未登録の手動料理は「未確認」（料理名にも当たらなければ）", () => {
    const set = buildExclusionSet([ingredient("pork", "dislike")], CATALOG)
    const result = evaluateEntry(manualEntry("豚しゃぶ", null), set)
    expect(result.verdict).toBe("label_check")
    expect(result.allowed).toBe(false)
    expect(result.unverifiable).toEqual([{ reason: "no_ingredients", ingredientId: null }])
    // 対照: 材料を登録すれば判定できる（当たらない材料なら問題なし）
    expect(evaluateEntry(manualEntry("野菜炒め", [ing("cabbage")]), set).verdict).toBe("ok")
    // 対照: 除外が 1 件も無ければ、確かめるものが無いので問題なし
    expect(evaluateEntry(manualEntry("豚しゃぶ", null), buildExclusionSet([], CATALOG)).verdict).toBe("ok")
  })

  it("辞書で解決できない材料（一覧から消えた食材）を持つ手動料理も「未確認」", () => {
    const set = buildExclusionSet([ingredient("pork", "dislike")], CATALOG)
    const result = evaluateEntry(manualEntry("炒め物", [ing("cabbage"), ing("removed_ingredient")]), set)
    expect(result.verdict).toBe("label_check")
    expect(result.unverifiable).toEqual([{ reason: "unknown_ingredient", ingredientId: "removed_ingredient" }])
  })

  it("対照: 苦手だけの世帯では、商品で原材料が変わる材料（ルウ）だけを理由に未確認にはしない（アレルギーの世帯だけ）", () => {
    const roux = RECIPES.find((recipe) => usesDirectly(recipe, "curry_roux")) as RecipeDef
    expect(roux).toBeDefined()
    expect(evaluateRecipe(roux, buildExclusionSet([ingredient("tomato", "dislike")], CATALOG)).verdict).not.toBe("label_check")
    expect(evaluateRecipe(roux, buildExclusionSet([allergen("egg")], CATALOG)).verdict).toBe("label_check")
  })
})

// ── [低 8] 分類の語 ─────────────────────────────────────────────────

describe("[低 8] 分類の語（〜科・〜類）を、含む品目 1 つへ縮めない", () => {
  it("「なす科」はなすだけへ解決せず「判定できない」（アレルギーは自動確定を止め、苦手は何も外さないと示す）", () => {
    const allergy = resolveExclusionLabel("なす科", "allergy", CATALOG)
    expect(allergy).toMatchObject({ status: "undetermined", effect: "holds_auto_confirm", allergenIds: [], ingredientIds: [] })
    expect(resolveExclusionLabel("なす科", "dislike", CATALOG)).toMatchObject({ status: "undetermined", effect: "no_effect" })
    // 判定と画面の解決が一致する（「適用済み」に見せない）
    const set = buildExclusionSet([custom("なす科")], CATALOG)
    expect(set.undetermined.map((item) => item.label)).toEqual(["なす科"])
    expect(set.ingredientRules).toEqual([])
    for (const label of ["ナス科", "なす科の野菜", "うり科"]) {
      expect(resolveExclusionLabel(label, "allergy", CATALOG).status, label).toBe("undetermined")
    }
  })

  it("「〜類」は、類全体を指す品目（アレルゲン名・総称の食材）にだけ解決する。1 つの食材へは縮めない", () => {
    expect(resolveExclusionLabel("なす類", "allergy", CATALOG).status).toBe("undetermined")
    expect(resolveExclusionLabel("えび類", "allergy", CATALOG)).toMatchObject({ status: "resolved", allergenIds: ["shrimp"] })
    expect(resolveExclusionLabel("きのこ類全般", "allergy", CATALOG)).toMatchObject({ status: "resolved", ingredientIds: ["mushroom"] })
  })

  it("対照: 既存の解決は変わらない（卵料理 → 卵・乳製品・ナッツ類・魚介類・きのこ類）", () => {
    expect(resolveExclusionLabel("卵料理", "allergy", CATALOG)).toMatchObject({ status: "resolved", allergenIds: ["egg"], via: ["contains"] })
    expect(resolveExclusionLabel("乳製品", "allergy", CATALOG)).toMatchObject({ status: "resolved", allergenIds: ["milk"], via: ["term"] })
    expect(resolveExclusionLabel("ナッツ類", "allergy", CATALOG).status).toBe("resolved")
    expect(resolveExclusionLabel("魚介類", "dislike", CATALOG).status).toBe("resolved")
    expect(resolveExclusionLabel("きのこ類", "dislike", CATALOG)).toMatchObject({ status: "resolved", ingredientIds: ["mushroom"] })
  })
})

// ── R25 ────────────────────────────────────────────────────────────

describe("R25 食材辞書の派生関係", () => {
  it("じゃがいもが苦手でも、片栗粉を使うだけの料理は外さない", () => {
    const blocked = partition([ingredient("potato", "dislike")]).blocked
    expect(blocked.length).toBeGreaterThan(0)
    expect(blocked.filter((recipe) => !usesDirectly(recipe, "potato")).map((r) => r.title)).toEqual([])
    // 自由入力でも同じ
    const byName = partition([custom("じゃがいも", "dislike")]).blocked
    expect(ids(byName)).toEqual(ids(blocked))
  })

  it("対照: じゃがいものアレルギーは、片栗粉（じゃがいものでんぷん）へも及ぼす", () => {
    const blocked = partition([ingredient("potato", "allergy")]).blocked
    const withStarch = RECIPES.filter((recipe) => usesDirectly(recipe, "katakuriko"))
    expect(withStarch.length).toBeGreaterThan(0)
    for (const recipe of withStarch) expect(ids(blocked), recipe.title).toContain(recipe.id)
  })

  it("トマトの除外は、ミニトマトを使う料理にも及ぶ", () => {
    for (const reason of ["allergy", "dislike"] as const) {
      const set = buildExclusionSet([ingredient("tomato", reason)], CATALOG)
      const dish = manualEntry("サラダ", [ing("cherry_tomato"), ing("lettuce")])
      expect(evaluateEntry(dish, set).verdict, reason).toBe("blocked")
      // 対照: 逆向きには及ぼさない（ミニトマトが苦手でもトマトは外さない）
      const reverse = buildExclusionSet([ingredient("cherry_tomato", reason)], CATALOG)
      expect(evaluateEntry(manualEntry("サラダ", [ing("tomato"), ing("lettuce")]), reverse).blockedBy, reason).toEqual([])
    }
  })
})
