/**
 * 買い物の Server Action の契約。
 *
 * - X-05: 認証と世帯は getAuthContext から。余分な項目を持つ要求は拒む
 * - C-41 / C-45: 必要量はサーバーが確定した献立から計算する。同期は冪等で、手動項目と購入の記録を消さない
 * - C-46: 300g 購入後に必要量が 500g へ増えたら、残り 200g
 * - C-47: 購入と在庫への補充は別の事実。補充は確認した量だけを 1 度だけ反映する（再送で二重にならない）
 *
 * DB は `fake-dinner-db.ts` の代役、カタログは実物。肉じゃが（2 人分）は豚こま 150g、
 * カレーライス（2 人分）は豚こま 200g を使う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath } = vi.hoisted(() => ({ getAuthContext: vi.fn(), revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))

import {
  deleteGroceryItem,
  restockPantryFromGrocery,
  saveGroceryManualItem,
  saveGroceryRequest,
  setGroceryPurchase,
  syncGroceryList,
  updateGroceryItemMeta,
} from "../actions"
import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  groceryRow,
  type FakeDinnerDb,
  type Row,
} from "@/lib/meals/server/__tests__/fake-dinner-db"
import type { GrocerySaveSuccess } from "@/lib/meals/server/plan-requests"
import { loadShoppingView, type ShoppingItemView } from "@/lib/meals/server/plan-views"

const USER = "f1000000-0000-4000-8000-000000000001"
const HOUSE = "f1000000-0000-4000-8000-0000000000a1"
const OTHER_HOUSE = "f1000000-0000-4000-8000-0000000000b2"
const OP1 = "f2000000-0000-4000-8000-000000000001"
const OP2 = "f2000000-0000-4000-8000-000000000002"
const OP3 = "f2000000-0000-4000-8000-000000000003"
const MANUAL = "f3000000-0000-4000-8000-000000000001"
const PANTRY1 = "f4000000-0000-4000-8000-000000000001"
const PANTRY2 = "f4000000-0000-4000-8000-000000000002"
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"

let db: FakeDinnerDb

function success(result: unknown): GrocerySaveSuccess {
  expect(result).not.toHaveProperty("error")
  return result as GrocerySaveSuccess
}

function pork(): Row {
  const row = db.grocery().find((item) => item.item_key === "pork_komagire|mass")
  if (!row) throw new Error("pork item not found")
  return row
}

/** 献立を変えた（版が進んだ）ことにする。 */
function bumpPlanRevision(): void {
  const state = db.tables.dinner_plan_state.find((row) => row.household_id === HOUSE)
  if (!state) throw new Error("plan state not found")
  state.revision = (state.revision as number) + 1
}

async function viewOf(id: unknown): Promise<ShoppingItemView> {
  const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
  if (!loaded.ok) throw new Error("view failed")
  const all = [...loaded.view.sections.flatMap((section) => section.items), ...loaded.view.purchased, ...loaded.view.notNeeded]
  const found = all.find((item) => item.id === id)
  if (!found) throw new Error("item view not found")
  return found
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.supabase, userId: USER, householdId: HOUSE },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  getAuthContext.mockReset()
  revalidatePath.mockReset()
})

describe("X-05 認証と世帯の境界", () => {
  it("未認証なら、どの Action も DB に触れずに拒否する", async () => {
    getAuthContext.mockResolvedValue({ error: "ログインが必要です", reason: "unauthenticated", context: null })
    const results = await Promise.all([
      syncGroceryList({ operationId: OP1 }),
      setGroceryPurchase({ id: MANUAL, version: "v", purchase: { kind: "full" } }),
      saveGroceryManualItem({ id: MANUAL, version: null, name: "牛乳", quantity: null, unit: null, section: null, note: null }),
      updateGroceryItemMeta({ id: MANUAL, version: "v", note: "特売", section: null }),
      deleteGroceryItem({ id: MANUAL, version: "v" }),
      restockPantryFromGrocery({ groceryId: MANUAL, version: "v", pantryItemId: PANTRY1, quantity: null }),
    ])
    for (const result of results) expect(result).toEqual({ error: "ログインが必要です", failure: "rejected" })
    expect(db.calls.rpc).toEqual([])
    expect(db.calls.from).toEqual([])
  })

  it("世帯 ID を紛れ込ませた要求は拒否する。別世帯の項目は見つからない扱いで書かない", async () => {
    expect(await syncGroceryList({ operationId: OP1, householdId: OTHER_HOUSE } as never)).toMatchObject({
      failure: "rejected",
    })
    expect(await saveGroceryRequest({ op: "sync", operationId: OP1, household_id: OTHER_HOUSE } as never)).toMatchObject({
      failure: "rejected",
    })
    expect(db.calls.rpc).toEqual([])

    const foreign = groceryRow(OTHER_HOUSE, { name: "豚こま切れ肉", required_quantity: 300, unit: "g" })
    db.tables.grocery_items.push(foreign)
    const result = success(
      await setGroceryPurchase({ id: foreign.id as string, version: foreign.updated_at as string, purchase: { kind: "full" } }),
    )
    expect(result).toMatchObject({ status: "conflict", detail: "gone" })
    expect(db.rpcNames()).toEqual([])
    expect(foreign.purchased_quantity).toBe(0)
  })
})

