/**
 * proxy（認証ゲート）の fail-closed 検証。
 *
 * 本ファイルは `getUser()`（毎回 Auth サーバへ往復）から `getClaims()`（非対称鍵なら
 * ローカル WebCrypto 検証）へ切り替えるにあたって置いた。**認証の最外殻ゲートであり
 * ながらテストが1本も無かった**ため、切替の前に不変条件を固定する。
 *
 * 最重要の不変条件: **判定不能は必ず「未認証」へ倒す**（fail-closed）。
 * 署名不正・期限切れ・JWKS 取得失敗・想定外の戻り値のいずれでも、保護ページを
 * 素通しさせてはならない。ここが緩むと「OSS 公開 × 家族専用」が破れる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const getClaims = vi.fn()
const profileSingle = vi.fn()

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: () => getClaims() },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => profileSingle() }) }),
    }),
  }),
}))

import { proxy } from "../proxy"

/** 本物の NextRequest を使う（nextUrl / cookies が要るため素の Request では不足） */
function request(pathname: string) {
  return new NextRequest(new URL(pathname, "https://example.test"), {
    headers: { host: "example.test" },
  })
}

/** 認証済み扱いの claims（sub がユーザー ID） */
const validClaims = { data: { claims: { sub: "user-1" } }, error: null }

beforeEach(() => {
  getClaims.mockReset()
  profileSingle.mockReset()
  profileSingle.mockResolvedValue({ data: { is_approved: true }, error: null })
})

describe("proxy: 未認証の扱い（fail-closed）", () => {
  it.each([
    ["claims が空", { data: null, error: null }],
    ["error が返る（署名不正・期限切れ・JWKS 取得失敗を含む）", { data: null, error: { message: "invalid JWT" } }],
    ["claims はあるが sub が無い", { data: { claims: {} }, error: null }],
    ["想定外の戻り値（undefined）", undefined],
  ])("%s → 保護ページは /login へ redirect（素通しさせない）", async (_label, ret) => {
    getClaims.mockResolvedValue(ret)
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("getClaims が throw しても素通しさせない（例外も未認証へ倒す）", async () => {
    getClaims.mockRejectedValue(new Error("network down"))
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("未認証でも /login 自体は通す（リダイレクトループを作らない）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    const res = await proxy(request("/login"))
    expect(res.status).not.toBe(307)
  })
})

describe("proxy: 承認ゲート（DB 読みゆえ即時に効き続ける）", () => {
  it("承認済みは保護ページを通す", async () => {
    getClaims.mockResolvedValue(validClaims)
    const res = await proxy(request("/baby"))
    expect(res.status).not.toBe(307)
  })

  it("未承認は /pending-approval へ", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: { is_approved: false }, error: null })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })

  it("profiles が引けない時も承認済み扱いにしない（fail-closed）", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })
})
