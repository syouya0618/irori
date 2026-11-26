"use client"

import { useState } from "react"
import { AlertCircle, BrushCleaning, ChevronDown, ChevronUp, CircleCheck, Loader2, Plus, Undo2 } from "lucide-react"
import { loadCleaningHistory, saveCleaning } from "@/app/(main)/chores/cleaning/actions"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { EmptyState } from "@/components/chores/shared/empty-state"
import { PendingChoreNotice } from "@/components/chores/shared/pending-chore-notice"
import { RefreshOnVisible } from "@/components/chores/shared/refresh-on-visible"
import { useChoresRefresh } from "@/components/chores/shared/use-chores-refresh"
import {
  CHORE_SAVE_MESSAGES,
  createChoreEditSessions,
  useChoreSave,
  type ChoreSaveOutcome,
  type ChoreSaveSession,
} from "@/components/chores/shared/use-chore-save"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import {
  freezePressedOn,
  isCleaningRequest,
  labelOfCleaningRequest,
  type CleaningRequest,
  type CleaningSaveSuccess,
} from "@/lib/domain/cleaning"
import {
  bucketOf,
  CLEANING_FILTERS,
  describeCadence,
  EMPTY_CLEANING_MARKS,
  formatYmdJa,
  isDueSoonBucket,
  matchesCleaningFilter,
  routineStatusFromMarks,
  type CleaningBucket,
  type CleaningFilter,
  type CleaningLog,
  type CleaningMarks,
  type CleaningRoutine,
  type RoutineStatus,
} from "@/lib/domain/cleaning-schedule"
import { newClientId } from "@/lib/utils/client-id"
import { isValidYmd, todayJstString } from "@/lib/utils/date-jst"
import { segmentCn } from "@/lib/utils/segment-cn"
import { CleaningCalendar, calendarMarksForDate } from "./cleaning-calendar"
import { CleaningItemCard } from "./cleaning-item-card"
import { CleaningItemDetail } from "./cleaning-item-detail"
import { CleaningRoutineForm } from "./cleaning-routine-form"
import { CleaningQuickRecord } from "./cleaning-quick-record"
import { CleaningStatus } from "./cleaning-status"

/** 直後の取り消しの帯を出しておく時間。過ぎた記録は履歴から取り消す。 */
export const CLEANING_UNDO_WINDOW_MS = 10 * 60 * 1000
/** 表示中の定期再取得の間隔（家族の完了を取り込む）。 */
const POLL_MS = 60_000

const FILTER_LABEL: Record<CleaningFilter, string> = {
  all: "すべて",
  week: "週ごと",
  month: "月ごと",
  year: "年ごと",
}

export interface CleaningViewProps {
  view?: "calendar" | "status"
  owner: ChoreOwner
  /** サーバーの今日（JST）。期限・区分はこの日付で計算する */
  today: string
  routines: CleaningRoutine[]
  /** 項目 ID → 有効な履歴の要約。鍵が無い項目は履歴なし（未記録） */
  marks: Record<string, CleaningMarks>
  /** 有効な履歴（直近の一部） */
  logs: CleaningLog[]
  /** 読めなんだ項目の件数（この版が知らぬ周期など） */
  unreadableRoutines: number
  routinesTruncated: boolean
  historyFailed: boolean
  historyTruncated: boolean
}

interface Entry {
  routine: CleaningRoutine
  status: RoutineStatus
  bucket: CleaningBucket
  historyPending: boolean
}

type SheetBody = { kind: "create" } | { kind: "item"; routineId: string; mode: "detail" | "edit" }
/** 開いておるシート。`session` は開くたび（中身を切り替えるたび）に増える編集セッション（R35） */
type SheetState = (SheetBody & { session: number }) | null

interface Notice {
  text: string
  tone: "status" | "alert"
}

/** 結果の文言。`session` はその操作を行った場所（シートの編集セッション。シートの外は undefined） */
interface PlacedNotice extends Notice {
  session: ChoreSaveSession
}

interface LastClosed {
  logId: string
  version: string
  text: string
  at: number
}

/** 保存応答・取り消しのイベントでだけ読む時計。描画中には呼ばない。 */
function cleaningEventTime(): number {
  return Date.now()
}

