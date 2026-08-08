/**
 * 購読の再登録エンドポイント（B-4）の契約。
 *
 * ## ⚠️ このテストが証明せぬこと
 * ここは Route Handler を**直接 import** しておるゆえ `src/proxy.ts` を通らぬ。
 * proxy はこのパスを `isPublicRoute` に**入れておらぬ**（＝ 認証が要る）のが正しく、
 * セッション切れなら `/login` へ 307 が返る。その 307 を fetch が追って
 * 「HTML の 200」を成功と誤読せぬことは、呼び出し側の
 * `isResubscribeAccepted`（`sw-logic.test.ts` / `push-reconcile.test.ts`）が持つ。
 *
 * ここが担うのは「認可・検証・冪等な書込」の側じゃ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const rpc = vi.fn()
const getAuthContext = vi.fn()

vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

const { POST } = await import("../route")

const USER_ID = "22222222-2222-2222-2222-222222222222"
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/new-token"
const OLD_ENDPOINT = "https://fcm.googleapis.com/fcm/send/old-token"
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

function authed() {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { rpc: (...a: unknown[]) => rpc(...a) }, userId: USER_ID },
  })
}

function request(body: unknown, raw?: string): Request {
  return new Request("http://127.0.0.1:3000/api/push/resubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: ENDPOINT,
    p256dh: "key-p256dh",
    auth: "key-auth",
    userAgent: UA,
    ...overrides,
  }
}

beforeEach(() => {
  rpc.mockReset()
  rpc.mockResolvedValue({ data: null, error: null })
  getAuthContext.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("POST /api/push/resubscribe — 認可", () => {
  it("未認証なら 401（**書込には一切触れぬ**）", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    const res = await POST(request(validBody()))
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("未承認なら 401（承認ゲートは DB 側の RPC と二重に効く）", async () => {
    getAuthContext.mockResolvedValue({
      error: "承認待ちです",
      reason: "not-approved",
      context: null,
    })
    const res = await POST(request(validBody()))
    expect(res.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("POST /api/push/resubscribe — 入力の検証", () => {
  beforeEach(authed)

  it("JSON でない body は 400（throw せぬ）", async () => {
    const res = await POST(request(null, "not json at all"))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(["endpoint", "p256dh", "auth"])("%s が欠ければ 400", async (key) => {
    const res = await POST(request(validBody({ [key]: undefined })))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    "http://fcm.googleapis.com/fcm/send/x",
    "https://169.254.169.254/latest/meta-data",
    "https://evil.example.com/relay",
    "not-a-url",
  ])("allowlist 外の endpoint (%s) は 400（SSRF / open relay 防御）", async (endpoint) => {
    const res = await POST(request(validBody({ endpoint })))
    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("DB の CHECK と同じ長さ上限で弾く", async () => {
    const long = `https://fcm.googleapis.com/${"a".repeat(2100)}`
    expect((await POST(request(validBody({ endpoint: long })))).status).toBe(400)
    expect(
      (await POST(request(validBody({ p256dh: "k".repeat(256) })))).status,
    ).toBe(400)
    expect((await POST(request(validBody({ auth: "a".repeat(256) })))).status).toBe(400)
  })
})

describe("POST /api/push/resubscribe — 登録", () => {
  beforeEach(authed)

  it("成功したら **JSON の { ok: true }** を返す（呼び出し側の唯一の弁別子）", async () => {
    const res = await POST(request(validBody()))
    expect(res.status).toBe(200)
    // ⚠️ `res.ok` は proxy の 307 → HTML 200 でも true になる。
    // ゆえに content-type と本文の形の両方が契約じゃ。
    expect(res.headers.get("content-type")).toContain("application/json")
    await expect(res.json()).resolves.toEqual({ ok: true })
  })

  it("書込は upsert_push_subscription 1 本のみ（冪等ゆえ何度呼んでも増えぬ）", async () => {
    await POST(request(validBody()))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("upsert_push_subscription", {
      p_endpoint: ENDPOINT,
      p_p256dh: "key-p256dh",
      p_auth: "key-auth",
      // ⚠️ ここが null に落ちると、既存行の端末名が上書きで潰れて
      // 設定カードが全部「不明な端末」になる。
      p_user_agent: "iPhone/iPad の Safari",
    })
  })

  it("RPC が失敗したら 500（握り潰さぬ）", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "boom", code: "P0001" },
    })
    const res = await POST(request(validBody()))
    expect(res.status).toBe(500)
  })
})

/**
 * ★ **proxy との契約**（`runbook-contract.test.ts` と同じ型の機械縛り）。
 *
 * このパスを `isPublicRoute` へ足すと、cookie が読まれぬまま
 * `upsert_push_subscription` が `auth.uid() = NULL` で 28000 に落ち、
 * **再登録が恒久的に失敗する**。しかもハンドラを直接 import する上のテストは
 * 全て緑のままじゃ（V8 の型）。ゆえに proxy の実体を読んで縛る。
 */
