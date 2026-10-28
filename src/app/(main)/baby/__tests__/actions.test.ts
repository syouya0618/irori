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
  recordTemperature,
  recordGrowth,
  recordMemo,
  upsertBabyDiary,
} from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { FUTURE_LOG_TIME_ERROR } from "@/lib/domain/baby-log-time"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

/** insert().select(cols).single() を模した fake client。 */
function makeSupabase(insertResult: { data: unknown; error: unknown }) {
  const single = vi.fn().mockResolvedValue(insertResult)
  const select = vi.fn((_cols: string) => ({ single }))
  const insert = vi.fn(() => ({ select }))
  const from = vi.fn(() => ({ insert }))
  return { client: { from }, insert, insertSelect: select }
}

/** 編集を始めた時点の版（PostgREST の表記・マイクロ秒つき）と、保存で進んだ後の版。 */
const V0 = "2026-10-01T00:00:00.123456+00:00"
const V1 = "2026-10-01T00:05:00.654321+00:00"

/** 既存の updateLog の検査は「開いた時点の版」を送る正常な呼び出しとして書く。 */
function updateLogV0(logId: string, updates: Parameters<typeof updateLog>[1]) {
  return updateLog(logId, updates, V0)
}

/**
 * updateLog の fake client（どれも supabase.from("baby_logs") 起点）。
 * - 更新: update(payload).eq()….select(cols) を await → 配列の行。
 * - 既存行の pre-fetch（"breast_left_sec"）と、版が合わなかった時の読み直し
 *   （BABY_LOG_COLUMNS）: select(cols).eq()….maybeSingle()。
 *
 * **`.eq()` は経路ごとに記録する。** 更新の絞り込み（id・世帯・版の三点）と読み直しの
 * 絞り込みが混ざると、「版で絞った」の assert が読み直しの eq で偽って通る。
 * 更新の終端は `.single()` も持つ — 旧形（`.single()` で受ける実装）に対しても版ガードの
 * 検査だけが赤くなり、RED が呼び出し形の TypeError で濁らぬように。
 */
function makeLogUpdateSupabase(
  opts: {
    update?: { data: unknown; error: unknown }
    prefetch?: { data: unknown; error: unknown }
    reread?: { data: unknown; error: unknown }
  } = {},
) {
  const updateResult = opts.update ?? {
    data: [{ id: "log-1", updated_at: V1 }],
    error: null,
  }
  const updateEqs: [string, unknown][] = []
  const readEqs: [string, unknown][] = []

  const terminal = {
    then: (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => Promise.resolve(updateResult).then(onFulfilled, onRejected),
    single: () => {
      const rows = updateResult.data
      if (updateResult.error || !Array.isArray(rows)) return Promise.resolve(updateResult)
      if (rows.length === 1) return Promise.resolve({ data: rows[0], error: null })
      return Promise.resolve({ data: null, error: { code: "PGRST116", message: "no rows" } })
    },
  }
  const select = vi.fn((_cols: string) => terminal)
  const updateChain: Record<string, unknown> = {
    eq: vi.fn((col: string, val: unknown) => {
      updateEqs.push([col, val])
      return updateChain
    }),
    select,
  }
  const update = vi.fn((_payload: Record<string, unknown>) => updateChain)

  const fetchSelect = vi.fn((cols: string) => {
    const chain: Record<string, unknown> = {
      eq: vi.fn((col: string, val: unknown) => {
        readEqs.push([col, val])
        return chain
      }),
      maybeSingle: () =>
        Promise.resolve(
          cols === "breast_left_sec"
            ? (opts.prefetch ?? { data: { breast_left_sec: null }, error: null })
            : (opts.reread ?? { data: null, error: null }),
        ),
    }
    return chain
  })

  const from = vi.fn((_table: string) => ({ update, select: fetchSelect }))
  return { client: { from }, from, update, select, fetchSelect, updateEqs, readEqs }
}

/** 1 行の更新が通る形（旧来の `{ data: 行 }` を配列の 1 行として返す）。 */
function makeUpdateSupabase(updateResult: { data: unknown; error: unknown }) {
  return makeLogUpdateSupabase({
    update:
      updateResult.data && !Array.isArray(updateResult.data)
        ? { data: [updateResult.data], error: updateResult.error }
        : updateResult,
  })
}

/** durationSec 単独編集の pre-fetch を伴う形（pre-fetch の結果と更新の 1 行を渡す）。 */
function makeUpdateSupabaseWithFetch(
  fetchResult: { data: unknown; error: unknown },
  updateResult: { data: unknown; error: unknown },
) {
  return makeLogUpdateSupabase({
    prefetch: fetchResult,
    update:
      updateResult.data && !Array.isArray(updateResult.data)
        ? { data: [updateResult.data], error: updateResult.error }
        : updateResult,
  })
}

/**
 * deleteLog の fake client（どれも supabase.from("baby_logs") 起点）。
 * - 削除: delete().eq()….select(cols) を await → 配列の行（.single() なし）。
 * - 0 行だった時の読み直し: select(cols).eq()….maybeSingle()。
 *
 * **`.eq()` は経路ごとに記録する**（makeLogUpdateSupabase と同じ理由）。削除の絞り込み
 * （id・世帯・版の三点）と読み直しの絞り込みが混ざると、「版で絞った」の assert が
 * 読み直しの eq で偽って通る。`.eq()` は何本でも受ける — 版を足す前の実装（二本）に
 * 対しても、RED が呼び出し形の TypeError で濁らず、版ガードの検査だけが赤くなるように。
 */
function makeLogDeleteSupabase(
  opts: {
    del?: { data: unknown; error: unknown }
    reread?: { data: unknown; error: unknown }
  } = {},
) {
  const deleteResult = opts.del ?? { data: [{ id: "log-1" }], error: null }
  const deleteEqs: [string, unknown][] = []
  const readEqs: [string, unknown][] = []

  const select = vi.fn((_cols: string) => Promise.resolve(deleteResult))
  const deleteChain: Record<string, unknown> = {
    eq: vi.fn((col: string, val: unknown) => {
      deleteEqs.push([col, val])
      return deleteChain
    }),
    select,
  }
  const del = vi.fn(() => deleteChain)

  const fetchSelect = vi.fn((_cols: string) => {
    const chain: Record<string, unknown> = {
      eq: vi.fn((col: string, val: unknown) => {
        readEqs.push([col, val])
        return chain
      }),
      maybeSingle: () => Promise.resolve(opts.reread ?? { data: null, error: null }),
    }
    return chain
  })

  const from = vi.fn((_table: string) => ({ delete: del, select: fetchSelect }))
  return { client: { from }, from, del, select, fetchSelect, deleteEqs, readEqs }
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
    expect(result).toMatchObject({ error: null, id: "log-99", log: { id: "log-99" } })
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
    expect(result).toMatchObject({ error: null, id: "log-77", log: { id: "log-77" } })
  })
})

