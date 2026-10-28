/**
 * useServerClock のサンプルの取り直しと片付け（v8 N3-01 で足した 10 分ごとの取り直し。独立レビュー
 * v8rc2 RC2-CLOCK-REFRESH-UNTESTED）。開いたまま長く計測しても停めた時に古すぎぬサンプルを持ち、
 * 閉じた後は /api/version を取りに行かぬこと。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { SERVER_CLOCK_REFRESH_MS, useServerClock } from "../use-server-clock"

const T0 = Date.parse("2026-10-28T03:00:00.000Z")
let versionCalls = 0

beforeEach(() => {
  versionCalls = 0
  vi.useFakeTimers({ now: T0 })
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname !== "/api/version") throw new Error(`unexpected fetch ${url.pathname}`)
    versionCalls += 1
    return Response.json({ buildId: "dev", releaseName: "test", serverTime: Date.now() })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe("useServerClock の取り直し", () => {
  it("開いた時に 1 回、開いておる間は 10 分ごとに取り直し、閉じた後は時間が経っても画面へ戻っても取らぬ", async () => {
    const { rerender, result } = renderHook(({ active }) => useServerClock(active), {
      initialProps: { active: true },
    })
    await flush()
    expect(versionCalls).toBe(1)
    expect(result.current.serverNowIso()).toEqual(expect.any(String))

    await act(async () => {
      vi.advanceTimersByTime(SERVER_CLOCK_REFRESH_MS)
    })
    await flush()
    expect(versionCalls).toBe(2)

    rerender({ active: false })
    await act(async () => {
      vi.advanceTimersByTime(5 * SERVER_CLOCK_REFRESH_MS)
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush()
    expect(versionCalls).toBe(2)
  })

  it("対照: 初めから閉じておれば取らぬ", async () => {
    renderHook(() => useServerClock(false))
    await act(async () => {
      vi.advanceTimersByTime(3 * SERVER_CLOCK_REFRESH_MS)
    })
    await flush()
    expect(versionCalls).toBe(0)
  })
})
