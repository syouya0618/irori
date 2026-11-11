import { describe, expect, it } from "vitest"

import { buildExclusionSet, evaluateRecipe } from "../exclusions"
import {
  checkPlanAdoption,
  DEFAULT_DINNER_SERVINGS,
  generatePlan,
  mainProteinKey,
  moveDay,
  type PlannedEntry,
  type PlanInput,
  PlanInputError,
  type PlanResult,
  replaceDay,
  replaceDish,
  reviewPlan,
} from "../planner"
import type { PantryItem, PlanEntry, WishConstraints } from "../types"
import { EMPTY_WISH } from "../wish-rules"
import { CATALOG, exclusion, ing, planEntry, q, recipeById, STAPLES, stock } from "./fixtures"

// 2026-11-11 は水曜。金曜は 11/13
const START = "2026-11-11"
const FRIDAY = "2026-11-13"

function input(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    startDate: START,
    days: 7,
    servings: DEFAULT_DINNER_SERVINGS,
    today: START,
    existingEntries: [],
    pantry: [],
    exclusions: [],
    stapleIngredientIds: STAPLES,
    catalog: CATALOG,
    ...overrides,
  }
}

function wish(overrides: Partial<WishConstraints>): WishConstraints {
  return { ...EMPTY_WISH, ...overrides }
}

const recipeIds = (plan: PlanResult, role = "main") =>
  plan.entries.filter((e) => e.role === role).map((e) => e.recipeId)

const onDate = (plan: PlanResult, date: string) => plan.entries.filter((e) => e.date === date)

/** 結果を保存した後の状態（新しい枠へ ID を振る）。 */
function saved(plan: PlanResult): PlanEntry[] {
  return plan.entries.map((e: PlannedEntry, i) => ({
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
    status: e.status,
    origin: e.origin,
  }))
}

describe("V-C2 初回ユーザーで 1〜7 日（C-31 / C-32 / C-36）", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("在庫・好み・除外が何も無くても %i 日分を作れる（主菜＋副菜）", (days) => {
    const plan = generatePlan(input({ days }))
    expect(plan.gaps).toEqual([])
    expect(plan.entries).toHaveLength(days * 2)
    expect(new Set(plan.entries.map((e) => e.date)).size).toBe(days)
    for (const date of new Set(plan.entries.map((e) => e.date))) {
      expect(onDate(plan, date).map((e) => e.role)).toEqual(["main", "side"])
    }
  })

  it("新しい枠は「提案」で、人数は渡した値、出所は自動、版はレシピの版", () => {
    const plan = generatePlan(input({ days: 1, servings: 3 }))
    expect(plan.entries[0]).toMatchObject({
      id: null,
      status: "proposed",
      pinned: false,
      origin: "auto",
      servings: 3,
      recipeVersion: 1,
      kept: false,
      position: 0,
    })
    expect(plan.entries[1].position).toBe(1)
  })

  it("7 日間で主菜・副菜を繰り返さない", () => {
    const plan = generatePlan(input())
    expect(new Set(recipeIds(plan, "main")).size).toBe(7)
    expect(new Set(recipeIds(plan, "side")).size).toBe(7)
  })

  it("同じ主たんぱくを連日にしない（候補があるかぎり）", () => {
    const plan = generatePlan(input())
    const keys = plan.entries
      .filter((e) => e.role === "main")
      .map((e) => mainProteinKey(recipeById(e.recipeId as string), CATALOG))
    for (let i = 1; i < keys.length; i += 1) {
      expect(keys[i] === null || keys[i] !== keys[i - 1]).toBe(true)
    }
  })

  it("決定的: 同じ入力からは同じ結果。種を変えても、その種では毎回同じ", () => {
    expect(generatePlan(input())).toEqual(generatePlan(input()))
    const seeded = generatePlan(input({ options: { seed: 7 } }))
    expect(generatePlan(input({ options: { seed: 7 } }))).toEqual(seeded)
  })

  it.each([
    [{ days: 0 }, "invalid_days"],
    [{ days: 8 }, "invalid_days"],
    [{ days: 1.5 }, "invalid_days"],
    [{ startDate: "2026-02-30" }, "invalid_start_date"],
    [{ startDate: "11/11" }, "invalid_start_date"],
    [{ servings: 0 }, "invalid_servings"],
    [{ servings: Number.NaN }, "invalid_servings"],
  ] as const)("不正な入力 %o は %s で拒否する", (overrides, code) => {
    let caught: unknown = null
    try {
      generatePlan(input(overrides))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(PlanInputError)
    expect((caught as PlanInputError).code).toBe(code)
  })
})

