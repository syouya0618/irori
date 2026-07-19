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

import { getConsumptionRates, addReceiptItemsToStock } from "../actions"

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
