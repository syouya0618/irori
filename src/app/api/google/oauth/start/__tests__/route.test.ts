import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `/api/google/oauth/start` の **URL 契約テスト**（計画書 §7 D-4）。
 *
 * ## なぜ実ハンドラの Location を見るのか
 * `buildGoogleAuthorizeUrl` を直接呼ぶテストは「builder がこう組む」ことしか
 * 示さぬ。**実際に Google へ送り出す URL** の保証にはならぬ（`calendar-client.ts`
 * が `buildEventsUrl` を export せぬのと同じ理由）。ゆえにここでは
 * `GET()` を呼び、返った `Location` ヘッダを解析して固定する。
 *
 * ## 固定する契約（落とすと静かに壊れるもの）
 * 1. スコープ 3 種（`calendar.readonly` / `openid` / `email`）が**集合として**一致
 * 2. `access_type=offline`
 * 3. `prompt=consent`
 * 4. `state` が cookie と同値・十分な長さ（CSRF）
 * 5. `redirect_uri` が `getAppOrigin()` 由来（専用 env を増やさぬ）
 *
 * mock は `getAuthContext`（Supabase 往復の代役）と env のみ。**URL の組み立てには
 * 一切 mock を挟まぬ** — 挟めば「定数を echo しただけ」のテストになる。
 */

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { GET } from "@/app/api/google/oauth/start/route"
import {
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_OAUTH_STATE_COOKIE,
} from "@/lib/google/oauth-connect"

const APP_ORIGIN = "https://irori.example.test"
// 本物らしい形にせぬ（機密のダミーは「明らかにダミー」と分かる形に保つ）。
const FAKE_CLIENT_ID = "test-client-id-not-real"

function request(): Request {
  return new Request(`${APP_ORIGIN}/api/google/oauth/start`)
}

/** 返答の Location を URL として解析する。 */
function locationOf(response: Response): URL {
  const location = response.headers.get("location")
  expect(location, "Location ヘッダが無い").not.toBeNull()
  return new URL(location as string)
}

/** `Set-Cookie` から state cookie の値を取り出す（無ければ null）。 */
function stateCookieOf(response: Response): string | null {
  const setCookie = response.headers.getSetCookie().find((c) =>
    c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`),
  )
  if (setCookie === undefined) return null
  const value = setCookie.slice(`${GOOGLE_OAUTH_STATE_COOKIE}=`.length)
  return value.split(";")[0]
}

beforeEach(() => {
  getAuthContext.mockReset()
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: {}, userId: "user-1", householdId: "household-1" },
  })
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN)
  vi.stubEnv("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("GET /api/google/oauth/start — URL 契約", () => {
  it("Google の認可エンドポイントへ redirect する", async () => {
    const url = locationOf(await GET(request()))
    expect(url.origin).toBe("https://accounts.google.com")
    expect(url.pathname).toBe("/o/oauth2/v2/auth")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID)
  })

  it("スコープは calendar.readonly / openid / email の 3 種ちょうど", async () => {
    const url = locationOf(await GET(request()))
    const scope = url.searchParams.get("scope")
    expect(scope, "scope パラメータが無い").not.toBeNull()

    const granted = (scope as string).split(" ").filter((s) => s.length > 0)
    // 集合として一致させる（順序は契約ではない）。
    expect(new Set(granted)).toEqual(
      new Set([GOOGLE_CALENDAR_READONLY_SCOPE, "openid", "email"]),
    )
    // 個別にも名指しする（集合比較だけだと差分の読みが辛い）。
    // `openid email` が無いと userinfo が引けず google_account_id を埋められぬ
    // （D-1 migration の契約）。
    expect(granted).toContain("openid")
    expect(granted).toContain("email")
    expect(granted).toContain(GOOGLE_CALENDAR_READONLY_SCOPE)
  })

  it("access_type=offline を必ず付ける（refresh token を得る条件）", async () => {
    const url = locationOf(await GET(request()))
    expect(url.searchParams.get("access_type")).toBe("offline")
  })

  it("prompt=consent を必ず付ける（2 回目以降も refresh token を得る条件）", async () => {
    const url = locationOf(await GET(request()))
    expect(url.searchParams.get("prompt")).toBe("consent")
  })

  it("redirect_uri は getAppOrigin() から導出する（専用 env を増やさぬ）", async () => {
    const url = locationOf(await GET(request()))
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${APP_ORIGIN}/api/google/oauth/callback`,
    )
  })

  it("NEXT_PUBLIC_APP_URL 未設定なら host ヘッダから redirect_uri を組む", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "")
    const response = await GET(
      new Request("http://127.0.0.1/api/google/oauth/start", {
        headers: { host: "localhost:3000", "x-forwarded-proto": "http" },
      }),
    )
    expect(locationOf(response).searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/google/oauth/callback",
    )
  })
})

describe("GET /api/google/oauth/start — CSRF state", () => {
  it("state を cookie と URL の両方へ同じ値で載せる", async () => {
    const response = await GET(request())
    const url = locationOf(response)
    const cookieState = stateCookieOf(response)

    expect(cookieState, "state cookie が発行されていない").not.toBeNull()
    expect(url.searchParams.get("state")).toBe(cookieState)
  })

  it("state は 256bit 相当の乱数（64 桁の hex）", async () => {
    const state = stateCookieOf(await GET(request()))
    expect(state).toMatch(/^[0-9a-f]{64}$/)
  })

  it("呼ぶたびに異なる state を発行する（使い回さぬ）", async () => {
    const first = stateCookieOf(await GET(request()))
    const second = stateCookieOf(await GET(request()))
    expect(first).not.toBe(second)
  })

  it("state cookie は httpOnly / SameSite=Lax / 経路限定で発行する", async () => {
    const response = await GET(request())
    const raw = response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    expect(raw).toBeDefined()
    expect(raw).toMatch(/HttpOnly/i)
    // strict では Google からのクロスサイト遷移で cookie が送られず必ず csrf になる。
    expect(raw).toMatch(/SameSite=Lax/i)
    expect(raw).toMatch(/Path=\/api\/google\/oauth/i)
  })

  it("https の origin では Secure を付ける", async () => {
    const raw = (await GET(request())).headers
      .getSetCookie()
      .find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    expect(raw).toMatch(/Secure/i)
  })

  it("http://localhost では Secure を付けない（付けると手動スモークが不可能になる）", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000")
    const raw = (await GET(request())).headers
      .getSetCookie()
      .find((c) => c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`))
    expect(raw).toBeDefined()
    expect(raw).not.toMatch(/Secure/i)
  })
})

describe("GET /api/google/oauth/start — fail-closed", () => {
  it("未認証ならログインへ戻す（Google へは送らぬ）", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    const url = locationOf(await GET(request()))
    expect(url.origin).toBe(APP_ORIGIN)
    expect(url.pathname).toBe("/login")
  })

  it("GOOGLE_CLIENT_ID 未設定なら 500 にせず ?google=not_configured で戻す", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "")
    const url = locationOf(await GET(request()))
    expect(url.pathname).toBe("/settings")
    expect(url.searchParams.get("google")).toBe("not_configured")
  })

  it("GOOGLE_CLIENT_ID の末尾改行は trim される", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", `${FAKE_CLIENT_ID}\n`)
    const url = locationOf(await GET(request()))
    expect(url.searchParams.get("client_id")).toBe(FAKE_CLIENT_ID)
  })

  it("空白のみの GOOGLE_CLIENT_ID は未設定として扱う", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "   ")
    const url = locationOf(await GET(request()))
    expect(url.searchParams.get("google")).toBe("not_configured")
  })
})
