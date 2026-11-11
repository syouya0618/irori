/**
 * 掃除の Server Action（saveCleaning）の契約。
 *
 * - X-05: 認証と世帯は getAuthContext から。クライアントの世帯 ID・回の鍵・実施日を信用せぬ
 * - B-06: 対象回はサーバーが DB の最新から計算。同じ回が先に閉じておれば 1 回分のまま（already_closed）
 * - B-07g: 未来の日を実施履歴にせぬ
 * - X-09: 同じ操作 ID の再送は、既に書いた行の内容で確かめ直す（次の回を新たに閉じぬ）。結果不明は unknown
 *
 * 暦の前提: 2026-11-11 は水曜。2026-11-07 / 11-14 は土曜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))

import { loadCleaningHistory, saveCleaning } from "../actions"
import type { CleaningRequest } from "@/lib/domain/cleaning"

const USER = "c1000000-0000-4000-8000-000000000001"
const SPOUSE = "c1000000-0000-4000-8000-000000000002"
const HOUSE = "c1000000-0000-4000-8000-0000000000a1"
const ROUTINE = "c2000000-0000-4000-8000-000000000001"
const LOG = "c3000000-0000-4000-8000-000000000001"
const OTHER_LOG = "c3000000-0000-4000-8000-000000000002"
const V1 = "2026-11-01T00:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.654321+00:00"
const TODAY = "2026-11-11"

type Reply = { data: unknown; error: { code?: string; message?: string } | null }
type FromHandler = (table: string, filters: Record<string, unknown>) => Reply
type RpcHandler = (name: string, args: Record<string, unknown>) => Reply

function routineRow(over: Record<string, unknown> = {}) {
  return {
    id: ROUTINE,
    name: "浴室の排水口",
    location: "浴室",
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-07",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    // 周期の世代（Action が「見ておった回は今の世代で閉じ済みか」の読みを絞るのに使う）
    cadence_epoch: 0,
    archived: false,
    updated_at: V1,
    created_at: V1,
    ...over,
  }
}
function logRow(over: Record<string, unknown> = {}) {
  return {
    id: LOG,
    routine_id: ROUTINE,
    kind: "done",
    done_on: TODAY,
    occurrence: "2026-11-07",
    note: null,
    voided_at: null,
    created_by: USER,
    updated_at: V2,
    created_at: V2,
    ...over,
  }
}

function fakeSupabase(from: FromHandler, rpc: RpcHandler) {
  const calls = { from: [] as { table: string; filters: Record<string, unknown> }[], rpc: [] as [string, Record<string, unknown>][] }
  const supabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {}
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value
          return builder
        },
        is: (column: string, value: unknown) => {
          filters[column] = value
          return builder
        },
        maybeSingle: async () => {
          calls.from.push({ table, filters })
          return from(table, filters)
        },
      }
      return builder
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.rpc.push([name, args])
      return rpc(name, args)
    },
  }
  return { supabase, calls }
}

function signIn(from: FromHandler, rpc: RpcHandler) {
  const fake = fakeSupabase(from, rpc)
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: fake.supabase, userId: USER, householdId: HOUSE },
  })
  return fake.calls
}

/** 定義 1 件・履歴の要約つきの世帯。`logs` は操作 ID・回の鍵での読みに答える。 */
function household(options: {
  routine?: Record<string, unknown> | null
  marks?: { last_done_on: string | null; max_occurrence: string | null; max_skip_occurrence: string | null } | null
  logById?: Record<string, unknown> | null
  logByOccurrence?: Record<string, unknown> | null
}): FromHandler {
  return (table, filters) => {
    if (table === "cleaning_routines") {
      const row = options.routine === undefined ? routineRow() : options.routine
      // 世帯で絞った読みにしか行を返さぬ（別世帯の文脈なら見つからぬ）
      return { data: filters.household_id === HOUSE && filters.id === ROUTINE ? row : null, error: null }
    }
    if (table === "cleaning_logs") {
      if (filters.household_id !== HOUSE) return { data: null, error: null }
      if ("occurrence" in filters) return { data: options.logByOccurrence ?? null, error: null }
      return { data: options.logById ?? null, error: null }
    }
    return { data: null, error: { code: "42P01", message: "unexpected table" } }
  }
}

function marksRpc(marks: Parameters<typeof household>[0]["marks"], record: RpcHandler): RpcHandler {
  return (name, args) => {
    if (name === "cleaning_log_marks") {
      return { data: marks ? [{ routine_id: ROUTINE, ...marks }] : [], error: null }
    }
    return record(name, args)
  }
}

