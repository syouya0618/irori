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
  upsertBabyDiary,
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

describe("updateLog の授乳時間（durationSec）更新", () => {
  function makeCapturedUpdate() {
    const single = vi
      .fn()
      .mockResolvedValue({ data: { id: "log-1" }, error: null })
    const select = vi.fn(() => ({ single }))
    const eq2 = vi.fn(() => ({ select }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const update = vi.fn((_payload: Record<string, unknown>) => ({ eq: eq1 }))
    // durationSec 単独編集は既存行を pre-fetch する（sides を持つ行の合計だけ編集を
    // fail-loud で拒むため）。ここでは sides 無しの行を返す = 従来経路が通る前提。
    const maybeSingle = vi.fn().mockResolvedValue({
      data: { log_type: "feeding", ended_at: null, breast_left_sec: null },
      error: null,
    })
    const fetchEq2 = vi.fn(() => ({ maybeSingle }))
    const fetchEq1 = vi.fn(() => ({ eq: fetchEq2 }))
    const fetchSelect = vi.fn(() => ({ eq: fetchEq1 }))
    const from = vi.fn(() => ({ update, select: fetchSelect }))
    return { client: { from }, update }
  }

  it("durationSec 指定で duration_sec と導出 duration_min の両列を1経路で書く", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLog("log-1", { durationSec: 330 })
    expect(result.error).toBeNull()
    // 330 秒 → duration_min = round(330/60) = 6（recordFeeding の導出と同一規約）
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_sec: 330, duration_min: 6 }),
    )
  })

  it("durationSec: null は両列を null に戻す（時間なしの授乳へ）", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLog("log-1", { durationSec: null })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_sec: null, duration_min: null }),
    )
  })

  it("durationSec 未指定なら duration 列に触れない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLog("log-1", { memo: "hi" })
    expect(result.error).toBeNull()
    const payload = update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty("duration_sec")
    expect(payload).not.toHaveProperty("duration_min")
  })

  it.each([[0], [10801], [5.5], [NaN]])(
    "範囲外・非整数の durationSec(%s) は auth 前に拒否し DB へ到達しない",
    async (bad) => {
      const { client } = makeCapturedUpdate()
      setContext(client)
      const result = await updateLog("log-1", { durationSec: bad as number })
      expect(result.error).toBe("授乳時間は1秒〜180分の範囲で指定してください")
      expect(client.from).not.toHaveBeenCalled()
    },
  )
})

describe("recordFeeding の breast_left_count / breast_right_count（母乳サイクル）", () => {
  it("breast + 妥当な counts は insert payload に breast_left_count/right_count を書く", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "log-1" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 3,
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ breast_left_count: 2, breast_right_count: 3 }),
    )
  })

  it("breast + 片側 0 の妥当な counts は 0 のまま insert する（falsy 判定で null 化しない）", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "log-3" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 0,
      breastRightCount: 3,
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ breast_left_count: 0, breast_right_count: 3 }),
    )
  })

  it.each([
    [undefined, undefined],
    [null, null],
    [21, 0],
    [0, 21],
    [0, 0],
    [1.5, 0],
    [-1, 5],
  ])(
    "breast + 不正な counts(%s, %s) は日本語エラーで DB 到達しない",
    async (left, right) => {
      const { client, insert } = makeSupabase({
        data: { id: "x" },
        error: null,
      })
      setContext(client)
      const result = await recordFeeding({
        feedingType: "breast",
        breastLeftCount: left as number | null | undefined,
        breastRightCount: right as number | null | undefined,
      })
      expect(result.error).toBe(
        "左右の回数は0〜20回・合計1回以上で指定してください",
      )
      expect(result.id).toBeNull()
      expect(insert).not.toHaveBeenCalled()
    },
  )

  it("breast + 境界値 counts(20, 20) は受理される（緑側の回帰固定・pgTAP baby_breast_counts (7) と対）", async () => {
    // 拒否側（21）だけだと `> 20` を `>= 20` へ壊す変異が全緑で生き残る
    // （ミューテーション実測 M01）。境界の通る側を固定して両側から挟む。
    const { client, insert } = makeSupabase({ data: { id: "b20" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 20,
      breastRightCount: 20,
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ breast_left_count: 20, breast_right_count: 20 }),
    )
  })

  it("breast 以外で counts を指定するとエラー（DB CHECK chk_breast_counts_only_breast のミラー）", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "x" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      breastLeftCount: 1,
      breastRightCount: 0,
    })
    expect(result.error).toBe("この授乳タイプには左右の回数を指定できません")
    expect(result.id).toBeNull()
    expect(insert).not.toHaveBeenCalled()
  })

  it("breast 以外で counts 未指定は素通りし breast_left_count/right_count は null で insert する", async () => {
    const { client, insert } = makeSupabase({
      data: { id: "log-2" },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle" })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_count: null,
        breast_right_count: null,
      }),
    )
  })
})