describe("C-32 主食・汁物", () => {
  it("既定では主食・汁物の枠を足さない", () => {
    const plan = generatePlan(input({ days: 3 }))
    expect(plan.entries.some((e) => e.role === "staple" || e.role === "soup")).toBe(false)
  })

  it("主食を足す設定でも、主食を含む料理（カレー・丼）の日には足さない", () => {
    const plan = generatePlan(
      input({
        options: { includeStaple: true },
        wish: wish({ pins: [{ date: FRIDAY, recipeId: "pork_curry" }, { date: START, recipeId: "oyakodon" }] }),
      }),
    )
    let withStaple = 0
    let withoutStaple = 0
    for (const date of new Set(plan.entries.map((e) => e.date))) {
      const day = onDate(plan, date)
      const main = recipeById(day.find((e) => e.role === "main")?.recipeId as string)
      const hasStaple = day.some((e) => e.role === "staple")
      expect(hasStaple).toBe(main.includesStaple !== true)
      if (hasStaple) withStaple += 1
      else withoutStaple += 1
    }
    // 両方の日が実際に存在すること（片側だけの検査にしない）
    expect(withStaple).toBeGreaterThan(0)
    expect(withoutStaple).toBeGreaterThan(0)
    expect(plan.gaps).toEqual([])
  })

  it("ご飯は毎日繰り返してよい（主菜・副菜の「繰り返さない」を主食へ当てない）", () => {
    const plan = generatePlan(input({ days: 3, options: { includeStaple: true }, wish: wish({ avoidTags: ["curry", "donburi"] }) }))
    expect(recipeIds(plan, "staple")).toEqual(["rice_plain", "rice_plain", "rice_plain"])
  })

  it("汁物は設定したときだけ足す", () => {
    const plan = generatePlan(input({ days: 2, options: { includeSoup: true } }))
    expect(recipeIds(plan, "soup")).toEqual(["miso_soup", "miso_soup"])
  })

  it("汁物が複数あれば、同じものを続けずに回す（足りなくなったら繰り返す）", () => {
    const clearSoup = { ...recipeById("miso_soup"), id: "clear_soup", title: "豆腐のすまし汁", ingredients: [ing("tofu", 0.5, "block"), ing("salt", null, "pinch")] }
    const catalog = { ingredients: CATALOG.index, recipes: [...CATALOG.recipes, clearSoup] }
    const plan = generatePlan(input({ days: 4, catalog, options: { includeSoup: true } }))
    const soups = recipeIds(plan, "soup")
    expect(soups).toHaveLength(4)
    expect(new Set(soups.slice(0, 2)).size).toBe(2)
    expect(new Set(soups.slice(2, 4)).size).toBe(2)
  })
})

