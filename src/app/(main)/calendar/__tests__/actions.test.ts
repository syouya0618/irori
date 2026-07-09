/**
 * calendar/actions の単体テスト(DB なし・meals actions.test.ts の idiom)。
 * 検証・所有権/source ガード(0 行→編集/削除不可)・silent fail 防止を回帰対象にする。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
const logSupabaseError = vi.fn()
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "../actions"

const HOUSEHOLD = "house-1"

/** create: insert().select().single() / update・delete: ...eq().eq().eq().select() */
function makeSupabase(opts: {
  single?: { data: unknown; error: unknown }
  mutate?: { data: unknown; error: unknown }
}) {
  const single = vi.fn().mockResolvedValue(opts.single ?? { data: { id: "ev-1" }, error: null })
  const selectTerminal = {
    single,
    then: (f: (v: unknown) => unknown) =>
      Promise.resolve(opts.mutate ?? { data: [{ id: "ev-1" }], error: null }).then(f),
  }
  const eqChain: Record<string, unknown> = {
    eq: () => eqChain,
    select: () => selectTerminal,
  }
  const insert = vi.fn(() => ({ select: () => selectTerminal }))
  const from = vi.fn(() => ({
    insert,
    update: () => ({ eq: () => eqChain }),
    delete: () => ({ eq: () => eqChain }),
  }))
  return { client: { from }, from, insert }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

const baseInput = {
  title: "検診",
  isAllDay: true,
  startDate: "2026-07-09",
  endDate: "2026-07-09",
}

beforeEach(() => vi.clearAllMocks())

describe("createCalendarEvent", () => {
  it("検証エラー(空 title)で insert を叩かず error を返す", async () => {
    const sb = makeSupabase({})
    setContext(sb.client)
    const r = await createCalendarEvent({ ...baseInput, title: "  " })
    expect(r.error).toBe("タイトルを入力してください")
    expect(sb.insert).not.toHaveBeenCalled()
  })

  it("正常系で eventId を返す", async () => {
    const sb = makeSupabase({ single: { data: { id: "ev-9" }, error: null } })
    setContext(sb.client)
    const r = await createCalendarEvent(baseInput)
    expect(r.error).toBeNull()
    expect((r as { eventId: string }).eventId).toBe("ev-9")
    expect(revalidatePath).toHaveBeenCalledWith("/calendar")
  })

  it("DB error で logSupabaseError を呼びエラーを返す", async () => {
    const sb = makeSupabase({
      single: { data: null, error: { message: "boom", code: "500", details: "", hint: "" } },
    })
    setContext(sb.client)
    const r = await createCalendarEvent(baseInput)
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
  })
})

describe("updateCalendarEvent", () => {
  it("0 行(同期予定/権限なし)で「編集できません」を返す", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    const r = await updateCalendarEvent({ ...baseInput, id: "ev-1" })
    expect(r.error).toMatch(/編集できません/)
  })

  it("1 行更新で成功", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "ev-1" }], error: null } })
    setContext(sb.client)
    const r = await updateCalendarEvent({ ...baseInput, id: "ev-1" })
    expect(r.error).toBeNull()
    expect(revalidatePath).toHaveBeenCalledWith("/calendar")
  })
})

describe("deleteCalendarEvent", () => {
  it("0 行で「削除できません」を返す", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toMatch(/削除できません/)
  })

  it("1 行削除で成功", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "ev-1" }], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toBeNull()
  })
})