describe("record{Temperature,Growth,Memo} が作成 log id を返す（B-03 楽観 append 用）", () => {
  it("recordTemperature: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "temp-1" }, error: null })
    setContext(client)
    const result = await recordTemperature({ temperature: 36.7 })
    expect(result).toMatchObject({ error: null, id: "temp-1", log: { id: "temp-1" } })
  })

  it("recordGrowth: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "growth-1" }, error: null })
    setContext(client)
    const result = await recordGrowth({ weightG: 5200 })
    expect(result).toMatchObject({ error: null, id: "growth-1", log: { id: "growth-1" } })
  })

  it("recordMemo: 成功時に id を返す", async () => {
    const { client } = makeSupabase({ data: { id: "memo-1" }, error: null })
    setContext(client)
    const result = await recordMemo({ memo: "hello" })
    expect(result).toMatchObject({ error: null, id: "memo-1", log: { id: "memo-1" } })
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
    const result = await updateLogV0("log-1", {
      loggedAt: "2099-01-01T00:00:00.000Z",
    })
    expect(result.error).toBe(FUTURE_LOG_TIME_ERROR)
    expect(update).not.toHaveBeenCalled()
  })

  it("loggedAt 変更は pre-fetch なしで update まで進む", async () => {
    const { client, update, fetchSelect } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", {
      loggedAt: "2026-07-09T10:00:00.000Z",
      amountMl: 80,
    })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalled()
    // 既存行の pre-fetch が要るのは durationSec 単独編集のときだけ
    expect(fetchSelect).not.toHaveBeenCalled()
  })

  it("pre-fetch が 0 行（別世帯/不在）なら update せず失敗を返す", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("missing", { durationSec: 300 })
    expect(result.error).toBeTruthy()
    expect(update).not.toHaveBeenCalled()
  })
})

