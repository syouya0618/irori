"use client"

import { CheckCircle2, CloudOff, RotateCw, Users } from "lucide-react"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import { getLogSummary } from "@/lib/domain/baby-log-summary"
import type { HandoffSummary } from "@/lib/domain/handoff"
import { FRESHNESS_RETRY_LABEL, HOME_STATUS_WORDS } from "@/lib/domain/freshness"
import type { BabyLogData } from "@/lib/types/baby"

/** "10/26 22:15"（今日なら時刻だけ） */
function whenLabel(iso: string, today: string): string {
  const ymd = toJstDateString(iso)
  const time = formatTimeJst(iso)
  if (ymd === today) return time
  const [, m, d] = ymd.split("-")
  return `${Number(m)}/${Number(d)} ${time}`
}

interface BabyHandoffSummaryProps {
  summary: HandoffSummary
  /** 今日（JST）。前回の確認の表示で日付を添えるかに使う */
  today: string
  /** 数えた範囲の文言（「直近8日」等。部分取得を「全部」と言わぬ） */
  scopeLabel: string
  /** 「確認した」（この端末の印を今の内容へ進める。家族の既読とは関係ない） */
  onAcknowledge: () => void
}

/**
 * 「前回この端末で見てから」（2026-10-27 C4）。記録された事実だけを短く出す。誰が直したか・
 * 家族が読んだか・削除の有無は記録に無いゆえ言わぬ。何も無ければ描かぬ（カードを増やさぬ）。
 */
export function BabyHandoffSummary({
  summary,
  today,
  scopeLabel,
  onAcknowledge,
}: BabyHandoffSummaryProps) {
  if (summary.status === "first") return null
  if (summary.status === "failed") {
    return (
      <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <Users size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
        前回この端末で見てからの記録は、読み込めなかったため数えられません。
      </p>
    )
  }
  const { newByOthers, newByMe, updated, since, sinceBeforeWindow } = summary
  if (newByOthers === 0 && updated === 0) return null
  const parts: string[] = []
  if (newByOthers > 0) parts.push(`新しい記録 ${newByOthers}件（ほかの方が記録）`)
  if (updated > 0) parts.push(`更新のある記録 ${updated}件`)
  return (
    <section
      aria-label="前回この端末で見てから"
      className="glass flex flex-col gap-1.5 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]"
    >
      <p className="flex items-start gap-2 text-sm">
        <Users size={16} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold">
            前回この端末で見てから（{whenLabel(since, today)} 以降）
          </span>
          <span>{parts.join("・")}</span>
          <span className="text-xs text-muted-foreground">
            {scopeLabel}の範囲で数えています
            {sinceBeforeWindow ? "（前回の確認はこの範囲より前です。範囲外は数えていません）" : ""}
            。{updated > 0 ? "更新した人は記録されていません。" : ""}
            削除された記録はここには出ません。
            {newByMe > 0 ? `ご自身の記録 ${newByMe}件は含めていません。` : ""}
          </span>
        </span>
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onAcknowledge}
          className="min-h-11 cursor-pointer rounded-lg px-3 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10"
        >
          確認した
        </button>
      </div>
    </section>
  )
}

interface BabyFreshnessNoticeProps {
  /** describeStale の文言（null なら描かぬ） */
  message: string | null
  onRetry: () => void
  retrying?: boolean
}

/**
 * 「最新を確認できません（最終確認 HH:mm）」と再試行（2026-10-27 C1）。取り直しの失敗を黙って
 * 古い表示のまま出し続けぬ。重要なエラーゆえ畳まぬ場所（タイムラインの上）に出す。
 */
export function BabyFreshnessNotice({ message, onRetry, retrying = false }: BabyFreshnessNoticeProps) {
  if (!message) return null
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground"
    >
      <CloudOff size={14} className="shrink-0" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        aria-label={`最新を${FRESHNESS_RETRY_LABEL}`}
        className="touch-target flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 font-medium text-primary transition-colors duration-200 hover:bg-primary/10 disabled:opacity-50"
      >
        <RotateCw size={14} aria-hidden="true" />
        {FRESHNESS_RETRY_LABEL}
      </button>
    </div>
  )
}

interface BabyLastRecordProps {
  /** サーバが確定した行（この画面で最後に記録が付いた行）。null なら描かぬ */
  log: BabyLogData | null
  today: string
}

/**
 * 保存の後の確認（2026-10-27 C1）。この画面で最後に付いた記録を、記録の釦のすぐ下の決まった
 * 場所に出す。トーストが消えても残る。値は logs の state（サーバの確定行）から導くだけで、
 * 別の保存状態を持たぬ — 編集・取り消しで行が変われば、この表示も同じ行に追従する。
 */
export function BabyLastRecord({ log, today }: BabyLastRecordProps) {
  if (!log) return null
  // 一つの文字列で出す（タイムラインの行の文言と同じ文字列の要素を増やさぬ）
  // 授乳の logged_at は開始時刻（CLAUDE.md の契約）ゆえ「開始」と添える（最終授乳の表示と同じ）
  const when = `${whenLabel(log.logged_at, today)}${log.log_type === "feeding" ? " 開始" : ""}`
  const text = `${HOME_STATUS_WORDS.saved}: ${when}・${getLogSummary(log)}`
  return (
    <p
      role="status"
      aria-label="直前に記録した内容"
      className="flex items-center gap-2 rounded-xl bg-muted/60 px-3 py-2 text-sm tabular-nums dark:bg-muted/40"
    >
      <CheckCircle2 size={16} className="shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">{text}</span>
    </p>
  )
}
