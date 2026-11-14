/**
 * 献立・買い物・今夜の要約の画面用の組み立てと、要求の型ガード。
 *
 * - C-46: 300g 購入後に必要量が 500g → 残り 200g
 * - C-47: 購入と在庫への補充は別の事実
 * - C-35: 在庫の引当は計画上（同じ在庫を 2 日へ配らない）
 * - C-55: 除外に当たる固定枠を、置換せずに見えるようにする
 * - C-37: 材料が未登録の手動料理は、買い物の自動計算の対象外と分かる
 * - C-81 / C-89: 経路（自動 / AI 補助）と AI の状態を正直に出す
 *
 * カタログは実物。暦の前提: 2026-11-11 は水曜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  groceryRow,
  pantryRow,
  type FakeDinnerDb,
} from "./fake-dinner-db"
import {
  isDinnerRequest,
  isDinnerServingsRequest,
  isGenerateDinnerPlanRequest,
  isGroceryRequest,
  isRestockPantryFromGroceryRequest,
  isSaveCustomDishRequest,
  isSaveGroceryManualItemRequest,
  isSetGroceryPurchaseRequest,
  isWishConstraintsShape,
} from "../plan-requests"
import {
  describePinRejection,
  describePlanGap,
  TONIGHT_VIEW_PARTS,
  buildDinnerPlanView,
  buildTonightSummary,
  loadDinnerPlanView,
  loadMealAiStatus,
  loadShoppingView,
  loadTonightSummary,
  mealAiStatusView,
  toShoppingItemView,
  type DinnerEntryView,
  type DinnerPlanView,
  type ShoppingView,
} from "../plan-views"
import { loadMealContext } from "../context"
import { groceryItemFromRow } from "../rows"

const USER = "f1000000-0000-4000-8000-000000000001"
const HOUSE = "f1000000-0000-4000-8000-0000000000a1"
const TODAY = "2026-11-11"
const TOMORROW = "2026-11-12"
const UUID = "f3000000-0000-4000-8000-000000000001"
const VERSION = "2026-11-10T00:00:00.123456+00:00"

let db: FakeDinnerDb

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function planView(options: { days?: number } = {}): Promise<DinnerPlanView> {
  const loaded = await loadDinnerPlanView(db.supabase, HOUSE, { today: TODAY, days: options.days ?? 7 })
  if (!loaded.ok) throw new Error(`plan view failed: ${JSON.stringify(loaded.failures)}`)
  return loaded.view
}

async function shoppingView(): Promise<ShoppingView> {
  const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
  if (!loaded.ok) throw new Error(`shopping view failed: ${JSON.stringify(loaded.failures)}`)
  return loaded.view
}

function entryOf(view: DinnerPlanView, id: unknown): DinnerEntryView {
  const found = view.days.flatMap((day) => day.entries).find((entry) => entry.id === id)
  if (!found) throw new Error("entry view not found")
  return found
}

function storedItem(overrides: Record<string, unknown>) {
  const parsed = groceryItemFromRow(groceryRow(HOUSE, { name: "豚こま切れ肉", ...overrides }))
  if (!parsed.ok) throw new Error(`fixture row is unreadable: ${parsed.field}`)
  return parsed.value
}

describe("買い物の 1 項目（toShoppingItemView）", () => {
  it("C-46: 300g 購入後に必要量が 500g なら、残り 200g で「まだ買うもの」", () => {
    const view = toShoppingItemView(storedItem({ required_quantity: 500, unit: "g", purchased_quantity: 300, purchased: true }))
    expect(view).toMatchObject({
      numeric: true,
      requiredAmount: 500,
      requiredText: "500g",
      purchasedAmount: 300,
      remainingAmount: 200,
      remainingText: "200g",
      state: "to_buy",
      restockableAmount: 300,
    })
  })

  it("対照: 必要量まで購入していれば残り 0 で「購入済み」。未購入なら残りは必要量", () => {
    expect(
      toShoppingItemView(storedItem({ required_quantity: 500, unit: "g", purchased_quantity: 500, purchased: true })),
    ).toMatchObject({ remainingAmount: 0, remainingText: null, state: "purchased" })
    expect(toShoppingItemView(storedItem({ required_quantity: 500, unit: "g" }))).toMatchObject({
      remainingAmount: 500,
      state: "to_buy",
      restockableAmount: null,
    })
  })

  it("C-47: 在庫へ足した分は「手元の購入分」から外れる（購入量そのものは変わらない）", () => {
    const view = toShoppingItemView(
      storedItem({
        required_quantity: 200,
        unit: "g",
        purchased_quantity: 300,
        purchased: false,
        restocked_quantity: 300,
        restock_ids: [UUID],
      }),
    )
    // 残り = 必要 200 −（購入 300 − 在庫へ 300）= 200。もう在庫へ足せる量は無い
    expect(view).toMatchObject({
      purchasedAmount: 300,
      restockedAmount: 300,
      remainingAmount: 200,
      restockableAmount: 0,
      restockCount: 1,
      state: "to_buy",
    })
  })

  it("数値で追えない項目はチェックで判定し、量を捏造しない", () => {
    const note = toShoppingItemView(storedItem({ required_quantity: null, unit: null, required_note: "適量" }))
    expect(note).toMatchObject({ numeric: false, requiredAmount: null, remainingAmount: null, requiredText: "適量", state: "to_buy" })
    expect(
      toShoppingItemView(storedItem({ required_quantity: null, unit: null, required_note: "適量", purchased: true })).state,
    ).toBe("purchased")
    // 在庫量を確認（必要量 0・単位あり）は数値の残りを出さない
    expect(
      toShoppingItemView(storedItem({ required_quantity: null, unit: "g", needs_stock_check: true })),
    ).toMatchObject({ numeric: false, needsStockCheck: true, remainingText: null })
  })

  it("作った料理に使った分は、購入の事実のまま見せ、残り・在庫へ足せる量から外す", () => {
    // 必要 200g（次の料理）・買った 500g・うち作った料理に 300g 使用 → 充てられる 200g で残り 0
    const view = toShoppingItemView(
      storedItem({ required_quantity: 200, unit: "g", purchased_quantity: 500, purchased: true, consumed_quantity: 300 }),
    )
    expect(view).toMatchObject({
      purchasedAmount: 500,
      consumedAmount: 300,
      remainingAmount: 0,
      restockableAmount: 200,
      state: "purchased",
    })
    // 対照: 使った分が無ければ 300g 余る（在庫へ足せる量は 500g）
    expect(
      toShoppingItemView(storedItem({ required_quantity: 200, unit: "g", purchased_quantity: 500, purchased: true })),
    ).toMatchObject({ consumedAmount: 0, remainingAmount: 0, restockableAmount: 500 })
    // 使った分が購入を食い尽くしていれば、次の料理の分は丸ごと残る
    expect(
      toShoppingItemView(storedItem({ required_quantity: 200, unit: "g", purchased_quantity: 300, consumed_quantity: 300 })),
    ).toMatchObject({ remainingAmount: 200, restockableAmount: 0, state: "to_buy" })
  })

  it("数値で追えない項目の印は、作った料理で使い終えたら外れて見える（印の事実は残る）", () => {
    const used = toShoppingItemView(
      storedItem({ required_quantity: null, unit: null, required_note: "少々", purchased: true, purchase_consumed: true }),
    )
    expect(used).toMatchObject({ checked: false, state: "to_buy" })
    expect(
      toShoppingItemView(storedItem({ required_quantity: null, unit: null, required_note: "少々", purchased: true })),
    ).toMatchObject({ checked: true, state: "purchased" })
  })

  it("献立から不要になった自動項目は「もう不要」。手動項目は不要にしない", () => {
    expect(
      toShoppingItemView(storedItem({ required_quantity: 300, unit: "g", purchased_quantity: 300, purchased: true, still_needed: false }))
        .state,
    ).toBe("not_needed")
    expect(
      toShoppingItemView(
        storedItem({ origin: "manual", item_key: `manual|${UUID}`, ingredient_id: null, required_quantity: null, unit: null, still_needed: false }),
      ).state,
    ).toBe("to_buy")
  })
})

describe("買い物の画面（loadShoppingView）", () => {
  it("売場別に並べ、どの日のどの料理かを出す。購入済み・もう不要は別枠", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    db.tables.grocery_items.push(
      groceryRow(HOUSE, {
        name: "豚こま切れ肉",
        required_quantity: 150,
        unit: "g",
        sources: [{ date: TODAY, recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 150, unit: "g" } }],
      }),
      groceryRow(HOUSE, {
        name: "じゃがいも",
        item_key: "potato|count:piece",
        ingredient_id: "potato",
        required_quantity: 3,
        unit: "piece",
        purchased_quantity: 3,
        purchased: true,
      }),
      groceryRow(HOUSE, {
        name: "鮭",
        item_key: "salmon|count:slice",
        ingredient_id: "salmon",
        required_quantity: 2,
        unit: "slice",
        note: "骨なし",
        still_needed: false,
      }),
      groceryRow(HOUSE, { origin: "manual", item_key: `manual|${UUID}`, ingredient_id: null, name: "ラップ" }),
    )
    const view = await shoppingView()
    // 売場を回る順（表示名は catalog/sections.ts が正本）
    expect(view.sections.map((section) => section.section)).toEqual(["meat", "other"])
    expect(view.sections.every((section) => section.label !== "")).toBe(true)
    expect(view.sections[0].items[0]).toMatchObject({
      name: "豚こま切れ肉",
      origin: "auto",
      sources: [{ date: TODAY, dateLabel: "11/11（水）", title: "肉じゃが", quantityText: "150g" }],
    })
    expect(view.sections[1].items[0]).toMatchObject({ name: "ラップ", origin: "manual" })
    expect(view.purchased.map((item) => item.name)).toEqual(["じゃがいも"])
    expect(view.notNeeded.map((item) => item.name)).toEqual(["鮭"])
    expect(view.toBuyCount).toBe(2)
  })

  it("購入をすべて作った料理に使い終えた不要の行は出さない（台帳として DB には残る）。使い残しがあれば出す", async () => {
    db.tables.grocery_items.push(
      // 使い終えた: 300g 買って 300g 使い、メモも補充も無い
      groceryRow(HOUSE, {
        name: "鶏もも肉",
        item_key: "chicken_thigh|mass",
        ingredient_id: "chicken_thigh",
        required_quantity: 300,
        unit: "g",
        purchased_quantity: 300,
        purchased: true,
        consumed_quantity: 300,
        purchase_consumed: true,
        still_needed: false,
      }),
      // 使い終えた印（少々）
      groceryRow(HOUSE, {
        name: "塩",
        item_key: "salt|none",
        ingredient_id: "salt",
        required_note: "少々",
        purchased: true,
        purchase_consumed: true,
        still_needed: false,
      }),
      // 対照: 100g 使い残している
      groceryRow(HOUSE, {
        name: "豚こま切れ肉",
        required_quantity: 300,
        unit: "g",
        purchased_quantity: 400,
        purchased: true,
        consumed_quantity: 300,
        still_needed: false,
      }),
      // 対照: 使い終えたがメモがある
      groceryRow(HOUSE, {
        name: "鮭",
        item_key: "salmon|count:slice",
        ingredient_id: "salmon",
        required_quantity: 2,
        unit: "slice",
        purchased_quantity: 2,
        consumed_quantity: 2,
        note: "骨なし",
        still_needed: false,
      }),
    )
    const view = await shoppingView()
    expect(view.notNeeded.map((item) => item.name).sort()).toEqual(["豚こま切れ肉", "鮭"].sort())
    expect(view.purchased).toEqual([])
    expect(view.toBuyCount).toBe(0)
  })

  it("材料が未登録の手動料理は、自動計算の対象外として一覧に出る（材料があれば出ない）", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, {
        plan_date: TODAY,
        recipe_id: null,
        recipe_version: null,
        custom_title: "おでん",
        status: "confirmed",
        origin: "manual",
      }),
      entryRow(HOUSE, {
        plan_date: TOMORROW,
        recipe_id: null,
        recipe_version: null,
        custom_title: "ポテト炒め",
        custom_ingredients: [{ ingredientId: "potato", quantity: { amount: 2, unit: "piece" } }],
        status: "confirmed",
        origin: "manual",
      }),
    )
    const view = await shoppingView()
    expect(view.uncomputed).toEqual([
      expect.objectContaining({ title: "おでん", reason: "no_ingredients", dateLabel: "11/11（水）" }),
    ])
    expect(view.uncomputed[0].message).toContain("買い物の自動計算に入っていません")
  })

  it("献立や食材が変わって自動項目が古いときは stale。同期済みなら stale でない", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    expect((await shoppingView()).stale).toBe(true)

    const { syncGroceryAutoItems } = await import("../grocery-sync")
    const actor = { supabase: db.supabase, householdId: HOUSE, userId: USER }
    expect(await syncGroceryAutoItems(actor, UUID, { today: TODAY })).toMatchObject({ ok: true, status: "saved" })
    expect((await shoppingView()).stale).toBe(false)

    // 食材（在庫）が変わると、必要量が変わるので古くなる
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 150, unit: "g" }))
    expect((await shoppingView()).stale).toBe(true)
  })

  it("除外を足した後・更新の前（リストが古い間）は、当たる料理の材料を『入れていない』と言わず、残りうると言う（F1）", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, {
        plan_date: TODAY,
        recipe_id: null,
        recipe_version: null,
        custom_title: "卵焼き",
        custom_ingredients: [{ ingredientId: "egg", quantity: { amount: 100, unit: "g" } }],
        status: "confirmed",
        origin: "manual",
      }),
    )
    const { syncGroceryAutoItems } = await import("../grocery-sync")
    const actor = { supabase: db.supabase, householdId: HOUSE, userId: USER }
    expect(await syncGroceryAutoItems(actor, UUID, { today: TODAY })).toMatchObject({ ok: true, status: "saved" })
    expect((await shoppingView()).heldDishes).toEqual([])

    // 卵のアレルギーを足す（買い物の同期はまだ）: 保存済みのリストには卵が残っておる
    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    const stale = await shoppingView()
    expect(stale.sections.flatMap((group) => group.items).map((item) => item.name)).toContain("卵")
    expect(stale.stale).toBe(true)
    expect(stale.heldDishes.map((dish) => dish.title)).toEqual(["卵焼き"])
    expect(stale.heldDishes[0].message).toContain("材料が残っていることがあります")
    expect(stale.heldDishes[0].message).not.toContain("入れていません")

    // 更新の後は、事実どおり「入れていません」と言う
    expect(await syncGroceryAutoItems(actor, "f3000000-0000-4000-8000-000000000002", { today: TODAY })).toMatchObject({ ok: true })
    const fresh = await shoppingView()
    expect(fresh.stale).toBe(false)
    expect(fresh.sections.flatMap((group) => group.items).map((item) => item.name)).not.toContain("卵")
    expect(fresh.heldDishes[0].message).toContain("入れていません")
  })

  it("リストが古い間も、当たる・確かめられない理由（材料が無い等）は消さずに言う", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    db.tables.dinner_plan_entries.push(
      // 同期していない確定の料理（リストを古くする）と、材料の無い手動料理（除外に当たるかを確かめられぬ）
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }),
      entryRow(HOUSE, {
        plan_date: TOMORROW,
        recipe_id: null,
        recipe_version: null,
        custom_title: "おでん",
        status: "confirmed",
        origin: "manual",
      }),
    )
    const view = await shoppingView()
    expect(view.stale).toBe(true)
    const oden = view.heldDishes.find((dish) => dish.title === "おでん")
    expect(oden?.message).toContain("材料が登録されていないため、使わない食材に当たるかを確かめられません。")
    expect(oden?.message).toContain("材料が残っていることがあります")
    expect(oden?.message).not.toContain("入れていません")
  })

  it("常備品は買い物に出さず、常備品として扱ったことを返す", async () => {
    db.tables.dinner_settings.push({
      household_id: HOUSE,
      servings: 2,
      include_soup: false,
      max_cook_minutes: null,
      staples: ["soy_sauce"],
      child_stages: {},
      updated_at: VERSION,
    })
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    expect((await shoppingView()).stapleAssumed).toEqual(["しょうゆ"])
  })

  it("読み込みに失敗したら、空のリストではなく失敗を返す", async () => {
    db.failTable("grocery_items")
    expect(await loadShoppingView(db.supabase, HOUSE, { today: TODAY })).toEqual({
      ok: false,
      failures: [{ part: "grocery", kind: "query" }],
    })
  })
})

describe("献立の画面（loadDinnerPlanView）", () => {
  it("設定が無い世帯は標準の人数（2 人分）で計算していると明示する", async () => {
    const view = await planView()
    expect(view.servings).toEqual({ value: 2, isStandard: true, mismatchCount: 0 })
    expect(view.days).toHaveLength(7)
    expect(view.days[0]).toMatchObject({ date: TODAY, isToday: true, isPast: false, entries: [], missingRoles: [] })
    expect(view.days[0].label).toBe("今日 11/11（水）")
    expect(view.revision).toBe(0)
    expect(view.groceryStale).toBe(false)

    db.tables.dinner_settings.push({
      household_id: HOUSE,
      servings: 4,
      include_soup: true,
      max_cook_minutes: 30,
      staples: [],
      child_stages: {},
      updated_at: VERSION,
    })
    expect(await planView()).toMatchObject({ servings: { value: 4, isStandard: false }, includeSoup: true, maxCookMinutes: 30 })
  })

  it("R45: 設定の人数と違う、これからの未調理の枠の数を返す（作った・作らなかった・過ぎた日は数えない）", async () => {
    db.tables.dinner_settings.push({
      household_id: HOUSE,
      servings: 4,
      include_soup: false,
      max_cook_minutes: null,
      staples: [],
      child_stages: {},
      updated_at: VERSION,
    })
    db.tables.dinner_plan_entries.push(
      // 数える: 固定した確定の枠（2 人分のまま）と、提案の枠
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "curry_rice", status: "confirmed", pinned: true, servings: 2 }),
      entryRow(HOUSE, { plan_date: TOMORROW, recipe_id: "nikujaga", servings: 3 }),
      // 数えない: 設定と同じ人数・作った・作らなかった
      entryRow(HOUSE, { plan_date: TOMORROW, role: "side", position: 1, recipe_id: "spinach_ohitashi", servings: 4 }),
      entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "spinach_ohitashi", status: "cooked", servings: 2 }),
      entryRow(HOUSE, { plan_date: TODAY, role: "soup", position: 2, recipe_id: "tofu_wakame_miso_soup", status: "skipped", servings: 2 }),
    )
    const view = await planView()
    expect(view.servings).toEqual({ value: 4, isStandard: false, mismatchCount: 2 })
    // 枠ごとの人数は、その枠の値のまま見せる（設定の人数へ言い換えない）
    expect(view.days[0].entries.find((entry) => entry.pinned)?.servings).toBe(2)
  })

  it("各料理の状態・出所・固定と、在庫の計画上の引当を出す（同じ在庫を 2 日へ配らない）", async () => {
    const first = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", pinned: true })
    const second = entryRow(HOUSE, { plan_date: TOMORROW, recipe_id: "curry_rice", origin: "ai_assisted" })
    db.tables.dinner_plan_entries.push(first, second)
    // 豚こまは 150g だけ。今日の肉じゃが（150g）に当たり、明日のカレー（200g）には残らない
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 150, unit: "g" }))
    const pantryBefore = JSON.stringify(db.tables.pantry_items)

    const view = await planView()
    const today = entryOf(view, first.id)
    const tomorrow = entryOf(view, second.id)
    expect(today).toMatchObject({
      title: "肉じゃが",
      roleLabel: "主菜",
      statusLabel: "確定",
      originLabel: "自動",
      pinned: true,
      isCustom: false,
      minutes: 35,
      groceryUncomputed: false,
    })
    expect(tomorrow).toMatchObject({ title: "カレーライス", statusLabel: "提案", originLabel: "AI 補助", pinned: false })
    expect(today.stock?.missing.map((line) => line.name)).not.toContain("豚こま切れ肉")
    const shortPork = tomorrow.stock?.missing.find((line) => line.name === "豚こま切れ肉")
    expect(shortPork?.detail).toContain("あと200g")
    expect(tomorrow.stock).toMatchObject({ level: "buy", label: "買い足し" })
    // 計画上の引当だけで、実在庫は変えない
    expect(JSON.stringify(db.tables.pantry_items)).toBe(pantryBefore)
    expect(view.counts).toMatchObject({ proposed: 1, confirmed: 1, cooked: 0, conflicts: 0 })
    // 料理がある日の足りない区分は、理由つきで出す（料理が無い日は出さない）
    expect(view.days[0].missingRoles).toEqual([expect.objectContaining({ role: "side", reason: "unfilled" })])
    expect(view.days[2].missingRoles).toEqual([])
  })

  it("作った・作らなかった料理は、取り消しで戻る先（作る前の提案・確定）を持つ。記録が無ければ確定", async () => {
    const fromProposal = entryRow(HOUSE, { plan_date: TODAY, status: "cooked", prior_status: "proposed" })
    const fromConfirmed = entryRow(HOUSE, { plan_date: TODAY, role: "side", status: "skipped", prior_status: "confirmed" })
    const legacy = entryRow(HOUSE, { plan_date: TODAY, role: "soup", status: "cooked", prior_status: null })
    const active = entryRow(HOUSE, { plan_date: TOMORROW, status: "confirmed" })
    db.tables.dinner_plan_entries.push(fromProposal, fromConfirmed, legacy, active)
    const view = await planView()
    expect(entryOf(view, fromProposal.id).restoreTo).toBe("proposed")
    expect(entryOf(view, fromConfirmed.id).restoreTo).toBe("confirmed")
    expect(entryOf(view, legacy.id).restoreTo).toBe("confirmed")
    expect(entryOf(view, active.id).restoreTo).toBeNull()
  })

  it("C-55: 除外に当たる固定枠を、置換せずに衝突として見せる", async () => {
    const pinned = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "oyakodon", pinned: true, status: "confirmed" })
    const fine = entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "spinach_ohitashi" })
    db.tables.dinner_plan_entries.push(pinned, fine)
    expect(entryOf(await planView(), pinned.id).conflict).toBeNull()

    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const view = await planView()
    const conflicted = entryOf(view, pinned.id)
    expect(conflicted).toMatchObject({ title: "親子丼", pinned: true, status: "confirmed", recipeId: "oyakodon" })
    expect(conflicted.conflict).toMatchObject({ verdict: "blocked" })
    expect(conflicted.conflict?.message).toContain("卵")
    expect(entryOf(view, fine.id).conflict).toBeNull()
    expect(view.counts.conflicts).toBe(1)
    // 行は書き換えていない
    expect(pinned).toMatchObject({ recipe_id: "oyakodon", pinned: true })
  })

  it("辞書へ解決できない除外は、判定の限界として名前を返す", async () => {
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "dislike", target_kind: "custom", target_id: null, custom_label: "パクチー風味" }),
    )
    expect((await planView()).limitedExclusions).toEqual(["パクチー風味"])
  })

  it("材料が未登録の手動料理は、買い物の自動計算の対象外と分かる", async () => {
    const custom = entryRow(HOUSE, {
      plan_date: TODAY,
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      origin: "manual",
      pinned: true,
    })
    db.tables.dinner_plan_entries.push(custom)
    expect(entryOf(await planView(), custom.id)).toMatchObject({
      title: "おでん",
      isCustom: true,
      originLabel: "手動",
      groceryUncomputed: true,
      stock: null,
      minutes: null,
    })
  })

  it("確定した料理があるのに買い物を同期していなければ、買い物リストが古いと知らせる", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, status: "confirmed" }))
    db.tables.dinner_plan_state.push({ household_id: HOUSE, revision: 3, grocery_revision: null })
    expect((await planView()).groceryStale).toBe(true)
    db.tables.dinner_plan_state[0].grocery_revision = 3
    expect((await planView()).groceryStale).toBe(false)
    db.tables.dinner_plan_state[0].revision = 4
    expect((await planView()).groceryStale).toBe(true)
  })

  it("読めない行は件数で返し、範囲が不正・取得の失敗は失敗として返す", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, status: "status_from_the_future" }))
    expect((await planView()).unreadableEntries).toBe(1)
    expect(await loadDinnerPlanView(db.supabase, HOUSE, { today: TODAY, days: 8 })).toMatchObject({ ok: false })
    db.failTable("food_exclusions")
    expect(await loadDinnerPlanView(db.supabase, HOUSE, { today: TODAY })).toEqual({
      ok: false,
      failures: [{ part: "exclusions", kind: "query" }],
    })
  })
})

describe("今夜の要約（loadTonightSummary）", () => {
  it("今日の献立と、まだ買うものの件数を返す", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }),
      entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "spinach_ohitashi", status: "proposed" }),
      entryRow(HOUSE, { plan_date: TOMORROW, recipe_id: "curry_rice", status: "confirmed" }),
    )
    db.tables.grocery_items.push(
      groceryRow(HOUSE, { name: "豚こま切れ肉", required_quantity: 150, unit: "g" }),
      groceryRow(HOUSE, {
        name: "じゃがいも",
        item_key: "potato|count:piece",
        ingredient_id: "potato",
        required_quantity: 3,
        unit: "piece",
        purchased_quantity: 3,
        purchased: true,
      }),
    )
    const loaded = await loadTonightSummary(db.supabase, HOUSE, { today: TODAY })
    expect(loaded).toMatchObject({
      ok: true,
      summary: {
        today: TODAY,
        dinner: { state: "confirmed", stateLabel: "確定", dishes: [{ title: "肉じゃが" }, { title: "ほうれん草のおひたし" }] },
        toBuyCount: 1,
      },
    })
  })

  it("献立が無い日は「未定」。読めなかったときは「献立なし」と偽らず失敗を返す", async () => {
    expect(await loadTonightSummary(db.supabase, HOUSE, { today: TODAY })).toMatchObject({
      ok: true,
      summary: { dinner: { state: "none", stateLabel: "未定", dishes: [] }, toBuyCount: 0 },
    })
    db.failTable("dinner_plan_entries")
    expect(await loadTonightSummary(db.supabase, HOUSE, { today: TODAY })).toMatchObject({ ok: false })
  })
})

/**
 * R46 / C-65: 1 歳未満のはちみつ等の年齢の制約は、「今あるもので」・レシピ詳細だけでなく、
 * 献立と今夜の読み取りにも載る（料理は外さない・置き換えない。注意として示す）。
 * 「さつまいものはちみつレモン煮」（副菜）は はちみつ を使う。
 */
