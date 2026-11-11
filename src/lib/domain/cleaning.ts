/**
 * 掃除ルーティーンの保存の形（要求・応答・行の読み取り）と表示の文言（中立モジュール）。
 *
 * 周期の計算は `cleaning-schedule.ts`。ここは「画面 → Server Action → RPC」を運ぶ値の検証と、
 * DB から届いた行を信用せずに読む部分を持つ。`"use server"` のファイルは関数しか export できぬ
 * ゆえ、型・定数・型ガードはここへ置く。画面・Action・端末の控えの復元が**同じ型ガード**を通す。
 *
 * ## 回の鍵をクライアントから受け取らぬ
 * 完了・スキップ・延期の要求は、画面が見ておった回（`seenOccurrence`）を「照合用」に運ぶだけじゃ。
 * 実際に閉じる回・延期する回は、Action が DB の最新（定義 + 有効な履歴）から計算する。
 * 画面が古く、家族が先に閉じておれば conflict として最新を返す（次の回を誤って閉じぬ）。
 */
import { isRecord } from "@/lib/domain/child-sharing"
import {
  cadenceSpanJa,
  CADENCE_INTERVAL_MAX,
  isCadenceInterval,
  isCadenceUnit,
  isScheduleMode,
  type CadenceUnit,
  type CleaningLog,
  type CleaningMarks,
  type CleaningRoutine,
  type RoutineStatus,
  type ScheduleMode,
} from "@/lib/domain/cleaning-schedule"
import type { ChoreSaveSuccess } from "@/lib/domain/rpc-outcome"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import { isClientId } from "@/lib/utils/client-id"
import { isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

/** DB の CHECK と同じ上限（変える時は migration も変える）。 */
export const CLEANING_NAME_MAX = 60
export const CLEANING_LOCATION_MAX = 40
export const CLEANING_NOTE_MAX = 200
/** DB の日付の範囲（`cleaning_valid_date`）。 */
export const CLEANING_DATE_MIN = "2000-01-01"
export const CLEANING_DATE_MAX = "2999-12-31"
/** 延期できる最大の日数（RPC は今日 + 366 日まで）。 */
export const CLEANING_POSTPONE_MAX_DAYS = 366

/** 一覧・履歴の取得上限（+1 件読んで打ち切りを検知する）。 */
export const CLEANING_ROUTINE_LIMIT = 300
export const CLEANING_LOG_LIMIT = 300

export const CLEANING_ROUTINE_COLUMNS =
  "id, name, location, cadence_unit, cadence_interval, schedule_mode, anchor_date, postponed_occurrence, postponed_until, paused_at, resume_floor, archived, updated_at, created_at"
export const CLEANING_LOG_COLUMNS =
  "id, routine_id, kind, done_on, occurrence, scheduled_on, note, voided_at, created_by, updated_at, created_at"

export const CLEANING_STATE_ACTIONS = ["pause", "resume", "clear_postpone"] as const
export type CleaningStateAction = (typeof CLEANING_STATE_ACTIONS)[number]

export const CLEANING_CLOSE_KINDS = ["done", "skip"] as const
export type CleaningCloseKind = (typeof CLEANING_CLOSE_KINDS)[number]

/** 定義の作成・編集・アーカイブ。`version` が null なら作成。 */
export interface CleaningRoutineRequest {
  op: "routine"
  id: string
  version: string | null
  name: string
  location: string | null
  cadenceUnit: CadenceUnit
  cadenceInterval: number
  scheduleMode: ScheduleMode
  anchorDate: string
  archived: boolean
}

/** 休止・再開・延期の取り消し。 */
export interface CleaningStateRequest {
  op: "state"
  id: string
  version: string
  action: CleaningStateAction
}

/** 現在の回の延期。`seenOccurrence` は照合用（延期する回はサーバーが決める）。 */
export interface CleaningPostponeRequest {
  op: "postpone"
  id: string
  version: string
  seenOccurrence: string
  until: string
}

/**
 * 現在の回を閉じる（1 タップ完了・スキップ）。`id` は履歴の行 ID（操作 ID を兼ねる）。
 *
 * ## 実施日は最初の押下で固定する（`pressedOn`）
 * 完了の実施日は、**最初に押した時に画面が持っておったサーバーの今日（JST）**を要求へ固定して運ぶ
 * （`freezePressedOn`）。応答を失った控えを日をまたいで「同じ操作で確認」しても、押した日で記録する
 * （固定せねば、先の送信が届いておらなんだ時に確かめた日の実施として黙って残る）。
 * - 値は端末の時計では作らぬ。画面の今日が端末の日付と食い違う時（日付をまたいで開いたままの画面・
 *   端末の時計のずれ）は固定せず `null` を送り、サーバーが受けた日で記録する
 * - サーバーは固定した日が自分の今日より後なら拒む（未来の日を実施履歴にせぬ）
 * - スキップは実施日を持たぬゆえ、常に `null`
 */
export interface CleaningCloseRequest {
  op: "close"
  id: string
  routineId: string
  routineVersion: string
  kind: CleaningCloseKind
  seenOccurrence: string
  pressedOn: string | null
}

/**
 * 完了の要求へ固定する実施日を決める。`screenToday` は画面が持つサーバーの今日、`deviceToday` は
 * 端末の今日（JST）。両者が一致する時だけ、画面の今日を固定する。食い違う時は、どちらが正しいか
 * 端末からは判らぬゆえ固定せぬ（null = サーバーが受けた日で記録する）。
 */
export function freezePressedOn(screenToday: string, deviceToday: string): string | null {
  return isCleaningDate(screenToday) && screenToday === deviceToday ? screenToday : null
}

/** 過去日の実施記録の追記（現在の回を閉じぬ）。 */
export interface CleaningBackfillRequest {
  op: "backfill"
  id: string
  routineId: string
  routineVersion: string
  doneOn: string
  note: string | null
}

/** 履歴の訂正（実施日・メモ）。スキップの履歴は実施日を持たぬゆえ `doneOn` は null。 */
export interface CleaningLogUpdateRequest {
  op: "log_update"
  id: string
  version: string
  doneOn: string | null
  note: string | null
}

/** 履歴の取り消し（直後の取り消しも同じ）。 */
export interface CleaningLogVoidRequest {
  op: "log_void"
  id: string
  version: string
}

export type CleaningRequest =
  | CleaningRoutineRequest
  | CleaningStateRequest
  | CleaningPostponeRequest
  | CleaningCloseRequest
  | CleaningBackfillRequest
  | CleaningLogUpdateRequest
  | CleaningLogVoidRequest

/** 前後の空白を除いた長さが範囲内で、制御文字を含まぬ 1 行の文字列か（DB の `cleaning_text` と同じ規則）。 */
function isShortText(value: unknown, max: number): value is string {
  if (typeof value !== "string") return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || [...trimmed].length > max) return false
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0
    if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) return false
  }
  return true
}

