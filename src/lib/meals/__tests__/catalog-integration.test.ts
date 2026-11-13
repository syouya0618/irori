/**
 * 機能 C の統合テスト: **実カタログ**（`src/lib/meals/catalog/`）× 純粋ロジック。
 *
 * 個々の規則は各モジュールのテストが小さな fixture で固定している。ここでは
 * 「同梱したデータで、利用者が実際に行う操作が成立するか」を確かめる。
 *
 * 除外の検査は、判定の実装（`exclusions.ts` / `lookup.ts`）を使わない独立した
 * 突き合わせ（このファイルの `lineage`）で行う。実装と同じ関数で確かめると、
 * 実装の誤りを検査が一緒に見逃すため。
 */

import { describe, expect, it } from "vitest"

import {
  ALLERGENS,
  CHILD_SERVING_RECIPES,
  INGREDIENTS,
  RECIPES,
  STAPLE_CANDIDATE_INGREDIENTS,
  STORE_SECTION_LABELS,
  STORE_SECTIONS,
} from "@/lib/meals/catalog"
import {
  findAgeRuleWarnings,
  type MealChild,
  resolveChildServing,
  summarizeChildServing,
} from "@/lib/meals/child-serving"
import { buildExclusionSet, partitionRecipes } from "@/lib/meals/exclusions"
import {
  buildGroceryNeeds,
  type ExistingGroceryItem,
  type GroceryNeedDetail,
  type GroceryUpsert,
  mergeWithExisting,
} from "@/lib/meals/grocery"
import { toCatalogView } from "@/lib/meals/lookup"
import { buildIngredientIndex, foldName, resolveIngredientId } from "@/lib/meals/normalize"
import {
  DEFAULT_DINNER_SERVINGS,
  generatePlan,
  mainProteinKey,
  moveDay,
  planDates,
  type PlanInput,
  type PlanResult,
  replaceDay,
  replaceDish,
  reviewPlan,
} from "@/lib/meals/planner"
import { suggestNow, type SuggestNowInput, type SuggestNowResult } from "@/lib/meals/suggest-now"
import type {
  DishFeedback,
  DishRole,
  FoodExclusion,
  IngredientDef,
  PantryItem,
  PlanEntry,
  PlanEntryStatus,
  Quantity,
  RecipeDef,
  RecipeIngredient,
  StoreSection,
  UnitId,
} from "@/lib/meals/types"
import { parseWish } from "@/lib/meals/wish-rules"

const CATALOG = toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })

// 2026-11-16 は月曜。金曜は 11/20
const MONDAY = "2026-11-16"
const TUESDAY = "2026-11-17"
const WEDNESDAY = "2026-11-18"
const FRIDAY = "2026-11-20"
const SUNDAY = "2026-11-22"
const TODAY = MONDAY

const ALL_ROLES: readonly DishRole[] = ["main", "side", "staple", "soup"]

/** 世帯が「常備品」に設定した、という想定の調味料（初期登録ではない。テストが明示して渡す）。 */
const HOUSE_STAPLES: readonly string[] = [
  "soy_sauce", "mirin", "sake", "sugar", "salt", "salad_oil", "pepper", "katsuobushi",
]
const ALL_STAPLE_CANDIDATES: readonly string[] = STAPLE_CANDIDATE_INGREDIENTS.map((i) => i.id)
const EVERY_INGREDIENT: readonly string[] = INGREDIENTS.map((i) => i.id)

// ── 独立した突き合わせ（判定の実装を使わない） ─────────────────────

const DEF: ReadonlyMap<string, IngredientDef> = new Map(INGREDIENTS.map((i) => [i.id, i]))
const RECIPE: ReadonlyMap<string, RecipeDef> = new Map(RECIPES.map((r) => [r.id, r]))

function recipeOf(id: string | null): RecipeDef {
  const found = id === null ? undefined : RECIPE.get(id)
  if (!found) throw new Error(`recipe not in catalog: ${String(id)}`)
  return found
}

/** 自分と、`derivedFrom` を推移的にたどった由来の食材。 */
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

/** 必須・任意を問わず、材料（と由来）が持つアレルゲン。 */
function allergensOf(recipe: RecipeDef): Set<string> {
  return new Set(recipe.ingredients.flatMap((i) => lineage(i.ingredientId).flatMap((d) => [...d.allergens])))
}

function hasVaries(recipe: RecipeDef): boolean {
  return recipe.ingredients.some((i) => lineage(i.ingredientId).some((d) => d.allergenInfo === "varies"))
}

/** 必須・任意を問わず、その食材（または派生品）を材料に持つか。 */
function usesAny(recipe: RecipeDef, ingredientIds: ReadonlySet<string>): boolean {
  return recipe.ingredients.some((i) => lineage(i.ingredientId).some((d) => ingredientIds.has(d.id)))
}

const BASE_FACTOR: Partial<Record<UnitId, { unit: UnitId; factor: number }>> = {
  g: { unit: "g", factor: 1 },
  kg: { unit: "g", factor: 1000 },
  ml: { unit: "ml", factor: 1 },
  l: { unit: "ml", factor: 1000 },
  tsp: { unit: "ml", factor: 5 },
  tbsp: { unit: "ml", factor: 15 },
  cup: { unit: "ml", factor: 200 },
}

/** 確定した枠から必要量を素朴に展開する（`食材|基準単位` → 量）。任意材料・適量は含めない。 */
function expandNaively(entries: readonly PlanEntry[]): Map<string, number> {
  const totals = new Map<string, number>()
  for (const entry of entries) {
    if (entry.status !== "confirmed") continue
    const recipe = recipeOf(entry.recipeId)
    for (const ingredient of recipe.ingredients) {
      const { amount, unit } = ingredient.quantity
      if (ingredient.optional === true || amount === null) continue
      const base = BASE_FACTOR[unit] ?? { unit, factor: 1 }
      const key = `${ingredient.ingredientId}|${base.unit}`
      const scaled = (amount * base.factor * entry.servings) / recipe.servings
      totals.set(key, (totals.get(key) ?? 0) + scaled)
    }
  }
  return totals
}

// ── 入力の組み立て ─────────────────────────────────────────────────

function planInput(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    startDate: MONDAY,
    days: 7,
    servings: DEFAULT_DINNER_SERVINGS,
    today: TODAY,
    existingEntries: [],
    pantry: [],
    exclusions: [],
    stapleIngredientIds: [],
    catalog: CATALOG,
    ...overrides,
  }
}

/** 結果を保存した後の状態（新しい枠へ ID を振る）。`status` を渡すと全枠をその状態にする。 */
function saved(plan: PlanResult, status?: PlanEntryStatus): PlanEntry[] {
  return plan.entries.map((e, i) => ({
    id: e.id ?? `saved-${i}`,
    date: e.date,
    role: e.role,
    position: e.position,
    recipeId: e.recipeId,
    recipeVersion: e.recipeVersion,
    customTitle: e.customTitle,
    customIngredients: e.customIngredients,
    servings: e.servings,
    pinned: e.pinned,
    status: status ?? e.status,
    origin: e.origin,
  }))
}

function entryFor(
  id: string,
  date: string,
  recipeId: string,
  overrides: Partial<PlanEntry> = {},
): PlanEntry {
  const recipe = recipeOf(recipeId)
  return {
    id,
    date,
    role: recipe.role,
    position: 0,
    recipeId,
    recipeVersion: recipe.version,
    customTitle: null,
    customIngredients: null,
    servings: 2,
    pinned: false,
    status: "confirmed",
    origin: "auto",
    ...overrides,
  }
}

function q(amount: number, unit: UnitId): Quantity {
  return { amount, unit }
}

/** 在庫 1 件。名前を辞書へ解決して作る（利用者の入力と同じ経路）。 */
function stockByName(name: string, quantity: Quantity | null, overrides: Partial<PantryItem> = {}): PantryItem {
  const ingredientId = resolveIngredientId(name, CATALOG.index)
  return {
    id: `p-${name}`,
    ingredientId,
    name,
    quantity,
    status: "have",
    useSoon: false,
    storage: "fridge",
    expiresOn: null,
    confirmedOn: TODAY,
    ...overrides,
  }
}

function allergy(allergenId: string, id = `x-${allergenId}`, subject: FoodExclusion["subject"] = { kind: "household" }): FoodExclusion {
  return { id, reason: "allergy", target: { kind: "allergen", allergenId }, subject }
}

function dislikeIngredient(ingredientId: string, subject: FoodExclusion["subject"] = { kind: "household" }): FoodExclusion {
  return { id: `x-${ingredientId}`, reason: "dislike", target: { kind: "ingredient", ingredientId }, subject }
}

function nowInput(overrides: Partial<SuggestNowInput> = {}): SuggestNowInput {
  return {
    today: TODAY,
    servings: 2,
    pantry: [],
    exclusions: [],
    stapleIngredientIds: [],
    catalog: CATALOG,
    limit: 1000,
    ...overrides,
  }
}

const idsOf = (plan: PlanResult, role: DishRole) =>
  plan.entries.filter((e) => e.role === role).map((e) => e.recipeId as string)

const onDate = (plan: PlanResult, date: string) => plan.entries.filter((e) => e.date === date)

/** 在庫提案のどの枠かを問わず、出力に現れたレシピ。 */
function shownRecipes(result: SuggestNowResult): RecipeDef[] {
  return [...result.ready, ...result.check, ...result.buy].map((s) => s.recipe)
}

/** 期間 × 区分の全ての枠が「料理 1 つ」か「不足枠 1 つ」のどちらかで説明できる（黙って消えた枠が無い）。 */
function expectEverySlotAccounted(plan: PlanResult, roles: readonly DishRole[]): void {
  for (const date of planDates(plan.startDate, plan.days)) {
    const day = onDate(plan, date)
    const mainIncludesStaple = day.some((e) => e.role === "main" && recipeOf(e.recipeId).includesStaple === true)
    for (const role of roles) {
      const filled = day.filter((e) => e.role === role).length
      const gaps = plan.gaps.filter((g) => g.date === date && g.role === role).length
      const expected = role === "staple" && mainIncludesStaple ? 0 : 1
      expect(filled + gaps, `${date} ${role}`).toBe(expected)
    }
  }
}

// ── 1. 通常条件で 1〜7 日 ──────────────────────────────────────────

