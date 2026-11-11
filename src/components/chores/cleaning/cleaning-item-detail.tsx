"use client"

import { useEffect, useId, useRef, useState, useTransition } from "react"
import { AlertCircle, Archive, CircleCheck, History, Loader2, Pause, Pencil, Play, SkipForward, Undo2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SectionError } from "@/components/chores/shared/section-error"
import {
  CLEANING_DATE_MIN,
  CLEANING_NOTE_MAX,
  compareCleaningLogsNewestFirst,
  freezePressedOn,
  normalizeOptionalText,
  oldestCleaningLogCursor,
  parseCleaningLog,
  postponeRangeOf,
  type CleaningHistoryCursor,
  type CleaningHistoryRequest,
  type CleaningHistoryResult,
  type CleaningRequest,
} from "@/lib/domain/cleaning"
import {
  describeCadence,
  formatYmdJa,
  type CleaningBucket,
  type CleaningLog,
  type CleaningRoutine,
  type RoutineStatus,
} from "@/lib/domain/cleaning-schedule"
import { newClientId } from "@/lib/utils/client-id"
import { isValidYmd, shiftYmd, todayJstString } from "@/lib/utils/date-jst"
import { CleaningStatusBadges, lastDoneText, nextDueText } from "./cleaning-item-card"

/** 履歴に一度に並べる件数（「古い記録をさらに表示」で同じ件数ずつ足す）。 */
const HISTORY_VISIBLE = 20
const HISTORY_LOAD_FAILED = "履歴を読み込めませんでした。通信状況を確認して、もう一度お試しください。"

/** 訂正中の履歴。`version` は訂正を開いた時点の版（保存はこの版で送る）。 */
interface LogDraft {
  id: string
  version: string
  doneOn: string
  note: string
}

function draftOf(log: CleaningLog): LogDraft {
  return { id: log.id, version: log.updated_at, doneOn: log.done_on ?? "", note: log.note ?? "" }
}

function ymd(value: string | null, today: string): string {
  return formatYmdJa(value, today) ?? value ?? ""
}

/** 履歴 1 件の言い方。スキップ・過去日の追記は、実施と取り違えぬよう種類を文で言う。 */
function logTitle(log: CleaningLog, today: string): string {
  if (log.kind === "done") {
    const date = ymd(log.done_on, today)
    return log.occurrence === null ? `${date} に実施（あとから記録）` : `${date} に実施`
  }
  if (log.kind === "skip") return `${ymd(log.occurrence, today)} の回をスキップ`
  return `${ymd(log.occurrence, today)} の回の記録`
}

/**
 * 項目の詳細（下シートの中身）。完了・スキップ・延期・過去日の記録・履歴の訂正と取り消し・
 * 休止と再開・編集・アーカイブをここから行う。
 *
 * 保存は親が持つ（`send` が受け付けたら true）。ここは要求を組むだけで、回の鍵は
 * 「画面が見ておった回」として運ぶ（実際に閉じる回・延期する回はサーバーが決める）。
 *
 * ## 履歴は項目ごとに古い方まで読める
 * 親が渡す `logs` は、世帯全体の直近の記録からこの項目の分を抜いたものじゃ（年 1 回の項目の前回の
 * 記録は、そこに入っておらぬことがある）。打ち切られておる時・一覧を読めなんだ時は、この項目の
 * 続きを `loadHistory` で読み足し、どの記録にも訂正・取り消しの釦を出す。読み足した分はこの詳細を
 * 開いておる間だけ持つ（保存が確定すれば親がシートを閉じるゆえ、古い版の行を持ち越さぬ）。
 *
 * ## 履歴の訂正は「訂正を開いた時点の版」を送る
 * 訂正欄を開いたまま、背景の再取得でその記録が新しい版へ差し替わっても、開いた時の入力に新しい版を
 * 付けて送らぬ（家族の訂正を黙って巻き戻す）。版が進んだら保存を止め、最新の内容で開き直させる。
 */
