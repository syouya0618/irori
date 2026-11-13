/**
 * 独立レビュー R21（= R28）/ R22 の回帰テスト（**実カタログ**）。
 *
 * - R21 / R28: 1 日の差替えは、その日に在った区分（主食・汁物を含む）を黙って消さない。
 * - R22: 「主食の枠も作る」の既定は ごはん。麺・パンは在庫や希望があるときに選ぶ。
 */

import { describe, expect, it } from "vitest"

import { ALLERGENS, INGREDIENTS, RECIPES } from "@/lib/meals/catalog"
import { toCatalogView } from "@/lib/meals/lookup"
import { generatePlan, type PlanInput, type PlanResult, replaceDay, replaceDish } from "@/lib/meals/planner"
import type { DishRole, PantryItem, PlanEntry, RecipeDef, UnitId, WishConstraints } from "@/lib/meals/types"

const CATALOG = toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })
const MONDAY = "2026-11-16"
const RECIPE: ReadonlyMap<string, RecipeDef> = new Map(RECIPES.map((r) => [r.id, r]))

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

function saved(plan: PlanResult, status: PlanEntry["status"] = "proposed"): PlanEntry[] {
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
    status,
    origin: e.origin,
  }))
}

function wish(overrides: Partial<WishConstraints>): WishConstraints {
  return { pins: [], preferTags: [], avoidTags: [], maxMinutes: null, preferRecipeIds: [], ...overrides }
}

function stock(ingredientId: string, amount: number, unit: UnitId): PantryItem {
  return {
    id: `p-${ingredientId}`,
    ingredientId,
    name: ingredientId,
    quantity: { amount, unit },
    status: "have",
    useSoon: false,
    storage: "pantry",
    expiresOn: null,
    confirmedOn: MONDAY,
  }
}

const rolesOn = (entries: readonly Pick<PlanEntry, "date" | "role">[], date: string): DishRole[] =>
  entries.filter((e) => e.date === date).map((e) => e.role).sort()

const staplesOf = (plan: PlanResult): string[] =>
  plan.entries.filter((e) => e.role === "staple").map((e) => e.recipeId as string)

// ── R22 ────────────────────────────────────────────────────────────

describe("R22 主食の既定は ごはん", () => {
  it("初回ユーザー（常備品なし・在庫なし）: 7 日の主食は全て ごはん（種を変えても）", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const plan = generatePlan(planInput({ options: { includeStaple: true, seed } }))
      const staples = staplesOf(plan)
      expect(staples.length, `seed ${seed}`).toBeGreaterThan(0)
      expect(new Set(staples), `seed ${seed}`).toEqual(new Set(["steamed_rice"]))
    }
    // 種なしでも同じ
    expect(new Set(staplesOf(generatePlan(planInput({ options: { includeStaple: true } }))))).toEqual(new Set(["steamed_rice"]))
  })

  it("調味料だけを常備品にしていても、主食は ごはん のまま（調味料の多い主食へ寄らない）", () => {
    const seasonings = ["soy_sauce", "mirin", "sake", "sugar", "salt", "salad_oil", "pepper", "katsuobushi", "butter"]
    for (let seed = 0; seed < 10; seed += 1) {
      const plan = generatePlan(planInput({ stapleIngredientIds: seasonings, options: { includeStaple: true, seed } }))
      expect(new Set(staplesOf(plan)), `seed ${seed}`).toEqual(new Set(["steamed_rice"]))
    }
  })

  it("対照: うどんが在庫で揃うなら、その分は うどん を選ぶ（在庫利用が優先）", () => {
    const plan = generatePlan(
      planInput({
        days: 3,
        pantry: [stock("udon", 2, "pack")],
        stapleIngredientIds: ["soy_sauce", "mirin", "salt", "katsuobushi"],
        options: { includeStaple: true },
      }),
    )
    expect(staplesOf(plan)).toContain("kake_udon")
    // 在庫は 1 回分。残りの日は ごはん
    expect(staplesOf(plan).filter((id) => id === "kake_udon")).toHaveLength(1)
    expect(staplesOf(plan).filter((id) => id !== "kake_udon").every((id) => id === "steamed_rice")).toBe(true)
  })

  it("対照: 「パン」を希望すれば、パンの主食が選ばれる", () => {
    const plan = generatePlan(planInput({ days: 3, wish: wish({ preferTags: ["bread"] }), options: { includeStaple: true } }))
    expect(staplesOf(plan)).toContain("butter_toast")
  })

  it("ごはんにも当たる希望（和食）・主食の選び分けに使わない希望（時短）では、主食は ごはん のまま", () => {
    const seasonings = ["soy_sauce", "mirin", "sake", "sugar", "salt", "salad_oil", "pepper", "katsuobushi", "butter"]
    for (const preferTags of [["japanese"], ["quick"], ["japanese", "quick"]]) {
      for (let seed = 0; seed < 8; seed += 1) {
        const plan = generatePlan(
          planInput({ wish: wish({ preferTags }), stapleIngredientIds: seasonings, options: { includeStaple: true, seed } }),
        )
        expect(new Set(staplesOf(plan)), `${preferTags.join("+")} seed ${seed}`).toEqual(new Set(["steamed_rice"]))
      }
    }
  })

  it("対照: 「麺」を希望すれば、麺の主食が選ばれる", () => {
    const plan = generatePlan(planInput({ days: 3, wish: wish({ preferTags: ["noodle"], avoidTags: [] }), options: { includeStaple: true } }))
    const staples = staplesOf(plan)
    // 麺の主菜（焼きそば等）の日は主食が付かない。主食が付く日は うどん
    if (staples.length > 0) expect(staples).toContain("kake_udon")
    expect(plan.entries.some((e) => RECIPE.get(e.recipeId as string)?.tags.includes("noodle"))).toBe(true)
  })

  it("対照: 「米は少なめ」と希望されたら、ごはんへ寄せない", () => {
    for (let seed = 0; seed < 5; seed += 1) {
      const plan = generatePlan(planInput({ wish: wish({ avoidTags: ["rice"] }), options: { includeStaple: true, seed } }))
      const staples = staplesOf(plan)
      expect(staples.length).toBeGreaterThan(0)
      expect(staples, `seed ${seed}`).not.toContain("steamed_rice")
    }
  })

  it("対照: 調理時間の上限（15 分以内）が明示されたときは、主食でも守る", () => {
    const plan = generatePlan(planInput({ days: 3, wish: wish({ maxMinutes: 15 }), options: { includeStaple: true } }))
    expect(staplesOf(plan).length).toBeGreaterThan(0)
    for (const id of staplesOf(plan)) expect(RECIPE.get(id)?.minutes ?? 999, id).toBeLessThanOrEqual(15)
  })
})

