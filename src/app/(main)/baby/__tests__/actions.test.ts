import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import {
  recordFeeding,
  recordDiaper,
  updateLog,
  deleteLog,
  startSleep,
  recordTemperature,
  recordGrowth,
  recordMemo,
} from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  FUTURE_LOG_TIME_ERROR,
  SLEEP_START_AFTER_END_ERROR,
} from "@/lib/domain/baby-log-time"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

/** insert().select("id").single() を模した fake client。 */
function makeSupabase(insertResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(insertResult)
  const select = vi.fn(() => ({ single }))
  const insert = vi.fn(() => ({ select }))
  const from = vi.fn(() => ({ insert }))
  return { client: { from }, insert }
}

/** update().eq().eq().select("id").single() を模した fake client。 */
function makeUpdateSupabase(updateResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(updateResult)
  const select = vi.fn(() => ({ single }))
  const eqHousehold = vi.fn(() => ({ select }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const update = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ update }))
  return { client: { from } }
}

/**
 * updateLog の loggedAt 指定経路を模した fake client。
 * 先に log_type/ended_at を pre-fetch（select().eq().eq().maybeSingle()）してから
 * update().eq().eq().select("id").single() する。両方 supabase.from("baby_logs") 起点。
 */
function makeUpdateSupabaseWithFetch(
  fetchResult: { data: unknown; error: unknown },
  updateResult: { data: unknown; error: unknown },
) {
  // pre-fetch: from().select("log_type, ended_at").eq().eq().maybeSingle()
  const maybeSingle = vi.fn().mockResolvedValue(fetchResult)
  const fetchEq2 = vi.fn(() => ({ maybeSingle }))
  const fetchEq1 = vi.fn(() => ({ eq: fetchEq2 }))
  const fetchSelect = vi.fn(() => ({ eq: fetchEq1 }))

  // update: from().update().eq().eq().select("id").single()
  const single = vi.fn().mockResolvedValue(updateResult)
  const updSelect = vi.fn(() => ({ single }))
  const updEq2 = vi.fn(() => ({ select: updSelect }))
  const updEq1 = vi.fn(() => ({ eq: updEq2 }))
  const update = vi.fn(() => ({ eq: updEq1 }))

  const from = vi.fn(() => ({ select: fetchSelect, update }))
  return { client: { from }, update, fetchSelect }
}

/** delete().eq().eq().select("id") を模した fake client（.single() なし、data は配列）。 */
function makeDeleteSupabase(deleteResult: { data: unknown; error: unknown }) {
  const select = vi.fn().mockResolvedValue(deleteResult)
  const eqHousehold = vi.fn(() => ({ select }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const del = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ delete: del }))
  return { client: { from } }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

beforeEach(() => {
  revalidatePath.mockClear()
  getAuthContext.mockReset()
  mockedLog.mockClear()
})

describe("recordFeeding / recordDiaper が作成した log id を返す（Undo 用）", () => {
  it("recordFeeding: 成功時に作成した log の id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "log-99" }, error: null })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle" })
    expect(result).toEqual({ error: null, id: "log-99" })
  })

  it("recordFeeding: 失敗時は error を返し id は null、握り潰さず logSupabaseError を呼ぶ", async () => {
    const { client } = makeSupabase({
      data: null,
      error: { message: "boom", code: "XX000" },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle" })
    expect(result.error).toBeTruthy()
    expect(result.id).toBeNull()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })

  it("recordDiaper: 成功時に作成した log の id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "log-77" }, error: null })
    setContext(client)
    const result = await recordDiaper({ diaperType: "pee" })
    expect(result).toEqual({ error: null, id: "log-77" })
  })
})

describe("startSleep / record{Temperature,Growth,Memo} が作成 log id を返す（B-03 楽観 append 用）", () => {
  it("startSleep: 成功時に作成した睡眠 log の id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "sleep-1" }, error: null })
    setContext(client)
    const result = await startSleep()
    expect(result).toEqual({ error: null, id: "sleep-1" })
  })

  it("startSleep: 23505（既に睡眠中）は正常系ゆえ id: null + ログ抑止", async () => {
    const { client } = makeSupabase({
      data: null,
      error: { code: "23505", message: "duplicate key" },
    })
    setContext(client)
    const result = await startSleep()
    expect(result.error).toBe("既に睡眠中のセッションがあります。")
    expect(result.id).toBeNull()
    // 23505 は UNIQUE 制約による正常系ゆえ構造化ログは出さない
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("startSleep: 23505 以外の DB エラーは id: null + logSupabaseError", async () => {
    const { client } = makeSupabase({
      data: null,
      error: { code: "XX000", message: "boom" },
    })
    setContext(client)
    const result = await startSleep()
    expect(result.error).toBe("睡眠の記録に失敗しました。")
    expect(result.id).toBeNull()
    expect(mockedLog).toHaveBeenCalled()
  })

  it("recordTemperature: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "temp-1" }, error: null })
    setContext(client)
    const result = await recordTemperature({ temperature: 36.7 })
    expect(result).toEqual({ error: null, id: "temp-1" })
  })

  it("recordGrowth: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "growth-1" }, error: null })
    setContext(client)
    const result = await recordGrowth({ weightG: 5200 })
    expect(result).toEqual({ error: null, id: "growth-1" })
  })

  it("recordMemo: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "memo-1" }, error: null })
    setContext(client)
    const result = await recordMemo({ memo: "hello" })
    expect(result).toEqual({ error: null, id: "memo-1" })
  })

  it("recordMemo: 空文字は id: null で早期 return（DB 到達なし）", async () => {
    const { client } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordMemo({ memo: "" })
    expect(result.error).toBeTruthy()
    expect(result.id).toBeNull()
  })
})

