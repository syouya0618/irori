"use server"

import { revalidatePath } from "next/cache"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isRecord } from "@/lib/domain/child-sharing"
import {
  CLEANING_HISTORY_PAGE,
  CLEANING_LOG_COLUMNS,
  CLEANING_ROUTINE_COLUMNS,
  isCleaningHistoryRequest,
  isCleaningRequest,
  parseCleaningLog,
  parseCleaningMarksRow,
  parseCleaningRoutine,
  postponeRangeOf,
  type CleaningBackfillRequest,
  type CleaningCloseRequest,
  type CleaningHistoryRequest,
  type CleaningHistoryResult,
  type CleaningLogUpdateRequest,
  type CleaningLogVoidRequest,
  type CleaningPostponeRequest,
  type CleaningRequest,
  type CleaningRoutineRequest,
  type CleaningSaveSuccess,
  type CleaningStateRequest,
} from "@/lib/domain/cleaning"
import {
  EMPTY_CLEANING_MARKS,
  formatYmdJa,
  routineStatusFromMarks,
  type CleaningLog,
  type CleaningMarks,
  type CleaningRoutine,
} from "@/lib/domain/cleaning-schedule"
import {
  failureOfRpcError,
  isRpcStatus,
  parseRpcOutcome,
  rejectedResult,
  unknownResult,
  type ChoreSaveFailure,
  type ChoreSaveResult,
} from "@/lib/domain/rpc-outcome"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import { isClientId } from "@/lib/utils/client-id"
import { todayJstString } from "@/lib/utils/date-jst"

type Result = ChoreSaveResult<CleaningSaveSuccess>
type DbError = { code?: string | null; message?: string | null }

const INVALID_MESSAGE = "入力内容を確認してください。"
const FUTURE_MESSAGE = "未来の日付は実施日として記録できません。今日までの日付を選んでください。"
const GONE_MESSAGE = "この項目が見つかりません。再読み込みして確認してください。"
const READ_FAILED_MESSAGE = "最新の状態を確認できませんでした。通信状況を確認して、もう一度お試しください。"
const ID_CONFLICT_MESSAGE =
  "同じ操作が別の内容で記録済みでした。上書きはしていません。画面の内容を確認してください。"
// 1 タップの完了・スキップは日付も回も入力させぬ。「入力内容を確認」「日付を選んで」とは言わず、理由を言う
const CLOSE_LIMIT_MESSAGE =
  "先の回まで記録済みのため、次の予定日が近づくまで今回の分は記録できません。今日掃除した時は、項目の詳細の「過去にやった日を記録」から記録できます。"
const CLOSE_DATE_MESSAGE =
  "日付の変わり目のため実施日を確かめられず、記録していません。少し待ってから、もう一度お試しください。"
const HISTORY_FAILED_MESSAGE = "履歴を読み込めませんでした。通信状況を確認して、もう一度お試しください。"

/**
 * 周期の世代の列（`cleaning_routines.cadence_epoch` / `cleaning_logs.cadence_epoch`）。
 * 画面へ運ぶ行（`CLEANING_ROUTINE_COLUMNS`）には含めぬ — 世代を使うのは、この Action が「見ておった回は
 * 今の世代で閉じ済みか」を確かめる読みだけじゃ（他は DB の RPC と `cleaning_log_marks` が世代で絞る）。
 * 生成型（`database.ts`）の行の型に依らぬよう、列名は string として渡す。
 */
const EPOCH_COLUMN: string = "cadence_epoch"
const ROUTINE_STATE_COLUMNS: string = `${CLEANING_ROUTINE_COLUMNS}, ${EPOCH_COLUMN}`

/** DB の拒否を利用者向けの文へ（生のエラーは返さず、呼び出し側でログへ出す）。 */
function messageOfDbError(error: DbError): string {
  const code = error.code ?? ""
  const message = error.message ?? ""
  if (code === "42501") return "この操作を行えません。再読み込みして、項目と権限を確認してください。"
  if (code === "22023") return message.includes("future") ? FUTURE_MESSAGE : INVALID_MESSAGE
  if (code === "23514") {
    if (message.includes("too many")) return "掃除の項目が上限に達しています。使っていない項目をアーカイブしてください。"
    if (message.includes("archived")) return "アーカイブ済みの項目です。元に戻してから操作してください。"
    if (message.includes("paused")) return "休止中の項目です。再開してから操作してください。"
    return INVALID_MESSAGE
  }
  return "保存できませんでした。通信状況を確認して、もう一度お試しください。"
}