describe("updateLog が 0 行更新を成功と偽らない", () => {
  it("成功時（1 行更新）は error: null と更新後の行を返す", async () => {
    const row = { id: "log-1", log_type: "diaper", logged_at: "2026-10-01T00:01:00.000Z" }
    const { client } = makeUpdateSupabase({ data: row, error: null })
    setContext(client)
    const result = await updateLogV0("log-1", { memo: "hi" })
    expect(result).toEqual({ error: null, log: row })
  })

  it("更新後の行は BABY_LOG_COLUMNS 一式で取り直す（画面の書き換えに全列が要る）", async () => {
    const { client, select } = makeUpdateSupabase({
      data: { id: "log-1" },
      error: null,
    })
    setContext(client)
    await updateLogV0("log-1", { memo: "hi" })
    expect(select).toHaveBeenCalledWith(BABY_LOG_COLUMNS)
  })

  it("0 行（不在・別世帯）は success を偽らず error を返し、ノイズログを出さない", async () => {
    const { client } = makeLogUpdateSupabase({ update: { data: [], error: null } })
    setContext(client)
    const result = await updateLogV0("missing-id", { memo: "hi" })
    expect(result.error).toBeTruthy()
    expect(result.log).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
    // 行が無いのは正常な失敗ゆえ logSupabaseError では出さない。
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("DB エラーは logSupabaseError で構造化ログに残し、衝突とは言わぬ", async () => {
    const { client } = makeUpdateSupabase({
      data: null,
      error: { code: "XX000", message: "boom" },
    })
    setContext(client)
    const result = await updateLogV0("log-1", { memo: "hi" })
    expect(result.error).toBeTruthy()
    expect(result.conflict).toBeUndefined()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })
})

describe("updateLog の版ガード（P2-07: 開いた時点の版でしか書けぬ）", () => {
  // 家族（または自分の別端末）が先に保存した後の行。版は V1 へ進んでおる。
  const CURRENT = {
    id: "log-1",
    log_type: "diaper",
    logged_at: "2026-10-01T00:01:00+00:00",
    diaper_type: "poop",
    poop_amount: "large",
    memo: "家族が直したメモ",
    updated_at: V1,
  }

  it.each([
    ["版なし（デプロイを跨いだ古い画面）", undefined],
    ["null（ログの編集に「行が無い」版は無い）", null],
    ["日付だけ", "2026-10-01"],
    ["表記でない文字列", "not-a-version"],
  ])("版が %s なら DB に触れず、画面が古いと返す（無条件の上書きへ倒さぬ）", async (_label, bad) => {
    const { client, from } = makeLogUpdateSupabase()
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" }, bad as unknown as string)
    expect(result.error).toMatch(/画面が古いため保存できませんでした/)
    expect(from).not.toHaveBeenCalled()
  })

  it("更新は id・世帯・版（送られた表記のまま・マイクロ秒つき）の三点で 1 本の UPDATE に絞る", async () => {
    const { client, update, updateEqs, fetchSelect } = makeLogUpdateSupabase()
    setContext(client)
    await updateLog("log-1", { memo: "hi" }, V0)
    expect(update).toHaveBeenCalledTimes(1)
    expect(updateEqs).toEqual([
      ["id", "log-1"],
      ["household_id", HOUSEHOLD],
      ["updated_at", V0],
    ])
    // 先に版を SELECT してから無条件に UPDATE する形（TOCTOU）ではない
    expect(fetchSelect).not.toHaveBeenCalled()
  })

  it("成功は更新後の行（trigger で進んだ版）を返す", async () => {
    const saved = { ...CURRENT, memo: "hi" }
    const { client } = makeLogUpdateSupabase({ update: { data: [saved], error: null } })
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" }, V0)
    expect(result).toEqual({ error: null, log: saved })
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("0 行で読み直した行が送った内容と違う → 衝突。最新の行を返し、成功と偽らぬ", async () => {
    const { client, readEqs } = makeLogUpdateSupabase({
      update: { data: [], error: null },
      reread: { data: CURRENT, error: null },
    })
    setContext(client)
    const result = await updateLog(
      "log-1",
      { diaperType: "poop", poopAmount: "small", memo: "古い画面から書いたメモ" },
      V0,
    )
    expect(result.error).toMatch(/別の端末で先に更新されていました/)
    expect(result.log).toBeUndefined()
    expect(result.conflict).toEqual({ current: CURRENT })
    expect(revalidatePath).not.toHaveBeenCalled()
    // 読み直しも世帯で絞る（別世帯の行を拾って見せぬ）
    expect(readEqs).toEqual([
      ["id", "log-1"],
      ["household_id", HOUSEHOLD],
    ])
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("0 行で読み直しても無い（削除済み・別世帯）→ 削除されていたと返す（別世帯と削除を区別せぬ）", async () => {
    const { client } = makeLogUpdateSupabase({
      update: { data: [], error: null },
      reread: { data: null, error: null },
    })
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" }, V0)
    expect(result.error).toMatch(/削除されていました/)
    expect(result.conflict).toEqual({ current: null })
    expect(result.log).toBeUndefined()
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("0 行で読み直しに失敗 → 確かめられなかったと返す（衝突とも削除とも断定せぬ）", async () => {
    const { client } = makeLogUpdateSupabase({
      update: { data: [], error: null },
      reread: { data: null, error: { code: "XX000", message: "boom" } },
    })
    setContext(client)
    const result = await updateLog("log-1", { memo: "hi" }, V0)
    expect(result.error).toMatch(/確かめられませんでした/)
    expect(result.conflict).toBeUndefined()
    expect(result.log).toBeUndefined()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD, logId: "log-1" }),
    )
  })

  it("0 行でも、読み直した行が送った内容そのもの（応答だけ失われた保存の再試行）なら成功", async () => {
    const current = { ...CURRENT, poop_amount: "small", memo: "同じメモ" }
    const { client } = makeLogUpdateSupabase({
      update: { data: [], error: null },
      reread: { data: current, error: null },
    })
    setContext(client)
    const result = await updateLog(
      "log-1",
      { diaperType: "poop", poopAmount: "small", memo: "同じメモ" },
      V0,
    )
    expect(result).toEqual({ error: null, log: current })
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("内容一致の判定は logged_at の表記ゆれ（Z と +00:00）を同じ時刻として扱う", async () => {
    const current = { ...CURRENT, memo: "同じメモ" }
    const { client } = makeLogUpdateSupabase({
      update: { data: [], error: null },
      reread: { data: current, error: null },
    })
    setContext(client)
    const result = await updateLog(
      "log-1",
      { loggedAt: "2026-10-01T00:01:00.000Z", memo: "同じメモ" },
      V0,
    )
    expect(result).toEqual({ error: null, log: current })
  })

  it("未承認の利用者は DB に触れず拒否される", async () => {
    getAuthContext.mockResolvedValue({
      error: "承認待ちです",
      reason: "not-approved",
      context: null,
    })
    const { client, from } = makeLogUpdateSupabase()
    void client
    const result = await updateLog("log-1", { memo: "hi" }, V0)
    expect(result.error).toBe("承認待ちです")
    expect(from).not.toHaveBeenCalled()
  })
})

describe("record* は作成した行の版も返す（P2-07: 作成直後の編集に版が要る）", () => {
  it("insert は行一式（版・記録時刻を含む）を取り直し、updatedAt と確定行として返す", async () => {
    const row = { id: "log-5", updated_at: V0, logged_at: V0, log_type: "diaper", diaper_type: "pee" }
    const { client, insertSelect } = makeSupabase({ data: row, error: null })
    setContext(client)
    const result = await recordDiaper({ diaperType: "pee" })
    // 確定行で画面を組めるよう、編集・表示に使う列一式を読む（版だけでなく）
    expect(insertSelect).toHaveBeenCalledWith(BABY_LOG_COLUMNS)
    expect(result).toEqual({ error: null, id: "log-5", updatedAt: V0, loggedAt: V0, log: row })
  })

  it("loggedAt を送らぬクイック記録でも、DB が now() で書いた記録時刻をそのまま返す（楽観行の時刻の源）", async () => {
    const dbNow = "2026-10-25T05:20:59.400123+00:00"
    const { client, insert } = makeSupabase({
      data: { id: "log-6", updated_at: dbNow, logged_at: dbNow },
      error: null,
    })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle" })
    // 送らぬ（DB 既定の now() に委ねる従来挙動は変えぬ）
    expect((insert.mock.calls[0] as unknown[])[0]).not.toHaveProperty("logged_at")
    expect(result).toMatchObject({ error: null, id: "log-6", loggedAt: dbNow })
  })
})

describe("deleteLog が 0 行削除を成功と偽らない", () => {
  it("成功時（1 行削除）は error: null を返す", async () => {
    const { client } = makeLogDeleteSupabase({ del: { data: [{ id: "log-1" }], error: null } })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result).toEqual({ error: null })
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("0 行で読み直しても無い（既に削除済み）は success を偽らず alreadyDeleted を返し、ノイズログを出さない", async () => {
    // 応答を失った自分の削除の再試行も同じ形になる（行はもう無い = 消したい状態は満たされている）
    const { client } = makeLogDeleteSupabase({
      del: { data: [], error: null },
      reread: { data: null, error: null },
    })
    setContext(client)
    const result = await deleteLog("missing-id", V0)
    expect(result.error).toBe("既に削除されています。")
    // 画面に残る幽霊行（他端末の削除は Realtime で届かぬ）を呼び出し側が外せる印
    expect(result.alreadyDeleted).toBe(true)
    expect(result.conflict).toBeUndefined()
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("DB エラーは alreadyDeleted を付けない（行を画面から外させない）", async () => {
    const { client, fetchSelect } = makeLogDeleteSupabase({
      del: { data: null, error: { code: "XX000", message: "boom" } },
    })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result.alreadyDeleted).toBeUndefined()
    expect(result.conflict).toBeUndefined()
    // 失敗を 0 行（削除済み・衝突）と取り違えて読み直さぬ
    expect(fetchSelect).not.toHaveBeenCalled()
  })

  it("DB エラーは logSupabaseError で構造化ログに残す", async () => {
    const { client } = makeLogDeleteSupabase({
      del: { data: null, error: { code: "XX000", message: "boom" } },
    })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result.error).toBeTruthy()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })
})

/**
 * 削除の版ガード（PR #235 敵対レビュー P1）。
 *
 * 編集（updateLog）だけが版を見ても、削除が id と世帯だけで消せば、A が先に直した記録を
 * B が古い画面から丸ごと消せる（A の編集ごと失われる）。削除も開いた時点の版を条件にした
 * 1 本の DELETE で書き、0 行なら読み直して「削除済み」「他端末で更新済み」「確かめられぬ」を
 * 分ける。
 */
describe("deleteLog の版ガード（開いた時点の版でしか消せぬ）", () => {
  // 家族（または自分の別端末）が先に保存した後の行。版は V1 へ進んでおる。
  const CURRENT = {
    id: "log-1",
    log_type: "diaper",
    logged_at: "2026-10-01T00:01:00+00:00",
    diaper_type: "poop",
    poop_amount: "large",
    memo: "家族が直したメモ",
    updated_at: V1,
  }

  it.each([
    ["版なし（デプロイを跨いだ古い画面）", undefined],
    ["null（記録の削除に「行が無い」版は無い）", null],
    ["日付だけ", "2026-10-01"],
    ["表記でない文字列", "not-a-version"],
  ])("版が %s なら DB に触れず、画面が古いと返す（無条件の削除へ倒さぬ）", async (_label, bad) => {
    const { client, from } = makeLogDeleteSupabase()
    setContext(client)
    const result = await deleteLog("log-1", bad as unknown as string)
    expect(result.error).toMatch(/画面が古いため/)
    expect(result.alreadyDeleted).toBeUndefined()
    expect(result.conflict).toBeUndefined()
    expect(from).not.toHaveBeenCalled()
  })

  it("削除は id・世帯・版（送られた表記のまま・マイクロ秒つき）の三点で 1 本の DELETE に絞る", async () => {
    const { client, del, deleteEqs, fetchSelect } = makeLogDeleteSupabase()
    setContext(client)
    await deleteLog("log-1", V0)
    expect(del).toHaveBeenCalledTimes(1)
    expect(deleteEqs).toEqual([
      ["id", "log-1"],
      ["household_id", HOUSEHOLD],
      ["updated_at", V0],
    ])
    // 先に版を SELECT してから無条件に DELETE する形（TOCTOU）ではない
    expect(fetchSelect).not.toHaveBeenCalled()
  })

  it("⭐ 0 行で読み直した行の版が進んでおる（A が先に更新）→ 消さず、最新の行を衝突として返す", async () => {
    const { client, readEqs } = makeLogDeleteSupabase({
      del: { data: [], error: null },
      reread: { data: CURRENT, error: null },
    })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result.error).toMatch(/別の端末で先に更新されていた/)
    expect(result.conflict).toEqual({ current: CURRENT })
    // 「削除済み」と取り違えて画面から外させぬ（A の記録は DB に残っておる）
    expect(result.alreadyDeleted).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
    // 読み直しも世帯で絞る（別世帯の行を拾って見せぬ）
    expect(readEqs).toEqual([
      ["id", "log-1"],
      ["household_id", HOUSEHOLD],
    ])
    expect(mockedLog).not.toHaveBeenCalled()
  })

  it("0 行で読み直しても無い別世帯の行は、削除済みと同じ応答にする（存在を漏らさぬ）", async () => {
    // 別世帯の行は RLS と世帯の絞り込みで削除にも読み直しにも見えぬ
    const { client, deleteEqs, readEqs } = makeLogDeleteSupabase({
      del: { data: [], error: null },
      reread: { data: null, error: null },
    })
    setContext(client)
    const result = await deleteLog("other-household-log", V0)
    expect(result).toEqual({ error: "既に削除されています。", alreadyDeleted: true })
    expect(deleteEqs).toContainEqual(["household_id", HOUSEHOLD])
    expect(readEqs).toContainEqual(["household_id", HOUSEHOLD])
  })

  it("0 行で読み直しに失敗 → 削除済みとも衝突とも断定せず、行を画面から外させぬ", async () => {
    const { client } = makeLogDeleteSupabase({
      del: { data: [], error: null },
      reread: { data: null, error: { code: "XX000", message: "boom" } },
    })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result.error).toMatch(/確かめられませんでした/)
    expect(result.alreadyDeleted).toBeUndefined()
    expect(result.conflict).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD, logId: "log-1" }),
    )
  })

  it("0 行なのに読み直した行の版が送った版と同じ → 衝突とは偽らず、削除の失敗として返す", async () => {
    // 版が合うのに消えぬのは、他端末の更新ではなく削除そのものが拒まれた形。
    // 「先に更新されていた」と見せると、利用者は存在しない変更を探すことになる
    const sameVersion = { ...CURRENT, updated_at: V0 }
    const { client } = makeLogDeleteSupabase({
      del: { data: [], error: null },
      reread: { data: sameVersion, error: null },
    })
    setContext(client)
    const result = await deleteLog("log-1", V0)
    expect(result.error).toBe("ログの削除に失敗しました。")
    expect(result.conflict).toBeUndefined()
    expect(result.alreadyDeleted).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("未承認の利用者は DB に触れず拒否される", async () => {
    getAuthContext.mockResolvedValue({
      error: "承認待ちです",
      reason: "not-approved",
      context: null,
    })
    const { from } = makeLogDeleteSupabase()
    const result = await deleteLog("log-1", V0)
    expect(result.error).toBe("承認待ちです")
    expect(from).not.toHaveBeenCalled()
  })
})

describe("updateLog の授乳時間（durationSec）更新", () => {
  function makeCapturedUpdate() {
    // durationSec 単独編集は既存行を pre-fetch する（sides を持つ行の合計だけ編集を
    // fail-loud で拒むため）。既定は sides 無しの行 = 従来経路が通る前提。
    return makeLogUpdateSupabase()
  }

  it("durationSec 指定で duration_sec と導出 duration_min の両列を1経路で書く", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLogV0("log-1", { durationSec: 330 })
    expect(result.error).toBeNull()
    // 330 秒 → duration_min = round(330/60) = 6（recordFeeding の導出と同一規約）
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_sec: 330, duration_min: 6 }),
    )
  })

  it("durationSec: null は両列を null に戻す（時間なしの授乳へ）", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLogV0("log-1", { durationSec: null })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ duration_sec: null, duration_min: null }),
    )
  })

  it("durationSec 未指定なら duration 列に触れない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)

    const result = await updateLogV0("log-1", { memo: "hi" })
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
      const result = await updateLogV0("log-1", { durationSec: bad as number })
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
  /** 更新の payload を検査する fake client（1 行の更新が通る形）。 */
  function makeCapturedUpdate() {
    return makeLogUpdateSupabase()
  }

  it("feedingType='breast' + 妥当な counts は payload に書く", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", { feedingType: "bottle" })
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
    const result = await updateLogV0("log-1", { feedingType: "breast" })
    expect(result.error).toBe(
      "左右の回数は0〜20回・合計1回以上で指定してください",
    )
    expect(update).not.toHaveBeenCalled()
  })

  it("feedingType='breast' + 範囲外の counts はエラーで update しない", async () => {
    const { client, update } = makeCapturedUpdate()
    setContext(client)
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", { memo: "hi" })
    expect(result.error).toBeNull()
    const payload = update.mock.calls[0][0] as Record<string, unknown>
    expect(payload).not.toHaveProperty("breast_left_count")
    expect(payload).not.toHaveProperty("breast_right_count")
  })
})