interface ConfirmedRecord {
  log: CleaningLog
  /** 取消・訂正で実施日ではなくなった日。古い要約から復活させない。 */
  removedDoneDates: string[]
  /** 詳細で読み足した履歴など、訂正前の日付がこの画面にはない。 */
  previousDateUnknown: boolean
}

/** 保存の確定後、次の正常な読み取りまでの前回実施日。回の鍵は世代を含むため再集計しない。 */
function confirmedLastDone(
  routineId: string,
  serverMarks: CleaningMarks,
  logs: readonly CleaningLog[],
  records: readonly ConfirmedRecord[],
  completeHistory: boolean,
): { marks: CleaningMarks; pending: boolean } {
  const affected = records.filter(({ log }) => log.routine_id === routineId)
  if (affected.length === 0) return { marks: serverMarks, pending: false }
  let knownLast: string | null = null
  for (const log of logs) {
    if (log.routine_id === routineId && log.kind === "done" && log.voided_at === null && log.done_on !== null) {
      if (knownLast === null || log.done_on > knownLast) knownLast = log.done_on
    }
  }
  if (completeHistory) return { marks: { ...serverMarks, lastDoneOn: knownLast }, pending: false }

  const before = serverMarks.lastDoneOn
  const changedPrevious = before !== null && affected.some((record) =>
    record.previousDateUnknown || record.removedDoneDates.includes(before),
  )
  // 前回を消したが全履歴はない。見えている古い記録を「最後」とも、0件を「未記録」とも断定しない。
  if (changedPrevious && (knownLast === null || knownLast < before)) {
    return { marks: { ...serverMarks, lastDoneOn: null }, pending: true }
  }
  const lastDoneOn = knownLast !== null && (before === null || knownLast > before) ? knownLast : before
  return { marks: { ...serverMarks, lastDoneOn }, pending: false }
}

/** 結果の文言 1 行（色だけで示さず、アイコン + 文）。 */
function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null
  return notice.tone === "alert" ? (
    <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
      <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
      <span className="min-w-0 break-words">{notice.text}</span>
    </p>
  ) : (
    <p role="status" className="flex items-start gap-2 text-sm text-foreground">
      <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
      <span className="min-w-0 break-words">{notice.text}</span>
    </p>
  )
}

function byDueThenName(a: Entry, b: Entry): number {
  const dueA = a.status.dueOn ?? "9999-12-31"
  const dueB = b.status.dueOn ?? "9999-12-31"
  if (dueA !== dueB) return dueA < dueB ? -1 : 1
  return a.routine.name.localeCompare(b.routine.name, "ja")
}

/**
 * 掃除ルーティーンの画面。
 *
 * カレンダーでは日付を選んで実施を記録し、状況ページでは前回実施からの日数を確認する。
 * 既存の予定管理（今日・今週やること、周期で絞るこのあとの項目）はカレンダーの下に残す。
 *
 * 保存は `useChoreSave`（操作 ID と内容を送信の前に固定・結果不明は同じ操作で確認・自動再送なし）。
 * 期限と区分は、サーバーが読んだ定義と有効な履歴の要約から毎回計算する（前回実施日の写しを持たぬ）。
 *
 * ## 応答は、送ったシートだけを閉じる（R35）
 * シート（項目の追加・詳細・編集）は開くたび・中身を切り替えるたびに新しい編集セッションの番号を持つ
 * （レコード ID ではない。同じ項目を閉じて開き直しても別の番号）。送信の時の番号と応答の時の番号が
 * 一致する時だけ、シートを閉じ・結果をシートの中に出す。違えば（送った後にシートを閉じた・別のシートを
 * 開いた）、開いておるシートの入力・保存中の表示には触れず、結果は「どの操作か」を添えて一覧に出す。
 * その操作自身の控えの確定・一覧の取り直し・直後の取り消しの帯（一覧の部品）は、いつでも反映する。
 */
