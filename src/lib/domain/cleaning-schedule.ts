/**
 * 掃除ルーティーンの周期計算（純関数・中立モジュール）。
 *
 * 境界指令を持たぬゆえ、Server Component / Server Action / Client Component のどこからでも
 * 値 import できる。日付は "YYYY-MM-DD"（JST 暦日）の文字列だけで扱い、`Date` へ日付文字列を
 * 渡さぬ（`@/lib/utils/date-jst` と `@/lib/domain/ymd-math` だけを使う）。
 *
 * ## 定義と履歴の分離
 * 周期の定義は `cleaning_routines`、実績は `cleaning_logs`。**前回実施日の正本は有効な履歴**
 * （取り消されておらぬ `done` の最大 `done_on`）で、定義側に写しを持たぬ。履歴が無ければ
 * `lastDoneOn` は null（「未記録」。作成日を実施日に見立てぬ）。
 *
 * ## 周期の規則
 * - **fixed**（固定した曜日・日付）: 予定日は**元の基準日**から毎回生成する。週 = 7×n 日、
 *   月 = 基準日の「日」を保ち無い月は末日、年 = 基準の月日で 2/29 は平年 2/28。寄せた結果を
 *   次の起点にせぬゆえ、1/31 → 2/28 → 3/31 と戻り、永久にずれぬ。
 *   - 対象回 = 今日以前で最も新しい未完了の予定日（無ければ次の予定日）
 *   - 完了はその回だけを閉じ、次回は「閉じた回より後で今日より後の最初の予定日」。途中で
 *     逃した回を実施済みにはせぬ（履歴を作らぬ）。最後に閉じた回より前の回は対象から外れる
 *   - 期限超過日数は「最も古い未完了の予定日」から数える
 *   - 過去日の追記（`occurrence` が null の履歴）は回を閉じぬ
 * - **after_done**（実施から一定期間後）: 予定日 = 最後の起点 + 周期。起点は**最後の閉鎖**で
 *   決める — 最後に回を閉じたのが `done` なら前回実施日、`skip` ならその回の**予定日**（延期前）。
 *   「日付の大きい方」ではない: 先の回をスキップした後に早めに実施したら、次回は実施日から数える
 *   （スキップした予定日からではない）。鍵は閉じるたびに必ず前の鍵より後ろになるゆえ、最大の鍵が
 *   スキップの鍵と一致する時だけ「最後の閉鎖はスキップ」と判る。月・年は暦で足し（30 日・365 日へ
 *   換算せぬ）、実施日が新しい基準になる。履歴が無ければ基準日。
 *   - スキップの起点は鍵ではない（B-07f）: 鍵は予定日から逃げうる（下の「回の鍵」）。スキップの履歴は
 *     DB（`record_cleaning_log`）が計算した予定日（`scheduled_on`）を持ち、要約は
 *     `lastSkipScheduledOn` で運ぶ。予定日を持たぬ要約・履歴（この版が知らぬ種類の閉鎖）だけ鍵へ退化する
 * - **延期**は現在の回の期限だけを動かす（基準日・前回実施日は不変。次の回には及ばぬ）。
 * - **スキップ**は回を閉じるが実施ではない（前回実施日は動かぬ）。
 * - **休止**中は期限を数えぬ。`resume_floor`（作成・周期変更・再開の日）より前の予定日は
 *   対象にせぬ（作成前・休止中の回を「期限超過」として積み上げぬ）。
 *
 * ## 回の鍵（`currentOccurrence`）
 * 「同じ回」を DB の一意制約（routine_id, occurrence）で 1 行に確定するための鍵じゃ。必ず
 * **まだ閉じておらぬ日付**になるよう、最後に閉じた回より後の値を返す（閉じた回と同じ鍵を
 * 返すと、その項目は二度と完了できなくなる）。after_done では表示上の期限と 1 日ずれうる
 * （早めに実施して次の期限が閉じた回の日付に重なった時）。鍵は表示に使わぬこと。
 *
 * ## 鍵は周期の世代（`cadence_epoch`）の中でだけ意味を持つ
 * 周期（単位・間隔・方式・基準日）を変えると、DB は定義の世代を 1 進める。`CleaningMarks` の
 * `maxOccurrence` / `maxSkipOccurrence` は **今の世代で閉じた回だけ**から取る（`cleaning_log_marks`）。
 * 変更前の格子で閉じた鍵を数えると、新しい格子の予定日がその鍵に覆われて黙って飛ぶ
 * （毎月 30 日の回を早めに完了 → 毎週土曜へ変更 → 12 月まで予定が出ぬ）。前回実施日は全ての世代の
 * 有効な履歴から取る（実施した事実は周期を変えても変わらぬ）。
 *
 * ## 閉じられる回の上限（`closeKeyLimit`）
 * DB（`record_cleaning_log`）は、今日（基準日が未来なら基準日）から 2 周期より先の鍵を拒む
 * （遠い未来の鍵で項目を黙らせぬため）。先の回を続けて閉じると現在の回の鍵がこの上限を越えうる。
 * その時は `closeLimitReached` を立て、画面と Action が「予定日が近づくまで閉じられぬ」と理由を言う
 * （DB の拒否を「入力内容を確認してください」として見せぬ）。
 */
