/**
 * 新しいスケジュール/メモの統合契約。アプリ本物のデータ組み立てをメモリ上のDBで検証する。
 * カタログは実物、時刻はJST暦日。別の世帯の情報が混ざらないことも保証する。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeDinnerDb, entryRow, groceryRow, type FakeDinnerDb } from "@/lib/meals/server/__tests__/fake-dinner-db"

const actions = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  saveDinnerRequest: vi.fn(),
  saveGroceryRequest: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext: actions.getAuthContext }))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({
  saveDinnerRequest: actions.saveDinnerRequest,
  interpretDinnerWish: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest: actions.saveGroceryRequest }))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  addPantryItems: vi.fn(), savePantryItem: vi.fn(), deletePantryItem: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: vi.fn(), saveFoodExclusion: vi.fn(), deleteFoodExclusion: vi.fn(),
  saveFoodPreference: vi.fn(), deleteFoodPreference: vi.fn(), deleteDishFeedback: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/chores/meals",
}))

import MealsSchedulePage from "../page"
import MealMemoPage from "../memo/page"

const USER = "f4000000-0000-4000-8000-000000000001"
const HOUSE = "f4000000-0000-4000-8000-0000000000a1"
const OTHER = "f4000000-0000-4000-8000-0000000000b1"
const TODAY = "2026-11-11"
let db: FakeDinnerDb

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  localStorage.clear()
  vi.resetAllMocks()
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  actions.getAuthContext.mockResolvedValue({
    error: null, reason: null, context: { supabase: db.supabase, userId: USER, householdId: HOUSE },
  })
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("スケジュール画面", () => {
  it("月曜〜日曜の7日と料理名を表示し、曜日を押すと料理詳細が開く", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga" }),
      entryRow(OTHER, { plan_date: TODAY, recipe_id: "oyakodon" }),
    )
    render(await MealsSchedulePage())
    expect(screen.getByTestId("schedule-week").querySelectorAll("li")).toHaveLength(7)
    expect(screen.getByText("肉じゃが")).toBeInTheDocument()
    expect(screen.queryByText("親子丼")).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /11\/11.*の献立を見る/ }))
    })
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("肉じゃが")).toBeInTheDocument()
    expect(within(dialog).getByText(/材料（レシピ/)).toBeInTheDocument()
    expect(within(dialog).getByRole("link", { name: "料理の詳細を見る" })).toHaveAttribute("href", "/chores/meals/recipes/nikujaga")
    expect(within(dialog).getByRole("link", { name: "献立を変更する" })).toHaveAttribute("href", "/chores/meals/plan")
  })

  it("献立を読み込めなければ「未定」と偽らず、最後に読めた内容を保つ", async () => {
    db.failTable("dinner_plan_entries")
    const page = await MealsSchedulePage()
    expect(() => render(page)).toThrow(/読み込めませんでした/)
    expect(screen.queryByText("未定")).not.toBeInTheDocument()
  })

  it("認証されていない場合は世帯の内容を描かない", async () => {
    actions.getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await MealsSchedulePage()).toBeNull()
  })
})

describe("家族と共有する買い物メモ", () => {
  it("手動の買い物をメモとして表示し、別世帯や自動生成の項目を本文へ混ぜない", async () => {
    db.tables.grocery_items.push(
      groceryRow(HOUSE, { name: "キッチンペーパー", origin: "manual", item_key: null, ingredient_id: null, section: "other" }),
      groceryRow(HOUSE, { name: "豚こま切れ肉", origin: "auto" }),
      groceryRow(OTHER, { name: "他の世帯のメモ", origin: "manual", item_key: null, ingredient_id: null }),
    )
    render(await MealMemoPage())
    const list = screen.getByTestId("memo-list")
    expect(within(list).getByText("キッチンペーパー")).toBeInTheDocument()
    expect(within(list).queryByText("豚こま切れ肉")).not.toBeInTheDocument()
    expect(screen.queryByText("他の世帯のメモ")).not.toBeInTheDocument()
    expect(screen.getByLabelText("買い物メモを追加")).toBeInTheDocument()
  })

  it("メモ追加は数量・単位・売場を要求せず、既存の版付き買い物操作で保存する", async () => {
    actions.saveGroceryRequest.mockResolvedValue({ status: "saved", notices: [] })
    render(await MealMemoPage())
    const input = screen.getByLabelText("買い物メモを追加")
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: "週末の鍋用に白菜" } })
    await act(async () => { fireEvent.submit(input.closest("form") as HTMLFormElement) })
    await waitFor(() => expect(actions.saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(actions.saveGroceryRequest.mock.calls[0][0]).toMatchObject({
      op: "manual_item",
      name: "週末の鍋用に白菜",
      quantity: null, unit: null, section: "other", note: null, version: null,
    })
    await waitFor(() => expect(input).toHaveValue(""))
  })

  it("購入チェックは別操作で、在庫へ自動登録しない", async () => {
    actions.saveGroceryRequest.mockResolvedValue({ status: "saved", notices: [] })
    db.tables.grocery_items.push(
      groceryRow(HOUSE, { name: "牛乳", origin: "manual", item_key: null, ingredient_id: null, section: "other" }),
    )
    render(await MealMemoPage())
    const checkbox = screen.getByRole("checkbox", { name: "牛乳を購入済みにする" })
    await waitFor(() => expect(checkbox).toBeEnabled())
    await act(async () => { fireEvent.click(checkbox) })
    await waitFor(() => expect(actions.saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(actions.saveGroceryRequest.mock.calls[0][0]).toMatchObject({
      op: "purchase", purchase: { kind: "check", checked: true },
    })
    expect(db.calls.rpc.map(([name]) => name)).not.toContain("add_pantry_items")
  })
})
