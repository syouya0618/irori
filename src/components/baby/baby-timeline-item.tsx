"use client"

import {
  Droplets,
  Moon,
  Milk,
  ChevronRight,
  Thermometer,
  Ruler,
  StickyNote,
} from "lucide-react"
import { getLogSummary } from "@/lib/domain/baby-log-summary"
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

// 1 行の要約（getLogSummary）は中立モジュール src/lib/domain/baby-log-summary.ts にある。
// このファイルは use client 指令つきゆえ、Server Component（検索結果）から値を import させぬ。

interface BabyTimelineItemProps {
  log: BabyLogData
  onEdit: (log: BabyLogData) => void
  /** 記録者の表示名（機能 A）。null / 省略なら出さぬ */
  recorderLabel?: string | null
}

export function BabyTimelineItem({
  log,
  onEdit,
  recorderLabel = null,
}: BabyTimelineItemProps) {
  const config = logTypeConfig[log.log_type]
  const Icon = config.icon

  return (
    // 時刻を左の列に大きく置く（ぴよログ等の記録アプリと同じ読み方: 時刻 → 何を）。夜間に
    // 「最後はいつ何をしたか」を縦に目で追えるよう、時刻の桁を揃えて左端に固定する
    <button
      type="button"
      onClick={() => onEdit(log)}
      className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left transition-colors duration-200 hover:bg-muted/50 active:bg-muted/70 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="w-12 shrink-0 font-mono text-base font-semibold tabular-nums">
        {formatTimeJst(log.logged_at)}
      </span>
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-full ${config.bg}`}
        aria-hidden="true"
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
        {/* 記録者（二人以上の世帯でだけ親が渡す）。誰が付けた記録かで引き継ぎが分かる */}
        {recorderLabel && (
          <span className="max-w-20 truncate leading-tight">{recorderLabel}</span>
        )}
        <ChevronRight size={16} aria-hidden="true" />
      </div>
    </button>
  )
}