describe("V-C2 / C-12 / C-31 / C-36 実カタログで 1〜7 日分が成立する（除外なし・在庫なし・2 人分）", () => {
  it.each([1, 3, 7])("%i 日分: 主菜＋副菜の全枠が埋まり、期間内で主菜も副菜も重複しない", (days) => {
    for (const stapleIngredientIds of [[], HOUSE_STAPLES, ALL_STAPLE_CANDIDATES]) {
      const plan = generatePlan(planInput({ days, stapleIngredientIds }))
      expect(plan.gaps).toEqual([])
      expect(plan.entries).toHaveLength(days * 2)
      for (const date of planDates(MONDAY, days)) {
        expect(onDate(plan, date).map((e) => e.role)).toEqual(["main", "side"])
      }
      expect(new Set(idsOf(plan, "main")).size).toBe(days)
      expect(new Set(idsOf(plan, "side")).size).toBe(days)
      for (const entry of plan.entries) {
        expect(entry).toMatchObject({ servings: DEFAULT_DINNER_SERVINGS, status: "proposed", origin: "auto", pinned: false })
        expect(entry.recipeVersion).toBe(recipeOf(entry.recipeId).version)
      }
    }
  })

  it("同じ入力からは同じ献立（種を変えても、その種では毎回同じ）", () => {
    expect(generatePlan(planInput())).toEqual(generatePlan(planInput()))
    const seeded = generatePlan(planInput({ options: { seed: 11 } }))
    expect(generatePlan(planInput({ options: { seed: 11 } }))).toEqual(seeded)
    // 対照: 種で結果が変わりうる（揺らぎが効いている）
    const variants = new Set([1, 2, 3, 4, 5].map((seed) => idsOf(generatePlan(planInput({ options: { seed } })), "main").join()))
    expect(variants.size).toBeGreaterThan(1)
  })

  it("C-32: 主食・汁物を足しても全枠が埋まり、主食を含む主菜（丼・カレー・麺）の日には主食を足さない", () => {
    let sawIncludesStaple = false
    for (const seed of [undefined, 1, 2, 3, 4, 5, 6, 7]) {
      const plan = generatePlan(planInput({ options: { includeStaple: true, includeSoup: true, seed } }))
      expect(plan.gaps).toEqual([])
      expectEverySlotAccounted(plan, ALL_ROLES)
      for (const date of planDates(MONDAY, 7)) {
        const day = onDate(plan, date)
        const main = recipeOf(day.find((e) => e.role === "main")?.recipeId ?? null)
        const staples = day.filter((e) => e.role === "staple")
        if (main.includesStaple === true) {
          sawIncludesStaple = true
          expect(staples, `${date} ${main.id}`).toEqual([])
        } else {
          expect(staples, `${date} ${main.id}`).toHaveLength(1)
        }
      }
    }
    // 対照: 主食を含む主菜の日が実際に検査されている
    expect(sawIncludesStaple).toBe(true)
  })

  it("7 日の主菜で、同じ主たんぱく（ひき肉・豚・鶏・牛・魚・卵・豆腐）が 3 回以上にならず、連日にもならない", () => {
    const seenKeys = new Set<string>()
    for (const startDate of [MONDAY, WEDNESDAY, "2026-12-27"]) {
      for (const stapleIngredientIds of [[], HOUSE_STAPLES, ALL_STAPLE_CANDIDATES]) {
        for (let seed = 0; seed <= 40; seed += 1) {
          const options = seed === 0 ? {} : { seed }
          const plan = generatePlan(planInput({ startDate, today: startDate, stapleIngredientIds, options }))
          const keys = idsOf(plan, "main").map((id) => mainProteinKey(recipeOf(id), CATALOG))
          const label = `${startDate} staples=${stapleIngredientIds.length} seed=${seed}: ${keys.join(" ")}`
          expect(keys, label).toHaveLength(7)
          const counts = new Map<string, number>()
          for (const [i, key] of keys.entries()) {
            expect(key, label).not.toBeNull()
            if (key === null) continue
            seenKeys.add(key)
            counts.set(key, (counts.get(key) ?? 0) + 1)
            if (i > 0) expect(keys[i - 1], label).not.toBe(key)
          }
          expect(Math.max(...counts.values()), label).toBeLessThanOrEqual(2)
        }
      }
    }
    // 対照: 鍵が 1 種類に潰れていない（区別できている）
    expect(seenKeys.size).toBeGreaterThanOrEqual(5)
  })

  it("主たんぱくの鍵: ひき肉料理は「ひき肉」、肉を使う料理の卵・豆腐は副材料として数える", () => {
    const key = (id: string) => mainProteinKey(recipeOf(id), CATALOG)
    expect(key("hamburg_steak")).toBe("tag:ground_meat")
    expect(key("mapo_tofu")).toBe("tag:ground_meat")
    expect(key("chicken_tsukune_shio")).toBe("tag:ground_meat")
    expect(key("oyakodon")).toBe("tag:chicken")
    expect(key("niku_dofu")).toBe("tag:beef")
    expect(key("pork_nira_egg")).toBe("tag:pork")
    expect(key("tofu_steak_mushroom")).toBe("tag:tofu")
    expect(key("salmon_shioyaki")).toBe("tag:fish")
  })

  it("在庫が空でも卵料理などに寄らない: 7 日の主菜＋副菜で、同じたんぱく源（卵・豆腐・豚 …）の料理は 2 品まで", () => {
    const proteinTags = ["ground_meat", "pork", "chicken", "beef", "fish", "egg", "tofu"]
    let mostEggs = 0
    for (const stapleIngredientIds of [[], HOUSE_STAPLES, ALL_STAPLE_CANDIDATES]) {
      for (const extra of [{}, { includeStaple: true, includeSoup: true }]) {
        for (let seed = 0; seed <= 40; seed += 1) {
          const plan = generatePlan(planInput({ stapleIngredientIds, options: seed === 0 ? extra : { ...extra, seed } }))
          const label = `staples=${stapleIngredientIds.length} seed=${seed}`
          expect(plan.gaps, label).toEqual([])
          const dishes = plan.entries.filter((e) => e.role === "main" || e.role === "side").map((e) => recipeOf(e.recipeId))
          for (const tag of proteinTags) {
            const tagged = dishes.filter((r) => r.tags.includes(tag)).map((r) => r.id)
            expect(tagged.length, `${label} ${tag}: ${tagged.join(",")}`).toBeLessThanOrEqual(2)
          }
          // 卵の個数（2 人分・汁物を含む）
          const eggs = plan.entries
            .flatMap((e) => recipeOf(e.recipeId).ingredients)
            .filter((i) => i.ingredientId === "egg" && i.optional !== true)
            .reduce((sum, i) => sum + (i.quantity.amount ?? 0), 0)
          mostEggs = Math.max(mostEggs, eggs)
        }
      }
    }
    // 主菜・副菜の卵料理 2 品（最大 4 + 3 個）と、かきたま汁（1 個 × 繰り返し）まで
    expect(mostEggs).toBeLessThanOrEqual(9)
    // 対照: 卵料理が 1 つも選ばれないわけではない（避けすぎていない）
    expect(mostEggs).toBeGreaterThan(0)
  })

  it("「魚多め」と希望すれば、偏りの減点より希望を優先して魚の主菜が 3 日以上になる（連日は避けたまま）", () => {
    const wish = parseWish({ text: "魚多め", startDate: MONDAY, days: 7, today: TODAY, recipes: RECIPES })
    expect(wish.constraints.preferTags).toEqual(["fish"])
    const plan = generatePlan(planInput({ wish: wish.constraints, stapleIngredientIds: HOUSE_STAPLES }))
    const fishDays = idsOf(plan, "main").map((id) => recipeOf(id).tags.includes("fish"))
    expect(fishDays.filter(Boolean).length).toBeGreaterThanOrEqual(3)
    for (let i = 1; i < fishDays.length; i += 1) expect(fishDays[i] && fishDays[i - 1]).toBe(false)
    // 対照: 希望が無ければ 2 日まで
    const plain = generatePlan(planInput({ stapleIngredientIds: HOUSE_STAPLES }))
    expect(idsOf(plain, "main").filter((id) => recipeOf(id).tags.includes("fish")).length).toBeLessThanOrEqual(2)
  })

  it("1 品差替え: どの枠でも別の候補が出て、他の枠は変わらず、期間内の重複も生まない", () => {
    const base = generatePlan(planInput())
    const entries = saved(base)
    for (const target of entries) {
      const result = replaceDish(planInput({ existingEntries: entries }), target.id)
      if (!result.ok) throw new Error(`replaceDish failed: ${result.reason}`)
      expect(result.plan.unchanged).toEqual([])
      expect(result.plan.gaps).toEqual([])
      const replaced = onDate(result.plan, target.date).find((e) => e.role === target.role)
      expect(replaced?.recipeId, target.id).not.toBe(target.recipeId)
      expect(replaced?.position).toBe(target.position)
      expect(result.plan.removedEntryIds).toEqual([target.id])
      // 他の枠は ID・料理とも元のまま
      const others = result.plan.entries.filter((e) => e.id !== null)
      expect(others.map((e) => [e.id, e.recipeId])).toEqual(
        entries.filter((e) => e.id !== target.id).map((e) => [e.id, e.recipeId]),
      )
      expect(new Set(idsOf(result.plan, target.role)).size).toBe(7)
    }
  })

  it("1 日差替え: どの日でも主菜・副菜とも別の料理になり、他の日は 1 つも変わらない", () => {
    const entries = saved(generatePlan(planInput()))
    for (const date of planDates(MONDAY, 7)) {
      const result = replaceDay(planInput({ existingEntries: entries }), date)
      if (!result.ok) throw new Error(`replaceDay failed: ${result.reason}`)
      expect(result.plan.gaps).toEqual([])
      const before = entries.filter((e) => e.date === date)
      const after = onDate(result.plan, date)
      expect(after.map((e) => e.role)).toEqual(["main", "side"])
      for (const entry of after) {
        expect(before.map((e) => e.recipeId)).not.toContain(entry.recipeId)
      }
      expect(
        result.plan.entries.filter((e) => e.date !== date).map((e) => [e.id, e.date, e.recipeId]),
      ).toEqual(entries.filter((e) => e.date !== date).map((e) => [e.id, e.date, e.recipeId]))
    }
  })

  it("C-34: 時間の希望（15 分・20 分以内）を、満たす候補があるかぎり守る", () => {
    for (const maxMinutes of [15, 20]) {
      const wish = parseWish({ text: `${maxMinutes}分以内`, startDate: MONDAY, days: 7, today: TODAY, recipes: RECIPES })
      expect(wish.constraints.maxMinutes).toBe(maxMinutes)
      const plan = generatePlan(planInput({ wish: wish.constraints }))
      expect(plan.gaps).toEqual([])
      for (const entry of plan.entries) {
        expect(recipeOf(entry.recipeId).minutes, `${maxMinutes}: ${entry.recipeId}`).toBeLessThanOrEqual(maxMinutes)
      }
    }
    // 対照: 希望が無ければ 15 分を超える料理も選ばれる
    const free = generatePlan(planInput({ stapleIngredientIds: ALL_STAPLE_CANDIDATES }))
    expect(free.entries.some((e) => recipeOf(e.recipeId).minutes > 15)).toBe(true)
  })
})

// ── 2. 金曜はカレー ────────────────────────────────────────────────