describe("献立からの同期（syncGroceryList）", () => {
  it("確定した料理だけから必要量を計算する（提案・作った料理は入れない。人数を反映する）", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 }),
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "proposed" }),
      entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "tamagoyaki", status: "cooked" }),
      // 過ぎた日の確定は対象外
      entryRow(HOUSE, { plan_date: "2026-11-10", recipe_id: "ginger_pork", status: "confirmed" }),
    )
    const result = success(await syncGroceryList({ operationId: OP1 }))
    expect(result.status).toBe("saved")
    // 肉じゃが 2 人分で 150g → 4 人分で 300g
    expect(pork()).toMatchObject({ required_quantity: 300, unit: "g", origin: "auto", still_needed: true })
    expect(pork().sources).toEqual([expect.objectContaining({ date: TODAY, recipeId: "nikujaga", title: "肉じゃが" })])
    const keys = db.grocery().map((item) => item.item_key as string)
    expect(keys).toContain("potato|count:piece")
    // 提案のカレー（ルウ）・作った卵焼き（卵）の材料は入らない
    expect(keys.some((key) => key.startsWith("curry_roux|"))).toBe(false)
    expect(keys.some((key) => key.startsWith("egg|"))).toBe(false)
    // どの項目の出所も、今日の肉じゃがだけ（過ぎた日のしょうが焼きの材料は入らない）
    const sources = db.grocery().flatMap((item) => item.sources as { date: string; recipeId: string }[])
    expect(new Set(sources.map((source) => `${source.date}|${source.recipeId}`))).toEqual(new Set([`${TODAY}|nikujaga`]))
  })

  it("冪等: 同じ献立で何度同期しても、行の数も内容も版も変わらない。手動項目も残る", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    success(await saveGroceryManualItem({ id: MANUAL, version: null, name: "牛乳", quantity: 1, unit: "l", section: "egg_dairy", note: null }))
    expect(success(await syncGroceryList({ operationId: OP1 })).status).toBe("saved")
    const first = JSON.stringify(db.grocery())
    const count = db.grocery().length

    expect(success(await syncGroceryList({ operationId: OP2 })).status).toBe("saved")
    expect(db.grocery()).toHaveLength(count)
    expect(JSON.stringify(db.grocery())).toBe(first)
    expect(db.grocery().find((item) => item.id === MANUAL)).toMatchObject({ origin: "manual", name: "牛乳" })

    // 同じ操作 ID の再送は、計算も書込もし直さない（replayed）
    const syncCalls = () => db.rpcNames().filter((name) => name === "sync_grocery_auto_items").length
    const before = syncCalls()
    expect(success(await syncGroceryList({ operationId: OP2 })).status).toBe("replayed")
    expect(syncCalls()).toBe(before)
    expect(JSON.stringify(db.grocery())).toBe(first)
  })

  it("計算の後に献立が変わっていたら、読み直して 1 回だけやり直す", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    let calls = 0
    db.intercept("sync_grocery_auto_items", () => {
      calls += 1
      return calls === 1 ? { data: { status: "conflict", revision: 9 }, error: null } : undefined
    })
    expect(success(await syncGroceryList({ operationId: OP1 })).status).toBe("saved")
    expect(calls).toBe(2)
    expect(pork().required_quantity).toBe(150)

    // 2 回続けて変わっていたら、書かずに止める（古い必要量を書かない）
    db.intercept("sync_grocery_auto_items", () => ({ data: { status: "conflict", revision: 9 }, error: null }))
    const busy = await syncGroceryList({ operationId: OP3 })
    expect(busy).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames().filter((name) => name === "sync_grocery_auto_items")).toHaveLength(4)
  })

  it("読む間に献立の枠が確定でなくなった（DB が出所を 22023 で拒んだ）ら、読み直して 1 回だけやり直す", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    let calls = 0
    db.intercept("sync_grocery_auto_items", () => {
      calls += 1
      return calls === 1
        ? { data: null, error: { code: "22023", message: "a source names an entry that is not confirmed" } }
        : undefined
    })
    expect(success(await syncGroceryList({ operationId: OP1 })).status).toBe("saved")
    expect(calls).toBe(2)
    expect(db.grocery().map((row) => row.item_key)).toContain("pork_komagire|mass")
    // 対照: ほかの 22023 はやり直さずに拒否として返す
    db.intercept("sync_grocery_auto_items", () => ({ data: null, error: { code: "22023", message: "invalid sync" } }))
    expect(await syncGroceryList({ operationId: OP2 })).toMatchObject({ failure: "rejected" })
  })

  it("献立に読めない行があるときは同期を送らない（その料理の材料を「不要」として消さない）", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }),
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "status_from_the_future" }),
    )
    const result = await syncGroceryList({ operationId: OP1 })
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("読めない記録") })
    expect(db.rpcNames()).toEqual([])
  })

  it("献立の読み込みに失敗したら、空の献立で同期しない", async () => {
    db.tables.grocery_items.push(groceryRow(HOUSE, { name: "豚こま切れ肉", required_quantity: 300, unit: "g" }))
    db.failTable("dinner_plan_entries")
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames()).toEqual([])
    expect(db.grocery()).toHaveLength(1)
  })
})