describe("V-C2 希望日と固定料理（C-33）", () => {
  const pinnedCurry = planEntry({ id: "pin-1", date: FRIDAY, recipeId: "pork_curry", pinned: true, origin: "manual" })

  it("「金曜はカレー」の希望を、その日の固定枠にする", () => {
    const plan = generatePlan(input({ wish: wish({ pins: [{ date: FRIDAY, recipeId: "pork_curry" }] }) }))
    const friday = onDate(plan, FRIDAY).find((e) => e.role === "main")
    expect(friday).toMatchObject({ recipeId: "pork_curry", pinned: true, origin: "auto", status: "proposed" })
    expect(plan.rejectedPins).toEqual([])
    // 他の日に同じ料理を重ねない
    expect(recipeIds(plan).filter((id) => id === "pork_curry")).toHaveLength(1)
  })

  it("AI 補助から来た固定は、出所を ai_assisted として残す", () => {
    const plan = generatePlan(
      input({ wish: wish({ pins: [{ date: FRIDAY, recipeId: "pork_curry" }] }), options: { wishOrigin: "ai_assisted" } }),
    )
    expect(onDate(plan, FRIDAY)[0].origin).toBe("ai_assisted")
  })

  it("全体を再生成しても、固定枠は ID・料理・日付とも保持する", () => {
    const first = generatePlan(input({ existingEntries: [pinnedCurry] }))
    const again = generatePlan(input({ existingEntries: saved(first), options: { seed: 99 } }))
    for (const plan of [first, again]) {
      expect(plan.entries.find((e) => e.id === "pin-1")).toMatchObject({
        date: FRIDAY,
        recipeId: "pork_curry",
        pinned: true,
        kept: true,
        origin: "manual",
      })
      expect(plan.removedEntryIds).not.toContain("pin-1")
    }
  })

  it("全体の再生成は、固定していない枠を作り直す（消す枠の ID を返す）", () => {
    const first = saved(generatePlan(input({ days: 2 })))
    const again = generatePlan(input({ days: 2, existingEntries: first }))
    expect(again.removedEntryIds).toEqual(first.map((e) => e.id).sort())
    expect(again.entries.every((e) => e.id === null)).toBe(true)
  })

  it("作り終えた枠（cooked）は再生成で保持し、在庫も引き当てない", () => {
    const cooked = planEntry({ id: "done-1", date: START, recipeId: "pork_ginger", status: "cooked" })
    const pantry = [stock("pork", { id: "pork", quantity: q(200, "g") })]
    const plan = generatePlan(input({ existingEntries: [cooked], pantry }))
    expect(plan.entries.find((e) => e.id === "done-1")).toMatchObject({ status: "cooked", kept: true, stock: null })
    expect(plan.allocations.some((a) => a.entryKey === "done-1")).toBe(false)
    // 作り終えた料理を同じ期間でもう一度選ばない
    expect(recipeIds(plan).filter((id) => id === "pork_ginger")).toHaveLength(1)
  })

  it("1 日差替え: その日の固定枠は保持し、固定していない枠だけを直前と違う料理にする", () => {
    const before = saved(generatePlan(input({ existingEntries: [pinnedCurry] })))
    const beforeSide = before.find((e) => e.date === FRIDAY && e.role === "side") as PlanEntry
    const result = replaceDay(input({ existingEntries: before }), FRIDAY)
    if (!result.ok) throw new Error(result.reason)
    const friday = onDate(result.plan, FRIDAY)
    expect(friday.find((e) => e.role === "main")).toMatchObject({ id: "pin-1", recipeId: "pork_curry", pinned: true })
    const side = friday.find((e) => e.role === "side")
    expect(side?.recipeId).not.toBe(beforeSide.recipeId)
    expect(result.plan.removedEntryIds).toEqual([beforeSide.id])
  })

  it("1 日差替え: 他の日の枠は 1 つも変えない", () => {
    const before = saved(generatePlan(input()))
    const result = replaceDay(input({ existingEntries: before }), FRIDAY)
    if (!result.ok) throw new Error(result.reason)
    const others = (entries: { date: string; id: string | null; recipeId: string | null }[]) =>
      entries.filter((e) => e.date !== FRIDAY).map((e) => [e.id, e.date, e.recipeId])
    expect(others(result.plan.entries)).toEqual(others(before))
    const beforeFriday = before.filter((e) => e.date === FRIDAY).map((e) => e.recipeId)
    for (const entry of onDate(result.plan, FRIDAY)) {
      expect(beforeFriday).not.toContain(entry.recipeId)
    }
  })

  it("1 日差替え: 固定枠しか無い日は差し替えるものが無い", () => {
    const pinnedSide = planEntry({ id: "pin-2", date: FRIDAY, role: "side", position: 1, recipeId: "egg_roll", pinned: true })
    const result = replaceDay(input({ existingEntries: [pinnedCurry, pinnedSide] }), FRIDAY)
    expect(result).toEqual({ ok: false, reason: "nothing_to_replace" })
  })

  it("1 品差替え: 対象の枠だけを直前と違う料理にし、位置を保つ", () => {
    const before = saved(generatePlan(input({ days: 3 })))
    const target = before.find((e) => e.date === FRIDAY && e.role === "side") as PlanEntry
    const result = replaceDish(input({ days: 3, existingEntries: before }), target.id)
    if (!result.ok) throw new Error(result.reason)
    const replaced = onDate(result.plan, FRIDAY).find((e) => e.role === "side")
    expect(replaced).toMatchObject({ id: null, position: target.position, kept: false })
    expect(replaced?.recipeId).not.toBe(target.recipeId)
    expect(result.plan.removedEntryIds).toEqual([target.id])
    const untouched = result.plan.entries.filter((e) => e.id !== null).map((e) => [e.id, e.recipeId])
    expect(untouched).toEqual(before.filter((e) => e.id !== target.id).map((e) => [e.id, e.recipeId]))
  })

  it("1 品差替え: 続けて差し替えるときは、直前までに見た料理を避けられる", () => {
    const before = saved(generatePlan(input({ days: 1 })))
    const target = before.find((e) => e.role === "main") as PlanEntry
    const first = replaceDish(input({ days: 1, existingEntries: before }), target.id)
    if (!first.ok) throw new Error(first.reason)
    const firstMain = first.plan.entries.find((e) => e.role === "main")?.recipeId as string
    const second = replaceDish(input({ days: 1, existingEntries: before }), target.id, [firstMain])
    if (!second.ok) throw new Error(second.reason)
    const secondMain = second.plan.entries.find((e) => e.role === "main")?.recipeId
    expect(new Set([target.recipeId, firstMain, secondMain]).size).toBe(3)
  })

  it("1 品差替え: 固定枠・作り終えた枠・存在しない枠は拒否する（固定の解除は別の明示操作）", () => {
    const cooked = planEntry({ id: "done-1", date: START, recipeId: "pork_ginger", status: "cooked" })
    const base = input({ existingEntries: [pinnedCurry, cooked] })
    expect(replaceDish(base, "pin-1")).toEqual({ ok: false, reason: "pinned" })
    expect(replaceDish(base, "done-1")).toEqual({ ok: false, reason: "cooked" })
    expect(replaceDish(base, "missing")).toEqual({ ok: false, reason: "not_found" })
  })

  it("1 品差替え: 他の候補が無ければ枠を空にせず、元のまま残して知らせる", () => {
    const onlyTofu = [
      exclusion("x1", "allergy", { kind: "allergen", allergenId: "pork" }),
      exclusion("x2", "allergy", { kind: "allergen", allergenId: "chicken" }),
      exclusion("x3", "allergy", { kind: "allergen", allergenId: "salmon" }),
      exclusion("x4", "allergy", { kind: "allergen", allergenId: "egg" }),
    ]
    const before = saved(generatePlan(input({ days: 1, exclusions: onlyTofu })))
    const main = before.find((e) => e.role === "main") as PlanEntry
    expect(main.recipeId).toBe("tofu_steak")
    const result = replaceDish(input({ days: 1, exclusions: onlyTofu, existingEntries: before }), main.id)
    if (!result.ok) throw new Error(result.reason)
    expect(result.plan.unchanged).toEqual([{ entryId: main.id, reason: "no_alternative" }])
    expect(result.plan.entries.find((e) => e.id === main.id)).toMatchObject({ recipeId: "tofu_steak", kept: true })
    expect(result.plan.removedEntryIds).toEqual([])
    expect(result.plan.gaps).toEqual([])
  })

  it("日付移動: 2 つの日の枠を入れ替え、固定は枠に付いて行く", () => {
    const before = saved(generatePlan(input({ days: 3, existingEntries: [pinnedCurry] })))
    const moved = moveDay(before, FRIDAY, START)
    if (!moved.ok) throw new Error(moved.reason)
    expect(moved.entries.find((e) => e.id === "pin-1")).toMatchObject({ date: START, pinned: true, recipeId: "pork_curry" })
    const wasOnStart = before.filter((e) => e.date === START).map((e) => e.id)
    expect(moved.entries.filter((e) => e.date === FRIDAY).map((e) => e.id)).toEqual(wasOnStart)
    // 枠の数も料理も変わらない
    expect(moved.entries.map((e) => e.recipeId).sort()).toEqual(before.map((e) => e.recipeId).sort())
    // 入力は変えていない
    expect(before.find((e) => e.id === "pin-1")?.date).toBe(FRIDAY)
  })

  it("日付移動: 移動先が空なら単なる移動。作り終えた枠のある日は動かさない", () => {
    const entries = [pinnedCurry, planEntry({ id: "done-1", date: START, recipeId: "pork_ginger", status: "cooked" })]
    const toEmpty = moveDay(entries, FRIDAY, "2026-11-15")
    expect(toEmpty.ok && toEmpty.entries.find((e) => e.id === "pin-1")?.date).toBe("2026-11-15")
    expect(moveDay(entries, FRIDAY, START)).toEqual({ ok: false, reason: "cooked" })
    expect(moveDay(entries, FRIDAY, "2026-13-01")).toEqual({ ok: false, reason: "invalid_date" })
  })
})

