/**
 * V7 のポーリング（Realtime を使わぬ同期完了検知）の契約テスト。
 *
 * ここが担うのは「削除のみの同期サイクルを画面へ反映する唯一の経路」ゆえ、
 * 回数の上限・前進判定・アンマウント後に呼ばぬことを固定する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act } from "@testing-library/react"
import {
  useGoogleSyncPoll,
  GOOGLE_SYNC_POLL_INTERVAL_MS,
  GOOGLE_SYNC_POLL_ATTEMPTS,
} from "../use-google-sync-poll"

function Probe(props: {
  enabled: boolean
  baseline: string | null
  fetchSignal: () => Promise<{ lastSyncedAt: string | null }>
  onAdvanced: () => void
}) {
  useGoogleSyncPoll(props)
  return null
}

/** タイマーを 1 周期進め、間に挟まる await を解消する。 */
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(GOOGLE_SYNC_POLL_INTERVAL_MS)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("useGoogleSyncPoll", () => {
  it("enabled が false なら一度も叩かぬ", async () => {
    const fetchSignal = vi.fn().mockResolvedValue({ lastSyncedAt: null })
    const onAdvanced = vi.fn()
    render(
      <Probe
        enabled={false}
        baseline={null}
        fetchSignal={fetchSignal}
        onAdvanced={onAdvanced}
      />,
    )
    await tick()
    await tick()
    expect(fetchSignal).not.toHaveBeenCalled()
  })

  it("前進を検知したら onAdvanced を呼び、以降は叩かぬ", async () => {
    const fetchSignal = vi
      .fn()
      .mockResolvedValue({ lastSyncedAt: "2026-08-02T00:00:01.000Z" })
    const onAdvanced = vi.fn()
    render(
      <Probe
        enabled
        baseline="2026-08-02T00:00:00.000Z"
        fetchSignal={fetchSignal}
        onAdvanced={onAdvanced}
      />,
    )
    await tick()
    expect(onAdvanced).toHaveBeenCalledTimes(1)

    await tick()
    await tick()
    expect(fetchSignal).toHaveBeenCalledTimes(1)
  })

  it("前進せねば上限回数で打ち切る（開きっぱなしのタブが叩き続けぬ）", async () => {
    const fetchSignal = vi
      .fn()
      .mockResolvedValue({ lastSyncedAt: "2026-08-02T00:00:00.000Z" })
    const onAdvanced = vi.fn()
    render(
      <Probe
        enabled
        baseline="2026-08-02T00:00:00.000Z"
        fetchSignal={fetchSignal}
        onAdvanced={onAdvanced}
      />,
    )
    for (let i = 0; i < GOOGLE_SYNC_POLL_ATTEMPTS + 3; i += 1) await tick()

    expect(fetchSignal).toHaveBeenCalledTimes(GOOGLE_SYNC_POLL_ATTEMPTS)
    expect(onAdvanced).not.toHaveBeenCalled()
  })

  it("失敗しても投げず、次の試行へ進む（握り潰さずログは出す）", async () => {
    const fetchSignal = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ lastSyncedAt: "2026-08-02T00:00:01.000Z" })
    const onAdvanced = vi.fn()
    render(
      <Probe
        enabled
        baseline="2026-08-02T00:00:00.000Z"
        fetchSignal={fetchSignal}
        onAdvanced={onAdvanced}
      />,
    )
    await tick()
    expect(console.error).toHaveBeenCalled()
    await tick()
    expect(onAdvanced).toHaveBeenCalledTimes(1)
  })

  it("アンマウント後は onAdvanced を呼ばぬ", async () => {
    let resolve: (v: { lastSyncedAt: string | null }) => void = () => {}
    const fetchSignal = vi.fn(
      () =>
        new Promise<{ lastSyncedAt: string | null }>((r) => {
          resolve = r
        }),
    )
    const onAdvanced = vi.fn()
    const view = render(
      <Probe
        enabled
        baseline={null}
        fetchSignal={fetchSignal}
        onAdvanced={onAdvanced}
      />,
    )
    await tick()
    expect(fetchSignal).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      resolve({ lastSyncedAt: "2026-08-02T00:00:01.000Z" })
    })
    expect(onAdvanced).not.toHaveBeenCalled()
  })
})