describe("購入の記録と、必要量の増加（C-46）", () => {
  beforeEach(async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 }),
    )
    success(await syncGroceryList({ operationId: OP1 }))
  })

  it("300g 購入した後に必要量が 500g へ増えたら、購入量は残り、残り 200g と出る", async () => {
    const bought = success(
      await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "full" } }),
    )
    expect(bought.status).toBe("saved")
    expect(pork()).toMatchObject({ purchased_quantity: 300, purchased: true })
    expect(await viewOf(pork().id)).toMatchObject({ state: "purchased", remainingAmount: 0 })
    // 購入しただけでは在庫は増えない
    expect(db.tables.pantry_items).toEqual([])

    // 献立にカレー（豚こま 200g）が確定で加わった
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "confirmed" }))
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP2 }))
    expect(pork()).toMatchObject({ required_quantity: 500, purchased_quantity: 300 })
    const view = await viewOf(pork().id)
    expect(view).toMatchObject({ state: "to_buy", requiredAmount: 500, purchasedAmount: 300, remainingAmount: 200, remainingText: "200g" })
    expect(view.sources.map((source) => source.title).sort()).toEqual(["カレーライス", "肉じゃが"])
  })

  it("数値の項目は量で、数値で追えない項目はチェックで記録する（取り違えは拒否）", async () => {
    const id = pork().id as string
    expect(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "check", checked: true } })).toMatchObject({
      failure: "rejected",
    })
    const partial = success(
      await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 100 } }),
    )
    expect(partial.status).toBe("saved")
    expect(pork()).toMatchObject({ purchased_quantity: 100, purchased: false })
    expect(await viewOf(id)).toMatchObject({ state: "to_buy", remainingAmount: 200 })

    // 0 で取り消し
    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 0 } }))
    expect(pork()).toMatchObject({ purchased_quantity: 0, purchased: false })

    success(await saveGroceryManualItem({ id: MANUAL, version: null, name: "ラップ", quantity: null, unit: null, section: null, note: null }))
    const manual = () => db.grocery().find((item) => item.id === MANUAL) as Row
    expect(
      await setGroceryPurchase({ id: MANUAL, version: manual().updated_at as string, purchase: { kind: "full" } }),
    ).toMatchObject({ failure: "rejected" })
    success(
      await setGroceryPurchase({ id: MANUAL, version: manual().updated_at as string, purchase: { kind: "check", checked: true } }),
    )
    expect(manual()).toMatchObject({ purchased: true, purchased_quantity: 0 })
    expect(await viewOf(MANUAL)).toMatchObject({ state: "purchased", numeric: false, origin: "manual" })
  })

  it("古い版では書かない。同じ内容の再送は replayed", async () => {
    const id = pork().id as string
    const version = pork().updated_at as string
    success(await setGroceryPurchase({ id, version, purchase: { kind: "full" } }))
    const after = pork().updated_at
    expect(success(await setGroceryPurchase({ id, version, purchase: { kind: "full" } })).status).toBe("replayed")
    expect(pork().updated_at).toBe(after)
    const stale = success(await setGroceryPurchase({ id, version, purchase: { kind: "amount", amount: 50 } }))
    expect(stale).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(pork().purchased_quantity).toBe(300)
  })
})