describe("R46 献立・今夜の年齢の制約（C-65）", () => {
  const BABY = "c1000000-0000-4000-8000-000000000001"
  const TODDLER = "c1000000-0000-4000-8000-000000000002"
  const child = (id: string, name: string, birthDate: string | null) => ({
    id,
    household_id: HOUSE,
    name,
    birth_date: birthDate,
    created_at: VERSION,
  })
  const honeyDish = (over: Record<string, unknown> = {}) =>
    entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "sweet_potato_honey_lemon", ...over })

  beforeEach(() => {
    // 2026-11-11 時点: ゆい = 8 か月、そうた = 2 歳 6 か月
    db.tables.children.push(child(BABY, "ゆい", "2026-03-05"), child(TODDLER, "そうた", "2024-05-01"))
  })

  it("はちみつを使う料理に、1 歳未満の子の名前と月齢つきの注意を出す（1 歳以上の子・ほかの料理には出さない）", async () => {
    const honey = honeyDish({ status: "confirmed", pinned: true })
    const plain = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga" })
    db.tables.dinner_plan_entries.push(honey, plain)
    const view = await planView()
    expect(view.ageRulesChecked).toBe(true)
    const warnings = entryOf(view, honey.id).ageWarnings ?? []
    expect(warnings).toEqual([
      {
        childId: BABY,
        childName: "ゆい",
        ingredientName: "はちみつ",
        ageUnknown: false,
        text: "はちみつを使います。ゆい（8か月）は1歳未満のため、与えません。",
      },
    ])
    // 対照: はちみつを使わない料理
    expect(entryOf(view, plain.id).ageWarnings).toEqual([])
    // 料理は外さない・置き換えない（固定も状態もそのまま）
    expect(entryOf(view, honey.id)).toMatchObject({ title: "さつまいものはちみつレモン煮", pinned: true, status: "confirmed" })
  })

  it("月齢は料理の日で数える（その日までに 1 歳になる子には出さない）。生年月日が無い子は確認を促す", async () => {
    db.tables.children.length = 0
    // 2025-11-13 生まれ: 今日（11/11）は 11 か月、金曜（11/13）は 1 歳
    db.tables.children.push(child(BABY, "ゆい", "2025-11-13"), child(TODDLER, "", null))
    const today = honeyDish()
    const friday = honeyDish({ plan_date: "2026-11-13" })
    db.tables.dinner_plan_entries.push(today, friday)
    const view = await planView()
    expect((entryOf(view, today.id).ageWarnings ?? []).map((warning) => [warning.childId, warning.ageUnknown])).toEqual([
      [BABY, false],
      [TODDLER, true],
    ])
    const later = entryOf(view, friday.id).ageWarnings ?? []
    expect(later.map((warning) => warning.childId)).toEqual([TODDLER])
    expect(later[0].text).toBe(
      "はちみつを使います。1歳未満のお子さんには与えません。名前未設定のお子さんの生年月日が未登録のため、年齢を確認してください。",
    )
  })

  it("手動料理は、登録した材料と料理名の両方から判定する（重ねない。対照: 関係のない料理名には出さない）", async () => {
    const custom = (title: string, ingredients: unknown, position: number) =>
      entryRow(HOUSE, {
        plan_date: TODAY,
        role: "side",
        position,
        recipe_id: null,
        recipe_version: null,
        custom_title: title,
        custom_ingredients: ingredients,
        origin: "manual",
        pinned: true,
      })
    const byTitle = custom("ハチミツトースト", null, 1)
    const byIngredient = custom("レモンの甘煮", [{ ingredientId: "honey", quantity: { amount: 1, unit: "tbsp" } }], 2)
    const both = custom("蜂蜜大根", [{ ingredientId: "honey", quantity: { amount: 2, unit: "tbsp" } }], 3)
    const unrelated = custom("バタートースト", null, 4)
    db.tables.dinner_plan_entries.push(byTitle, byIngredient, both, unrelated)
    const view = await planView()
    const texts = (id: unknown) => (entryOf(view, id).ageWarnings ?? []).map((warning) => warning.text)
    expect(texts(byTitle.id)).toEqual(["料理名から判断しました。はちみつを使います。ゆい（8か月）は1歳未満のため、与えません。"])
    expect(texts(byIngredient.id)).toEqual(["はちみつを使います。ゆい（8か月）は1歳未満のため、与えません。"])
    expect(texts(both.id)).toHaveLength(1)
    expect(texts(unrelated.id)).toEqual([])
  })

  it("「作らなかった」料理には出さない。子どもを読んでいない読み込みでは「確かめていない」と分かる", async () => {
    const skipped = honeyDish({ status: "skipped" })
    const active = honeyDish({ plan_date: TOMORROW })
    db.tables.dinner_plan_entries.push(skipped, active)
    const view = await planView()
    expect(entryOf(view, skipped.id).ageWarnings).toEqual([])
    expect(entryOf(view, active.id).ageWarnings).toHaveLength(1)

    // 子どもを include しない読み込み（注意は作れない）。「注意なし」と言い切らない
    const loaded = await loadMealContext(db.supabase, HOUSE, {
      include: ["settings", "pantry", "exclusions", "plan"],
      today: TODAY,
    })
    if (!loaded.ok) throw new Error("context failed")
    const unchecked = buildDinnerPlanView(loaded.context, { startDate: TODAY, days: 7 })
    expect(unchecked?.ageRulesChecked).toBe(false)
    expect(unchecked?.days.flatMap((day) => day.entries).every((entry) => entry.ageWarnings?.length === 0)).toBe(true)
  })

  it("子どもの読み込みに失敗したら、注意なしの献立を返さずに失敗を返す", async () => {
    db.tables.dinner_plan_entries.push(honeyDish())
    db.failTable("children")
    expect(await loadDinnerPlanView(db.supabase, HOUSE, { today: TODAY })).toEqual({
      ok: false,
      failures: [{ part: "children", kind: "query" }],
    })
  })

  it("今夜: 今日の料理の注意を載せる（`TONIGHT_VIEW_PARTS` で読んだとき）。子どもを読まなければ未確認", async () => {
    db.tables.dinner_plan_entries.push(honeyDish({ status: "confirmed" }), entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga" }))
    const loaded = await loadMealContext(db.supabase, HOUSE, {
      include: TONIGHT_VIEW_PARTS,
      planRange: { from: TODAY, to: TODAY },
      today: TODAY,
    })
    if (!loaded.ok) throw new Error("context failed")
    const summary = buildTonightSummary(loaded.context)
    expect(summary.ageRulesChecked).toBe(true)
    expect(summary.dinner.dishes.map((dish) => [dish.title, (dish.ageWarnings ?? []).map((warning) => warning.childName)])).toEqual([
      ["肉じゃが", []],
      ["さつまいものはちみつレモン煮", ["ゆい"]],
    ])

    const hub = await loadTonightSummary(db.supabase, HOUSE, { today: TODAY })
    if (!hub.ok) throw new Error("summary failed")
    expect(hub.summary.ageRulesChecked).toBe(false)
  })
})