describe("V-C2 / C-33 「金曜はカレー」を規則で解釈して固定する", () => {
  const parsed = parseWish({ text: "金曜はカレー", startDate: MONDAY, days: 7, today: TODAY, recipes: RECIPES })
  const options = { includeStaple: true }
  const first = generatePlan(planInput({ wish: parsed.constraints, options }))
  const entries = saved(first)
  const curry = entries.find((e) => e.recipeId === "curry_rice")

  const curryDates = (list: readonly { date: string; recipeId: string | null; pinned: boolean }[]) =>
    list.filter((e) => e.recipeId === "curry_rice").map((e) => [e.date, e.pinned])

  it("生成 AI を使わずに、金曜の固定（カレーライス）へ直す", () => {
    expect(parsed.constraints.pins).toEqual([{ date: FRIDAY, recipeId: "curry_rice" }])
    expect(parsed.unparsed).toEqual([])
    // 対照: 期間に金曜が無ければ固定にしない（原文を返す）
    const noFriday = parseWish({ text: "金曜はカレー", startDate: MONDAY, days: 3, today: TODAY, recipes: RECIPES })
    expect(noFriday.constraints.pins).toEqual([])
    expect(noFriday.unparsed).toEqual(["金曜はカレー"])
  })

  it("金曜の主菜がカレーの固定枠になり、その日に主食は付かない（他の日には付く）", () => {
    expect(first.rejectedPins).toEqual([])
    expect(first.gaps).toEqual([])
    expect(curryDates(first.entries)).toEqual([[FRIDAY, true]])
    expect(onDate(first, FRIDAY).map((e) => e.role).sort()).toEqual(["main", "side"])
    // 対照: 主食を含まない主菜の日には主食が付いている
    const plainDay = planDates(MONDAY, 7).find(
      (date) => recipeOf(onDate(first, date).find((e) => e.role === "main")?.recipeId ?? null).includesStaple !== true,
    )
    expect(plainDay).toBeDefined()
    expect(onDate(first, plainDay as string).some((e) => e.role === "staple")).toBe(true)
  })

  it("全体を再生成しても、固定枠は ID・日付・料理とも残る（希望を渡し直さなくても）", () => {
    for (const seed of [undefined, 3, 9]) {
      const again = generatePlan(planInput({ existingEntries: entries, options: { ...options, seed } }))
      const kept = again.entries.find((e) => e.recipeId === "curry_rice")
      expect(kept).toMatchObject({ id: curry?.id, date: FRIDAY, pinned: true, kept: true })
      expect(onDate(again, FRIDAY).some((e) => e.role === "staple")).toBe(false)
      expect(again.removedEntryIds).not.toContain(curry?.id)
      expect(again.gaps).toEqual([])
    }
  })

  it("金曜を 1 日差替えしても固定のカレーは残り、副菜だけが替わる。主食も付かない", () => {
    const result = replaceDay(planInput({ existingEntries: entries, options }), FRIDAY)
    if (!result.ok) throw new Error(result.reason)
    const friday = onDate(result.plan, FRIDAY)
    expect(friday.find((e) => e.role === "main")).toMatchObject({ id: curry?.id, recipeId: "curry_rice", pinned: true })
    const oldSide = entries.find((e) => e.date === FRIDAY && e.role === "side")
    expect(friday.find((e) => e.role === "side")?.recipeId).not.toBe(oldSide?.recipeId)
    expect(friday.some((e) => e.role === "staple")).toBe(false)
  })

  it("固定枠そのものの 1 品差替えは拒否する（解除は別の明示操作）", () => {
    expect(replaceDish(planInput({ existingEntries: entries, options }), curry?.id ?? "")).toEqual({
      ok: false,
      reason: "pinned",
    })
  })

  it("日付移動（金 → 水）: 固定は枠に付いて行き、移動先でも主食が二重に付かない。その後の再生成でも水曜に残る", () => {
    const moved = moveDay(entries, FRIDAY, WEDNESDAY)
    if (!moved.ok) throw new Error(moved.reason)
    expect(curryDates(moved.entries)).toEqual([[WEDNESDAY, true]])
    const reviewed = reviewPlan(planInput({ existingEntries: moved.entries, options }))
    expect(curryDates(reviewed.entries)).toEqual([[WEDNESDAY, true]])
    expect(onDate(reviewed, WEDNESDAY).some((e) => e.role === "staple")).toBe(false)
    expect(reviewed.entries).toHaveLength(entries.length)
    const again = generatePlan(planInput({ existingEntries: moved.entries, options: { ...options, seed: 5 } }))
    expect(curryDates(again.entries)).toEqual([[WEDNESDAY, true]])
    expect(onDate(again, WEDNESDAY).some((e) => e.role === "staple")).toBe(false)
    // 金曜は固定が外れたので、通常どおり主食つきで作り直される
    const fridayMain = recipeOf(onDate(again, FRIDAY).find((e) => e.role === "main")?.recipeId ?? null)
    expect(onDate(again, FRIDAY).some((e) => e.role === "staple")).toBe(fridayMain.includesStaple !== true)
  })
})

// ── 3. 今あるもので ────────────────────────────────────────────────

describe("V-C1 / C-23〜C-27 「今あるもので」: 代表的な在庫で実カタログから提案する", () => {
  const pantry = [
    stockByName("鶏もも", q(300, "g")),
    stockByName("玉ねぎ", q(2, "piece")),
    stockByName("たまご", q(4, "piece")),
    stockByName("お米", q(2, "kg"), { storage: "pantry" }),
  ]

  it("入力した名前が辞書の食材へ解決している（炊いた「ごはん」は米と同一視しない）", () => {
    expect(pantry.map((p) => p.ingredientId)).toEqual(["chicken_thigh", "onion", "egg", "rice"])
    expect(resolveIngredientId("ごはん", CATALOG.index)).toBeNull()
    expect(resolveIngredientId("ご飯", CATALOG.index)).toBeNull()
  })

  it("数量つきの在庫と常備品の設定で、揃う候補を 3 案返す。必須材料は 1 つも欠けていない", () => {
    const top = suggestNow(nowInput({ pantry, stapleIngredientIds: HOUSE_STAPLES, limit: undefined }))
    expect(top.ready).toHaveLength(3)
    expect(top.readyTotal).toBeGreaterThanOrEqual(3)
    expect(top.hints).toEqual([])
    const all = suggestNow(nowInput({ pantry, stapleIngredientIds: HOUSE_STAPLES }))
    expect(all.ready.map((s) => s.recipe.id)).toEqual(
      expect.arrayContaining(["chicken_teriyaki", "oyakodon", "tamagoyaki"]),
    )
    const stocked = new Set(pantry.map((p) => p.ingredientId))
    for (const suggestion of all.ready) {
      expect(suggestion.match.missing).toEqual([])
      expect(suggestion.match.toCheck).toEqual([])
      for (const ingredient of suggestion.recipe.ingredients.filter((i) => i.optional !== true)) {
        const covered = stocked.has(ingredient.ingredientId) || HOUSE_STAPLES.includes(ingredient.ingredientId)
        expect(covered, `${suggestion.recipe.id} → ${ingredient.ingredientId}`).toBe(true)
      }
    }
    // 3 つの枠は混ざらない
    for (const s of all.check) expect(s.match.missing).toEqual([])
    for (const s of all.check) expect(s.match.toCheck.length).toBeGreaterThan(0)
    for (const s of all.buy) expect(s.match.missing.length).toBeGreaterThan(0)
  })

  it("数量不明の在庫だけでは「揃う」にせず、分量要確認の枠へ入れて理由を返す", () => {
    const unknown = pantry.map((p) => ({ ...p, quantity: null }))
    const result = suggestNow(nowInput({ pantry: unknown, stapleIngredientIds: HOUSE_STAPLES }))
    expect(result.ready).toEqual([])
    expect(result.readyTotal).toBe(0)
    expect(result.hints).toContain("quantity_unknown")
    const check = result.check.map((s) => s.recipe.id)
    expect(check).toEqual(expect.arrayContaining(["chicken_teriyaki", "oyakodon", "tamagoyaki"]))
    const teriyaki = result.check.find((s) => s.recipe.id === "chicken_teriyaki")
    expect(teriyaki?.match.toCheck.map((l) => [l.ingredientId, l.reasons])).toEqual([
      ["chicken_thigh", ["quantity_unknown"]],
    ])
  })

  it("油・調味料を登録も常備品設定もしなければ、それらが必須の料理は「揃う」にならない", () => {
    const result = suggestNow(nowInput({ pantry, stapleIngredientIds: [] }))
    expect(result.readyTotal).toBe(0)
    const teriyaki = result.buy.find((s) => s.recipe.id === "chicken_teriyaki")
    expect(teriyaki?.match.missing.map((l) => l.ingredientId).sort()).toEqual(
      ["mirin", "sake", "salad_oil", "soy_sauce", "sugar"],
    )
    for (const line of teriyaki?.match.missing ?? []) expect(line.reasons).toEqual(["not_in_pantry"])
    // 油だけを常備品にしても、しょうゆ等が無ければ揃わない（一部の設定で全部を満たした扱いにしない）
    const oilOnly = suggestNow(nowInput({ pantry, stapleIngredientIds: ["salad_oil"] }))
    expect(oilOnly.ready.map((s) => s.recipe.id)).not.toContain("chicken_teriyaki")
    // 実カタログのどの料理も、在庫と常備品が空なら揃わない（暗黙の常備品が無い）
    const nothing = suggestNow(nowInput({ pantry: [], stapleIngredientIds: [], roles: ALL_ROLES }))
    expect(nothing.readyTotal).toBe(0)
    expect(nothing.checkTotal).toBe(0)
    expect(nothing.buyTotal).toBe(RECIPES.length)
  })

  it("E2E ④ の前提: ほうれん草 1 束・しょうゆ 大さじ 2・かつお節 5g だけで、ほうれん草のおひたし（副菜）が揃い、表示の 3 件に入る", () => {
    const pantry = [
      stockByName("ほうれん草", q(1, "bunch")),
      stockByName("しょうゆ", q(2, "tbsp"), { storage: "pantry" }),
      stockByName("かつお節", q(5, "g"), { storage: "pantry" }),
    ]
    const result = suggestNow(nowInput({ pantry, limit: undefined }))
    expect(result.ready.map((s) => s.recipe.id)).toContain("spinach_ohitashi")
    expect(result.ready.find((s) => s.recipe.id === "spinach_ohitashi")?.recipe.role).toBe("side")
    // かつお節が無ければ、買い足せば作れる（表示の 3 件）に入り、足りないのはかつお節だけ
    const withoutBonito = suggestNow(nowInput({ pantry: pantry.slice(0, 2), limit: undefined }))
    const ohitashi = withoutBonito.buy.find((s) => s.recipe.id === "spinach_ohitashi")
    expect(withoutBonito.buy.map((s) => s.recipe.id), JSON.stringify(withoutBonito.buy.map((s) => s.recipe.id))).toContain(
      "spinach_ohitashi",
    )
    expect(ohitashi?.match.missing.map((line) => line.ingredientId)).toEqual(["katsuobushi"])
  })

  it("g で登録した調味料は、小さじ・大さじの必要量と比べられないので「揃う」と言わず確認へ回す", () => {
    const withSalt = [
      stockByName("鮭", q(2, "slice")),
      stockByName("塩", q(500, "g"), { storage: "pantry" }),
      stockByName("こめ油", q(600, "g"), { storage: "pantry" }),
    ]
    const result = suggestNow(nowInput({ pantry: withSalt }))
    const shioyaki = result.check.find((s) => s.recipe.id === "salmon_shioyaki")
    expect(shioyaki?.match.toCheck.map((l) => [l.ingredientId, l.reasons])).toEqual([
      ["salt", ["unit_mismatch"]],
      ["rice_oil", ["unit_mismatch"]],
    ])
    // 対照: 常備品に設定すれば揃う
    const asStaple = suggestNow(nowInput({ pantry: withSalt.slice(0, 1), stapleIngredientIds: ["salt", "rice_oil"] }))
    expect(asStaple.ready.map((s) => s.recipe.id)).toContain("salmon_shioyaki")
  })

  it("期限を過ぎた食材・使い切った食材は材料に数えない（当日までは使える）", () => {
    const withExpiry = (expiresOn: string) =>
      pantry.map((p) => (p.ingredientId === "chicken_thigh" ? { ...p, expiresOn } : p))
    const expired = suggestNow(nowInput({ pantry: withExpiry("2026-11-15"), stapleIngredientIds: HOUSE_STAPLES }))
    expect(expired.ready.map((s) => s.recipe.id)).not.toContain("chicken_teriyaki")
    expect(expired.ready.map((s) => s.recipe.id)).not.toContain("oyakodon")
    const teriyaki = expired.buy.find((s) => s.recipe.id === "chicken_teriyaki")
    expect(teriyaki?.match.missing.map((l) => [l.ingredientId, l.reasons])).toEqual([["chicken_thigh", ["expired"]]])
    // 期限超過への加点もしない
    expect(teriyaki?.score.expiring).toBe(0)
    // 対照: 期限が今日なら使える（期限が近い食材として上がる）
    const today = suggestNow(nowInput({ pantry: withExpiry(TODAY), stapleIngredientIds: HOUSE_STAPLES }))
    const fresh = today.ready.find((s) => s.recipe.id === "chicken_teriyaki")
    expect(fresh?.match.expiringSoonCount).toBe(1)
    // 使い切った
    const usedUp = pantry.map((p) => (p.ingredientId === "egg" ? { ...p, status: "out" as const } : p))
    const out = suggestNow(nowInput({ pantry: usedUp, stapleIngredientIds: HOUSE_STAPLES }))
    expect(out.ready.map((s) => s.recipe.id)).not.toContain("tamagoyaki")
    expect(out.buy.find((s) => s.recipe.id === "tamagoyaki")?.match.missing[0]?.reasons).toEqual(["used_up"])
  })

  it("在庫が空なら「揃う」は 0 件。黙って緩めず、買い足し案は別枠で不足を明示する", () => {
    const result = suggestNow(nowInput({ pantry: [], stapleIngredientIds: HOUSE_STAPLES, limit: undefined }))
    expect(result.ready).toEqual([])
    expect(result.readyTotal).toBe(0)
    expect(result.check).toEqual([])
    expect(result.hints).toContain("pantry_empty")
    expect(result.buy).toHaveLength(3)
    expect(result.buyTotal).toBeGreaterThan(3)
    for (const suggestion of result.buy) {
      expect(suggestion.level).toBe("buy")
      expect(suggestion.match.missing.length).toBeGreaterThan(0)
      for (const line of suggestion.match.missing) expect(line.shortBy?.amount ?? 0).toBeGreaterThan(0)
    }
  })
})

