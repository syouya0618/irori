/**
 * 掃除の保存の形（要求の型ガード・行の読み取り・延期の範囲・テンプレート）の契約。
 *
 * 暦の前提: 2026-11-11 は水曜。2026-11-07 / 11-14 は土曜。
 */
import { describe, expect, it } from "vitest"
import {
  cadenceIntervalOptions,
  CLEANING_LOG_COLUMNS,
  CLEANING_ROUTINE_COLUMNS,
  compareCleaningLogsNewestFirst,
  daysAgoJa,
  daysUntilJa,
  freezePressedOn,
  isCleaningHistoryRequest,
  isCleaningRequest,
  labelOfCleaningRequest,
  normalizeOptionalText,
  oldestCleaningLogCursor,
  parseCleaningLog,
  parseCleaningMarksRow,
  parseCleaningRoutine,
  postponeRangeOf,
  type CleaningRequest,
} from "../cleaning"
import {
  describeCadence,
  EMPTY_CLEANING_MARKS,
  isCadenceInterval,
  routineStatusFromMarks,
  type CleaningRoutine,
} from "../cleaning-schedule"
import { CLEANING_TEMPLATES } from "../cleaning-templates"

const ROUTINE = "c2000000-0000-4000-8000-000000000001"
const LOG = "c3000000-0000-4000-8000-000000000001"
const V = "2026-11-01T00:00:00.123456+00:00"
const WED = "2026-11-11"

const routineRequest: CleaningRequest = {
  op: "routine",
  id: ROUTINE,
  version: null,
  name: "浴室の排水口",
  location: null,
  cadenceUnit: "week",
  cadenceInterval: 1,
  scheduleMode: "fixed",
  anchorDate: "2026-11-07",
  archived: false,
}
const valid: CleaningRequest[] = [
  routineRequest,
  { ...routineRequest, version: V, archived: true, location: "浴室" },
  { op: "state", id: ROUTINE, version: V, action: "pause" },
  { op: "state", id: ROUTINE, version: V, action: "resume" },
  { op: "state", id: ROUTINE, version: V, action: "clear_postpone" },
  { op: "postpone", id: ROUTINE, version: V, seenOccurrence: "2026-11-07", until: "2026-11-13" },
  { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: "2026-11-07", pressedOn: WED },
  { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "skip", seenOccurrence: "2026-11-07", pressedOn: null },
  { op: "backfill", id: LOG, routineId: ROUTINE, routineVersion: V, doneOn: "2026-11-03", note: null },
  { op: "backfill", id: LOG, routineId: ROUTINE, routineVersion: V, doneOn: "2026-11-03", note: "念入りに" },
  { op: "log_update", id: LOG, version: V, doneOn: "2026-11-03", note: null },
  { op: "log_update", id: LOG, version: V, doneOn: null, note: "見送り" },
  { op: "log_void", id: LOG, version: V },
  // 実施日を固定できなんだ完了（画面の今日と端末の日付が食い違った）は null を明示する
  { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: "2026-11-07", pressedOn: null },
]