describe("在庫への補充（C-47）", () => {
  beforeEach(async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 }),
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "confirmed" }),
    )
    success(await syncGroceryList({ operationId: OP1 }))
  })

  it("購入していない項目は在庫へ足せない。購入量を超えても足せない", async () => {
    const id = pork().id as string
    expect(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 100 }),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("購入済み") })
    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    expect(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 301 }),
    ).toMatchObject({ failure: "rejected" })
    expect(db.tables.pantry_items).toEqual([])
    expect(db.rpcNames()).not.toContain("restock_pantry_from_grocery")
  })

  it("確認した量だけを 1 度だけ反映する。再送しても在庫は 1 行・補充量は 1 回分のまま", async () => {
    const id = pork().id as string
    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    expect(await viewOf(id)).toMatchObject({ remainingAmount: 200, restockableAmount: 300 })
    const request = { groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 300 }

    const first = success(await restockPantryFromGrocery(request))
    expect(first).toMatchObject({ status: "saved", grocery: { ok: true } })
    expect(db.tables.pantry_items).toEqual([
      expect.objectContaining({ id: PANTRY1, ingredient_id: "pork_komagire", quantity: 300, unit: "g", status: "have" }),
    ])
    // 購入の記録はそのまま。補充は別の事実として数える
    expect(pork()).toMatchObject({ purchased_quantity: 300, restocked_quantity: 300, restock_ids: [PANTRY1] })
    // 在庫 300g を一度だけ差し引いて必要量は 200g。残りは 200g のまま（二重に差し引かない・二重に数えない）
    expect(pork().required_quantity).toBe(200)
    expect(await viewOf(id)).toMatchObject({ state: "to_buy", remainingAmount: 200, restockableAmount: 0 })

    // 応答を失った再送（古い版・同じ在庫 ID）
    const again = success(await restockPantryFromGrocery(request))
    expect(again.status).toBe("replayed")
    expect(db.tables.pantry_items).toHaveLength(1)
    expect(pork()).toMatchObject({ restocked_quantity: 300, restock_ids: [PANTRY1] })
    expect(await viewOf(id)).toMatchObject({ remainingAmount: 200 })

    // 別の ID でもう一度足そうとしても、足せる量は残っていない
    expect(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY2, quantity: 1 }),
    ).toMatchObject({ failure: "rejected" })
    expect(db.tables.pantry_items).toHaveLength(1)
  })

  it("RPC 自身が守る補充の上限で拒まれたら、利用者向けの文にして在庫を作らない（Action の検査の後に上限が変わった）", async () => {
    const id = pork().id as string
    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    // Action が読んだ後・RPC の前に、別の経路で 250g が補充済みになった（版は同じまま = 版の衝突では止まらない）
    db.intercept("restock_pantry_from_grocery", () => {
      pork().restocked_quantity = 250
      return undefined
    })
    expect(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 100 }),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("購入した量を超えて") })
    expect(db.tables.pantry_items).toEqual([])
    // 対照: 残りの 50g ちょうどなら通る
    success(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 50 }),
    )
    expect(pork()).toMatchObject({ purchased_quantity: 300, restocked_quantity: 300 })
  })

  it("補充の後の買い物の再計算に失敗しても、補充の成功は変えずに別に知らせる", async () => {
    const id = pork().id as string
    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    db.intercept("sync_grocery_auto_items", () => ({ data: null, error: { code: "57014", message: "timeout" } }))
    const result = success(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 300 }),
    )
    expect(result).toMatchObject({ status: "saved", grocery: { ok: false } })
    expect(db.tables.pantry_items).toHaveLength(1)
  })
})

/**
 * 作った料理に使った分（充当）と、購入・補充の操作。購入は事実の合計で送り、使った分は今の必要にも
 * 在庫へも充てない。今日の肉じゃが（4 人分）= 豚こま 300g、金曜のカレー = 豚こま 200g。
 */
describe("作った料理に使った分と、購入・補充の操作", () => {
  beforeEach(async () => {
    const tonight = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 })
    db.tables.dinner_plan_entries.push(
      tonight,
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "confirmed" }),
    )
    success(await syncGroceryList({ operationId: OP1 }))
    success(await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    // 今日の肉じゃがを作った（献立の版が進み、同期が今日ぶんの 300g を充当として記録する）
    tonight.status = "cooked"
    tonight.prior_status = "confirmed"
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP2 }))
  })

  it("購入の事実 300g は残り、今日の料理に使った 300g は金曜ぶんに充てない（残り 200g・在庫へ足せる量 0）", async () => {
    expect(pork()).toMatchObject({ required_quantity: 200, purchased_quantity: 300, consumed_quantity: 300 })
    expect(await viewOf(pork().id)).toMatchObject({
      state: "to_buy",
      purchasedAmount: 300,
      consumedAmount: 300,
      remainingAmount: 200,
      restockableAmount: 0,
    })
    // 使った分は在庫へ足せない
    expect(
      await restockPantryFromGrocery({ groceryId: pork().id as string, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 1 }),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("作った料理に使った") })
    expect(db.tables.pantry_items).toEqual([])
  })

  it("買った量の合計は、在庫へ足した量 + 使った量より下げられない。「必要量まで購入」は使った分の上に足す", async () => {
    const id = pork().id as string
    expect(
      await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 250 } }),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("作った料理に使った量") })
    expect(pork()).toMatchObject({ purchased_quantity: 300 })

    success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "full" } }))
    // 300（事実）+ 金曜ぶん 200 = 500。使った 300g を買い戻したことにはしない
    expect(pork()).toMatchObject({ purchased_quantity: 500, consumed_quantity: 300, purchased: true })
    expect(await viewOf(id)).toMatchObject({ state: "purchased", remainingAmount: 0, restockableAmount: 200 })

    // 在庫へ足せるのは、買った 500 − 使った 300 = 200g まで
    expect(
      await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 201 }),
    ).toMatchObject({ failure: "rejected" })
    success(await restockPantryFromGrocery({ groceryId: id, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 200 }))
    expect(pork()).toMatchObject({ purchased_quantity: 500, restocked_quantity: 200, consumed_quantity: 300 })
  })
})