describe("recordDiaper のうんちの量（poop_amount）", () => {
  it("poop + small を insert payload に書く", async () => {
    const { client, insert } = makeSupabase({ data: { id: "d-1" }, error: null })
    setContext(client)
    const result = await recordDiaper({ diaperType: "poop", poopAmount: "small" })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "poop", poop_amount: "small" }),
    )
  })

  it("both + large も許可（両方はうんちを含む）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "d-2" }, error: null })
    setContext(client)
    const result = await recordDiaper({ diaperType: "both", poopAmount: "large" })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "both", poop_amount: "large" }),
    )
  })

  it("量 未指定 / null は poop_amount: null で insert（量なし・後方互換の形）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "d-3" }, error: null })
    setContext(client)
    await recordDiaper({ diaperType: "poop" })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "poop", poop_amount: null }),
    )
    await recordDiaper({ diaperType: "pee", poopAmount: null })
    expect(insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ diaper_type: "pee", poop_amount: null }),
    )
  })

  it("pee に量を付けるとエラーで DB 到達しない（chk_poop_amount_only_poop のミラー）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordDiaper({ diaperType: "pee", poopAmount: "large" })
    expect(result.error).toBe("うんちの量はうんちを含む記録にのみ指定できます")
    expect(result.id).toBeNull()
    expect(insert).not.toHaveBeenCalled()
  })

  it("集合外の量はエラーで DB 到達しない（chk_poop_amount_value のミラー）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordDiaper({
      diaperType: "poop",
      poopAmount: "medium" as unknown as "small",
    })
    expect(result.error).toBe("うんちの量は 少量 / 大量 のいずれかで指定してください")
    expect(insert).not.toHaveBeenCalled()
  })
})