function isOptionalText(value: unknown, max: number): value is string | null {
  return value === null || isShortText(value, max)
}

function isCleaningDate(value: unknown): value is string {
  return typeof value === "string" && isValidYmd(value) && value >= CLEANING_DATE_MIN && value <= CLEANING_DATE_MAX
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key))
}

const ROUTINE_KEYS = [
  "op",
  "id",
  "version",
  "name",
  "location",
  "cadenceUnit",
  "cadenceInterval",
  "scheduleMode",
  "anchorDate",
  "archived",
] as const

/**
 * 要求の型ガード。**形と範囲だけ**を見る（「今日より後か」のような時刻に依る検証は Action と
 * RPC が行う — 端末の控えから復元した要求を、日付が変わっただけで読めぬ扱いにせぬため）。
 * 余分な項目を持つ値は受けぬ（`householdId` 等を紛れ込ませても無視ではなく拒否する）。
 */
export function isCleaningRequest(value: unknown): value is CleaningRequest {
  if (!isRecord(value)) return false
  switch (value.op) {
    case "routine":
      return (
        hasOnlyKeys(value, ROUTINE_KEYS) &&
        isClientId(value.id) &&
        (value.version === null || isTimestamptzText(value.version)) &&
        isShortText(value.name, CLEANING_NAME_MAX) &&
        isOptionalText(value.location, CLEANING_LOCATION_MAX) &&
        isCadenceUnit(value.cadenceUnit) &&
        isCadenceInterval(value.cadenceUnit, value.cadenceInterval) &&
        isScheduleMode(value.scheduleMode) &&
        isCleaningDate(value.anchorDate) &&
        typeof value.archived === "boolean" &&
        // 作成と同時のアーカイブは無い（RPC も 22023）
        !(value.version === null && value.archived)
      )
    case "state":
      return (
        hasOnlyKeys(value, ["op", "id", "version", "action"]) &&
        isClientId(value.id) &&
        isTimestamptzText(value.version) &&
        typeof value.action === "string" &&
        (CLEANING_STATE_ACTIONS as readonly string[]).includes(value.action)
      )
    case "postpone":
      return (
        hasOnlyKeys(value, ["op", "id", "version", "seenOccurrence", "until"]) &&
        isClientId(value.id) &&
        isTimestamptzText(value.version) &&
        isCleaningDate(value.seenOccurrence) &&
        isCleaningDate(value.until)
      )
    case "close":
      return (
        hasOnlyKeys(value, ["op", "id", "routineId", "routineVersion", "kind", "seenOccurrence", "pressedOn"]) &&
        isClientId(value.id) &&
        isClientId(value.routineId) &&
        isTimestamptzText(value.routineVersion) &&
        typeof value.kind === "string" &&
        (CLEANING_CLOSE_KINDS as readonly string[]).includes(value.kind) &&
        isCleaningDate(value.seenOccurrence) &&
        // 固定した実施日は完了だけが持つ（スキップは実施日を持たぬ）。項目そのものは必須（null を明示する）
        (value.pressedOn === null || (value.kind === "done" && isCleaningDate(value.pressedOn)))
      )
    case "backfill":
      return (
        hasOnlyKeys(value, ["op", "id", "routineId", "routineVersion", "doneOn", "note"]) &&
        isClientId(value.id) &&
        isClientId(value.routineId) &&
        isTimestamptzText(value.routineVersion) &&
        isCleaningDate(value.doneOn) &&
        isOptionalText(value.note, CLEANING_NOTE_MAX)
      )
    case "log_update":
      return (
        hasOnlyKeys(value, ["op", "id", "version", "doneOn", "note"]) &&
        isClientId(value.id) &&
        isTimestamptzText(value.version) &&
        (value.doneOn === null || isCleaningDate(value.doneOn)) &&
        isOptionalText(value.note, CLEANING_NOTE_MAX)
      )
    case "log_void":
      return hasOnlyKeys(value, ["op", "id", "version"]) && isClientId(value.id) && isTimestamptzText(value.version)
    default:
      return false
  }
}