import { daysBetweenYmd, isValidYmd, shiftYmd } from "@/lib/utils/date-jst"
import { addMonthsClamped, addYearsClamped, weekEndSunday, weekdayOfYmd } from "@/lib/domain/ymd-math"

export const CADENCE_UNITS = ["week", "month", "year"] as const
export type CadenceUnit = (typeof CADENCE_UNITS)[number]

export const SCHEDULE_MODES = ["fixed", "after_done"] as const
export type ScheduleMode = (typeof SCHEDULE_MODES)[number]

/** 周期の間隔の上限（DB の CHECK と同じ値。変える時は migration も変える）。 */
export const CADENCE_INTERVAL_MAX: Record<CadenceUnit, number> = { week: 52, month: 24, year: 10 }

export function isCadenceUnit(value: unknown): value is CadenceUnit {
  return typeof value === "string" && (CADENCE_UNITS as readonly string[]).includes(value)
}

export function isScheduleMode(value: unknown): value is ScheduleMode {
  return typeof value === "string" && (SCHEDULE_MODES as readonly string[]).includes(value)
}

export function isCadenceInterval(unit: CadenceUnit, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= CADENCE_INTERVAL_MAX[unit]
}

/** 周期の定義（予定日を決める 4 項目）。 */
export interface CleaningSchedule {
  cadence_unit: CadenceUnit
  cadence_interval: number
  schedule_mode: ScheduleMode
  /** fixed: 曜日・日付の基準。after_done: 履歴が無い間の最初の予定日 */
  anchor_date: string
}

/** `cleaning_routines` の行（DB の列名のまま運ぶ）。 */
export interface CleaningRoutine extends CleaningSchedule {
  id: string
  name: string
  location: string | null
  /** 延期した回の鍵。`postponed_until` と必ず対で入る */
  postponed_occurrence: string | null
  postponed_until: string | null
  /** 休止した時刻（timestamptz）。null なら稼働中 */
  paused_at: string | null
  /** この日より前の予定日は対象にせぬ（作成・周期変更・再開の日） */
  resume_floor: string | null
  archived: boolean
  /** 版（PostgREST の表記のまま運ぶ。丸めぬ） */
  updated_at: string
  created_at: string
}

/**
 * 履歴の種類。`other` は、この版が知らぬ種類（DB に種類が増えた時の退化先）じゃ。
 * 回を閉じる効果は持つが、実施としては数えぬ（未知の値で画面を倒さず、実施と偽りもせぬ）。
 */
export type CleaningLogKind = "done" | "skip" | "other"

/** `cleaning_logs` の行。 */
export interface CleaningLog {
  id: string
  routine_id: string
  kind: CleaningLogKind
  /** 実施日（done だけが持つ） */
  done_on: string | null
  /** 閉じた回の鍵。過去日の追記は null（回を閉じぬ） */
  occurrence: string | null
  /**
   * スキップした回の予定日（延期前。skip だけが持つ。DB が計算して入れる）。実施基準の鍵は予定日から
   * 逃げうるゆえ、スキップの後の次回はこちらから数える。無ければ（done・この版が知らぬ種類）鍵へ退化
   */
  scheduled_on?: string | null
  note: string | null
  /** 取り消した時刻。null なら有効 */
  voided_at: string | null
  created_by: string | null
  updated_at: string
  created_at: string
}

