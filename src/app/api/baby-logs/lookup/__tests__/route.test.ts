/**
 * 応答不明の保存の照合 GET（2026-10-27 A2）。読みだけ・自世帯だけ・no-store・入力の検証。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext: () => getAuthContext() }))

import { GET } from "../route"

const ID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

function makeSupabase(result: { data: unknown; error: unknown }) {
  const calls: Array<[string, unknown]> = []
  const b = {
    select: () => b,
    eq: (c: string, v: unknown) => {
      calls.push([c, v])
      return b
    },
    in: (c: string, v: unknown) => {
      calls.push([c, v])
      return Promise.resolve(result)
    },
  }
  return { client: { from: vi.fn(() => b) }, calls }
}

function req(query: string) {
  return new Request(`http://localhost/api/baby-logs/lookup?${query}`)
}

beforeEach(() => getAuthContext.mockReset())

describe("GET /api/baby-logs/lookup", () => {
  it("自世帯で絞って読み、no-store の JSON で返す（書かぬ）", async () => {
    const { client, calls } = makeSupabase({ data: [{ id: ID }], error: null })
    getAuthContext.mockResolvedValue({ error: null, reason: null, context: { supabase: client, userId: "u", householdId: "h1" } })
    const res = await GET(req(`id=${ID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(await res.json()).toEqual({ logs: [{ id: ID }] })
    expect(calls).toEqual([
      ["household_id", "h1"],
      ["id", [ID]],
    ])
  })

  it("id が無い・UUID でない・多すぎるなら 400（認証より前に止め、DB に届かぬ）", async () => {
    for (const q of ["", "id=nope", Array.from({ length: 21 }, () => `id=${ID.slice(0, -1)}0`).join("&")]) {
      const res = await GET(req(q))
      expect(res.status).toBe(400)
    }
    expect(getAuthContext).not.toHaveBeenCalled()
  })

  it("未認証は 401、未承認は 403（ログインし直せば直る時だけ 401）", async () => {
    getAuthContext.mockResolvedValueOnce({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect((await GET(req(`id=${ID}`))).status).toBe(401)
    getAuthContext.mockResolvedValueOnce({ error: "承認待ちです", reason: "not-approved", context: null })
    expect((await GET(req(`id=${ID}`))).status).toBe(403)
  })

  it("読みの失敗は 500（見つからぬ = 200 と区別する）", async () => {
    const { client } = makeSupabase({ data: null, error: { code: "XX000", message: "boom" } })
    getAuthContext.mockResolvedValue({ error: null, reason: null, context: { supabase: client, userId: "u", householdId: "h1" } })
    expect((await GET(req(`id=${ID}`))).status).toBe(500)
  })
})