const closeRequest = (over: Partial<Extract<CleaningRequest, { op: "close" }>> = {}): CleaningRequest => ({
  op: "close",
  id: LOG,
  routineId: ROUTINE,
  routineVersion: V1,
  kind: "done",
  seenOccurrence: "2026-11-07",
  // 最初に押した日（画面が持っておったサーバーの今日）
  pressedOn: TODAY,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  // 2026-11-11 12:00 JST
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  revalidatePath.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("X-05 認証と入力", () => {
  it("未認証なら DB へ届く前に拒否する", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await saveCleaning(closeRequest())).toEqual({ error: "認証されていません", failure: "rejected" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("世帯 ID を紛れ込ませた要求は、無視ではなく拒否する（認証より前）", async () => {
    const calls = signIn(household({}), () => ({ data: null, error: null }))
    const injected = { ...closeRequest(), householdId: "c1000000-0000-4000-8000-0000000000b1" } as unknown as CleaningRequest
    expect(await saveCleaning(injected)).toMatchObject({ failure: "rejected" })
    expect(getAuthContext).not.toHaveBeenCalled()
    expect(calls.rpc).toEqual([])
  })

  it.each([
    ["形の違う要求", { op: "close", id: "not-a-uuid" }],
    ["未知の操作", { op: "delete_all", id: ROUTINE }],
    ["版の無い状態変更", { op: "state", id: ROUTINE, version: null, action: "pause" }],
    ["作成と同時のアーカイブ", { op: "routine", id: ROUTINE, version: null, name: "x", location: null, cadenceUnit: "week", cadenceInterval: 1, scheduleMode: "fixed", anchorDate: TODAY, archived: true }],
    ["範囲外の間隔", { op: "routine", id: ROUTINE, version: null, name: "x", location: null, cadenceUnit: "week", cadenceInterval: 53, scheduleMode: "fixed", anchorDate: TODAY, archived: false }],
    ["実在せぬ基準日", { op: "routine", id: ROUTINE, version: null, name: "x", location: null, cadenceUnit: "month", cadenceInterval: 1, scheduleMode: "fixed", anchorDate: "2026-02-30", archived: false }],
  ])("%s は拒否する", async (_name, request) => {
    signIn(household({}), () => ({ data: null, error: null }))
    expect(await saveCleaning(request as unknown as CleaningRequest)).toMatchObject({ failure: "rejected" })
    expect(getAuthContext).not.toHaveBeenCalled()
  })

  it("RPC へ世帯 ID を渡さぬ（世帯は DB が auth.uid() から導出する）", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "saved", log: logRow(), routine: routineRow() }, error: null })),
    )
    await saveCleaning(closeRequest())
    for (const [, args] of calls.rpc) {
      expect(Object.keys(args).every((key) => key.startsWith("p_"))).toBe(true)
      expect(JSON.stringify(args)).not.toContain(HOUSE)
    }
    // 読みは必ず世帯で絞る
    expect(calls.from.every((call) => call.filters.household_id === HOUSE)).toBe(true)
  })
})