// ── 4. 在庫の引当と使い切り（週間献立） ────────────────────────────

describe("C-26 / C-34 / C-35 実カタログの週間献立と在庫", () => {
  it("同じ在庫を 2 日へ二重に配らない。足りない分は買い物へ回り、計画だけでは実在庫を変えない", () => {
    const pantry = [stockByName("鶏もも", q(300, "g"))]
    const snapshot = structuredClone(pantry)
    const entries = [
      entryFor("e-mon", MONDAY, "chicken_teriyaki", { pinned: true }),
      entryFor("e-tue", TUESDAY, "chicken_daikon_simmer", { pinned: true }),
    ]
    const plan = reviewPlan(planInput({ existingEntries: entries, pantry, stapleIngredientIds: HOUSE_STAPLES }))
    const chicken = plan.allocations.filter((a) => a.ingredientId === "chicken_thigh")
    expect(chicken.map((a) => [a.date, a.quantity])).toEqual([[MONDAY, q(300, "g")]])
    const tuesday = plan.entries.find((e) => e.id === "e-tue")
    expect(tuesday?.stock?.missing.find((l) => l.ingredientId === "chicken_thigh")).toMatchObject({
      reasons: ["allocated"],
      shortBy: q(250, "g"),
    })
    expect(pantry).toEqual(snapshot)
    const grocery = buildGroceryNeeds({
      entries,
      from: MONDAY,
      to: SUNDAY,
      pantry,
      stapleIngredientIds: HOUSE_STAPLES,
      catalog: CATALOG,
    })
    expect(grocery.needs.find((n) => n.ingredientId === "chicken_thigh")).toMatchObject({
      gross: q(550, "g"),
      fromStock: q(300, "g"),
      required: q(250, "g"),
    })
    expect(pantry).toEqual(snapshot)
  })

  it("在庫で作れる料理・早く使いたい食材を使う料理を、初日に置く", () => {
    const pantry = [
      stockByName("さば", q(2, "slice"), { useSoon: true }),
      stockByName("しょうが", q(2, "clove")),
    ]
    const staples = [...HOUSE_STAPLES, "miso"]
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = generatePlan(planInput({ pantry, stapleIngredientIds: staples, options: { seed } }))
      expect(onDate(plan, MONDAY).find((e) => e.role === "main")).toMatchObject({
        recipeId: "mackerel_miso",
        stock: { level: "ready" },
      })
    }
    // 対照: その在庫が無ければ、さばのみそ煮は初日に来ない
    const without = generatePlan(planInput({ stapleIngredientIds: staples }))
    expect(onDate(without, MONDAY).find((e) => e.role === "main")?.recipeId).not.toBe("mackerel_miso")
  })

  it("在庫利用は偏りの回避より優先する: 在庫で揃う豚肉料理が 2 つあれば、連日でも先に使う", () => {
    const pantry = [
      stockByName("豚ロース", q(250, "g")),
      stockByName("豚バラ", q(200, "g")),
      stockByName("白菜", q(300, "g")),
      stockByName("玉ねぎ", q(1, "piece")),
      // 副菜（冷ややっこ等）がしょうがを先に使っても、2 つの主菜の分が残る量
      stockByName("しょうが", q(6, "clove")),
    ]
    const staples = [...HOUSE_STAPLES, "rice_oil", "katakuriko"]
    const plan = generatePlan(planInput({ pantry, stapleIngredientIds: staples }))
    const firstTwo = [MONDAY, TUESDAY].map((date) => onDate(plan, date).find((e) => e.role === "main"))
    expect(firstTwo.map((e) => e?.recipeId).sort()).toEqual(["ginger_pork", "pork_napa_shio_stir_fry"])
    for (const entry of firstTwo) expect(entry?.stock?.level).toBe("ready")
    // 3 日目以降（在庫で揃う料理が無い）は、連日の豚肉を避ける
    const wednesday = onDate(plan, WEDNESDAY).find((e) => e.role === "main")
    expect(mainProteinKey(recipeOf(wednesday?.recipeId ?? null), CATALOG)).not.toBe("tag:pork")
  })

  it("期限のある食材は、食べる日が期限内の枠にだけ引き当てる", () => {
    const salmon = stockByName("鮭", q(2, "slice"), { expiresOn: TUESDAY })
    const staples = [...HOUSE_STAPLES, "rice_oil", "butter"]
    const plan = generatePlan(planInput({ pantry: [salmon], stapleIngredientIds: staples }))
    const used = plan.allocations.filter((a) => a.pantryItemId === salmon.id)
    expect(used.length).toBeGreaterThan(0)
    for (const allocation of used) expect(allocation.date <= TUESDAY, allocation.date).toBe(true)
    // 対照: 期限の後から始まる献立では、その在庫を 1 件も引き当てない
    const later = generatePlan(
      planInput({ startDate: WEDNESDAY, today: TODAY, pantry: [salmon], stapleIngredientIds: staples }),
    )
    expect(later.allocations.filter((a) => a.pantryItemId === salmon.id)).toEqual([])
  })
})

// ── 5. 性質テスト: 全アレルゲン × 全レシピ ─────────────────────────

