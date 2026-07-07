import { describe, it, expect, vi, afterEach } from "vitest"
import { logRealtimeStatus, logRealtimeEvent } from "../realtime-log"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("logRealtimeStatus", () => {
  it("SUBSCRIBED は console.info に channel/status を出す", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    logRealtimeStatus("meals-abc", "SUBSCRIBED")
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][1]).toMatchObject({
      channel: "meals-abc",
      status: "SUBSCRIBED",
    })
  })

  it("CLOSED は console.warn に落とす（セッション途中の socket 死の信号）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    logRealtimeStatus("stock", "CLOSED")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][1]).toMatchObject({ status: "CLOSED" })
  })

  it("CHANNEL_ERROR / TIMED_OUT は console.error に error.message を含める", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    logRealtimeStatus("baby_logs", "CHANNEL_ERROR", new Error("boom"))
    logRealtimeStatus("baby_logs", "TIMED_OUT")
    expect(error).toHaveBeenCalledTimes(2)
    expect(error.mock.calls[0][1]).toMatchObject({
      status: "CHANNEL_ERROR",
      error: "boom",
    })
  })
})

describe("logRealtimeEvent", () => {
  it("table / eventType のみ出し、row 本体(PII)は出さない", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {})
    // 実際の RealtimePostgresChangesPayload は new/old に行データ(PII)を持つ
    const payload = {
      table: "shopping_items",
      eventType: "INSERT",
      new: { id: "1", name: "秘密のメモ" },
    }
    logRealtimeEvent("shopping", payload)
    expect(info).toHaveBeenCalledTimes(1)
    expect(info.mock.calls[0][1]).toEqual({
      channel: "shopping",
      table: "shopping_items",
      eventType: "INSERT",
    })
    expect(JSON.stringify(info.mock.calls[0][1])).not.toContain("秘密")
  })
})
