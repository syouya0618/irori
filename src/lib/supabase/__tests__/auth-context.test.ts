/**
 * getAuthContext の fail-closed 検証。
 *
 * proxy と同じく `getUser()` → `getClaims()` へ切り替えるにあたり、切替前に
 * 不変条件を固定するために置いた（従前テストなし）。
 *
 * 判定不能（claims なし・error・sub 欠落・例外）は必ず "unauthenticated" へ倒す。
 * ページと Server Action はこの戻り値だけを信じて世帯データを触るため、ここが
 * 緩むと household 分離が破れる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getClaims = vi.fn()
const profileSingle = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: () => getClaims() },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => profileSingle() }) }),
    }),
  }),
}))

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

// React.cache は同一リクエスト内メモ化。テストでは素通しにして各ケースを独立させる。
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>()
  return { ...actual, cache: (fn: unknown) => fn }
})

import { getAuthContext } from "../auth-context"

beforeEach(() => {
  getClaims.mockReset()
  profileSingle.mockReset()
})

describe("getAuthContext: 認証不能は必ず unauthenticated（fail-closed）", () => {
  it.each([
    ["claims が空", { data: null, error: null }],
    ["error が返る", { data: null, error: { message: "invalid JWT" } }],
    ["sub が無い", { data: { claims: {} }, error: null }],
    ["想定外の戻り値", undefined],
  ])("%s → unauthenticated（世帯データへ到達させない）", async (_l, ret) => {
    getClaims.mockResolvedValue(ret)
    const r = await getAuthContext()
    expect(r.reason).toBe("unauthenticated")
    expect(r.context).toBeNull()
    // profiles を引きに行かない（無駄な往復も作らない）
    expect(profileSingle).not.toHaveBeenCalled()
  })

  it("getClaims が throw しても unauthenticated へ倒す", async () => {
    getClaims.mockRejectedValue(new Error("network down"))
    const r = await getAuthContext()
    expect(r.reason).toBe("unauthenticated")
    expect(r.context).toBeNull()
  })
})

describe("getAuthContext: 正常系と世帯なし", () => {
  it("claims.sub と household_id が揃えば context を返す", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: { household_id: "house-1" }, error: null })
    const r = await getAuthContext()
    expect(r.error).toBeNull()
    expect(r.context?.userId).toBe("user-1")
    expect(r.context?.householdId).toBe("house-1")
  })

  it("世帯未設定は no-household（unauthenticated と区別する）", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: { household_id: null }, error: null })
    const r = await getAuthContext()
    expect(r.reason).toBe("no-household")
    expect(r.context).toBeNull()
  })

  it("profiles が引けない時も context を返さない（fail-closed）", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const r = await getAuthContext()
    expect(r.context).toBeNull()
  })
})