describe("X-06 別世帯の項目", () => {
  it("自世帯に無い項目の完了は「見つからぬ」で拒否し、記録の RPC を呼ばぬ", async () => {
    const calls = signIn(
      household({ routine: null }),
      marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "rejected" })
    expect(calls.rpc.map(([name]) => name)).not.toContain("record_cleaning_log")
  })

  it("DB が別世帯として拒んだ（42501）操作は rejected で、成功と返さぬ", async () => {
    signIn(household({}), () => ({ data: null, error: { code: "42501", message: "routine unavailable" } }))
    const result = await saveCleaning({ op: "state", id: ROUTINE, version: V1, action: "pause" })
    expect(result).toMatchObject({ failure: "rejected" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("B-06 対象回はサーバーが決める", () => {
  it("完了は DB の最新から計算した回と、サーバーの今日で記録する", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "saved", log: logRow(), routine: routineRow() }, error: null })),
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ status: "saved", log: { id: LOG, updated_at: V2 }, routine: { id: ROUTINE } })
    const record = calls.rpc.find(([name]) => name === "record_cleaning_log")
    expect(record?.[1]).toEqual({
      p_id: LOG,
      p_routine_id: ROUTINE,
      p_routine_version: V1,
      p_kind: "done",
      p_done_on: TODAY,
      p_occurrence: "2026-11-07",
      p_note: null,
    })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/cleaning")
  })

  it("スキップは実施日を付けずに同じ回を閉じる", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({
        data: { status: "saved", log: logRow({ kind: "skip", done_on: null }), routine: routineRow() },
        error: null,
      })),
    )
    expect(await saveCleaning(closeRequest({ kind: "skip", pressedOn: null }))).toMatchObject({ status: "saved" })
    expect(calls.rpc.find(([name]) => name === "record_cleaning_log")?.[1]).toMatchObject({
      p_kind: "skip",
      p_done_on: null,
      p_occurrence: "2026-11-07",
    })
  })

  it("画面が見ておった回が今の対象回と違えば、書かずに conflict（クライアントの回を使わぬ）", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
    )
    const result = await saveCleaning(closeRequest({ seenOccurrence: "2026-11-14" }))
    expect(result).toMatchObject({ status: "conflict", detail: "occurrence_moved", routine: { id: ROUTINE } })
    expect(calls.rpc.map(([name]) => name)).toEqual(["cleaning_log_marks"])
  })

  it("家族が先に同じ回を完了しておれば、次の回を閉じず「1 回分のまま」と返す", async () => {
    const spouseLog = logRow({ id: OTHER_LOG, created_by: SPOUSE })
    const calls = signIn(
      household({ logByOccurrence: spouseLog }),
      // 11/07 の回は閉じ済み → 今の対象回は 11/14
      marksRpc({ last_done_on: TODAY, max_occurrence: "2026-11-07", max_skip_occurrence: null }, () => ({
        data: null,
        error: { code: "XX000", message: "must not be called" },
      })),
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ status: "replayed", detail: "already_closed", log: { id: OTHER_LOG } })
    expect(calls.rpc.map(([name]) => name)).not.toContain("record_cleaning_log")
    expect(calls.from.at(-1)).toEqual({
      table: "cleaning_logs",
      filters: { household_id: HOUSE, routine_id: ROUTINE, cadence_epoch: 0, occurrence: "2026-11-07", voided_at: null },
    })
  })

  it("R16 「先に閉じたか」の読みは今の周期の世代で絞る（変更前の格子の同じ日付の閉鎖と取り違えぬ）", async () => {
    const calls = signIn(
      household({ routine: routineRow({ cadence_epoch: 3 }), logByOccurrence: null }),
      marksRpc({ last_done_on: TODAY, max_occurrence: "2026-11-07", max_skip_occurrence: null }, () => ({
        data: null,
        error: { code: "XX000", message: "must not be called" },
      })),
    )
    // 今の世代に閉鎖の行は無い → 「先に記録されていた」とは返さず、回が変わったと返す
    expect(await saveCleaning(closeRequest())).toMatchObject({ status: "conflict", detail: "occurrence_moved" })
    expect(calls.from.at(-1)?.filters).toMatchObject({ cadence_epoch: 3, occurrence: "2026-11-07" })
  })

  it("R16 定義の行から周期の世代を読めねば、世代 0 と見なさず結果不明で止める（記録の RPC を呼ばぬ）", async () => {
    for (const cadence_epoch of [undefined, null, "0", -1, 1.5]) {
      const calls = signIn(
        household({ routine: routineRow({ cadence_epoch }) }),
        marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
      )
      expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "unknown" })
      expect(calls.rpc).toEqual([])
    }
  })

  it("同時に届いた完了は DB が 1 行に確定し、2 人目は already_closed になる", async () => {
    const spouseLog = logRow({ id: OTHER_LOG, created_by: SPOUSE })
    signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "already_closed", log: spouseLog, routine: routineRow() }, error: null })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({
      status: "replayed",
      detail: "already_closed",
      log: { id: OTHER_LOG, created_by: SPOUSE },
    })
  })

  it("対照: 先に閉じたのがスキップなら、完了として成立したとは返さぬ", async () => {
    const skipped = logRow({ id: OTHER_LOG, created_by: SPOUSE, kind: "skip", done_on: null })
    signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "already_closed", log: skipped, routine: routineRow() }, error: null })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ status: "conflict", detail: "closed_differently" })
  })

  it("定義の版が違えば conflict（RPC の判定をそのまま返す）", async () => {
    signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "conflict", routine: routineRow({ updated_at: V2 }) }, error: null })),
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ status: "conflict", routine: { updated_at: V2 } })
    expect(result).not.toHaveProperty("detail")
  })

  it("休止中・アーカイブ済みの項目は完了を受けぬ", async () => {
    for (const routine of [routineRow({ paused_at: V2 }), routineRow({ archived: true })]) {
      const calls = signIn(
        household({ routine }),
        marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
      )
      expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "rejected" })
      expect(calls.rpc.map(([name]) => name)).not.toContain("record_cleaning_log")
    }
  })
})