/** 有効な履歴から周期計算に要る値だけを抜いたもの（全履歴を運ばずに済むよう、DB でも集計できる形）。 */
export interface CleaningMarks {
  /** 有効な done の最大 done_on（= 前回実施日。周期の世代に依らぬ） */
  lastDoneOn: string | null
  /** 今の周期の世代で、有効な履歴が閉じた回の鍵の最大 */
  maxOccurrence: string | null
  /** 今の周期の世代で、有効な「実施でない閉鎖」（skip 等）の鍵の最大 */
  maxSkipOccurrence: string | null
  /**
   * `maxSkipOccurrence` の回の予定日（延期前。DB の `cleaning_log_marks.last_skip_scheduled_on`）。
   * 実施基準でスキップが最後の閉鎖なら、次回はここから数える。無ければ鍵へ退化する
   */
  lastSkipScheduledOn?: string | null
}

export const EMPTY_CLEANING_MARKS: CleaningMarks = { lastDoneOn: null, maxOccurrence: null, maxSkipOccurrence: null }

/** 周期計算が読む routine の項目。 */
export type RoutineScheduleState = CleaningSchedule &
  Pick<CleaningRoutine, "postponed_occurrence" | "postponed_until" | "paused_at" | "resume_floor">

export interface RoutineStatus {
  /** 前回実施日。null は「未記録」 */
  lastDoneOn: string | null
  /** 前回実施日から今日までの暦日数。未記録なら null */
  daysSinceLastDone: number | null
  /** 閉じる対象回の鍵（表示には使わぬ）。休止中・計算できぬ時は null */
  currentOccurrence: string | null
  /** 延期を反映する前の予定日（fixed で複数回逃していれば最も古い未完了の予定日） */
  scheduledOn: string | null
  /** 延期を反映した表示上の期限 */
  dueOn: string | null
  /** 期限を過ぎた暦日数（過ぎておらねば 0） */
  overdueDays: number
  /** 未完了のまま期日を迎えた回の数（fixed で数周期遅れた時に 2 以上） */
  openCount: number
  isPaused: boolean
  /** 現在の回が延期されておるか */
  postponed: boolean
  /**
   * 現在の回の鍵が、閉じられる回の上限（`closeKeyLimit`）を越えておる。先の回を続けて閉じた後で、
   * 予定日が近づくまで完了・スキップを受けられぬ（DB が拒む）。休止中・計算できぬ時は false
   */
  closeLimitReached: boolean
  /**
   * 現在の回を `doneOn` に実施して閉じた時の、次回の予定日。計算できねば null。
   * fixed は実施日に依らず次の未来の予定日、after_done は実施日 + 周期。
   */
  nextAfterCompletion: (doneOn: string) => string | null
  /** 現在の回をスキップした時の、次回の予定日。 */
  nextAfterSkip: () => string | null
}

function maxYmd(a: string | null, b: string | null): string | null {
  if (a === null) return b
  if (b === null) return a
  return a >= b ? a : b
}

function isUsableSchedule(schedule: CleaningSchedule): boolean {
  return (
    isCadenceUnit(schedule.cadence_unit) &&
    isScheduleMode(schedule.schedule_mode) &&
    isCadenceInterval(schedule.cadence_unit, schedule.cadence_interval) &&
    isValidYmd(schedule.anchor_date)
  )
}

/**
 * `ymd` から周期 `times` 回ぶん先（負なら前）の暦日。月・年は暦で数え、無い日は月末へ寄せる。
 * 基準は `ymd` 自身の「日」（実施日が新しい基準になる after_done 用）。計算できねば null。
 */
