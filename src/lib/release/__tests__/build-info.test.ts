/**
 * 版の識別子（E1）。next.config.ts の埋め込み（env.IRORI_BUILD_SHA）と shortBuildId が同じ規則で
 * あること、branch 名などを出さぬこと、空文字（e2e-env.sh）を "dev" に倒すことを固定する。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { clientBuildId, isComparableBuildId, shortBuildId, DEV_BUILD_ID } from "../build-info"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe("shortBuildId", () => {
  it("40 桁の SHA の先頭 7 桁（小文字）", () => {
    expect(shortBuildId("324078F0AC9DE8F28ABDB9D26AC557EEAC11D215")).toBe("324078f")
  })
  it.each([
    [undefined],
    [null],
    [""],
    ["   "],
    ["main"],
    ["feature/foo"],
    ["12345"],
    ["zzzzzzz"],
  ])("比べられぬ値 %j は dev", (value) => {
    expect(shortBuildId(value as string | null | undefined)).toBe(DEV_BUILD_ID)
  })
})

describe("isComparableBuildId", () => {
  it("7 桁の 16 進だけ比べられる。dev・null は比べぬ", () => {
    expect(isComparableBuildId("324078f")).toBe(true)
    expect(isComparableBuildId("dev")).toBe(false)
    expect(isComparableBuildId(null)).toBe(false)
    expect(isComparableBuildId("324078f0")).toBe(false)
  })
})

describe("next.config.ts の env.IRORI_BUILD_SHA（ビルド時の埋め込み）", () => {
  async function configFor(sha: string | undefined) {
    if (sha === undefined) vi.stubEnv("VERCEL_GIT_COMMIT_SHA", undefined as unknown as string)
    else vi.stubEnv("VERCEL_GIT_COMMIT_SHA", sha)
    vi.resetModules()
    const mod = await import("../../../../next.config")
    return mod.default
  }

  it.each([
    ["324078f0ac9de8f28abdb9d26ac557eeac11d215"],
    [""],
    ["not-a-sha"],
    ["ABCDEF0123456789ABCDEF0123456789ABCDEF01"],
  ])("VERCEL_GIT_COMMIT_SHA=%j → shortBuildId と同じ値", async (sha) => {
    const config = await configFor(sha)
    expect(config.env?.IRORI_BUILD_SHA).toBe(shortBuildId(sha))
  })

  it("未設定は dev", async () => {
    const config = await configFor(undefined)
    expect(config.env?.IRORI_BUILD_SHA).toBe("dev")
  })

  it("埋め込むのは短い SHA だけ（branch 名・環境名を env へ足さぬ）", async () => {
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "feature/secret-branch")
    vi.stubEnv("VERCEL_ENV", "preview")
    const config = await configFor("324078f0ac9de8f28abdb9d26ac557eeac11d215")
    expect(Object.keys(config.env ?? {})).toEqual(["IRORI_BUILD_SHA"])
    expect(JSON.stringify(config.env)).not.toContain("secret-branch")
    // 版の自動再読込を起こす deploymentId は設定せぬ（更新は利用者が選ぶ）
    expect(config.deploymentId).toBeUndefined()
  })
})

describe("clientBuildId", () => {
  it("埋め込まれた IRORI_BUILD_SHA を読む（字面の process.env.IRORI_BUILD_SHA）", () => {
    vi.stubEnv("IRORI_BUILD_SHA", "abc1234")
    expect(clientBuildId()).toBe("abc1234")
  })
  it("埋め込まれておらねば dev", () => {
    vi.stubEnv("IRORI_BUILD_SHA", "")
    expect(clientBuildId()).toBe("dev")
  })
})