describe("V-C2 在庫の引当（C-35）", () => {
  const pantry = (): PantryItem[] => [
    stock("pork", { id: "pork", quantity: q(250, "g") }),
    stock("onion", { id: "onion", quantity: q(2, "piece") }),
    stock("carrot", { id: "carrot", quantity: q(1, "piece") }),
    stock("potato", { id: "potato", quantity: q(2, "piece") }),
    stock("curry_roux", { id: "roux", quantity: q(8, "piece") }),
    stock("rice", { id: "rice", quantity: q(10, "bowl") }),
  ]
  const twoPorkDishes = [
    planEntry({ id: "a", date: "2026-11-11", recipeId: "pork_ginger", pinned: true }),
    planEntry({ id: "b", date: "2026-11-12", recipeId: "pork_curry", pinned: true }),
  ]

  it("同じ在庫を複数日へ二重に配らない: 250g の豚肉は 1 日目に 200g、2 日目は残り 50g だけ", () => {
    const plan = reviewPlan(input({ days: 2, pantry: pantry(), existingEntries: twoPorkDishes }))
    const pork = plan.allocations.filter((a) => a.pantryItemId === "pork")
    expect(pork.map((a) => [a.date, a.entryKey, a.quantity])).toEqual([
      ["2026-11-11", "a", q(200, "g")],
      ["2026-11-12", "b", q(50, "g")],
    ])
    expect(plan.entries.find((e) => e.id === "a")?.stock?.level).toBe("ready")
    const curry = plan.entries.find((e) => e.id === "b")
    expect(curry?.stock?.level).toBe("buy")
    expect(curry?.stock?.missing.map((m) => [m.ingredientId, m.shortBy])).toEqual([["pork", q(150, "g")]])
  })

  it("どの在庫も、引当の合計が登録された数量を超えない", () => {
    const stockList = pantry()
    const plan = generatePlan(input({ pantry: stockList }))
    const totals = new Map<string, number>()
    for (const a of plan.allocations) {
      totals.set(a.pantryItemId, (totals.get(a.pantryItemId) ?? 0) + (a.quantity.amount ?? 0))
    }
    expect(totals.size).toBeGreaterThan(0)
    for (const item of stockList) {
      expect(totals.get(item.id) ?? 0).toBeLessThanOrEqual(item.quantity?.amount ?? 0)
    }
  })

  it("計画を作っただけでは実在庫を変えない（引当は別データ）", () => {
    const stockList = pantry()
    const snapshot = JSON.parse(JSON.stringify(stockList))
    generatePlan(input({ pantry: stockList }))
    reviewPlan(input({ days: 2, pantry: stockList, existingEntries: twoPorkDishes }))
    expect(stockList).toEqual(snapshot)
  })

  it("日付順に割り当てる: 枠を入れ替えると、先の日の料理が在庫を取る", () => {
    const swapped = moveDay(twoPorkDishes, "2026-11-11", "2026-11-12")
    if (!swapped.ok) throw new Error(swapped.reason)
    const plan = reviewPlan(input({ days: 2, pantry: pantry(), existingEntries: swapped.entries }))
    const pork = plan.allocations.filter((a) => a.pantryItemId === "pork")
    expect(pork.map((a) => [a.date, a.entryKey, a.quantity.amount])).toEqual([
      ["2026-11-11", "b", 200],
      ["2026-11-12", "a", 50],
    ])
  })

  it("数量不明の在庫は引き当てない（複数日で使えても「確認」のまま、十分とは言わない）", () => {
    const plan = reviewPlan(
      input({
        days: 2,
        pantry: [stock("pork", { id: "pork" }), ...pantry().filter((p) => p.id !== "pork")],
        existingEntries: twoPorkDishes,
      }),
    )
    expect(plan.allocations.some((a) => a.pantryItemId === "pork")).toBe(false)
    expect(plan.entries.find((e) => e.id === "a")?.stock?.level).toBe("check")
  })

  it("在庫で作れる料理を優先して選ぶ", () => {
    const plan = generatePlan(input({ days: 1, pantry: [stock("salmon", { id: "s", quantity: q(2, "slice") })] }))
    expect(recipeIds(plan)).toEqual(["salmon_grill"])
    expect(plan.entries[0].stock?.level).toBe("ready")
  })
})