describe("X-09 同じ操作 ID の再送", () => {
  it("既に書いた行が在れば、その行の内容で確かめ直す（日付が変わっても次の回を閉じぬ）", async () => {
    // 先の送信は 11/10 に 11/07 の回を閉じた。再送は翌日に届いた
    const mine = logRow({ done_on: "2026-11-10" })
    const calls = signIn(household({ logById: mine }), (name) =>
      name === "record_cleaning_log"
        ? { data: { status: "replayed", log: mine, routine: routineRow() }, error: null }
        : { data: null, error: { code: "XX000", message: "must not be called" } },
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ status: "replayed", log: { id: LOG, done_on: "2026-11-10" } })
    expect(result).not.toHaveProperty("detail")
    expect(calls.rpc).toEqual([
      [
        "record_cleaning_log",
        {
          p_id: LOG,
          p_routine_id: ROUTINE,
          p_routine_version: V1,
          p_kind: "done",
          p_done_on: "2026-11-10",
          p_occurrence: "2026-11-07",
          p_note: null,
        },
      ],
    ])
  })

  it("自分の記録が取り消されておれば、成功とは返さぬ", async () => {
    const mine = logRow({ voided_at: V2 })
    signIn(household({ logById: mine }), () => ({
      data: { status: "conflict", log: mine, routine: routineRow() },
      error: null,
    }))
    expect(await saveCleaning(closeRequest())).toMatchObject({ status: "conflict", detail: "voided" })
  })

  it("同じ操作 ID が別の人・別の内容の行なら、送り直しても成立せぬ衝突として返す", async () => {
    for (const existing of [
      logRow({ created_by: SPOUSE }),
      logRow({ kind: "skip", done_on: null }),
      logRow({ occurrence: null }),
    ]) {
      const calls = signIn(household({ logById: existing }), () => ({ data: null, error: null }))
      expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "conflict" })
      expect(calls.rpc).toEqual([])
    }
  })

  it("読みと書きの間に先の送信が届いた（23505）時は、既存の行から 1 度だけ確かめ直す", async () => {
    const mine = logRow()
    let landed = false
    const calls = signIn(
      (table, filters) => {
        if (table === "cleaning_logs" && !("occurrence" in filters)) return { data: landed ? mine : null, error: null }
        return household({})(table, filters)
      },
      marksRpc(null, () => {
        if (!landed) {
          landed = true
          return { data: null, error: { code: "23505", message: "request id conflict" } }
        }
        return { data: { status: "replayed", log: mine, routine: routineRow() }, error: null }
      }),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ status: "replayed", log: { id: LOG } })
    expect(calls.rpc.filter(([name]) => name === "record_cleaning_log")).toHaveLength(2)
  })

  it("対照: 確かめ直しても 23505 なら衝突として止める（繰り返さぬ）", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "23505", message: "request id conflict" } })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "conflict" })
    expect(calls.rpc.filter(([name]) => name === "record_cleaning_log")).toHaveLength(2)
  })
})

describe("X-09 結果不明", () => {
  it("SQLSTATE を持たぬ失敗（通信断・タイムアウト）は unknown", async () => {
    signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "", message: "TypeError: fetch failed" } })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("対照: SQLSTATE を持つ拒否は rejected", async () => {
    signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "23514", message: "routine paused" } })),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "rejected", error: expect.stringContaining("休止中") })
  })

  it.each([
    ["status が未知", { status: "ok", log: logRow(), routine: routineRow() }],
    ["行が無い", { status: "saved", routine: routineRow() }],
    ["別の操作の行", { status: "saved", log: logRow({ id: OTHER_LOG }), routine: routineRow() }],
    ["別の項目の定義", { status: "saved", log: logRow(), routine: routineRow({ id: OTHER_LOG }) }],
    ["null", null],
  ])("戻り値の形が読めぬ（%s）なら、成功とも拒否とも返さず unknown", async (_name, data) => {
    signIn(household({}), marksRpc(null, () => ({ data, error: null })))
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "unknown" })
  })

  it("最新の状態の読みが通信で失敗したら unknown（先の送信が届いておるかもしれぬ）", async () => {
    signIn(
      () => ({ data: null, error: { code: "", message: "fetch failed" } }),
      () => ({ data: null, error: null }),
    )
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "unknown" })
  })
})