/** 項目ごとの履歴の追加読み込みで、1 回に返す件数。 */
export const CLEANING_HISTORY_PAGE = 20

/** 履歴の追加読み込みの位置（これより古い記録を読む）。`createdAt` は DB の表記のまま運ぶ。 */
export interface CleaningHistoryCursor {
  createdAt: string
  id: string
}

/**
 * 1 つの項目の有効な履歴を、新しい順に 1 ページ読む要求。`before` が null なら最も新しい記録から。
 * 一覧（世帯全体の直近 `CLEANING_LOG_LIMIT` 件）から外れた記録を、訂正・取り消しできるようにする。
 */
export interface CleaningHistoryRequest {
  routineId: string
  before: CleaningHistoryCursor | null
}

/**
 * 履歴の 1 ページ。`next` は続きの位置（null なら、これより古い記録は無い）。続きの位置はサーバーが
 * 返した行から決める（画面が読めぬ行を挟んでも、同じページを引き直し続けぬ）。
 */
export type CleaningHistoryResult = { logs: CleaningLog[]; next: CleaningHistoryCursor | null } | { error: string }

export function isCleaningHistoryRequest(value: unknown): value is CleaningHistoryRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ["routineId", "before"]) || !isClientId(value.routineId)) return false
  if (value.before === null) return true
  return (
    isRecord(value.before) &&
    hasOnlyKeys(value.before, ["createdAt", "id"]) &&
    isTimestamptzText(value.before.createdAt) &&
    isClientId(value.before.id)
  )
}