describe("C-26 早く使いたい・期限の近い食材を前半へ", () => {
  it("「早く使いたい」食材を使う料理を 1 日目に置く", () => {
    const pantry = [
      stock("salmon", { id: "s", quantity: q(2, "slice") }),
      stock("tofu", { id: "t", quantity: q(1, "block"), useSoon: true }),
      stock("pork", { id: "p", quantity: q(200, "g") }),
      stock("onion", { id: "o", quantity: q(1, "piece") }),
    ]
    const plan = generatePlan(input({ days: 3, pantry }))
    expect(recipeIds(plan)[0]).toBe("tofu_steak")
  })

  it("期限の近い食材を、期限内の日に使う（期限の後の日には配らない）", () => {
    const pantry = [
      stock("pork", { id: "p", quantity: q(200, "g") }),
      stock("onion", { id: "o", quantity: q(1, "piece") }),
      stock("chicken_thigh", { id: "c", quantity: q(250, "g") }),
      stock("salmon", { id: "s", quantity: q(2, "slice"), expiresOn: "2026-11-12" }),
    ]
    const plan = generatePlan(input({ days: 4, pantry }))
    const salmonDay = plan.entries.find((e) => e.recipeId === "salmon_grill")?.date
    expect(salmonDay).toBe("2026-11-11")
    for (const a of plan.allocations.filter((x) => x.pantryItemId === "s")) {
      expect(a.date <= "2026-11-12").toBe(true)
    }
  })

  it("期限を過ぎる日には、その在庫を材料に数えない", () => {
    const pinned = [planEntry({ id: "late", date: "2026-11-14", recipeId: "salmon_grill", pinned: true })]
    const pantry = [stock("salmon", { id: "s", quantity: q(2, "slice"), expiresOn: "2026-11-12" })]
    const plan = reviewPlan(input({ days: 4, pantry, existingEntries: pinned }))
    expect(plan.entries[0].stock).toMatchObject({ level: "buy" })
    expect(plan.entries[0].stock?.missing[0].reasons).toEqual(["expired"])
    expect(plan.allocations).toEqual([])
  })
})