/** RPC・読み取りの失敗を分類する。同じ ID に別の内容（23505）は、送り直しても成立せぬ衝突。 */
function failureOf(error: DbError): ChoreSaveFailure {
  if (error.code === "23505") return { error: ID_CONFLICT_MESSAGE, failure: "conflict" }
  return failureOfRpcError(error, messageOfDbError(error))
}

function revalidateCleaning(): void {
  revalidatePath("/chores/cleaning")
  revalidatePath("/chores")
}

/** `{ status, routine }` を返す RPC の戻り値を読む。行が要求の項目でなければ結果不明。 */
function routineOutcome(data: unknown, routineId: string): Result {
  const outcome = parseRpcOutcome(data, "routine")
  const routine = outcome ? parseCleaningRoutine(outcome.entity) : null
  if (!outcome || !routine || routine.id !== routineId) return unknownResult()
  revalidateCleaning()
  return { status: outcome.status, routine }
}

/** `{ status, log }` を返す RPC の戻り値を読む。 */
function logOutcome(data: unknown, logId: string): Result {
  const outcome = parseRpcOutcome(data, "log")
  const log = outcome ? parseCleaningLog(outcome.entity) : null
  if (!outcome || !log || log.id !== logId) return unknownResult()
  revalidateCleaning()
  return { status: outcome.status, log }
}

/**
 * 定義と有効な履歴の要約を、世帯で絞って読む（RLS と二重）。別世帯の ID は「見つからぬ」と
 * 同じ応答にする（存在を漏らさぬ）。
 */
async function loadRoutineState(
  { supabase, householdId, userId }: AuthContext,
  routineId: string,
): Promise<
  { failure: ChoreSaveFailure } | { failure: null; routine: CleaningRoutine; marks: CleaningMarks; epoch: number }