/**
 * 独立レビューの指摘 3・4: 同期が走らない「作った」・作る前に開いた画面からの買い足し。
 * 今日の肉じゃが（4 人分）= 豚こま 300g。「作った」は献立の RPC を直に呼んで再現する（同期は呼ばない）。
 */
describe("同期を待たない充当と、作る前の画面からの買い足し", () => {
  const cookedPayload = {
    plan_date: TODAY,
    role: "main",
    position: 0,
    recipe_id: "nikujaga",
    recipe_version: 1,
    custom_title: null,
    custom_ingredients: null,
    servings: 4,
    pinned: false,
    status: "cooked",
    origin: "auto",
  }
  let tonight: Row

  beforeEach(async () => {
    tonight = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 })
    db.tables.dinner_plan_entries.push(tonight)
    success(await syncGroceryList({ operationId: OP1 }))
    success(await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
  })

  it("「作った」の後に同期が走らなくても、使った 300g は在庫へ足せない（RPC が作った時に充当を記録する）", async () => {
    const cooked = await db.supabase.rpc("save_dinner_entry", {
      p_id: tonight.id as string,
      p_version: tonight.updated_at as string,
      p_entry: cookedPayload,
    })
    expect(cooked.error).toBeNull()
    expect(db.rpcNames().filter((name) => name === "sync_grocery_auto_items")).toHaveLength(1)
    expect(pork()).toMatchObject({ purchased_quantity: 300, consumed_quantity: 300 })
    expect(
      await restockPantryFromGrocery({ groceryId: pork().id as string, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 300 }),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("作った料理に使った") })
    expect(db.tables.pantry_items).toEqual([])
  })

  it("日が過ぎて使った扱いになった料理も、補充の前に数える（読んだ版は古くなり、読み直すと足せない）", async () => {
    // 献立にも買い物にも書込が無いまま日が過ぎた（同期も「作った」も走っていない）
    vi.setSystemTime(new Date("2026-11-12T03:00:00.000Z"))
    db.setToday("2026-11-12")
    const seen = pork()
    expect(seen).toMatchObject({ consumed_quantity: 0 })
    const stale = success(
      await restockPantryFromGrocery({ groceryId: seen.id as string, version: seen.updated_at as string, pantryItemId: PANTRY1, quantity: 300 }),
    )
    expect(stale).toMatchObject({ status: "conflict" })
    expect(pork()).toMatchObject({ purchased_quantity: 300, consumed_quantity: 300 })
    expect(
      await restockPantryFromGrocery({ groceryId: pork().id as string, version: pork().updated_at as string, pantryItemId: PANTRY1, quantity: 300 }),
    ).toMatchObject({ failure: "rejected" })
    expect(db.tables.pantry_items).toEqual([])
  })

  it("作る前に開いた画面（古い版）から、作った後の買い足しを合計で記録できる。購入が後から変わっていれば conflict", async () => {
    const before = pork()
    const oldScreen = { id: before.id as string, version: before.updated_at as string }
    tonight.status = "cooked"
    tonight.prior_status = "confirmed"
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP2 }))
    expect(pork().updated_at).not.toBe(oldScreen.version)

    // 版の違いは充当の記録・必要量だけ。購入の事実（300g）は変わっていないので通す
    const added = success(await setGroceryPurchase({ ...oldScreen, purchase: { kind: "amount", amount: 400 } }))
    expect(added.status).toBe("saved")
    expect(pork()).toMatchObject({ purchased_quantity: 400, consumed_quantity: 300 })
    expect(await viewOf(pork().id)).toMatchObject({ purchasedAmount: 400, consumedAmount: 300, restockableAmount: 100 })

    // 対照: 同じ古い画面からもう一度送ると、購入の事実が後から変わっているので上書きしない
    expect(success(await setGroceryPurchase({ ...oldScreen, purchase: { kind: "amount", amount: 450 } }))).toMatchObject({
      status: "conflict",
    })
    expect(pork()).toMatchObject({ purchased_quantity: 400 })
  })

  it("単位を変える前に開いた画面からの購入は、新しい単位で記録せず conflict にする（量だけの変更では止めない）", async () => {
    const manual = () => db.grocery().find((item) => item.id === MANUAL) as Row
    success(await saveGroceryManualItem({ id: MANUAL, version: null, name: "牛乳", quantity: 2, unit: "piece", section: null, note: null }))
    const beforeUnit = manual().updated_at as string
    // 対照: 必要な量だけを変えても、開いていた画面の購入は通る
    success(await saveGroceryManualItem({ id: MANUAL, version: beforeUnit, name: "牛乳", quantity: 3, unit: "piece", section: null, note: null }))
    expect(success(await setGroceryPurchase({ id: MANUAL, version: beforeUnit, purchase: { kind: "amount", amount: 2 } })).status).toBe(
      "saved",
    )
    const seen = manual().updated_at as string
    // 別の端末が単位を「個」→「ml」へ直した
    success(await saveGroceryManualItem({ id: MANUAL, version: seen, name: "牛乳", quantity: 200, unit: "ml", section: null, note: null }))
    expect(success(await setGroceryPurchase({ id: MANUAL, version: seen, purchase: { kind: "amount", amount: 3 } }))).toMatchObject({
      status: "conflict",
    })
    expect(manual()).toMatchObject({ purchased_quantity: 2, unit: "ml" })
  })

  it("合計の下限は「下げる」時だけ（使った量より低いままの再送や、上げる操作は止めない）", async () => {
    tonight.status = "cooked"
    tonight.prior_status = "confirmed"
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP2 }))
    const id = pork().id as string
    expect(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 200 } })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("作った料理に使った量"),
    })
    expect(success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } })).status).toBe(
      "replayed",
    )
    expect(success(await setGroceryPurchase({ id, version: pork().updated_at as string, purchase: { kind: "amount", amount: 350 } })).status).toBe(
      "saved",
    )
  })
})