describe("C-34 採点: 時間・好み・重複回避", () => {
  it("時間の希望（30 分以内）を満たす候補があれば、その中から選ぶ", () => {
    // カレーの材料が全部そろっている在庫。希望が無ければ 40 分のカレーが 1 日目に来る
    const pantry = [
      stock("pork", { quantity: q(200, "g") }),
      stock("onion", { quantity: q(1, "piece") }),
      stock("carrot", { quantity: q(1, "piece") }),
      stock("potato", { quantity: q(2, "piece") }),
      stock("curry_roux", { quantity: q(4, "piece") }),
      stock("rice", { quantity: q(2, "bowl") }),
    ]
    expect(recipeIds(generatePlan(input({ days: 1, pantry })))).toEqual(["pork_curry"])
    const plan = generatePlan(input({ pantry, wish: wish({ maxMinutes: 30 }) }))
    expect(plan.entries).toHaveLength(14)
    for (const entry of plan.entries) {
      expect(recipeById(entry.recipeId as string).minutes).toBeLessThanOrEqual(30)
    }
  })

  it("時間の希望を満たす候補が無いときは、枠を空にせず減点して選ぶ", () => {
    const plan = generatePlan(input({ days: 1, wish: wish({ maxMinutes: 3 }) }))
    expect(plan.gaps).toEqual([])
    expect(plan.entries[0].score?.time).toBe(-30)
  })

  it("C-74: 保存済みの評価の有無で選ぶ料理が変わる", () => {
    const base = generatePlan(input({ days: 1 }))
    const feedback = [
      { id: "f1", profileId: "mama", recipeId: "chicken_teriyaki", eatenOn: "2026-10-01", taste: 3 as const, effort: 3 as const, again: true, excludeFromLearning: false },
    ]
    const withFeedback = generatePlan(input({ days: 1, feedback }))
    expect(recipeIds(base)).not.toEqual(["chicken_teriyaki"])
    expect(recipeIds(withFeedback)).toEqual(["chicken_teriyaki"])
    expect(withFeedback.entries[0].preferenceReasons.map((r) => r.kind)).toEqual(["taste", "effort", "again"])
    // 「気分」として記録した評価は反映しない
    const moodOnly = generatePlan(input({ days: 1, feedback: feedback.map((f) => ({ ...f, excludeFromLearning: true })) }))
    expect(recipeIds(moodOnly)).toEqual(recipeIds(base))
  })

  it("希望のタグ（魚多め）で、魚の料理が早い日に来る", () => {
    const plan = generatePlan(input({ days: 1, wish: wish({ preferTags: ["fish"] }) }))
    expect(recipeIds(plan)).toEqual(["salmon_grill"])
  })

  it("最近作った料理は後回しにする", () => {
    const base = generatePlan(input({ days: 1 }))
    const first = recipeIds(base)[0] as string
    const plan = generatePlan(input({ days: 1, recentHistory: [{ date: "2026-11-09", recipeId: first }] }))
    expect(recipeIds(plan)[0]).not.toBe(first)
  })

  it("「作らなかった」枠は低評価にも履歴にもしない: 作り直しの対象になるだけ", () => {
    const base = generatePlan(input({ days: 1 }))
    const first = recipeIds(base)[0] as string
    const skipped = planEntry({ id: "sk", date: START, recipeId: first, status: "skipped" })
    const plan = generatePlan(input({ days: 1, existingEntries: [skipped] }))
    expect(recipeIds(plan)).toEqual([first])
    expect(plan.removedEntryIds).toEqual(["sk"])
  })
})