describe("updateLog のうんちの量（poop_amount）", () => {
  it("diaperType=poop + poopAmount=large を payload に書く", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { diaperType: "poop", poopAmount: "large" })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "poop", poop_amount: "large" }),
    )
  })

  it("diaperType=poop + poopAmount=null は量なしへ戻す", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { diaperType: "poop", poopAmount: null })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "poop", poop_amount: null }),
    )
  })

  it("pee へ変更すると量は常に null で上書き（送り忘れ/消し忘れ防御）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { diaperType: "pee" })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ diaper_type: "pee", poop_amount: null }),
    )
  })

  it("poop へ変更で量 未指定なら poop_amount 列に触れない（既存値を undefined で壊さない）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { diaperType: "both" })
    expect(result.error).toBeNull()
    const payload = (
      update.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0]
    expect(payload).toHaveProperty("diaper_type", "both")
    expect(payload).not.toHaveProperty("poop_amount")
  })

  it("量だけ送る（種類なし）は fail-loud で拒否", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { poopAmount: "small" })
    expect(result.error).toBe("うんちの量はおむつの種類と同時に指定してください")
    expect(update).not.toHaveBeenCalled()
  })

  it("pee に量を付けて送るのは拒否", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", { diaperType: "pee", poopAmount: "small" })
    expect(result.error).toBe("うんちの量はうんちを含む記録にのみ指定できます")
    expect(update).not.toHaveBeenCalled()
  })
})

