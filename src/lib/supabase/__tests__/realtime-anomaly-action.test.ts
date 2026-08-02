/**
 * Realtime 異常報告 Server Action の検証（I-15）。
 *
 * Server Action は action id を知る者なら誰でも POST できる。認証を課さねば
 * **匿名のログ注入口**になり、本物の異常が偽の行に埋もれて「気づく」が壊れる。
 * ここで固定するのは「記録する条件を狭く保つ」ことじゃ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const getVerifiedUserId = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: {} }),
}))
vi.mock("@/lib/supabase/verified-user", () => ({
  getVerifiedUserId: (...args: unknown[]) => getVerifiedUserId(...args),
}))

import { reportRealtimeAnomaly } from "../realtime-anomaly-action"

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  getVerifiedUserId.mockReset()
  getVerifiedUserId.mockResolvedValue("user-1")
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})

// spy を毎回捨てる。restore を怠ると同じ spy が使い回され、前のテストの呼び出しが
// 積み上がって「呼ばれていない」系の assertion が偽陽性で落ちる（実際に踏んだ）。
afterEach(() => {
  vi.restoreAllMocks()
})

describe("reportRealtimeAnomaly: 異常 3 種のみ記録する", () => {
  it.each(["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"])(
    "%s は userId 付きで記録する",
    async (status) => {
      await reportRealtimeAnomaly("shopping", status, "socket died")

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("realtime-anomaly"),
        expect.objectContaining({
          channel: "shopping",
          status,
          error: "socket died",
          userId: "user-1",
        }),
      )
    },
  )

  it.each(["SUBSCRIBED", "JOINING", "", "closed"])(
    "%s は記録しない（正常系・未知値でログを埋めない）",
    async (status) => {
      await reportRealtimeAnomaly("shopping", status)
      expect(consoleError).not.toHaveBeenCalled()
    },
  )

  it("status のフィルタは認証より先（無駄な往復を作らない）", async () => {
    await reportRealtimeAnomaly("shopping", "SUBSCRIBED")
    expect(getVerifiedUserId).not.toHaveBeenCalled()
  })
})

describe("reportRealtimeAnomaly: 認証を課す（匿名のログ注入を防ぐ）", () => {
  it("未認証は静かに捨てる（記録しない・throw もしない）", async () => {
    getVerifiedUserId.mockResolvedValue(null)

    await expect(
      reportRealtimeAnomaly("shopping", "CLOSED", "x"),
    ).resolves.toBeUndefined()

    expect(consoleError).not.toHaveBeenCalled()
  })

  it("認証を通れば記録する（未認証ドロップが常時発火していないことの陽性対照）", async () => {
    getVerifiedUserId.mockResolvedValue("user-9")
    await reportRealtimeAnomaly("stock", "CLOSED")
    expect(consoleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-9" }),
    )
  })
})

describe("reportRealtimeAnomaly: ログ 1 行の肥大化を防ぐ", () => {
  it("長大な channel / message は切り詰める（他の行を押し流さない）", async () => {
    const huge = "x".repeat(5000)
    await reportRealtimeAnomaly(huge, "CLOSED", huge)

    const payload = consoleError.mock.calls[0][1] as {
      channel: string
      error: string
    }
    expect(payload.channel.length).toBeLessThanOrEqual(201)
    expect(payload.error.length).toBeLessThanOrEqual(201)
    expect(payload.channel.endsWith("…")).toBe(true)
  })

  it("error message 無しでも記録できる（TIMED_OUT は err を伴わない）", async () => {
    await reportRealtimeAnomaly("stock", "TIMED_OUT")
    expect(consoleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "TIMED_OUT", error: undefined }),
    )
  })
})