// ── R21 / R28 ──────────────────────────────────────────────────────

describe("R21 / R28 1 日の差替えは、その日の主食・汁物の枠を黙って消さない", () => {
  it("主食・汁物つきで作った献立を、サーバーと同じ指定（種だけ）で差し替えても区分が保たれる", () => {
    let checked = 0
    let droppedForStapleMain = 0
    for (let seed = 0; seed < 12; seed += 1) {
      const created = generatePlan(planInput({ options: { includeStaple: true, includeSoup: true, seed } }))
      const before = saved(created)
      for (const date of [...new Set(before.map((e) => e.date))]) {
        // replaceDinnerDay は plannerOptions に seed しか渡さない（includeStaple / includeSoup は無い）
        const result = replaceDay(planInput({ existingEntries: before, options: { seed: seed + 100 } }), date)
        if (!result.ok) throw new Error(`replaceDay failed: ${result.reason}`)
        const { plan } = result
        const beforeRoles = rolesOn(before, date)
        const afterRoles = rolesOn(plan.entries, date)
        const newMain = plan.entries.find((e) => e.date === date && e.role === "main")
        const mainHasStaple = newMain?.recipeId ? RECIPE.get(newMain.recipeId)?.includesStaple === true : false
        const dropped = plan.droppedEntries.filter((d) => d.date === date)
        if (beforeRoles.includes("staple") && mainHasStaple) {
          // 主食を含む主菜（丼・カレー・麺）へ替わったときだけ主食を外し、外したことを返す
          expect(afterRoles, `${seed} ${date}`).toEqual(beforeRoles.filter((role) => role !== "staple"))
          expect(dropped.map((d) => [d.role, d.reason]), `${seed} ${date}`).toEqual([["staple", "main_includes_staple"]])
          droppedForStapleMain += 1
        } else {
          expect(afterRoles, `${seed} ${date}`).toEqual(beforeRoles)
          expect(dropped, `${seed} ${date}`).toEqual([])
        }
        // 消える行は、選び直した行か、知らせた行だけ（gaps にも落ちていない）
        expect(plan.gaps.filter((g) => g.date === date), `${seed} ${date}`).toEqual([])
        // 他の日は 1 つも変わらない
        for (const entry of before.filter((e) => e.date !== date)) {
          expect(plan.entries.find((e) => e.id === entry.id)?.recipeId).toBe(entry.recipeId)
        }
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(50)
    // 外す側の分岐も実際に通っている（検査が片側だけになっていない）
    expect(droppedForStapleMain).toBeGreaterThan(0)
  })

  it("主食は選び直しても ごはん のまま（元の主食を避ける対象にしない）。主菜・副菜・汁物は別の料理になる", () => {
    const created = generatePlan(planInput({ days: 3, options: { includeStaple: true, includeSoup: true } }))
    const before = saved(created)
    const date = before.find((e) => e.role === "staple")?.date as string
    const result = replaceDay(planInput({ days: 3, existingEntries: before }), date)
    if (!result.ok) throw new Error("unreachable")
    const beforeBy = new Map(before.filter((e) => e.date === date).map((e) => [e.role, e.recipeId]))
    const afterBy = new Map(result.plan.entries.filter((e) => e.date === date).map((e) => [e.role, e.recipeId]))
    for (const role of ["main", "side", "soup"] as const) expect(afterBy.get(role), role).not.toBe(beforeBy.get(role))
    if (afterBy.has("staple")) expect(afterBy.get("staple")).toBe("steamed_rice")
  })

  it("設定で汁物を足していなくても、その日に在った汁物（手で足した確定済みの枠）は消さずに選び直す", () => {
    const created = generatePlan(planInput({ days: 2 }))
    const soup: PlanEntry = {
      id: "manual-soup",
      date: MONDAY,
      role: "soup",
      position: 5,
      recipeId: RECIPES.find((r) => r.role === "soup")?.id as string,
      recipeVersion: 1,
      customTitle: null,
      customIngredients: null,
      servings: 2,
      pinned: false,
      status: "confirmed",
      origin: "manual",
    }
    const before = [...saved(created), soup]
    const result = replaceDay(planInput({ days: 2, existingEntries: before }), MONDAY)
    if (!result.ok) throw new Error("unreachable")
    const soups = result.plan.entries.filter((e) => e.date === MONDAY && e.role === "soup")
    expect(soups).toHaveLength(1)
    expect(soups[0].recipeId).not.toBe(soup.recipeId)
    expect(soups[0].position).toBe(5)
  })

  it("同じ区分が 2 品ある日は、1 品目だけを選び直し、2 品目はそのまま残す", () => {
    const sides = RECIPES.filter((r) => r.role === "side")
    const mains = RECIPES.filter((r) => r.role === "main" && r.includesStaple !== true)
    const entry = (id: string, recipe: RecipeDef, position: number): PlanEntry => ({
      id,
      date: MONDAY,
      role: recipe.role,
      position,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      customTitle: null,
      customIngredients: null,
      servings: 2,
      pinned: false,
      status: "proposed",
      origin: "auto",
    })
    const before = [entry("main-1", mains[0], 0), entry("side-1", sides[0], 1), entry("side-2", sides[1], 2)]
    const result = replaceDay(planInput({ days: 1, existingEntries: before }), MONDAY)
    if (!result.ok) throw new Error("unreachable")
    const after = result.plan.entries
    expect(after.filter((e) => e.role === "side")).toHaveLength(2)
    expect(after.find((e) => e.id === "side-2")).toMatchObject({ recipeId: sides[1].id, kept: true })
    expect(after.some((e) => e.id === "side-1")).toBe(false)
    expect(result.plan.removedEntryIds).toEqual(["main-1", "side-1"])
  })

  it("手動料理（材料なし）の主食も消さない。ほかの候補へ選び直す", () => {
    const created = generatePlan(planInput({ days: 1 }))
    const manual: PlanEntry = {
      id: "manual-staple",
      date: MONDAY,
      role: "staple",
      position: 7,
      recipeId: null,
      recipeVersion: null,
      customTitle: "雑穀ごはん",
      customIngredients: null,
      servings: 2,
      pinned: false,
      status: "proposed",
      origin: "manual",
    }
    const result = replaceDay(planInput({ days: 1, existingEntries: [...saved(created), manual] }), MONDAY)
    if (!result.ok) throw new Error("unreachable")
    const mainId = result.plan.entries.find((e) => e.role === "main")?.recipeId as string
    const staples = result.plan.entries.filter((e) => e.role === "staple")
    if (RECIPE.get(mainId)?.includesStaple === true) {
      expect(result.plan.droppedEntries.map((d) => d.entryId)).toEqual(["manual-staple"])
    } else {
      expect(staples).toHaveLength(1)
    }
  })

  it("対照: 主食の枠が無い日を差し替えても、主食は足さない（設定に無い区分を勝手に増やさない）", () => {
    const created = generatePlan(planInput({ days: 2 }))
    const before = saved(created)
    const result = replaceDay(planInput({ days: 2, existingEntries: before }), MONDAY)
    if (!result.ok) throw new Error("unreachable")
    expect(rolesOn(result.plan.entries, MONDAY)).toEqual(["main", "side"])
    expect(result.plan.droppedEntries).toEqual([])
  })

  it("対照: 1 品差替えで主食を選び直すときは、元と違う主食になる（避ける対象のまま）", () => {
    const created = generatePlan(planInput({ days: 1, options: { includeStaple: true }, wish: wish({ avoidTags: ["donburi", "curry", "noodle"] }) }))
    const before = saved(created)
    const staple = before.find((e) => e.role === "staple") as PlanEntry
    expect(staple).toBeDefined()
    const result = replaceDish(planInput({ days: 1, existingEntries: before }), staple.id)
    if (!result.ok) throw new Error("unreachable")
    const next = result.plan.entries.find((e) => e.role === "staple")
    expect(next?.recipeId).not.toBe(staple.recipeId)
    expect(result.plan.droppedEntries).toEqual([])
  })
})