describe("V-C4 / C-53 / C-54 性質: アレルギー登録したアレルゲンは、どの出力にも現れない", () => {
  /** 特定原材料（表示義務）と大豆。この世帯でも 7 日分が組めることを目標にする。 */
  const TARGETS = [...ALLERGENS.filter((a) => a.tier === "mandatory").map((a) => a.id), "soybean"]

  /** 独立した突き合わせでの「自動で確定してよい候補」。 */
  const autoCandidates = (role: DishRole, allergenIds: readonly string[]) =>
    RECIPES.filter(
      (r) => r.role === role && !hasVaries(r) && allergenIds.every((id) => !allergensOf(r).has(id)),
    )

  it("対照: 除外が無ければ、アレルゲンを含む料理も原材料が商品で変わる料理も候補に出る", () => {
    const result = suggestNow(nowInput({ stapleIngredientIds: EVERY_INGREDIENT, roles: ALL_ROLES }))
    expect(result.readyTotal).toBe(RECIPES.length)
    expect(result.labelCheck).toEqual([])
    expect(result.excludedCount).toBe(0)
    for (const allergenId of ["wheat", "egg", "milk", "soybean", "shrimp", "sesame", "pork"]) {
      expect(RECIPES.some((r) => allergensOf(r).has(allergenId)), allergenId).toBe(true)
    }
    expect(RECIPES.some(hasVaries)).toBe(true)
  })

  it.each(ALLERGENS.map((a) => [a.id, a.name] as const))(
    "%s（%s）: 献立にも在庫提案にも、含む料理・確かめられない料理が 1 つも出ない",
    (allergenId) => {
      const exclusions = [allergy(allergenId)]
      const containing = RECIPES.filter((r) => allergensOf(r).has(allergenId))
      const unverifiable = RECIPES.filter((r) => !allergensOf(r).has(allergenId) && hasVaries(r))
      const expectClean = (recipe: RecipeDef, where: string) => {
        expect(allergensOf(recipe).has(allergenId), `${where}: ${recipe.id}`).toBe(false)
        expect(hasVaries(recipe), `${where}: ${recipe.id}`).toBe(false)
      }

      // 週間献立（主食・汁物つき、種を変えて）
      for (const seed of [undefined, 1, 2]) {
        const plan = generatePlan(
          planInput({
            exclusions,
            stapleIngredientIds: ALL_STAPLE_CANDIDATES,
            options: { includeStaple: true, includeSoup: true, seed },
          }),
        )
        for (const entry of plan.entries) expectClean(recipeOf(entry.recipeId), "plan")
        expectEverySlotAccounted(plan, ALL_ROLES)
        expect(plan.conflicts).toEqual([])
      }

      // 在庫提案: 何でも揃っている世帯と、在庫が空の世帯
      for (const stapleIngredientIds of [EVERY_INGREDIENT, []]) {
        const result = suggestNow(nowInput({ exclusions, stapleIngredientIds, roles: ALL_ROLES }))
        const shown = shownRecipes(result)
        for (const recipe of shown) expectClean(recipe, "suggestNow")
        // 含む料理は全て除外として数え、確かめられない料理は全て別枠へ出す（黙って消さない）
        expect(result.excludedCount).toBe(containing.length)
        expect(result.labelCheck.map((l) => l.recipe.id).sort()).toEqual(unverifiable.map((r) => r.id).sort())
        expect(shown.length + result.labelCheck.length + result.excludedCount).toBe(RECIPES.length)
      }
    },
  )

  it("派生品・調味料まで判定する: 卵 → マヨネーズ、小麦 → しょうゆ、乳 → バター、大豆 → みそ・サラダ油", () => {
    const blocked = (allergenId: string) =>
      partitionRecipes(CATALOG.recipes, buildExclusionSet([allergy(allergenId)], CATALOG)).blocked.map((r) => r.id)
    expect(blocked("egg")).toEqual(expect.arrayContaining(["potato_salad", "tamagoyaki", "oyakodon"]))
    expect(blocked("wheat")).toEqual(expect.arrayContaining(["chicken_teriyaki", "kake_udon", "cod_meuniere"]))
    expect(blocked("milk")).toEqual(expect.arrayContaining(["salmon_foil_bake", "chicken_cream_stew"]))
    expect(blocked("soybean")).toEqual(expect.arrayContaining(["mackerel_miso", "tamagoyaki", "hiyayakko"]))
    // 対照: 塩味の料理は残る
    for (const allergenId of ["egg", "wheat", "milk", "soybean"]) {
      expect(blocked(allergenId), allergenId).not.toContain("salmon_shioyaki")
    }
  })

  it.each(TARGETS)("%s のアレルギーでも、主菜・副菜の自動候補がそれぞれ 7 件以上残る", (allergenId) => {
    const set = buildExclusionSet([allergy(allergenId)], CATALOG)
    for (const role of ["main", "side"] as const) {
      const allowed = partitionRecipes(CATALOG.recipes.filter((r) => r.role === role), set).allowed.map((r) => r.id)
      // 実装の判定と、独立した突き合わせが一致する
      expect(allowed.sort()).toEqual(autoCandidates(role, [allergenId]).map((r) => r.id).sort())
      expect(allowed.length, `${allergenId} ${role}`).toBeGreaterThanOrEqual(7)
    }
  })

  it.each(TARGETS)("%s のアレルギーでも、7 日分の主菜・副菜が不足なく組める", (allergenId) => {
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = generatePlan(planInput({ exclusions: [allergy(allergenId)], options: { seed } }))
      expect(plan.gaps, `${allergenId} seed=${seed}`).toEqual([])
      expect(plan.entries).toHaveLength(14)
    }
  })

  it("候補の件数を固定する（データを変えて減ったら気づけるように）: 小麦・大豆の主菜 / 副菜 / 汁物", () => {
    const count = (allergenIds: readonly string[]) =>
      (["main", "side", "soup", "staple"] as const).map((role) => autoCandidates(role, allergenIds).length)
    expect(count(["wheat"])).toEqual([10, 9, 5, 2])
    expect(count(["soybean"])).toEqual([9, 8, 2, 2])
    expect(count(["wheat", "soybean"])).toEqual([8, 8, 2, 2])
    expect(count(["egg", "milk", "wheat"])).toEqual([9, 9, 5, 2])
  })

  it("主要なアレルゲンを重ねても、除外を破らずに不足枠と理由を返す（落ちない・止まる）", () => {
    const combos: readonly (readonly string[])[] = [
      ["egg", "milk", "wheat"],
      ["egg", "milk", "wheat", "soybean"],
      ["egg", "milk", "wheat", "soybean", "chicken", "pork", "beef"],
      ALLERGENS.map((a) => a.id),
    ]
    for (const combo of combos) {
      const exclusions = combo.map((id) => allergy(id))
      const plan = generatePlan(
        planInput({ exclusions, stapleIngredientIds: ALL_STAPLE_CANDIDATES, options: { includeStaple: true, includeSoup: true } }),
      )
      for (const entry of plan.entries) {
        const recipe = recipeOf(entry.recipeId)
        for (const id of combo) expect(allergensOf(recipe).has(id), `${recipe.id} ← ${id}`).toBe(false)
        expect(hasVaries(recipe), recipe.id).toBe(false)
      }
      expectEverySlotAccounted(plan, ALL_ROLES)
      for (const role of ALL_ROLES) {
        const candidates = autoCandidates(role, combo).length
        const gaps = plan.gaps.filter((g) => g.role === role)
        if (candidates >= 7) expect(gaps, `${combo.length}: ${role}`).toEqual([])
        for (const gap of gaps) {
          expect(["exhausted", "needs_label_check", "all_excluded"]).toContain(gap.reason)
          expect(gap.reason === "exhausted").toBe(candidates > 0)
        }
      }
      // 在庫提案も同じ規則
      const now = suggestNow(nowInput({ exclusions, stapleIngredientIds: EVERY_INGREDIENT, roles: ALL_ROLES }))
      for (const recipe of shownRecipes(now)) {
        for (const id of combo) expect(allergensOf(recipe).has(id), `${recipe.id} ← ${id}`).toBe(false)
      }
    }
    // 全品目を除外すると主菜は足りなくなる（その状況でも上の検査を通っている）
    const everything = generatePlan(planInput({ exclusions: ALLERGENS.map((a) => allergy(a.id)) }))
    expect(everything.gaps.filter((g) => g.role === "main").length).toBeGreaterThan(0)
  })

  it("希望や好みでは除外を緩めない: カレーの固定は採用せず、優先に挙げた料理も選ばない", () => {
    // 小麦アレルギー: カレールウは小麦を含む → 除外
    const wheat = generatePlan(
      planInput({
        exclusions: [allergy("wheat")],
        wish: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: [], avoidTags: [], maxMinutes: null, preferRecipeIds: ["chicken_teriyaki"] },
        preferences: [{ id: "pf1", scope: "household", profileId: null, target: { kind: "recipe", id: "chicken_teriyaki" }, sentiment: "like" }],
      }),
    )
    expect(wheat.rejectedPins).toEqual([{ date: FRIDAY, recipeId: "curry_rice", reason: "excluded" }])
    expect(wheat.entries.map((e) => e.recipeId)).not.toContain("curry_rice")
    expect(wheat.entries.map((e) => e.recipeId)).not.toContain("chicken_teriyaki")
    // えびアレルギー: ルウは商品で原材料が変わる → 確かめられないので自動では固定しない
    const shrimp = generatePlan(
      planInput({
        exclusions: [allergy("shrimp")],
        wish: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: [], avoidTags: [], maxMinutes: null, preferRecipeIds: [] },
      }),
    )
    expect(shrimp.rejectedPins).toEqual([{ date: FRIDAY, recipeId: "curry_rice", reason: "needs_label_check" }])
    // 希望の解釈には除外を適用した候補だけを渡す → 「金曜はカレー」は解釈できない希望として返る
    const allowed = partitionRecipes(CATALOG.recipes, buildExclusionSet([allergy("wheat")], CATALOG)).allowed
    const parsed = parseWish({ text: "金曜はカレー", startDate: MONDAY, days: 7, today: TODAY, recipes: allowed })
    expect(parsed.constraints.pins).toEqual([])
    expect(parsed.unparsed).toEqual(["金曜はカレー"])
  })
})

// ── 6. 苦手・家族 2 人 ─────────────────────────────────────────────

