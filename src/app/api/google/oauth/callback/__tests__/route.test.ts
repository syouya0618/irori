import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * `/api/google/oauth/callback` のエラーモデル（計画書 §7 D-5）。
 *
 * ## stub の方針
 * - `global.fetch` を stub する = **ネットワーク境界の注入**。実 `oauth.ts` /
 *   `calendar-client.ts` がそのまま走るため、`refresh_token` → `refreshToken` の
 *   写しや `invalid_grant` の型付けまで本物の経路で検査できる。グローバル規約が
 *   禁じる「ブラウザ専用 I/O を mock で隠す」行為ではない（計画書 §D-6 の断り書き）。
 * - `createAdminClient` / `saveGoogleTokens` / `getAuthContext` はモジュール境界で
 *   差し替える。DB は D-1 の pgTAP と D-3 の単体テストが担保する領分ゆえ、
 *   ここで検査したいのは**このルートの orchestration**（順序・書き込み内容・遷移）じゃ。
 */

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

const createAdminClient = vi.fn()
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}))

const saveGoogleTokens = vi.fn()
vi.mock("@/lib/google/token-store", () => ({
  saveGoogleTokens: (...args: unknown[]) => saveGoogleTokens(...args),
}))

import { GET } from "@/app/api/google/oauth/callback/route"
import {
  GOOGLE_CALENDAR_READONLY_SCOPE,
  GOOGLE_OAUTH_STATE_COOKIE,
} from "@/lib/google/oauth-connect"

const APP_ORIGIN = "https://irori.example.test"
const STATE = "a".repeat(64)
// ダミーは「明らかにダミー」と分かる形に保つ（本物らしい形にせぬ）。
const FAKE_CLIENT_ID = "test-client-id-not-real"
const FAKE_CLIENT_SECRET = "test-client-secret-not-real"
const FULL_SCOPE = `${GOOGLE_CALENDAR_READONLY_SCOPE} openid email`

// ── Supabase admin クライアントの記録つきスタブ ────────────────────────────
type QueryResult = { data: unknown; error: unknown }

interface RecordedCall {
  table: string
  op: "upsert" | "update"
  payload: unknown
  options?: unknown
}

function makeAdminStub() {
  const calls: RecordedCall[] = []
  const results = new Map<string, QueryResult>()

  const chainFor = (result: QueryResult) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      maybeSingle: async () => result,
      // `.select("id")` のまま await される経路（配列 upsert）用。
      then: <T>(
        onFulfilled?: (value: QueryResult) => T,
        onRejected?: (reason: unknown) => T,
      ) => Promise.resolve(result).then(onFulfilled, onRejected),
    }
    return chain
  }

  const record = (
    table: string,
    op: "upsert" | "update",
    payload: unknown,
    options?: unknown,
  ) => {
    calls.push({ table, op, payload, options })
    return chainFor(results.get(`${table}:${op}`) ?? { data: null, error: null })
  }

  const client = {
    from: (table: string) => ({
      upsert: (payload: unknown, options?: unknown) =>
        record(table, "upsert", payload, options),
      update: (payload: unknown) => record(table, "update", payload),
    }),
  }

  return {
    client,
    calls,
    /** `table:op` に対する戻り値を差し替える。 */
    setResult(key: string, result: QueryResult) {
      results.set(key, result)
    },
    find(table: string, op: "upsert" | "update"): RecordedCall | undefined {
      return calls.find((c) => c.table === table && c.op === op)
    },
  }
}

let admin: ReturnType<typeof makeAdminStub>

// ── Google HTTP のスタブ ──────────────────────────────────────────────────
interface GoogleStubOptions {
  token?: { status?: number; body?: unknown }
  userinfo?: { status?: number; body?: unknown }
  calendarList?: { status?: number; body?: unknown }
  /** 指定 URL で fetch そのものを失敗させる（ネットワーク断の再現）。 */
  networkFailOn?: (url: string) => boolean
}

