/**
 * `/auth/callback` の失敗経路の契約。
 *
 * この route は以前、失敗の証拠を全て捨てて `/login?error=auth` へ飛ばすだけ
 * じゃった。GoTrue が返す `error_code` も、`exchangeCodeForSession` の error も
 * 読まず・記録せず・利用者にも伝えなんだ。2026-08-10 に配偶者がログインできなく
 * なった時、**誰も原因を言えなんだ**のはそのためじゃ。
 *
 * ここで固定するのは「どの失敗がどの理由コードになるか」と、
 * **code の有無を先に見る順序**（再送リンクに古い error が紛れても、今回の
 * 成否を取り違えぬこと）じゃ。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const exchangeCodeForSession = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { exchangeCodeForSession: (c: string) => exchangeCodeForSession(c) },
  }),
}))

import { GET } from "../route"

const ORIGIN = "https://example.test"

function request(query: string) {
  return new Request(`${ORIGIN}/auth/callback${query}`, {
    headers: { host: "example.test", "x-forwarded-proto": "https" },
  })
}

/** redirect 先の pathname と error クエリを取り出す */
async function redirectOf(query: string) {
  const res = await GET(request(query))
  const url = new URL(res.headers.get("location")!)
  return {
    status: res.status,
    pathname: url.pathname,
    error: url.searchParams.get("error"),
    returnTo: url.searchParams.get("returnTo"),
  }
}

beforeEach(() => {
  exchangeCodeForSession.mockReset()
  exchangeCodeForSession.mockResolvedValue({ error: null })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("成功経路", () => {
  it("code の交換に成功したら / へ送る", async () => {
    const r = await redirectOf("?code=abc")
    expect(r.pathname).toBe("/")
    expect(r.error).toBeNull()
  })

  it("returnTo が相対パスならそこへ送る", async () => {
    expect((await redirectOf("?code=abc&returnTo=%2Fbaby")).pathname).toBe(
      "/baby"
    )
  })

  it.each([
    ["別オリジン", "https%3A%2F%2Fevil.example.com"],
    ["プロトコル相対", "%2F%2Fevil.example.com"],
  ])("returnTo が %s なら無視して / へ（open redirect 防止）", async (_l, v) => {
    const r = await redirectOf(`?code=abc&returnTo=${v}`)
    expect(r.pathname).toBe("/")
  })
})

describe("失敗経路：理由が利用者へ届く", () => {
  it("PKCE の検証子欠落は verifier_missing（別ブラウザで開いた場合）", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: {
        message: "invalid request: both auth code and code verifier should be non-empty",
        code: "validation_failed",
        status: 400,
      },
    })
    const r = await redirectOf("?code=abc")
    expect(r.pathname).toBe("/login")
    expect(r.error).toBe("verifier_missing")
  })

  it("それ以外の交換失敗は exchange_failed（文字列一致に外れても無言にせぬ）", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "something else entirely", code: "unknown", status: 500 },
    })
    expect((await redirectOf("?code=abc")).error).toBe("exchange_failed")
  })

  it("交換失敗は必ずログに残す（端末を触れぬ側から原因を追えるように）", async () => {
    exchangeCodeForSession.mockResolvedValue({
      error: { message: "boom", code: "some_code", status: 400 },
    })
    await redirectOf("?code=abc")
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("exchangeCodeForSession"),
      expect.objectContaining({ code: "some_code", status: 400 })
    )
  })

  it("期限切れ（otp_expired）は link_expired", async () => {
    expect(
      (await redirectOf("?error=access_denied&error_code=otp_expired")).error
    ).toBe("link_expired")
  })

  it("code も error も無い着地は link_invalid（無言で戻さぬ）", async () => {
    const r = await redirectOf("")
    expect(r.pathname).toBe("/login")
    expect(r.error).toBe("link_invalid")
  })

  it("GoTrue の error_description をクエリへ載せ替えぬ（自由文を画面経路へ通さぬ）", async () => {
    const res = await GET(
      request(
        "?error=access_denied&error_code=otp_expired&error_description=call%20evil.example.com"
      )
    )
    const location = res.headers.get("location")!
    expect(location).not.toContain("evil.example.com")
    expect(location).not.toContain("error_description")
  })
})

describe("順序：code の有無を先に見る", () => {
  /**
   * `/login?error=...` から再送すると、`emailRedirectTo` が引き継いだ古い
   * `error` がリンクへ紛れうる（引き継ぎ側でも落としてはおるが、二重に守る）。
   * その時に**今回の成功を前回の失敗で塗り潰さぬ**ことを固定する。
   */
  it("古い error が付いていても、code の交換に成功したら成功として扱う", async () => {
    const r = await redirectOf("?error=link_expired&error_code=otp_expired&code=abc")
    expect(r.pathname).toBe("/")
    expect(r.error).toBeNull()
  })
})
