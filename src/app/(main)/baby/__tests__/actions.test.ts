import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { recordFeeding, recordDiaper, updateLog, deleteLog } from "../actions"
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
