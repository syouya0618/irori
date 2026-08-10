/**
 * `/auth/confirm` — メールを使わぬログインの着地点（緊急用の逃げ道）の契約。
 *
 * ここは **認証の入口**じゃ。守るものは 3 つある:
 *   ① 有効な token_hash が無ければセッションを立てぬ（fail-closed）
 *   ② `type` は **この app が発行するものだけ**しか受けぬ（allowlist）
 *   ③ **token_hash をどこにも漏らさぬ**（ログにも redirect 先にも）
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const verifyOtp = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { verifyOtp: (p: unknown) => verifyOtp(p) },
  }),
}))

import { GET } from "../route"

const ORIGIN = "https://example.test"
const TOKEN = "super-secret-token-hash-value"

function request(query: string) {
  return new Request(`${ORIGIN}/auth/confirm${query}`, {
    headers: { host: "example.test", "x-forwarded-proto": "https" },
  })
}

async function locationOf(query: string) {
  const res = await GET(request(query))
  const url = new URL(res.headers.get("location")!)
  return {
    raw: res.headers.get("location")!,
    pathname: url.pathname,
    error: url.searchParams.get("error"),
    returnTo: url.searchParams.get("returnTo"),
  }
}

beforeEach(() => {
  verifyOtp.mockReset()
  verifyOtp.mockResolvedValue({ error: null })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("成功経路", () => {
  it("有効な token_hash で / へ送る（行き先は proxy が default_page へ解決する）", async () => {
    const r = await locationOf(`?token_hash=${TOKEN}&type=magiclink`)
    expect(r.pathname).toBe("/")
    expect(verifyOtp).toHaveBeenCalledWith({
      token_hash: TOKEN,
      type: "magiclink",
    })
  })

  it("returnTo が相対パスならそこへ送る", async () => {
    const r = await locationOf(
      `?token_hash=${TOKEN}&type=magiclink&returnTo=%2Fbaby`
    )
    expect(r.pathname).toBe("/baby")
  })

  it.each([
    ["別オリジン", "https%3A%2F%2Fevil.example.com"],
    ["スキーム相対", "%2F%2Fevil.example.com"],
  ])("returnTo が %s なら無視して / へ（open redirect 防止）", async (_l, v) => {
    const r = await locationOf(`?token_hash=${TOKEN}&type=magiclink&returnTo=${v}`)
    expect(r.pathname).toBe("/")
  })
})

describe("fail-closed（有効な token が無ければ通さぬ）", () => {
  it("token_hash 無しは verifyOtp を呼ばずに弾く", async () => {
    const r = await locationOf("?type=magiclink")
    expect(r.pathname).toBe("/login")
    expect(r.error).toBe("link_invalid")
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it("verifyOtp が失敗したらセッションを立てず /login へ", async () => {
    verifyOtp.mockResolvedValue({
      error: { message: "Token has expired or is invalid", code: "otp_expired", status: 403 },
    })
    const r = await locationOf(`?token_hash=${TOKEN}&type=magiclink`)
    expect(r.pathname).toBe("/login")
    expect(r.error).toBe("link_invalid")
  })
})

describe("type の allowlist", () => {
  it("magiclink は通す", async () => {
    expect((await locationOf(`?token_hash=${TOKEN}&type=magiclink`)).pathname).toBe("/")
  })

  /**
   * `EmailOtpType` は `(string & {})` を含むため **TypeScript は誤った値を止めぬ**。
   * 実行時のこの allowlist だけが唯一の守りゆえ、素通ししたら赤くする。
   * この app が発行せぬ種別は、発行するようになった PR でテストと共に足すこと。
   */
  it.each([
    "recovery",
    "invite",
    "signup",
    "email_change",
    "email",
    "sms",
    "",
    "MAGICLINK",
  ])("発行せぬ種別 %s は verifyOtp へ渡さぬ", async (type) => {
    const r = await locationOf(
      `?token_hash=${TOKEN}&type=${encodeURIComponent(type)}`
    )
    expect(r.pathname).toBe("/login")
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it("type 自体が無ければ弾く", async () => {
    const r = await locationOf(`?token_hash=${TOKEN}`)
    expect(r.error).toBe("link_invalid")
    expect(verifyOtp).not.toHaveBeenCalled()
  })
})

describe("token_hash を漏らさぬ（使い切りの資格情報ゆえ）", () => {
  it("redirect 先の URL に載せぬ", async () => {
    const r = await locationOf(`?token_hash=${TOKEN}&type=magiclink&returnTo=%2Fbaby`)
    expect(r.raw).not.toContain(TOKEN)
  })

  it("失敗時の redirect 先にも載せぬ", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "bad", code: "x", status: 403 } })
    const r = await locationOf(`?token_hash=${TOKEN}&type=magiclink`)
    expect(r.raw).not.toContain(TOKEN)
  })

  it("ログにも載せぬ（在ったか否かだけ記録する）", async () => {
    await locationOf(`?type=magiclink`) // token 無しでログが出る経路
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    )
    expect(logged).not.toContain(TOKEN)
    expect(logged).toContain("hasTokenHash")
  })

  it("verifyOtp 失敗のログにも載せぬ", async () => {
    verifyOtp.mockResolvedValue({ error: { message: "bad", code: "x", status: 403 } })
    await locationOf(`?token_hash=${TOKEN}&type=magiclink`)
    const logged = JSON.stringify(
      (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
    )
    expect(logged).not.toContain(TOKEN)
  })
})