/**
 * R01（配線）: 判定できないアレルギーの除外があると、どの料理も「原材料の確認が必要」になる。
 * 献立と今夜の読み取りは、その理由（保留）と該当する除外の名前を画面へ渡す
 * （「商品により原材料が異なる材料を含みます」と、事実と違う理由を出さない）。
 */
describe("R01 献立・今夜: 判定できない除外による保留の理由", () => {
  const unknownAllergy = () =>
    exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" })

  it("料理そのものに確認の要る材料が無い枠は、保留の理由と除外の名前を出す（対照: ルウを使う料理は元の理由のまま）", async () => {
    const salmon = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "salmon_shioyaki", status: "confirmed" })
    const curry = entryRow(HOUSE, { plan_date: TOMORROW, recipe_id: "curry_rice" })
    db.tables.dinner_plan_entries.push(salmon, curry)
    db.tables.food_exclusions.push(unknownAllergy())
    const view = await planView()
    expect(view.exclusions).toMatchObject({
      holdsAutoConfirm: true,
      undetermined: [{ label: "ぞぞぞ成分", reason: "allergy", effect: "holds_auto_confirm" }],
    })
    expect(view.exclusions?.holdMessage).toContain("「ぞぞぞ成分」")
    const held = entryOf(view, salmon.id).conflict
    expect(held).toMatchObject({ verdict: "label_check", undeterminedHold: true })
    expect(held?.message).toContain("「ぞぞぞ成分」")
    expect(held?.message).not.toContain("商品により原材料が異なる")
    expect(entryOf(view, curry.id).conflict).toEqual({
      verdict: "label_check",
      message: "原材料の確認が必要です（商品により原材料が異なる材料を含みます）。",
      undeterminedHold: false,
    })
    // 料理は置き換えない・状態も変えない
    expect(entryOf(view, salmon.id)).toMatchObject({ title: "鮭の塩焼き", status: "confirmed" })
  })

  it("保留の間は、買い物リストが古くても「献立から更新」を促さない。保留の文が買い物を止めていることを言う（対照: 判定できる除外なら古いと知らせる）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "salmon_shioyaki", status: "confirmed" }))
    db.tables.dinner_plan_state.push({ household_id: HOUSE, revision: 4, grocery_revision: 3 })
    db.tables.food_exclusions.push(unknownAllergy())
    const held = await planView()
    expect(held.groceryStale).toBe(false)
    expect(held.exclusions?.holdMessage).toContain("買い物リストの自動の更新も止めています")
    db.tables.food_exclusions = [exclusionRow(HOUSE)]
    expect((await planView()).groceryStale).toBe(true)
  })

  it("対照: 判定できない苦手・判定できるアレルギーでは保留しない（衝突も、保留の文も出さない）", async () => {
    const salmon = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "salmon_shioyaki" })
    db.tables.dinner_plan_entries.push(salmon)
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "dislike", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ風味" }),
      exclusionRow(HOUSE),
    )
    const view = await planView()
    expect(view.exclusions).toMatchObject({
      holdsAutoConfirm: false,
      holdMessage: null,
      undetermined: [{ label: "ぞぞぞ風味", reason: "dislike", effect: "no_effect" }],
    })
    expect(entryOf(view, salmon.id).conflict).toBeNull()
  })

  it("今夜: 除外を読んだ読み込みでは保留の状態を返す。読んでいなければ null（「保留なし」と言わない）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "salmon_shioyaki" }))
    db.tables.food_exclusions.push(unknownAllergy())
    const loaded = await loadMealContext(db.supabase, HOUSE, {
      include: TONIGHT_VIEW_PARTS,
      planRange: { from: TODAY, to: TODAY },
      today: TODAY,
    })
    if (!loaded.ok) throw new Error("context failed")
    const summary = buildTonightSummary(loaded.context)
    expect(summary.exclusions).toMatchObject({ holdsAutoConfirm: true, undetermined: [{ label: "ぞぞぞ成分" }] })
    expect(summary.exclusions?.holdMessage).toContain("献立を確定できません")

    const hub = await loadTonightSummary(db.supabase, HOUSE, { today: TODAY })
    if (!hub.ok) throw new Error("summary failed")
    expect(hub.summary.exclusions).toBeNull()
  })
})