/**
 * 使わない食材の設定を後から足しても、確定・固定済みの料理の材料が買い物に入り続けない。
 * 献立の状態は書き換えない（設定の保存は献立を書き換えない約束）。判定が「問題なし」でない確定の料理は、
 * 買い物の自動計算に入れず、買い物の画面に理由を出す。除外を読めないときは問題なしと見なさず同期を止める。
 * 親子丼 = 鶏もも肉・玉ねぎ・卵…（卵アレルギーに当たる）。肉じゃが = 豚こま切れ肉…（当たらない）。
 */
describe("使わない食材の設定に当たる確定の料理は、買い物の自動計算に入れない", () => {
  const EGG = "egg|count:piece"
  const keys = () => db.grocery().filter((row) => row.still_needed === true).map((row) => row.item_key)

  it("確定・固定の親子丼に卵アレルギーを足すと、次の同期で親子丼の材料は外れ、理由が出る。献立の状態は変えない", async () => {
    const oyakodon = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "oyakodon", status: "confirmed", pinned: true })
    db.tables.dinner_plan_entries.push(oyakodon, entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "nikujaga", status: "confirmed" }))
    success(await syncGroceryList({ operationId: OP1 }))
    expect(keys()).toEqual(expect.arrayContaining([EGG, "chicken_thigh|mass", "pork_komagire|mass"]))

    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    success(await syncGroceryList({ operationId: OP2 }))
    // 修正前: 状態だけで絞るので、確定の親子丼の卵が必要な項目に残った
    expect(keys()).not.toContain(EGG)
    expect(keys()).not.toContain("chicken_thigh|mass")
    // 対照: 当たらない料理の材料は残る
    expect(keys()).toContain("pork_komagire|mass")
    // 献立は書き換えない
    expect(db.entries().find((entry) => entry.id === oyakodon.id)).toMatchObject({ status: "confirmed", pinned: true })

    const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!loaded.ok) throw new Error("view failed")
    expect(loaded.view.heldDishes).toEqual([
      expect.objectContaining({ entryId: oyakodon.id, date: TODAY, title: "親子丼", verdict: "blocked" }),
    ])
    expect(loaded.view.exclusionsUnreadable).toBe(false)
    // 外した後のリストは今の献立と除外に合っている（古いと言わない）
    expect(loaded.view.stale).toBe(false)
  })

  it("材料の未登録の確定の手動料理は、除外を足すと「未確認」で保留に移り、理由が出る（対照: 除外が無ければ自動計算の対象外のまま）", async () => {
    const oden = entryRow(HOUSE, {
      plan_date: TODAY,
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      status: "confirmed",
      origin: "manual",
    })
    db.tables.dinner_plan_entries.push(oden, entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "nikujaga", status: "confirmed" }))
    success(await syncGroceryList({ operationId: OP1 }))
    const before = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!before.ok) throw new Error("view failed")
    // 対照: 除外が無い間は、材料の未登録の料理は「自動計算の対象外」で、保留ではない
    expect(before.view.heldDishes).toEqual([])
    expect(before.view.uncomputed).toEqual([expect.objectContaining({ entryId: oden.id, reason: "no_ingredients" })])

    // 苦手だけの除外でも、材料の分からない料理は「含まない」と言えない（label_check）
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { reason: "dislike", target_kind: "ingredient", target_id: "honey" }))
    success(await syncGroceryList({ operationId: OP2 }))
    const after = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!after.ok) throw new Error("view failed")
    expect(after.view.heldDishes).toEqual([
      {
        entryId: oden.id,
        date: TODAY,
        dateLabel: expect.any(String),
        title: "おでん",
        verdict: "label_check",
        // 理由は「材料が未登録」（「確かめられない材料がある」と、事実と違う理由を言わない）
        message:
          "材料が登録されていないため、使わない食材に当たるかを確かめられません。この料理は買い物の自動計算に入れていません。献立で材料を登録するか、選び直してください。",
      },
    ])
    // 同じ料理を「対象外」と「保留」の両方に出さない
    expect(after.view.uncomputed).toEqual([])
    // 対照: 当たらない確定の料理の材料は残る。献立の状態は変えない
    expect(keys()).toContain("pork_komagire|mass")
    expect(db.entries().find((entry) => entry.id === oden.id)).toMatchObject({ status: "confirmed" })
    expect(after.view.stale).toBe(false)
  })

  it("材料のある確定の料理が「未確認」（商品で原材料が変わる材料 + アレルギー）になると、その材料は外れる（対照: 確かめられる料理は残る）", async () => {
    const curry = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "curry_rice", status: "confirmed" })
    const salmon = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "salmon_shioyaki", status: "confirmed" })
    db.tables.dinner_plan_entries.push(curry, salmon)
    const has = (id: string) => keys().some((key) => String(key).startsWith(`${id}|`))
    success(await syncGroceryList({ operationId: OP1 }))
    expect(has("curry_roux")).toBe(true)
    expect(has("salmon")).toBe(true)

    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    success(await syncGroceryList({ operationId: OP2 }))
    // カレールウは商品で原材料が変わる。卵のアレルギーがあると「含まない」と言えないので、カレーの材料は入れない
    expect(has("curry_roux")).toBe(false)
    expect(has("pork_komagire")).toBe(false)
    // 対照: 原材料を確かめられる鮭の塩焼きは残る
    expect(has("salmon")).toBe(true)
    const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!loaded.ok) throw new Error("view failed")
    expect(loaded.view.heldDishes).toEqual([
      expect.objectContaining({ entryId: curry.id, title: "カレーライス", verdict: "label_check" }),
    ])
    expect(loaded.view.heldDishes[0].message).toContain("原材料を確かめられない")
    expect(db.entries().find((entry) => entry.id === curry.id)).toMatchObject({ status: "confirmed" })
    expect(loaded.view.stale).toBe(false)
  })

  it("判定できないアレルギーの登録で保留した料理には、その登録を理由に出す（対照: 確かめられない材料を本当に含む料理は元の理由）", async () => {
    const salmon = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "salmon_shioyaki", status: "confirmed" })
    const curry = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "confirmed" })
    db.tables.dinner_plan_entries.push(salmon, curry)
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" }),
    )
    success(await syncGroceryList({ operationId: OP1 }))
    // どの料理も当たらないと言えないので、どちらの材料も入れない
    expect(keys().some((key) => String(key).startsWith("salmon|"))).toBe(false)
    const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!loaded.ok) throw new Error("view failed")
    const messageOf = (id: unknown) => loaded.view.heldDishes.find((dish) => dish.entryId === id)?.message ?? ""
    expect(loaded.view.heldDishes.map((dish) => dish.verdict)).toEqual(["label_check", "label_check"])
    // 鮭の塩焼きそのものに確かめられない材料は無い。保留の理由（判定できない登録）とその名前を言う
    expect(messageOf(salmon.id)).toContain("「ぞぞぞ成分」")
    expect(messageOf(salmon.id)).not.toContain("確かめられない材料")
    // 対照: 商品で原材料が変わる材料を含むカレーは、元の理由のまま
    expect(messageOf(curry.id)).toBe(
      "原材料を確かめられない材料があるため、この料理の材料は買い物に入れていません。献立で確かめるか、選び直してください。",
    )
  })

  it("使わない食材の設定を読めないときは、問題なしと見なさずに同期を止め、理由を返す。画面は照合できないと言う", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "oyakodon", status: "confirmed" }))
    db.failTable("food_exclusions")
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("使わない食材の設定"),
    })
    expect(db.grocery()).toEqual([])
    expect(db.rpcNames()).not.toContain("sync_grocery_auto_items")

    const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!loaded.ok) throw new Error("the shopping list itself stays readable")
    expect(loaded.view).toMatchObject({ exclusionsUnreadable: true, heldDishes: [], stale: false })
  })

  it("読めない除外の行が 1 件でも在れば、同じく問題なしと見なさずに同期を止める（取得の失敗だけでなく）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "oyakodon", status: "confirmed" }))
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_kind: "synthetic_unknown_kind" }))
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("使わない食材の設定"),
    })
    expect(db.rpcNames()).not.toContain("sync_grocery_auto_items")
    const loaded = await loadShoppingView(db.supabase, HOUSE, { today: TODAY })
    if (!loaded.ok) throw new Error("the shopping list itself stays readable")
    expect(loaded.view).toMatchObject({ exclusionsUnreadable: true, heldDishes: [] })
  })

  it("作った料理の充当は、後から除外を足しても残る（もう食べた分は除外とは別の事実）", async () => {
    const tonight = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 })
    db.tables.dinner_plan_entries.push(tonight)
    success(await syncGroceryList({ operationId: OP1 }))
    success(await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }))
    tonight.status = "cooked"
    tonight.prior_status = "confirmed"
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP2 }))
    const before = { purchased: pork().purchased_quantity, consumed: pork().consumed_quantity, ledger: pork().consumptions }
    expect(before).toMatchObject({ purchased: 300, consumed: 300 })

    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "dislike", target_kind: "ingredient", target_id: "pork_komagire" }),
    )
    success(await syncGroceryList({ operationId: OP3 }))
    expect({ purchased: pork().purchased_quantity, consumed: pork().consumed_quantity, ledger: pork().consumptions }).toEqual(before)
  })
})