describe("C-36 / C-53 候補不足でも除外を破らない", () => {
  const narrow = [
    exclusion("x-papa", "allergy", { kind: "allergen", allergenId: "pork" }, { kind: "member", profileId: "papa" }),
    exclusion("x-kid", "dislike", { kind: "ingredient", ingredientId: "chicken_thigh" }, { kind: "child", childId: "kid" }),
  ]

  it("家族 2 人の異なる除外を両方守る。足りない枠は理由つきで返す", () => {
    const plan = generatePlan(input({ exclusions: narrow }))
    const set = buildExclusionSet(narrow, CATALOG)
    for (const entry of plan.entries) {
      expect(evaluateRecipe(recipeById(entry.recipeId as string), set).allowed).toBe(true)
    }
    // 豚・鶏を外すと主菜は 鮭・豆腐・えび の 3 つ
    expect(recipeIds(plan).sort()).toEqual(["salmon_grill", "shrimp_egg", "tofu_steak"])
    const mainGaps = plan.gaps.filter((g) => g.role === "main")
    expect(mainGaps).toHaveLength(4)
    expect(mainGaps[0]).toMatchObject({ reason: "exhausted", detail: { total: 9, blocked: 6, labelCheck: 0, alreadyUsed: 3 } })
  })

  it("対照: 除外が無ければ同じ期間に不足枠は出ない", () => {
    expect(generatePlan(input()).gaps).toEqual([])
  })

  it("人数を変えても除外は変わらない", () => {
    for (const servings of [1, 2, 6]) {
      const plan = generatePlan(input({ exclusions: narrow, servings }))
      expect(recipeIds(plan).sort()).toEqual(["salmon_grill", "shrimp_egg", "tofu_steak"])
    }
  })

  it("全ての主菜が除外に当たるとき: 主菜は不足枠（all_excluded）、副菜は選ぶ", () => {
    const all = [
      exclusion("a", "allergy", { kind: "allergen", allergenId: "pork" }),
      exclusion("b", "allergy", { kind: "allergen", allergenId: "chicken" }),
      exclusion("c", "allergy", { kind: "allergen", allergenId: "salmon" }),
      exclusion("d", "allergy", { kind: "allergen", allergenId: "shrimp" }),
      exclusion("e", "dislike", { kind: "ingredient", ingredientId: "tofu" }),
    ]
    const plan = generatePlan(input({ days: 2, exclusions: all }))
    expect(recipeIds(plan)).toEqual([])
    expect(plan.gaps.filter((g) => g.role === "main").map((g) => g.reason)).toEqual(["all_excluded", "all_excluded"])
    expect(recipeIds(plan, "side")).toHaveLength(2)
  })

  it("原材料の確認が必要な料理（ルウ）は、アレルギーの除外があれば自動で選ばない", () => {
    const shrimp = [exclusion("s", "allergy", { kind: "allergen", allergenId: "shrimp" })]
    const curryOnFriday = wish({ pins: [{ date: FRIDAY, recipeId: "pork_curry" }] })
    const plan = generatePlan(input({ exclusions: shrimp, wish: curryOnFriday }))
    expect(recipeIds(plan)).not.toContain("pork_curry")
    expect(recipeIds(plan)).not.toContain("shrimp_egg")
    expect(plan.rejectedPins).toEqual([{ date: FRIDAY, recipeId: "pork_curry", reason: "needs_label_check" }])
    // 対照: 苦手だけの世帯では、同じ希望でカレーを固定できる
    const dislikeOnly = [exclusion("t", "dislike", { kind: "ingredient", ingredientId: "tomato" })]
    const allowed = generatePlan(input({ exclusions: dislikeOnly, wish: curryOnFriday }))
    expect(recipeIds(allowed)).toContain("pork_curry")
    expect(allowed.rejectedPins).toEqual([])
  })

  it("残る候補が「原材料の確認が必要」なものだけなら、不足枠の理由でそう伝える", () => {
    const rouxOnly = { ingredients: CATALOG.index, recipes: [recipeById("pork_curry")] }
    const plan = generatePlan(
      input({ days: 1, catalog: rouxOnly, exclusions: [exclusion("s", "allergy", { kind: "allergen", allergenId: "shrimp" })] }),
    )
    expect(plan.entries).toEqual([])
    expect(plan.gaps.find((g) => g.role === "main")).toMatchObject({
      reason: "needs_label_check",
      detail: { total: 1, blocked: 0, labelCheck: 1 },
    })
  })

  it("除外に当たる料理を希望で固定しようとしても採用しない（点数や希望で除外を緩めない）", () => {
    const plan = generatePlan(
      input({
        exclusions: [exclusion("p", "dislike", { kind: "ingredient", ingredientId: "pork" })],
        wish: wish({
          pins: [
            { date: FRIDAY, recipeId: "pork_curry" },
            { date: "2026-12-01", recipeId: "salmon_grill" },
            { date: FRIDAY, recipeId: "no_such_recipe" },
          ],
          preferRecipeIds: ["pork_ginger"],
        }),
      }),
    )
    expect(plan.rejectedPins).toEqual([
      { date: FRIDAY, recipeId: "pork_curry", reason: "excluded" },
      { date: "2026-12-01", recipeId: "salmon_grill", reason: "out_of_range" },
      { date: FRIDAY, recipeId: "no_such_recipe", reason: "unknown_recipe" },
    ])
    expect(recipeIds(plan)).not.toContain("pork_curry")
    expect(recipeIds(plan)).not.toContain("pork_ginger")
  })

  it("カタログが空でも落ちない（全ての枠が no_recipes）", () => {
    const plan = generatePlan(input({ days: 2, catalog: { ingredients: [], recipes: [] } }))
    expect(plan.entries).toEqual([])
    expect(plan.gaps.map((g) => g.reason)).toEqual(["no_recipes", "no_recipes", "no_recipes", "no_recipes"])
  })
})

