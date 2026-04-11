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
  minutesBetween,
  formatElapsedMinutes,
} from "@/lib/utils/baby-log-labels"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"
import type { BabyLogType } from "@/lib/types/database"

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
      if (log.amount_ml) parts.push(`${log.amount_ml}ml`)
      if (log.duration_min) parts.push(`${log.duration_min}分`)
      return parts.join(" ")
    }
    case "diaper":
      return log.diaper_type ? getDiaperTypeLabel(log.diaper_type) : "おむつ"
    case "sleep":
      if (log.ended_at) {
        const mins = minutesBetween(log.logged_at, log.ended_at)
        return formatElapsedMinutes(mins)
      }
      return "睡眠中..."
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
        <p className="text-sm font-medium">{getLogSummary(log)}</p>
        {log.memo && (
          <p className="truncate text-xs text-muted-foreground">{log.memo}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="font-mono">{formatTimeJst(log.logged_at)}</span>
        <ChevronsRight size={12} />
      </div>
    </button>
  )
}