function stubGoogleFetch(options: GoogleStubOptions = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input)
    if (options.networkFailOn?.(url)) {
      throw new TypeError("fetch failed")
    }
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })

    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return json(options.token?.status ?? 200, options.token?.body ?? {
        access_token: "test-access-token",
        refresh_token: "test-refresh-token",
        expires_in: 3600,
        scope: FULL_SCOPE,
      })
    }
    if (url.startsWith("https://openidconnect.googleapis.com/v1/userinfo")) {
      return json(options.userinfo?.status ?? 200, options.userinfo?.body ?? {
        sub: "google-sub-1",
        email: "someone@example.test",
      })
    }
    if (url.includes("/calendar/v3/users/me/calendarList")) {
      return json(
        options.calendarList?.status ?? 200,
        options.calendarList?.body ?? {
          items: [
            { id: "primary@example.test", summary: "メイン", primary: true },
            { id: "shared@example.test", summary: "共有" },
          ],
        },
      )
    }
    throw new Error(`想定外の fetch: ${url}`)
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

// ── リクエスト組み立て ────────────────────────────────────────────────────
function callbackRequest(
  params: Record<string, string> = {},
  cookieState: string | null = STATE,
): NextRequest {
  const url = new URL(`${APP_ORIGIN}/api/google/oauth/callback`)
  const merged = { state: STATE, code: "test-auth-code", ...params }
  for (const [key, value] of Object.entries(merged)) {
    if (value.length > 0) url.searchParams.set(key, value)
  }
  const headers = new Headers()
  if (cookieState !== null) {
    headers.set("cookie", `${GOOGLE_OAUTH_STATE_COOKIE}=${cookieState}`)
  }
  return new NextRequest(url, { headers })
}

function noticeOf(response: Response): string | null {
  const location = response.headers.get("location")
  expect(location, "Location ヘッダが無い").not.toBeNull()
  return new URL(location as string).searchParams.get("google")
}

function pathOf(response: Response): string {
  return new URL(response.headers.get("location") as string).pathname
}

/** state cookie の破棄（Max-Age=0）が指示されているか。 */
function clearsStateCookie(response: Response): boolean {
  return response.headers
    .getSetCookie()
    .some(
      (c) =>
        c.startsWith(`${GOOGLE_OAUTH_STATE_COOKIE}=`) &&
        /Max-Age=0/i.test(c),
    )
}

beforeEach(() => {
  vi.restoreAllMocks()
  admin = makeAdminStub()
  admin.setResult("google_connections:upsert", {
    data: { id: "connection-1" },
    error: null,
  })
  admin.setResult("google_connections:update", {
    data: { id: "connection-1" },
    error: null,
  })
  admin.setResult("google_calendar_subscriptions:upsert", {
    data: [{ id: "sub-1" }, { id: "sub-2" }],
    error: null,
  })

  createAdminClient.mockReset()
  createAdminClient.mockImplementation(() => admin.client)
  saveGoogleTokens.mockReset()
  saveGoogleTokens.mockResolvedValue(undefined)
  getAuthContext.mockReset()
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: {}, userId: "user-1", householdId: "household-1" },
  })

  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN)
  vi.stubEnv("GOOGLE_CLIENT_ID", FAKE_CLIENT_ID)
  vi.stubEnv("GOOGLE_CLIENT_SECRET", FAKE_CLIENT_SECRET)
  // 経路の判定だけを見たいので、期待どおりの console.error は黙らせる。
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("CSRF: state の照合", () => {
  it("cookie と state が一致すれば通る（対照）", async () => {
    stubGoogleFetch()
    expect(noticeOf(await GET(callbackRequest()))).toBe("connected")
  })

  it("state が cookie と食い違えば ?google=csrf（Google へ問い合わせぬ）", async () => {
    const fetchMock = stubGoogleFetch()
    const response = await GET(callbackRequest({ state: "b".repeat(64) }))
    expect(noticeOf(response)).toBe("csrf")
    // 交換すらしてはならぬ。
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })

  it("cookie が無ければ ?google=csrf", async () => {
    stubGoogleFetch()
    const response = await GET(callbackRequest({}, null))
    expect(noticeOf(response)).toBe("csrf")
  })

  it("cookie も state も無い場合でも素通りせぬ（空 === 空 の穴）", async () => {
    stubGoogleFetch()
    const response = await GET(callbackRequest({ state: "" }, null))
    expect(noticeOf(response)).toBe("csrf")
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })

  it("cookie 空文字 + state 空文字も csrf", async () => {
    stubGoogleFetch()
    const response = await GET(callbackRequest({ state: "" }, ""))
    expect(noticeOf(response)).toBe("csrf")
  })

  it("成功でも失敗でも state cookie を破棄する（replay 防止）", async () => {
    stubGoogleFetch()
    expect(clearsStateCookie(await GET(callbackRequest()))).toBe(true)
    expect(
      clearsStateCookie(await GET(callbackRequest({ state: "z".repeat(64) }))),
    ).toBe(true)
  })
})