describe("isCleaningRequest", () => {
  it.each(valid.map((request) => [`${request.op}${"action" in request ? `:${request.action}` : ""}`, request]))(
    "正しい要求（%s）を受ける",
    (_name, request) => {
      expect(isCleaningRequest(request)).toBe(true)
      // 端末の控えは JSON で往復する。往復しても同じ判定になる
      expect(isCleaningRequest(JSON.parse(JSON.stringify(request)))).toBe(true)
    },
  )

  it("余分な項目（世帯 ID・実施日・回の鍵の上書き）を持つ要求を受けぬ", () => {
    for (const request of valid) {
      expect(isCleaningRequest({ ...request, householdId: "c1000000-0000-4000-8000-0000000000a1" })).toBe(false)
    }
    const close = valid[6]
    expect(isCleaningRequest({ ...close, doneOn: "2026-11-01" })).toBe(false)
    expect(isCleaningRequest({ ...close, occurrence: "2026-11-07" })).toBe(false)
  })

  it.each([
    ["null", null],
    ["配列", []],
    ["未知の操作", { op: "truncate", id: ROUTINE }],
    ["UUID でない ID", { ...routineRequest, id: "1" }],
    ["空の名前", { ...routineRequest, name: "   " }],
    ["61 文字の名前", { ...routineRequest, name: "あ".repeat(61) }],
    ["改行を含む名前", { ...routineRequest, name: "浴室\nの排水口" }],
    ["空文字の場所（無いなら null）", { ...routineRequest, location: "" }],
    ["41 文字の場所", { ...routineRequest, location: "あ".repeat(41) }],
    ["未知の単位", { ...routineRequest, cadenceUnit: "day" }],
    ["未知の方式", { ...routineRequest, scheduleMode: "weekly" }],
    ["0 の間隔", { ...routineRequest, cadenceInterval: 0 }],
    ["小数の間隔", { ...routineRequest, cadenceInterval: 1.5 }],
    ["文字列の間隔", { ...routineRequest, cadenceInterval: "1" }],
    ["月の上限を越える間隔", { ...routineRequest, cadenceUnit: "month", cadenceInterval: 25 }],
    ["実在せぬ基準日", { ...routineRequest, anchorDate: "2026-02-30" }],
    ["範囲外の基準日", { ...routineRequest, anchorDate: "1999-12-31" }],
    ["作成と同時のアーカイブ", { ...routineRequest, archived: true }],
    ["版が Date へ通された形", { ...routineRequest, version: "Sun Nov 01 2026" }],
    ["版の無い状態変更", { op: "state", id: ROUTINE, version: null, action: "pause" }],
    ["state に postpone を混ぜる", { op: "state", id: ROUTINE, version: V, action: "postpone" }],
    ["延期先の無い延期", { op: "postpone", id: ROUTINE, version: V, seenOccurrence: "2026-11-07", until: null }],
    ["未知の種類の完了", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "undo", seenOccurrence: "2026-11-07", pressedOn: null }],
    ["回の無い完了", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: null, pressedOn: WED }],
    ["固定した実施日の項目が無い完了", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: "2026-11-07" }],
    ["実在せぬ日を固定した完了", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: "2026-11-07", pressedOn: "2026-02-30" }],
    ["時刻つきの値を固定した完了", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "done", seenOccurrence: "2026-11-07", pressedOn: "2026-11-11T03:00:00Z" }],
    ["実施日を持つスキップ", { op: "close", id: LOG, routineId: ROUTINE, routineVersion: V, kind: "skip", seenOccurrence: "2026-11-07", pressedOn: WED }],
    ["実施日の無い追記", { op: "backfill", id: LOG, routineId: ROUTINE, routineVersion: V, doneOn: null, note: null }],
    ["201 文字のメモ", { op: "backfill", id: LOG, routineId: ROUTINE, routineVersion: V, doneOn: WED, note: "あ".repeat(201) }],
    ["版の無い取り消し", { op: "log_void", id: LOG, version: undefined }],
  ])("不正な要求（%s）を拒む", (_name, request) => {
    expect(isCleaningRequest(request)).toBe(false)
  })

  it("B-02 週・月・年 × 固定 / 実施基準の 6 通りを全て受け、どれも読み下せて最初の予定日が決まる", () => {
    for (const cadenceUnit of ["week", "month", "year"] as const) {
      for (const scheduleMode of ["fixed", "after_done"] as const) {
        expect(isCleaningRequest({ ...routineRequest, cadenceUnit, scheduleMode, anchorDate: "2026-11-14" })).toBe(true)
        const schedule = {
          cadence_unit: cadenceUnit,
          cadence_interval: 1,
          schedule_mode: scheduleMode,
          anchor_date: "2026-11-14",
        }
        expect(describeCadence(schedule)).not.toBeNull()
        const status = routineStatusFromMarks(
          { ...schedule, postponed_occurrence: null, postponed_until: null, paused_at: null, resume_floor: null },
          EMPTY_CLEANING_MARKS,
          WED,
        )
        expect(status.dueOn).toBe("2026-11-14")
        expect(status.lastDoneOn).toBeNull()
      }
    }
  })

  it("長さは文字数で数える（60 文字ちょうど・絵文字を含まぬ合成文字は通る）", () => {
    expect(isCleaningRequest({ ...routineRequest, name: "あ".repeat(60) })).toBe(true)
    expect(isCleaningRequest({ ...routineRequest, name: "𠮷".repeat(60) })).toBe(true)
  })

  it("型ガードは時刻に依らぬ（未来日の検証は Action と RPC が行う）", () => {
    expect(
      isCleaningRequest({ op: "backfill", id: LOG, routineId: ROUTINE, routineVersion: V, doneOn: "2999-01-01", note: null }),
    ).toBe(true)
    // 固定した実施日も同じ: 何日も前に押した控えを、日付が変わっただけで読めぬ扱いにせぬ
    expect(isCleaningRequest({ ...valid[6], pressedOn: "2026-10-01" })).toBe(true)
  })
})