describe("recordFeeding / updateLog の開始側（breast_start_side）", () => {
  it("recordFeeding: breast + left を insert payload に書く", async () => {
    const { client, insert } = makeSupabase({ data: { id: "s-1" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 0,
      breastStartSide: "left",
    })
    expect(result.error).toBeNull()
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ feeding_type: "breast", breast_start_side: "left" }),
    )
  })

  it("recordFeeding: 不明（null / 未指定）は breast_start_side: null で通る", async () => {
    const { client, insert } = makeSupabase({ data: { id: "s-2" }, error: null })
    setContext(client)
    await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
    })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ breast_start_side: null }),
    )
  })

  it("recordFeeding: breast 以外に開始側を付けるとエラー（chk_breast_start_side_only_breast のミラー）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordFeeding({ feedingType: "bottle", breastStartSide: "left" })
    expect(result.error).toBe("この授乳タイプには開始側を指定できません")
    expect(insert).not.toHaveBeenCalled()
  })

  it("recordFeeding: 集合外の開始側はエラー", async () => {
    const { client, insert } = makeSupabase({ data: { id: "x" }, error: null })
    setContext(client)
    const result = await recordFeeding({
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 0,
      breastStartSide: "both" as unknown as "left",
    })
    expect(result.error).toBe("開始側は 左 / 右 のいずれかで指定してください")
    expect(insert).not.toHaveBeenCalled()
  })

  it("recordFeeding: bottle 行は開始側 null で insert する（未指定の既定）", async () => {
    const { client, insert } = makeSupabase({ data: { id: "s-3" }, error: null })
    setContext(client)
    await recordFeeding({ feedingType: "bottle" })
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ breast_start_side: null }),
    )
  })

  it("updateLog: feedingType=breast + right を書き、null は不明へ戻す", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    await updateLogV0("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      breastStartSide: "right",
    })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ breast_start_side: "right" }),
    )
    await updateLogV0("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
      breastStartSide: null,
    })
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({ breast_start_side: null }),
    )
  })

  it("updateLog: feedingType=breast で開始側 未指定なら列に触れない", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    await updateLogV0("log-1", {
      feedingType: "breast",
      breastLeftCount: 1,
      breastRightCount: 1,
    })
    const payload = (
      update.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0]
    expect(payload).not.toHaveProperty("breast_start_side")
  })

  it("updateLog: breast 以外へ種別変更すると開始側も強制 null 化（counts / sides と同じ規約）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    await updateLogV0("log-1", { feedingType: "bottle" })
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ breast_start_side: null }),
    )
  })

  it("updateLog: 開始側だけ送る（種類なし）/ breast 以外に付ける は fail-loud", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      { data: null, error: null },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    expect((await updateLogV0("log-1", { breastStartSide: "left" })).error).toBe(
      "開始側は授乳の種類と同時に指定してください",
    )
    expect(
      (await updateLogV0("log-1", { feedingType: "bottle", breastStartSide: "left" })).error,
    ).toBe("この授乳タイプには開始側を指定できません")
    expect(update).not.toHaveBeenCalled()
  })
})