describe("同意拒否・Google 側 error", () => {
  it("error=access_denied は ?google=denied", async () => {
    stubGoogleFetch()
    const response = await GET(
      callbackRequest({ error: "access_denied", code: "" }),
    )
    expect(noticeOf(response)).toBe("denied")
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })

  it("その他の error は ?google=error", async () => {
    stubGoogleFetch()
    const response = await GET(
      callbackRequest({ error: "invalid_scope", code: "" }),
    )
    expect(noticeOf(response)).toBe("error")
  })

  it("code も error も無ければ ?google=error", async () => {
    stubGoogleFetch()
    expect(noticeOf(await GET(callbackRequest({ code: "" })))).toBe("error")
  })
})

describe("refresh_token の取り逃し（計画書 §D-5）", () => {
  it("refresh_token が無ければ ?google=no_refresh_token", async () => {
    stubGoogleFetch({
      token: {
        body: {
          access_token: "test-access-token",
          expires_in: 3600,
          scope: FULL_SCOPE,
        },
      },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("no_refresh_token")
  })

  it("refresh_token が無ければトークンを保存せぬ", async () => {
    stubGoogleFetch({
      token: {
        body: { access_token: "test-access-token", scope: FULL_SCOPE },
      },
    })
    await GET(callbackRequest())
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })

  it("refresh_token が無ければ接続行を 1 行も書かぬ（既存接続を壊さぬ）", async () => {
    stubGoogleFetch({
      token: {
        body: { access_token: "test-access-token", scope: FULL_SCOPE },
      },
    })
    await GET(callbackRequest())
    expect(admin.calls).toHaveLength(0)
  })

  it("refresh_token が空文字でも成功扱いにせぬ", async () => {
    stubGoogleFetch({
      token: {
        body: {
          access_token: "test-access-token",
          refresh_token: "",
          scope: FULL_SCOPE,
        },
      },
    })
    const response = await GET(callbackRequest())
    expect(noticeOf(response)).toBe("no_refresh_token")
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })
})

describe("invalid_grant（認可コードの失効）", () => {
  it("?google=invalid_grant で UI へ露出する", async () => {
    stubGoogleFetch({
      token: {
        status: 400,
        body: { error: "invalid_grant", error_description: "Bad Request" },
      },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("invalid_grant")
  })

  it("既存の接続行を needs_reauth へ倒さぬ（動いている接続を止めぬ）", async () => {
    stubGoogleFetch({
      token: { status: 400, body: { error: "invalid_grant" } },
    })
    await GET(callbackRequest())
    // DB は一切触らぬ（計画書 §D-5 との差異はルートの doc comment に明記）。
    expect(admin.calls).toHaveLength(0)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it("ネットワーク断は ?google=network（恒久失敗と混ぜぬ）", async () => {
    stubGoogleFetch({
      networkFailOn: (url) => url.startsWith("https://oauth2.googleapis.com"),
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("network")
  })

  it("その他の失敗は ?google=error", async () => {
    stubGoogleFetch({
      token: { status: 500, body: { error: "internal" } },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("error")
  })
})

describe("スコープ検査", () => {
  it("calendar.readonly が欠ければ ?google=missing_scope", async () => {
    stubGoogleFetch({
      token: {
        body: {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          scope: "openid email",
        },
      },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("missing_scope")
  })

  it("スコープ欠落時は active へ昇格させぬ（needs_reauth のまま）", async () => {
    stubGoogleFetch({
      token: {
        body: {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          scope: "openid email",
        },
      },
    })
    await GET(callbackRequest())
    // トークンは保存する（有効ではある）が、昇格の UPDATE は撃たぬ。
    expect(saveGoogleTokens).toHaveBeenCalledTimes(1)
    expect(admin.find("google_connections", "update")).toBeUndefined()
  })

  it("部分文字列一致で誤判定せぬ", async () => {
    stubGoogleFetch({
      token: {
        body: {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          scope: `${GOOGLE_CALENDAR_READONLY_SCOPE}.metadata openid email`,
        },
      },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("missing_scope")
  })
})

describe("書き込み順序（片方だけ書けた状態を残さぬ）", () => {
  it("接続行は needs_reauth で作り、トークン保存後に active へ昇格する", async () => {
    stubGoogleFetch()
    await GET(callbackRequest())

    const upsert = admin.find("google_connections", "upsert")
    expect(upsert?.payload).toMatchObject({
      household_id: "household-1",
      user_id: "user-1",
      google_account_id: "google-sub-1",
      google_email: "someone@example.test",
      // ここが要点: 最初は必ず needs_reauth。
      connection_status: "needs_reauth",
    })
    expect(upsert?.options).toMatchObject({
      onConflict: "user_id,google_account_id",
    })

    const update = admin.find("google_connections", "update")
    expect(update?.payload).toMatchObject({ connection_status: "active" })

    // 順序: upsert → saveGoogleTokens → update
    expect(admin.calls.map((c) => `${c.table}:${c.op}`)).toEqual([
      "google_connections:upsert",
      "google_connections:update",
      "google_calendar_subscriptions:upsert",
    ])
    expect(saveGoogleTokens).toHaveBeenCalledTimes(1)
  })

  it("トークン保存が失敗したら active へ昇格させぬ（needs_reauth が残る）", async () => {
    stubGoogleFetch()
    saveGoogleTokens.mockRejectedValue(new Error("保存に失敗"))

    const response = await GET(callbackRequest())
    expect(noticeOf(response)).toBe("save_failed")
    expect(admin.find("google_connections", "update")).toBeUndefined()
  })

  it("saveGoogleTokens には 3 点セットの所有スコープを渡す", async () => {
    stubGoogleFetch()
    await GET(callbackRequest())
    expect(saveGoogleTokens).toHaveBeenCalledWith(
      admin.client,
      {
        connectionId: "connection-1",
        householdId: "household-1",
        userId: "user-1",
      },
      expect.objectContaining({
        refreshToken: "test-refresh-token",
        accessToken: "test-access-token",
        scope: FULL_SCOPE,
      }),
    )
  })

  it("接続行の保存が 0 行なら save_failed（無音の no-op にせぬ）", async () => {
    stubGoogleFetch()
    admin.setResult("google_connections:upsert", { data: null, error: null })
    const response = await GET(callbackRequest())
    expect(noticeOf(response)).toBe("save_failed")
    expect(saveGoogleTokens).not.toHaveBeenCalled()
  })

  it("接続行の保存が error なら save_failed", async () => {
    stubGoogleFetch()
    admin.setResult("google_connections:upsert", {
      data: null,
      // Supabase の error は plain object（class Error 非継承）。
      error: { message: "duplicate key", code: "23505", details: null, hint: null },
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("save_failed")
  })

  it("昇格 UPDATE が 0 行なら save_failed", async () => {
    stubGoogleFetch()
    admin.setResult("google_connections:update", { data: null, error: null })
    expect(noticeOf(await GET(callbackRequest()))).toBe("save_failed")
  })
})

describe("カレンダー一覧の取り込み", () => {
  it("接続直後に購読行を投入する（設定カードに一覧が出る前提）", async () => {
    stubGoogleFetch()
    await GET(callbackRequest())

    const upsert = admin.find("google_calendar_subscriptions", "upsert")
    expect(upsert?.payload).toEqual([
      {
        connection_id: "connection-1",
        household_id: "household-1",
        google_calendar_id: "primary@example.test",
        summary: "メイン",
      },
      {
        connection_id: "connection-1",
        household_id: "household-1",
        google_calendar_id: "shared@example.test",
        summary: "共有",
      },
    ])
    expect(upsert?.options).toMatchObject({
      onConflict: "connection_id,google_calendar_id",
    })
  })

  it("is_selected / sync_token を payload に入れぬ（利用者の選択と増分状態を守る）", async () => {
    stubGoogleFetch()
    await GET(callbackRequest())
    const rows = admin.find("google_calendar_subscriptions", "upsert")
      ?.payload as Record<string, unknown>[]
    for (const row of rows) {
      expect(row).not.toHaveProperty("is_selected")
      expect(row).not.toHaveProperty("sync_token")
      expect(row).not.toHaveProperty("sync_lease_until")
    }
  })

  it("一覧の取得に失敗しても接続は巻き戻さぬ（connected_no_calendars）", async () => {
    stubGoogleFetch({ calendarList: { status: 403, body: { error: {} } } })
    const response = await GET(callbackRequest())
    expect(noticeOf(response)).toBe("connected_no_calendars")
    // 昇格は済んでおる = 接続は生きておる。
    expect(
      (admin.find("google_connections", "update")?.payload as Record<string, unknown>)
        ?.connection_status,
    ).toBe("active")
  })

  it("summary は 500 文字で切り詰める（CHECK 制約）", async () => {
    stubGoogleFetch({
      calendarList: {
        body: { items: [{ id: "long@example.test", summary: "あ".repeat(600) }] },
      },
    })
    await GET(callbackRequest())
    const rows = admin.find("google_calendar_subscriptions", "upsert")
      ?.payload as { summary: string }[]
    expect(rows[0].summary).toHaveLength(500)
  })

  it("summary 欠落は null のまま保存する（fail-soft）", async () => {
    stubGoogleFetch({
      calendarList: { body: { items: [{ id: "nosummary@example.test" }] } },
    })
    await GET(callbackRequest())
    const rows = admin.find("google_calendar_subscriptions", "upsert")
      ?.payload as { summary: string | null }[]
    expect(rows[0].summary).toBeNull()
  })
})

describe("設定不備・認可", () => {
  it("未認証ならログインへ戻す", async () => {
    stubGoogleFetch()
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    const response = await GET(callbackRequest())
    expect(pathOf(response)).toBe("/login")
    expect(clearsStateCookie(response)).toBe(true)
  })

  it("GOOGLE_CLIENT_SECRET 未設定なら ?google=not_configured（交換を試みぬ）", async () => {
    const fetchMock = stubGoogleFetch()
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "")
    expect(noticeOf(await GET(callbackRequest()))).toBe("not_configured")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("service role クライアントを作れなければ save_failed", async () => {
    stubGoogleFetch()
    createAdminClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY が未設定です")
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("save_failed")
  })
})

describe("userinfo", () => {
  it("sub / email が欠ければ ?google=error（openid email スコープ不足）", async () => {
    stubGoogleFetch({ userinfo: { body: { email: "someone@example.test" } } })
    const response = await GET(callbackRequest())
    expect(noticeOf(response)).toBe("error")
    expect(admin.calls).toHaveLength(0)
  })

  it("userinfo のネットワーク断は ?google=network", async () => {
    stubGoogleFetch({
      networkFailOn: (url) => url.includes("openidconnect.googleapis.com"),
    })
    expect(noticeOf(await GET(callbackRequest()))).toBe("network")
  })
})