describe("record* の loggedAt（記録時刻の指定・タスクB）", () => {
  it("recordFeeding: loggedAt 指定時は logged_at を insert する", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "log-1" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      loggedAt: "2026-07-09T11:00:00.000Z",
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ logged_at: "2026-07-09T11:00:00.000Z" }),
    )
  })

  it("recordFeeding: loggedAt 未指定時は logged_at を insert しない（DB now 既定に委ねる）", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "log-2" },
      error: null,
    })
    setContext(client)
    await recordFeeding({ feedingType: "bottle" })
    const payload = (insert.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ])[0]
    expect("logged_at" in payload).toBe(false)
  })

  it("recordFeeding: 未来の loggedAt は DB 到達前に拒否（+5 分許容超）", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "x" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      loggedAt: "2099-01-01T00:00:00.000Z",
    })
    expect(result.error).toBe(FUTURE_LOG_TIME_ERROR)
    expect(result.id).toBeNull()
    expect(insert).not.toHaveBeenCalled()
  })

  it("recordMemo: loggedAt 指定時は logged_at を insert する", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "memo-1" },
      error: null,
    })
    setContext(client)
    const result = await recordMemo({
      memo: "hi",
      loggedAt: "2026-07-09T11:00:00.000Z",
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ logged_at: "2026-07-09T11:00:00.000Z" }),
    )
  })
})

describe("updateLog の記録時刻検証（タスクB）", () => {
  it("未来の loggedAt は DB 到達前に拒否（update 未実行）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: null, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      loggedAt: "2099-01-01T00:00:00.000Z",
    })
    expect(result.error).toBe(FUTURE_LOG_TIME_ERROR)
    expect(update).not.toHaveBeenCalled()
  })

  it("sleep で logged_at > ended_at は拒否し update しない（負 overlap 防止）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      {
        data: { log_type: "sleep", ended_at: "2026-07-09T11:00:00Z" },
        error: null,
      },
      { data: { id: "sleep-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("sleep-1", {
      loggedAt: "2026-07-09T12:00:00.000Z",
    })
    expect(result.error).toBe(SLEEP_START_AFTER_END_ERROR)
    expect(update).not.toHaveBeenCalled()
  })

  it("sleep で logged_at ≤ ended_at は update まで進む", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      {
        data: { log_type: "sleep", ended_at: "2026-07-09T12:00:00Z" },
        error: null,
      },
      { data: { id: "sleep-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("sleep-1", {
      loggedAt: "2026-07-09T10:00:00.000Z",
    })
    expect(result).toEqual({ error: null })
    expect(update).toHaveBeenCalled()
  })

  it("非 sleep（feeding）は order 検証をスキップして update まで進む", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: { log_type: "feeding", ended_at: null }, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      loggedAt: "2026-07-09T10:00:00.000Z",
      amountMl: 80,
    })
    expect(result).toEqual({ error: null })
    expect(update).toHaveBeenCalled()
  })

  it("pre-fetch が 0 行（別世帯/不在）なら update せず失敗を返す", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("missing", {
      loggedAt: "2026-07-09T10:00:00.000Z",
    })
    expect(result.error).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })
})

describe("updateLog が 0 行更新を成功と偽らない", () => {
  it("成功時（1 行更新）は error: null を返す", async () => {
    const { client } = makeUpdateSupabase({ data: { id: "log-1" }, error: null })
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" })
    expect(result).toEqual({ error: null })
  })

  it("0 行マッチ（PGRST116）は success を偽らず error を返し、ノイズログを出さない", async () => {
    const { client } = makeUpdateSupabase({
      data: null,
      error: { code: "PGRST116", message: "no rows" },
    })
    setContext(client)
    const result = await updateLog("missing-id", { memo: "hi" })
    expect(result.error).toBeTruthy()
    // PGRST116 は正常な失敗ゆえ logSupabaseError では出さない。
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("PGRST116 以外の DB エラーは logSupabaseError で構造化ログに残す", async () => {
    const { client } = makeUpdateSupabase({
      data: null,
      error: { code: "XX000", message: "boom" },
    })
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" })
    expect(result.error).toBeTruthy()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })
})

describe("deleteLog が 0 行削除を成功と偽らない", () => {
  it("成功時（1 行削除）は error: null を返す", async () => {
    const { client } = makeDeleteSupabase({ data: [{ id: "log-1" }], error: null })
    setContext(client)
    const result = await deleteLog("log-1")
    expect(result).toEqual({ error: null })
  })

  it("0 行マッチ（既に削除済み/別世帯）は success を偽らず error を返し、ノイズログを出さない", async () => {
    const { client } = makeDeleteSupabase({ data: [], error: null })
    setContext(client)
    const result = await deleteLog("missing-id")
    expect(result.error).toBeTruthy()
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("DB エラーは logSupabaseError で構造化ログに残す", async () => {
    const { client } = makeDeleteSupabase({
      data: null,
      error: { code: "XX000", message: "boom" },
    })
    setContext(client)
    const result = await deleteLog("log-1")
    expect(result.error).toBeTruthy()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })
})