describe("R19 完了の実施日は最初に押した日（日をまたいだ再送でも、確かめた日にせぬ）", () => {
  // 実施基準は回の鍵が今日に依らぬ（何日後に確かめ直しても、見ておった回と今の回が一致する）
  const afterDoneRoutine = () => routineRow({ schedule_mode: "after_done", anchor_date: "2026-11-07" })
  const saved = (doneOn: string) => ({
    data: { status: "saved", log: logRow({ done_on: doneOn }), routine: afterDoneRoutine() },
    error: null,
  })

  it("11/14 に押して届かなんだ完了を 11/20 に確かめ直すと、11/14 の実施として記録する", async () => {
    // 2026-11-20 12:00 JST
    vi.setSystemTime(new Date("2026-11-20T03:00:00.000Z"))
    const calls = signIn(household({ routine: afterDoneRoutine() }), marksRpc(null, () => saved("2026-11-14")))
    const result = await saveCleaning(closeRequest({ pressedOn: "2026-11-14" }))
    expect(result).toMatchObject({ status: "saved", log: { done_on: "2026-11-14" } })
    expect(calls.rpc.find(([name]) => name === "record_cleaning_log")?.[1]).toMatchObject({
      p_done_on: "2026-11-14",
      p_occurrence: "2026-11-07",
    })
  })

  it("対照: 実施日を固定できなんだ要求（null）は、サーバーが受けた日で記録する", async () => {
    vi.setSystemTime(new Date("2026-11-20T03:00:00.000Z"))
    const calls = signIn(household({ routine: afterDoneRoutine() }), marksRpc(null, () => saved("2026-11-20")))
    await saveCleaning(closeRequest({ pressedOn: null }))
    expect(calls.rpc.find(([name]) => name === "record_cleaning_log")?.[1]).toMatchObject({ p_done_on: "2026-11-20" })
  })

  it("固定した日がサーバーの今日より後なら拒み、DB を読みも書きもせぬ（未来の日を実施履歴にせぬ）", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
    )
    const result = await saveCleaning(closeRequest({ pressedOn: "2026-11-12" }))
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("日付の変わり目") })
    // 1 タップの操作に「日付を選んで」とは言わぬ
    expect(result).not.toMatchObject({ error: expect.stringContaining("選んでください") })
    expect(calls.rpc).toEqual([])
    expect(calls.from.map((call) => call.table)).toEqual(["cleaning_logs"])
  })

  it("対照: 固定した日がサーバーの今日（JST）なら未来日扱いにせぬ（UTC ではまだ前日の 00:30 JST）", async () => {
    // 2026-11-11 00:30 JST = 2026-11-10 15:30 UTC
    vi.setSystemTime(new Date("2026-11-10T15:30:00.000Z"))
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: { status: "saved", log: logRow(), routine: routineRow() }, error: null })),
    )
    expect(await saveCleaning(closeRequest({ pressedOn: TODAY }))).toMatchObject({ status: "saved" })
    expect(calls.rpc.find(([name]) => name === "record_cleaning_log")?.[1]).toMatchObject({ p_done_on: TODAY })
  })

  it("先の送信が届いておれば、要求の日付ではなく既に書いた行の実施日で確かめ直す", async () => {
    const mine = logRow({ done_on: "2026-11-10" })
    const calls = signIn(household({ logById: mine }), () => ({
      data: { status: "replayed", log: mine, routine: routineRow() },
      error: null,
    }))
    await saveCleaning(closeRequest({ pressedOn: TODAY }))
    expect(calls.rpc).toHaveLength(1)
    expect(calls.rpc[0][1]).toMatchObject({ p_done_on: "2026-11-10" })
  })

  it("R20 アプリと DB の時計が日付の境で食い違って DB が未来日と拒んだ時は、押し直しを促す文で返す", async () => {
    signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "22023", message: "done_on in the future" } })),
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("もう一度お試しください") })
    expect(result).not.toMatchObject({ error: expect.stringContaining("選んでください") })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("R18 先の回を続けて閉じた後（鍵が DB の上限を越える）は、理由の分かる文で拒む", () => {
  const afterDoneRoutine = () => routineRow({ schedule_mode: "after_done", anchor_date: TODAY })

  it("今日完了し先の 2 回をスキップした後の完了は、記録の RPC を呼ばずに理由を返す", async () => {
    // 11/18・11/25 の回をスキップ済み → 今の回の鍵は 12/02（上限は今日から 2 周期 = 11/25）
    const calls = signIn(
      household({ routine: afterDoneRoutine() }),
      marksRpc({ last_done_on: TODAY, max_occurrence: "2026-11-25", max_skip_occurrence: "2026-11-25" }, () => ({
        data: null,
        error: { code: "XX000", message: "must not be called" },
      })),
    )
    const result = await saveCleaning(closeRequest({ seenOccurrence: "2026-12-02" }))
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("先の回まで記録済み") })
    expect(result).toMatchObject({ error: expect.stringContaining("過去にやった日を記録") })
    expect(result).not.toMatchObject({ error: "入力内容を確認してください。" })
    expect(calls.rpc.map(([name]) => name)).toEqual(["cleaning_log_marks"])
  })

  it("対照: 上限ちょうどの回（2 周期先）は記録する", async () => {
    const calls = signIn(
      household({ routine: afterDoneRoutine() }),
      marksRpc({ last_done_on: TODAY, max_occurrence: "2026-11-18", max_skip_occurrence: "2026-11-18" }, () => ({
        data: {
          status: "saved",
          log: logRow({ kind: "skip", done_on: null, occurrence: "2026-11-25" }),
          routine: afterDoneRoutine(),
        },
        error: null,
      })),
    )
    expect(
      await saveCleaning(closeRequest({ kind: "skip", pressedOn: null, seenOccurrence: "2026-11-25" })),
    ).toMatchObject({ status: "saved" })
    expect(calls.rpc.find(([name]) => name === "record_cleaning_log")?.[1]).toMatchObject({ p_occurrence: "2026-11-25" })
  })

  it("DB が鍵の上限で拒んだ時（時計の食い違い等）も、同じ理由の文にする", async () => {
    signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "22023", message: "occurrence out of range" } })),
    )
    const result = await saveCleaning(closeRequest())
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("先の回まで記録済み") })
  })

  it("対照: ほかの 22023（入力の不正）は従来どおり「入力内容を確認」", async () => {
    signIn(household({}), marksRpc(null, () => ({ data: null, error: { code: "22023", message: "invalid log" } })))
    expect(await saveCleaning(closeRequest())).toMatchObject({ failure: "rejected", error: "入力内容を確認してください。" })
  })
})