describe("proxy の承認ゲートを迂回しておらぬこと", () => {
  const proxySource = readFileSync(
    path.join(path.resolve(__dirname, "../../../../../.."), "src/proxy.ts"),
    "utf8",
  )

  /** `isPublicRoute` の式（`const isPublicRoute =` 〜 次の `const` の手前）。 */
  const publicRouteExpr = (() => {
    const start = proxySource.indexOf("const isPublicRoute =")
    expect(start).toBeGreaterThanOrEqual(0)
    const end = proxySource.indexOf("const isInviteRoute", start)
    expect(end).toBeGreaterThan(start)
    return proxySource.slice(start, end)
  })()

  it("走査が空回りしておらぬ（式の切り出しに失敗しての偽緑を潰す）", () => {
    // 既知の例外が 1 つ在ることを先に固定する。0 件なら下の assert は
    // 「何も無い」で通ってしまい、検出器として死ぬ。
    expect(publicRouteExpr).toContain("/api/cron/")
  })

  it("public 扱いの `/api/` prefix は `/api/cron/` **ただ 1 つ**", () => {
    const apiPrefixes = [...publicRouteExpr.matchAll(/"(\/api\/[^"]*)"/g)].map(
      (m) => m[1],
    )
    // cron は pg_net が cookie を持たぬゆえの例外（ハンドラ側が
    // NOTIFY_CRON_SECRET を fail-closed に検証する）。ここは違う。
    expect(apiPrefixes).toEqual(["/api/cron/"])
  })

  it("proxy は `/api/push` を一切知らぬ（＝ 認証と承認が効いておる）", () => {
    expect(proxySource).not.toContain("/api/push")
  })
})

describe("POST /api/push/resubscribe — 旧 endpoint の掃除", () => {
  beforeEach(authed)

  it("旧 endpoint が違えば掃除する（**登録の後**に呼ぶ）", async () => {
    await POST(request(validBody({ oldEndpoint: OLD_ENDPOINT })))
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "upsert_push_subscription",
      "delete_my_push_subscription",
    ])
    expect(rpc.mock.calls[1][1]).toEqual({ p_endpoint: OLD_ENDPOINT })
  })

  it("旧 endpoint が新しいものと同じなら掃除せぬ（自分を消してしまう）", async () => {
    await POST(request(validBody({ oldEndpoint: ENDPOINT })))
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc.mock.calls[0][0]).toBe("upsert_push_subscription")
  })

  it("旧 endpoint が allowlist 外なら掃除だけ諦め、登録は成立させる", async () => {
    const res = await POST(
      request(validBody({ oldEndpoint: "https://evil.example.com/relay" })),
    )
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("掃除に失敗しても 200（新しい端末には既に届く。残った行は 410 で消える）", async () => {
    rpc
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "nope" } })
    const res = await POST(request(validBody({ oldEndpoint: OLD_ENDPOINT })))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true })
  })
})
