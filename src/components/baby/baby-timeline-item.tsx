"use client"

import {
  Droplets,
  Moon,
  Milk,
  ChevronsRight,
  Thermometer,
  Ruler,
  StickyNote,
} from "lucide-react"
import {
  getFeedingTypeLabel,
  getDiaperTypeLabel,
  formatBreastCounts,
  formatBreastSideBreakdown,
  formatDurationSec,
} from "@/lib/utils/baby-log-labels"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"
import type { BabyLogType } from "@/lib/types/database"

// `sleep` は記録導線ごと廃止した旧種別だが、DB の ENUM 値としては残る
// （Postgres は ENUM 値を削除できない）。`Record<BabyLogType, …>` の網羅性のため、
// および万一の残存行で `config.icon` が undefined 参照になってダッシュボードごと
// 落ちる enum drift（#147/#158 と同型）を避けるため、退化形の定義だけ残す。
const logTypeConfig: Record<
  BabyLogType,
  { icon: typeof Milk; bg: string; text: string }
> = {
  feeding: { icon: Milk, bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-300" },
  diaper: { icon: Droplets, bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-300" },
  sleep: { icon: Moon, bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-300" },
  temperature: { icon: Thermometer, bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-300" },
  growth: { icon: Ruler, bg: "bg-teal-100 dark:bg-teal-900/40", text: "text-teal-700 dark:text-teal-300" },
  memo: { icon: StickyNote, bg: "bg-gray-100 dark:bg-gray-800", text: "text-gray-600 dark:text-gray-300" },
}

function getLogSummary(log: BabyLogData): string {
  switch (log.log_type) {
    case "feeding": {
      if (!log.feeding_type) return "授乳"
      const label = getFeedingTypeLabel(log.feeding_type)
      const parts = [label]
      // 母乳サイクル（'breast'）で左右別時間（sides）を持つ行は
      // 「母乳 左2回7分30秒・右1回5分」と側ごとに表示し、合計は併記しない
      // （左右の和と自明・二重表示は密度を壊す）。sides を持たない行
      // （#165 期の旧サイクル行）は従来の「母乳 左2・右1 12分30秒」へフォールバック。
      if (log.feeding_type === "breast" && log.breast_left_sec != null) {
        const breakdown = formatBreastSideBreakdown(
          log.breast_left_count,
          log.breast_right_count,
          log.breast_left_sec,
          log.breast_right_sec,
        )
        if (breakdown) parts.push(breakdown)
        return parts.join(" ")
      }
      // formatBreastCounts は内訳なし（両側 0/null）で "" を返す契約ゆえ、空文字を
      // push すると join(" ") で「母乳  12分30秒」と二重空白の間延びした行になる。
      if (log.feeding_type === "breast") {
        const counts = formatBreastCounts(
          log.breast_left_count,
          log.breast_right_count,
        )
        if (counts) parts.push(counts)
      }
      if (log.amount_ml != null) parts.push(`${log.amount_ml}ml`)
      // 秒精度があれば「M分S秒」で表示、無ければ従来の分表示にフォールバック
      if (log.duration_sec != null) parts.push(formatDurationSec(log.duration_sec))
      else if (log.duration_min) parts.push(`${log.duration_min}分`)
      return parts.join(" ")
    }
    case "diaper":
      return log.diaper_type ? getDiaperTypeLabel(log.diaper_type) : "おむつ"
    // 廃止済みの旧種別（上の logTypeConfig と同じ理由で退化形のみ残す）
    case "sleep":
      return "睡眠"
    case "temperature":
      return log.temperature != null ? `${log.temperature}℃` : "体温"
    case "growth": {
      const parts: string[] = []
      if (log.weight_g != null) parts.push(`${log.weight_g}g`)
      if (log.height_cm != null) parts.push(`${log.height_cm}cm`)
      return parts.length > 0 ? parts.join(" / ") : "成長記録"
    }
    case "memo":
      return log.memo ? log.memo.slice(0, 20) : "メモ"
  }
}

interface BabyTimelineItemProps {
  log: BabyLogData
  onEdit: (log: BabyLogData) => void
}

export function BabyTimelineItem({ log, onEdit }: BabyTimelineItemProps) {
  const config = logTypeConfig[log.log_type]
  const Icon = config.icon

  return (
    <button
      onClick={() => onEdit(log)}
      className="flex w-full items-center gap-3 rounded-2xl p-3 text-left transition-colors duration-200 hover:bg-muted/50 active:bg-muted/70"
    >
      <div
        className={`flex size-10 shrink-0 items-center justify-center rounded-full ${config.bg}`}
      >
        <Icon size={18} className={config.text} />
      </div>

      <div className="min-w-0 flex-1">
        {log.log_type === "memo" ? (
          // メモは全文をタイムラインでも読めるよう複数行で頭出し（改行を反映）。
          // 密度維持のため line-clamp-3 で切り、全文は編集シート/日記ビューで読む。
          <p className="text-sm whitespace-pre-wrap line-clamp-3">
            {log.memo || "メモ"}
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">{getLogSummary(log)}</p>
            {log.memo && (
              // メモ注記は複数行入力に対応（改行反映・2行まで頭出し）。
              <p className="line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {log.memo}
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="font-mono">{formatTimeJst(log.logged_at)}</span>
        <ChevronsRight size={12} />
      </div>
    </button>
  )
}
