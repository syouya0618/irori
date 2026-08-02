import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"

/**
 * Server Action は実体を呼ばない（`@/lib/supabase/server` → next/headers を
 * 引きずり込むため）。ここで見たいのは「いつ・何回呼ぶか」の契約じゃ。
 */
const reportRealtimeAnomaly = vi.fn()
vi.mock("../realtime-anomaly-action", () => ({
  reportRealtimeAnomaly: (...args: unknown[]) => reportRealtimeAnomaly(...args),
}))

import { logRealtimeStatus, logRealtimeEvent } from "../realtime-log"

beforeEach(() => {
  reportRealtimeAnomaly.mockReset()
  reportRealtimeAnomaly.mockResolvedValue(undefined)
})

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

/**
 * Realtime 異常のサーバ報告（I-15）。
 *
 * ## なぜ要るか
 * Realtime のログを出す 5 ファイルはすべて `"use client"` ゆえ、`console.*` は
 * 利用者のブラウザにしか出ぬ。#92（間欠的に配信が届かない）が特定できておらぬのは
 * 「症状が起きた端末のコンソールを誰も見ていない」という構造的理由じゃ。
 *
 * ## ここで固定する契約
 *   1. 異常 3 種のみ送る（正常な SUBSCRIBED でログを埋めない）
 *   2. **1 セッション 1 回**（再接続のフラップで数十回飛ばさない）
 *   3. 報告が失敗しても**本来のログ機能を壊さない**
 *
 * 各テストは `vi.resetModules()` でモジュールを作り直し、モジュールスコープの
 * ゲート（anomalyReported）を初期状態に戻してから走らせる。
 */
describe("logRealtimeStatus: 異常のみサーバへ 1 回だけ報告する", () => {
  async function freshModule() {
    vi.resetModules()
    reportRealtimeAnomaly.mockReset()
    reportRealtimeAnomaly.mockResolvedValue(undefined)
    return await import("../realtime-log")
  }

  it.each(["CLOSED", "CHANNEL_ERROR", "TIMED_OUT"])(
    "%s は報告する（channel / status / error message を渡す）",
    async (status) => {
      vi.spyOn(console, "warn").mockImplementation(() => {})
      vi.spyOn(console, "error").mockImplementation(() => {})
      const mod = await freshModule()

      mod.logRealtimeStatus("shopping", status, new Error("socket died"))

      expect(reportRealtimeAnomaly).toHaveBeenCalledTimes(1)
      expect(reportRealtimeAnomaly).toHaveBeenCalledWith(
        "shopping",
        status,
        "socket died",
      )
    },
  )

  it("SUBSCRIBED は報告しない（正常系でログを埋めない）", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {})
    const mod = await freshModule()

    mod.logRealtimeStatus("meals", "SUBSCRIBED")

    expect(reportRealtimeAnomaly).not.toHaveBeenCalled()
  })

  it("1 セッション 1 回に絞る（再接続フラップで連投しない）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const mod = await freshModule()

    // 同一 channel の再発、別 channel の異常、いずれも 2 回目以降は送らない
    mod.logRealtimeStatus("stock", "CLOSED")
    mod.logRealtimeStatus("stock", "CLOSED")
    mod.logRealtimeStatus("baby_logs", "CHANNEL_ERROR")

    expect(reportRealtimeAnomaly).toHaveBeenCalledTimes(1)
  })

  it("報告を絞っても**ローカルのログは毎回出る**（診断情報を失わない）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const mod = await freshModule()

    mod.logRealtimeStatus("stock", "CLOSED")
    mod.logRealtimeStatus("stock", "CLOSED")

    // console.warn は 2 回とも出る（サーバ報告のゲートに巻き込まれていない）
    const closedWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes("closed"),
    )
    expect(closedWarns).toHaveLength(2)
  })
})

describe("logRealtimeStatus: 報告が失敗しても本来の機能を壊さない", () => {
  async function freshModule() {
    vi.resetModules()
    reportRealtimeAnomaly.mockReset()
    return await import("../realtime-log")
  }

  it("Server Action が reject しても呼び出し元へ例外を漏らさない（圏外・500）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    reportRealtimeAnomaly.mockRejectedValue(new Error("network down"))
    const mod = await freshModule()
    reportRealtimeAnomaly.mockRejectedValue(new Error("network down"))

    expect(() => mod.logRealtimeStatus("stock", "CLOSED")).not.toThrow()

    // `.catch()` が付いており unhandled rejection にならない
    await Promise.resolve()
    await Promise.resolve()
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes("anomaly report failed")),
    ).toBe(true)
  })

  it("Server Action が同期 throw しても購読ログは通常どおり出る", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    reportRealtimeAnomaly.mockImplementation(() => {
      throw new Error("action reference broken")
    })
    const mod = await freshModule()
    reportRealtimeAnomaly.mockImplementation(() => {
      throw new Error("action reference broken")
    })

    expect(() => mod.logRealtimeStatus("stock", "CLOSED")).not.toThrow()

    // 本来の CLOSED ログは出ている（報告の失敗に巻き込まれていない）
    expect(warn.mock.calls.some((c) => String(c[0]).includes("closed"))).toBe(true)
  })

  it("同期 throw しても再送ループにならない（ゲートは送信前に立てる）", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    reportRealtimeAnomaly.mockImplementation(() => {
      throw new Error("action reference broken")
    })
    const mod = await freshModule()
    reportRealtimeAnomaly.mockImplementation(() => {
      throw new Error("action reference broken")
    })

    mod.logRealtimeStatus("stock", "CLOSED")
    mod.logRealtimeStatus("stock", "CLOSED")

    expect(reportRealtimeAnomaly).toHaveBeenCalledTimes(1)
  })
})