export function CleaningView({
  view = "calendar",
  owner,
  today,
  routines,
  marks,
  logs,
  unreadableRoutines,
  routinesTruncated,
  historyFailed,
  historyTruncated,
}: CleaningViewProps) {
  const [selectedDate, setSelectedDate] = useState(today)
  // 履歴の取得失敗は新しい断面ではない。確定した保存を、失敗時の空配列で消さない。
  const [lastReadableLogs, setLastReadableLogs] = useState(logs)
  if (!historyFailed && lastReadableLogs !== logs) setLastReadableLogs(logs)
  const receiptSource = historyFailed ? lastReadableLogs : logs
  const [confirmed, setConfirmed] = useState<{ source: CleaningLog[]; records: ConfirmedRecord[] }>({ source: logs, records: [] })
  // 正常な再取得が届いたらサーバーを正本に戻す（家族が行った訂正・取消も受け入れる）。
  const confirmedRecords = confirmed.source === receiptSource ? confirmed.records : []
  const confirmedLogs = confirmedRecords.map(({ log }) => log)
  const visibleLogs = [...logs.filter((log) => !confirmedLogs.some((entry) => entry.id === log.id)), ...confirmedLogs]
  const { refresh } = useChoresRefresh()
  const [filter, setFilter] = useState<CleaningFilter>("all")
  const [sheet, setSheet] = useState<SheetState>(null)
  // 操作の結果。操作した場所（シートの番号 / 一覧）に出す
  const [notice, setNotice] = useState<PlacedNotice | null>(null)
  // 送った後に場所が変わった操作の結果（どの操作かを添える）。開いておるシートには出さず、一覧にだけ出す
  const [earlier, setEarlier] = useState<Notice | null>(null)
  const [lastClosed, setLastClosed] = useState<LastClosed | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  // 編集セッションの番号札（応答の時に今のシートを読む。描画を待たず開閉と同時に書き換える）
  const [sessions] = useState(createChoreEditSessions)

  function openSheet(body: SheetBody) {
    setSheet({ ...body, session: sessions.begin() })
  }

  function closeSheet() {
    sessions.close()
    setSheet(null)
  }

  const nameOfRoutine = (id: string) => routines.find((routine) => routine.id === id)?.name ?? ""
  const nameOfRequest = (request: CleaningRequest): string => {
    if (request.op === "routine") return request.name
    if (request.op === "close" || request.op === "backfill") return nameOfRoutine(request.routineId)
    if (request.op === "state" || request.op === "postpone") return nameOfRoutine(request.id)
    const log = visibleLogs.find((entry) => entry.id === request.id)
    if (log) return nameOfRoutine(log.routine_id)
    // 一覧に無い記録（詳細で読み足した古い履歴）の訂正・取り消しは、開いておる項目のもの
    return sheet?.kind === "item" ? nameOfRoutine(sheet.routineId) : ""
  }

  function onOutcome(outcome: ChoreSaveOutcome<CleaningRequest, CleaningSaveSuccess>) {
    const request = outcome.payload
    const origin = outcome.origin
    // 送ったシートが今も開いておる時だけ、そのシートを閉じる（シートの外の操作は、シートが開いておらねば今の画面）
    const current = origin?.current ?? true
    // 操作した場所が今も同じ時だけ、結果をそこに出す。違えば、どの操作かを添えて一覧にだけ出す
    const inPlace = origin?.inPlace ?? true
    const which = `先に送った操作（${origin?.label ?? labelOfCleaningRequest(request, nameOfRequest(request))}）`
    /** 結果を出す。`earlierText` は場所が変わった時の文（項目名を含まぬ文には、どの操作かを添える） */
    const say = (text: string, tone: Notice["tone"], earlierText: string = text) => {
      if (inPlace) setNotice({ text, tone, session: origin?.place })
      else setEarlier({ text: earlierText, tone })
    }

    if (outcome.kind === "rejected") {
      // 保存されておらぬと確定。シートは開いたまま（入力を直して送り直せる）
      say(outcome.error, "alert", `${which}は保存できませんでした。${outcome.error}`)
      return
    }
    // 確定・結果不明のどちらも、送ったシートを閉じて画面の文言と控えの一覧を見せる
    if (current) closeSheet()
    if (outcome.kind === "unknown") {
      // 結果不明は控えの一覧（「同じ操作で確認」）が、どの操作かを添えて伝える
      if (inPlace) setNotice(null)
      return
    }
    const { result, status } = outcome
    const name = nameOfRequest(request) || "掃除の項目"
    // 書いたと確定した行だけ反映する。結果不明を完了に見せない。
    if (result.log && status !== "conflict") {
      const settledLog = result.log
      const beforeLog = visibleLogs.find((log) => log.id === settledLog.id)
      const removedDate = request.op === "log_void"
        ? settledLog.kind === "done" ? settledLog.done_on : null
        : request.op === "log_update" && beforeLog?.kind === "done" && beforeLog.done_on !== settledLog.done_on
          ? beforeLog.done_on
          : null
      setConfirmed((previous) => {
        const records = previous.source === receiptSource ? previous.records : []
        const prior = records.find(({ log }) => log.id === settledLog.id)
        return {
          source: receiptSource,
          records: [
            ...records.filter(({ log }) => log.id !== settledLog.id),
            {
              log: settledLog,
              removedDoneDates: [...new Set([...(prior?.removedDoneDates ?? []), ...(removedDate === null ? [] : [removedDate])])],
              previousDateUnknown: prior?.previousDateUnknown === true || (request.op === "log_update" && !beforeLog && settledLog.kind === "done"),
            },
          ],
        }
      })
    }
    if (result.detail === "already_closed") {
      setLastClosed(null)
      say(`「${name}」は先に記録されていました。同じ回の記録は 1 件のままです。`, "status")
      return
    }
    if (result.detail === "closed_differently") {
      say(
        `「${name}」の今回の分は、先に別の内容（完了またはスキップ）で記録されていました。変える時は履歴から取り消してください。`,
        "alert",
      )
      return
    }
    if (result.detail === "occurrence_moved") {
      say(`「${name}」の予定が変わっていました。記録はしていません。最新の内容を確認してください。`, "alert")
      return
    }
    if (result.detail === "voided") {
      setLastClosed(null)
      say(`「${name}」の記録は取り消されていました。最新の内容を確認してください。`, "alert")
      return
    }
    if (status === "conflict") {
      say(CHORE_SAVE_MESSAGES.conflict, "alert", `${which}: ${CHORE_SAVE_MESSAGES.conflict}`)
      return
    }
    if (request.op === "close" || request.op === "backfill") {
      const text = request.op === "backfill"
        ? origin?.session === undefined
          ? `「${name}」を${formatYmdJa(result.log?.done_on ?? request.doneOn, today)}に記録しました。`
          : `${labelOfCleaningRequest(request, name)}しました。`
        : request.kind === "done" ? `「${name}」を完了にしました。` : `「${name}」をスキップしました。`
      // 記録した実施日が画面の今日と違う時（日をまたいで確かめ直した・画面が古かった）は、その日付を告げる
      const doneOn = request.op === "close" && request.kind === "done" ? (result.log?.done_on ?? null) : null
      const dated =
        isValidYmd(doneOn) && doneOn !== today
          ? `実施日は${formatYmdJa(doneOn, today) ?? doneOn}で記録しました。違う時は、項目の詳細の履歴から直せます。`
          : ""
      say(`${text}${dated}`, "status")
      // 直後の取り消しは、サーバーが返した行の版で行う（端末の時計で版を作らぬ）。帯は一覧の部品ゆえ、
      // 開いておるシートに関わらず反映する
      setLastClosed(
        result.log ? { logId: result.log.id, version: result.log.updated_at, text, at: cleaningEventTime() } : null,
      )
      return
    }
    if (request.op === "log_void") {
      setLastClosed((prev) => (prev?.logId === request.id ? null : prev))
      say(`「${name}」の記録を取り消しました。`, "status")
      return
    }
    if (request.op === "log_update") {
      setLastClosed((prev) => (prev?.logId === request.id ? null : prev))
    }
    say(`${labelOfCleaningRequest(request, name)}しました。`, "status")
  }

  const save = useChoreSave<CleaningRequest, CleaningSaveSuccess>({
    owner,
    kind: "cleaning",
    run: saveCleaning,
    isPayload: isCleaningRequest,
    onOutcome,
    sessions,
  })

  /**
   * 操作を送る。受け付けたら true。`session` は送ったシートの編集セッション（一覧から送る時は省く）。
   */
  function send(request: CleaningRequest, session?: ChoreSaveSession): boolean {
    setNotice(null)
    // 一覧から次の操作をした = 先に送った操作の結果は見た
    if (session === undefined) setEarlier(null)
    return save.send(request, labelOfCleaningRequest(request, nameOfRequest(request)), session) !== null
  }

  /** このシートの操作が送信中か（ほかの場所の操作の送信中に「保存中」と出さぬ） */
  const sendingFrom = (session: number) =>
    save.pending.some((entry) => entry.phase === "sending" && entry.session === session)

  const entries: Entry[] = routines
    .filter((routine) => !routine.archived)
    .map((routine) => {
      const history = confirmedLastDone(routine.id, marks[routine.id] ?? EMPTY_CLEANING_MARKS, visibleLogs, confirmedRecords, !historyFailed && !historyTruncated)
      const status = routineStatusFromMarks(routine, history.marks, today)
      return { routine, status, bucket: bucketOf(status, today), historyPending: history.pending }
    })
  const pendingHistoryIds = new Set(entries.filter((entry) => entry.historyPending).map((entry) => entry.routine.id))
  const archived = routines.filter((routine) => routine.archived)
  const dueSoon = entries.filter((entry) => isDueSoonBucket(entry.bucket)).sort(byDueThenName)
  const rest = entries
    .filter((entry) => !isDueSoonBucket(entry.bucket) && matchesCleaningFilter(entry.routine, filter))
    .sort((a, b) => {
      // 休止中は末尾
      if ((a.bucket === "paused") !== (b.bucket === "paused")) return a.bucket === "paused" ? 1 : -1
      return byDueThenName(a, b)
    })
  const restTotal = entries.length - dueSoon.length

  const calendarItems = entries.map((entry) => ({
    id: entry.routine.id,
    name: entry.routine.name,
    dueOn: entry.status.isPaused || entry.historyPending ? null : entry.status.dueOn,
    lastDoneOn: entry.status.lastDoneOn,
  }))
  const completedIds = new Set(calendarMarksForDate(selectedDate, calendarItems, visibleLogs).completed.map((item) => item.id))
  // 最新実施日より前の日は、部分履歴の不在だけでは未実施と断定できない。
  // 今日・最新実施日以降・履歴なしが要約で確認できる項目は引き続き記録できる。
  const uncertainDateIds = new Set(entries.filter(({ routine, status }) =>
    (historyFailed || historyTruncated) && !completedIds.has(routine.id) &&
    status.lastDoneOn !== null && selectedDate < status.lastDoneOn,
  ).map(({ routine }) => routine.id))
  const quickPendingIds = new Set([...pendingHistoryIds, ...uncertainDateIds])
  const sendingRecord = save.pending.find((entry) => entry.phase === "sending" && (entry.payload.op === "close" || entry.payload.op === "backfill"))
  const busyRoutineId = sendingRecord && (sendingRecord.payload.op === "close" || sendingRecord.payload.op === "backfill") ? sendingRecord.payload.routineId : null
  const undoing = save.pending.some(
    (entry) => entry.phase === "sending" && entry.payload.op === "log_void" && entry.payload.id === lastClosed?.logId,
  )

  function complete(entry: Entry) {
    if (entry.historyPending || entry.status.currentOccurrence === null || entry.status.closeLimitReached) return
    send({
      op: "close",
      id: newClientId(),
      routineId: entry.routine.id,
      routineVersion: entry.routine.updated_at,
      kind: "done",
      seenOccurrence: entry.status.currentOccurrence,
      // 実施日は最初の押下で固定する（画面の今日が端末の日付と合う時だけ。合わねばサーバーが受けた日）。
      // 応答を失って後日確かめ直しても、確かめた日ではなく押した日で記録される
      pressedOn: freezePressedOn(today, todayJstString()),
    })
  }

  function recordSelectedDay(id: string) {
    if (!isValidYmd(selectedDate) || selectedDate > today || completedIds.has(id)) return
    const entry = entries.find((item) => item.routine.id === id)
    if (!entry || quickPendingIds.has(id)) return
    // 今日の記録は予定の回も進める。過去日や休止中・先の回の上限では、実施だけを追記する。
    if (selectedDate === today && !entry.status.isPaused && entry.status.currentOccurrence !== null && !entry.status.closeLimitReached) {
      send({
        op: "close", id: newClientId(), routineId: id, routineVersion: entry.routine.updated_at,
        kind: "done", seenOccurrence: entry.status.currentOccurrence, pressedOn: selectedDate,
      })
    } else {
      send({
        op: "backfill", id: newClientId(), routineId: id, routineVersion: entry.routine.updated_at,
        doneOn: selectedDate, note: null,
      })
    }
  }

  function undoLastClosed() {
    if (lastClosed === null) return
    if (cleaningEventTime() - lastClosed.at > CLEANING_UNDO_WINDOW_MS) {
      setLastClosed(null)
      setNotice({ text: "取り消せる時間を過ぎました。項目の詳細の履歴から取り消せます。", tone: "alert", session: undefined })
      return
    }
    send({ op: "log_void", id: lastClosed.logId, version: lastClosed.version })
  }

  const openEntry = sheet?.kind === "item" ? entries.find((entry) => entry.routine.id === sheet.routineId) : undefined
  // 並べ替えと、一覧から外れた古い記録の読み足しは詳細が行う
  const openLogs = openEntry
    ? visibleLogs.filter((log) => log.routine_id === openEntry.routine.id && log.voided_at === null)
    : []
  const sheetOpen = sheet?.kind === "create" || openEntry !== undefined

  const saveMessage: Notice | null = save.message ? { text: save.message, tone: save.messageTone } : null
  // シートの中: そのシートの操作の結果と、どの操作にも属さぬ文言（端末の控えを読めぬ等）だけを出す。
  // 送った後に閉じた・別のシートで行った操作の結果は出さぬ（このシートの入力の結果と取り違えぬ）
  const sheetNotice: Notice | null =
    sheet === null
      ? null
      : notice !== null && notice.session === sheet.session
        ? notice
        : saveMessage !== null && (save.messageSession === sheet.session || save.messageSession === null)
          ? saveMessage
          : null
  // 一覧: シートを閉じておる時の、直近の操作の結果
  const pageNotice: Notice | null = sheetOpen ? null : (notice ?? saveMessage)

  const renderCard = (entry: Entry) => (
    <CleaningItemCard
      key={entry.routine.id}
      routine={entry.routine}
      status={entry.status}
      bucket={entry.bucket}
      today={today}
      historyPending={entry.historyPending}
      disabled={save.blocked || entry.historyPending}
      busy={busyRoutineId === entry.routine.id}
      onComplete={() => complete(entry)}
      onOpen={() => openSheet({ kind: "item", routineId: entry.routine.id, mode: "detail" })}
    />
  )

  const inlineUndo = lastClosed !== null ? (
    <div
      data-testid="cleaning-inline-undo"
      className="flex items-center gap-2 rounded-xl border border-border/60 bg-muted/50 py-1 pr-1 pl-3"
    >
      <CircleCheck size={18} className="shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-sm break-words">{lastClosed.text}</span>
      <button
        type="button"
        aria-label="直前の記録を取り消す"
        disabled={save.blocked}
        onClick={undoLastClosed}
        className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-3 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {undoing ? (
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        ) : (
          <Undo2 size={16} aria-hidden="true" />
        )}
        取り消す
      </button>
    </div>
  ) : null

  return (
    <div className="flex flex-col gap-6">
      {view === "calendar" ? (
        <>
          <CleaningCalendar
            today={today}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            items={calendarItems}
            logs={visibleLogs}
            historyFailed={historyFailed}
            historyTruncated={historyTruncated}
            onOpenRoutine={(id) => openSheet({ kind: "item", routineId: id, mode: "detail" })}
          />
          <CleaningQuickRecord
            today={today}
            selectedDate={selectedDate}
            routines={entries.map((entry) => entry.routine)}
            completedIds={completedIds}
            pendingIds={quickPendingIds}
            disabled={save.blocked}
            busyRoutineId={busyRoutineId}
            onSelectDate={setSelectedDate}
            onRecord={recordSelectedDay}
            onAddRoutine={() => openSheet({ kind: "create" })}
          >
            {uncertainDateIds.size > 0 && (
              <div role="status" className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
                <p>選択日の履歴を確認できない項目は、二重記録を防ぐため一時的に記録を止めています。項目の詳細で履歴を確認してから記録してください。</p>
                {historyFailed && <Button type="button" variant="outline" onClick={() => refresh("manual")}>履歴を読み込み直す</Button>}
              </div>
            )}
            {inlineUndo}
          </CleaningQuickRecord>
        </>
      ) : (
        <>
          <CleaningStatus
            today={today}
            entries={entries}
            routinesTruncated={routinesTruncated || unreadableRoutines > 0}
            onOpenRoutine={(id) => openSheet({ kind: "item", routineId: id, mode: "detail" })}
            onAddRoutine={() => openSheet({ kind: "create" })}
          />
          {inlineUndo}
        </>
      )}
      {view === "calendar" && (
        <section aria-labelledby="cleaning-due-heading" className="flex flex-col gap-3">
          <h2 id="cleaning-due-heading" className="text-sm font-semibold text-muted-foreground">
            今日・今週やること
          </h2>
          {entries.length === 0 ? (
            <EmptyState
              icon={BrushCleaning}
              // 読めぬ項目が在る時に「まだありません」と言わぬ（在る項目を無いと偽らぬ）
              title={unreadableRoutines > 0 ? "表示できる項目がありません" : "掃除の項目がまだありません"}
              description="「毎週土曜に浴室の排水口」のように、繰り返す掃除を登録できます。前回からの日数と次の予定日が分かります。"
            >
              <Button type="button" onClick={() => openSheet({ kind: "create" })}>
                <Plus aria-hidden="true" />
                最初の項目を追加
              </Button>
            </EmptyState>
          ) : dueSoon.length === 0 ? (
            <p className="glass flex items-center gap-2 rounded-2xl px-4 py-4 text-sm shadow-lg shadow-black/[0.04]">
              <CircleCheck size={18} className="shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
              今日・今週が期限の掃除はありません。
            </p>
          ) : (
            <ul aria-labelledby="cleaning-due-heading" className="flex flex-col gap-3">
              {dueSoon.map(renderCard)}
            </ul>
      )}


      </section>

      )}

      {/* 送った後に場所が変わった操作の結果（どの操作かを添える）。開いておるシートには出さぬ */}
      {pendingHistoryIds.size > 0 && (
        <div role="status" className="flex flex-col items-start gap-2 rounded-xl border border-border bg-muted/50 p-3 text-sm">
          <p>記録の変更は保存済みです。前回の実施日と次回の目安を確認中です。更新できない場合は、もう一度読み込んでください。</p>
          <Button type="button" variant="outline" onClick={() => refresh("manual")}>もう一度読み込む</Button>
        </div>
      )}
      <NoticeLine notice={earlier} />
      <NoticeLine notice={pageNotice} />
      {/* 控えの一覧は、シートを開いておる間はシートの中に出す（新しい保存を止めておる理由が分かるよう） */}
      {!sheetOpen && <PendingChoreNotice save={save} showMessage={false} />}

      {unreadableRoutines > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            表示できない項目が {unreadableRoutines} 件あります。アプリを更新すると表示できる場合があります。項目は消えていません。
          </span>
        </p>
      )}

      {view === "calendar" && entries.length > 0 && (
        <section aria-labelledby="cleaning-rest-heading" className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id="cleaning-rest-heading" className="text-sm font-semibold text-muted-foreground">
              このあとの項目
            </h2>
            <Button type="button" variant="outline" onClick={() => openSheet({ kind: "create" })}>
              <Plus aria-hidden="true" />
              項目を追加
            </Button>
          </div>
          <div role="group" aria-label="周期で絞り込む" className="flex gap-1 rounded-xl bg-muted/50 p-1">
            {CLEANING_FILTERS.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
                className={`${segmentCn(filter === value)} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
              >
                {FILTER_LABEL[value]}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            絞り込みは周期の単位です。今日・今週が期限の項目は、周期に関わらず上に出ます。
          </p>
          {rest.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {restTotal === 0
                ? "すべての項目が、今日・今週やることに入っています。"
                : `${FILTER_LABEL[filter]}の項目は、このあとの予定にはありません。`}
            </p>
          ) : (
            <ul aria-labelledby="cleaning-rest-heading" className="flex flex-col gap-3">
              {rest.map(renderCard)}
            </ul>
          )}
          {routinesTruncated && (
            <p className="text-sm text-muted-foreground">
              項目が多いため、一部だけ表示しています。使っていない項目をアーカイブすると全て表示できます。
            </p>
          )}
        </section>
      )}

      {archived.length > 0 && (
        <section aria-labelledby="cleaning-archived-heading" className="flex flex-col gap-3">
          <h2 id="cleaning-archived-heading" className="sr-only">
            アーカイブ済みの項目
          </h2>
          <button
            type="button"
            aria-expanded={showArchived}
            aria-controls="cleaning-archived-list"
            onClick={() => setShowArchived((value) => !value)}
            className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-xl px-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span>アーカイブ済み（{archived.length}件）</span>
            {showArchived ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
          </button>
          {showArchived && (
            <ul id="cleaning-archived-list" className="flex flex-col gap-2">
              {archived.map((routine) => (
                <li
                  key={routine.id}
                  className="glass flex items-center gap-3 rounded-2xl px-4 py-2 shadow-lg shadow-black/[0.04]"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-medium break-words [overflow-wrap:anywhere]">{routine.name}</span>
                    <span className="text-sm text-muted-foreground break-words">
                      {describeCadence(routine) ?? "周期を確認してください"}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`${routine.name}を元に戻す`}
                    disabled={save.blocked}
                    onClick={() =>
                      send({
                        op: "routine",
                        id: routine.id,
                        version: routine.updated_at,
                        name: routine.name,
                        location: routine.location,
                        cadenceUnit: routine.cadence_unit,
                        cadenceInterval: routine.cadence_interval,
                        scheduleMode: routine.schedule_mode,
                        anchorDate: routine.anchor_date,
                        archived: false,
                      })
                    }
                  >
                    元に戻す
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <RefreshOnVisible pollMs={POLL_MS} />

      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => {
          if (!open) closeSheet()
        }}
      >
        <SheetContent side="bottom" className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom">
          {sheet?.kind === "create" && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle>掃除の項目を追加</SheetTitle>
                <SheetDescription>追加した項目は、家族の端末にも表示されます。</SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
                <NoticeLine notice={sheetNotice} />
                <PendingChoreNotice save={save} showMessage={false} />
                {/* 編集セッションごとに作り直す（別のセッションの入力・状態を持ち越さぬ） */}
                <CleaningRoutineForm
                  key={sheet.session}
                  editing={null}
                  today={today}
                  disabled={save.blocked}
                  saving={sendingFrom(sheet.session)}
                  onSubmit={(request) => send(request, sheet.session)}
                  onCancel={closeSheet}
                />
              </div>
            </>
          )}
          {sheet?.kind === "item" && openEntry && (
            <>
              <SheetHeader className="pr-14 pb-0">
                <SheetTitle className="break-words [overflow-wrap:anywhere]">{openEntry.routine.name}</SheetTitle>
                <SheetDescription>
                  {sheet.mode === "edit" ? "名前・場所・周期を変更します。" : "記録・延期・履歴の確認ができます。"}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
                <NoticeLine notice={sheetNotice} />
                <PendingChoreNotice save={save} showMessage={false} />
                {sheet.mode === "edit" ? (
                  <CleaningRoutineForm
                    key={`${openEntry.routine.id}:${sheet.session}`}
                    editing={openEntry.routine}
                    today={today}
                    disabled={save.blocked}
                    saving={sendingFrom(sheet.session)}
                    onSubmit={(request) => send(request, sheet.session)}
                    onCancel={() => openSheet({ kind: "item", routineId: openEntry.routine.id, mode: "detail" })}
                  />
                ) : (
                  <CleaningItemDetail
                    key={`${openEntry.routine.id}:${sheet.session}`}
                    routine={openEntry.routine}
                    status={openEntry.status}
                    bucket={openEntry.bucket}
                    logs={openLogs}
                    historyFailed={historyFailed}
                    historyTruncated={historyTruncated}
                    historyPending={openEntry.historyPending}
                    today={today}
                    disabled={save.blocked}
                    send={(request) => send(request, sheet.session)}
                    loadHistory={loadCleaningHistory}
                    onEdit={() => openSheet({ kind: "item", routineId: openEntry.routine.id, mode: "edit" })}
                  />
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  )
}