describe("V-C4 / C-52 / C-53 苦手として登録した食材と、家族の異なる除外", () => {
  function expectNowhere(exclusions: readonly FoodExclusion[], banned: (recipe: RecipeDef) => boolean, servings = 2): void {
    for (const seed of [undefined, 1, 2, 3]) {
      const plan = generatePlan(
        planInput({
          exclusions,
          servings,
          stapleIngredientIds: ALL_STAPLE_CANDIDATES,
          options: { includeStaple: true, includeSoup: true, seed },
        }),
      )
      for (const entry of plan.entries) expect(banned(recipeOf(entry.recipeId)), `plan: ${entry.recipeId}`).toBe(false)
      expectEverySlotAccounted(plan, ALL_ROLES)
    }
    for (const stapleIngredientIds of [EVERY_INGREDIENT, []]) {
      const result = suggestNow(nowInput({ exclusions, servings, stapleIngredientIds, roles: ALL_ROLES }))
      for (const recipe of shownRecipes(result)) expect(banned(recipe), `suggestNow: ${recipe.id}`).toBe(false)
      for (const { recipe } of result.labelCheck) expect(banned(recipe), `labelCheck: ${recipe.id}`).toBe(false)
      expect(result.excludedCount).toBe(RECIPES.filter(banned).length)
    }
  }

  it("ピーマン・なす・きのこ（自由入力）を苦手に登録すると、必須でも任意でも材料に現れない", () => {
    const exclusions: FoodExclusion[] = [
      dislikeIngredient("green_pepper"),
      dislikeIngredient("eggplant"),
      { id: "x-kinoko", reason: "dislike", target: { kind: "custom", label: "きのこ" }, subject: { kind: "household" } },
    ]
    const set = buildExclusionSet(exclusions, CATALOG)
    // 「きのこ」は辞書の総称へ解決し、名前の一致だけに頼らない
    expect(set.limited).toEqual([])
    // きのこは辞書の由来（derivedFrom）に頼らず、ここで名指しする（辞書の由来が欠けたら出力の検査で気づく）
    const bannedIds = new Set([
      "green_pepper", "eggplant", "mushroom",
      "shiitake", "shimeji", "enoki", "maitake", "eringi", "dried_shiitake",
    ])
    const banned = (recipe: RecipeDef) => usesAny(recipe, bannedIds)
    // 対照: 該当する料理が実在する（しめじ・エリンギ・干ししいたけ等は「きのこ」に由来する）
    expect(RECIPES.filter(banned).map((r) => r.id)).toEqual(
      expect.arrayContaining([
        "pork_cabbage_miso_stir_fry",
        "eggplant_pepper_miso_stir_fry",
        "salmon_foil_bake",
        "tofu_steak_mushroom",
        "chicken_mushroom_takikomi",
        "mushroom_saute",
        "beef_pepper_shio_stir_fry",
      ]),
    )
    for (const id of ["shiitake", "shimeji", "enoki", "maitake", "eringi", "dried_shiitake"]) {
      expect(lineage(id).map((d) => d.id), id).toContain("mushroom")
    }
    expectNowhere(exclusions, banned)
    // 苦手だけの世帯では、原材料が商品で変わる料理（カレー）を確認待ちにしない
    const now = suggestNow(nowInput({ exclusions, stapleIngredientIds: EVERY_INGREDIENT }))
    expect(now.labelCheck).toEqual([])
    expect(shownRecipes(now).map((r) => r.id)).toContain("curry_rice")
  })

  it("任意の材料として使う料理も外す（ブロッコリーが任意のシチュー、キャベツを添えるしょうが焼き）", () => {
    const optionalUse = (recipeId: string, ingredientId: string) =>
      recipeOf(recipeId).ingredients.find((i) => i.ingredientId === ingredientId)?.optional
    expect(optionalUse("chicken_cream_stew", "broccoli")).toBe(true)
    expect(optionalUse("ginger_pork", "cabbage")).toBe(true)
    const exclusions = [dislikeIngredient("broccoli"), dislikeIngredient("cabbage")]
    const banned = (recipe: RecipeDef) => usesAny(recipe, new Set(["broccoli", "cabbage"]))
    expect(banned(recipeOf("chicken_cream_stew"))).toBe(true)
    expect(banned(recipeOf("ginger_pork"))).toBe(true)
    expectNowhere(exclusions, banned)
  })

  it("家族 2 人が別々の除外（1 人は卵アレルギー、1 人はえびが苦手）を持つとき、どちらも現れない。人数や名義で変わらない", () => {
    const perMember: FoodExclusion[] = [
      allergy("egg", "x-egg", { kind: "member", profileId: "profile-a" }),
      dislikeIngredient("shrimp", { kind: "member", profileId: "profile-b" }),
    ]
    const banned = (recipe: RecipeDef) =>
      allergensOf(recipe).has("egg") || usesAny(recipe, new Set(["shrimp"])) || hasVaries(recipe)
    // 対照: 卵は派生品（マヨネーズ）でも、えびは主菜として実在する
    expect(allergensOf(recipeOf("potato_salad")).has("egg")).toBe(true)
    expect(usesAny(recipeOf("shrimp_broccoli_shio_stir_fry"), new Set(["shrimp"]))).toBe(true)
    for (const servings of [1, 2, 5]) {
      for (const seed of [undefined, 1, 2]) {
        const plan = generatePlan(
          planInput({ exclusions: perMember, servings, options: { includeStaple: true, includeSoup: true, seed } }),
        )
        for (const entry of plan.entries) expect(banned(recipeOf(entry.recipeId)), entry.recipeId ?? "").toBe(false)
        expect(plan.gaps).toEqual([])
      }
      const now = suggestNow(nowInput({ exclusions: perMember, servings, stapleIngredientIds: EVERY_INGREDIENT, roles: ALL_ROLES }))
      for (const recipe of shownRecipes(now)) expect(banned(recipe), recipe.id).toBe(false)
    }
    // 誰の除外かを世帯共通へ付け替えても、片方だけを渡した結果とは違い、両方を渡した結果と同じ
    const asHousehold = perMember.map((e) => ({ ...e, subject: { kind: "household" as const } }))
    expect(idsOf(generatePlan(planInput({ exclusions: asHousehold })), "main")).toEqual(
      idsOf(generatePlan(planInput({ exclusions: perMember })), "main"),
    )
    // 片方だけ（ログイン本人の分だけ）では、もう一方の除外が守られない = 和集合が必要
    const onlyA = suggestNow(nowInput({ exclusions: [perMember[0]], stapleIngredientIds: EVERY_INGREDIENT }))
    expect(shownRecipes(onlyA).map((r) => r.id)).toContain("shrimp_broccoli_shio_stir_fry")
  })
})

// ── 7. 買い物 ──────────────────────────────────────────────────────

