/**
 * GET /api/version（E1 / N3）: いま答えておる bundle の短い SHA・リリース名・サーバの今の時刻だけを
 * no-store で返す。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { GET, dynamic } from "../route"
import { RELEASE_NAME } from "@/lib/release/release-notes"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("GET /api/version", () => {
  it("埋め込まれた短い SHA・リリース名・サーバの時刻を no-store の JSON で返す", async () => {
    vi.stubEnv("IRORI_BUILD_SHA", "abc1234")
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.123Z"), toFake: ["Date"] })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(await res.json()).toEqual({
      buildId: "abc1234",
      releaseName: RELEASE_NAME,
      serverTime: Date.parse("2026-10-28T03:00:00.123Z"),
    })
  })

  it("時刻は要求ごとのサーバの時計（応答を作った時の値）", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-28T03:00:00.000Z"), toFake: ["Date"] })
    const first = (await (await GET()).json()).serverTime
    vi.setSystemTime(new Date("2026-10-28T03:00:07.000Z"))
    const second = (await (await GET()).json()).serverTime
    expect(second - first).toBe(7_000)
  })

  it("branch 名・環境名・完全な SHA を返さぬ", async () => {
    vi.stubEnv("IRORI_BUILD_SHA", "abc1234")
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/secret-branch")
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc1234def5678abc1234def5678abc1234def56")
    vi.stubEnv("VERCEL_ENV", "preview")
    const text = await (await GET()).text()
    expect(text).not.toContain("secret-branch")
    expect(text).not.toContain("preview")
    expect(text).not.toContain("abc1234def5678")
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["buildId", "releaseName", "serverTime"])
  })

  it("埋め込みが無い build は dev と答える（端末は比べぬ）", async () => {
    vi.stubEnv("IRORI_BUILD_SHA", "")
    expect((await (await GET()).json()).buildId).toBe("dev")
  })

  it("要求ごとに答える（静的化しない）", () => {
    expect(dynamic).toBe("force-dynamic")
  })
})