export function CleaningItemDetail({
  routine,
  status,
  bucket,
  logs,
  historyFailed,
  historyTruncated,
  today,
  disabled,
  send,
  loadHistory,
  onEdit,
}: {
  routine: CleaningRoutine
  status: RoutineStatus
  bucket: CleaningBucket
  /** この項目の有効な履歴のうち、一覧（世帯全体の直近）に入っておった分 */
  logs: readonly CleaningLog[]
  historyFailed: boolean
  historyTruncated: boolean
  today: string
  disabled: boolean
  send: (request: CleaningRequest) => boolean
  /** この項目の、より古い履歴を 1 ページ読む（Server Action） */
  loadHistory: (request: CleaningHistoryRequest) => Promise<CleaningHistoryResult>
  onEdit: () => void
}) {
  const baseId = useId()
  const range = postponeRangeOf(routine, status, today)
  const canPostpone = range !== null && range.max >= range.min
  const [postponeTo, setPostponeTo] = useState("")
  const [backfillOn, setBackfillOn] = useState(shiftYmd(today, -1))
  const [backfillNote, setBackfillNote] = useState("")
  const [editingLog, setEditingLog] = useState<LogDraft | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 読み足した古い履歴。`cursor` は続きの位置（undefined = まだ読み足しておらぬ、null = これより古い記録は無い）
  const [older, setOlder] = useState<CleaningLog[]>([])
  const [cursor, setCursor] = useState<CleaningHistoryCursor | null | undefined>(undefined)
  const [visibleCount, setVisibleCount] = useState(HISTORY_VISIBLE)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [loadingHistory, startHistoryLoad] = useTransition()
  const aliveRef = useRef(false)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const occurrence = status.currentOccurrence
  const hasOccurrence = !status.isPaused && occurrence !== null
  // 先の回を続けて閉じた後は、現在の回の鍵が DB の上限を越える（予定日が近づくまで閉じられぬ）
  const canClose = hasOccurrence && !status.closeLimitReached
  const nextIfDone = canClose ? status.nextAfterCompletion(today) : null
  const nextIfSkipped = canClose ? status.nextAfterSkip() : null

  // 一覧の分（最新の版）を優先し、読み足した分のうち一覧に無いものを足す
  const listedIds = new Set(logs.map((log) => log.id))
  const allLogs = [...logs, ...older.filter((log) => !listedIds.has(log.id))].sort(compareCleaningLogsNewestFirst)
  const visibleLogs = allLogs.slice(0, visibleCount)
  // 一覧が世帯全体で打ち切られておる・読めなんだ時だけ、サーバーに続きが在りうる
  const mayHaveOlder = (historyTruncated || historyFailed) && cursor !== null
  const canShowMore = allLogs.length > visibleCount || mayHaveOlder

  function showOlder() {
    if (allLogs.length > visibleCount) {
      setVisibleCount((count) => count + HISTORY_VISIBLE)
      return
    }
    if (!mayHaveOlder || loadingHistory) return
    setHistoryError(null)
    // 続きの位置: 読み足し済みならサーバーが返した位置、まだなら読み込み済みの最古の記録
    const before = cursor === undefined ? oldestCleaningLogCursor(allLogs) : cursor
    startHistoryLoad(async () => {
      try {
        const result = await loadHistory({ routineId: routine.id, before })
        // 詳細を閉じた・別の項目へ移った後に届いた応答は捨てる
        if (!aliveRef.current) return
        if ("error" in result) {
          setHistoryError(result.error || HISTORY_LOAD_FAILED)
          return
        }
        // Server の応答ゆえ形を信用せず読み直す。別の項目・取り消し済みの行は混ぜぬ
        const loaded: CleaningLog[] = []
        for (const row of Array.isArray(result.logs) ? result.logs : []) {
          const log = parseCleaningLog(row)
          if (log && log.routine_id === routine.id && log.voided_at === null) loaded.push(log)
        }
        setOlder((prev) => {
          const known = new Set(prev.map((log) => log.id))
          return [...prev, ...loaded.filter((log) => !known.has(log.id))]
        })
        setCursor(result.next ?? null)
        setVisibleCount((count) => count + HISTORY_VISIBLE)
      } catch (err) {
        console.error("[cleaning] 履歴の読み込みに失敗", { message: err instanceof Error ? err.message : String(err) })
        if (aliveRef.current) setHistoryError(HISTORY_LOAD_FAILED)
      }
    })
  }

  function close(kind: "done" | "skip") {
    if (occurrence === null || !canClose) return
    setError(null)
    send({
      op: "close",
      id: newClientId(),
      routineId: routine.id,
      routineVersion: routine.updated_at,
      kind,
      seenOccurrence: occurrence,
      // 完了の実施日は、最初の押下で固定する（画面の今日が端末の日付と合う時だけ。合わねばサーバーが決める）
      pressedOn: kind === "done" ? freezePressedOn(today, todayJstString()) : null,
    })
  }

  function postpone() {
    if (occurrence === null || range === null) return
    if (!isValidYmd(postponeTo) || postponeTo < range.min || postponeTo > range.max) {
      setError(`延期先は${ymd(range.min, today)}から${ymd(range.max, today)}までの日付を選んでください。`)
      return
    }
    setError(null)
    send({ op: "postpone", id: routine.id, version: routine.updated_at, seenOccurrence: occurrence, until: postponeTo })
  }

  function backfill() {
    if (!isValidYmd(backfillOn) || backfillOn < CLEANING_DATE_MIN) {
      setError("実施した日を選んでください。")
      return
    }
    if (backfillOn > today) {
      setError("未来の日付は実施日として記録できません。今日までの日付を選んでください。")
      return
    }
    const note = normalizeOptionalText(backfillNote)
    if (note !== null && [...note].length > CLEANING_NOTE_MAX) {
      setError(`メモは${CLEANING_NOTE_MAX}文字までにしてください。`)
      return
    }
    setError(null)
    send({
      op: "backfill",
      id: newClientId(),
      routineId: routine.id,
      routineVersion: routine.updated_at,
      doneOn: backfillOn,
      note,
    })
  }

  function saveLogEdit(log: CleaningLog) {
    if (editingLog === null || editingLog.id !== log.id) return
    // 訂正を開いた後にこの記録が変わっておれば送らぬ（釦も無効にしてある）
    if (log.updated_at !== editingLog.version) return
    const isDone = log.kind === "done"
    if (isDone && (!isValidYmd(editingLog.doneOn) || editingLog.doneOn < CLEANING_DATE_MIN)) {
      setError("実施した日を選んでください。")
      return
    }
    if (isDone && editingLog.doneOn > today) {
      setError("未来の日付は実施日として記録できません。今日までの日付を選んでください。")
      return
    }
    const note = normalizeOptionalText(editingLog.note)
    if (note !== null && [...note].length > CLEANING_NOTE_MAX) {
      setError(`メモは${CLEANING_NOTE_MAX}文字までにしてください。`)
      return
    }
    setError(null)
    // 版は訂正を開いた時点のもの（生きた行の版を読まぬ）
    send({ op: "log_update", id: log.id, version: editingLog.version, doneOn: isDone ? editingLog.doneOn : null, note })
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
          {routine.location !== null && <span>{routine.location}・</span>}
          {describeCadence(routine) ?? "周期を確認してください"}
        </p>
        <div className="flex flex-wrap gap-1.5 empty:hidden">
          <CleaningStatusBadges status={status} bucket={bucket} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-sm">
          <dt className="text-muted-foreground">前回</dt>
          <dd className="break-words">{lastDoneText(status, today)}</dd>
          <dt className="text-muted-foreground">次回</dt>
          <dd className="break-words">{nextDueText(status, today)}</dd>
        </dl>
      </section>

      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {hasOccurrence && !canClose && (
        <section aria-labelledby={`${baseId}-close`} className="flex flex-col gap-2">
          <h3 id={`${baseId}-close`} className="text-sm font-semibold">
            今回の分
          </h3>
          <p data-testid="cleaning-close-limit" className="text-sm text-muted-foreground">
            先の回まで完了・スキップを記録済みのため、次の予定日が近づくまで今回の分は記録できません。今日掃除した時は、下の「過去にやった日を記録」から今日の日付で記録できます。先の回の記録を取り消す時は、下の履歴から取り消せます。
          </p>
        </section>
      )}

      {canClose && (
        <section aria-labelledby={`${baseId}-close`} className="flex flex-col gap-2">
          <h3 id={`${baseId}-close`} className="text-sm font-semibold">
            今回の分
          </h3>
          <div className="flex flex-wrap gap-2">
            <Button type="button" disabled={disabled} onClick={() => close("done")}>
              <CircleCheck aria-hidden="true" />
              今日やったことにする
            </Button>
            <Button type="button" variant="outline" disabled={disabled} onClick={() => close("skip")}>
              <SkipForward aria-hidden="true" />
              今回はスキップ
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            {nextIfDone !== null && <>今日やると、次回は{ymd(nextIfDone, today)}です。</>}
            {nextIfSkipped !== null && (
              <>スキップすると、実施の記録は付けずに次回（{ymd(nextIfSkipped, today)}）へ進みます。</>
            )}
            昨日など別の日に済ませていた時は、完了にしたあと下の履歴で実施日を直せます。
          </p>
        </section>
      )}

      {hasOccurrence && (
        <section aria-labelledby={`${baseId}-postpone`} className="flex flex-col gap-2">
          <h3 id={`${baseId}-postpone`} className="text-sm font-semibold">
            延期
          </h3>
          {status.postponed && (
            <div className="flex flex-col gap-2">
              <p className="text-sm">
                今回の期限を{ymd(status.dueOn, today)}へ延期しています（元の予定日は{ymd(status.scheduledOn, today)}）。
              </p>
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={disabled}
                onClick={() => {
                  setError(null)
                  send({ op: "state", id: routine.id, version: routine.updated_at, action: "clear_postpone" })
                }}
              >
                延期を取り消す
              </Button>
            </div>
          )}
          {canPostpone && range !== null ? (
            <>
              <label htmlFor={`${baseId}-postpone-date`} className="text-sm text-muted-foreground">
                今回の期限だけを動かします。前回実施日と、次回以降の予定日は変わりません。
                {range.nextScheduledOn !== null && (
                  <>次の予定日（{ymd(range.nextScheduledOn, today)}）の前日まで選べます。</>
                )}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={`${baseId}-postpone-date`}
                  type="date"
                  value={postponeTo}
                  min={range.min}
                  max={range.max}
                  className="h-11 w-auto min-w-40 flex-1"
                  onChange={(event) => {
                    setPostponeTo(event.target.value)
                    setError(null)
                  }}
                />
                <Button type="button" variant="outline" disabled={disabled || postponeTo === ""} onClick={postpone}>
                  この日まで延期
                </Button>
              </div>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              次の予定日が近いため、これ以上は延期できません。今回を見送る時はスキップを使ってください。
            </p>
          )}
        </section>
      )}

      <section aria-labelledby={`${baseId}-backfill`} className="flex flex-col gap-2">
        <h3 id={`${baseId}-backfill`} className="text-sm font-semibold">
          過去にやった日を記録
        </h3>
        <p className="text-sm text-muted-foreground">
          記録し忘れた過去の実施を、履歴へ追加します。今回の分は完了になりません
          {routine.schedule_mode === "after_done" && "（前回実施日が新しくなれば、次回の予定日は数え直します）"}。
        </p>
        <label htmlFor={`${baseId}-backfill-date`} className="text-sm font-medium">
          実施した日
        </label>
        <Input
          id={`${baseId}-backfill-date`}
          type="date"
          value={backfillOn}
          min={CLEANING_DATE_MIN}
          max={today}
          className="h-11"
          onChange={(event) => {
            setBackfillOn(event.target.value)
            setError(null)
          }}
        />
        <label htmlFor={`${baseId}-backfill-note`} className="text-sm font-medium">
          メモ（任意）
        </label>
        <Input
          id={`${baseId}-backfill-note`}
          value={backfillNote}
          maxLength={CLEANING_NOTE_MAX}
          autoComplete="off"
          className="h-11"
          onChange={(event) => {
            setBackfillNote(event.target.value)
            setError(null)
          }}
        />
        <Button type="button" variant="outline" className="self-start" disabled={disabled} onClick={backfill}>
          この日の実施を記録
        </Button>
      </section>

      <section aria-labelledby={`${baseId}-history`} className="flex flex-col gap-2">
        <h3 id={`${baseId}-history`} className="text-sm font-semibold">
          履歴
        </h3>
        {/* 一覧を読めなんだ時も、この項目の分は下の釦で読める（読めた分は下に並べる） */}
        {historyFailed && allLogs.length === 0 && cursor !== null && <SectionError what="履歴" />}
        {visibleLogs.length === 0 ? (
          (!historyFailed || cursor === null) && (
            <p className="text-sm text-muted-foreground">
              {cursor === null
                ? "この項目の記録は見つかりませんでした。"
                : historyTruncated
                  ? "直近の履歴の中に、この項目の記録は見つかりませんでした。古い記録は下の釦で読み込めます。"
                  : "まだ記録がありません。"}
            </p>
          )
        ) : (
          <ul className="flex flex-col gap-3">
            {visibleLogs.map((log) => {
              const title = logTitle(log, today)
              const editingThis = editingLog?.id === log.id
              // 訂正を開いた後に、別の端末がこの記録を変えた（開いた時の入力では保存させぬ）
              const changedElsewhere = editingThis && editingLog !== null && log.updated_at !== editingLog.version
              return (
                <li
                  key={log.id}
                  data-testid="cleaning-log"
                  className="flex flex-col gap-2 border-t border-border/60 pt-3 first:border-t-0 first:pt-0"
                >
                  <p className="text-sm font-medium break-words">{title}</p>
                  {log.note !== null && (
                    <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{log.note}</p>
                  )}
                  {editingThis && editingLog !== null ? (
                    <div className="flex flex-col gap-2">
                      {changedElsewhere && (
                        <div
                          role="alert"
                          className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3"
                        >
                          <p className="flex items-start gap-2 text-sm text-foreground">
                            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                            <span className="min-w-0 break-words">
                              他の端末でこの記録が変更されました。開いた時の入力のままでは保存できません（家族の変更を上書きしないためです）。上の最新の内容を確かめてから、訂正し直してください。
                            </span>
                          </p>
                          <Button
                            type="button"
                            variant="outline"
                            className="self-start"
                            onClick={() => {
                              setEditingLog(draftOf(log))
                              setError(null)
                            }}
                          >
                            最新の内容で訂正し直す
                          </Button>
                        </div>
                      )}
                      {log.kind === "done" && (
                        <>
                          <label htmlFor={`${baseId}-log-date-${log.id}`} className="text-sm font-medium">
                            実施した日
                          </label>
                          <Input
                            id={`${baseId}-log-date-${log.id}`}
                            type="date"
                            value={editingLog.doneOn}
                            min={CLEANING_DATE_MIN}
                            max={today}
                            className="h-11"
                            onChange={(event) => {
                              setEditingLog({ ...editingLog, doneOn: event.target.value })
                              setError(null)
                            }}
                          />
                        </>
                      )}
                      <label htmlFor={`${baseId}-log-note-${log.id}`} className="text-sm font-medium">
                        メモ（任意）
                      </label>
                      <Input
                        id={`${baseId}-log-note-${log.id}`}
                        value={editingLog.note}
                        maxLength={CLEANING_NOTE_MAX}
                        autoComplete="off"
                        className="h-11"
                        onChange={(event) => {
                          setEditingLog({ ...editingLog, note: event.target.value })
                          setError(null)
                        }}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" disabled={disabled || changedElsewhere} onClick={() => saveLogEdit(log)}>
                          訂正を保存
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setEditingLog(null)}>
                          やめる
                        </Button>
                      </div>
                    </div>
                  ) : confirming === log.id ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">
                        取り消すと、前回実施日と次回の予定日をこの記録が無かったものとして数え直します。
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="destructive"
                          disabled={disabled}
                          onClick={() => {
                            setConfirming(null)
                            setError(null)
                            send({ op: "log_void", id: log.id, version: log.updated_at })
                          }}
                        >
                          この記録を取り消す
                        </Button>
                        <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                          やめる
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {log.kind !== "other" && (
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`${title}を訂正`}
                          disabled={disabled}
                          onClick={() => {
                            setConfirming(null)
                            setEditingLog(draftOf(log))
                          }}
                        >
                          <Pencil aria-hidden="true" />
                          訂正
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`${title}を取り消す`}
                        disabled={disabled}
                        onClick={() => {
                          setEditingLog(null)
                          setConfirming(log.id)
                        }}
                      >
                        <Undo2 aria-hidden="true" />
                        取り消す
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {historyError !== null && (
          <p role="alert" className="text-sm text-destructive">
            {historyError}
          </p>
        )}
        {canShowMore && (
          <>
            {visibleLogs.length > 0 && (
              <p className="text-sm text-muted-foreground">
                新しい順に一部だけ表示しています。古い記録は消えていません。下の釦で読み込むと、訂正・取り消しができます。
              </p>
            )}
            <Button
              type="button"
              variant="outline"
              className="self-start"
              disabled={loadingHistory}
              onClick={showOlder}
            >
              {loadingHistory ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <History aria-hidden="true" />
              )}
              {historyFailed && allLogs.length === 0 ? "この項目の履歴を読み込む" : "古い記録をさらに表示"}
            </Button>
          </>
        )}
        {!canShowMore && cursor === null && allLogs.length > 0 && (
          <p className="text-sm text-muted-foreground">この項目の記録は、これで全てです。</p>
        )}
      </section>

      <section aria-labelledby={`${baseId}-manage`} className="flex flex-col gap-2">
        <h3 id={`${baseId}-manage`} className="text-sm font-semibold">
          項目の管理
        </h3>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={disabled} onClick={onEdit}>
            <Pencil aria-hidden="true" />
            編集
          </Button>
          {status.isPaused ? (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setError(null)
                send({ op: "state", id: routine.id, version: routine.updated_at, action: "resume" })
              }}
            >
              <Play aria-hidden="true" />
              再開する
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => {
                setError(null)
                send({ op: "state", id: routine.id, version: routine.updated_at, action: "pause" })
              }}
            >
              <Pause aria-hidden="true" />
              休止する
            </Button>
          )}
          {confirming !== "archive" && (
            <Button type="button" variant="outline" disabled={disabled} onClick={() => setConfirming("archive")}>
              <Archive aria-hidden="true" />
              アーカイブ
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {status.isPaused
            ? "再開すると、再開した日より前の予定日は期限超過として数えません。"
            : "休止の間は期限を数えません。旅行や季節で使わない時に。"}
        </p>
        {confirming === "archive" && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              アーカイブすると一覧から外れます。履歴は消えず、あとで元に戻せます。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="destructive"
                disabled={disabled}
                onClick={() => {
                  setConfirming(null)
                  setError(null)
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
                    archived: true,
                  })
                }}
              >
                アーカイブする
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                やめる
              </Button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
