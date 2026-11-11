/**
 * 買い物リストの画面（ShoppingView）の契約（要件台帳 C-41 / C-43 / C-44 / C-46 / C-47 / C-72、
 * X-02 / X-03 / X-09）。
 *
 * 項目の表示（`ShoppingItemView`）は、DB の行の形から本物の写像（`groceryItemFromRow` →
 * `toShoppingItemView`）で作る（残りの計算を画面のテストで書き直さない）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import { STORE_SECTIONS } from "@/lib/meals/catalog/sections"
import { groceryRow } from "@/lib/meals/server/__tests__/fake-dinner-db"
import type { GroceryRequest, GrocerySaveSuccess } from "@/lib/meals/server/plan-requests"
import { toShoppingItemView, type ShoppingItemView, type ShoppingView as ShoppingViewData } from "@/lib/meals/server/plan-views"
import { groceryItemFromRow } from "@/lib/meals/server/rows"

const { saveGroceryRequest, saveDinnerRequest, refresh } = vi.hoisted(() => ({
  saveGroceryRequest: vi.fn<(request: GroceryRequest) => Promise<GrocerySaveSuccess | ChoreSaveFailure>>(),
  saveDinnerRequest: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest }))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest, interpretDinnerWish: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  addPantryItems: vi.fn(),
  savePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: vi.fn(),
  saveFoodExclusion: vi.fn(),
  deleteFoodExclusion: vi.fn(),
  saveFoodPreference: vi.fn(),
  deleteFoodPreference: vi.fn(),
  deleteDishFeedback: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
  usePathname: () => "/chores/meals/shopping",
}))

import { CHORE_PENDING_PREFIX } from "@/lib/domain/chore-pending"

import { purchaseProgressText } from "../shopping-labels"
import { ShoppingView, type ShoppingViewProps } from "../shopping-view"

const OWNER: ChoreOwner = { userId: "a2000000-0000-4000-8000-000000000001", householdId: "a2000000-0000-4000-8000-0000000000a1" }
const HOUSE = OWNER.householdId
const TODAY = "2026-11-11"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** DB の行の形から、画面の 1 項目を作る。 */
function item(over: Record<string, unknown> & { name: string }): ShoppingItemView {
  const parsed = groceryItemFromRow(groceryRow(HOUSE, over))
  if (!parsed.ok) throw new Error(`fixture row is unreadable: ${parsed.field}`)
  return toShoppingItemView(parsed.value)
}

/** 項目を、画面の形（売場ごとのまだ買うもの・購入済み・不要）へ振り分ける。 */
function shopping(items: ShoppingItemView[], over: Partial<ShoppingViewData> = {}): ShoppingViewData {
  const toBuy = items.filter((entry) => entry.state === "to_buy")
  return {
    today: TODAY,
    from: TODAY,
    to: "2026-12-08",
    sections: STORE_SECTIONS.map((def) => ({
      section: def.id,
      label: def.label,
      items: toBuy.filter((entry) => entry.section === def.id),
    })).filter((group) => group.items.length > 0),
    purchased: items.filter((entry) => entry.state === "purchased"),
    notNeeded: items.filter((entry) => entry.state === "not_needed"),
    toBuyCount: toBuy.length,
    stale: false,
    uncomputed: [],
    heldDishes: [],
    exclusionsUnreadable: false,
    stapleAssumed: [],
    unreadableItems: 0,
    ...over,
  }
}

const pork = () =>
  item({
    name: "豚こま切れ肉",
    section: "meat",
    required_quantity: 500,
    unit: "g",
    purchased_quantity: 300,
    purchased: false,
    sources: [
      { date: "2026-11-12", recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 300, unit: "g" } },
      { date: "2026-11-13", recipeId: "curry_rice", title: "カレーライス", quantity: { amount: 200, unit: "g" } },
    ],
  })
const onion = () => item({ name: "玉ねぎ", item_key: "onion|count", ingredient_id: "onion", section: "vegetable", required_quantity: 2, unit: "piece" })
const salt = () => item({ name: "塩", item_key: "salt|none", ingredient_id: "salt", section: "seasoning", required_note: "少々" })
const milk = () => item({ name: "牛乳", item_key: "milk|volume", ingredient_id: "milk", section: "egg_dairy", required_quantity: 500, unit: "ml", purchased_quantity: 500, purchased: true })
const paper = () => item({ name: "キッチンペーパー", origin: "manual", item_key: null, ingredient_id: null, section: "other" })

function props(over: Partial<ShoppingViewProps> = {}): ShoppingViewProps {
  return { owner: OWNER, view: shopping([pork(), onion(), salt()]), ...over }
}
function view(over: Partial<ShoppingViewProps> = {}) {
  return render(<ShoppingView {...props(over)} />)
}

const rowOf = (name: string) => {
  const found = screen.getAllByTestId("shopping-item").find((row) => within(row).queryByText(name) !== null)
  if (!found) throw new Error(`row not found: ${name}`)
  return found
}
const box = (name: string) => screen.getByRole("checkbox", { name: `${name}を購入済みにする` })
const syncButton = () => screen.getByRole("button", { name: "献立から更新" })
async function ready() {
  await waitFor(() => expect(syncButton()).toBeEnabled())
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
const saved = (over: Partial<GrocerySaveSuccess> = {}): GrocerySaveSuccess => ({ status: "saved", notices: [], ...over })

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.restoreAllMocks()
})