describe("V-C3 / C-41〜C-46 実カタログの献立から買い物リストを作る", () => {
  const plan = generatePlan(planInput({ options: { includeStaple: true, includeSoup: true } }))
  const confirmed = saved(plan, "confirmed")
  const input = (entries: readonly PlanEntry[], pantry: readonly PantryItem[] = []) => ({
    entries,
    from: MONDAY,
    to: SUNDAY,
    pantry,
    today: TODAY,
    catalog: CATALOG,
  })
  const numericMap = (needs: readonly GroceryNeedDetail[]): Map<string, number> => {
    const map = new Map<string, number>()
    for (const need of needs) {
      if (need.required === null || need.required.amount === null) continue
      map.set(`${need.ingredientId}|${need.required.unit}`, need.required.amount)
    }
    return map
  }

  it("7 日分を確定して展開すると、必須材料の合計と一致する（在庫なし・常備品の設定なし）", () => {
    expect(plan.gaps).toEqual([])
    const result = buildGroceryNeeds(input(confirmed))
    expect(result.uncomputed).toEqual([])
    expect(result.covered).toEqual([])
    expect(result.stapleAssumed).toEqual([])
    expect(result.versionMismatches).toEqual([])
    const expected = expandNaively(confirmed)
    const actual = numericMap(result.needs)
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
    for (const [key, amount] of expected) expect(actual.get(key), key).toBeCloseTo(amount, 6)
    // 必須材料は全て載り、任意だけの材料は載らない
    const required = new Set(
      confirmed.flatMap((e) => recipeOf(e.recipeId).ingredients.filter((i) => i.optional !== true).map((i) => i.ingredientId)),
    )
    expect(new Set(result.needs.map((n) => n.ingredientId))).toEqual(required)
    // 同じ鍵の項目は 1 つだけ
    expect(new Set(result.needs.map((n) => n.itemKey)).size).toBe(result.needs.length)
  })

  it("提案のまま（未確定）の献立からは買い物を作らない", () => {
    expect(buildGroceryNeeds(input(saved(plan))).needs).toEqual([])
  })

  it("品目から、どの日のどの料理に必要かが分かる", () => {
    const result = buildGroceryNeeds(input(confirmed))
    for (const need of result.needs) {
      expect(need.sources.length, need.itemKey).toBeGreaterThan(0)
      for (const source of need.sources) {
        const entry = confirmed.find((e) => e.date === source.date && e.recipeId === source.recipeId)
        expect(entry, `${need.itemKey} ← ${source.title}`).toBeDefined()
        const recipe = recipeOf(source.recipeId)
        expect(source.title).toBe(recipe.title)
        expect(recipe.ingredients.some((i) => i.ingredientId === need.ingredientId && i.optional !== true)).toBe(true)
      }
    }
  })

  it("同じ計画で 2 回計算しても同一で、入力を変えない", () => {
    const snapshot = structuredClone(confirmed)
    const once = buildGroceryNeeds(input(confirmed))
    expect(buildGroceryNeeds(input(confirmed))).toEqual(once)
    expect(confirmed).toEqual(snapshot)
  })

  it("人数を 2 → 4 にすると数値の量がちょうど 2 倍（元レシピの量から一度だけ計算）。適量・少々は変わらない", () => {
    const two = buildGroceryNeeds(input(confirmed))
    const four = buildGroceryNeeds(input(confirmed.map((e) => ({ ...e, servings: 4 }))))
    expect(four.needs.map((n) => n.itemKey)).toEqual(two.needs.map((n) => n.itemKey))
    let numeric = 0
    for (const need of two.needs) {
      const doubled = four.needs.find((n) => n.itemKey === need.itemKey)
      expect(doubled?.nonNumeric).toEqual(need.nonNumeric)
      if (need.required === null || need.required.amount === null) {
        expect(doubled?.required).toBeNull()
        continue
      }
      numeric += 1
      expect(doubled?.required?.unit).toBe(need.required.unit)
      expect(doubled?.required?.amount, need.itemKey).toBeCloseTo(need.required.amount * 2, 6)
    }
    expect(numeric).toBeGreaterThan(10)
    // 4 人分を計算した後で 2 人分を計算し直しても、最初と同じ（結果を掛け直していない）
    expect(buildGroceryNeeds(input(confirmed))).toEqual(two)
    // 対照: 3 人分は 1.5 倍
    const three = buildGroceryNeeds(input(confirmed.map((e) => ({ ...e, servings: 3 }))))
    const sample = two.needs.find((n) => n.required !== null && n.required.amount !== null) as GroceryNeedDetail
    expect(three.needs.find((n) => n.itemKey === sample.itemKey)?.required?.amount).toBeCloseTo(
      (sample.required?.amount ?? 0) * 1.5,
      6,
    )
  })

  it("在庫は一度だけ差し引く: 2 つの料理が同じ食材を使っても、同じ在庫を二重に引かない", () => {
    const entries = [
      entryFor("g1", MONDAY, "nikujaga"),
      entryFor("g2", TUESDAY, "curry_rice"),
      entryFor("g3", WEDNESDAY, "ginger_pork"),
    ]
    const pantry = [stockByName("豚こま", q(250, "g")), stockByName("玉ねぎ", q(2, "piece"))]
    const result = buildGroceryNeeds(input(entries, pantry))
    // 豚こま: 150 + 200 = 350g。在庫 250g を一度だけ引いて 100g（二重に引くと 0 になる）
    expect(result.needs.find((n) => n.ingredientId === "pork_komagire")).toMatchObject({
      gross: q(350, "g"),
      fromStock: q(250, "g"),
      required: q(100, "g"),
      needsStockCheck: false,
    })
    // 玉ねぎ: 1 + 1 + 0.5 = 2.5 個。在庫 2 個を引いて 0.5 個
    expect(result.needs.find((n) => n.ingredientId === "onion")).toMatchObject({
      gross: q(2.5, "piece"),
      fromStock: q(2, "piece"),
      required: q(0.5, "piece"),
    })
    // 対照: 在庫が無ければ全量
    const none = buildGroceryNeeds(input(entries))
    expect(none.needs.find((n) => n.ingredientId === "pork_komagire")?.required).toEqual(q(350, "g"))
  })

  it("数量不明の在庫は差し引かず「在庫量を確認」を立てる。個数の必要量から g の在庫を引かない", () => {
    const entries = [entryFor("g1", MONDAY, "nikujaga")]
    const unknown = buildGroceryNeeds(input(entries, [stockByName("玉ねぎ", null)]))
    expect(unknown.needs.find((n) => n.ingredientId === "onion")).toMatchObject({
      required: q(1, "piece"),
      fromStock: q(0, "piece"),
      needsStockCheck: true,
    })
    const grams = buildGroceryNeeds(input(entries, [stockByName("玉ねぎ", q(400, "g"))]))
    expect(grams.needs.find((n) => n.ingredientId === "onion")).toMatchObject({
      required: q(1, "piece"),
      fromStock: q(0, "piece"),
      needsStockCheck: true,
    })
    // 対照: 在庫に登録が無い食材には確認を立てない
    expect(unknown.needs.find((n) => n.ingredientId === "potato")?.needsStockCheck).toBe(false)
  })

  it("個数と g を合算しない: 同じ食材でも単位の族が違えば別の項目のまま", () => {
    const manual: RecipeIngredient[] = [
      { ingredientId: "onion", quantity: q(200, "g") },
      { ingredientId: "pork_komagire", quantity: q(0.1, "kg") },
    ]
    const entries = [
      entryFor("g1", MONDAY, "nikujaga"),
      {
        ...entryFor("g2", TUESDAY, "nikujaga"),
        recipeId: null,
        recipeVersion: null,
        customTitle: "野菜炒め",
        customIngredients: manual,
      },
    ]
    const result = buildGroceryNeeds(input(entries))
    const onion = result.needs.filter((n) => n.ingredientId === "onion")
    expect(onion.map((n) => [n.itemKey, n.required]).sort()).toEqual([
      ["onion:count:piece", q(1, "piece")],
      ["onion:mass", q(200, "g")],
    ])
    // 対照: g と kg は同じ族なので合算する（150g + 0.1kg = 250g）
    expect(result.needs.filter((n) => n.ingredientId === "pork_komagire").map((n) => n.required)).toEqual([q(250, "g")])
  })

  it("売場ごとに、売場を回る順で返す。未知の売場・辞書に無い材料は「その他」に残す", () => {
    const result = buildGroceryNeeds(input(confirmed))
    const order = result.bySection.map((g) => STORE_SECTIONS.findIndex((s) => s.id === g.section))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.length).toBeGreaterThanOrEqual(4)
    expect(result.bySection.flatMap((g) => g.items).length).toBe(result.needs.length)
    for (const group of result.bySection) {
      expect(group.label).toBe(STORE_SECTION_LABELS[group.section])
      for (const item of group.items) {
        expect(item.section).toBe(group.section)
        expect(DEF.get(item.ingredientId)?.section, item.ingredientId).toBe(group.section)
      }
    }

    // 未知の売場の値を持つ食材（データが先に増えた場合）と、辞書に無い材料
    const withUnknownSection = toCatalogView({
      ingredients: INGREDIENTS.map((i) => (i.id === "kabocha" ? { ...i, section: "frozen" as unknown as StoreSection } : i)),
      recipes: RECIPES,
      allergens: ALLERGENS,
    })
    const entries = [
      entryFor("g1", MONDAY, "kabocha_simmer"),
      {
        ...entryFor("g2", MONDAY, "kabocha_simmer"),
        position: 1,
        recipeId: null,
        recipeVersion: null,
        customTitle: "おみやげの一品",
        customIngredients: [{ ingredientId: "not_in_dictionary", quantity: q(1, "pack") }],
      },
    ]
    const odd = buildGroceryNeeds({ ...input(entries), catalog: withUnknownSection })
    expect(odd.needs.find((n) => n.ingredientId === "kabocha")?.section).toBe("other")
    expect(odd.needs.find((n) => n.ingredientId === "not_in_dictionary")).toMatchObject({
      section: "other",
      name: "not_in_dictionary",
      required: q(1, "pack"),
    })
    const other = odd.bySection.find((g) => g.section === "other")
    expect(other?.label).toBe(STORE_SECTION_LABELS.other)
    expect(other?.items.map((i) => i.ingredientId)).toEqual(expect.arrayContaining(["kabocha", "not_in_dictionary"]))
    // 対照: 実カタログのままなら、かぼちゃは野菜売場
    expect(buildGroceryNeeds(input([entries[0]])).needs.find((n) => n.ingredientId === "kabocha")?.section).toBe("vegetable")
  })

  it("300g 購入後に必要量が 500g へ増えたら、残り 200g を未購入として示す。再計算で項目・手動入力を増やさず消さない", () => {
    const toExisting = (upserts: readonly GroceryUpsert[]): ExistingGroceryItem[] =>
      upserts.map((u, i) => ({
        id: u.id ?? `item-${String(i).padStart(3, "0")}`,
        itemKey: u.itemKey,
        name: u.name,
        section: u.section,
        sectionOverridden: false,
        required: u.required,
        purchased: u.purchased,
        restocked: u.restocked,
        checked: u.checked,
        note: u.note,
      }))
    const manual: ExistingGroceryItem = {
      id: "manual-1", itemKey: null, name: "牛乳", section: "egg_dairy", sectionOverridden: false,
      required: null, purchased: null, restocked: null, checked: false, note: "低脂肪",
    }

    // 肉じゃが 4 人分 → 豚こま 300g
    const first = [entryFor("g1", MONDAY, "nikujaga", { servings: 4 })]
    const needs1 = buildGroceryNeeds(input(first)).needs
    const merged1 = mergeWithExisting(needs1, [manual])
    const pork1 = merged1.upserts.find((u) => u.ingredientId === "pork_komagire")
    expect(pork1).toMatchObject({ id: null, required: q(300, "g"), remaining: q(300, "g"), checked: false })
    expect(merged1.manual).toEqual([manual])

    // 300g 買って、玉ねぎにメモを書いた
    const stored = [...toExisting(merged1.upserts), manual].map((item) => {
      if (item.itemKey === "pork_komagire:mass") return { ...item, purchased: q(300, "g"), checked: true }
      if (item.itemKey === "onion:count:piece") return { ...item, note: "新玉ねぎがあれば" }
      return item
    })
    const merged2 = mergeWithExisting(needs1, stored)
    expect(merged2.upserts.find((u) => u.ingredientId === "pork_komagire")).toMatchObject({
      remaining: q(0, "g"),
      checked: true,
    })
    // 同じ計画で突き合わせ直しても、項目は増えず内容も同じ（冪等）
    expect(merged2.upserts).toHaveLength(merged1.upserts.length)
    expect(mergeWithExisting(needs1, [...toExisting(merged2.upserts), manual]).upserts).toEqual(merged2.upserts)
    expect(merged2.removals).toEqual([])

    // カレー（2 人分・豚こま 200g）を足す → 必要量 500g
    const second = [...first, entryFor("g2", TUESDAY, "curry_rice")]
    const needs2 = buildGroceryNeeds(input(second)).needs
    const merged3 = mergeWithExisting(needs2, stored)
    const pork3 = merged3.upserts.filter((u) => u.ingredientId === "pork_komagire")
    expect(pork3).toHaveLength(1)
    expect(pork3[0]).toMatchObject({
      id: stored.find((s) => s.itemKey === "pork_komagire:mass")?.id,
      required: q(500, "g"),
      purchased: q(300, "g"),
      remaining: q(200, "g"),
      checked: false,
    })
    // メモ・手動項目は残る。鍵は重複しない
    expect(merged3.upserts.find((u) => u.itemKey === "onion:count:piece")?.note).toBe("新玉ねぎがあれば")
    expect(merged3.manual).toEqual([manual])
    expect(new Set(merged3.upserts.map((u) => u.itemKey)).size).toBe(merged3.upserts.length)
    expect(merged3.removals).toEqual([])
  })
})

// ── 8. 取り分け・年齢制約 ──────────────────────────────────────────

describe("V-C4 / C-62 / C-64 / C-65 取り分け案内と年齢制約（実カタログ）", () => {
  const child = (birthDate: string | null, mealStage: string | null): MealChild => ({ id: "child-1", birthDate, mealStage })
  // 2026-11-16 時点: 2024-05-01 生まれは 2 歳 6 か月、2026-08-01 は 3 か月、2026-03-01 は 8 か月
  const TODDLER_BIRTH = "2024-05-01"

  it("取り分けに対応するレシピが 3 件以上あり、2 歳以降の子には工程と注意が出る", () => {
    expect(CHILD_SERVING_RECIPES.length).toBeGreaterThanOrEqual(3)
    for (const recipe of CHILD_SERVING_RECIPES) {
      const byStage = resolveChildServing(recipe, child(TODDLER_BIRTH, "toddler"), TODAY, CATALOG.index)
      if (byStage.show === null) throw new Error(`${recipe.id}: ${byStage.reason}`)
      expect(byStage.basis).toBe("guardian_stage")
      expect(byStage.show.instructions.length, recipe.id).toBeGreaterThan(0)
      expect(byStage.show.cautions.length, recipe.id).toBeGreaterThan(0)
      expect(byStage.show.instructions[0]).toMatch(/取り分ける/u)
      // R27 / C-61 / C-64: 保護者が段階を設定していない子には、2 歳以上でも月齢だけからは出さない
      const byAge = resolveChildServing(recipe, child(TODDLER_BIRTH, null), TODAY, CATALOG.index)
      expect(byAge).toEqual({ show: null, reason: "未設定" })
    }
  })

  it("0 歳（離乳開始前・離乳期）・未設定・2 歳未満では出さず、理由を返す", () => {
    for (const recipe of CHILD_SERVING_RECIPES) {
      const reason = (birthDate: string | null, mealStage: string | null) => {
        const result = resolveChildServing(recipe, child(birthDate, mealStage), TODAY, CATALOG.index)
        return result.show === null ? result.reason : "表示"
      }
      expect(reason("2026-08-01", "not_started")).toBe("離乳開始前")
      expect(reason("2026-03-01", "weaning_mid")).toBe("対象月齢外")
      expect(reason("2025-09-01", "weaning_complete")).toBe("対象月齢外")
      expect(reason("2026-03-01", null)).toBe("対象月齢外")
      expect(reason(null, null)).toBe("未設定")
      expect(reason(null, "toddler")).toBe("未設定")
      expect(reason(TODDLER_BIRTH, "unknown_stage")).toBe("未設定")
      // 保護者が離乳期と設定していれば、2 歳を過ぎていても月齢で上書きしない
      expect(reason(TODDLER_BIRTH, "weaning_late")).toBe("対象月齢外")
      // 境界: 2 歳の誕生日から。前日は対象外
      expect(reason("2024-11-16", "toddler")).toBe("表示")
      expect(reason("2024-11-17", "toddler")).toBe("対象月齢外")
    }
  })

  it("対応していないレシピは、何歳の子にも「未対応」（一般案内があるだけで対応扱いにしない）", () => {
    const unsupported = RECIPES.filter((r) => r.childServing === undefined)
    expect(unsupported.length).toBeGreaterThan(CHILD_SERVING_RECIPES.length)
    for (const recipe of unsupported) {
      for (const birthDate of [TODDLER_BIRTH, "2021-04-01", "2026-08-01"]) {
        expect(resolveChildServing(recipe, child(birthDate, "toddler"), TODAY, CATALOG.index)).toEqual({
          show: null,
          reason: "未対応",
        })
      }
    }
  })

  it("はちみつを使う料理は、1 歳未満の子がいる世帯で警告する（1 歳以上には出さない）", () => {
    const infant: MealChild = { id: "infant", birthDate: "2026-01-16", mealStage: "weaning_late" }
    const oneYear: MealChild = { id: "one", birthDate: "2025-11-16", mealStage: "weaning_complete" }
    const unknownAge: MealChild = { id: "unknown", birthDate: null, mealStage: null }
    const warned = RECIPES.filter(
      (r) => findAgeRuleWarnings(r.ingredients, [infant], TODAY, CATALOG.index).length > 0,
    ).map((r) => r.id)
    expect(warned).toEqual(["sweet_potato_honey_lemon"])
    const honeyDish = recipeOf("sweet_potato_honey_lemon")
    const summary = summarizeChildServing(honeyDish, [infant, oneYear, unknownAge], TODAY, CATALOG.index)
    expect(summary.warnings).toEqual([
      {
        childId: "infant",
        ingredientId: "honey",
        ingredientName: "はちみつ",
        ruleIngredientId: "honey",
        minAgeMonths: 12,
        sourceId: "mhlw_honey_leaflet",
        ageUnknown: false,
      },
      expect.objectContaining({ childId: "unknown", ageUnknown: true }),
    ])
    // 取り分け案内としても出さない
    for (const row of summary.perChild) expect(row.result.show).toBeNull()
    // 対照: はちみつを使わない料理には警告が出ない
    expect(summarizeChildServing(recipeOf("nikujaga"), [infant], TODAY, CATALOG.index).warnings).toEqual([])
  })
})