/**
 * 履歴の並び（新しい順）。実施日（スキップは閉じた回）の新しい順、同じ日は記録した順。
 * `Array.prototype.sort` の比較関数。
 */
export function compareCleaningLogsNewestFirst(a: CleaningLog, b: CleaningLog): number {
  const keyA = `${a.done_on ?? a.occurrence ?? ""}|${a.created_at}|${a.id}`
  const keyB = `${b.done_on ?? b.occurrence ?? ""}|${b.created_at}|${b.id}`
  return keyA === keyB ? 0 : keyA < keyB ? 1 : -1
}

/**
 * 読み込み済みの履歴のうち、**記録した時刻が最も古い**ものの位置（次の追加読み込みの起点）。
 * 一覧は世帯全体の新しい順で切ってあるゆえ、その中のこの項目の記録は「この項目の新しい方から
 * 連続した分」になっておる。ゆえに、読み込み済みの最古より古い記録だけを足せば抜けが出ぬ。
 * 位置に使えぬ行（時刻の表記が読めぬ）は数えぬ。1 件も無ければ null（最も新しい記録から読む）。
 */
export function oldestCleaningLogCursor(logs: readonly CleaningLog[]): CleaningHistoryCursor | null {
  let oldest: CleaningLog | null = null
  let oldestMs = Number.POSITIVE_INFINITY
  for (const log of logs) {
    if (!isTimestamptzText(log.created_at)) continue
    // 比較だけに使う（運ぶ値は表記のまま。Date を通した値は送らぬ）
    const ms = Date.parse(log.created_at.replace(" ", "T"))
    if (Number.isNaN(ms)) continue
    if (ms < oldestMs || (ms === oldestMs && oldest !== null && log.created_at < oldest.created_at)) {
      oldest = log
      oldestMs = ms
    }
  }
  return oldest === null ? null : { createdAt: oldest.created_at, id: oldest.id }
}

