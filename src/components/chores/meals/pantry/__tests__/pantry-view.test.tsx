/**
 * 食材の画面（PantryView）の契約（要件台帳 C-21 / C-22 / C-27、X-02 / X-03 / X-09 / X-12、V-UI）。
 *
 * 「今日」は Server Component が渡す JST の日付（ここでは 2026-11-11 固定）。端末の時計は使わない。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { putChorePending, type ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import type {
  AddPantryItemsRequest,
  DeletePantryItemRequest,
  PantryBulkSaveSuccess,
  PantryDeleteSuccess,
  PantryItemSaveSuccess,
  PantryPreviewItem,
  PantryPreviewResult,
  SavePantryItemRequest,
} from "@/lib/meals/server/pantry-requests"
import type { StoredPantryItem } from "@/lib/meals/server/rows"

const actions = vi.hoisted(() => ({
  previewPantryText: vi.fn<(text: string) => Promise<PantryPreviewResult>>(),
  addPantryItems: vi.fn<(request: AddPantryItemsRequest) => Promise<PantryBulkSaveSuccess | ChoreSaveFailure>>(),
  savePantryItem: vi.fn<(request: SavePantryItemRequest) => Promise<PantryItemSaveSuccess | ChoreSaveFailure>>(),
  deletePantryItem: vi.fn<(request: DeletePantryItemRequest) => Promise<PantryDeleteSuccess | ChoreSaveFailure>>(),
  settings: vi.fn(),
  saveDinnerRequest: vi.fn(),
  saveGroceryRequest: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest: actions.saveDinnerRequest }))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest: actions.saveGroceryRequest }))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  previewPantryText: actions.previewPantryText,
  addPantryItems: actions.addPantryItems,
  savePantryItem: actions.savePantryItem,
  deletePantryItem: actions.deletePantryItem,
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: actions.settings,
  saveFoodExclusion: actions.settings,
  deleteFoodExclusion: actions.settings,
  saveFoodPreference: actions.settings,
  deleteFoodPreference: actions.settings,
  deleteDishFeedback: actions.settings,
}))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }))

import { getMealLookup } from "@/lib/meals/server/context"

import { genericInfoFrom, toPantryItemView, type PantryItemView } from "../pantry-item-view"
import { PANTRY_BULK_PLACEHOLDER } from "../pantry-bulk-form"
import { PantryView, type PantryViewProps } from "../pantry-view"

const OWNER: ChoreOwner = {
  userId: "d1000000-0000-4000-8000-000000000001",
  householdId: "d1000000-0000-4000-8000-0000000000a1",
}
const TODAY = "2026-11-11"
const V1 = "2026-11-01T00:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.654321+00:00"
const ONION = "d2000000-0000-4000-8000-000000000001"
const MILK = "d2000000-0000-4000-8000-000000000002"
const HERB = "d2000000-0000-4000-8000-000000000003"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const CATALOG_NAMES: Record<string, string> = { onion: "玉ねぎ", milk: "牛乳" }

function stored(over: Partial<StoredPantryItem> = {}): StoredPantryItem {
  return {
    id: ONION,
    ingredientId: "onion",
    name: "玉ねぎ",
    quantity: { amount: 2, unit: "piece" },
    status: "have",
    useSoon: false,
    storage: "pantry",
    expiresOn: null,
    confirmedOn: "2026-11-10",
    version: V1,
    ...over,
  }
}
function item(over: Partial<StoredPantryItem> = {}): PantryItemView {
  return toPantryItemView(stored(over), TODAY, (id) => CATALOG_NAMES[id])
}

function view(over: Partial<PantryViewProps> = {}) {
  const props: PantryViewProps = { owner: OWNER, today: TODAY, items: [item()], unreadable: 0, ...over }
  return render(<PantryView {...props} />)
}

function preview(over: Partial<PantryPreviewItem>): PantryPreviewItem {
  return { name: "玉ねぎ", ingredientId: "onion", ingredientName: "玉ねぎ", quantity: null, quantityText: null, issues: [], ...over }
}
const PREVIEW_OK: PantryPreviewResult = {
  ok: true,
  items: [
    preview({ quantity: { amount: 2, unit: "piece" }, quantityText: "2個" }),
    preview({ name: "謎の葉", ingredientId: null, ingredientName: null }),
    preview({
      name: "豚こま",
      ingredientId: "pork_komagire",
      ingredientName: "豚こま切れ肉",
      quantityText: "300",
      issues: ["quantity_unreadable"],
    }),
  ],
  resolvedCount: 2,
  unresolvedNames: ["謎の葉"],
  truncated: false,
}

const bulkBox = () => screen.getByLabelText("家にある食材")
const rowOf = (name: string) =>
  screen.getAllByTestId("pantry-item").find((row) => within(row).queryByText(name) !== null) as HTMLElement
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
async function ready() {
  // 端末の控えを読み終えるまで、保存の釦は塞がっている
  await waitFor(() => expect(screen.getByRole("button", { name: "玉ねぎを編集" })).toBeEnabled())
}
async function readPreview(text = "玉ねぎ 2個、謎の葉\n豚こま 300") {
  fireEvent.change(bulkBox(), { target: { value: text } })
  await click(screen.getByRole("button", { name: "内容を確認" }))
  await waitFor(() => expect(screen.getAllByTestId("pantry-draft").length).toBeGreaterThan(0))
}

beforeEach(() => {
  // 端末の時計を、サーバーの今日（2026-11-11）と違う日にしておく。確認日・期限の判定に端末の時計を
  // 使う実装は、これで食い違って落ちる（X-12）
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2027-01-05T03:00:00.000Z"))
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("C-21 まとめ入力 → 確認 → 登録", () => {
  it("入力欄に例（改行・読点の区切り）が出ており、読み取りは保存しない", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    view()
    await ready()
    expect(bulkBox()).toHaveAttribute("placeholder", PANTRY_BULK_PLACEHOLDER)
    expect(PANTRY_BULK_PLACEHOLDER).toContain("、")
    expect(PANTRY_BULK_PLACEHOLDER).toContain("\n")

    await readPreview()
    expect(actions.previewPantryText).toHaveBeenCalledWith("玉ねぎ 2個、謎の葉\n豚こま 300")
    expect(screen.getByText("読み取った内容（まだ登録していません）")).toBeInTheDocument()
    expect(actions.addPantryItems).not.toHaveBeenCalled()
  })

  it("一致した食材・一覧にない名前・読み取れた数量を分けて示す", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    view()
    await ready()
    await readPreview()

    expect(screen.getByTestId("pantry-preview-resolved")).toHaveTextContent("2件")
    expect(screen.getByTestId("pantry-preview-unresolved")).toHaveTextContent("1件")
    expect(screen.getByTestId("pantry-preview-quantities")).toHaveTextContent("1件（3件中）")
    expect(screen.getByText("一覧にない名前は、そのまま登録できますが、提案の材料には数えません。")).toBeInTheDocument()

    const [onion, herb, pork] = screen.getAllByTestId("pantry-draft")
    expect(within(onion).getByText("食材の一覧と一致: 玉ねぎ")).toBeInTheDocument()
    expect(within(onion).getByText(/読み取れた数量: 2個/)).toBeInTheDocument()
    // 対照: 一覧にない名前に「一致」と出さない
    expect(within(herb).getByText("一覧にない名前です（提案の材料に数えません）")).toBeInTheDocument()
    expect(within(herb).queryByText(/食材の一覧と一致/)).not.toBeInTheDocument()
    // 単位の無い数字は数量にしない（推測で g や個にしない）
    expect(within(pork).getByText(/読み取れませんでした（「300」）/)).toBeInTheDocument()
    expect(within(pork).getByText("数量を読み取れませんでした（数量不明として扱います）")).toBeInTheDocument()
    expect(within(pork).getByLabelText("3件目の数量")).toHaveValue("")
  })

  it("1 件ずつ直して登録する。行 ID は 1 回だけ作り、確認日はサーバーの今日、世帯の項目は送らない", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    actions.addPantryItems.mockImplementation(async (request) => ({
      status: "saved",
      items: request.items.map((entry) => ({ ...stored(), id: entry.id, name: entry.name })),
      saved: request.items.length,
      replayed: 0,
    }))
    view()
    await ready()
    await readPreview()

    fireEvent.change(screen.getByLabelText("3件目の数量"), { target: { value: "３００" } })
    fireEvent.change(screen.getByLabelText("3件目の単位"), { target: { value: "g" } })
    fireEvent.change(screen.getByLabelText("2件目の保管場所"), { target: { value: "fridge" } })
    await click(screen.getByRole("button", { name: "3件を登録" }))

    await waitFor(() => expect(actions.addPantryItems).toHaveBeenCalledTimes(1))
    const request = actions.addPantryItems.mock.calls[0][0]
    expect(Object.keys(request)).toEqual(["items"])
    expect(request.items).toHaveLength(3)
    expect(new Set(request.items.map((entry) => entry.id)).size).toBe(3)
    for (const entry of request.items) {
      expect(entry.id).toMatch(UUID)
      // 照合はサーバーが名前の完全一致で行う（画面から食材 ID を送らない）
      expect(entry.ingredientId).toBeNull()
      expect(entry.confirmedOn).toBe(TODAY)
      expect(entry.status).toBe("have")
      expect(Object.keys(entry)).not.toContain("householdId")
    }
    expect(request.items[0]).toMatchObject({ name: "玉ねぎ", quantity: { amount: 2, unit: "piece" }, storage: null })
    expect(request.items[1]).toMatchObject({ name: "謎の葉", quantity: null, storage: "fridge" })
    expect(request.items[2]).toMatchObject({ name: "豚こま", quantity: { amount: 300, unit: "g" } })

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3件の食材を登録しました。"))
    // 確定したら、まとめ入力を空に戻す（同じ文をもう一度登録させない）
    expect(screen.queryByTestId("pantry-draft")).not.toBeInTheDocument()
    expect(bulkBox()).toHaveValue("")
    expect(actions.refresh).toHaveBeenCalled()
  })

  it("名前を直した行は「登録するときに照合」と示し、外した行は送らない", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    actions.addPantryItems.mockResolvedValue({ status: "saved", items: [], saved: 2, replayed: 0 })
    view()
    await ready()
    await readPreview()

    fireEvent.change(screen.getByLabelText("1件目の名前"), { target: { value: "新玉ねぎ" } })
    const [renamed] = screen.getAllByTestId("pantry-draft")
    expect(within(renamed).getByText("名前を変えました。登録するときに、食材の一覧と照合します。")).toBeInTheDocument()
    expect(within(renamed).queryByText(/食材の一覧と一致/)).not.toBeInTheDocument()
    expect(screen.getByTestId("pantry-preview-renamed")).toHaveTextContent("1件")

    await click(screen.getByRole("button", { name: "2件目「謎の葉」を登録しない" }))
    expect(screen.getAllByTestId("pantry-draft")).toHaveLength(2)
    await click(screen.getByRole("button", { name: "2件を登録" }))
    await waitFor(() => expect(actions.addPantryItems).toHaveBeenCalledTimes(1))
    expect(actions.addPantryItems.mock.calls[0][0].items.map((entry) => entry.name)).toEqual(["新玉ねぎ", "豚こま"])
  })

  it("数量に数字でない文字が入っていれば送らず、その行を名指しで伝える（対照: 空欄は数量不明で送れる）", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    actions.addPantryItems.mockResolvedValue({ status: "saved", items: [], saved: 3, replayed: 0 })
    view()
    await ready()
    await readPreview()

    fireEvent.change(screen.getByLabelText("2件目の数量"), { target: { value: "たくさん" } })
    await click(screen.getByRole("button", { name: "3件を登録" }))
    expect(screen.getByRole("alert")).toHaveTextContent("2件目「謎の葉」")
    expect(actions.addPantryItems).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("2件目の数量"), { target: { value: "" } })
    await click(screen.getByRole("button", { name: "3件を登録" }))
    await waitFor(() => expect(actions.addPantryItems).toHaveBeenCalledTimes(1))
    expect(actions.addPantryItems.mock.calls[0][0].items[1].quantity).toBeNull()
  })

  it("読み取りに失敗したら理由を出し、入力は残す（X-03 失敗・オフライン）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    actions.previewPantryText.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    view()
    await ready()
    fireEvent.change(bulkBox(), { target: { value: "玉ねぎ" } })
    await click(screen.getByRole("button", { name: "内容を確認" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("通信できませんでした"))
    expect(bulkBox()).toHaveValue("玉ねぎ")

    actions.previewPantryText.mockResolvedValueOnce({ ok: false, error: "食材の名前を入力してください。" })
    await click(screen.getByRole("button", { name: "内容を確認" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("食材の名前を入力してください。"))
    expect(screen.queryByTestId("pantry-draft")).not.toBeInTheDocument()
  })
})

describe("X-09 結果不明の登録は、同じ行 ID・同じ内容で確かめ直す", () => {
  it("応答を失っても新しい ID で作り直さず、確認中は新しい保存を受けない", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    actions.addPantryItems.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    view()
    await ready()
    await readPreview()
    await click(screen.getByRole("button", { name: "3件を登録" }))

    await waitFor(() => expect(screen.getByText("保存できたか確認できていない操作")).toBeInTheDocument())
    expect(screen.getByText("食材 3 件を登録（「玉ねぎ」ほか）")).toBeInTheDocument()
    // 確認待ちの間は、状態の切替も登録も受けない
    expect(within(rowOf("玉ねぎ")).getByRole("button", { name: "残り少ない" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "3件を登録" })).toBeDisabled()

    actions.addPantryItems.mockResolvedValueOnce({ status: "replayed", items: [stored(), stored(), stored()], saved: 0, replayed: 3 })
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(actions.addPantryItems).toHaveBeenCalledTimes(2))
    expect(actions.addPantryItems.mock.calls[1][0]).toEqual(actions.addPantryItems.mock.calls[0][0])
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("3件の食材は、既に登録されていました。"))
    expect(screen.queryByText("保存できたか確認できていない操作")).not.toBeInTheDocument()
  })

  it("設定の画面で送った操作の控えも、この画面で「読めない控え」にならず確かめ直せる（対照: 知らない操作は読めない控え）", async () => {
    const settingsRequest = {
      op: "settings_save",
      version: null,
      servings: 3,
      includeSoup: false,
      maxCookMinutes: null,
      stapleIngredientIds: [],
      childStages: {},
    }
    putChorePending({
      schema: 1,
      id: "d9000000-0000-4000-8000-000000000001",
      owner: OWNER,
      kind: "meal",
      label: "ごはんの設定を保存",
      payload: settingsRequest,
      phase: "unknown",
      firstAttemptAt: "2026-11-11T00:00:00.000Z",
    })
    actions.settings.mockResolvedValue({ status: "replayed", settings: null, deleted: false })
    const first = view()
    await waitFor(() => expect(screen.getByText("ごはんの設定を保存")).toBeInTheDocument())
    expect(screen.queryByText(/読み取れない保存の控え/)).not.toBeInTheDocument()
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(actions.settings).toHaveBeenCalledTimes(1))
    // Action へは op を外した要求だけを渡す（Action は余分な項目を拒む）
    const { op: _op, ...withoutOp } = settingsRequest
    void _op
    expect(actions.settings.mock.calls[0][0]).toEqual(withoutOp)
    await act(async () => {})
    first.unmount()

    // 買い物の画面で送った操作も同じ（買い物の Action へ、そのままの内容で送り直す）
    localStorage.clear()
    const groceryRequest = { op: "delete", id: MILK, version: V1 }
    putChorePending({
      schema: 1,
      id: "d9000000-0000-4000-8000-000000000003",
      owner: OWNER,
      kind: "meal",
      label: "買い物の項目を削除",
      payload: groceryRequest,
      phase: "unknown",
      firstAttemptAt: "2026-11-11T00:00:00.000Z",
    })
    actions.saveGroceryRequest.mockResolvedValue({ status: "replayed", notices: [] })
    const second = view()
    await waitFor(() => expect(screen.getByText("買い物の項目を削除")).toBeInTheDocument())
    expect(screen.queryByText(/読み取れない保存の控え/)).not.toBeInTheDocument()
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(actions.saveGroceryRequest).toHaveBeenCalledWith(groceryRequest))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("保存されていました"))
    await act(async () => {})
    second.unmount()

    localStorage.clear()
    putChorePending({
      schema: 1,
      id: "d9000000-0000-4000-8000-000000000002",
      owner: OWNER,
      kind: "meal",
      label: "知らない操作",
      payload: { op: "from_a_newer_version", id: ONION },
      phase: "unknown",
      firstAttemptAt: "2026-11-11T00:00:00.000Z",
    })
    view()
    await waitFor(() => expect(screen.getByText(/読み取れない保存の控えが 1 件あります/)).toBeInTheDocument())
  })
})

describe("C-21 一覧: 3 択・早く使いたい・最終確認日", () => {
  it("「ある／残り少ない／使い切った」の今の状態だけが選択中で、切り替えると版つきで保存する", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ status: "low", version: V2 }), deleted: false })
    view()
    await ready()
    const group = within(rowOf("玉ねぎ")).getByRole("group", { name: "玉ねぎの状態" })
    const pressed = () =>
      within(group)
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-pressed")])
    expect(pressed()).toEqual([
      ["ある", "true"],
      ["残り少ない", "false"],
      ["使い切った", "false"],
    ])

    // 対照: 今の状態を押しても送らない
    await click(within(group).getByRole("button", { name: "ある" }))
    expect(actions.savePantryItem).not.toHaveBeenCalled()

    await click(within(group).getByRole("button", { name: "残り少ない" }))
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0]).toEqual({
      id: ONION,
      version: V1,
      item: {
        ingredientId: "onion",
        name: "玉ねぎ",
        quantity: { amount: 2, unit: "piece" },
        status: "low",
        useSoon: false,
        storage: "pantry",
        expiresOn: null,
        // 状態を変えた = 今日見た
        confirmedOn: TODAY,
      },
    })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("「玉ねぎ」を保存しました。"))
  })

  it("「使い切った」も 1 タップで保存できる", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ status: "out" }), deleted: false })
    view()
    await ready()
    await click(within(rowOf("玉ねぎ")).getByRole("button", { name: "使い切った" }))
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0].item.status).toBe("out")
  })

  it("「早く使いたい」は押すたびに切り替わり、最終確認日は動かさない", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ useSoon: true }), deleted: false })
    view()
    await ready()
    const toggle = screen.getByRole("button", { name: "玉ねぎを早く使いたい" })
    expect(toggle).toHaveAttribute("aria-pressed", "false")
    await click(toggle)
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0].item).toMatchObject({ useSoon: true, confirmedOn: "2026-11-10" })
  })

  it("「今日確認した」は確認日をサーバーの今日にする（対照: 今日確認済みの食材には釦を出さない）", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ confirmedOn: TODAY }), deleted: false })
    view({ items: [item(), item({ id: MILK, ingredientId: "milk", name: "牛乳", confirmedOn: TODAY })] })
    await ready()
    expect(within(rowOf("牛乳")).getByText("今日確認済み")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "牛乳を今日確認した" })).not.toBeInTheDocument()

    await click(screen.getByRole("button", { name: "玉ねぎを今日確認した" }))
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0].item).toMatchObject({ status: "have", confirmedOn: TODAY })
  })

  it("家族が先に直していたら上書きせず、その旨を伝える（対照: 別の端末で削除済み）", async () => {
    actions.savePantryItem.mockResolvedValueOnce({ status: "conflict", item: stored({ version: V2 }), deleted: false })
    view()
    await ready()
    await click(within(rowOf("玉ねぎ")).getByRole("button", { name: "残り少ない" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("上書きはしていません"))

    actions.savePantryItem.mockResolvedValueOnce({ status: "conflict", item: null, deleted: true })
    await click(within(rowOf("玉ねぎ")).getByRole("button", { name: "使い切った" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("別の端末で削除されていました"))
  })

  it("拒否された保存は理由を出し、控えを残さない（X-03 失敗）", async () => {
    actions.savePantryItem.mockResolvedValue({ error: "食材の状態を選び直してください。", failure: "rejected" })
    view()
    await ready()
    await click(within(rowOf("玉ねぎ")).getByRole("button", { name: "残り少ない" }))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("食材の状態を選び直してください。"))
    expect(screen.queryByText("保存できたか確認できていない操作")).not.toBeInTheDocument()
    expect(within(rowOf("玉ねぎ")).getByRole("button", { name: "残り少ない" })).toBeEnabled()
  })
})

describe("C-26 / C-27 期限切れ・古い確認・数量不明を印で示す", () => {
  it("期限切れ・期限が近い・確認が古い・一覧にない名前・数量不明を、文字つきの印で示す", () => {
    view({
      items: [
        item({ id: ONION, name: "玉ねぎ", expiresOn: "2026-11-08" }),
        item({ id: MILK, ingredientId: "milk", name: "牛乳", storage: "fridge", expiresOn: "2026-11-13", confirmedOn: "2026-11-01" }),
        item({ id: HERB, ingredientId: null, name: "謎の葉", quantity: null, storage: null, confirmedOn: TODAY }),
      ],
    })
    const onion = rowOf("玉ねぎ")
    expect(within(onion).getByText(/期限切れ（3日超過）・材料に数えません/)).toBeInTheDocument()
    const milk = rowOf("牛乳")
    expect(within(milk).getByText(/期限が近い（あと2日）/)).toBeInTheDocument()
    // 冷蔵は 7 日を超えると「古い」
    expect(within(milk).getByText("確認から日が経っています")).toBeInTheDocument()
    const herb = rowOf("謎の葉")
    expect(within(herb).getByText("一覧にない名前（提案の材料に数えません）")).toBeInTheDocument()
    expect(within(herb).getByText(/数量不明/)).toBeInTheDocument()

    expect(screen.getByText(/期限切れの食材が 1 件あります/)).toBeInTheDocument()
    expect(screen.getByText(/確認から日が経った食材が 1 件あります/)).toBeInTheDocument()
    expect(screen.getByText(/食材の一覧にない名前が 1 件あります/)).toBeInTheDocument()
  })

  it("対照: 期限に余裕があり、確認が新しく、一覧と一致する食材には印を出さない", () => {
    view({ items: [item({ expiresOn: "2026-11-30", confirmedOn: TODAY })] })
    const row = rowOf("玉ねぎ")
    expect(within(row).queryByText(/期限切れ/)).not.toBeInTheDocument()
    expect(within(row).queryByText(/期限が近い/)).not.toBeInTheDocument()
    expect(within(row).queryByText("確認から日が経っています")).not.toBeInTheDocument()
    expect(within(row).queryByText(/一覧にない名前/)).not.toBeInTheDocument()
    expect(within(row).getByText(/2個・常温・確認 11\/11（水）・期限 11\/30（月）/)).toBeInTheDocument()
    expect(screen.queryByText(/期限切れの食材が/)).not.toBeInTheDocument()
  })
})

describe("一覧の並べ方と空の表示（X-03 未登録）", () => {
  const three = [
    item({ id: ONION, name: "玉ねぎ", storage: "pantry", status: "have" }),
    item({ id: MILK, ingredientId: "milk", name: "牛乳", storage: "fridge", status: "low" }),
    item({ id: HERB, ingredientId: null, name: "謎の葉", storage: null, status: "out" }),
  ]

  it("保管場所別（既定）と状態別を切り替えられる", async () => {
    view({ items: three })
    const headings = () => screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)
    expect(headings()).toEqual(["冷蔵（1件）", "常温（1件）", "保管場所なし（1件）"])
    expect(screen.getByRole("button", { name: "保管場所別" })).toHaveAttribute("aria-pressed", "true")

    await click(screen.getByRole("button", { name: "状態別" }))
    expect(headings()).toEqual(["ある（1件）", "残り少ない（1件）", "使い切った（1件）"])
    expect(screen.getByRole("button", { name: "状態別" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByRole("button", { name: "保管場所別" })).toHaveAttribute("aria-pressed", "false")
  })

  it("食材が無ければ入力へ誘導する（対照: 読めない行が在るときは「まだ登録されていません」と言わない）", async () => {
    const empty = view({ items: [] })
    expect(screen.getByText("食材がまだ登録されていません")).toBeInTheDocument()
    await click(screen.getByRole("button", { name: "食材を入力する" }))
    expect(bulkBox()).toHaveFocus()
    await act(async () => {})
    empty.unmount()

    view({ items: [], unreadable: 2 })
    expect(screen.queryByText("食材がまだ登録されていません")).not.toBeInTheDocument()
    expect(screen.getByText("表示できる食材がありません")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("表示できない食材が 2 件あります")
  })
})

describe("編集シート（数量・保管場所・期限・最終確認日・削除）", () => {
  it("名前を変えたら食材の一覧との結び付きを外して送り、数量・保管場所・期限も送る", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ name: "新玉ねぎ" }), deleted: false })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))

    fireEvent.change(screen.getByLabelText("名前"), { target: { value: "新玉ねぎ" } })
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "1.5" } })
    fireEvent.change(screen.getByLabelText("単位"), { target: { value: "kg" } })
    fireEvent.change(screen.getByLabelText("保管場所（任意）"), { target: { value: "fridge" } })
    fireEvent.change(screen.getByLabelText("期限（任意）"), { target: { value: "2026-11-20" } })
    await click(screen.getByRole("button", { name: "保存" }))

    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0]).toEqual({
      id: ONION,
      version: V1,
      item: {
        ingredientId: null,
        name: "新玉ねぎ",
        quantity: { amount: 1.5, unit: "kg" },
        status: "have",
        useSoon: false,
        storage: "fridge",
        expiresOn: "2026-11-20",
        confirmedOn: "2026-11-10",
      },
    })
  })

  it("対照: 名前を変えなければ結び付きを保ち、数量の空欄は数量不明として送る", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored(), deleted: false })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))
    fireEvent.change(screen.getByLabelText("数量"), { target: { value: "" } })
    await click(screen.getByRole("button", { name: "保存" }))
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0].item).toMatchObject({ ingredientId: "onion", quantity: null })
  })

  it("未来の最終確認日は送らない", async () => {
    view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))
    fireEvent.change(screen.getByLabelText("最終確認日"), { target: { value: "2026-11-12" } })
    await click(screen.getByRole("button", { name: "保存" }))
    expect(screen.getByRole("alert")).toHaveTextContent("今日までの日付")
    expect(actions.savePantryItem).not.toHaveBeenCalled()
  })

  it("削除は 2 段の確認の後に、開いた時点の版で送る", async () => {
    actions.deletePantryItem.mockResolvedValue({ status: "saved", id: ONION, item: null })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))
    await click(screen.getByRole("button", { name: "この食材を削除" }))
    expect(actions.deletePantryItem).not.toHaveBeenCalled()
    await click(screen.getByRole("button", { name: "削除する" }))
    await waitFor(() => expect(actions.deletePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.deletePantryItem.mock.calls[0][0]).toEqual({ id: ONION, version: V1 })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("食材を削除しました。"))
  })
})

describe("R35 / R37: 編集のシートは、応答で勝手に閉じず、開いた時点の版を送る", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  const milk = () => item({ id: MILK, ingredientId: "milk", name: "牛乳", storage: "fridge" })

  it("R35 はこの画面では起きない: 送信中は編集のシートを開けない（応答が、後から開いた編集を閉じる余地が無い）", async () => {
    const pending = deferred<Awaited<ReturnType<typeof actions.savePantryItem>>>()
    actions.savePantryItem.mockReturnValue(pending.promise)
    view({ items: [item(), milk()] })
    await ready()
    await click(within(rowOf("玉ねぎ")).getByRole("button", { name: "残り少ない" }))
    expect(actions.savePantryItem).toHaveBeenCalledTimes(1)
    // 応答を待つ間は、どの食材の編集も開けない
    expect(screen.getByRole("button", { name: "牛乳を編集" })).toBeDisabled()
    await click(screen.getByRole("button", { name: "牛乳を編集" }))
    expect(screen.queryByRole("dialog")).toBeNull()
    await act(async () => {
      pending.resolve({ status: "saved", item: stored({ status: "low", version: V2 }), deleted: false })
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "牛乳を編集" })).toBeEnabled())
  })

  it("正常側: 編集のシートから送った保存の応答では、そのシートを閉じる", async () => {
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ name: "新玉ねぎ" }), deleted: false })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "新玉ねぎ" } })
    await click(within(dialog).getByRole("button", { name: "保存" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("危険側: 編集を開いたまま食材の版が進んだら、入力を黙って作り直さず、古い入力に新しい版も付けない", async () => {
    const { rerender } = view()
    await ready()
    await click(screen.getByRole("button", { name: "玉ねぎを編集" }))
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("名前")
    fireEvent.change(name, { target: { value: "新玉ねぎ" } })

    // 家族が数量を直した後の値が届いた（版が進む）
    rerender(
      <PantryView
        owner={OWNER}
        today={TODAY}
        items={[item({ quantity: { amount: 5, unit: "piece" }, version: V2 })]}
        unreadable={0}
      />,
    )
    // 入力は残る（作り直されていない）
    expect(within(dialog).getByLabelText("名前")).toBe(name)
    expect(name).toHaveValue("新玉ねぎ")
    expect(within(dialog).getByTestId("changed-elsewhere")).toHaveTextContent("この食材は、入力を始めた後に他の端末で変更されました")
    const saveButton = within(dialog).getByRole("button", { name: "保存" })
    expect(saveButton).toBeDisabled()
    await click(saveButton)
    expect(actions.savePantryItem).not.toHaveBeenCalled()

    // 最新の内容を読み込むと、届いた値（5 個）から始まり、その版で送れる
    actions.savePantryItem.mockResolvedValue({ status: "saved", item: stored({ version: V2 }), deleted: false })
    await click(within(dialog).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(dialog).queryByTestId("changed-elsewhere")).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText("数量")).toHaveValue("5")
    expect(within(dialog).getByLabelText("名前")).toHaveValue("玉ねぎ")
    await click(within(dialog).getByRole("button", { name: "保存" }))
    await waitFor(() => expect(actions.savePantryItem).toHaveBeenCalledTimes(1))
    expect(actions.savePantryItem.mock.calls[0][0]).toMatchObject({ id: ONION, version: V2 })
  })

  it("確認中の下書き（まとめ入力の確認一覧）が在る間は、自動の取り直しを見送る（対照: 無ければ取り直す）", async () => {
    actions.previewPantryText.mockResolvedValue(PREVIEW_OK)
    view()
    await ready()
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    await readPreview()
    // 入力欄を空に戻しても、確認中の下書きが在る間は見送る（文字の入力の検出に頼らない）
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(actions.refresh).toHaveBeenCalledTimes(1)
  })
})

describe("R24: 総称で登録した食材は、材料に数えていないことと直し方を出す", () => {
  const lookup = getMealLookup()
  const generic = (over: Partial<StoredPantryItem> = {}) =>
    toPantryItemView(
      stored({ id: MILK, ingredientId: "pork", name: "豚肉", quantity: { amount: 300, unit: "g" }, ...over }),
      TODAY,
      (id) => lookup.index.byId.get(id)?.name,
      genericInfoFrom(lookup.index.byId),
    )

  it("前提: 食材辞書の総称（豚肉・鶏肉・牛肉・きのこ）には、具体的な名前の例が在る（対照: 総称でない食材は null）", () => {
    const infoOf = genericInfoFrom(lookup.index.byId)
    for (const id of ["pork", "chicken", "beef", "mushroom"]) {
      expect(lookup.index.byId.get(id)?.generic, id).toBe(true)
      const info = infoOf(id)
      expect(info, id).not.toBeNull()
      expect(info?.examples.length, id).toBeGreaterThan(0)
      // 例は総称そのものではなく、その総称に由来する具体的な食材
      for (const name of info?.examples ?? []) expect(name).not.toBe(lookup.index.byId.get(id)?.name)
    }
    expect(infoOf("pork")?.examples[0]).toMatch(/^豚/)
    expect(infoOf("onion")).toBeNull()
    expect(infoOf("pork_komagire")).toBeNull()
    expect(infoOf("no_such_ingredient")).toBeNull()
  })

  it("総称の食材の行に「材料に数えていません」と具体的な名前の例を出し、編集へ送る", async () => {
    view({ items: [generic(), item()] })
    await ready()
    const row = rowOf("豚肉")
    const note = within(row).getByTestId("pantry-generic")
    expect(note).toHaveTextContent("総称（材料に数えていません）")
    expect(note).toHaveTextContent("部位・種類が分からないため、提案・献立・買い物の材料に数えていません")
    const example = genericInfoFrom(lookup.index.byId)("pork")?.examples[0] ?? ""
    expect(note).toHaveTextContent(`「${example}」`)
    expect(note).toHaveTextContent("具体的な名前に直すと材料に数えます")
    // 対照: 総称でない食材には出さない
    expect(within(rowOf("玉ねぎ")).queryByTestId("pantry-generic")).not.toBeInTheDocument()
    // まとめの知らせ
    expect(screen.getByTestId("pantry-generic-summary")).toHaveTextContent("総称（「豚肉」「きのこ」など）で登録した食材が 1 件あります")

    await click(within(note).getByRole("button", { name: "豚肉を具体的な名前に直す" }))
    const dialog = await screen.findByRole("dialog")
    // 編集では「〜として数えています」と言わない
    expect(within(dialog).getByTestId("pantry-editor-generic")).toHaveTextContent("「豚肉」は総称です")
    expect(dialog).not.toHaveTextContent("として数えています")
  })

  it("対照: 総称の食材が無ければ、まとめの知らせを出さない。使い切った総称は件数に数えない", async () => {
    view({ items: [item()] })
    await ready()
    expect(screen.queryByTestId("pantry-generic-summary")).not.toBeInTheDocument()
    cleanup()
    view({ items: [generic({ status: "out" }), item()] })
    await ready()
    expect(screen.queryByTestId("pantry-generic-summary")).not.toBeInTheDocument()
  })
})

describe("V-UI 長い日本語・押下領域・遷移", () => {
  const LONG = "とても長い名前の食材をそのまま登録した場合でも画面からはみ出さないことを確かめる"

  it("長い食材名は折り返す（はみ出させない）", () => {
    view({ items: [item({ name: LONG, ingredientId: null })] })
    const name = within(rowOf(LONG)).getByText(LONG)
    expect(name.className).toContain("break-words")
    expect(name.className).toContain("[overflow-wrap:anywhere]")
    expect(name.className).toContain("min-w-0")
  })

  it("button は 44px の担い手（min-h-11 / size-11 / touch-target）を持ち、transition-all を使わない", async () => {
    const { container } = view()
    await ready()
    const buttons = [...container.querySelectorAll("button")]
    expect(buttons.length).toBeGreaterThan(5)
    for (const button of buttons) {
      expect(button.className, button.textContent ?? "").toMatch(/min-h-11|size-11|touch-target/)
    }
    expect(container.innerHTML).not.toContain("transition-all")
  })
})