/** R24（配線）: 総称（「豚肉」）で登録した食材は部位に数えない。献立の在庫の内訳でも、どの登録のことかを示す。 */
describe("R24 献立: 総称で登録した食材の確認", () => {
  it("「豚肉」の在庫があると、豚こま切れ肉は「確認が要る材料」に回り、登録名つきの文が付く（対照: 無関係な材料には付かない）", async () => {
    const dish = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga" })
    db.tables.dinner_plan_entries.push(dish)
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "pork", name: "豚肉", quantity: 300, unit: "g" }))
    const stock = entryOf(await planView(), dish.id).stock
    const pork = stock?.toCheck.find((line) => line.name === "豚こま切れ肉")
    expect(pork?.genericStock).toBe(true)
    expect(pork?.detail).toContain("「豚肉」で登録されています。豚こま切れ肉に当たるか（部位・種類）を確認してください。")
    // 買い足しの一覧には入れない（同一視もしないが、「無い」とも言わない）
    expect(stock?.missing.some((line) => line.name === "豚こま切れ肉")).toBe(false)
    expect(stock?.missing.every((line) => line.genericStock === false)).toBe(true)
  })

  it("対照: 総称の在庫が無ければ、豚こま切れ肉は買い足しに入り、総称の印は付かない", async () => {
    const dish = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga" })
    db.tables.dinner_plan_entries.push(dish)
    const stock = entryOf(await planView(), dish.id).stock
    expect(stock?.missing.find((line) => line.name === "豚こま切れ肉")).toMatchObject({ genericStock: false })
  })
})