> {
  const { data, error } = await supabase
    .from("cleaning_routines")
    .select(ROUTINE_STATE_COLUMNS)
    .eq("id", routineId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (error) {
    logSupabaseError("cleaning", "routine lookup failed", error, { userId })
    return { failure: failureOfRpcError(error, READ_FAILED_MESSAGE) }
  }
  const row: unknown = data
  if (!row) return { failure: rejectedResult(GONE_MESSAGE) }
  const routine = parseCleaningRoutine(row)
  if (!routine) return { failure: rejectedResult(GONE_MESSAGE) }
  // 世代が読めぬ行は「世代 0」と見なさぬ（別の世代の閉鎖を、今の回の閉鎖と取り違える）
  const epoch = isRecord(row) ? row[EPOCH_COLUMN] : undefined
  if (typeof epoch !== "number" || !Number.isInteger(epoch) || epoch < 0) {
    console.error("[cleaning] routine row has no readable cadence epoch", { userId })
    return { failure: failureOfRpcError({ code: "" }, READ_FAILED_MESSAGE) }
  }

  const { data: markRows, error: marksError } = await supabase.rpc("cleaning_log_marks", { p_routine_id: routineId })
  if (marksError) {
    logSupabaseError("cleaning", "marks lookup failed", marksError, { userId })
    return { failure: failureOfRpcError(marksError, READ_FAILED_MESSAGE) }
  }
  // 行が無い = 有効な履歴が無い（未記録）。読めぬ行を「履歴なし」と見なさぬ
  let marks: CleaningMarks = EMPTY_CLEANING_MARKS
  for (const raw of Array.isArray(markRows) ? markRows : []) {
    const parsed = parseCleaningMarksRow(raw)
    if (!parsed) return { failure: failureOfRpcError({ code: "" }, READ_FAILED_MESSAGE) }
    if (parsed.routineId === routineId) marks = parsed.marks
  }
  return { failure: null, routine, marks, epoch }
}

async function saveRoutine(context: AuthContext, request: CleaningRoutineRequest): Promise<Result> {
  const { supabase, userId } = context
  const { data, error } = await supabase.rpc("save_cleaning_routine", {
    p_id: request.id,
    p_version: request.version,
    p_name: request.name.trim(),
    p_location: request.location === null ? null : request.location.trim(),
    p_cadence_unit: request.cadenceUnit,
    p_cadence_interval: request.cadenceInterval,
    p_schedule_mode: request.scheduleMode,
    p_anchor_date: request.anchorDate,
    p_archived: request.archived,
  })
  if (error) {
    logSupabaseError("cleaning", "save_cleaning_routine failed", error, { userId })
    return failureOf(error)
  }
  return routineOutcome(data, request.id)
}

async function setState(context: AuthContext, request: CleaningStateRequest): Promise<Result> {
  const { supabase, userId } = context
  const { data, error } = await supabase.rpc("set_cleaning_routine_state", {
    p_id: request.id,
    p_version: request.version,
    p_action: request.action,
    p_occurrence: null,
    p_until: null,
  })
  if (error) {
    logSupabaseError("cleaning", "set_cleaning_routine_state failed", error, { userId, action: request.action })
    return failureOf(error)
  }
  return routineOutcome(data, request.id)
}

/**
 * 延期。延期する回は DB の最新から計算する（画面が見ておった回と違えば、書かずに最新を返す）。
 */
async function postpone(context: AuthContext, request: CleaningPostponeRequest): Promise<Result> {
  const { supabase, userId } = context
  const loaded = await loadRoutineState(context, request.id)
  if (loaded.failure) return loaded.failure
  const { routine, marks } = loaded

  // 応答を失った自分の再送（同じ回・同じ延期先が既に入っておる）。日付が変わっても成立させる
  if (routine.postponed_occurrence === request.seenOccurrence && routine.postponed_until === request.until) {
    return { status: "replayed", routine }
  }
  if (routine.archived) return rejectedResult("アーカイブ済みの項目です。元に戻してから操作してください。")
  if (routine.paused_at !== null) return rejectedResult("休止中の項目です。再開してから操作してください。")

  const today = todayJstString()
  const status = routineStatusFromMarks(routine, marks, today)
  if (status.currentOccurrence === null) return rejectedResult("この項目の次の予定日を計算できません。周期を確認してください。")
  if (status.currentOccurrence !== request.seenOccurrence) {
    return { status: "conflict", detail: "occurrence_moved", routine }
  }
  const range = postponeRangeOf(routine, status, today)
  if (range === null || range.max < range.min) {
    return rejectedResult("次の予定日が近いため延期できません。今回を見送る時はスキップを使ってください。")
  }
  if (request.until < range.min || request.until > range.max) {
    const from = formatYmdJa(range.min, today) ?? range.min
    const to = formatYmdJa(range.max, today) ?? range.max
    return rejectedResult(`延期先は${from}から${to}までの日付を選んでください。`)
  }

  const { data, error } = await supabase.rpc("set_cleaning_routine_state", {
    p_id: request.id,
    p_version: request.version,
    p_action: "postpone",
    p_occurrence: status.currentOccurrence,
    p_until: request.until,
  })
  if (error) {
    logSupabaseError("cleaning", "postpone failed", error, { userId })
    return failureOf(error)
  }
  return routineOutcome(data, request.id)
}

/** `record_cleaning_log` の戻り値を読む。`already_closed` は同じ種類なら「1 回分のまま」、違えば衝突。 */
function recordOutcome(data: unknown, request: { id: string; routineId: string; kind: string }): Result {
  if (!isRecord(data)) return unknownResult()
  const routine = isRecord(data.routine) ? parseCleaningRoutine(data.routine) : null
  const log = isRecord(data.log) ? parseCleaningLog(data.log) : null
  if (!routine || routine.id !== request.routineId) return unknownResult()

  if (data.status === "already_closed") {
    if (!log || log.routine_id !== request.routineId || log.voided_at !== null) return unknownResult()
    revalidateCleaning()
    return log.kind === request.kind
      ? { status: "replayed", detail: "already_closed", log, routine }
      : { status: "conflict", detail: "closed_differently", log, routine }
  }
  if (!isRpcStatus(data.status)) return unknownResult()
  if (data.status === "conflict") {
    revalidateCleaning()
    // 行つきの conflict は「自分の記録が取り消されておった」。行なしは定義の版が違う
    if (log && log.id === request.id) return { status: "conflict", detail: "voided", log, routine }
    return { status: "conflict", routine }
  }
  if (!log || log.id !== request.id || log.routine_id !== request.routineId) return unknownResult()
  revalidateCleaning()
  return { status: data.status, log, routine }
}

/** 操作 ID（= 履歴の行 ID）で既存の行を読む。世帯で絞る。 */
async function findLogById(
  { supabase, householdId, userId }: AuthContext,
  logId: string,
): Promise<{ failure: ChoreSaveFailure } | { failure: null; log: CleaningLog | null }> {
  const { data, error } = await supabase
    .from("cleaning_logs")
    .select(CLEANING_LOG_COLUMNS)
    .eq("id", logId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (error) {
    logSupabaseError("cleaning", "log lookup failed", error, { userId })
    return { failure: failureOfRpcError(error, READ_FAILED_MESSAGE) }
  }
  if (!data) return { failure: null, log: null }
  const log = parseCleaningLog(data)
  // 行は在るが読めぬ。書かれておるかもしれぬゆえ、拒否ではなく結果不明
  return log ? { failure: null, log } : { failure: unknownResult(READ_FAILED_MESSAGE) }
}

/**
 * 現在の回を閉じる（1 タップ完了・スキップ）。
 *
 * 1. 同じ操作 ID の行が既に在れば、**その行の内容で** RPC を呼び直す（replayed。応答を失った
 *    自分の再送。日付が変わっていても、次の回を新たに閉じぬ）
 * 2. 無ければ、定義 + 有効な履歴から対象回を計算する。画面が見ておった回と違えば書かぬ
 *    （家族が先に閉じておれば `already_closed`、それ以外は `occurrence_moved`）
 * 3. 計算した回で RPC を呼ぶ。同時に届いた完了は RPC が 1 行に確定する（`already_closed`）
 *
 * 1 と 3 の間に自分の先の送信が届くと RPC が 23505 を返すゆえ、その時だけ 1 からやり直す。
 *
 * 完了の実施日は、要求が固定しておる「最初に押した日」（`pressedOn`。画面が持っておったサーバーの
 * 今日）を使う。応答を失った控えを後日確かめ直しても、確かめた日ではなく押した日で記録する。
 * 固定できなんだ要求（null）は受けた日。どちらも、サーバーの今日より後なら拒む（未来の日を
 * 実施履歴にせぬ。DB も同じ検査を持つ）。
 */
async function closeOccurrence(context: AuthContext, request: CleaningCloseRequest, attempt = 0): Promise<Result> {
  const { supabase, userId } = context

  const found = await findLogById(context, request.id)
  if (found.failure) return found.failure
  let doneOn: string | null
  let occurrence: string | null
  if (found.log) {
    const existing = found.log
    if (
      existing.routine_id !== request.routineId ||
      existing.kind !== request.kind ||
      existing.created_by !== userId ||
      existing.occurrence === null
    ) {
      return { error: ID_CONFLICT_MESSAGE, failure: "conflict" }
    }
    doneOn = existing.done_on
    occurrence = existing.occurrence
  } else {
    const today = todayJstString()
    // 実施日は最初に押した日（固定できなんだ要求は受けた日）。サーバーの今日より後は記録せぬ
    const pressedOn = request.kind === "done" ? (request.pressedOn ?? today) : null
    if (pressedOn !== null && pressedOn > today) return rejectedResult(CLOSE_DATE_MESSAGE)

    const loaded = await loadRoutineState(context, request.routineId)
    if (loaded.failure) return loaded.failure
    const { routine, marks, epoch } = loaded
    if (routine.archived) return rejectedResult("アーカイブ済みの項目です。元に戻してから操作してください。")
    if (routine.paused_at !== null) return rejectedResult("休止中の項目です。再開してから操作してください。")
    const status = routineStatusFromMarks(routine, marks, today)
    if (status.currentOccurrence === null) {
      return rejectedResult("この項目の次の予定日を計算できません。周期を確認してください。")
    }
    if (status.currentOccurrence !== request.seenOccurrence) {
      // 画面が見ておった回は、既に誰かが閉じたのか（＝同時完了）を確かめる。回の鍵は周期の世代ごとゆえ、
      // 今の世代で絞る（変更前の格子の同じ日付の閉鎖を、今の回の閉鎖と取り違えぬ）
      const { data: closing, error: closingError } = await supabase
        .from("cleaning_logs")
        .select(CLEANING_LOG_COLUMNS)
        .eq("household_id", context.householdId)
        .eq("routine_id", request.routineId)
        .eq(EPOCH_COLUMN, epoch)
        .eq("occurrence", request.seenOccurrence)
        .is("voided_at", null)
        .maybeSingle()
      if (closingError) {
        logSupabaseError("cleaning", "closing log lookup failed", closingError, { userId })
        return failureOfRpcError(closingError, READ_FAILED_MESSAGE)
      }
      const closed = closing ? parseCleaningLog(closing) : null
      if (!closed) return { status: "conflict", detail: "occurrence_moved", routine }
      return closed.kind === request.kind
        ? { status: "replayed", detail: "already_closed", log: closed, routine }
        : { status: "conflict", detail: "closed_differently", log: closed, routine }
    }
    // 先の回を続けて閉じた後は、現在の回の鍵が DB の上限（今日から 2 周期）を越える。DB の拒否
    // （22023）を待たず、理由の分かる文で拒む
    if (status.closeLimitReached) return rejectedResult(CLOSE_LIMIT_MESSAGE)
    doneOn = pressedOn
    occurrence = status.currentOccurrence
  }

  const { data, error } = await supabase.rpc("record_cleaning_log", {
    p_id: request.id,
    p_routine_id: request.routineId,
    p_routine_version: request.routineVersion,
    p_kind: request.kind,
    p_done_on: doneOn,
    p_occurrence: occurrence,
    p_note: found.log ? found.log.note : null,
  })
  if (error) {
    // 読みと書きの間に、同じ操作 ID の先の送信が届いた。もう一度だけ、既存の行から確かめ直す
    if (error.code === "23505" && attempt === 0 && !found.log) return closeOccurrence(context, request, 1)
    logSupabaseError("cleaning", "record_cleaning_log failed", error, { userId, kind: request.kind })
    if (error.code === "22023") {
      // 日付も回も入力させぬ操作ゆえ、「日付を選んで」「入力内容を確認」とは返さぬ。
      // future = アプリと DB の時計が日付の境で食い違った（書いておらぬ。押し直せば通る）
      const message = error.message ?? ""
      if (message.includes("future")) return rejectedResult(CLOSE_DATE_MESSAGE)
      if (message.includes("out of range")) return rejectedResult(CLOSE_LIMIT_MESSAGE)
    }
    return failureOf(error)
  }
  return recordOutcome(data, request)
}

/** 過去日の実施記録の追記。回の鍵を付けぬ（現在の回を閉じぬ）。未来日は DB へ届く前に拒む。 */
async function backfill(context: AuthContext, request: CleaningBackfillRequest): Promise<Result> {
  const { supabase, userId } = context
  if (request.doneOn > todayJstString()) return rejectedResult(FUTURE_MESSAGE)
  const { data, error } = await supabase.rpc("record_cleaning_log", {
    p_id: request.id,
    p_routine_id: request.routineId,
    p_routine_version: request.routineVersion,
    p_kind: "done",
    p_done_on: request.doneOn,
    p_occurrence: null,
    p_note: request.note === null ? null : request.note.trim(),
  })
  if (error) {
    logSupabaseError("cleaning", "backfill failed", error, { userId })
    return failureOf(error)
  }
  return recordOutcome(data, { id: request.id, routineId: request.routineId, kind: "done" })
}

async function updateLog(context: AuthContext, request: CleaningLogUpdateRequest): Promise<Result> {
  const { supabase, userId } = context
  if (request.doneOn !== null && request.doneOn > todayJstString()) return rejectedResult(FUTURE_MESSAGE)
  const { data, error } = await supabase.rpc("update_cleaning_log", {
    p_id: request.id,
    p_version: request.version,
    p_done_on: request.doneOn,
    p_note: request.note === null ? null : request.note.trim(),
  })
  if (error) {
    logSupabaseError("cleaning", "update_cleaning_log failed", error, { userId })
    return failureOf(error)
  }
  return logOutcome(data, request.id)
}

async function voidLog(context: AuthContext, request: CleaningLogVoidRequest): Promise<Result> {
  const { supabase, userId } = context
  const { data, error } = await supabase.rpc("void_cleaning_log", { p_id: request.id, p_version: request.version })
  if (error) {
    logSupabaseError("cleaning", "void_cleaning_log failed", error, { userId })
    return failureOf(error)
  }
  return logOutcome(data, request.id)
}

/**
 * 掃除の保存（定義・状態・履歴の全操作）。
 *
 * - 入力は型ガードで検証し、認証・世帯は `getAuthContext()` から取る（世帯 ID を受け取らぬ）
 * - 書込は SECURITY DEFINER の RPC だけ。RPC は `auth.uid()` から世帯を導出し、別世帯の ID は 42501
 * - 結果は `{ status }`（saved / replayed / conflict）か `{ error, failure }`。戻り値の形が
 *   読めねば「結果不明」として返し、成功とも失敗とも断定せぬ
 */
export async function saveCleaning(request: CleaningRequest): Promise<Result> {
  if (!isCleaningRequest(request)) return rejectedResult(INVALID_MESSAGE)
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const context = auth.context
  switch (request.op) {
    case "routine":
      return saveRoutine(context, request)
    case "state":
      return setState(context, request)
    case "postpone":
      return postpone(context, request)
    case "close":
      return closeOccurrence(context, request)
    case "backfill":
      return backfill(context, request)
    case "log_update":
      return updateLog(context, request)
    case "log_void":
      return voidLog(context, request)
  }
}

/**
 * 1 つの項目の有効な履歴を、記録の新しい順に 1 ページ読む（読み取りだけ。何も書かぬ）。
 *
 * 画面の一覧は世帯全体の直近 `CLEANING_LOG_LIMIT` 件で切ってある。そこから外れた記録（年 1 回の
 * 項目の前回の完了など）にも訂正・取り消しの釦を出せるよう、項目の詳細が続きをここから読む。
 *
 * - 認証・世帯は `getAuthContext()` から取り、読みは世帯と項目で絞る（RLS と二重）。別世帯の項目は
 *   「記録なし」と同じ応答になる（存在を漏らさぬ）
 * - `before` より古い記録を読む。同じ時刻の行を落とさぬよう「以前」で読み、起点の行だけを除く
 *   （重なった行は画面が ID で 1 件にまとめる）
 * - 読めなんだ時は `{ error }`。「記録なし」とは返さぬ
 */
export async function loadCleaningHistory(request: CleaningHistoryRequest): Promise<CleaningHistoryResult> {
  if (!isCleaningHistoryRequest(request)) return { error: INVALID_MESSAGE }
  const auth = await getAuthContext()
  if (auth.error !== null) return { error: auth.error }
  const { supabase, householdId, userId } = auth.context

  let query = supabase
    .from("cleaning_logs")
    .select(CLEANING_LOG_COLUMNS)
    .eq("household_id", householdId)
    .eq("routine_id", request.routineId)
    .is("voided_at", null)
  if (request.before !== null) {
    query = query.lte("created_at", request.before.createdAt).neq("id", request.before.id)
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(CLEANING_HISTORY_PAGE + 1)
  if (error) {
    logSupabaseError("cleaning", "history lookup failed", error, { userId })
    return { error: HISTORY_FAILED_MESSAGE }
  }
  const rows: unknown[] = Array.isArray(data) ? data : []
  const page = rows.slice(0, CLEANING_HISTORY_PAGE)
  const logs: CleaningLog[] = []
  for (const row of page) {
    const log = parseCleaningLog(row)
    if (log && log.routine_id === request.routineId && log.voided_at === null) logs.push(log)
  }
  if (rows.length <= CLEANING_HISTORY_PAGE) return { logs, next: null }
  // 続きの位置は、このページの最後の行（画面が読めぬ行でも）から決める。位置を作れねば、続きが
  // 在るのに「無い」と返さず失敗にする
  const last = page[page.length - 1]
  if (!isRecord(last) || !isTimestamptzText(last.created_at) || !isClientId(last.id)) {
    console.error("[cleaning] history page ended on a row without a usable cursor", { userId })
    return { error: HISTORY_FAILED_MESSAGE }
  }
  return { logs, next: { createdAt: last.created_at, id: last.id } }
}