describe("手動項目・メモ・売場・削除（C-44）", () => {
  it("手動項目の作成と編集。数量だけ・単位だけの片方や、未知の売場は拒否する", async () => {
    expect(
      await saveGroceryManualItem({ id: MANUAL, version: null, name: "牛乳", quantity: 1, unit: null, section: null, note: null }),
    ).toMatchObject({ failure: "rejected" })
    expect(
      await saveGroceryManualItem({ id: MANUAL, version: null, name: "牛乳", quantity: null, unit: null, section: "moon", note: null }),
    ).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames()).toEqual([])

    const created = success(
      await saveGroceryManualItem({ id: MANUAL, version: null, name: " 牛乳 ", quantity: 1, unit: "l", section: "egg_dairy", note: "低脂肪" }),
    )
    expect(created.status).toBe("saved")
    const row = () => db.grocery().find((item) => item.id === MANUAL) as Row
    expect(row()).toMatchObject({ origin: "manual", name: "牛乳", required_quantity: 1, unit: "l", section: "egg_dairy", note: "低脂肪" })
    // 単位が L でも、量はその項目の単位で返す
    expect(await viewOf(MANUAL)).toMatchObject({ numeric: true, requiredAmount: 1, remainingAmount: 1, remainingText: "1L", sectionLabel: "卵・乳製品" })

    // 1 つの入口（saveGroceryRequest）からも同じ検証を通る
    const viaEntry = success(
      await saveGroceryRequest({ op: "meta", id: MANUAL, version: row().updated_at as string, note: null, section: null }),
    )
    expect(viaEntry.status).toBe("saved")
    expect(row()).toMatchObject({ note: null, section: null })
    expect(await saveGroceryRequest({ op: "meta", id: MANUAL, version: row().updated_at as string, note: null, section: "moon" })).toMatchObject({
      failure: "rejected",
    })
  })

  it("自動項目のメモと売場は再計算で消えない。必要な自動項目は削除できない", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed" }))
    success(await syncGroceryList({ operationId: OP1 }))
    const id = pork().id as string
    success(await updateGroceryItemMeta({ id, version: pork().updated_at as string, note: "特売の日に", section: "other" }))
    success(await syncGroceryList({ operationId: OP2 }))
    expect(pork()).toMatchObject({ note: "特売の日に", section: "other" })
    expect(await viewOf(id)).toMatchObject({ note: "特売の日に", section: "other", sectionOverridden: true })

    expect(await deleteGroceryItem({ id, version: pork().updated_at as string })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("献立で必要"),
    })
    expect(db.grocery().some((item) => item.id === id)).toBe(true)

    // 献立から外れると「もう不要」として残り（メモがあるため）、削除できる
    db.tables.dinner_plan_entries = []
    bumpPlanRevision()
    success(await syncGroceryList({ operationId: OP3 }))
    expect(pork()).toMatchObject({ still_needed: false, note: "特売の日に" })
    expect(await viewOf(id)).toMatchObject({ state: "not_needed" })
    expect(success(await deleteGroceryItem({ id, version: pork().updated_at as string })).status).toBe("saved")
    expect(db.grocery()).toEqual([])
  })
})