describe("C-41 売場ごとに並べる", () => {
  it("まだ買うものを、店内を一巡する順の売場ごとに出す（項目の無い売場は出さない）", async () => {
    view()
    await ready()
    const sections = screen.getAllByTestId("shopping-section")
    expect(sections.map((section) => within(section).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "野菜・きのこ・果物",
      "肉・肉加工品",
      "調味料・粉類",
    ])
    expect(within(sections[0]).getByText("玉ねぎ")).toBeInTheDocument()
    expect(within(sections[1]).getByText("豚こま切れ肉")).toBeInTheDocument()
    expect(within(sections[2]).getByText("塩")).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 2, name: "まだ買うもの（3件）" })).toBeInTheDocument()
  })

  it("売場の一覧は 8 区分（野菜・肉・魚・卵/乳製品・大豆製品・主食・調味料・その他）", () => {
    expect(STORE_SECTIONS.map((def) => def.id)).toEqual([
      "vegetable",
      "meat",
      "fish",
      "egg_dairy",
      "soy",
      "staple",
      "seasoning",
      "other",
    ])
  })

  it("購入済みは下の区画へ送る", async () => {
    view({ view: shopping([pork(), milk()]) })
    await ready()
    const purchased = screen.getByRole("region", { name: "購入済み（1件）" })
    expect(within(purchased).getByText("牛乳")).toBeInTheDocument()
    expect(within(purchased).queryByText("豚こま切れ肉")).toBeNull()
    expect(box("牛乳")).toHaveAttribute("aria-checked", "true")
    // 購入済みの区画は、まだ買うものの後に在る
    const toBuy = screen.getByRole("region", { name: "まだ買うもの（1件）" })
    expect(toBuy.compareDocumentPosition(purchased) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("売場は項目の詳細から変えられる（食材の既定へ戻すこともできる）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = pork()
    view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    // 行に売場の上書きが在る項目は、既定へ戻す選択肢を持つ
    expect(within(dialog).getByRole("option", { name: "食材の既定の売場に戻す" })).toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText("売場"), { target: { value: "other" } })
    fireEvent.change(within(dialog).getByLabelText("メモ"), { target: { value: " 特売の日に " } })
    await click(within(dialog).getByRole("button", { name: "メモと売場を保存" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "meta",
      id: target.id,
      version: target.version,
      note: "特売の日に",
      section: "other",
    })
  })
})

