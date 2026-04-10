"use client"

import { Baby } from "lucide-react"
import { BabyTimelineItem } from "./baby-timeline-item"
import type { BabyLogData } from "@/lib/types/baby"

interface BabyTimelineProps {
  logs: BabyLogData[]
  onEdit: (log: BabyLogData) => void
}

export function BabyTimeline({ logs, onEdit }: BabyTimelineProps) {
  if (logs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12">
        <Baby size={48} className="text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">
          まだ記録がありません
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <h2 className="px-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        タイムライン
      </h2>
      <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] divide-y divide-border/30">
        {logs.map((log) => (
          <BabyTimelineItem key={log.id} log={log} onEdit={onEdit} />
        ))}
      </div>
    </div>
  )
}