describe("AI の状態と文言（C-81 / C-89）", () => {
  it("未設定のときは DB へ問い合わせず、自動献立が使えることを伝える", async () => {
    vi.stubEnv("MEAL_AI_ENABLED", "")
    const status = await loadMealAiStatus(db.supabase)
    expect(status).toMatchObject({ state: "not_configured", resetsAt: null })
    expect(status.message).toContain("自動献立はそのまま使えます")
    expect(db.calls.rpc).toEqual([])
  })

  it("有効なときは、上限・無料枠の終了・確認できない状態を区別する", async () => {
    vi.stubEnv("MEAL_AI_ENABLED", "true")
    vi.stubEnv("MEAL_AI_ACCOUNT_ID", "0123456789abcdef0123456789abcdef")
    vi.stubEnv("MEAL_AI_API_TOKEN", "test-token")
    expect((await loadMealAiStatus(db.supabase)).state).toBe("available")
    db.intercept("dinner_ai_status", () => ({ data: { used: 10, provider_exhausted: false, resets_at: null }, error: null }))
    expect((await loadMealAiStatus(db.supabase)).state).toBe("household_limit")
    db.intercept("dinner_ai_status", () => ({
      data: { used: 2, provider_exhausted: true, resets_at: "2026-11-12T00:00:00+00:00" },
      error: null,
    }))
    const exhausted = await loadMealAiStatus(db.supabase)
    expect(exhausted).toMatchObject({ state: "provider_exhausted", resetsAtLabel: "11月12日 9:00" })
    expect(exhausted.message).toContain("11月12日 9:00 以降に再開")
    db.intercept("dinner_ai_status", () => ({ data: null, error: { code: "42501", message: "denied" } }))
    expect((await loadMealAiStatus(db.supabase)).state).toBe("unknown")
  })

  it("文言は保証や監修を装わない", () => {
    const texts = [
      ...(["not_configured", "available", "household_limit", "provider_exhausted", "temporary_failure", "unknown"] as const).map(
        (state) => mealAiStatusView(state, "2026-11-12T00:00:00.000Z").message,
      ),
      ...(["no_recipes", "all_excluded", "needs_label_check", "exhausted", "unfilled"] as const).map((reason) =>
        describePlanGap(reason, "main"),
      ),
      ...(["out_of_range", "unknown_recipe", "excluded", "needs_label_check", "slot_taken"] as const).map(describePinRejection),
    ]
    for (const text of texts) {
      expect(text).not.toMatch(/栄養バランス|管理栄養士|監修|保証|安全です/)
      expect(text.length).toBeGreaterThan(0)
    }
    expect(describePlanGap("all_excluded", "side")).toContain("副菜")
  })
})

