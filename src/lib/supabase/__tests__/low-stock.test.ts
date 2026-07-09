/**
 * autoAddLowStockItems の消費レート週窓 TZ 回帰テスト。
 *
 * logged_at は TIMESTAMPTZ。オフセット無しの "YYYY-MM-DDT00:00:00" は Postgres が
 * セッション TZ(既定 UTC)で解釈し、JST 深夜 0 時より 9 時間ずれる。深夜の授乳・
 * おむつ記録が集計から漏れないよう、下限は +09:00 を明示する。
 */

import { describe, it, expect, vi } from "vitest"
import { autoAddLowStockItems } from "@/lib/supabase/low-stock"

/** baby_logs の .gte("logged_at", ...) 引数を捕捉する最小 fake client。 */
function makeFakeClient(gteSpy: (col: string, val: string) => void) {
  const tableData: Record<string, unknown> = {
    households: { data: { auto_stock_categories: [] }, error: null },
    baby_logs: { data: [], error: null },
    stock_items: { data: [], error: null },
    shopping_items: { data: [], error: null },
  }
  function builder(table: string) {
    const result = tableData[table] ?? { data: [], error: null }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      gte: (col: string, val: string) => {
        gteSpy(col, val)
        return chain
      },
      limit: () => chain,
      single: () => Promise.resolve(result),
      // Promise.all は thenable を await する → chain 自体を解決可能にする
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve(result).then(onFulfilled),
    }
    return chain
  }
  return { from: (table: string) => builder(table) } as never
}

describe("autoAddLowStockItems: 消費レート週窓の TZ", () => {
  it("logged_at の下限は JST 深夜 0 時（+09:00 明示）で問い合わせる", async () => {
    const gte = vi.fn()
    const supabase = makeFakeClient(gte)

    await autoAddLowStockItems(supabase, "house-1", "user-1")

    const loggedAtCall = gte.mock.calls.find(([col]) => col === "logged_at")
    expect(loggedAtCall).toBeDefined()
    expect(loggedAtCall?.[1]).toMatch(/T00:00:00\+09:00$/)
  })
})