describe("R19 完了の実施日は最初の押下で固定する（freezePressedOn）", () => {
  it("画面の今日（サーバー由来）が端末の日付と合う時だけ、その日を固定する", () => {
    expect(freezePressedOn(WED, WED)).toBe(WED)
  })

  it("食い違う時は固定せぬ（null = サーバーが受けた日。古い画面の日付・ずれた端末の日付で記録せぬ）", () => {
    // 日付をまたいで開いたままの画面
    expect(freezePressedOn("2026-11-10", WED)).toBeNull()
    // 端末の時計が進んでおる / 遅れておる
    expect(freezePressedOn(WED, "2026-11-12")).toBeNull()
    expect(freezePressedOn(WED, "2026-11-10")).toBeNull()
  })

  it("画面の今日が日付として読めぬ時も固定せぬ", () => {
    expect(freezePressedOn("", "")).toBeNull()
    expect(freezePressedOn("2026-02-30", "2026-02-30")).toBeNull()
  })
})

describe("R15 項目ごとの履歴の追加読み込み", () => {
  const OLDER = "c3000000-0000-4000-8000-000000000002"
  const logAt = (id: string, createdAt: string, doneOn = WED) => ({
    id,
    routine_id: ROUTINE,
    kind: "done" as const,
    done_on: doneOn,
    occurrence: null,
    note: null,
    voided_at: null,
    created_by: null,
    updated_at: createdAt,
    created_at: createdAt,
  })

  it("要求の形: 項目 ID と、続きの位置（無ければ null）だけを受ける", () => {
    expect(isCleaningHistoryRequest({ routineId: ROUTINE, before: null })).toBe(true)
    expect(isCleaningHistoryRequest({ routineId: ROUTINE, before: { createdAt: V, id: LOG } })).toBe(true)
    expect(isCleaningHistoryRequest(JSON.parse(JSON.stringify({ routineId: ROUTINE, before: { createdAt: V, id: LOG } })))).toBe(true)
  })

  it.each([
    ["null", null],
    ["項目 ID が UUID でない", { routineId: "1", before: null }],
    ["位置が無い（null を明示せぬ）", { routineId: ROUTINE }],
    ["世帯 ID を紛れ込ませる", { routineId: ROUTINE, before: null, householdId: "c1000000-0000-4000-8000-0000000000a1" }],
    ["位置の時刻が Date を通した形", { routineId: ROUTINE, before: { createdAt: "Sun Nov 01 2026", id: LOG } }],
    ["位置の時刻に絞り込みの構文を混ぜる", { routineId: ROUTINE, before: { createdAt: `${V},id.neq.x`, id: LOG } }],
    ["位置の ID が UUID でない", { routineId: ROUTINE, before: { createdAt: V, id: "x" } }],
    ["位置に余分な項目", { routineId: ROUTINE, before: { createdAt: V, id: LOG, limit: 9999 } }],
  ])("不正な要求（%s）を拒む", (_name, request) => {
    expect(isCleaningHistoryRequest(request)).toBe(false)
  })

  it("続きの位置は、読み込み済みの中で記録した時刻が最も古い行（表記のまま運ぶ）", () => {
    const newest = logAt(LOG, "2026-11-11T02:00:00.654321+00:00")
    // 実施日は新しいが、記録したのは最も古い（あとから訂正した・過去日を先に記録した）
    const oldest = logAt(OLDER, "2026-01-05T09:30:00.000123+00:00", "2026-11-10")
    expect(oldestCleaningLogCursor([newest, oldest])).toEqual({ createdAt: "2026-01-05T09:30:00.000123+00:00", id: OLDER })
    expect(oldestCleaningLogCursor([oldest, newest])).toEqual({ createdAt: "2026-01-05T09:30:00.000123+00:00", id: OLDER })
  })

  it("1 件も無ければ null（最も新しい記録から読む）。時刻を読めぬ行は位置にせぬ", () => {
    expect(oldestCleaningLogCursor([])).toBeNull()
    expect(oldestCleaningLogCursor([logAt(LOG, "not a time")])).toBeNull()
    expect(oldestCleaningLogCursor([logAt(LOG, "not a time"), logAt(OLDER, V)])).toEqual({ createdAt: V, id: OLDER })
  })

  it("履歴は実施日の新しい順、同じ日は記録した順に並べる", () => {
    const a = logAt(LOG, "2026-11-01T00:00:00.000000+00:00", "2026-11-01")
    const b = logAt(OLDER, "2026-11-02T00:00:00.000000+00:00", "2026-10-20")
    const c = { ...logAt("c3000000-0000-4000-8000-000000000003", "2026-11-03T00:00:00.000000+00:00"), done_on: "2026-11-01" }
    expect([b, a, c].sort(compareCleaningLogsNewestFirst).map((log) => log.id)).toEqual([c.id, a.id, b.id])
  })
})

function routineRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROUTINE,
    household_id: "c1000000-0000-4000-8000-0000000000a1",
    name: "浴室の排水口",
    location: null,
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-07",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: "2026-11-01",
    archived: false,
    updated_at: V,
    created_at: V,
    ...over,
  }
}

describe("parseCleaningRoutine", () => {
  it("DB の行を読み、版は表記のまま運ぶ。知らぬ列（household_id 等）は写さぬ", () => {
    const routine = parseCleaningRoutine(routineRow())
    expect(routine).toMatchObject({ id: ROUTINE, name: "浴室の排水口", resume_floor: "2026-11-01", updated_at: V })
    expect(routine).not.toHaveProperty("household_id")
  })

  it.each([
    ["この版が知らぬ単位", { cadence_unit: "day" }],
    ["この版が知らぬ方式", { schedule_mode: "seasonal" }],
    ["範囲外の間隔", { cadence_interval: 99 }],
    ["壊れた基準日", { anchor_date: "2026-13-01" }],
    ["壊れた延期先", { postponed_occurrence: "2026-11-07", postponed_until: "soon" }],
    ["版が無い", { updated_at: null }],
    ["ID が無い", { id: null }],
  ])("%s の行は null（その行だけを読めぬ項目として数える）", (_name, over) => {
    expect(parseCleaningRoutine(routineRow(over))).toBeNull()
  })

  it("延期は対で入っておる時だけ読む（片方だけなら延期なし）", () => {
    expect(
      parseCleaningRoutine(routineRow({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" })),
    ).toMatchObject({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" })
    expect(parseCleaningRoutine(routineRow({ postponed_occurrence: "2026-11-07" }))).toMatchObject({
      postponed_occurrence: null,
      postponed_until: null,
    })
  })

  it("列の定数は、読み取りに要る列を全て含む", () => {
    for (const column of Object.keys(routineRow()).filter((key) => key !== "household_id")) {
      expect(CLEANING_ROUTINE_COLUMNS.split(", ")).toContain(column)
    }
    expect(CLEANING_LOG_COLUMNS.split(", ")).toEqual(
      expect.arrayContaining(["id", "routine_id", "kind", "done_on", "occurrence", "voided_at", "updated_at"]),
    )
  })
})

describe("parseCleaningLog / parseCleaningMarksRow", () => {
  const row = {
    id: LOG,
    routine_id: ROUTINE,
    kind: "done",
    done_on: WED,
    occurrence: "2026-11-07",
    note: null,
    voided_at: null,
    created_by: null,
    updated_at: V,
    created_at: V,
  }

  it("履歴の行を読む", () => {
    expect(parseCleaningLog(row)).toEqual(row)
  })

  it("この版が知らぬ種類は other へ退化させ、実施（done）とは読まぬ", () => {
    expect(parseCleaningLog({ ...row, kind: "delegated" })).toMatchObject({ kind: "other" })
    // 対照: 既知の種類はそのまま
    expect(parseCleaningLog({ ...row, kind: "skip", done_on: null })).toMatchObject({ kind: "skip" })
  })

  it("必須の列が欠ける・日付が壊れた行は null", () => {
    expect(parseCleaningLog({ ...row, routine_id: null })).toBeNull()
    expect(parseCleaningLog({ ...row, done_on: "2026-02-30" })).toBeNull()
    expect(parseCleaningLog({ ...row, updated_at: 1 })).toBeNull()
    expect(parseCleaningLog(null)).toBeNull()
  })

  it("要約の行を読む。壊れた日付は「履歴なし」にせず null（読めぬ）", () => {
    expect(
      parseCleaningMarksRow({ routine_id: ROUTINE, last_done_on: WED, max_occurrence: "2026-11-07", max_skip_occurrence: null }),
    ).toEqual({ routineId: ROUTINE, marks: { lastDoneOn: WED, maxOccurrence: "2026-11-07", maxSkipOccurrence: null } })
    expect(
      parseCleaningMarksRow({ routine_id: ROUTINE, last_done_on: "yesterday", max_occurrence: null, max_skip_occurrence: null }),
    ).toBeNull()
    expect(parseCleaningMarksRow({ last_done_on: WED })).toBeNull()
  })

  it("B-07f スキップの予定日を読む（持たぬ行には載せず、壊れた日付の行は読めぬ）", () => {
    const skipped = { ...row, kind: "skip", done_on: null, occurrence: "2026-11-12", scheduled_on: WED }
    expect(parseCleaningLog(skipped)).toMatchObject({ kind: "skip", occurrence: "2026-11-12", scheduled_on: WED })
    // done（予定日なし）は鍵へ退化する形のまま
    expect(parseCleaningLog({ ...row, scheduled_on: null })).not.toHaveProperty("scheduled_on")
    expect(parseCleaningLog({ ...skipped, scheduled_on: "2026-02-30" })).toBeNull()
    expect(CLEANING_LOG_COLUMNS.split(", ")).toContain("scheduled_on")

    const marks = { routine_id: ROUTINE, last_done_on: "2026-11-04", max_occurrence: "2026-11-12", max_skip_occurrence: "2026-11-12" }
    expect(parseCleaningMarksRow({ ...marks, last_skip_scheduled_on: WED })).toEqual({
      routineId: ROUTINE,
      marks: { lastDoneOn: "2026-11-04", maxOccurrence: "2026-11-12", maxSkipOccurrence: "2026-11-12", lastSkipScheduledOn: WED },
    })
    expect(parseCleaningMarksRow({ ...marks, last_skip_scheduled_on: null })?.marks).not.toHaveProperty("lastSkipScheduledOn")
    expect(parseCleaningMarksRow({ ...marks, last_skip_scheduled_on: "yesterday" })).toBeNull()
  })
})

function routine(over: Partial<CleaningRoutine> = {}): CleaningRoutine {
  return parseCleaningRoutine(routineRow({ resume_floor: null, ...over })) as CleaningRoutine
}

describe("postponeRangeOf（延期は現在の回の期限だけを動かす）", () => {
  it("固定: 明日から、次の予定日の前日まで", () => {
    const r = routine()
    const status = routineStatusFromMarks(r, EMPTY_CLEANING_MARKS, WED)
    expect(status.currentOccurrence).toBe("2026-11-07")
    expect(postponeRangeOf(r, status, WED)).toEqual({ min: "2026-11-12", max: "2026-11-13", nextScheduledOn: "2026-11-14" })
  })

  it("固定: 次の予定日が明日なら、延期できる日が無い（max < min）", () => {
    const r = routine()
    const status = routineStatusFromMarks(r, EMPTY_CLEANING_MARKS, "2026-11-13")
    const range = postponeRangeOf(r, status, "2026-11-13")
    expect(range).not.toBeNull()
    expect((range?.max ?? "") < (range?.min ?? "")).toBe(true)
  })

  it("固定: まだ先の回は、その予定日の翌日から", () => {
    const r = routine({ anchor_date: "2026-11-14" })
    const status = routineStatusFromMarks(r, EMPTY_CLEANING_MARKS, WED)
    expect(postponeRangeOf(r, status, WED)).toEqual({ min: "2026-11-15", max: "2026-11-20", nextScheduledOn: "2026-11-21" })
  })

  it("実施基準: 次の回が無い（実施で決まる）ゆえ、上限は今日から 366 日", () => {
    const r = routine({ schedule_mode: "after_done", anchor_date: WED })
    const status = routineStatusFromMarks(r, EMPTY_CLEANING_MARKS, WED)
    expect(postponeRangeOf(r, status, WED)).toEqual({ min: "2026-11-12", max: "2027-11-12", nextScheduledOn: null })
  })

  it("休止中は延期できぬ", () => {
    const r = routine({ paused_at: V })
    expect(postponeRangeOf(r, routineStatusFromMarks(r, EMPTY_CLEANING_MARKS, WED), WED)).toBeNull()
  })
})

describe("文言", () => {
  it("操作の説明は項目名を含み、長い名前は切り詰める", () => {
    expect(labelOfCleaningRequest(valid[0], "浴室の排水口")).toBe("「浴室の排水口」を追加")
    expect(labelOfCleaningRequest(valid[1], "浴室の排水口")).toBe("「浴室の排水口」をアーカイブ")
    expect(labelOfCleaningRequest(valid[6], "浴室の排水口")).toBe("「浴室の排水口」を完了")
    expect(labelOfCleaningRequest(valid[7], "浴室の排水口")).toBe("「浴室の排水口」をスキップ")
    expect(labelOfCleaningRequest(valid[12], "")).toBe("「掃除の項目」の記録を取り消し")
    // 端末の控えの説明は 80 文字まで
    for (const request of valid) {
      expect(labelOfCleaningRequest(request, "あ".repeat(60)).length).toBeLessThanOrEqual(80)
    }
  })

  it("日数の言い方", () => {
    expect([daysAgoJa(0), daysAgoJa(1), daysAgoJa(10)]).toEqual(["今日", "昨日", "10日前"])
    expect([daysUntilJa(0), daysUntilJa(1), daysUntilJa(3)]).toEqual(["今日", "明日", "3日後"])
  })

  it("空欄は null に、前後の空白は落とす", () => {
    expect(normalizeOptionalText("   ")).toBeNull()
    expect(normalizeOptionalText(" 浴室 ")).toBe("浴室")
  })

  it("間隔の選択肢は単位ごとの上限まで（DB の CHECK と同じ）", () => {
    expect(cadenceIntervalOptions("week")).toHaveLength(52)
    expect(cadenceIntervalOptions("month")).toHaveLength(24)
    expect(cadenceIntervalOptions("year").map((option) => option.label)).toEqual([
      "1年", "2年", "3年", "4年", "5年", "6年", "7年", "8年", "9年", "10年",
    ])
  })
})

describe("B-08 テンプレートは入力欄を埋めるだけ", () => {
  it("10 件前後あり、鍵と名前が重複せぬ", () => {
    expect(CLEANING_TEMPLATES.length).toBeGreaterThanOrEqual(10)
    expect(CLEANING_TEMPLATES.length).toBeLessThanOrEqual(14)
    expect(new Set(CLEANING_TEMPLATES.map((t) => t.key)).size).toBe(CLEANING_TEMPLATES.length)
    expect(new Set(CLEANING_TEMPLATES.map((t) => t.name)).size).toBe(CLEANING_TEMPLATES.length)
  })

  it("どのテンプレートも、基準日を足せばそのまま保存できる値で、絵文字を含まぬ", () => {
    for (const template of CLEANING_TEMPLATES) {
      expect(isCadenceInterval(template.cadenceUnit, template.cadenceInterval)).toBe(true)
      const request = {
        ...routineRequest,
        name: template.name,
        location: normalizeOptionalText(template.location),
        cadenceUnit: template.cadenceUnit,
        cadenceInterval: template.cadenceInterval,
        scheduleMode: template.scheduleMode,
      }
      expect(isCleaningRequest(request)).toBe(true)
      expect(
        describeCadence({
          cadence_unit: template.cadenceUnit,
          cadence_interval: template.cadenceInterval,
          schedule_mode: template.scheduleMode,
          anchor_date: "2026-11-07",
        }),
      ).not.toBeNull()
      expect(`${template.name}${template.location}`).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it("テンプレートは実施日・基準日・履歴を持たぬ（選んでも実績は作られぬ）", () => {
    for (const template of CLEANING_TEMPLATES) {
      expect(Object.keys(template).sort()).toEqual(
        ["cadenceInterval", "cadenceUnit", "key", "location", "name", "scheduleMode"].sort(),
      )
    }
  })

  it("週・月・年の全ての単位と、2 つの方式を含む", () => {
    expect(new Set(CLEANING_TEMPLATES.map((t) => t.cadenceUnit))).toEqual(new Set(["week", "month", "year"]))
    expect(new Set(CLEANING_TEMPLATES.map((t) => t.scheduleMode))).toEqual(new Set(["fixed", "after_done"]))
  })
})