export function addCadence(ymd: string, unit: CadenceUnit, interval: number, times = 1): string | null {
  if (!isValidYmd(ymd) || !isCadenceInterval(unit, interval) || !Number.isInteger(times)) return null
  if (unit === "week") return shiftYmd(ymd, 7 * interval * times)
  if (unit === "month") return addMonthsClamped(ymd, interval * times)
  return addYearsClamped(ymd, interval * times)
}

/** fixed の k 番目の予定日（k = 0 が基準日。負は基準日より前の格子）。毎回、元の基準日から数える。 */
function gridDate(schedule: CleaningSchedule, k: number): string | null {
  return addCadence(schedule.anchor_date, schedule.cadence_unit, schedule.cadence_interval, k)
}

function yearOf(ymd: string): number {
  return Number(ymd.slice(0, 4))
}

function monthOf(ymd: string): number {
  return Number(ymd.slice(5, 7))
}

/** `ymd` 以前で最も新しい格子の番号（基準日より前なら負）。計算できねば null。 */
function gridIndexAtOrBefore(schedule: CleaningSchedule, ymd: string): number | null {
  const { anchor_date: anchor, cadence_unit: unit, cadence_interval: n } = schedule
  let k: number
  if (unit === "week") {
    const days = daysBetweenYmd(anchor, ymd)
    if (days === null) return null
    return Math.floor(days / (7 * n))
  }
  if (unit === "month") {
    const months = (yearOf(ymd) - yearOf(anchor)) * 12 + (monthOf(ymd) - monthOf(anchor))
    k = Math.floor(months / n)
  } else {
    k = Math.floor((yearOf(ymd) - yearOf(anchor)) / n)
  }
  // 同じ月（年）の中で、格子の「日」が ymd より後ろなら一つ前の格子
  const at = gridDate(schedule, k)
  if (at === null) return null
  return at > ymd ? k - 1 : k
}

/** `ymd` 以後で最初の予定日（基準日より前へは遡らぬ）。 */
function firstGridOnOrAfter(schedule: CleaningSchedule, ymd: string): string | null {
  const index = gridIndexAtOrBefore(schedule, ymd)
  if (index === null) return null
  if (index < 0) return schedule.anchor_date
  const at = gridDate(schedule, index)
  if (at === null) return null
  return at === ymd ? at : gridDate(schedule, index + 1)
}

/** `ymd` 以前で最も新しい予定日。基準日より前なら null。 */
function lastGridOnOrBefore(schedule: CleaningSchedule, ymd: string): string | null {
  const index = gridIndexAtOrBefore(schedule, ymd)
  if (index === null || index < 0) return null
  return gridDate(schedule, index)
}

/**
 * fixed の予定日を `from`〜`to`（両端を含む）の範囲で古い順に返す。基準日より前は含めぬ。
 * after_done の予定日は履歴で決まるゆえ、ここでは空を返す。入力が不正でも空。
 */
export function scheduledDates(schedule: CleaningSchedule, from: string, to: string, limit = 400): string[] {
  if (!isUsableSchedule(schedule) || schedule.schedule_mode !== "fixed") return []
  if (!isValidYmd(from) || !isValidYmd(to) || from > to) return []
  const dates: string[] = []
  let next = firstGridOnOrAfter(schedule, from)
  while (next !== null && next <= to && dates.length < limit) {
    dates.push(next)
    next = firstGridOnOrAfter(schedule, shiftYmd(next, 1))
  }
  return dates
}

/**
 * 閉じられる回の鍵の上限: 今日（基準日が未来なら基準日）から 2 周期先。DB の `record_cleaning_log`
 * の `occurrence out of range` と同じ規則（変える時は migration も変える）。計算できねば null。
 */
export function closeKeyLimit(schedule: CleaningSchedule, today: string): string | null {
  if (!isUsableSchedule(schedule) || !isValidYmd(today)) return null
  const from = today >= schedule.anchor_date ? today : schedule.anchor_date
  return addCadence(from, schedule.cadence_unit, schedule.cadence_interval, 2)
}

/**
 * 有効な履歴から周期計算に要る値を抜く。取り消し済み・不正な日付は数えぬ。
 * `logs` は**今の周期の世代の履歴**であること（世代をまたぐ集計は DB の `cleaning_log_marks` が行う）。
 */