// ── 9. 別名の衝突 ──────────────────────────────────────────────────

describe("C-22 食材辞書の別名（全辞書）", () => {
  /** 照合用に畳んだ名前 → その名前を持つ食材 ID（このファイル内で独立に作る）。 */
  const owners = new Map<string, Set<string>>()
  for (const def of INGREDIENTS) {
    for (const name of [def.name, ...def.aliases]) {
      const folded = foldName(name)
      owners.set(folded, (owners.get(folded) ?? new Set<string>()).add(def.id))
    }
  }

  it("正規化した後に、同じ文字列が 2 つの食材を指さない", () => {
    const collisions = [...owners].filter(([, ids]) => ids.size > 1).map(([name, ids]) => `${name}: ${[...ids].join("/")}`)
    expect(collisions).toEqual([])
    expect(buildIngredientIndex(INGREDIENTS).ambiguousNames.size).toBe(0)
    expect(owners.has("")).toBe(false)
  })

  it("全ての表示名・別名が、自分の食材へ解決する", () => {
    for (const def of INGREDIENTS) {
      for (const name of [def.name, ...def.aliases]) {
        expect(resolveIngredientId(name, CATALOG.index), name).toBe(def.id)
      }
    }
    // 表記ゆれ（全角・空白・カタカナ）も同じ食材へ
    expect(resolveIngredientId(" タマネギ ", CATALOG.index)).toBe("onion")
    expect(resolveIngredientId("玉　ねぎ", CATALOG.index)).toBe("onion")
    expect(resolveIngredientId("ｷｬﾍﾞﾂ", CATALOG.index)).toBe("cabbage")
  })

  it("部分文字列では解決しない: 名前の一部を入れても、その一部が辞書の名前でないかぎり未解決", () => {
    let checked = 0
    for (const [folded] of owners) {
      const chars = [...folded]
      for (let start = 0; start < chars.length; start += 1) {
        for (let end = start + 1; end <= chars.length; end += 1) {
          if (start === 0 && end === chars.length) continue
          const part = chars.slice(start, end).join("")
          const resolved = resolveIngredientId(part, CATALOG.index)
          const exact = owners.get(part)
          checked += 1
          if (exact === undefined) expect(resolved, `${folded} の一部「${part}」`).toBeNull()
          else expect([...exact], `${folded} の一部「${part}」`).toEqual([resolved])
        }
      }
    }
    expect(checked).toBeGreaterThan(3000)
  })

  it("「豚」「鶏」「牛」などの一語や総称では、部位・加工品へ解決しない", () => {
    for (const word of ["豚", "鶏", "牛", "肉", "魚", "ねぎ", "豆腐", "ひき肉", "油", "チーズ", "缶", "こま", "バラ", "もも肉", "ごま油とごま"]) {
      expect(resolveIngredientId(word, CATALOG.index), word).toBeNull()
    }
    // 総称は総称の ID（部位とは別）
    expect(resolveIngredientId("豚肉", CATALOG.index)).toBe("pork")
    expect(resolveIngredientId("豚こま", CATALOG.index)).toBe("pork_komagire")
    expect(resolveIngredientId("豚バラ", CATALOG.index)).toBe("pork_belly_slice")
    // 「ツナ」はツナ缶の呼び名として解決する。まぐろとは別の食材
    expect(resolveIngredientId("ツナ", CATALOG.index)).toBe("tuna_can")
    expect(resolveIngredientId("ツナ", CATALOG.index)).not.toBe(resolveIngredientId("まぐろ", CATALOG.index))
    expect(resolveIngredientId("まぐろ", CATALOG.index)).toBe("tuna")
    // 在庫に総称で入れても、部位を使う料理の材料には数えない
    const generic = suggestNow(nowInput({ pantry: [stockByName("鶏肉", q(300, "g"))], stapleIngredientIds: HOUSE_STAPLES }))
    expect(generic.ready.map((s) => s.recipe.id)).not.toContain("chicken_teriyaki")
  })
})

// ── 10. 評価の反映 ─────────────────────────────────────────────────

describe("C-74 / C-52 保存した評価が次の提案と献立へ反映される", () => {
  /** 評価を付ける料理。評価が無いときの順位が先頭でも末尾でもないもの（上下どちらへも動ける）。 */
  const TARGET = "mackerel_miso"
  const feedback = (overrides: Partial<DishFeedback>): DishFeedback => ({
    id: "fb-1",
    profileId: "profile-a",
    recipeId: TARGET,
    eatenOn: "2026-11-10",
    taste: null,
    effort: null,
    again: null,
    excludeFromLearning: false,
    ...overrides,
  })
  // 全ての料理が揃う条件にして、順位が好みと時間だけで決まるようにする
  const order = (rows: readonly DishFeedback[]) =>
    suggestNow(nowInput({ stapleIngredientIds: EVERY_INGREDIENT, feedback: rows })).ready.map((s) => s.recipe.id)
  const liked = [feedback({ taste: 3, again: true })]
  const disliked = [feedback({ taste: 1 })]

  it("「おいしい・また食べたい」で順位が上がり、「苦手」で下がり、評価を削除すると元へ戻る", () => {
    const base = order([])
    const rank = (list: readonly string[]) => list.indexOf(TARGET)
    expect(rank(base)).toBeGreaterThan(0)
    expect(rank(base)).toBeLessThan(base.length - 1)
    expect(rank(order(liked))).toBeLessThan(rank(base))
    expect(rank(order(disliked))).toBeGreaterThan(rank(base))
    // 評価を削除した（入力から消えた）後は、並びが完全に元どおり
    expect(order([])).toEqual(base)
    // 他の料理どうしの順序は変えない
    const without = (list: readonly string[]) => list.filter((id) => id !== TARGET)
    expect(without(order(liked))).toEqual(without(base))
    expect(without(order(disliked))).toEqual(without(base))
  })

  it("その日の気分の記録（excludeFromLearning）や「作らなかった」は影響しない", () => {
    const base = order([])
    expect(order([feedback({ taste: 1, again: false, excludeFromLearning: true })])).toEqual(base)
    expect(order([feedback({ taste: 3, again: true, excludeFromLearning: true })])).toEqual(base)
    // 評価の無い記録（味・手間・また食べたいが全て未入力）も影響しない
    expect(order([feedback({})])).toEqual(base)
    // 「作らなかった」枠は評価でも履歴でもない: 献立の入力に在っても選び方を変えない
    const skipped = entryFor("skip-1", MONDAY, "nikujaga", { status: "skipped", position: 9 })
    const plain = generatePlan(planInput())
    const withSkipped = generatePlan(planInput({ existingEntries: [skipped] }))
    expect(withSkipped.entries.map((e) => [e.date, e.recipeId])).toEqual(plain.entries.map((e) => [e.date, e.recipeId]))
  })

  it("食後の「苦手」は採点だけ: 必須除外とは別で、候補からは消えない", () => {
    const result = suggestNow(nowInput({ stapleIngredientIds: EVERY_INGREDIENT, feedback: disliked }))
    expect(result.excludedCount).toBe(0)
    const row = result.ready.find((s) => s.recipe.id === TARGET)
    expect(row?.preferenceReasons).toEqual([
      { kind: "taste", feedbackId: "fb-1", profileId: "profile-a", eatenOn: "2026-11-10", value: 1, points: -4 },
    ])
    // 対照: 設定で「苦手」に登録した食材は、候補から消える
    const excluded = suggestNow(nowInput({ stapleIngredientIds: EVERY_INGREDIENT, exclusions: [dislikeIngredient("mackerel")] }))
    expect(excluded.excludedCount).toBeGreaterThan(0)
    expect(shownRecipes(excluded).map((r) => r.id)).not.toContain(TARGET)
  })

  it("週間献立でも: 好評の料理が初日に来て、不評の料理は初日から外れ、評価を消すと元の献立に戻る", () => {
    const base = generatePlan(planInput())
    const baseMains = idsOf(base, "main")
    const dayOne = baseMains[0]
    const target = RECIPES.find((r) => r.role === "main" && !baseMains.includes(r.id))
    if (!target) throw new Error("no main outside the base plan")

    const likedPlan = generatePlan(planInput({ feedback: [feedback({ recipeId: target.id, taste: 3, again: true })] }))
    const first = onDate(likedPlan, MONDAY).find((e) => e.role === "main")
    expect(first?.recipeId).toBe(target.id)
    // 理由は実在する記録だけ
    expect(first?.preferenceReasons.map((r) => (r.kind === "explicit" ? r.preferenceId : r.feedbackId))).toEqual(["fb-1", "fb-1"])

    const dislikedPlan = generatePlan(planInput({ feedback: [feedback({ recipeId: dayOne, taste: 1, again: false })] }))
    expect(idsOf(dislikedPlan, "main")[0]).not.toBe(dayOne)

    expect(generatePlan(planInput({ feedback: [] }))).toEqual(base)
    expect(
      generatePlan(planInput({ feedback: [feedback({ recipeId: dayOne, taste: 1, again: false, excludeFromLearning: true })] })),
    ).toEqual(base)
  })
})