describe("C-55 固定枠と新しい除外の衝突", () => {
  it("固定枠が新しい除外に当たっても、勝手に置換せず衝突として返す", () => {
    const pinned = planEntry({ id: "pin-1", date: FRIDAY, recipeId: "pork_curry", pinned: true })
    const plan = generatePlan(
      input({ existingEntries: [pinned], exclusions: [exclusion("p", "dislike", { kind: "ingredient", ingredientId: "pork" })] }),
    )
    expect(plan.entries.find((e) => e.id === "pin-1")).toMatchObject({ recipeId: "pork_curry", kept: true })
    expect(plan.conflicts.map((c) => [c.entryId, c.verdict, c.pinned])).toEqual([["pin-1", "blocked", true]])
    // 新しく選んだ枠には除外に当たる料理が無い
    expect(plan.entries.filter((e) => !e.kept).some((e) => (e.recipeId ?? "").startsWith("pork"))).toBe(false)
  })
})

describe("C-38 採用の直前に、計画の版と制約を確かめる", () => {
  const base = {
    startDate: START,
    days: 7,
    currentEntries: [planEntry({ id: "pin-1", date: FRIDAY, recipeId: "pork_curry", pinned: true })],
    exclusions: [exclusion("s", "allergy", { kind: "allergen", allergenId: "shrimp" })],
    catalog: CATALOG,
  }

  it("版が同じで制約を満たす提案は採用できる", () => {
    const result = checkPlanAdoption({
      ...base,
      baseRevision: 4,
      currentRevision: 4,
      proposed: [{ date: START, role: "main", recipeId: "salmon_grill" }],
    })
    expect(result).toEqual({ ok: true })
  })

  it("待っている間に計画が変わっていたら、内容を見ずに拒否する", () => {
    const result = checkPlanAdoption({
      ...base,
      baseRevision: 4,
      currentRevision: 5,
      proposed: [{ date: START, role: "main", recipeId: "salmon_grill" }],
    })
    expect(result).toEqual({ ok: false, problems: [{ problem: "stale_revision", date: null, recipeId: null }] })
  })

  it("存在しないレシピ・期間外・除外・確認待ち・固定枠の上書き・区分違いを拒否する", () => {
    const result = checkPlanAdoption({
      ...base,
      baseRevision: 4,
      currentRevision: 4,
      proposed: [
        { date: START, role: "main", recipeId: "invented_by_ai" },
        { date: "2026-12-24", role: "main", recipeId: "salmon_grill" },
        { date: START, role: "main", recipeId: "shrimp_egg" },
        { date: "2026-11-12", role: "main", recipeId: "pork_curry" },
        { date: FRIDAY, role: "main", recipeId: "salmon_grill" },
        { date: START, role: "main", recipeId: "egg_roll" },
      ],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problems.map((p) => [p.recipeId, p.problem])).toEqual([
      ["invented_by_ai", "unknown_recipe"],
      ["salmon_grill", "out_of_range"],
      ["shrimp_egg", "excluded"],
      ["pork_curry", "needs_label_check"],
      ["salmon_grill", "protected_slot"],
      ["egg_roll", "role_mismatch"],
    ])
  })
})
