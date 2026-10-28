/**
 * 端末とサーバの版の比べ方（E1）。取得失敗・期限切れ・ログインの門・dev を「最新です」と言わぬこと、
 * 古い画面から新しいサーバへの action 失敗を見分けることを固定する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error"
import {
  checkServerVersion,
  compareBuilds,
  getStaleClientDetected,
  noteServerActionFailure,
  resetStaleClientForTest,
  subscribeStaleClient,
  VERSION_ENDPOINT,
} from "../app-version"

function jsonRes(body: unknown, init: { status?: number; type?: string; contentType?: string } = {}) {
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    type: init.type ?? "basic",
    headers: new Headers({ "content-type": init.contentType ?? "application/json" }),
    json: async () => body,
  }
}

beforeEach(() => {
  resetStaleClientForTest()
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("compareBuilds", () => {
  it("同じ SHA は same、違えば different", () => {
    expect(compareBuilds("abc1234", "abc1234").state).toBe("same")
    expect(compareBuilds("abc1234", "def5678").state).toBe("different")
  })
  it("どちらかが dev・null なら unknown（dev 同士を同じ版と言わぬ）", () => {
    expect(compareBuilds("dev", "dev")).toEqual({ state: "unknown", reason: "dev-build" })
    expect(compareBuilds("abc1234", "dev").state).toBe("unknown")
    expect(compareBuilds("dev", "abc1234").state).toBe("unknown")
    expect(compareBuilds("abc1234", null).state).toBe("unknown")
  })
})

describe("checkServerVersion", () => {
  it("no-store・redirect manual・signal 付きで /api/version を叩き、違う版を different と言う", async () => {
    const fetchMock = vi.fn(async () => jsonRes({ buildId: "def5678", releaseName: "x" }))
    vi.stubGlobal("fetch", fetchMock)
    const result = await checkServerVersion({ client: "abc1234" })
    expect(result).toEqual({
      state: "different",
      clientBuildId: "abc1234",
      serverBuildId: "def5678",
      reason: null,
    })
    expect(fetchMock).toHaveBeenCalledWith(
      VERSION_ENDPOINT,
      expect.objectContaining({
        cache: "no-store",
        redirect: "manual",
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("同じ版は same", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ buildId: "abc1234" })))
    expect((await checkServerVersion({ client: "abc1234" })).state).toBe("same")
  })

  it.each([
    ["opaqueredirect（ログインの門）", jsonRes(null, { status: 0, type: "opaqueredirect" }), "gate"],
    ["307", jsonRes(null, { status: 307 }), "gate"],
    ["401", jsonRes(null, { status: 401 }), "gate"],
    ["503", jsonRes(null, { status: 503 }), "http"],
    ["HTML", jsonRes("<html>", { contentType: "text/html" }), "malformed"],
    ["形の違う JSON", jsonRes({ buildId: "main" }), "malformed"],
  ])("%s は unknown（最新とは言わぬ）", async (_label, res, reason) => {
    vi.stubGlobal("fetch", vi.fn(async () => res))
    const result = await checkServerVersion({ client: "abc1234" })
    expect(result.state).toBe("unknown")
    expect(result.reason).toBe(reason)
  })

  it("通信断は unknown（network）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    expect(await checkServerVersion({ client: "abc1234" })).toMatchObject({
      state: "unknown",
      reason: "network",
    })
  })

  it("期限（timeoutMs）を過ぎたら取り消して unknown（timeout）。待ち続けぬ", async () => {
    vi.useFakeTimers()
    let seenSignal: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            seenSignal = init.signal ?? undefined
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            )
          }),
      ),
    )
    const pending = checkServerVersion({ client: "abc1234", timeoutMs: 8000 })
    await vi.advanceTimersByTimeAsync(8000)
    const result = await pending
    expect(seenSignal?.aborted).toBe(true)
    expect(result).toMatchObject({ state: "unknown", reason: "timeout" })
  })

  it("呼び出し側の取消し（アンマウント）は aborted（期限切れとは分ける）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            )
          }),
      ),
    )
    const outer = new AbortController()
    const pending = checkServerVersion({ client: "abc1234", signal: outer.signal })
    outer.abort()
    expect(await pending).toMatchObject({ state: "unknown", reason: "aborted" })
  })

  it("端末が dev の build なら、サーバが答えても unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonRes({ buildId: "abc1234" })))
    expect(await checkServerVersion({ client: "dev" })).toMatchObject({
      state: "unknown",
      reason: "dev-build",
      serverBuildId: "abc1234",
    })
  })
})

describe("noteServerActionFailure（古い画面から新しいサーバへ）", () => {
  it("action が見つからぬ失敗だけを版の食い違いとして知らせる", () => {
    const listener = vi.fn()
    subscribeStaleClient(listener)
    expect(noteServerActionFailure(new TypeError("Failed to fetch"))).toBe(false)
    expect(getStaleClientDetected()).toBe(false)
    expect(listener).not.toHaveBeenCalled()

    expect(
      noteServerActionFailure(new UnrecognizedActionError('Server Action "abc" was not found on the server.')),
    ).toBe(true)
    expect(getStaleClientDetected()).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("対照: 名前だけ似せた Error は版の食い違いと見なさぬ（公式の判定に従う）", () => {
    const fake = new Error("Server Action not found")
    fake.name = "UnrecognizedActionError"
    expect(noteServerActionFailure(fake)).toBe(false)
  })
})