describe("C-46 買った量と残り", () => {
  it("300g 購入済みで必要量が 500g なら「購入済み 300g・あと 200g」と出し、まだ買うものに残す", async () => {
    view()
    await ready()
    const row = rowOf("豚こま切れ肉")
    expect(within(row).getByText("必要 500g")).toBeInTheDocument()
    expect(within(row).getByTestId("shopping-progress")).toHaveTextContent("購入済み 300g・あと 200g")
    expect(box("豚こま切れ肉")).toHaveAttribute("aria-checked", "false")
  })

  it("対照: 未購入は「あと 2個」、必要量まで買えば残りを出さない", () => {
    expect(purchaseProgressText(onion())).toBe("あと 2個")
    expect(purchaseProgressText(milk())).toBe("購入済み 500ml")
    // 量で追えない項目は、量の文を作らない（チェックだけで示す）
    expect(purchaseProgressText(salt())).toBeNull()
  })

  it("在庫へ足した分は内訳として添える（残りの計算に効く）", () => {
    const restocked = item({
      name: "豚こま切れ肉",
      required_quantity: 200,
      unit: "g",
      purchased_quantity: 300,
      restocked_quantity: 300,
      restock_ids: ["c1000000-0000-4000-8000-000000000001"],
    })
    expect(purchaseProgressText(restocked)).toBe("購入済み 300g・うち在庫へ追加 300g・あと 200g")
  })

  it("作った料理に使った分も内訳として添える（購入済みは買った事実の合計のまま）", () => {
    const used = item({
      name: "豚こま切れ肉",
      required_quantity: 200,
      unit: "g",
      purchased_quantity: 300,
      consumed_quantity: 300,
    })
    expect(purchaseProgressText(used)).toBe("購入済み 300g・うち作った料理に使用 300g・あと 200g")
  })

  it("作った料理に使った分がある項目: 合計の欄は買った事実の合計を映し、使った量より下げては送らない", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = item({
      name: "豚こま切れ肉",
      section: "meat",
      required_quantity: 200,
      unit: "g",
      purchased_quantity: 300,
      consumed_quantity: 300,
    })
    view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/うち作った料理に使用: 300g/)).toBeInTheDocument()
    const input = within(dialog).getByLabelText("買った量（合計・g）")
    expect(input).toHaveValue("300")
    // 画面の「残り」や使い残しの量（0g）を合計として送らない
    fireEvent.change(input, { target: { value: "100" } })
    await click(within(dialog).getByRole("button", { name: "買った量を保存" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("作った料理に使った量と在庫へ追加した量の合計（300g）")
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    // 金曜ぶんの 200g を買い足した = 合計 500g
    fireEvent.change(input, { target: { value: "500" } })
    await click(within(dialog).getByRole("button", { name: "買った量を保存" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toMatchObject({ purchase: { kind: "amount", amount: 500 } })
  })

  it("買った量は詳細から調整できる（合計の量を送る）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = pork()
    view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    const input = within(dialog).getByLabelText("買った量（合計・g）")
    expect(input).toHaveValue("300")
    fireEvent.change(input, { target: { value: "400" } })
    await click(within(dialog).getByRole("button", { name: "買った量を保存" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "purchase",
      id: target.id,
      version: target.version,
      purchase: { kind: "amount", amount: 400 },
    })
  })
})

describe("C-43 / C-44 在庫量の確認・使う料理・メモ", () => {
  it("在庫の量が分からず差し引いていない項目に「在庫量を確認」を出す", async () => {
    view({
      view: shopping([
        item({ name: "しょうゆ", item_key: "soy_sauce|volume", ingredient_id: "soy_sauce", section: "seasoning", required_quantity: 30, unit: "ml", needs_stock_check: true }),
        onion(),
      ]),
    })
    await ready()
    expect(within(rowOf("しょうゆ")).getByText("在庫量を確認")).toBeInTheDocument()
    // 対照: 差し引けた項目には出さない
    expect(within(rowOf("玉ねぎ")).queryByText("在庫量を確認")).toBeNull()
  })

  it("どの日のどの料理に使うかを、展開して確かめられる", async () => {
    view()
    await ready()
    const row = rowOf("豚こま切れ肉")
    const toggle = within(row).getByRole("button", { name: "使う料理（2件）" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(within(row).queryByText(/肉じゃが/)).toBeNull()
    await click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(within(row).getByText("11/12（木） 肉じゃが（300g）")).toBeInTheDocument()
    expect(within(row).getByText("11/13（金） カレーライス（200g）")).toBeInTheDocument()
    // 使う料理の無い項目（手動など）には、展開の釦を出さない
    expect(within(rowOf("塩")).queryByRole("button", { name: /使う料理/ })).toBeNull()
  })

  it("メモを行に出す", async () => {
    view({ view: shopping([item({ name: "豚こま切れ肉", section: "meat", required_quantity: 500, unit: "g", note: "国産" })]) })
    await ready()
    expect(within(rowOf("豚こま切れ肉")).getByText("メモ: 国産")).toBeInTheDocument()
  })
})

describe("C-44 / C-45 手動の項目", () => {
  it("手動の項目は「手動」と出す（自動の項目と見分けられる）", async () => {
    view({ view: shopping([pork(), paper()]) })
    await ready()
    expect(within(rowOf("キッチンペーパー")).getByText("手動")).toBeInTheDocument()
    expect(within(rowOf("豚こま切れ肉")).queryByText("手動")).toBeNull()
  })

  it("項目を追加: 新しい ID を 1 回だけ作り、数量なしは数量も単位も null で送る", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    view()
    await ready()
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: " ラップ " } })
    await click(within(dialog).getByRole("button", { name: "この項目を追加" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "manual_item",
      id: expect.stringMatching(UUID),
      version: null,
      name: "ラップ",
      quantity: null,
      unit: null,
      section: "other",
      note: null,
    })
    expect(await screen.findByText("「ラップ」を買い物リストへ追加しました。")).toBeInTheDocument()
  })

  it("数量だけ・単位だけの片方は送らない", async () => {
    view()
    await ready()
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "牛乳" } })
    fireEvent.change(within(dialog).getByLabelText("数量（任意）"), { target: { value: "2" } })
    await click(within(dialog).getByRole("button", { name: "この項目を追加" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("数量を入れるときは、単位も選んでください。")
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    // 対照: 単位も選べば送る
    saveGroceryRequest.mockResolvedValue(saved())
    fireEvent.change(within(dialog).getByLabelText("単位"), { target: { value: "pack" } })
    await click(within(dialog).getByRole("button", { name: "この項目を追加" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toMatchObject({ op: "manual_item", name: "牛乳", quantity: 2, unit: "pack" })
  })

  it("「献立から更新」は操作 ID だけを送る（量はサーバーが計算する）。手動の項目は消えないと言う", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    view({ view: shopping([pork(), paper()], { stale: true }) })
    await ready()
    expect(screen.getByTestId("shopping-stale")).toHaveTextContent("古い可能性があります")
    await click(syncButton())
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({ op: "sync", operationId: expect.stringMatching(UUID) })
    expect(await screen.findByText(/購入の記録・メモ・手動の項目はそのままです/)).toBeInTheDocument()
  })
})

describe("購入チェック（楽観更新と巻き戻し。X-09 / C-72）", () => {
  it("押した瞬間に印を付け、項目の版を送る。保存できたら印はそのまま", async () => {
    const pending = deferred<GrocerySaveSuccess>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    const target = onion()
    view({ view: shopping([target, pork()]) })
    await ready()
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "false")
    await click(box("玉ねぎ"))
    // 応答の前に印が付く（楽観更新）
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "true")
    expect(box("玉ねぎ")).toHaveAttribute("aria-busy", "true")
    expect(saveGroceryRequest).toHaveBeenCalledTimes(1)
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "purchase",
      id: target.id,
      version: target.version,
      purchase: { kind: "full" },
    })
    await act(async () => {
      pending.resolve(saved())
    })
    await waitFor(() => expect(box("玉ねぎ")).not.toHaveAttribute("aria-busy"))
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "true")
    expect(await screen.findByText("「玉ねぎ」を購入済みにしました。在庫は変えていません。")).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it("拒否されたら印を戻し、理由を出す", async () => {
    const pending = deferred<ChoreSaveFailure>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    view()
    await ready()
    await click(box("玉ねぎ"))
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "true")
    await act(async () => {
      pending.resolve({ error: "保存できませんでした。通信状況を確認して、もう一度お試しください。", failure: "rejected" })
    })
    await waitFor(() => expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "false"))
    expect(screen.getByRole("alert")).toHaveTextContent("保存できませんでした。")
    expect(screen.queryByText("保存できたか確認できていない操作")).toBeNull()
  })

  it("結果不明なら印を戻し（確定と偽らない）、同じ操作で確かめ直せる控えを出す", async () => {
    saveGroceryRequest.mockRejectedValueOnce(new Error("fetch failed"))
    view()
    await ready()
    await click(box("玉ねぎ"))
    expect(await screen.findByText("保存できたか確認できていない操作")).toBeInTheDocument()
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText("「玉ねぎ」を購入済みに変更")).toBeInTheDocument()
    // 控えが在る間は、ほかの項目の印も押せない
    expect(box("豚こま切れ肉")).toBeDisabled()
    const first = saveGroceryRequest.mock.calls[0][0]

    saveGroceryRequest.mockResolvedValueOnce(saved({ status: "replayed" }))
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(2))
    expect(saveGroceryRequest.mock.calls[1][0]).toEqual(first)
    await waitFor(() => expect(screen.queryByText("保存できたか確認できていない操作")).toBeNull())
  })

  it("家族が先に変えていたら印を戻し、上書きしていないと言う", async () => {
    saveGroceryRequest.mockResolvedValue({ status: "conflict", detail: "row_changed", notices: [] })
    view()
    await ready()
    await click(box("玉ねぎ"))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("他の端末で先に変更されていました。上書きはしていません。")
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "false")
  })

  it("連打しても 1 回しか送らない（保存中は、どの項目の印も受けない）", async () => {
    const pending = deferred<GrocerySaveSuccess>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    view()
    await ready()
    await click(box("玉ねぎ"))
    await click(box("玉ねぎ"))
    await click(box("豚こま切れ肉"))
    expect(saveGroceryRequest).toHaveBeenCalledTimes(1)
    expect(box("豚こま切れ肉")).toBeDisabled()
    await act(async () => {
      pending.resolve(saved())
    })
    await waitFor(() => expect(box("豚こま切れ肉")).toBeEnabled())
  })

  it("量で追えない項目はチェックで記録し、取り消しもチェックで送る", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = salt()
    view({ view: shopping([target]) })
    await ready()
    await click(box("塩"))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toMatchObject({ op: "purchase", purchase: { kind: "check", checked: true } })
  })

  it("購入済みの取り消しは、買った量を在庫へ足した量まで戻す（在庫へ足した分は消さない）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = milk()
    view({ view: shopping([target]) })
    await ready()
    await click(box("牛乳"))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "purchase",
      id: target.id,
      version: target.version,
      purchase: { kind: "amount", amount: 0 },
    })
  })

  it("購入済みの取り消しは、作った料理に使った分を消さない（買った量の合計を、使った量 + 在庫へ足した量まで戻す）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    // 買った 500ml のうち 300ml を作った料理に使い、200ml を今の必要（200ml）に充てている = 購入済み
    const target = item({
      name: "牛乳",
      item_key: "milk|volume",
      ingredient_id: "milk",
      section: "egg_dairy",
      required_quantity: 200,
      unit: "ml",
      purchased_quantity: 500,
      purchased: true,
      consumed_quantity: 300,
    })
    expect(target.state).toBe("purchased")
    view({ view: shopping([target]) })
    await ready()
    await click(box("牛乳"))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "purchase",
      id: target.id,
      version: target.version,
      purchase: { kind: "amount", amount: 300 },
    })
  })

  it("サーバーの値が届いたら（項目の版が変わったら）、押した時の印ではなく届いた値を出す", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = onion()
    const { rerender } = view({ view: shopping([target]) })
    await ready()
    await click(box("玉ねぎ"))
    await waitFor(() => expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "true"))
    // 家族が取り消した後の値が届いた（版が進み、未購入）
    rerender(<ShoppingView {...props({ view: shopping([{ ...target, version: "2026-11-11T05:00:00.000001+00:00" }]) })} />)
    expect(box("玉ねぎ")).toHaveAttribute("aria-checked", "false")
  })
})