describe("R15 項目ごとの履歴の追加読み込み（loadCleaningHistory）", () => {
  type Step = [string, ...unknown[]]
  function historyClient(reply: Reply) {
    const steps: Step[] = []
    const builder = {
      select: (columns: string) => (steps.push(["select", columns]), builder),
      eq: (column: string, value: unknown) => (steps.push(["eq", column, value]), builder),
      is: (column: string, value: unknown) => (steps.push(["is", column, value]), builder),
      lte: (column: string, value: unknown) => (steps.push(["lte", column, value]), builder),
      neq: (column: string, value: unknown) => (steps.push(["neq", column, value]), builder),
      order: (column: string, options: unknown) => (steps.push(["order", column, options]), builder),
      limit: async (count: number) => (steps.push(["limit", count]), reply),
    }
    const tables: string[] = []
    const supabase = { from: (table: string) => (tables.push(table), builder) }
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase, userId: USER, householdId: HOUSE },
    })
    return { steps, tables }
  }
  const idOf = (n: number) => `c3000000-0000-4000-8000-${String(n).padStart(12, "0")}`
  const at = (n: number) => `2026-01-${String(31 - n).padStart(2, "0")}T00:00:00.123456+00:00`
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      logRow({ id: idOf(100 + i), done_on: "2026-01-05", occurrence: null, created_at: at(i), updated_at: at(i) }),
    )

  it("世帯と項目で絞り、有効な記録を新しい順に 1 ページ（20 件 + 続きの検知 1 件）読む", async () => {
    const { steps, tables } = historyClient({ data: rows(3), error: null })
    const result = await loadCleaningHistory({ routineId: ROUTINE, before: null })
    expect(result).toMatchObject({ next: null })
    expect("logs" in result && result.logs.map((log) => log.id)).toEqual([idOf(100), idOf(101), idOf(102)])
    expect(tables).toEqual(["cleaning_logs"])
    expect(steps.filter(([name]) => name !== "select")).toEqual([
      ["eq", "household_id", HOUSE],
      ["eq", "routine_id", ROUTINE],
      ["is", "voided_at", null],
      ["order", "created_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 21],
    ])
    // 読み取りだけ: 画面の再検証を起こさぬ
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("続きの位置が在れば、その行より古い記録だけを読む（同じ時刻の行を落とさぬよう「以前」+ 起点の除外）", async () => {
    const before = { createdAt: "2026-02-01T00:00:00.654321+00:00", id: LOG }
    const { steps } = historyClient({ data: [], error: null })
    expect(await loadCleaningHistory({ routineId: ROUTINE, before })).toEqual({ logs: [], next: null })
    // 版・位置は表記のまま渡す（マイクロ秒を落とさぬ）
    expect(steps).toContainEqual(["lte", "created_at", "2026-02-01T00:00:00.654321+00:00"])
    expect(steps).toContainEqual(["neq", "id", LOG])
  })

  it("21 件届いたら 20 件だけ返し、続きの位置は 20 件目の行", async () => {
    historyClient({ data: rows(21), error: null })
    const result = await loadCleaningHistory({ routineId: ROUTINE, before: null })
    expect("logs" in result && result.logs).toHaveLength(20)
    expect(result).toMatchObject({ next: { createdAt: at(19), id: idOf(119) } })
  })

  it("別の項目・取り消し済み・読めぬ行は混ぜぬ", async () => {
    historyClient({
      data: [
        logRow({ id: idOf(1) }),
        logRow({ id: idOf(2), routine_id: OTHER_LOG }),
        logRow({ id: idOf(3), voided_at: V2 }),
        logRow({ id: idOf(4), done_on: "2026-02-30" }),
        null,
      ],
      error: null,
    })
    const result = await loadCleaningHistory({ routineId: ROUTINE, before: null })
    expect("logs" in result && result.logs.map((log) => log.id)).toEqual([idOf(1)])
  })

  it("読めなんだ時は失敗を返す（「記録なし」と偽らぬ）", async () => {
    historyClient({ data: null, error: { code: "", message: "fetch failed" } })
    const result = await loadCleaningHistory({ routineId: ROUTINE, before: null })
    expect(result).toEqual({ error: expect.stringContaining("履歴を読み込めませんでした") })
    expect(result).not.toHaveProperty("logs")
  })

  it("続きが在るのに位置を作れぬ（ページの最後の行が壊れておる）時は、「これで全て」と返さず失敗にする", async () => {
    const broken = rows(21)
    broken[19] = { ...broken[19], created_at: "yesterday" }
    historyClient({ data: broken, error: null })
    expect(await loadCleaningHistory({ routineId: ROUTINE, before: null })).toEqual({ error: expect.any(String) })
  })

  it("未認証・形の違う要求は DB を読まぬ（世帯 ID は受け取らぬ）", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await loadCleaningHistory({ routineId: ROUTINE, before: null })).toEqual({ error: "認証されていません" })

    const { tables } = historyClient({ data: rows(1), error: null })
    getAuthContext.mockClear()
    for (const request of [
      { routineId: "not-a-uuid", before: null },
      { routineId: ROUTINE, before: null, householdId: "c1000000-0000-4000-8000-0000000000b1" },
      { routineId: ROUTINE, before: { createdAt: "2026-02-01T00:00:00+00:00,id.neq.x", id: LOG } },
    ]) {
      expect(await loadCleaningHistory(request as never)).toEqual({ error: expect.any(String) })
    }
    expect(getAuthContext).not.toHaveBeenCalled()
    expect(tables).toEqual([])
  })
})