describe("upsertBabyDiary（育児日記・1日1本・updated_at を版とする楽観的排他）", () => {
  /** baby_diaries の 1 行（fake の内部表現）。 */
  interface DiaryRow {
    id: string
    household_id: string
    diary_date: string
    content: string
    updated_by: string | null
    updated_at: string
  }
  type Op = "select" | "upsert" | "update" | "delete"
  type FakeError = { message: string; code: string }

  /**
   * baby_diaries を模した in-memory の fake client（P1-06）。
   *
   * 本物の PostgREST / Postgres の意味論のうち、排他の正しさに効く 3 点を写す:
   * - UNIQUE (household_id, diary_date) への upsert は既定で DO UPDATE（＝上書き）、
   *   `ignoreDuplicates: true` なら ON CONFLICT DO NOTHING（返却 0 行）
   * - update / delete は `.eq()` の全条件（`updated_at` を含む）に一致する行だけに効き、
   *   0 行でも error は null（`.select()` の返却配列でしか検知できない）
   * - BEFORE UPDATE トリガ trg_baby_diaries_updated_at を模し、UPDATE のたびに
   *   updated_at を新しい値へ進める
   * 旧実装の `upsert(...).select().single()` も実行できるようにしてある（赤が
   * TypeError ではなく「上書きされた」というアサーション失敗で出るように）。
   */
  function makeDiaryFake(
    initial: DiaryRow[] = [],
    failOps: Partial<Record<Op, FakeError>> = {},
  ) {
    const rows: DiaryRow[] = initial.map((r) => ({ ...r }))
    const ops: Op[] = []
    let tick = 0
    const nextUpdatedAt = () =>
      `2026-07-22T12:00:00.${String(++tick).padStart(6, "0")}+00:00`
    const project = (r: DiaryRow) => ({
      id: r.id,
      diary_date: r.diary_date,
      content: r.content,
      updated_at: r.updated_at,
    })

    function builder(op: Op, payload?: Record<string, unknown>, opts?: Record<string, unknown>) {
      const filters: Array<[string, unknown]> = []
      let selected = false
      const matches = (r: DiaryRow) =>
        filters.every(
          ([col, val]) => String(r[col as keyof DiaryRow]) === String(val),
        )

      const exec = (): { data: unknown; error: unknown } => {
        ops.push(op)
        const failure = failOps[op]
        if (failure) return { data: null, error: failure }
        let affected: DiaryRow[] = []
        if (op === "select") {
          affected = rows.filter(matches)
        } else if (op === "upsert") {
          const row = payload as Pick<
            DiaryRow,
            "household_id" | "diary_date" | "content" | "updated_by"
          >
          const existing = rows.find(
            (r) =>
              r.household_id === row.household_id &&
              r.diary_date === row.diary_date,
          )
          if (existing && opts?.ignoreDuplicates === true) {
            affected = [] // ON CONFLICT DO NOTHING
          } else if (existing) {
            // ON CONFLICT DO UPDATE（＝無条件の上書き）+ トリガで版が進む
            existing.content = row.content
            existing.updated_by = row.updated_by
            existing.updated_at = nextUpdatedAt()
            affected = [existing]
          } else {
            const inserted: DiaryRow = {
              id: `d-new-${rows.length + 1}`,
              ...row,
              updated_at: nextUpdatedAt(),
            }
            rows.push(inserted)
            affected = [inserted]
          }
        } else if (op === "update") {
          affected = rows.filter(matches)
          for (const r of affected) {
            Object.assign(r, payload)
            r.updated_at = nextUpdatedAt()
          }
        } else {
          affected = rows.filter(matches)
          for (const r of affected) rows.splice(rows.indexOf(r), 1)
        }
        return { data: selected || op === "select" ? affected.map(project) : null, error: null }
      }

      const q = {
        select: () => {
          selected = true
          return q
        },
        eq: (col: string, val: unknown) => {
          filters.push([col, val])
          return q
        },
        single: () => {
          const res = exec()
          if (res.error) return Promise.resolve(res)
          const list = res.data as unknown[]
          return Promise.resolve(
            list.length === 1
              ? { data: list[0], error: null }
              : { data: null, error: { message: "not single", code: "PGRST116" } },
          )
        },
        maybeSingle: () => {
          const res = exec()
          if (res.error) return Promise.resolve(res)
          const list = res.data as unknown[]
          return Promise.resolve({ data: list[0] ?? null, error: null })
        },
        then: (
          onF: (v: { data: unknown; error: unknown }) => unknown,
          onR?: (e: unknown) => unknown,
        ) => Promise.resolve().then(exec).then(onF, onR),
      }
      return q
    }

    const from = vi.fn(() => ({
      select: () => builder("select").select(),
      upsert: (row: Record<string, unknown>, opts?: Record<string, unknown>) =>
        builder("upsert", row, opts),
      update: (patch: Record<string, unknown>) => builder("update", patch),
      delete: () => builder("delete"),
    }))
    return { client: { from }, rows, ops, from }
  }

  const SPOUSE_VERSION = "2026-07-22T03:00:00.123456+00:00"
  const STALE_VERSION = "2026-07-21T22:00:00.654321+00:00"

  function spouseRow(overrides: Partial<DiaryRow> = {}): DiaryRow {
    return {
      id: "d1",
      household_id: HOUSEHOLD,
      diary_date: "2026-07-20",
      content: "配偶者が先に書いた長文",
      updated_by: "user-2",
      updated_at: SPOUSE_VERSION,
      ...overrides,
    }
  }

  it("新規（期待版 null・行なし）は INSERT し、trim 済み本文の行を返す", async () => {
    const fake = makeDiaryFake()
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "  今日は散歩  ", null)
    expect(result.error).toBeNull()
    expect(result.diary?.content).toBe("今日は散歩")
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0]).toMatchObject({
      household_id: HOUSEHOLD,
      diary_date: "2026-07-20",
      content: "今日は散歩",
      updated_by: "user-1",
    })
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("版が一致すれば UPDATE で保存し、トリガで進んだ新しい版を返す", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "追記した本文", SPOUSE_VERSION)
    expect(result.error).toBeNull()
    expect(result.conflict).toBeUndefined()
    expect(fake.rows[0].content).toBe("追記した本文")
    expect(result.diary?.content).toBe("追記した本文")
    expect(result.diary?.updated_at).not.toBe(SPOUSE_VERSION)
    expect(result.diary?.updated_at).toBe(fake.rows[0].updated_at)
  })

  it("版の不一致（配偶者が先に保存）は上書きせず、最新の行を conflict で返す", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "古い版から書いた本文", STALE_VERSION)
    // 配偶者の本文は無傷（無条件 upsert だとここが「古い版から書いた本文」になる）
    expect(fake.rows[0].content).toBe("配偶者が先に書いた長文")
    expect(fake.rows[0].updated_at).toBe(SPOUSE_VERSION)
    // 書いた人は判別できない（応答が失われた自分の保存・同じ利用者の別端末も同じ形で
    // 衝突する）ため、「家族が」と断定しない
    expect(result.error).toBe(
      "この日の日記は別の端末で先に保存されていました（家族またはご自身）。",
    )
    expect(result.diary).toBeNull()
    expect(result.conflict).toEqual({
      current: {
        id: "d1",
        diary_date: "2026-07-20",
        content: "配偶者が先に書いた長文",
        updated_at: SPOUSE_VERSION,
      },
    })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("取得失敗の空シード（期待版 null）から保存しても、既存行があれば上書きせず conflict", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "空欄から書いた一言", null)
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].content).toBe("配偶者が先に書いた長文")
    expect(result.error).toBeTruthy()
    expect(result.conflict?.current?.content).toBe("配偶者が先に書いた長文")
  })

  it("応答が失われた保存の再試行（読み直した本文が今送った本文と同じ）は衝突にせず成功で返す", async () => {
    // 1 回目の保存は DB で成立し版が進んだが、応答だけが届かなかった。同じ端末から
    // 同じ本文で押し直すと、古い版の UPDATE は 0 行になる — それを「別の端末で先に
    // 保存されていました」と出せば、端末を 1 台しか使わぬ利用者を誤らせる（DC-01）。
    const fake = makeDiaryFake([spouseRow({ content: "送り直した本文" })])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "  送り直した本文  ", STALE_VERSION)
    expect(result.error).toBeNull()
    expect(result.conflict).toBeUndefined()
    expect(result.diary).toEqual({
      id: "d1",
      diary_date: "2026-07-20",
      content: "送り直した本文",
      updated_at: SPOUSE_VERSION,
    })
    expect(fake.rows[0].updated_at).toBe(SPOUSE_VERSION)
  })

  it("更新しようとした行が他端末で削除済みなら conflict（current: null）で返し、勝手に作り直さない", async () => {
    const fake = makeDiaryFake([])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "編集中の本文", SPOUSE_VERSION)
    expect(fake.rows).toHaveLength(0)
    expect(result.error).toBeTruthy()
    expect(result.conflict).toEqual({ current: null })
  })

  it("空保存は版が一致すれば DELETE し diary: null を返す", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "   \n  ", SPOUSE_VERSION)
    expect(result.error).toBeNull()
    expect(result.diary).toBeNull()
    expect(fake.rows).toHaveLength(0)
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("空保存でも版が古ければ消さず conflict（配偶者の新しい本文を守る）", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "", STALE_VERSION)
    expect(fake.rows).toHaveLength(1)
    expect(fake.rows[0].content).toBe("配偶者が先に書いた長文")
    expect(result.error).toBeTruthy()
    expect(result.conflict?.current?.updated_at).toBe(SPOUSE_VERSION)
  })

  it("空保存・期待版 null で行が在れば消さず conflict（DELETE を発行しない）", async () => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", " ", null)
    expect(fake.rows).toHaveLength(1)
    expect(fake.ops).not.toContain("delete")
    expect(result.conflict?.current?.content).toBe("配偶者が先に書いた長文")
  })

  it("空保存で行が既に無いなら冪等に成功する（期待版 null / 期待版あり の両方）", async () => {
    const fakeA = makeDiaryFake([])
    setContext(fakeA.client)
    const a = await upsertBabyDiary("2026-07-20", "", null)
    expect(a).toEqual({ error: null, diary: null })

    const fakeB = makeDiaryFake([])
    setContext(fakeB.client)
    const b = await upsertBabyDiary("2026-07-20", "", SPOUSE_VERSION)
    expect(b).toEqual({ error: null, diary: null })
  })

  it.each([
    ["undefined（版を送らぬ旧バンドル）", undefined],
    ["空文字", ""],
    ["日時でない文字列", "not-a-timestamp"],
    ["数値", 12345],
  ])("期待版が不正（%s）なら DB に触れず拒否する（無条件 upsert に倒さない）", async (_label, bad) => {
    const fake = makeDiaryFake([spouseRow()])
    setContext(fake.client)

    const result = await upsertBabyDiary(
      "2026-07-20",
      "本文",
      bad as unknown as string | null,
    )
    expect(result.error).toBeTruthy()
    expect(result.diary).toBeNull()
    expect(fake.from).not.toHaveBeenCalled()
    expect(fake.rows[0].content).toBe("配偶者が先に書いた長文")
  })

  it("Realtime 風の空白区切り・時差短縮の版表記も受理する", async () => {
    const fake = makeDiaryFake([spouseRow({ updated_at: "2026-07-22 03:00:00.123456+00" })])
    setContext(fake.client)

    const result = await upsertBabyDiary(
      "2026-07-20",
      "本文",
      "2026-07-22 03:00:00.123456+00",
    )
    expect(result.error).toBeNull()
    expect(fake.rows[0].content).toBe("本文")
  })

  it("不正な日付形式・未来日・上限超過は auth 前に拒否する", async () => {
    const from = vi.fn()
    setContext({ from })

    expect((await upsertBabyDiary("2026/07/20", "x", null)).error).toBe(
      "日付の形式が不正です",
    )
    expect((await upsertBabyDiary("2999-01-01", "x", null)).error).toBe(
      "未来の日記は書けません",
    )
    expect(
      (await upsertBabyDiary("2026-07-20", "あ".repeat(5001), null)).error,
    ).toContain("5000文字以内")
    expect(from).not.toHaveBeenCalled()
  })

  it.each([
    ["新規 INSERT", [] as DiaryRow[], "本文", null, "upsert" as Op, "日記の保存に失敗しました。もう一度お試しください。"],
    ["UPDATE", [spouseRow()], "本文", SPOUSE_VERSION, "update" as Op, "日記の保存に失敗しました。もう一度お試しください。"],
    ["DELETE", [spouseRow()], "", SPOUSE_VERSION, "delete" as Op, "日記の削除に失敗しました。もう一度お試しください。"],
  ])("%s の DB error は握り潰さず日本語エラーを返して記録する", async (_label, initial, content, version, op, message) => {
    const fake = makeDiaryFake(initial, { [op]: { message: "boom", code: "23514" } })
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", content, version)
    expect(result.error).toBe(message)
    expect(result.diary).toBeNull()
    expect(result.conflict).toBeUndefined()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ householdId: HOUSEHOLD, diaryDate: "2026-07-20" }),
    )
  })

  it("衝突後の最新行の読み直しが失敗したら conflict を偽らず（current: null と誤認させず）エラーだけ返す", async () => {
    const fake = makeDiaryFake([spouseRow()], {
      select: { message: "read boom", code: "XX000" },
    })
    setContext(fake.client)

    const result = await upsertBabyDiary("2026-07-20", "本文", STALE_VERSION)
    expect(fake.rows[0].content).toBe("配偶者が先に書いた長文")
    expect(result.error).toBeTruthy()
    expect(result.diary).toBeNull()
    expect(result.conflict).toBeUndefined()
    expect(mockedLog).toHaveBeenCalledWith(
      "baby",
      expect.any(String),
      expect.objectContaining({ message: "read boom" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
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
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", {
      feedingType: "bottle",
      breastLeftSec: 300,
      breastRightSec: 0,
    })
    expect(result.error).toBe("この授乳タイプには左右の時間を指定できません")
  })

  it("sides を持つ行への durationSec 単独編集は fail-loud で拒否（無音で sides を捨てない）", async () => {
    const { client, update } = makeUpdateSupabaseWithFetch(
      {
        data: { breast_left_sec: 300 },
        error: null,
      },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", {
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
        data: { breast_left_sec: null },
        error: null,
      },
      { data: { id: "log-1" }, error: null },
    )
    setContext(client)
    const result = await updateLogV0("log-1", {
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
    const result = await updateLogV0("log-1", { feedingType: "bottle" })
    expect(result.error).toBeNull()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        breast_left_sec: null,
        breast_right_sec: null,
      }),
    )
  })
})
