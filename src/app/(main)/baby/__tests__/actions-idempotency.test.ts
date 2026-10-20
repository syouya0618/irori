/**
 * 記録系 Server Action の冪等 id（P2-08）。
 *
 * 「保存は DB で成立したが応答だけが失われ、利用者が再試行して同じ記録が二重に増える」を
 * 止めるため、クライアントは操作の意図ごとに 1 回だけ UUID を作って送り、サーバはそれを
 * 主キーにして INSERT する。主キー重複（23505）は同じ世帯に行が在り**内容も同じ**なら
 * 「既に記録済み」（replayed）として同じ id を成功で返す。内容が違う（直して押し直した）なら
 * fail-loud（画面と DB が無言で食い違わぬ）。別世帯の id（推測・流用）なら重複とは扱わず
 * 失敗にする。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { recordFeeding, recordDiaper, recordMemo, recordTemperature, recordGrowth } from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"
const CLIENT_ID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const DUPLICATE = { message: "duplicate key value violates unique constraint", code: "23505" }

/**
 * insert().select("id").single() と、重複時の読み直し
 * select("id").eq("id").eq("household_id").maybeSingle() の両方を持つ fake client。
 */
function makeSupabase(opts: {
  insert: { data: unknown; error: unknown }
  lookup?: { data: unknown; error: unknown }
}) {
  const single = vi.fn().mockResolvedValue(opts.insert)
  const insertSelect = vi.fn(() => ({ single }))
  const insert = vi.fn(() => ({ select: insertSelect }))
  const maybeSingle = vi.fn().mockResolvedValue(opts.lookup ?? { data: null, error: null })
  const eqHousehold = vi.fn(() => ({ maybeSingle }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const lookupSelect = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ insert, select: lookupSelect }))
  return { client: { from }, insert, lookupSelect, eqId, eqHousehold }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

function insertedRow(insert: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return (insert.mock.calls[0] as unknown as [Record<string, unknown>])[0]
}

/** recordFeeding({ feedingType: "bottle" }) が INSERT する本文と同じ内容の既存行 */
const STORED_BOTTLE_ROW = {
  id: CLIENT_ID,
  log_type: "feeding",
  feeding_type: "bottle",
  amount_ml: null,
  duration_sec: null,
  duration_min: null,
  breast_left_count: null,
  breast_right_count: null,
  breast_left_sec: null,
  breast_right_sec: null,
  breast_start_side: null,
  memo: null,
  logged_at: "2026-10-19T03:00:00+00:00",
  logged_by: "user-1",
}

beforeEach(() => {
  revalidatePath.mockClear()
  getAuthContext.mockReset()
  mockedLog.mockClear()
})

describe("record* の冪等 id（P2-08）", () => {
  it("clientId を渡すと主キー id として INSERT する", async () => {
    const { client, insert } = makeSupabase({ insert: { data: { id: CLIENT_ID }, error: null } })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", clientId: CLIENT_ID })
    expect(result).toEqual({ error: null, id: CLIENT_ID })
    expect(insertedRow(insert)).toMatchObject({ id: CLIENT_ID, household_id: HOUSEHOLD, logged_by: "user-1" })
  })

  it("clientId を渡さねば id を送らず、DB の既定に委ねる（従来どおり）", async () => {
    const { client, insert } = makeSupabase({ insert: { data: { id: "db-1" }, error: null } })
    setContext(client)
    await recordFeeding({ feedingType: "bottle" })
    expect("id" in insertedRow(insert)).toBe(false)
  })

  it("UUID でない clientId は DB に届く前に拒む", async () => {
    const { client, insert } = makeSupabase({ insert: { data: { id: "x" }, error: null } })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", clientId: "not-a-uuid" })
    expect(result.error).toBeTruthy()
    expect(result.id).toBeNull()
    expect(insert).not.toHaveBeenCalled()
  })

  it("主キー重複（23505）で同じ世帯に同じ内容の行が在れば、二重記録せず既存の id を replayed として返す", async () => {
    const { client, insert, lookupSelect, eqId, eqHousehold } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: STORED_BOTTLE_ROW, error: null },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", clientId: CLIENT_ID })
    expect(result).toEqual({ error: null, id: CLIENT_ID, replayed: true })
    expect(insert).toHaveBeenCalledTimes(1)
    // 読み直しは id と世帯の両方で絞り、内容を比べるため列一式を読む
    expect(lookupSelect).toHaveBeenCalledWith(expect.stringContaining("feeding_type"))
    expect(eqId).toHaveBeenCalledWith("id", CLIENT_ID)
    expect(eqHousehold).toHaveBeenCalledWith("household_id", HOUSEHOLD)
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("同じ冪等 id でも内容が違えば（直して押し直した）成功と偽らず、更新を促す失敗にする", async () => {
    const { client } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: { ...STORED_BOTTLE_ROW, amount_ml: 120 }, error: null },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", amountMl: 140, clientId: CLIENT_ID })
    expect(result.id).toBeNull()
    expect(result.error).toContain("別の内容で記録済み")
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("内容の比較: logged_at は表記（Z / +00:00）が違っても同じ時刻なら一致、送っていない列は比べぬ", async () => {
    const { client } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: {
        data: { ...STORED_BOTTLE_ROW, logged_at: "2026-10-19T03:00:00+00:00", created_at: "x" },
        error: null,
      },
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      loggedAt: "2026-10-19T03:00:00.000Z",
      clientId: CLIENT_ID,
    })
    expect(result).toEqual({ error: null, id: CLIENT_ID, replayed: true })
  })

  it("対照: 送った logged_at が既存行と違う時刻なら不一致", async () => {
    const { client } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: STORED_BOTTLE_ROW, error: null },
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      loggedAt: "2026-10-19T04:00:00.000Z",
      clientId: CLIENT_ID,
    })
    expect(result.id).toBeNull()
    expect(result.error).toContain("別の内容で記録済み")
  })

  it("主キー重複でも同じ世帯に行が無ければ（別世帯の id）失敗にし、ログへ残す", async () => {
    const { client } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: null, error: null },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", clientId: CLIENT_ID })
    expect(result.error).toBeTruthy()
    expect(result.id).toBeNull()
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "23505" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })

  it("重複の読み直し自体が失敗したら成功と偽らず失敗にする", async () => {
    const { client } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: null, error: { message: "boom", code: "XX000" } },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", clientId: CLIENT_ID })
    expect(result.error).toBeTruthy()
    expect(result.id).toBeNull()
  })

  it("clientId 無しの 23505 は再試行とみなさず通常の失敗（対照）", async () => {
    const { client, lookupSelect } = makeSupabase({
      insert: { data: null, error: DUPLICATE },
      lookup: { data: STORED_BOTTLE_ROW, error: null },
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle" })
    expect(result.error).toBeTruthy()
    expect(lookupSelect).not.toHaveBeenCalled()
  })

  it("おむつ・メモ・体温・成長も同じ経路で id を主キーにする", async () => {
    for (const run of [
      () => recordDiaper({ diaperType: "pee", clientId: CLIENT_ID }),
      () => recordMemo({ memo: "hi", clientId: CLIENT_ID }),
      () => recordTemperature({ temperature: 36.8, clientId: CLIENT_ID }),
      () => recordGrowth({ weightG: 5200, clientId: CLIENT_ID }),
    ]) {
      const { client, insert } = makeSupabase({ insert: { data: { id: CLIENT_ID }, error: null } })
      setContext(client)
      const result = await run()
      expect(result).toEqual({ error: null, id: CLIENT_ID })
      expect(insertedRow(insert).id).toBe(CLIENT_ID)
    }
  })
})