describe("B-07g 未来の日を実施履歴にせぬ", () => {
  const backfill = (doneOn: string): CleaningRequest => ({
    op: "backfill",
    id: LOG,
    routineId: ROUTINE,
    routineVersion: V1,
    doneOn,
    note: null,
  })

  it("過去日の追記で明日を指定したら、DB へ届く前に拒否する", async () => {
    const calls = signIn(household({}), () => ({ data: null, error: null }))
    const result = await saveCleaning(backfill("2026-11-12"))
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("未来の日付") })
    expect(calls.rpc).toEqual([])
  })

  it("対照: 今日・過去日は記録でき、回の鍵を付けぬ（現在の回を閉じぬ）", async () => {
    for (const doneOn of [TODAY, "2026-11-03"]) {
      const saved = logRow({ done_on: doneOn, occurrence: null })
      const calls = signIn(household({}), () => ({
        data: { status: "saved", log: saved, routine: routineRow() },
        error: null,
      }))
      expect(await saveCleaning(backfill(doneOn))).toMatchObject({ status: "saved", log: { occurrence: null } })
      expect(calls.rpc).toEqual([
        [
          "record_cleaning_log",
          { p_id: LOG, p_routine_id: ROUTINE, p_routine_version: V1, p_kind: "done", p_done_on: doneOn, p_occurrence: null, p_note: null },
        ],
      ])
    }
  })

  it("履歴の訂正で未来日へ動かす要求も拒否する", async () => {
    const calls = signIn(household({}), () => ({ data: null, error: null }))
    const result = await saveCleaning({ op: "log_update", id: LOG, version: V2, doneOn: "2026-11-12", note: null })
    expect(result).toMatchObject({ failure: "rejected" })
    expect(calls.rpc).toEqual([])
  })

  it("サーバーの今日は JST で決める（UTC では前日でも、JST の今日は記録できる）", async () => {
    // 2026-11-11 00:30 JST = 2026-11-10 15:30 UTC
    vi.setSystemTime(new Date("2026-11-10T15:30:00.000Z"))
    const calls = signIn(household({}), () => ({
      data: { status: "saved", log: logRow({ occurrence: null }), routine: routineRow() },
      error: null,
    }))
    expect(await saveCleaning(backfill(TODAY))).toMatchObject({ status: "saved" })
    expect(calls.rpc).toHaveLength(1)
  })

  it("DB が未来日として拒んだ時も、理由を利用者の言葉で返す", async () => {
    signIn(household({}), () => ({ data: null, error: { code: "22023", message: "done_on in the future" } }))
    expect(await saveCleaning(backfill(TODAY))).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("未来の日付"),
    })
  })
})

