/**
 * 配信 cron ハンドラの **認可** の契約テスト（B-3）。
 *
 * ## ⚠ このテストが証明せぬこと（V8 の核心）
 * ここは Route Handler を **直接 import** しておるゆえ `src/proxy.ts` を通らぬ。
 * proxy が `/api/cron/` を承認ゲートから外していなければ、pg_net の
 * **cookie 無しの GET** は `/login` へ 307 され**ハンドラに到達せぬ**のに、
 * このファイルは緑のままじゃ。proxy を含めた検証は
 * `e2e/cron-routes-auth.spec.ts`（実ビルド + `next start`）が持つ。
 *
 * ここが担うのは残りの半分 —「secret 無しで開かぬこと」と
 * **「`CRON_SECRET` では開かぬこと」**（鍵の分離）じゃ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const deliverDueNotifications = vi.fn(async () => ({
  ranAt: "2026-08-15T00:50:00.000Z",
  scheduled: 2,
  sent: 2,
  skipped: 0,
  failed: 0,
}))

// service role クライアントと配信本体は認可の関心事ではない。
// **認可を通した後にしか呼ばれぬこと**を assert するために差し替える。
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}) as never,
}))
vi.mock("@/lib/notifications/deliver", () => ({
  deliverDueNotifications: (...args: unknown[]) =>
    deliverDueNotifications(...(args as [])),
}))

const { GET } = await import("../route")

const SECRET = "notify-secret-value"

function request(authorization?: string): Request {
  return new Request("http://127.0.0.1:3000/api/cron/notify", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  })
}

beforeEach(() => {
  deliverDueNotifications.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("GET /api/cron/notify", () => {
  it("NOTIFY_CRON_SECRET が未設定なら **401**（fail-closed）", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", "")
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(401)
    // 認可を通す前に service role の配信を撃ってはならぬ。
    expect(deliverDueNotifications).not.toHaveBeenCalled()
  })

  it("**`CRON_SECRET` では開かぬ**（鍵の分離。pg_net は Authorization を DB に溜める）", async () => {
    // google-sync の値だけが在る状態。ここで通ってしまうと、片方の漏洩が
    // 両方の cron を開けることになる。
    vi.stubEnv("NOTIFY_CRON_SECRET", "")
    vi.stubEnv("CRON_SECRET", SECRET)
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(401)
    expect(deliverDueNotifications).not.toHaveBeenCalled()
  })

  it("Authorization ヘッダが無ければ 401", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", SECRET)
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(deliverDueNotifications).not.toHaveBeenCalled()
  })

  it("secret が違えば 401", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", SECRET)
    const res = await GET(request(`Bearer ${"x".repeat(SECRET.length)}`))
    expect(res.status).toBe(401)
    expect(deliverDueNotifications).not.toHaveBeenCalled()
  })

  it("**長さが違う** secret でも throw せず 401（timingSafeEqual の RangeError 対策）", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", SECRET)
    const res = await GET(request("Bearer short"))
    expect(res.status).toBe(401)
  })

  it("正しい secret なら 200 で配信を走らせ、件数を返す", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", SECRET)
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(deliverDueNotifications).toHaveBeenCalledTimes(1)
    await expect(res.json()).resolves.toMatchObject({
      scheduled: 2,
      sent: 2,
      skipped: 0,
      failed: 0,
    })
  })

  it("末尾改行が混じった secret でも通る（env は trim する）", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", `${SECRET}\n`)
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
  })

  it("配信が落ちたら 500 を返し、握り潰さぬ", async () => {
    vi.stubEnv("NOTIFY_CRON_SECRET", SECRET)
    deliverDueNotifications.mockRejectedValueOnce(new Error("boom"))
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalled()
  })
})
