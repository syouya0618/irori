/**
 * 食材（在庫）の Server Action の契約。
 *
 * - X-05: 認証と世帯は getAuthContext から。未認証・閲覧だけの招待では RPC を呼ばない。
 *   世帯 ID を紛れ込ませた要求は拒否し、RPC の引数にも世帯の項目は無い
 * - C-21: まとめ入力の解釈（保存しない）→ 1 件ずつ確認して登録。数量は任意
 * - C-22: 食材名の解決は完全一致だけ（部分一致で別の食材へ寄せない）
 * - X-09 / X-10: 行 ID はクライアント採番。saved / replayed / conflict / 結果不明を分ける。
 *   版（updated_at）は文字列のまま DB へ渡す
 *
 * 食材辞書は実物（同梱カタログ）を使う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))

import type {
  AddPantryItemsRequest,
  DeletePantryItemRequest,
  PantryNewItem,
  SavePantryItemRequest,
} from "@/lib/meals/server/pantry-requests"

import { addPantryItems, deletePantryItem, previewPantryText, savePantryItem } from "../actions"

const USER = "d1000000-0000-4000-8000-000000000001"
const HOUSE = "d1000000-0000-4000-8000-0000000000a1"
const OTHER_HOUSE = "d1000000-0000-4000-8000-0000000000b1"
const ITEM_A = "d2000000-0000-4000-8000-000000000001"
const ITEM_B = "d2000000-0000-4000-8000-000000000002"
const V1 = "2026-11-10T00:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.654321+00:00"
const TODAY = "2026-11-11"

type Reply = { data: unknown; error: { code?: string; message?: string } | null }
type RpcHandler = (name: string, args: Record<string, unknown>) => Reply

function signIn(rpc: RpcHandler) {
  const calls: [string, Record<string, unknown>][] = []
  const from = vi.fn(() => {
    throw new Error("pantry actions must not read tables directly")
  })
  const supabase = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push([name, args])
      return rpc(name, args)
    },
  }
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: USER, householdId: HOUSE },
  })
  return { calls, from }
}

function newItem(over: Partial<PantryNewItem> = {}): PantryNewItem {
  return {
    id: ITEM_A,
    ingredientId: null,
    name: "玉ねぎ",
    quantity: { amount: 2, unit: "piece" },
    status: "have",
    useSoon: false,
    storage: "pantry",
    expiresOn: null,
    confirmedOn: TODAY,
    ...over,
  }
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    household_id: HOUSE,
    ingredient_id: "onion",
    name: "玉ねぎ",
    quantity: 2,
    unit: "piece",
    status: "have",
    use_soon: false,
    storage: "pantry",
    expires_on: null,
    confirmed_on: TODAY,
    created_by: USER,
    updated_at: V2,
    created_at: V2,
    ...over,
  }
}

const addRequest = (items: PantryNewItem[] = [newItem()]): AddPantryItemsRequest => ({ items })
const saveRequest = (over: Partial<SavePantryItemRequest> = {}): SavePantryItemRequest => {
  const { id: _id, ...item } = newItem()
  return { id: ITEM_A, version: V1, item, ...over }
}
const deleteRequest = (over: Partial<DeletePantryItemRequest> = {}): DeletePantryItemRequest => ({
  id: ITEM_A,
  version: V1,
  ...over,
})

const savedBulk: RpcHandler = (_name, args) => {
  const items = args.p_items as { id: string }[]
  return {
    data: { status: "saved", saved: items.length, replayed: 0, items: items.map((item) => row(item.id)) },
    error: null,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  // 2026-11-11 12:00 JST
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  revalidatePath.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("X-05 認証と世帯", () => {
  it.each([
    ["未認証", { error: "認証されていません", reason: "unauthenticated", context: null }],
    ["子どもだけの閲覧招待（viewer）", { error: "共有画面から閲覧してください", reason: "shared-only", context: null }],
    ["承認待ち", { error: "承認待ちです", reason: "not-approved", context: null }],
  ])("%s では、どの操作も DB へ届く前に拒否する", async (_name, denied) => {
    getAuthContext.mockResolvedValue(denied)
    expect(await addPantryItems(addRequest())).toEqual({ error: denied.error, failure: "rejected" })
    expect(await savePantryItem(saveRequest())).toEqual({ error: denied.error, failure: "rejected" })
    expect(await deletePantryItem(deleteRequest())).toEqual({ error: denied.error, failure: "rejected" })
    expect(await previewPantryText("玉ねぎ")).toEqual({ ok: false, error: denied.error })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("対照: 正規メンバーなら同じ要求が RPC へ届く", async () => {
    const { calls } = signIn(savedBulk)
    expect(await addPantryItems(addRequest())).toMatchObject({ status: "saved" })
    expect(calls.map(([name]) => name)).toEqual(["add_pantry_items"])
  })

  it("世帯 ID を紛れ込ませた要求は拒否し、RPC を呼ばない", async () => {
    const { calls } = signIn(savedBulk)
    const top = { ...addRequest(), householdId: OTHER_HOUSE } as unknown as AddPantryItemsRequest
    const nested = addRequest([{ ...newItem(), household_id: OTHER_HOUSE } as unknown as PantryNewItem])
    const save = { ...saveRequest(), householdId: OTHER_HOUSE } as unknown as SavePantryItemRequest
    const remove = { ...deleteRequest(), householdId: OTHER_HOUSE } as unknown as DeletePantryItemRequest
    expect(await addPantryItems(top)).toMatchObject({ failure: "rejected" })
    expect(await addPantryItems(nested)).toMatchObject({ failure: "rejected" })
    expect(await savePantryItem(save)).toMatchObject({ failure: "rejected" })
    expect(await deletePantryItem(remove)).toMatchObject({ failure: "rejected" })
    expect(calls).toEqual([])
  })

  it("RPC の引数に世帯の項目は無い（世帯は DB が auth.uid() から導出する）", async () => {
    const { calls } = signIn((name, args) => {
      if (name === "add_pantry_items") return savedBulk(name, args)
      if (name === "save_pantry_item") return { data: { status: "saved", item: row(ITEM_A) }, error: null }
      return { data: { status: "saved", id: ITEM_A }, error: null }
    })
    await addPantryItems(addRequest())
    await savePantryItem(saveRequest())
    await deletePantryItem(deleteRequest())
    expect(calls).toHaveLength(3)
    for (const [, args] of calls) {
      const text = JSON.stringify(args)
      expect(text).not.toMatch(/household/i)
      expect(text).not.toContain(HOUSE)
    }
  })
})

describe("C-21 / C-22 まとめ入力の解釈（保存しない）", () => {
  it("名前・数量を 1 件ずつに分け、解決できた食材とできなかった名前を返す", async () => {
    const { calls, from } = signIn(() => ({ data: null, error: null }))
    const result = await previewPantryText("玉ねぎ 2個、牛乳200ml\n卵, 豚こま 300 なぞの食材 塩 少々")
    expect(result).toMatchObject({ ok: true, truncated: false, resolvedCount: 5, unresolvedNames: ["なぞの食材"] })
    if (!result.ok) throw new Error("unreachable")
    expect(result.items).toEqual([
      { name: "玉ねぎ", ingredientId: "onion", ingredientName: "玉ねぎ", quantity: { amount: 2, unit: "piece" }, quantityText: "2個", issues: [] },
      { name: "牛乳", ingredientId: "milk", ingredientName: "牛乳", quantity: { amount: 200, unit: "ml" }, quantityText: "200ml", issues: [] },
      { name: "卵", ingredientId: "egg", ingredientName: "卵", quantity: null, quantityText: null, issues: [] },
      // 単位の無い数字は、推測で g にしない（数量不明のまま、読めなかった原文を返す）
      { name: "豚こま", ingredientId: "pork_komagire", ingredientName: "豚こま切れ肉", quantity: null, quantityText: "300", issues: ["quantity_unreadable"] },
      { name: "なぞの食材", ingredientId: null, ingredientName: null, quantity: null, quantityText: null, issues: [] },
      { name: "塩", ingredientId: "salt", ingredientName: "塩", quantity: null, quantityText: "少々", issues: ["quantity_not_countable"] },
    ])
    // 保存しない・DB も読まない
    expect(calls).toEqual([])
    expect(from).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("部分一致で別の食材へ寄せない（「豚」「豚こまの残り」は未解決。対照: 「豚こま」は解決する）", async () => {
    signIn(() => ({ data: null, error: null }))
    const result = await previewPantryText("豚、豚こまの残り、豚こま")
    if (!result.ok) throw new Error("unreachable")
    expect(result.items.map((item) => item.ingredientId)).toEqual([null, null, "pork_komagire"])
    expect(result.unresolvedNames).toEqual(["豚", "豚こまの残り"])
  })

  it("登録できない名前には印を付ける（黙って切り詰めない）", async () => {
    signIn(() => ({ data: null, error: null }))
    const long = "あ".repeat(41)
    const result = await previewPantryText(`${long}、卵`)
    if (!result.ok) throw new Error("unreachable")
    expect(result.items[0]).toMatchObject({ name: long, issues: ["name_invalid"] })
    expect(result.items[1].issues).toEqual([])
  })

  it("件数の上限を超えたぶんは含めず、打ち切ったことを返す", async () => {
    signIn(() => ({ data: null, error: null }))
    const many = Array.from({ length: 51 }, (_, index) => `食材${String.fromCharCode(0x3042 + index)}`).join("、")
    const result = await previewPantryText(many)
    if (!result.ok) throw new Error("unreachable")
    expect(result.items).toHaveLength(50)
    expect(result.truncated).toBe(true)
    const within = await previewPantryText(many.split("、").slice(0, 50).join("、"))
    expect(within).toMatchObject({ ok: true, truncated: false })
  })

  it.each([
    ["空の入力", "  、\n "],
    ["長すぎる入力", "あ".repeat(2001)],
    ["文字列でない入力", 42 as unknown as string],
  ])("%s は拒否する", async (_name, text) => {
    signIn(() => ({ data: null, error: null }))
    expect(await previewPantryText(text)).toMatchObject({ ok: false })
  })
})

describe("入力の検証（DB へ届く前に拒否する）", () => {
  const far = "9".repeat(8)
  it.each<[string, AddPantryItemsRequest]>([
    ["0 件", addRequest([])],
    ["51 件", addRequest(Array.from({ length: 51 }, (_, index) => newItem({ id: `d2000000-0000-4000-8000-${String(index).padStart(12, "0")}` })))],
    ["同じ ID が 2 件", addRequest([newItem(), newItem({ name: "にんじん" })])],
    ["UUID でない ID", addRequest([newItem({ id: "not-a-uuid" })])],
    ["大文字の UUID（DB の検証と食い違う）", addRequest([newItem({ id: ITEM_A.toUpperCase() })])],
    ["空の名前", addRequest([newItem({ name: "   " })])],
    ["41 文字の名前", addRequest([newItem({ name: "あ".repeat(41) })])],
    ["制御文字を含む名前", addRequest([newItem({ name: "玉ねぎ\n牛乳" })])],
    ["未知の単位", addRequest([newItem({ quantity: { amount: 1, unit: "barrel" as never } })])],
    ["数えない単位（適量）", addRequest([newItem({ quantity: { amount: 1, unit: "to_taste" } })])],
    ["数量 0", addRequest([newItem({ quantity: { amount: 0, unit: "piece" } })])],
    ["負の数量", addRequest([newItem({ quantity: { amount: -1, unit: "piece" } })])],
    ["丸めると 0 になる数量", addRequest([newItem({ quantity: { amount: 0.004, unit: "g" } })])],
    ["NaN の数量", addRequest([newItem({ quantity: { amount: Number.NaN, unit: "g" } })])],
    ["上限を超える数量", addRequest([newItem({ quantity: { amount: Number(far) * 10, unit: "g" } })])],
    ["文字列の数量", addRequest([newItem({ quantity: { amount: "2" as never, unit: "piece" } })])],
    ["未知の状態", addRequest([newItem({ status: "plenty" as never })])],
    ["未知の保管場所", addRequest([newItem({ storage: "cellar" as never })])],
    ["実在しない期限", addRequest([newItem({ expiresOn: "2026-02-30" })])],
    ["範囲外の期限", addRequest([newItem({ expiresOn: "2101-01-01" })])],
    ["実在しない最終確認日", addRequest([newItem({ confirmedOn: "2026-13-01" })])],
    ["未来の最終確認日", addRequest([newItem({ confirmedOn: "2026-11-12" })])],
    ["古すぎる最終確認日", addRequest([newItem({ confirmedOn: "1999-12-31" })])],
    ["早く使いたいが真偽値でない", addRequest([newItem({ useSoon: "yes" as never })])],
    ["食材の一覧に無い食材 ID", addRequest([newItem({ ingredientId: "dragon_fruit_xyz" })])],
    ["名前が別の食材に一致する食材 ID", addRequest([newItem({ name: "にんじん", ingredientId: "onion" })])],
    ["配列でない items", { items: "玉ねぎ" } as unknown as AddPantryItemsRequest],
    ["要求が配列", [newItem()] as unknown as AddPantryItemsRequest],
  ])("%s は拒否し、RPC を呼ばない", async (_name, request) => {
    const { calls } = signIn(savedBulk)
    expect(await addPantryItems(request)).toMatchObject({ failure: "rejected" })
    expect(calls).toEqual([])
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("対照: 境界の内側の値は RPC へ届く", async () => {
    const { calls } = signIn(savedBulk)
    const request = addRequest([
      newItem({ name: "あ".repeat(40), quantity: { amount: 0.01, unit: "kg" }, expiresOn: "2100-12-31", confirmedOn: "2000-01-01" }),
    ])
    expect(await addPantryItems(request)).toMatchObject({ status: "saved" })
    expect(calls).toHaveLength(1)
  })

  it.each<[string, SavePantryItemRequest]>([
    ["形の合わない版", saveRequest({ version: "yesterday" })],
    ["Date を通した版ではなく数値", saveRequest({ version: 1731290000000 as never })],
    ["内容の欠けた要求", { id: ITEM_A, version: V1 } as unknown as SavePantryItemRequest],
    ["内容に ID を混ぜた要求", saveRequest({ item: { ...newItem() } as never })],
  ])("編集: %s は拒否する", async (_name, request) => {
    const { calls } = signIn(() => ({ data: { status: "saved", item: row(ITEM_A) }, error: null }))
    expect(await savePantryItem(request)).toMatchObject({ failure: "rejected" })
    expect(calls).toEqual([])
  })

  it("削除: 版の無い要求は拒否する（家族が直した後の行を古い画面から消さない）", async () => {
    const { calls } = signIn(() => ({ data: { status: "saved", id: ITEM_A }, error: null }))
    expect(await deletePantryItem({ id: ITEM_A, version: null } as unknown as DeletePantryItemRequest)).toMatchObject({
      failure: "rejected",
    })
    expect(await deletePantryItem({ id: ITEM_A } as unknown as DeletePantryItemRequest)).toMatchObject({
      failure: "rejected",
    })
    expect(calls).toEqual([])
  })
})

describe("C-21 登録（add_pantry_items）", () => {
  it("クライアントが採番した ID と確認した内容を、DB の形で 1 回だけ送る", async () => {
    const { calls } = signIn(savedBulk)
    const result = await addPantryItems(
      addRequest([
        newItem({ quantity: { amount: 1.239, unit: "kg" }, useSoon: true, expiresOn: "2026-11-20" }),
        // 数量は任意。名前のままの食材（一覧に無い）も登録できる
        newItem({ id: ITEM_B, name: " なぞの食材 ", quantity: null, status: "low", storage: null }),
      ]),
    )
    expect(calls).toEqual([
      [
        "add_pantry_items",
        {
          p_items: [
            {
              id: ITEM_A,
              // ingredientId: null は名前の完全一致で解決する
              ingredient_id: "onion",
              name: "玉ねぎ",
              quantity: 1.24,
              unit: "kg",
              status: "have",
              use_soon: true,
              storage: "pantry",
              expires_on: "2026-11-20",
              confirmed_on: TODAY,
            },
            {
              id: ITEM_B,
              ingredient_id: null,
              name: "なぞの食材",
              quantity: null,
              unit: null,
              status: "low",
              use_soon: false,
              storage: null,
              expires_on: null,
              confirmed_on: TODAY,
            },
          ],
        },
      ],
    ])
    expect(result).toMatchObject({ status: "saved", saved: 2, replayed: 0 })
    if ("failure" in result) throw new Error("unreachable")
    expect(result.items.map((item) => item.id)).toEqual([ITEM_A, ITEM_B])
    // 版は DB の表記のまま（マイクロ秒を落とさない）
    expect(result.items[0].version).toBe(V2)
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
    expect(revalidatePath).toHaveBeenCalledWith("/chores")
  })

  it("利用者が選んだ食材（名前が一覧のどれにも一致しない）は、その結び付きのまま送る", async () => {
    const { calls } = signIn(savedBulk)
    await addPantryItems(addRequest([newItem({ name: "新玉ねぎ（淡路）", ingredientId: "onion" })]))
    expect((calls[0][1].p_items as { ingredient_id: string; name: string }[])[0]).toMatchObject({
      ingredient_id: "onion",
      name: "新玉ねぎ（淡路）",
    })
  })

  it("同じ ID・同じ内容の再送は replayed（二重に増えない応答をそのまま返す）", async () => {
    signIn(() => ({
      data: { status: "replayed", saved: 0, replayed: 1, items: [row(ITEM_A)] },
      error: null,
    }))
    expect(await addPantryItems(addRequest())).toMatchObject({ status: "replayed", saved: 0, replayed: 1 })
  })

  it("同じ ID に別の内容が在る（23505）は conflict の失敗。登録していない", async () => {
    signIn(() => ({ data: null, error: { code: "23505", message: "request id conflict" } }))
    expect(await addPantryItems(addRequest())).toMatchObject({ failure: "conflict" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    ["DB の検証（22023）", { code: "22023", message: "invalid name" }, "rejected"],
    ["権限なし（42501）", { code: "42501", message: "not allowed" }, "rejected"],
    ["通信の失敗（code なし）", { message: "fetch failed" }, "unknown"],
  ] as const)("%s は %s… 分類を取り違えない", async (_name, error, failure) => {
    signIn(() => ({ data: null, error }))
    const result = await addPantryItems(addRequest())
    expect(result).toMatchObject({ failure })
    // DB の生のエラーは利用者へ返さない
    expect(JSON.stringify(result)).not.toContain(error.message)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("RPC の例外（応答を失った）は結果不明。拒否と言い換えない", async () => {
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: {
        supabase: {
          rpc: async () => {
            throw new TypeError("fetch failed")
          },
        },
        userId: USER,
        householdId: HOUSE,
      },
    })
    expect(await addPantryItems(addRequest())).toMatchObject({ failure: "unknown" })
    expect(await savePantryItem(saveRequest())).toMatchObject({ failure: "unknown" })
    expect(await deletePantryItem(deleteRequest())).toMatchObject({ failure: "unknown" })
  })

  it.each([
    ["戻り値が null", null],
    ["status が未知", { status: "ok", saved: 1, replayed: 0, items: [row(ITEM_A)] }],
    ["行の数が要求と違う", { status: "saved", saved: 1, replayed: 0, items: [] }],
    ["行の ID が要求と違う", { status: "saved", saved: 1, replayed: 0, items: [row(ITEM_B)] }],
    ["行が読めない", { status: "saved", saved: 1, replayed: 0, items: [row(ITEM_A, { status: "plenty" })] }],
    ["件数の内訳が合わない", { status: "saved", saved: 0, replayed: 0, items: [row(ITEM_A)] }],
    ["まとめ入力に無いはずの conflict", { status: "conflict", saved: 0, replayed: 1, items: [row(ITEM_A)] }],
  ])("戻り値を読めない（%s）なら結果不明", async (_name, data) => {
    signIn(() => ({ data, error: null }))
    expect(await addPantryItems(addRequest())).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("C-21 / X-10 編集（save_pantry_item）", () => {
  it("数量・単位・状態・早く使いたい・保管場所・期限・最終確認日を、開いた時点の版つきで送る", async () => {
    const { calls } = signIn(() => ({ data: { status: "saved", item: row(ITEM_A, { status: "out" }) }, error: null }))
    const result = await savePantryItem(
      saveRequest({
        item: {
          ingredientId: "onion",
          name: "玉ねぎ",
          quantity: { amount: 300, unit: "g" },
          status: "out",
          useSoon: true,
          storage: "fridge",
          expiresOn: "2026-11-15",
          confirmedOn: "2026-11-09",
        },
      }),
    )
    expect(calls).toEqual([
      [
        "save_pantry_item",
        {
          p_id: ITEM_A,
          // 版は文字列のまま（new Date を通さない）
          p_version: V1,
          p_item: {
            ingredient_id: "onion",
            name: "玉ねぎ",
            quantity: 300,
            unit: "g",
            status: "out",
            use_soon: true,
            storage: "fridge",
            expires_on: "2026-11-15",
            confirmed_on: "2026-11-09",
          },
        },
      ],
    ])
    expect(result).toMatchObject({ status: "saved", deleted: false, item: { id: ITEM_A, status: "out", version: V2 } })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
  })

  it("新規（version: null）は版なしで送る", async () => {
    const { calls } = signIn(() => ({ data: { status: "saved", item: row(ITEM_A) }, error: null }))
    await savePantryItem(saveRequest({ version: null }))
    expect(calls[0][1].p_version).toBeNull()
  })

  it("家族が先に変えていれば conflict。上書きせず、DB の最新の行を返す", async () => {
    signIn(() => ({ data: { status: "conflict", item: row(ITEM_A, { quantity: 5, updated_at: V2 }) }, error: null }))
    expect(await savePantryItem(saveRequest())).toMatchObject({
      status: "conflict",
      deleted: false,
      item: { quantity: { amount: 5, unit: "piece" }, version: V2 },
    })
  })

  it("別の端末が削除していれば conflict + deleted（結果不明に落とさない）", async () => {
    signIn(() => ({ data: { status: "conflict", item: { id: ITEM_A, deleted: true } }, error: null }))
    expect(await savePantryItem(saveRequest())).toEqual({ status: "conflict", item: null, deleted: true })
  })

  it.each([
    ["別の行が返った", { status: "saved", item: row(ITEM_B) }],
    ["行が無い", { status: "saved" }],
    ["saved なのに削除の印", { status: "saved", item: { id: ITEM_A, deleted: true } }],
    ["削除の印の ID が違う", { status: "conflict", item: { id: ITEM_B, deleted: true } }],
  ])("戻り値を読めない（%s）なら結果不明", async (_name, data) => {
    signIn(() => ({ data, error: null }))
    expect(await savePantryItem(saveRequest())).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("削除（delete_pantry_item）", () => {
  it("版つきで送り、消えたら saved", async () => {
    const { calls } = signIn(() => ({ data: { status: "saved", id: ITEM_A }, error: null }))
    expect(await deletePantryItem(deleteRequest())).toEqual({ status: "saved", id: ITEM_A, item: null })
    expect(calls).toEqual([["delete_pantry_item", { p_id: ITEM_A, p_version: V1 }]])
    expect(revalidatePath).toHaveBeenCalledWith("/chores")
  })

  it("既に無い行の削除は replayed（応答を失った自分の再送）", async () => {
    signIn(() => ({ data: { status: "replayed", id: ITEM_A }, error: null }))
    expect(await deletePantryItem(deleteRequest())).toEqual({ status: "replayed", id: ITEM_A, item: null })
  })

  it("家族が先に変えていれば conflict。消さずに最新の行を返す", async () => {
    signIn(() => ({ data: { status: "conflict", item: row(ITEM_A, { status: "low" }) }, error: null }))
    expect(await deletePantryItem(deleteRequest())).toMatchObject({
      status: "conflict",
      id: ITEM_A,
      item: { status: "low", version: V2 },
    })
  })

  it("別世帯の行（42501）は拒否。存在を漏らす文言を返さない", async () => {
    signIn(() => ({ data: null, error: { code: "42501", message: "not allowed" } }))
    const result = await deletePantryItem(deleteRequest())
    expect(result).toMatchObject({ failure: "rejected" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("戻り値の ID が要求と違えば結果不明", async () => {
    signIn(() => ({ data: { status: "saved", id: ITEM_B }, error: null }))
    expect(await deletePantryItem(deleteRequest())).toMatchObject({ failure: "unknown" })
  })
})