/** 空欄を null に、前後の空白を落とした文字列にする（入力欄 → 要求）。 */
export function normalizeOptionalText(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function nullableYmd(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return isCleaningDate(value) ? value : undefined
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null
  return typeof value === "string" ? value : undefined
}

/**
 * DB（PostgREST / RPC の to_jsonb）から届いた定義の行を読む。必須の列が欠ける・周期が
 * この版の知らぬ値なら null（その行だけを「読めぬ項目」として数え、画面全体は倒さぬ）。
 * 版（`updated_at`）は表記のまま運ぶ。
 */
export function parseCleaningRoutine(value: unknown): CleaningRoutine | null {
  if (!isRecord(value)) return null
  const postponedOccurrence = nullableYmd(value.postponed_occurrence)
  const postponedUntil = nullableYmd(value.postponed_until)
  const resumeFloor = nullableYmd(value.resume_floor)
  const pausedAt = nullableText(value.paused_at)
  const location = nullableText(value.location)
  if (
    !isClientId(value.id) ||
    typeof value.name !== "string" ||
    location === undefined ||
    !isCadenceUnit(value.cadence_unit) ||
    !isCadenceInterval(value.cadence_unit, value.cadence_interval) ||
    !isScheduleMode(value.schedule_mode) ||
    !isCleaningDate(value.anchor_date) ||
    postponedOccurrence === undefined ||
    postponedUntil === undefined ||
    resumeFloor === undefined ||
    pausedAt === undefined ||
    typeof value.archived !== "boolean" ||
    !isTimestamptzText(value.updated_at) ||
    typeof value.created_at !== "string"
  ) {
    return null
  }
  // 延期は必ず対で入る（DB の CHECK）。片方だけなら延期なしとして読む
  const postponed = postponedOccurrence !== null && postponedUntil !== null
  return {
    id: value.id,
    name: value.name,
    location,
    cadence_unit: value.cadence_unit,
    cadence_interval: value.cadence_interval,
    schedule_mode: value.schedule_mode,
    anchor_date: value.anchor_date,
    postponed_occurrence: postponed ? postponedOccurrence : null,
    postponed_until: postponed ? postponedUntil : null,
    paused_at: pausedAt,
    resume_floor: resumeFloor,
    archived: value.archived,
    updated_at: value.updated_at,
    created_at: value.created_at,
  }
}

/**
 * 履歴の行を読む。種類がこの版の知らぬ値なら `other` へ退化させる（回を閉じる効果は保ち、
 * 実施としては数えぬ。未知の値で画面を倒さぬ）。必須の列が欠ければ null。
 */
export function parseCleaningLog(value: unknown): CleaningLog | null {
  if (!isRecord(value)) return null
  const doneOn = nullableYmd(value.done_on)
  const occurrence = nullableYmd(value.occurrence)
  const scheduledOn = nullableYmd(value.scheduled_on)
  const note = nullableText(value.note)
  const voidedAt = nullableText(value.voided_at)
  const createdBy = nullableText(value.created_by)
  if (
    !isClientId(value.id) ||
    !isClientId(value.routine_id) ||
    typeof value.kind !== "string" ||
    doneOn === undefined ||
    occurrence === undefined ||
    scheduledOn === undefined ||
    note === undefined ||
    voidedAt === undefined ||
    createdBy === undefined ||
    !isTimestamptzText(value.updated_at) ||
    typeof value.created_at !== "string"
  ) {
    return null
  }
  return {
    id: value.id,
    routine_id: value.routine_id,
    kind: value.kind === "done" || value.kind === "skip" ? value.kind : "other",
    done_on: doneOn,
    occurrence,
    // スキップの予定日は持つ行だけに載せる（無い行は鍵へ退化する。`CleaningLog.scheduled_on`）
    ...(scheduledOn !== null ? { scheduled_on: scheduledOn } : {}),
    note,
    voided_at: voidedAt,
    created_by: createdBy,
    updated_at: value.updated_at,
    created_at: value.created_at,
  }
}

/** `cleaning_log_marks` の 1 行を読む。形が合わねば null。 */
export function parseCleaningMarksRow(value: unknown): { routineId: string; marks: CleaningMarks } | null {
  if (!isRecord(value) || !isClientId(value.routine_id)) return null
  const lastDoneOn = nullableYmd(value.last_done_on)
  const maxOccurrence = nullableYmd(value.max_occurrence)
  const maxSkipOccurrence = nullableYmd(value.max_skip_occurrence)
  const lastSkipScheduledOn = nullableYmd(value.last_skip_scheduled_on)
  if (
    lastDoneOn === undefined ||
    maxOccurrence === undefined ||
    maxSkipOccurrence === undefined ||
    lastSkipScheduledOn === undefined
  ) {
    return null
  }
  return {
    routineId: value.routine_id,
    marks: {
      lastDoneOn,
      maxOccurrence,
      maxSkipOccurrence,
      // スキップの予定日は在る時だけ載せる（無ければ周期計算が鍵へ退化する）
      ...(lastSkipScheduledOn !== null ? { lastSkipScheduledOn } : {}),
    },
  }
}

/**
 * Action の成功応答に載る補足。
 * - `already_closed` … 同じ回を家族（または自分の別の端末）が先に同じ種類で閉じておった。
 *   行は増やしておらぬ（1 回分のまま）
 * - `closed_differently` … 同じ回が別の種類（完了に対するスキップ等）で先に閉じられておった
 * - `occurrence_moved` … 画面が見ておった回と、今の対象回が違う（何も書いておらぬ）
 * - `voided` … 自分の記録が、応答を待つ間に取り消されておった
 */
export type CleaningSaveDetail = "already_closed" | "closed_differently" | "occurrence_moved" | "voided"

/** 掃除の保存 Action の成功応答（conflict も応答としては成功 = 上書きしておらぬ）。 */
export interface CleaningSaveSuccess extends ChoreSaveSuccess {
  detail?: CleaningSaveDetail
  /** 書いた（または既に在った）履歴の行。直後の取り消しに版を使う */
  log?: CleaningLog
  /** 最新の定義の行 */
  routine?: CleaningRoutine
}

/** 利用者向けの短い説明（端末の控え・結果の文言に使う）。 */
export function labelOfCleaningRequest(request: CleaningRequest, routineName: string): string {
  const name = [...routineName.trim()].slice(0, 40).join("") || "掃除の項目"
  switch (request.op) {
    case "routine":
      if (request.version === null) return `「${name}」を追加`
      return request.archived ? `「${name}」をアーカイブ` : `「${name}」の内容を保存`
    case "state":
      if (request.action === "pause") return `「${name}」を休止`
      if (request.action === "resume") return `「${name}」を再開`
      return `「${name}」の延期を解除`
    case "postpone":
      return `「${name}」を延期`
    case "close":
      return request.kind === "done" ? `「${name}」を完了` : `「${name}」をスキップ`
    case "backfill":
      return `「${name}」の過去の実施を記録`
    case "log_update":
      return `「${name}」の履歴を訂正`
    case "log_void":
      return `「${name}」の記録を取り消し`
  }
}

/** 延期先に選べる日付の範囲。`max` が `min` より前なら延期できる日が無い。 */
export interface PostponeRange {
  min: string
  max: string
  /** fixed で、次の予定日の前日が上限になっておる時の、その次の予定日 */
  nextScheduledOn: string | null
}

/**
 * 延期先の範囲。延期は現在の回の期限だけを動かし、次の回には及ばぬ。
 * - 下限: 明日と「今の期限の翌日」の遅い方（期限を前へ動かす操作は延期ではない）
 * - 上限: 今日から 366 日。fixed は**次の予定日の前日**まで（次の予定日を越えると、延期した回は
 *   次の回に置き換わって消え、延期の意味が無くなる）
 * 休止中・計算できぬ時は null。
 */
export function postponeRangeOf(
  routine: Pick<CleaningRoutine, "schedule_mode">,
  status: RoutineStatus,
  today: string,
): PostponeRange | null {
  if (status.isPaused || status.currentOccurrence === null || status.scheduledOn === null || !isValidYmd(today)) {
    return null
  }
  const tomorrow = shiftYmd(today, 1)
  const afterScheduled = shiftYmd(status.scheduledOn, 1)
  const min = afterScheduled > tomorrow ? afterScheduled : tomorrow
  let max = shiftYmd(today, CLEANING_POSTPONE_MAX_DAYS)
  let nextScheduledOn: string | null = null
  if (routine.schedule_mode === "fixed") {
    const next = status.nextAfterSkip()
    if (next !== null) {
      const dayBefore = shiftYmd(next, -1)
      if (dayBefore < max) {
        max = dayBefore
        nextScheduledOn = next
      }
    }
  }
  return { min, max, nextScheduledOn }
}

export const CADENCE_UNIT_LABEL: Record<CadenceUnit, string> = { week: "週", month: "月", year: "年" }

export const SCHEDULE_MODE_LABEL: Record<ScheduleMode, string> = {
  fixed: "決まった曜日・日付",
  after_done: "実施してから一定期間後",
}

/** 周期の入力欄の選択肢（単位ごとの間隔の上限は DB の CHECK と同じ）。 */
export function cadenceIntervalOptions(unit: CadenceUnit): { value: number; label: string }[] {
  const options: { value: number; label: string }[] = []
  for (let n = 1; n <= CADENCE_INTERVAL_MAX[unit]; n++) options.push({ value: n, label: cadenceSpanJa(unit, n) })
  return options
}

/** 前回実施日からの日数の言い方（0 → 今日、1 → 昨日、n → n日前）。 */
export function daysAgoJa(days: number): string {
  if (days <= 0) return "今日"
  if (days === 1) return "昨日"
  return `${days}日前`
}

/** 期限までの日数の言い方（0 → 今日、1 → 明日、n → n日後）。 */
export function daysUntilJa(days: number): string {
  if (days <= 0) return "今日"
  if (days === 1) return "明日"
  return `${days}日後`
}
