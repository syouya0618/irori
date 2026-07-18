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
  startSleep,
  recordTemperature,
  recordGrowth,
  recordMemo,
} from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

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
