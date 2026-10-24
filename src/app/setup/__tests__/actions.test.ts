import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * createHousehold の失敗の振り分け（P1-01 の UI 側）。
 *
 * create_household は未承認の呼び出しを 42501 で拒む（20261002100001）。
 * 承認待ちの利用者に「もう一度お試しください」と再試行を促すと、何度押しても
 * 通らぬ操作を繰り返させることになるため、42501 だけは承認待ちの文言に分ける。
 */

const rpc = vi.fn()
const getUser = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser }, rpc }),
}))
vi.mock("next/navigation", () => ({
  redirect: vi.fn(() => {
    throw new Error("NEXT_REDIRECT")
  }),
}))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

import { createHousehold } from "../actions"

describe("createHousehold", () => {
  beforeEach(() => {
    rpc.mockReset()
    getUser.mockReset()
    getUser.mockResolvedValue({ data: { user: { id: "u1" } } })
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it("未承認（42501）は承認待ちの文言を返し、再試行を促さぬ", async () => {
    rpc.mockResolvedValue({
      error: { code: "42501", message: "not approved", details: null, hint: null },
    })
    const result = await createHousehold("田中家")
    expect(result).toEqual({ error: "管理者の承認がまだのため、世帯を作れません。" })
  })

  it("対照: 42501 以外の失敗は従来の再試行の文言", async () => {
    rpc.mockResolvedValue({
      error: { code: "P0001", message: "boom", details: null, hint: null },
    })
    const result = await createHousehold("田中家")
    expect(result).toEqual({ error: "世帯の作成に失敗しました。もう一度お試しください。" })
  })

  it("成功時は /baby へ redirect する", async () => {
    rpc.mockResolvedValue({ error: null })
    await expect(createHousehold("田中家")).rejects.toThrow("NEXT_REDIRECT")
  })
})