describe("C-47 「在庫へ追加」は購入チェックとは別の操作", () => {
  it("購入チェックは購入の記録だけを送る（在庫の ID や量を含まない）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    view()
    await ready()
    await click(box("玉ねぎ"))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    const request = saveGroceryRequest.mock.calls[0][0]
    expect(request.op).toBe("purchase")
    expect(JSON.stringify(request)).not.toMatch(/pantry|restock/i)
    expect(await screen.findByText(/在庫は変えていません/)).toBeInTheDocument()
  })

  it("購入済みの項目から、確認した量を 1 回だけ在庫へ足す（在庫の行 ID を 1 回だけ作る）", async () => {
    saveGroceryRequest.mockResolvedValue(saved({ grocery: { ok: true, status: "saved" } }))
    const target = milk()
    view({ view: shopping([target]) })
    await ready()
    // 購入済みの区画に、別の操作だと分かる説明が在る
    expect(screen.getByText(/購入済みにしただけでは、食材（在庫）は増えません/)).toBeInTheDocument()
    await click(screen.getByRole("button", { name: "牛乳を在庫へ追加" }))
    const dialog = await screen.findByRole("dialog")
    const section = within(dialog).getByTestId("restock-section")
    expect(section).toHaveTextContent("購入チェックとは別の操作です")
    const input = within(section).getByLabelText(/在庫へ足す量/)
    expect(input).toHaveValue("500")
    fireEvent.change(input, { target: { value: "450" } })
    await click(within(section).getByRole("button", { name: "在庫へ追加" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "restock",
      groceryId: target.id,
      version: target.version,
      pantryItemId: expect.stringMatching(UUID),
      quantity: 450,
    })
    expect(await screen.findByText("「牛乳」を在庫へ追加しました。購入の記録はそのままです。")).toBeInTheDocument()
  })

  it("「在庫へ追加」から開くと在庫へ追加の区画を先頭に、詳細から開くと量・メモの後に出す", async () => {
    view({ view: shopping([milk()]) })
    await ready()
    await click(screen.getByRole("button", { name: "牛乳を在庫へ追加" }))
    let dialog = await screen.findByRole("dialog")
    expect(dialog.querySelector("section")).toHaveAttribute("data-testid", "restock-section")
    await click(within(dialog).getByRole("button", { name: "閉じる" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await click(screen.getByRole("button", { name: "牛乳の詳細を開く" }))
    dialog = await screen.findByRole("dialog")
    expect(dialog.querySelector("section")).not.toHaveAttribute("data-testid", "restock-section")
    expect(within(dialog).getByTestId("restock-section")).toBeInTheDocument()
  })

  it("買った量を超える量は送らない", async () => {
    view({ view: shopping([milk()]) })
    await ready()
    await click(screen.getByRole("button", { name: "牛乳を在庫へ追加" }))
    const section = within(await screen.findByRole("dialog")).getByTestId("restock-section")
    fireEvent.change(within(section).getByLabelText(/在庫へ足す量/), { target: { value: "600" } })
    await click(within(section).getByRole("button", { name: "在庫へ追加" }))
    expect(within(section).getByRole("alert")).toHaveTextContent("買った量を超えて在庫へ追加することはできません")
    expect(saveGroceryRequest).not.toHaveBeenCalled()
  })

  it("対照: 未購入の項目には在庫へ追加の釦を出さず、購入済みにすると追加できると言う", async () => {
    view({ view: shopping([onion()]) })
    await ready()
    expect(screen.queryByRole("button", { name: "玉ねぎを在庫へ追加" })).toBeNull()
    await click(screen.getByRole("button", { name: "玉ねぎの詳細を開く" }))
    const section = within(await screen.findByRole("dialog")).getByTestId("restock-section")
    expect(section).toHaveTextContent("購入済みにすると、在庫へ追加できます。")
    expect(within(section).queryByRole("button", { name: "在庫へ追加" })).toBeNull()
  })

  it("買った分をすべて在庫へ足した後は、もう一度足す釦を出さない（二重に足さない）", async () => {
    const done = item({
      name: "牛乳",
      item_key: "milk|volume",
      ingredient_id: "milk",
      section: "egg_dairy",
      required_quantity: 500,
      unit: "ml",
      purchased_quantity: 1000,
      purchased: true,
      restocked_quantity: 1000,
      restock_ids: ["c1000000-0000-4000-8000-000000000001"],
    })
    view({ view: shopping([done]) })
    await ready()
    expect(screen.queryByRole("button", { name: "牛乳を在庫へ追加" })).toBeNull()
    await click(screen.getByRole("button", { name: "牛乳の詳細を開く" }))
    const section = within(await screen.findByRole("dialog")).getByTestId("restock-section")
    expect(section).toHaveTextContent("在庫へ追加済み: 1 回（合計 1L）")
    expect(section).toHaveTextContent("買った分は、すべて在庫へ追加済みです。")
    expect(within(section).queryByRole("button", { name: "在庫へ追加" })).toBeNull()
  })
})

describe("不要になった項目・自動計算に入っていない料理", () => {
  it("献立から不要になった購入済みの項目を別に出し、2 段の確認で削除できる", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const gone = item({ name: "鶏もも肉", item_key: "chicken_thigh|mass", ingredient_id: "chicken_thigh", section: "meat", required_quantity: 300, unit: "g", purchased_quantity: 300, purchased: true, still_needed: false })
    view({ view: shopping([pork(), gone]) })
    await ready()
    const region = screen.getByRole("region", { name: "献立からは不要になった項目（1件）" })
    expect(within(region).getByText("鶏もも肉")).toBeInTheDocument()
    expect(within(region).getByText("（購入済み 300g）")).toBeInTheDocument()
    // まだ買うもの・購入済みには並べない
    expect(screen.queryByRole("checkbox", { name: "鶏もも肉を購入済みにする" })).toBeNull()
    await click(within(region).getByRole("button", { name: "鶏もも肉を削除" }))
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    await click(within(region).getByRole("button", { name: "鶏もも肉を削除する" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({ op: "delete", id: gone.id, version: gone.version })
  })

  it("対照: 献立に必要な自動の項目には、削除の操作を出さない", async () => {
    view({ view: shopping([pork()]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByRole("button", { name: "この項目を削除" })).toBeNull()
    expect(within(dialog).getByText("献立から自動で作った項目")).toBeInTheDocument()
  })

  it("材料が未登録の手動料理を一覧にし、献立の画面（その日）の材料追加へつなげる", async () => {
    view({
      view: shopping([pork()], {
        uncomputed: [
          {
            entryId: "e2000000-0000-4000-8000-000000000001",
            date: "2026-11-14",
            dateLabel: "11/14（土）",
            title: "おでん",
            reason: "no_ingredients",
            message: "材料が登録されていないため、買い物の自動計算に入っていません。",
          },
        ],
      }),
    })
    await ready()
    const region = screen.getByRole("region", { name: "自動計算に入っていない料理" })
    expect(within(region).getByText("11/14（土） おでん")).toBeInTheDocument()
    expect(within(region).getByText("材料が登録されていないため、買い物の自動計算に入っていません。")).toBeInTheDocument()
    expect(within(region).getByRole("link", { name: "11/14（土） おでんの材料を献立の画面で追加" })).toHaveAttribute(
      "href",
      "/chores/meals/plan?start=2026-11-14",
    )
  })

  it("使わない食材の設定に当たる確定の料理は、材料を入れていない理由と料理名を出し、献立の画面（その日）へつなげる", async () => {
    view({
      view: shopping([pork()], {
        heldDishes: [
          {
            entryId: "e2000000-0000-4000-8000-000000000002",
            date: "2026-11-13",
            dateLabel: "11/13（金）",
            title: "親子丼",
            verdict: "blocked",
            message: "使わない食材の設定に当たる材料があるため、この料理の材料は買い物に入れていません。献立で選び直してください。",
          },
        ],
      }),
    })
    await ready()
    const region = screen.getByRole("region", { name: "使わない食材の設定に当たる料理" })
    expect(region).toHaveTextContent("使わない食材の設定に当たるため、次の料理の材料は入れていません: 親子丼")
    expect(within(region).getByText("11/13（金） 親子丼")).toBeInTheDocument()
    expect(within(region).getByRole("link", { name: "11/13（金） 親子丼を献立の画面で選び直す" })).toHaveAttribute(
      "href",
      "/chores/meals/plan?start=2026-11-13",
    )
    // 対照: 当たる料理が無ければ区画を出さない
    cleanup()
    view({ view: shopping([pork()]) })
    await ready()
    expect(screen.queryByRole("region", { name: "使わない食材の設定に当たる料理" })).toBeNull()
  })

  it("使わない食材の設定を読めないときは、照らせていないことと、更新を止めていることを知らせる", async () => {
    view({ view: shopping([pork()], { exclusionsUnreadable: true }) })
    await ready()
    expect(screen.getByTestId("shopping-exclusions-unreadable")).toHaveTextContent("使わない食材の設定を読めないため、献立と照らせていません")
    expect(screen.getByTestId("shopping-exclusions-unreadable")).toHaveAttribute("role", "alert")
  })
})

describe("空・失敗・他端末の反映（X-03 / C-72）", () => {
  it("項目が 1 件も無ければ、献立へ誘導する（手動の追加もできる）", async () => {
    view({ view: shopping([]) })
    await ready()
    expect(screen.getByText("買い物リストはまだありません")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "献立を作る" })).toHaveAttribute("href", "/chores/meals/plan")
    expect(screen.getByRole("button", { name: "項目を追加" })).toBeEnabled()
  })

  it("読めない項目が在るときは「まだありません」と言わない", async () => {
    view({ view: shopping([], { unreadableItems: 2 }) })
    await ready()
    expect(screen.queryByText("買い物リストはまだありません")).toBeNull()
    expect(screen.getByText("表示できる項目がありません")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("表示できない項目が 2 件あります。項目は消えていません。")
  })

  it("対照: 全部を買い終えたときは、空の案内ではなく「まだ買うものはありません」", async () => {
    view({ view: shopping([milk()]) })
    await ready()
    expect(screen.getByText("まだ買うものはありません。")).toBeInTheDocument()
    expect(screen.queryByText("買い物リストはまだありません")).toBeNull()
  })

  it("他の端末の変更が反映されるタイミングを文で示す", async () => {
    view()
    await ready()
    expect(screen.getByText(/ほかの端末での変更は、この画面に戻ったときと、開いている間は約30秒ごとに反映されます/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "今すぐ更新" })).toBeInTheDocument()
  })

  it("献立の画面で結果不明になった操作も、読めない控えにせず、ここから確かめ直せる", async () => {
    const OP = "92000000-0000-4000-8000-000000000001"
    const payload = { op: "confirm", expectedRevision: 3, startDate: TODAY, days: 7 }
    localStorage.setItem(
      `${CHORE_PENDING_PREFIX}${OWNER.userId}:${OWNER.householdId}:meal:${OP}`,
      JSON.stringify({
        schema: 1,
        id: OP,
        owner: OWNER,
        kind: "meal",
        label: "11/11（水）からの献立を確定",
        payload,
        phase: "unknown",
        firstAttemptAt: "2026-11-11T01:00:00.000Z",
      }),
    )
    saveDinnerRequest.mockResolvedValue({ status: "replayed", revision: 4, notices: [], grocery: null })
    view()
    expect(await screen.findByText("11/11（水）からの献立を確定")).toBeInTheDocument()
    expect(screen.queryByText(/読み取れない保存の控え/)).toBeNull()
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual(payload)
    expect(saveGroceryRequest).not.toHaveBeenCalled()
  })
})

describe("R35: 保存の応答は、その操作を送ったシートだけを閉じる", () => {
  it("危険側: 一覧のチェックの応答が、送信中に開いた別の項目のシートを閉じず、打ちかけのメモを消さない", async () => {
    const pending = deferred<GrocerySaveSuccess>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    view({ view: shopping([onion(), pork()]) })
    await ready()
    await click(box("玉ねぎ"))
    expect(saveGroceryRequest).toHaveBeenCalledTimes(1)

    // 応答を待つ間に、別の項目の詳細を開いてメモを打ち始める
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    const memo = within(dialog).getByLabelText("メモ")
    fireEvent.change(memo, { target: { value: "特売の日に買う" } })

    await act(async () => {
      pending.resolve(saved())
    })
    // 先の操作の結果は、開いているシートの中に出る
    await waitFor(() =>
      expect(within(dialog).getByText("「玉ねぎ」を購入済みにしました。在庫は変えていません。")).toBeInTheDocument(),
    )
    // シートは開いたまま、入力も残る（同じ欄のまま = 作り直されていない）
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("メモ")).toBe(memo)
    expect(memo).toHaveValue("特売の日に買う")
  })

  it("危険側: 一覧の操作が結果不明に終わっても、後から開いたシートを閉じない", async () => {
    const pending = deferred<GrocerySaveSuccess>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    view({ view: shopping([onion(), pork()]) })
    await ready()
    await click(box("玉ねぎ"))
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("メモ"), { target: { value: "打ちかけ" } })
    await act(async () => {
      pending.reject(new Error("fetch failed"))
    })
    await waitFor(() => expect(screen.getByText("保存できたか確認できていない操作")).toBeInTheDocument())
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("メモ")).toHaveValue("打ちかけ")
  })

  it("正常側: シートの中から送った操作の応答では、そのシートを閉じる", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    view({ view: shopping([pork()]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("メモ"), { target: { value: "国産" } })
    await click(within(dialog).getByRole("button", { name: "メモと売場を保存" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByText("「豚こま切れ肉」のメモ・売場を変更しました。")).toBeInTheDocument()
  })

  it("正常側: シートから送った操作の応答は、閉じて開き直した同じ項目のシートを閉じない（別のシートとして扱う）", async () => {
    const pending = deferred<GrocerySaveSuccess>()
    saveGroceryRequest.mockReturnValue(pending.promise)
    view({ view: shopping([pork()]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const first = await screen.findByRole("dialog")
    fireEvent.change(within(first).getByLabelText("メモ"), { target: { value: "国産" } })
    await click(within(first).getByRole("button", { name: "メモと売場を保存" }))
    // 応答の前に閉じて、同じ項目を開き直す
    await click(within(first).getByRole("button", { name: /閉じる|Close/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const second = await screen.findByRole("dialog")
    await act(async () => {
      pending.resolve(saved())
    })
    await waitFor(() => expect(within(second).getByText("「豚こま切れ肉」のメモ・売場を変更しました。")).toBeInTheDocument())
    expect(screen.getByRole("dialog")).toBe(second)
  })
})

describe("R33 / R37: 量・メモ・手動の項目は、入力を始めた時点の版を送る", () => {
  const V2 = "2026-11-11T05:00:00.000001+00:00"

  it("危険側: 入力の途中で家族が買った量を変えたら、古い入力に新しい版を付けて送らない（保存を止めて知らせる）", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = pork()
    const { rerender } = view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    const input = within(dialog).getByLabelText("買った量（合計・g）")
    fireEvent.change(input, { target: { value: "400" } })

    // 家族が 500g と記録した後の値が届いた（版が進む）
    rerender(<ShoppingView {...props({ view: shopping([{ ...target, version: V2, purchasedAmount: 500 }]) })} />)
    // 入力は消さない
    expect(within(dialog).getByLabelText("買った量（合計・g）")).toHaveValue("400")
    const notice = within(dialog).getAllByTestId("changed-elsewhere")[0]
    expect(notice).toHaveTextContent("他の端末で変更されました")
    expect(notice).toHaveTextContent("家族の変更を上書きしないため")
    const saveButton = within(dialog).getByRole("button", { name: "買った量を保存" })
    expect(saveButton).toBeDisabled()
    await click(saveButton)
    expect(saveGroceryRequest).not.toHaveBeenCalled()

    // 最新の内容を読み込むと、入力は最新の値に置き換わり、その版で送れる
    await click(within(notice).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(dialog).queryByTestId("changed-elsewhere")).toBeNull()
    expect(within(dialog).getByLabelText("買った量（合計・g）")).toHaveValue("500")
    fireEvent.change(within(dialog).getByLabelText("買った量（合計・g）"), { target: { value: "450" } })
    await click(within(dialog).getByRole("button", { name: "買った量を保存" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual({
      op: "purchase",
      id: target.id,
      version: V2,
      purchase: { kind: "amount", amount: 450 },
    })
  })

  it("危険側: メモを打っている途中で版が進んだら、メモと売場も保存を止める", async () => {
    const target = pork()
    const { rerender } = view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("メモ"), { target: { value: "私のメモ" } })
    rerender(<ShoppingView {...props({ view: shopping([{ ...target, version: V2, note: "家族のメモ" }]) })} />)
    expect(within(dialog).getByLabelText("メモ")).toHaveValue("私のメモ")
    expect(within(dialog).getByTestId("changed-elsewhere")).toHaveTextContent("他の端末で変更されました")
    const saveButton = within(dialog).getByRole("button", { name: "メモと売場を保存" })
    expect(saveButton).toBeDisabled()
    await click(saveButton)
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    await click(within(dialog).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(dialog).getByLabelText("メモ")).toHaveValue("家族のメモ")
  })

  it("危険側: 手動の項目の編集も、入力の途中で版が進んだら保存を止める", async () => {
    const target = paper()
    const { rerender } = view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "キッチンペーパーの詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "キッチンペーパー 2 ロール" } })
    rerender(<ShoppingView {...props({ view: shopping([{ ...target, version: V2, name: "キッチンタオル" }]) })} />)
    expect(within(dialog).getByLabelText("名前")).toHaveValue("キッチンペーパー 2 ロール")
    expect(within(dialog).getByTestId("changed-elsewhere")).toBeInTheDocument()
    const saveButton = within(dialog).getByRole("button", { name: "変更を保存" })
    expect(saveButton).toBeDisabled()
    await click(saveButton)
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    await click(within(dialog).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(dialog).getByLabelText("名前")).toHaveValue("キッチンタオル")
  })

  it("正常側: 触っていないフォームは届いた最新の値を映し、知らせを出さない。触って版が変わらなければ、その版で送る", async () => {
    saveGroceryRequest.mockResolvedValue(saved())
    const target = pork()
    const { rerender } = view({ view: shopping([target]) })
    await ready()
    await click(screen.getByRole("button", { name: "豚こま切れ肉の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    rerender(<ShoppingView {...props({ view: shopping([{ ...target, version: V2, purchasedAmount: 350, note: "届いたメモ" }]) })} />)
    expect(within(dialog).queryByTestId("changed-elsewhere")).toBeNull()
    expect(within(dialog).getByLabelText("買った量（合計・g）")).toHaveValue("350")
    expect(within(dialog).getByLabelText("メモ")).toHaveValue("届いたメモ")
    fireEvent.change(within(dialog).getByLabelText("買った量（合計・g）"), { target: { value: "400" } })
    await click(within(dialog).getByRole("button", { name: "買った量を保存" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toMatchObject({ version: V2, purchase: { kind: "amount", amount: 400 } })
  })
})

describe("規約（X-02）", () => {
  it("購入チェックは要素そのものが 44px（size-11）の checkbox。素の釦・リンクも 44px 以上", async () => {
    const { container } = view({ view: shopping([pork(), milk(), paper()]) })
    await ready()
    expect(box("豚こま切れ肉").className).toMatch(/\bsize-11\b/)
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    const raw = [...container.querySelectorAll("a, button")].filter(
      (element) => element.getAttribute("data-slot") !== "button",
    )
    expect(raw.length).toBeGreaterThan(3)
    for (const element of raw) {
      const cls = element.getAttribute("class") ?? ""
      expect(cls, element.textContent ?? "").toMatch(/\bmin-h-11\b|\bsize-11\b|\btouch-target\b/)
      expect(cls).not.toMatch(/transition-all/)
      expect(cls).not.toMatch(/(^|\s)outline-none(\s|$)/)
    }
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
