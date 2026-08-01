/**
 * getConsumptionRates の消費レート週窓 TZ 回帰テスト(low-stock.ts と同根の +09:00)。
 * getAuthContext をモックし、baby_logs クエリの .gte("logged_at", ...) 下限が
 * +09:00 明示になっていることを固定する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import {
  getConsumptionRates,
  addReceiptItemsToStock,
  deleteStockItem,
  updateStockItem,
} from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

beforeEach(() => vi.clearAllMocks())

describe("getConsumptionRates: 消費レート週窓の TZ", () => {
  it("logged_at の下限は JST 深夜 0 時（+09:00 明示）で問い合わせる", async () => {
    const gte = vi.fn()
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      gte: (col: string, val: string) => {
        gte(col, val)
        return chain
      },
      // .order() が終端(await される)
      order: () => Promise.resolve({ data: [], error: null }),
    }
    const supabase = { from: () => chain }
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase, userId: "u", householdId: "h" },
    })

    await getConsumptionRates()

    const call = gte.mock.calls.find(([col]) => col === "logged_at")
    expect(call).toBeDefined()
    expect(call?.[1]).toMatch(/T00:00:00\+09:00$/)
  })
})

describe("addReceiptItemsToStock: 認可と入力検証の順序", () => {
  it("未認証なら不正な引数でも throw せず認証エラーを返す（認可が入力処理より先）", async () => {
    getAuthContext.mockResolvedValue({
      error: "ログインしてください",
      reason: "unauthenticated",
      context: null,
    })

    const result = await addReceiptItemsToStock(null as never)

    expect(result).toEqual({ error: "ログインしてください" })
  })

  it("認証済みでも非配列は拒否し、DB に触れない", async () => {
    const from = vi.fn()
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase: { from }, userId: "u", householdId: "h" },
    })

    const result = await addReceiptItemsToStock("attack" as never)

    expect(result).toEqual({ error: "不正なリクエストです" })
    expect(from).not.toHaveBeenCalled()
  })

  it("細工した要素（name が number 等）は throw せず除外され、全滅なら追加不可エラー", async () => {
    const from = vi.fn()
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase: { from }, userId: "u", householdId: "h" },
    })

    const result = await addReceiptItemsToStock([
      { name: 123 },
      null,
    ] as never)

    expect(result).toEqual({
      error: "追加できる商品がありません（商品名を入力してください）",
    })
    expect(from).not.toHaveBeenCalled()
  })
})

/**
 * `.update()` / `.delete()` は 0 行でも `error: null` を返す。`.select("id")` で
 * 行数を検証しない限り「触れていないのに success」を返し、StockList の楽観削除の
 * 巻き戻しがハードエラー時にしか効かなくなる（PR #176 レビューで判明）。
 *
 * mock の掟: 中間の `.eq()` を await 可能にしない。await 可能にすると実装から
 * `.select()` が落ちても素通りしてしまう。
 */
type StockResult = { data: unknown; error: unknown }

/** verb().eq().eq().select() のみを受け付ける fake client。 */
function makeWriteClient(verb: "update" | "delete", result: StockResult) {
  const select = vi.fn().mockResolvedValue(result)
  const eqHousehold = vi.fn(() => ({ select }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const op = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ [verb]: op }))
  return { client: { from }, select, op }
}

function setStockContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "u", householdId: "h" },
  })
}

function stockForm(): FormData {
  const fd = new FormData()
  fd.set("name", "おむつ")
  fd.set("category", "baby")
  fd.set("quantity", "3")
  return fd
}

describe("deleteStockItem: 0 行削除を成功と偽らない", () => {
  it("0 行削除ならエラーを返す（楽観削除の巻き戻しが効く条件）", async () => {
    const { client, select } = makeWriteClient("delete", { data: [], error: null })
    setStockContext(client)

    expect(await deleteStockItem("stock-1")).toEqual({
      error: "削除に失敗しました（既に削除されている可能性があります）",
    })
    expect(select).toHaveBeenCalledWith("id")
  })

  it("1 行削除なら成功", async () => {
    const { client } = makeWriteClient("delete", {
      data: [{ id: "stock-1" }],
      error: null,
    })
    setStockContext(client)

    expect(await deleteStockItem("stock-1")).toEqual({ success: true })
  })

  it("ハードエラーはエラー文言 + 構造化ログ", async () => {
    const { client } = makeWriteClient("delete", {
      data: null,
      error: { code: "42501", message: "permission denied" },
    })
    setStockContext(client)

    expect(await deleteStockItem("stock-1")).toEqual({ error: "削除に失敗しました" })
    expect(vi.mocked(logSupabaseError)).toHaveBeenCalledWith(
      "stock",
      expect.any(String),
      expect.objectContaining({ code: "42501" }),
      expect.objectContaining({ itemId: "stock-1", householdId: "h" }),
    )
  })
})

describe("updateStockItem: 0 行更新を成功と偽らない", () => {
  it("0 行更新（別世帯・不在 id）ならエラーを返す", async () => {
    const { client, select } = makeWriteClient("update", { data: [], error: null })
    setStockContext(client)

    expect(await updateStockItem("stock-1", stockForm())).toEqual({
      error: "在庫の更新に失敗しました（対象が見つかりません）",
    })
    expect(select).toHaveBeenCalledWith("id")
  })

  it("1 行更新なら成功", async () => {
    const { client } = makeWriteClient("update", {
      data: [{ id: "stock-1" }],
      error: null,
    })
    setStockContext(client)

    expect(await updateStockItem("stock-1", stockForm())).toEqual({ success: true })
  })
})
