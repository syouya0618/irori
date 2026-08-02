/**
 * `oauth.ts` の契約テスト（計画書 §D-5 のエラーモデル / §D-6）。
 *
 * ## `global.fetch` の stub についての断り書き（グローバル規約との関係）
 * グローバル規約が禁じておるのは「**ブラウザ専用 I/O** を mock で隠し、node で
 * 落ちる事実を覆い隠すこと」。ここでの stub は**ネットワーク境界**の stub で、
 * `oauth.ts` は node/サーバ実行前提・絶対 URL のみ・`window` 非依存ゆえ
 * 「テスト緑・本番不動作」の死角は生まれぬ。本則には抵触せぬ。
 *
 * 実際の Google OAuth は**一度も叩いておらぬ**（認証情報を持たぬ）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchGoogleUserInfo,
  GoogleAuthError,
} from "../oauth"
import { GOOGLE_FETCH_TIMEOUT_MS } from "../fetch-with-timeout"

const REDIRECT_URI = "http://localhost:3000/api/google/oauth/callback"
const NOW = Date.parse("2026-08-02T00:00:00.000Z")

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function stubFetch(response: Response) {
  const calls: { url: string; init?: RequestInit }[] = []
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return response
  })
  vi.stubGlobal("fetch", mock)
  return { calls, mock }
}

let originalId: string | undefined
let originalSecret: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
  originalId = process.env.GOOGLE_CLIENT_ID
  originalSecret = process.env.GOOGLE_CLIENT_SECRET
  // 末尾改行を混ぜておく（`?.trim()` 防御が効いていることを同時に見る）。
  process.env.GOOGLE_CLIENT_ID = "test-client-id\n"
  process.env.GOOGLE_CLIENT_SECRET = "test-client-secret\n"
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (originalId === undefined) delete process.env.GOOGLE_CLIENT_ID
  else process.env.GOOGLE_CLIENT_ID = originalId
  if (originalSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET
  else process.env.GOOGLE_CLIENT_SECRET = originalSecret
})

// ============================================================
// invalid_grant の型区別（握り潰し禁止）
// ============================================================

describe("invalid_grant の区別", () => {
  it("refresh で invalid_grant が返れば kind='invalid_grant'", async () => {
    stubFetch(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      })
    )

    await expect(refreshAccessToken("rt-1", NOW)).rejects.toMatchObject({
      kind: "invalid_grant",
      status: 400,
    })
  })

  it("invalid_grant は GoogleAuthError のインスタンスで、Google の記述を保持する", async () => {
    stubFetch(
      jsonResponse(400, {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      })
    )

    const err = await refreshAccessToken("rt-1", NOW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleAuthError)
    expect((err as GoogleAuthError).googleError).toContain("invalid_grant")
  })

  it("invalid_client など他のエラーは kind='unknown'（恒久失敗と混ぜぬ）", async () => {
    stubFetch(jsonResponse(401, { error: "invalid_client" }))

    await expect(refreshAccessToken("rt-1", NOW)).rejects.toMatchObject({
      kind: "unknown",
      status: 401,
    })
  })

  it("code 交換でも invalid_grant を型で区別する", async () => {
    stubFetch(jsonResponse(400, { error: "invalid_grant" }))

    await expect(
      exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)
    ).rejects.toMatchObject({ kind: "invalid_grant" })
  })
})

// ============================================================
// トークン交換 / 更新
// ============================================================

describe("exchangeCodeForTokens", () => {
  it("token エンドポイントへ authorization_code を POST する", async () => {
    const { calls } = stubFetch(
      jsonResponse(200, {
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3599,
        scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
      })
    )

    const tokens = await exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)

    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token")
    expect(calls[0].init?.method).toBe("POST")
    const body = new URLSearchParams(String(calls[0].init?.body))
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("code-1")
    expect(body.get("redirect_uri")).toBe(REDIRECT_URI)
    // env の末尾改行が剥がれていること（`?.trim()` 防御）。
    expect(body.get("client_id")).toBe("test-client-id")
    expect(body.get("client_secret")).toBe("test-client-secret")

    expect(tokens.accessToken).toBe("at-1")
    expect(tokens.refreshToken).toBe("rt-1")
    expect(tokens.accessTokenExpiresAt).toBe(
      new Date(NOW + 3599 * 1000).toISOString()
    )
    expect(tokens.scope).toContain("calendar.readonly")
  })

  it("refresh_token が返らなければ null（呼び出し側が no_refresh_token を判定できる）", async () => {
    stubFetch(jsonResponse(200, { access_token: "at-1", expires_in: 3599 }))

    const tokens = await exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)

    expect(tokens.refreshToken).toBeNull()
  })

  it("expires_in が無ければ accessTokenExpiresAt は null（0 へ丸めぬ）", async () => {
    stubFetch(jsonResponse(200, { access_token: "at-1" }))

    const tokens = await exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)

    expect(tokens.accessTokenExpiresAt).toBeNull()
  })

  it("200 でも access_token が無ければ throw する（無音で進まぬ）", async () => {
    stubFetch(jsonResponse(200, { token_type: "Bearer" }))

    await expect(
      exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)
    ).rejects.toMatchObject({ kind: "unknown" })
  })
})

describe("refreshAccessToken", () => {
  it("grant_type=refresh_token を送り、Google が返さぬ refresh_token は null", async () => {
    const { calls } = stubFetch(
      jsonResponse(200, { access_token: "at-2", expires_in: 3599 })
    )

    const tokens = await refreshAccessToken("rt-1", NOW)

    const body = new URLSearchParams(String(calls[0].init?.body))
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("rt-1")
    // ここが null であることが、token-store 側で refresh_token を
    // 上書きせぬ設計（updateGoogleAccessToken）の前提じゃ。
    expect(tokens.refreshToken).toBeNull()
    expect(tokens.accessToken).toBe("at-2")
  })
})

// ============================================================
// env の fail-closed
// ============================================================

describe("OAuth クライアント資格情報の fail-closed", () => {
  it("GOOGLE_CLIENT_ID 未設定なら fetch せず throw する", async () => {
    delete process.env.GOOGLE_CLIENT_ID
    const { mock } = stubFetch(jsonResponse(200, { access_token: "at" }))

    await expect(
      exchangeCodeForTokens("code-1", REDIRECT_URI, NOW)
    ).rejects.toThrow(/GOOGLE_CLIENT_ID/)
    expect(mock).not.toHaveBeenCalled()
  })

  it("GOOGLE_CLIENT_SECRET が空白のみなら throw する", async () => {
    process.env.GOOGLE_CLIENT_SECRET = "   \n"
    const { mock } = stubFetch(jsonResponse(200, { access_token: "at" }))

    await expect(refreshAccessToken("rt-1", NOW)).rejects.toThrow(
      /GOOGLE_CLIENT_SECRET/
    )
    expect(mock).not.toHaveBeenCalled()
  })

  it("設定ミスは GoogleAuthError にしない（再連携導線へ誤って流さぬ）", async () => {
    delete process.env.GOOGLE_CLIENT_ID
    stubFetch(jsonResponse(200, { access_token: "at" }))

    const err = await refreshAccessToken("rt-1", NOW).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(GoogleAuthError)
  })
})

// ============================================================
// userinfo（openid email スコープの契約）
// ============================================================

describe("fetchGoogleUserInfo", () => {
  it("sub と email を返す", async () => {
    const { calls } = stubFetch(
      jsonResponse(200, {
        sub: "104729...",
        email: "spouse@example.com",
        email_verified: true,
      })
    )

    const info = await fetchGoogleUserInfo("at-1")

    expect(calls[0].url).toBe("https://openidconnect.googleapis.com/v1/userinfo")
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer at-1",
    })
    expect(info).toEqual({ sub: "104729...", email: "spouse@example.com" })
  })

  it("sub 欠落（openid email スコープ不足）は throw する", async () => {
    stubFetch(jsonResponse(200, { email: "spouse@example.com" }))

    await expect(fetchGoogleUserInfo("at-1")).rejects.toThrow(/openid email/)
  })

  it("email 欠落も throw する（google_email は NOT NULL）", async () => {
    stubFetch(jsonResponse(200, { sub: "104729..." }))

    await expect(fetchGoogleUserInfo("at-1")).rejects.toBeInstanceOf(
      GoogleAuthError
    )
  })

  it("403（スコープ不足）は kind='unknown' + status=403", async () => {
    stubFetch(jsonResponse(403, { error: { code: 403, message: "insufficient" } }))

    await expect(fetchGoogleUserInfo("at-1")).rejects.toMatchObject({
      kind: "unknown",
      status: 403,
    })
  })
})

// ============================================================
// ネットワーク層
// ============================================================

describe("ネットワーク層の失敗", () => {
  it("AbortError → kind='network'", async () => {
    const abortError = new Error("aborted")
    abortError.name = "AbortError"
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw abortError
      })
    )

    await expect(refreshAccessToken("rt-1", NOW)).rejects.toMatchObject({
      kind: "network",
    })
  })

  it("`TypeError: fetch failed` も kind='network'（unknown へ落とさぬ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )

    await expect(fetchGoogleUserInfo("at-1")).rejects.toMatchObject({
      kind: "network",
    })
  })

  it("AbortController が 10 秒で発火する", async () => {
    vi.useFakeTimers()
    const mock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.")
          err.name = "AbortError"
          reject(err)
        })
      })
    })
    vi.stubGlobal("fetch", mock)

    const promise = refreshAccessToken("rt-1", NOW)
    const assertion = expect(promise).rejects.toMatchObject({ kind: "network" })

    await vi.advanceTimersByTimeAsync(GOOGLE_FETCH_TIMEOUT_MS - 1)
    const signal = (mock.mock.calls[0][1] as RequestInit).signal
    expect(signal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(signal?.aborted).toBe(true)
    await assertion
  })
})

// ============================================================
// 機密のマスキング
// ============================================================

describe("機密をログに出さない", () => {
  it("失敗ログに client_secret / refresh_token / code が含まれない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    stubFetch(jsonResponse(400, { error: "invalid_grant" }))

    await refreshAccessToken("SUPER-SECRET-REFRESH-TOKEN", NOW).catch(() => {})

    const dumped = JSON.stringify(errorSpy.mock.calls)
    expect(dumped).not.toContain("SUPER-SECRET-REFRESH-TOKEN")
    expect(dumped).not.toContain("test-client-secret")
  })

  it("code 交換の失敗ログにも code / secret が含まれない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    stubFetch(jsonResponse(400, { error: "redirect_uri_mismatch" }))

    await exchangeCodeForTokens("SUPER-SECRET-CODE", REDIRECT_URI, NOW).catch(
      () => {}
    )

    const dumped = JSON.stringify(errorSpy.mock.calls)
    expect(dumped).not.toContain("SUPER-SECRET-CODE")
    expect(dumped).not.toContain("test-client-secret")
  })
})
