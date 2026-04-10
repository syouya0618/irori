"use client"

import { Baby, Droplets, Moon, Milk, ChevronsRight } from "lucide-react"
import {
  getFeedingTypeLabel,
  getDiaperTypeLabel,
  minutesBetween,
  formatElapsedMinutes,
} from "@/lib/utils/baby-log-labels"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

const logTypeConfig = {
  feeding: {
    icon: Milk,
    bg: "bg-amber-100",
    text: "text-amber-700",
  },
  diaper: {
    icon: Droplets,
    bg: "bg-sky-100",
    text: "text-sky-700",
  },
  sleep: {
    icon: Moon,
    bg: "bg-violet-100",
    text: "text-violet-700",
  },
} as const

function getLogSummary(log: BabyLogData): string {
  switch (log.log_type) {
    case "feeding":
      if (!log.feeding_type) return "授乳"
      const label = getFeedingTypeLabel(log.feeding_type)
      if (log.amount_ml) return `${label} ${log.amount_ml}ml`
      return label
    case "diaper":
      return log.diaper_type ? getDiaperTypeLabel(log.diaper_type) : "おむつ"
    case "sleep":
      if (log.ended_at) {
        const mins = minutesBetween(log.logged_at, log.ended_at)
        return `${formatElapsedMinutes(mins)}`
      }
      return "睡眠中..."
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