describe("延期", () => {
  const postpone = (over: Partial<Extract<CleaningRequest, { op: "postpone" }>> = {}): CleaningRequest => ({
    op: "postpone",
    id: ROUTINE,
    version: V1,
    seenOccurrence: "2026-11-07",
    until: "2026-11-13",
    ...over,
  })

  it("延期する回はサーバーが計算し、延期先だけを RPC へ渡す", async () => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({
        data: { status: "saved", routine: routineRow({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13", updated_at: V2 }) },
        error: null,
      })),
    )
    expect(await saveCleaning(postpone())).toMatchObject({ status: "saved", routine: { postponed_until: "2026-11-13" } })
    expect(calls.rpc.at(-1)).toEqual([
      "set_cleaning_routine_state",
      { p_id: ROUTINE, p_version: V1, p_action: "postpone", p_occurrence: "2026-11-07", p_until: "2026-11-13" },
    ])
  })

  it.each([
    ["今日", "2026-11-11"],
    ["次の予定日（固定周期は前日まで）", "2026-11-14"],
  ])("延期先が%sなら拒否する", async (_name, until) => {
    const calls = signIn(
      household({}),
      marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
    )
    expect(await saveCleaning(postpone({ until }))).toMatchObject({ failure: "rejected" })
    expect(calls.rpc.map(([name]) => name)).toEqual(["cleaning_log_marks"])
  })

  it("画面が見ておった回が違えば、書かずに conflict", async () => {
    signIn(
      household({}),
      marksRpc({ last_done_on: TODAY, max_occurrence: "2026-11-07", max_skip_occurrence: null }, () => ({
        data: null,
        error: { code: "XX000", message: "must not be called" },
      })),
    )
    expect(await saveCleaning(postpone())).toMatchObject({ status: "conflict", detail: "occurrence_moved" })
  })

  it("同じ延期が既に入っておれば replayed（日付が進んだ後の再送でも拒否にせぬ）", async () => {
    vi.setSystemTime(new Date("2026-11-13T03:00:00.000Z"))
    const calls = signIn(
      household({ routine: routineRow({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13", updated_at: V2 }) }),
      marksRpc(null, () => ({ data: null, error: { code: "XX000", message: "must not be called" } })),
    )
    expect(await saveCleaning(postpone())).toMatchObject({ status: "replayed" })
    expect(calls.rpc.map(([name]) => name)).toEqual(["cleaning_log_marks"])
  })
})

describe("定義・状態・履歴の RPC", () => {
  it("作成は前後の空白を落として渡し、返った定義を載せる", async () => {
    const calls = signIn(household({}), () => ({ data: { status: "saved", routine: routineRow() }, error: null }))
    const result = await saveCleaning({
      op: "routine",
      id: ROUTINE,
      version: null,
      name: "  浴室の排水口 ",
      location: " 浴室 ",
      cadenceUnit: "week",
      cadenceInterval: 1,
      scheduleMode: "fixed",
      anchorDate: "2026-11-07",
      archived: false,
    })
    expect(result).toMatchObject({ status: "saved", routine: { id: ROUTINE } })
    expect(calls.rpc).toEqual([
      [
        "save_cleaning_routine",
        {
          p_id: ROUTINE,
          p_version: null,
          p_name: "浴室の排水口",
          p_location: "浴室",
          p_cadence_unit: "week",
          p_cadence_interval: 1,
          p_schedule_mode: "fixed",
          p_anchor_date: "2026-11-07",
          p_archived: false,
        },
      ],
    ])
  })

  it("休止・再開・延期の解除は日付を渡さぬ", async () => {
    for (const action of ["pause", "resume", "clear_postpone"] as const) {
      const calls = signIn(household({}), () => ({ data: { status: "saved", routine: routineRow() }, error: null }))
      expect(await saveCleaning({ op: "state", id: ROUTINE, version: V1, action })).toMatchObject({ status: "saved" })
      expect(calls.rpc).toEqual([
        ["set_cleaning_routine_state", { p_id: ROUTINE, p_version: V1, p_action: action, p_occurrence: null, p_until: null }],
      ])
    }
  })

  it("取り消しと訂正は版を渡し、返った行を載せる", async () => {
    const voided = logRow({ voided_at: V2 })
    let calls = signIn(household({}), () => ({ data: { status: "saved", log: voided }, error: null }))
    expect(await saveCleaning({ op: "log_void", id: LOG, version: V2 })).toMatchObject({
      status: "saved",
      log: { voided_at: V2 },
    })
    expect(calls.rpc).toEqual([["void_cleaning_log", { p_id: LOG, p_version: V2 }]])

    calls = signIn(household({}), () => ({ data: { status: "conflict", log: logRow() }, error: null }))
    expect(
      await saveCleaning({ op: "log_update", id: LOG, version: V1, doneOn: "2026-11-10", note: " 念入りに " }),
    ).toMatchObject({ status: "conflict" })
    expect(calls.rpc).toEqual([
      ["update_cleaning_log", { p_id: LOG, p_version: V1, p_done_on: "2026-11-10", p_note: "念入りに" }],
    ])
  })

  it("項目の上限に達した時は、その理由を返す", async () => {
    signIn(household({}), () => ({ data: null, error: { code: "23514", message: "too many routines" } }))
    const result = await saveCleaning({
      op: "routine",
      id: ROUTINE,
      version: null,
      name: "窓",
      location: null,
      cadenceUnit: "year",
      cadenceInterval: 1,
      scheduleMode: "fixed",
      anchorDate: TODAY,
      archived: false,
    })
    expect(result).toMatchObject({ failure: "rejected", error: expect.stringContaining("上限") })
  })
})