describe("要求の型ガード（X-05）", () => {
  const generate = {
    operationId: UUID,
    expectedRevision: 0,
    startDate: TODAY,
    days: 7,
    constraints: null,
    mode: "auto",
  }

  it("正しい形を受け、余分な項目（世帯 ID・本人 ID）を持つ要求を拒む", () => {
    expect(isGenerateDinnerPlanRequest(generate)).toBe(true)
    expect(isGenerateDinnerPlanRequest({ ...generate, householdId: HOUSE })).toBe(false)
    expect(isGenerateDinnerPlanRequest({ ...generate, household_id: HOUSE })).toBe(false)
    expect(isDinnerRequest({ op: "generate", ...generate })).toBe(true)
    expect(isDinnerRequest({ op: "generate", ...generate, profileId: USER })).toBe(false)
    expect(isDinnerRequest({ op: "drop_table", ...generate })).toBe(false)
    expect(isDinnerRequest({ op: "constructor" })).toBe(false)
    expect(isGroceryRequest({ op: "sync", operationId: UUID })).toBe(true)
    expect(isGroceryRequest({ op: "sync", operationId: UUID, householdId: HOUSE })).toBe(false)
  })

  it("R45: 人数の変更の要求（1 枠・まとめて）の形。人数は 1〜12 の整数。世帯 ID・版なしを拒む", () => {
    const one = { op: "servings", entryId: UUID, version: VERSION, servings: 4 }
    expect(isDinnerServingsRequest(one)).toBe(true)
    expect(isDinnerServingsRequest({ op: "servings_upcoming", servings: 12 })).toBe(true)
    for (const servings of [0, 13, 2.5, "4", null, undefined]) {
      expect(isDinnerServingsRequest({ ...one, servings }), String(servings)).toBe(false)
      expect(isDinnerServingsRequest({ op: "servings_upcoming", servings }), String(servings)).toBe(false)
    }
    expect(isDinnerServingsRequest({ ...one, householdId: HOUSE })).toBe(false)
    expect(isDinnerServingsRequest({ op: "servings_upcoming", servings: 4, householdId: HOUSE })).toBe(false)
    expect(isDinnerServingsRequest({ op: "servings", entryId: UUID, servings: 4 })).toBe(false)
    expect(isDinnerServingsRequest({ op: "servings", entryId: "x", version: VERSION, servings: 4 })).toBe(false)
    // 献立のほかの操作とは別の合併型（画面の網羅 switch を壊さない）
    expect(isDinnerRequest(one)).toBe(false)
    expect(isDinnerServingsRequest({ op: "generate", ...generate })).toBe(false)
    expect(isDinnerServingsRequest({ op: "constructor" })).toBe(false)
  })

  it("範囲・型・null を検証する", () => {
    for (const bad of [
      { days: 0 },
      { days: 8 },
      { days: 1.5 },
      { startDate: "2026-02-30" },
      { startDate: null },
      { expectedRevision: -1 },
      { expectedRevision: "0" },
      { operationId: "not-a-uuid" },
      { mode: "ai" },
      { servings: 0 },
      { servings: 13 },
      { constraints: {} },
    ]) {
      expect(isGenerateDinnerPlanRequest({ ...generate, ...bad })).toBe(false)
    }
    expect(isGenerateDinnerPlanRequest({ ...generate, servings: 12, includeStaple: true })).toBe(true)
  })

  it("希望の形: 余分なキー・自由な文字列の ID・範囲外の時間を拒む", () => {
    const wish = { pins: [], preferTags: [], avoidTags: [], maxMinutes: null, preferRecipeIds: [] }
    expect(isWishConstraintsShape(wish)).toBe(true)
    expect(isWishConstraintsShape({ ...wish, pins: [{ date: TODAY, recipeId: "nikujaga" }], maxMinutes: 30 })).toBe(true)
    expect(isWishConstraintsShape({ ...wish, steps: ["自由な手順"] })).toBe(false)
    expect(isWishConstraintsShape({ ...wish, pins: [{ date: TODAY, recipeId: "Nikujaga; DROP" }] })).toBe(false)
    expect(isWishConstraintsShape({ ...wish, pins: [{ date: TODAY, recipeId: "nikujaga", note: "x" }] })).toBe(false)
    expect(isWishConstraintsShape({ ...wish, maxMinutes: 4 })).toBe(false)
    expect(isWishConstraintsShape({ ...wish, preferTags: ["fish", "fish"] })).toBe(false)
  })

  it("手動料理・買い物の入力の境界", () => {
    const dish = { id: UUID, version: null, date: TODAY, role: "main", title: "おでん", ingredients: null }
    expect(isSaveCustomDishRequest(dish)).toBe(true)
    expect(isSaveCustomDishRequest({ ...dish, title: "   " })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, title: "あ".repeat(61) })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, role: "dessert" })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, ingredients: [{ name: "卵", amount: 2, unit: "piece" }] })).toBe(true)
    // 適量・少々に数値を付けない／数値の単位に量が無いものは拒む／未知の単位は拒む
    expect(isSaveCustomDishRequest({ ...dish, ingredients: [{ name: "塩", amount: 1, unit: "pinch" }] })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, ingredients: [{ name: "卵", amount: null, unit: "piece" }] })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, ingredients: [{ name: "卵", amount: 2, unit: "dozen" }] })).toBe(false)
    expect(isSaveCustomDishRequest({ ...dish, ingredients: [{ amount: 2, unit: "piece" }] })).toBe(false)

    const purchase = { id: UUID, version: VERSION }
    expect(isSetGroceryPurchaseRequest({ ...purchase, purchase: { kind: "full" } })).toBe(true)
    expect(isSetGroceryPurchaseRequest({ ...purchase, purchase: { kind: "amount", amount: 300 } })).toBe(true)
    expect(isSetGroceryPurchaseRequest({ ...purchase, purchase: { kind: "amount", amount: -1 } })).toBe(false)
    expect(isSetGroceryPurchaseRequest({ ...purchase, purchase: { kind: "amount", amount: Number.NaN } })).toBe(false)
    expect(isSetGroceryPurchaseRequest({ ...purchase, purchase: { kind: "check", checked: "yes" } })).toBe(false)
    expect(isSetGroceryPurchaseRequest({ ...purchase, version: null, purchase: { kind: "full" } })).toBe(false)

    const restock = { groceryId: UUID, version: VERSION, pantryItemId: UUID, quantity: 300 }
    expect(isRestockPantryFromGroceryRequest(restock)).toBe(true)
    expect(isRestockPantryFromGroceryRequest({ ...restock, quantity: null })).toBe(true)
    expect(isRestockPantryFromGroceryRequest({ ...restock, quantity: 0 })).toBe(false)
    expect(isRestockPantryFromGroceryRequest({ ...restock, pantryItemId: "p1" })).toBe(false)

    const manual = { id: UUID, version: null, name: "牛乳", quantity: null, unit: null, section: null, note: null }
    expect(isSaveGroceryManualItemRequest(manual)).toBe(true)
    expect(isSaveGroceryManualItemRequest({ ...manual, quantity: 1 })).toBe(false)
    expect(isSaveGroceryManualItemRequest({ ...manual, unit: "l" })).toBe(false)
    expect(isSaveGroceryManualItemRequest({ ...manual, quantity: 1, unit: "l" })).toBe(true)
    expect(isSaveGroceryManualItemRequest({ ...manual, name: "あ".repeat(41) })).toBe(false)
  })
})
