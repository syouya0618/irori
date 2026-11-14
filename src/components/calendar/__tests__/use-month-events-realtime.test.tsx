/**
 * カレンダーの Realtime 購読の片付け（`useMonthEvents`）。realtime-js は `removeChannel` の中で
 * subscribe の callback を `CLOSED` で呼ぶ。画面を離れただけの終了を「購読の異常」としてサーバへ
 * 報告せず（1 タブ 1 回の報告枠を使い切らせず）、片付けの前に届いた CLOSED は従来どおり報告する。
 */
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const realtime = vi.hoisted(() => ({
  callbacks: [] as ((status: string, err?: Error) => void)[],
  report: vi.fn(),
}))

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    const channel = {
      on: () => channel,
      subscribe: (callback: (status: string, err?: Error) => void) => {
        realtime.callbacks.push(callback)
        return channel
      },
    }
    return {
      channel: () => channel,
      // realtime-js と同じく、片付けの中で subscribe の callback を CLOSED で呼ぶ
      removeChannel: () => {
        for (const callback of realtime.callbacks.splice(0)) callback("CLOSED")
        return Promise.resolve("ok")
      },
    }
  },
}))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("@/lib/supabase/realtime-anomaly-action", () => ({
  reportRealtimeAnomaly: (...args: unknown[]) => {
    realtime.report(...args)
    return Promise.resolve()
  },
}))

import { useMonthEvents } from "../use-month-events"

function mount() {
  return renderHook(() =>
    useMonthEvents({
      initialEvents: [],
      householdId: "h1",
      initialView: { monthFirst: "2026-11-01", selectedDate: "2026-11-12" },
    }),
  )
}

describe("useMonthEvents: Realtime の購読の終わり方", () => {
  it("画面を離れた（unmount の片付け）時の CLOSED は、異常として報告せぬ", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const view = mount()
    expect(realtime.callbacks).toHaveLength(1)
    view.unmount()
    expect(realtime.report).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it("片付けの前に届いた CLOSED（サーバ側の終了）は報告し、その後の片付けの CLOSED は重ねて報告せぬ", () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const view = mount()
    act(() => realtime.callbacks[0]("CLOSED"))
    expect(realtime.report).toHaveBeenCalledTimes(1)
    expect(realtime.report).toHaveBeenCalledWith("calendar-h1", "CLOSED", undefined)
    view.unmount()
    expect(realtime.report).toHaveBeenCalledTimes(1)
  })
})