describe("updateLog の breast_left_count / breast_right_count（母乳サイクル）", () => {
  /** update().eq().eq().select("id").single() を模した fake client（payload 検査用）。 */
  function makeCapturedUpdate() {
    const single = vi
      .fn()
      .mockResolvedValue({ data: { id: "log-1" }, error: null })
    const select = vi.fn(() => ({ single }))
    const eq2 = vi.fn(() => ({ select }))
    const eq1 = vi.fn(() => ({ eq: eq2 }))
    const update = vi.fn((_payload: Record<string, unknown>) => ({ eq: eq1 }))
    const from = vi.fn(() => ({ update }))
    return { client: { from }, update }
  }

  it("feedingType='breast' + 妥当な counts は payload に書く", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 4,
      breastRightCount: 5,
    })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        feeding_type: "breast",
        breast_left_count: 4,
        breast_right_count: 5,
      }),
    )
  })

  it("feedingType='breast' + 片側 0 の妥当な counts は 0 のまま payload に書く（falsy 判定で null 化しない）", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 0,
      breastRightCount: 1,
    })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        feeding_type: "breast",
        breast_left_count: 0,
        breast_right_count: 1,
      }),
    )
  })

  it("feedingType を bottle へ変更すると breast_left_count/right_count を null 化する（送り忘れ/消し忘れ防御）", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", { feedingType: "bottle" })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        feeding_type: "bottle",
        breast_left_count: null,
        breast_right_count: null,
      }),
    )
  })

  it("feedingType='breast' + counts 未指定はエラーで update しない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", { feedingType: "breast" })
    expect(result.error).toBe(
      "左右の回数は0〜20回・合計1回以上で指定してください",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("feedingType='breast' + 範囲外の counts はエラーで update しない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 21,
      breastRightCount: 0,
    })
    expect(result.error).toBe(
      "左右の回数は0〜20回・合計1回以上で指定してください",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("feedingType 未指定なら breast_left_count/right_count 列に触れない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" })
    expect(result.error).toBeNull()
    const payload = update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty("breast_left_count")
    expect(payload).not.toHaveProperty("breast_right_count")
  })
})

describe("upsertBabyDiary（育児日記・1日1本）", () => {
  function makeUpsertSupabase(upsertResult: { data: unknown; error: unknown }) {
    const single = vi.fn().mockResolvedValue(upsertResult)
    const select = vi.fn(() => ({ single }))
    const upsert = vi.fn<
      (
        row: Record<string, unknown>,
        opts: Record<string, unknown>,
      ) => { select: typeof select }
    >(() => ({ select }))
    const from = vi.fn(() => ({ upsert }))
    return { client: { from }, upsert }
  }

  function makeDiaryDeleteSupabase(deleteResult: { error: unknown }) {
    const eqDate = vi.fn().mockResolvedValue(deleteResult)
    const eqHousehold = vi.fn(() => ({ eq: eqDate }))
    const del = vi.fn(() => ({ eq: eqHousehold }))
    const from = vi.fn(() => ({ delete: del }))
    return { client: { from }, del }
  }

  it("本文ありは onConflict(household_id,diary_date) の upsert 1経路で保存し、trim 済み本文を書く", async () => {
    const { client, upsert } = makeUpsertSupabase({
      data: {
        id: "d1",
        diary_date: "2026-07-20",
        content: "今日は散歩",
        updated_at: "2026-07-22T12:00:00Z",
      },
      error: null,
    })
    setContext(client)

    const result = await upsertBabyDiary("2026-07-20", "  今日は散歩  ")
    expect(result.error).toBeNull()
    expect(result.diary?.content).toBe("今日は散歩")
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        household_id: HOUSEHOLD,
        diary_date: "2026-07-20",
        content: "今日は散歩",
      }),
      { onConflict: "household_id,diary_date" },
    )
  })

  it("空保存はその日の行を DELETE し diary: null を返す（冪等）", async () => {
    const { client, del } = makeDiaryDeleteSupabase({ error: null })
    setContext(client)

    const result = await upsertBabyDiary("2026-07-20", "   \n  ")
    expect(result.error).toBeNull()
    expect(result.diary).toBeNull()
    expect(del).toHaveBeenCalled()
  })

  it("不正な日付形式・未来日・上限超過は auth 前に拒否する", async () => {
    const from = vi.fn()
    setContext({ from })

    expect((await upsertBabyDiary("2026/07/20", "x")).error).toBe(
      "日付の形式が不正です",
    )
    expect((await upsertBabyDiary("2999-01-01", "x")).error).toBe(
      "未来の日記は書けません",
    )
    expect((await upsertBabyDiary("2026-07-20", "あ".repeat(5001))).error).toContain(
      "5000文字以内",
    )
    expect(from).not.toHaveBeenCalled()
  })

  it("upsert の DB error は握り潰さず日本語エラーを返す", async () => {
    const { client } = makeUpsertSupabase({
      data: null,
      error: { message: "boom", code: "23514" },
    })
    setContext(client)

    const result = await upsertBabyDiary("2026-07-20", "本文")
    expect(result.error).toBe("日記の保存に失敗しました。もう一度お試しください。")
    expect(result.diary).toBeNull()
  })
})