export function marksOfLogs(logs: readonly CleaningLog[]): CleaningMarks {
  let lastDoneOn: string | null = null
  let maxOccurrence: string | null = null
  let maxSkipOccurrence: string | null = null
  let lastSkipScheduledOn: string | null = null
  for (const log of logs) {
    if (log.voided_at !== null) continue
    // 実施として数えるのは done だけ（名指し）。それ以外の種類は、未知の値も含めて実施にせぬ
    if (log.kind === "done" && isValidYmd(log.done_on)) lastDoneOn = maxYmd(lastDoneOn, log.done_on)
    if (isValidYmd(log.occurrence)) {
      maxOccurrence = maxYmd(maxOccurrence, log.occurrence)
      if (log.kind !== "done" && (maxSkipOccurrence === null || log.occurrence > maxSkipOccurrence)) {
        // 最大の鍵の閉鎖の予定日（DB の cleaning_log_marks と同じ: 同じ世代で同じ鍵の有効行は 1 行）
        maxSkipOccurrence = log.occurrence
        lastSkipScheduledOn = isValidYmd(log.scheduled_on) ? log.scheduled_on : null
      }
    }
  }
  return { lastDoneOn, maxOccurrence, maxSkipOccurrence, lastSkipScheduledOn }
}

const NOT_COMPUTABLE = (): string | null => null

function blankStatus(marks: CleaningMarks, today: string, isPaused: boolean): RoutineStatus {
  const lastDoneOn = isValidYmd(marks.lastDoneOn) ? marks.lastDoneOn : null
  const since = lastDoneOn !== null && isValidYmd(today) ? daysBetweenYmd(lastDoneOn, today) : null
  return {
    lastDoneOn,
    daysSinceLastDone: since === null ? null : Math.max(0, since),
    currentOccurrence: null,
    scheduledOn: null,
    dueOn: null,
    overdueDays: 0,
    openCount: 0,
    isPaused,
    postponed: false,
    closeLimitReached: false,
    nextAfterCompletion: NOT_COMPUTABLE,
    nextAfterSkip: NOT_COMPUTABLE,
  }
}

/**
 * routine と履歴の要約（`marks`）から、今日時点の状態を計算する。
 * 全履歴を運べぬ場面（一覧・Server Action）はこちらを使う。
 */
