"use client"

import { AlertTriangle, CalendarCheck, CalendarDays, ChevronRight, Clock, PauseCircle } from "lucide-react"
import { CheckButton } from "@/components/chores/shared/check-button"
import { daysAgoJa, daysUntilJa } from "@/lib/domain/cleaning"
import {
  describeCadence,
  formatYmdJa,
  type CleaningBucket,
  type CleaningRoutine,
  type RoutineStatus,
} from "@/lib/domain/cleaning-schedule"
import { daysBetweenYmd } from "@/lib/utils/date-jst"

const BADGE = "inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-sm font-medium"

/**
 * 項目の状態の印。色だけに頼らず、必ずアイコンと文で示す（期限超過は日数まで言う）。
 */
export function CleaningStatusBadges({ status, bucket }: { status: RoutineStatus; bucket: CleaningBucket }) {
  if (bucket === "paused") {
    return (
      <span className={`${BADGE} bg-muted text-foreground`}>
        <PauseCircle size={14} aria-hidden="true" />
        休止中
      </span>
    )
  }
  return (
    <>
      {bucket === "overdue" && (
        <span className={`${BADGE} bg-destructive/10 text-destructive`}>
          <AlertTriangle size={14} aria-hidden="true" />
          期限を{status.overdueDays}日過ぎています
        </span>
      )}
      {bucket === "today" && (
        <span className={`${BADGE} bg-primary text-primary-foreground`}>
          <CalendarCheck size={14} aria-hidden="true" />
          今日
        </span>
      )}
      {bucket === "this_week" && (
        <span className={`${BADGE} bg-muted text-foreground`}>
          <CalendarDays size={14} aria-hidden="true" />
          今週
        </span>
      )}
      {status.postponed && (
        <span className={`${BADGE} bg-muted text-foreground`}>
          <Clock size={14} aria-hidden="true" />
          延期中
        </span>
      )}
    </>
  )
}

/** 前回実施日の言い方。履歴が無ければ「未記録」（作成日・基準日を実施日に見立てぬ）。 */
export function lastDoneText(status: RoutineStatus, today: string): string {
  if (status.lastDoneOn === null) return "未記録"
  const date = formatYmdJa(status.lastDoneOn, today) ?? status.lastDoneOn
  return status.daysSinceLastDone === null ? date : `${date}（${daysAgoJa(status.daysSinceLastDone)}）`
}

/** 次回予定（延期を反映した期限）の言い方。期限を過ぎた分は印の側が日数を言う。 */
export function nextDueText(status: RoutineStatus, today: string): string {
  if (status.isPaused) return "休止中（再開すると次の予定日が決まります）"
  if (status.dueOn === null) return "計算できません"
  const date = formatYmdJa(status.dueOn, today) ?? status.dueOn
  const until = daysBetweenYmd(today, status.dueOn)
  return until !== null && until >= 0 ? `${date}（${daysUntilJa(until)}）` : date
}

/**
 * 掃除の項目 1 件。左の印が 1 タップ完了（現在の回を閉じる）、右の釦が詳細（履歴・延期・編集）。
 *
 * 長い名前・場所は折り返す（`break-words` + `min-w-0`。320px 幅でも横へはみ出さぬ）。
 */
export function CleaningItemCard({
  routine,
  status,
  bucket,
  today,
  disabled,
  busy,
  onComplete,
  onOpen,
}: {
  routine: CleaningRoutine
  status: RoutineStatus
  bucket: CleaningBucket
  today: string
  /** 新しい操作を受けられぬ（送信中・確認待ち） */
  disabled: boolean
  /** この項目の完了を送信中 */
  busy: boolean
  onComplete: () => void
  onOpen: () => void
}) {
  const cadence = describeCadence(routine)
  // 先の回を続けて閉じた後は、予定日が近づくまで現在の回を閉じられぬ（DB が拒む）。押せぬ理由を文で言う
  const canClose = !status.isPaused && status.currentOccurrence !== null && !status.closeLimitReached
  return (
    <li
      data-testid="cleaning-item"
      className="glass flex items-start gap-2 rounded-2xl p-3 shadow-lg shadow-black/[0.04]"
    >
      <CheckButton
        checked={false}
        busy={busy}
        disabled={disabled || !canClose}
        label={`${routine.name}を完了にする`}
        onCheckedChange={onComplete}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
        <p className="text-base font-medium break-words [overflow-wrap:anywhere]">{routine.name}</p>
        <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">
          {routine.location !== null && <span>{routine.location}・</span>}
          {cadence ?? "周期を確認してください"}
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
        {status.closeLimitReached && (
          <p className="text-sm text-muted-foreground break-words">
            先の回まで記録済みです。次の予定日が近づくと、また完了にできます。
          </p>
        )}
      </div>
      <button
        type="button"
        aria-label={`${routine.name}の詳細を開く`}
        onClick={onOpen}
        className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-muted-foreground transition-colors duration-200 hover:bg-muted/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <ChevronRight size={20} aria-hidden="true" />
      </button>
    </li>
  )
}