describe("recordFeeding: 左右別の授乳時間（breastLeftSec / breastRightSec）", () => {
  it("sides + counts で記録すると duration_sec/min はサーバが左右の和から導出する（単一の書込経路）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "s-1" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 1,
      breastLeftSec: 450,
      breastRightSec: 300,
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_sec: 450,
        breast_right_sec: 300,
        duration_sec: 750,
        duration_min: 13,
      }),
    )
  })

  it("片側 0 秒は有効値として保持される（falsy で null に化けない）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "s-2" }, error: null })
    setContext(client)
    await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 0,
      breastLeftSec: 300,
      breastRightSec: 0,
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_sec: 300,
        breast_right_sec: 0,
        duration_sec: 300,
      }),
    )
  })

  it("sides と durationSec の同時指定はエラー（合計の二重真値源を禁止）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 0,
      breastLeftSec: 300,
      breastRightSec: 0,
      durationSec: 300,
    })
    expect(result.error).toBe(
      "左右の時間があるときは合計時間は指定できません（合計は自動計算されます）",
    )
    expect(insert).not.toHaveBeenCalled()
  })

  it.each([
    [300, undefined],
    [undefined, 300],
    [10801, 0],
    [0, 10801],
    [0, 0],
    [1.5, 300],
    [-1, 300],
  ])(
    "不正な sides(%s, %s) は日本語エラーで DB 到達しない",
    async (left, right) => {
      const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
      setContext(client)
      const result = await recordFeeding({
        feedingType: "breast",
        breastLeftCount: 1,
        breastRightCount: 1,
        breastLeftSec: left as number | undefined,
        breastRightSec: right as number | undefined,
      })
      expect(result.error).toBe(
        "左右の授乳時間は両方・各0〜180分・合計1秒以上で指定してください",
      )
      expect(insert).not.toHaveBeenCalled()
    },
  )

  it("breast 以外で sides を指定するとエラー（chk_breast_side_sec_only_breast のミラー）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "bottle",
      breastLeftSec: 300,
      breastRightSec: 0,
    })
    expect(result.error).toBe("この授乳タイプには左右の時間を指定できません")
    expect(insert).not.toHaveBeenCalled()
  })
})

describe("updateLog: 左右別の授乳時間", () => {
  it("sides pair + feedingType='breast' で合計をサーバ導出して書き込む", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 1,
      breastLeftSec: 400,
      breastRightSec: 200,
    })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_sec: 400,
        breast_right_sec: 200,
        duration_sec: 600,
        duration_min: 10,
      }),
    )
  })

  it("sides と durationSec の同時指定はエラー", async () => {
    const { client } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 0,
      breastLeftSec: 300,
      breastRightSec: 0,
      durationSec: 300,
    })
    expect(result.error).toBe(
      "左右の時間があるときは合計時間は指定できません（合計は自動計算されます）",
    )
  })

  it("feedingType が breast 以外なのに sides が来たらエラー（無音 no-op を作らない）", async () => {
    const { client } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "bottle",
      breastLeftSec: 300,
      breastRightSec: 0,
    })
    expect(result.error).toBe("この授乳タイプには左右の時間を指定できません")
  })

  it("sides を持つ行への durationSec 単独編集は fail-loud で拒否（無音で sides を捨てない）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      {
        data: { log_type: "feeding", ended_at: null, breast_left_sec: 300 },
        error: null,
      },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      durationSec: 500,
    })
    expect(result.error).toBe(
      "左右の時間を持つ記録は、左右それぞれの時間で編集してください",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("sides を持たない行への durationSec 単独編集は従来どおり通る", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      {
        data: { log_type: "feeding", ended_at: null, breast_left_sec: null },
        error: null,
      },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      durationSec: 500,
    })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_sec: 500, duration_min: 8 }),
    )
  })

  it("breast 以外へ種別変更すると sides も強制 null 化される（counts と同じ規約）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLog("log-1", { feedingType: "bottle" })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_sec: null,
        breast_right_sec: null,
      }),
    )
  })
})
