/**
 * cron ハンドラの **認可** の契約テスト。
 *
 * ## ⚠ このテストが証明せぬこと（V8 の核心）
 * ここは Route Handler を **直接 import** しておるゆえ `src/proxy.ts` を通らぬ。
 * proxy が `/api/cron/` を承認ゲートから外していなければ、本番の Vercel Cron
 * （cookie 無しの GET）は `/login` へ 307 され**ハンドラに到達せぬ**のに、
 * このファイルは緑のままじゃ。まさに「テスト緑・本番 100% 不発」の形。
 *
 * proxy を通ることの検証は dev サーバへの実 fetch で行う
 * （`fetch(url, { redirect: "manual" })` で 307 が返らぬこと）。
 * 恒久的な機械検査は `e2e/google-cron-proxy.spec.ts`（実ビルド + `next start`）。
 *
 * ここが担うのは残りの半分 —「secret 無しで開かぬこと」だけじゃ。
 * 片方だけでは cron が無認証で開く。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const syncAllHouseholds = vi.fn(async () => ({ households: 2, summaries: [] }))

// service role クライアントと同期本体は認可の関心事ではない。
// **認可を通した後にしか呼ばれぬこと**を assert するために差し替える。
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({}) as never,
}))
vi.mock("@/lib/google/sync", () => ({
  syncAllHouseholds: (...args: unknown[]) => syncAllHouseholds(...(args as [])),
}))

const { GET } = await import("../route")

const SECRET = "cron-secret-value"

function request(authorization?: string): Request {
  return new Request("http://127.0.0.1:3000/api/cron/google-sync", {
    method: "GET",
    headers: authorization ? { authorization } : {},
  })
}

beforeEach(() => {
  syncAllHouseholds.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("GET /api/cron/google-sync", () => {
  it("CRON_SECRET が未設定なら **401**（fail-closed）", async () => {
    vi.stubEnv("CRON_SECRET", "")
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(401)
    // 認可を通す前に service role の同期を撃ってはならぬ。
    expect(syncAllHouseholds).not.toHaveBeenCalled()
  })

  it("Authorization ヘッダが無ければ 401", async () => {
    vi.stubEnv("CRON_SECRET", SECRET)
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(syncAllHouseholds).not.toHaveBeenCalled()
  })

  it("secret が違えば 401", async () => {
    vi.stubEnv("CRON_SECRET", SECRET)
    const res = await GET(request(`Bearer ${"x".repeat(SECRET.length)}`))
    expect(res.status).toBe(401)
    expect(syncAllHouseholds).not.toHaveBeenCalled()
  })

  it("**長さが違う** secret でも throw せず 401（timingSafeEqual の RangeError 対策）", async () => {
    vi.stubEnv("CRON_SECRET", SECRET)
    const res = await GET(request("Bearer short"))
    expect(res.status).toBe(401)
  })

  it("正しい secret なら 200 で同期を走らせる", async () => {
    vi.stubEnv("CRON_SECRET", SECRET)
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(syncAllHouseholds).toHaveBeenCalledTimes(1)
    await expect(res.json()).resolves.toMatchObject({ ok: true, households: 2 })
  })

  it("末尾改行が混じった CRON_SECRET でも通る（env は trim する）", async () => {
    vi.stubEnv("CRON_SECRET", `${SECRET}\n`)
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
  })

  it("同期が落ちたら 500 を返し、握り潰さぬ", async () => {
    vi.stubEnv("CRON_SECRET", SECRET)
    syncAllHouseholds.mockRejectedValueOnce(new Error("boom"))
    const res = await GET(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(console.error).toHaveBeenCalled()
  })
})