export function routineStatusFromMarks(
  routine: RoutineScheduleState,
  marks: CleaningMarks,
  today: string,
): RoutineStatus {
  const isPaused = routine.paused_at !== null
  const status = blankStatus(marks, today, isPaused)
  if (isPaused || !isValidYmd(today) || !isUsableSchedule(routine)) return status

  const floor = isValidYmd(routine.resume_floor) ? routine.resume_floor : null
  const maxClosed = isValidYmd(marks.maxOccurrence) ? marks.maxOccurrence : null
  const afterClosed = maxClosed === null ? null : shiftYmd(maxClosed, 1)
  const { cadence_unit: unit, cadence_interval: interval } = routine

  let currentOccurrence: string | null
  let scheduledOn: string | null
  let openCount = 0
  let nextAfterCompletion: (doneOn: string) => string | null
  let nextAfterSkip: () => string | null

  if (routine.schedule_mode === "fixed") {
    // 対象にする予定日の下限: 基準日・対象開始日・最後に閉じた回の翌日のうち最も後ろ
    const start = maxYmd(maxYmd(routine.anchor_date, floor), afterClosed) ?? routine.anchor_date
    const first = firstGridOnOrAfter(routine, start)
    if (first === null) return status
    const newest = lastGridOnOrBefore(routine, today)
    if (newest !== null && newest >= first) {
      // 期日を迎えた未完了の回が在る。閉じるのは最も新しい回、超過は最も古い回から数える
      currentOccurrence = newest
      scheduledOn = first
      const from = gridIndexAtOrBefore(routine, first)
      const to = gridIndexAtOrBefore(routine, newest)
      openCount = from === null || to === null ? 1 : to - from + 1
    } else {
      currentOccurrence = first
      scheduledOn = first
    }
    const closing = currentOccurrence
    const nextScheduled = () => {
      const after = maxYmd(closing, today)
      return after === null ? null : firstGridOnOrAfter(routine, shiftYmd(after, 1))
    }
    nextAfterCompletion = (doneOn) => (isValidYmd(doneOn) ? nextScheduled() : null)
    nextAfterSkip = nextScheduled
  } else {
    const lastDone = isValidYmd(marks.lastDoneOn) ? marks.lastDoneOn : null
    const lastSkip = isValidYmd(marks.maxSkipOccurrence) ? marks.maxSkipOccurrence : null
    // 起点は最後の閉鎖。鍵は閉じるたびに前の鍵より後ろになるゆえ、最大の鍵がスキップの鍵と一致する
    // 時だけ、最後の閉鎖はスキップじゃ。その後に実施して回を閉じておれば、スキップは起点にせぬ
    // （「日付の大きい方」で決めると、先の回のスキップの後の実施が起点にならぬ）
    const skipIsLastClosure = lastSkip !== null && lastSkip === maxClosed
    // スキップの起点はその回の予定日（鍵は予定日から逃げうる）。予定日を持たぬ要約・鍵より後ろの値
    // （DB の CHECK が許さぬ形）だけ鍵へ退化する
    const skipScheduled =
      lastSkip !== null && isValidYmd(marks.lastSkipScheduledOn) && marks.lastSkipScheduledOn <= lastSkip
        ? marks.lastSkipScheduledOn
        : lastSkip
    const base = skipIsLastClosure ? maxYmd(lastDone, skipScheduled) : lastDone
    const chained = base === null ? routine.anchor_date : addCadence(base, unit, interval)
    if (chained === null) return status
    scheduledOn = maxYmd(chained, floor)
    // 鍵は必ず未閉鎖の日付にする（閉じた回の日付と重なったら、その翌日へ逃がす）
    currentOccurrence = maxYmd(scheduledOn, afterClosed)
    const scheduled = scheduledOn
    // どちらも「この回を閉じた後」は、その閉鎖が最後の閉鎖になる（鍵が最大になる）
    nextAfterCompletion = (doneOn) => {
      if (!isValidYmd(doneOn)) return null
      const nextBase = maxYmd(lastDone, doneOn)
      const next = nextBase === null ? null : addCadence(nextBase, unit, interval)
      return next === null ? null : maxYmd(next, floor)
    }
    // スキップは、この回の予定日（延期前）から次周期へ。鍵（逃げておれば予定日の翌日以降）からは数えぬ —
    // DB はこの予定日をスキップの履歴へ残し、次の計算の起点にする
    nextAfterSkip = () => {
      const nextBase = maxYmd(lastDone, scheduled)
      const next = nextBase === null ? null : addCadence(nextBase, unit, interval)
      return next === null ? null : maxYmd(next, floor)
    }
  }

  if (currentOccurrence === null || scheduledOn === null) return status
  const postponed =
    routine.postponed_occurrence === currentOccurrence && isValidYmd(routine.postponed_until)
  const dueOn = postponed ? routine.postponed_until : scheduledOn
  const late = dueOn === null ? null : daysBetweenYmd(dueOn, today)
  const limit = closeKeyLimit(routine, today)
  return {
    ...status,
    currentOccurrence,
    scheduledOn,
    dueOn,
    overdueDays: late === null ? 0 : Math.max(0, late),
    // 延期した回は、古い未完了の回を「超過」として数え直さぬ（利用者が期限を決め直した）
    openCount: postponed ? Math.min(openCount, 1) : openCount,
    postponed,
    closeLimitReached: limit !== null && currentOccurrence > limit,
    nextAfterCompletion,
    nextAfterSkip,
  }
}

/**
 * routine とその履歴から、今日時点の状態を計算する。`logs` に他の routine の行が混ざっても
 * 自分の行だけを数える。
 */
export function routineStatus(
  routine: RoutineScheduleState & { id: string },
  logs: readonly CleaningLog[],
  today: string,
): RoutineStatus {
  return routineStatusFromMarks(
    routine,
    marksOfLogs(logs.filter((log) => log.routine_id === routine.id)),
    today,
  )
}

export type CleaningBucket = "overdue" | "today" | "this_week" | "later" | "paused"

/**
 * 表示の区分。週は月曜始まり・日曜終わり（`weekStartMonday` と同じ）。
 * 周期の長さは見ぬ — 年 1 回の項目でも、期限が今週なら `this_week` になる。
 */
export function bucketOf(status: RoutineStatus, today: string): CleaningBucket {
  if (status.isPaused) return "paused"
  const due = status.dueOn
  if (due === null || !isValidYmd(today)) return "later"
  if (due < today) return "overdue"
  if (due === today) return "today"
  const weekEnd = weekEndSunday(today)
  return weekEnd !== null && due <= weekEnd ? "this_week" : "later"
}

/** 「今日・今週やること」に並べる区分か（期限超過を含む）。 */
export function isDueSoonBucket(bucket: CleaningBucket): boolean {
  return bucket === "overdue" || bucket === "today" || bucket === "this_week"
}

export const CLEANING_FILTERS = ["all", "week", "month", "year"] as const
export type CleaningFilter = (typeof CLEANING_FILTERS)[number]

export function isCleaningFilter(value: unknown): value is CleaningFilter {
  return typeof value === "string" && (CLEANING_FILTERS as readonly string[]).includes(value)
}

/**
 * 週 / 月 / 年のフィルターは**周期の単位**での絞り込みじゃ（期限の近さではない）。
 * 「今日・今週やること」はこのフィルターを通さず `isDueSoonBucket` だけで決める —
 * 年次の項目でも今週が期限なら、どのフィルターを選んでいても今週に出る。
 */
export function matchesCleaningFilter(routine: Pick<CleaningSchedule, "cadence_unit">, filter: CleaningFilter): boolean {
  return filter === "all" || routine.cadence_unit === filter
}

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const

const UNIT_SPAN_JA: Record<CadenceUnit, string> = { week: "週間", month: "ヶ月", year: "年" }

/** 周期の長さ（例: 「2週間」「3ヶ月」「1年」）。 */
export function cadenceSpanJa(unit: CadenceUnit, interval: number): string {
  return `${interval}${UNIT_SPAN_JA[unit]}`
}

/**
 * 周期の読み下し（例: 「毎週土曜」「毎月31日（無い月は月末）」「実施した日から3ヶ月後」）。
 * 定義が不正なら null。
 */
export function describeCadence(schedule: CleaningSchedule): string | null {
  if (!isUsableSchedule(schedule)) return null
  const { cadence_unit: unit, cadence_interval: n, anchor_date: anchor } = schedule
  if (schedule.schedule_mode === "after_done") return `実施した日から${cadenceSpanJa(unit, n)}後`
  if (unit === "week") {
    const weekday = weekdayOfYmd(anchor)
    if (weekday === null) return null
    const name = `${WEEKDAYS_JA[weekday]}曜`
    return n === 1 ? `毎週${name}` : `${n}週間ごとの${name}`
  }
  const day = Number(anchor.slice(8, 10))
  if (unit === "month") {
    const head = n === 1 ? `毎月${day}日` : `${n}ヶ月ごとの${day}日`
    return day >= 29 ? `${head}（無い月は月末）` : head
  }
  const month = monthOf(anchor)
  const head = n === 1 ? `毎年${month}月${day}日` : `${n}年ごとの${month}月${day}日`
  return month === 2 && day === 29 ? `${head}（うるう年でない年は2月28日）` : head
}

/**
 * 暦日の表示（例: 「11月14日（土）」。`today` と年が違えば「2027年3月1日（月）」）。
 * 不正なら null。
 */
export function formatYmdJa(ymd: string | null, today?: string): string | null {
  if (!isValidYmd(ymd)) return null
  const weekday = weekdayOfYmd(ymd)
  if (weekday === null) return null
  const body = `${monthOf(ymd)}月${Number(ymd.slice(8, 10))}日（${WEEKDAYS_JA[weekday]}）`
  const sameYear = today !== undefined && isValidYmd(today) && yearOf(today) === yearOf(ymd)
  return sameYear ? body : `${yearOf(ymd)}年${body}`
}
