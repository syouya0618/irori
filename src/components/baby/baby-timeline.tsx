"use client"

import { useMemo } from "react"
import { Baby } from "lucide-react"
import { BabyTimelineItem } from "./baby-timeline-item"
import type { BabyLogData } from "@/lib/types/baby"

interface BabyTimelineProps {
  logs: BabyLogData[]
  onEdit: (log: BabyLogData) => void
}

export function BabyTimeline({ logs, onEdit }: BabyTimelineProps) {
  // タイムラインは logged_at 降順（新しい順）で描画する（contract）。dashboard 側は
  // Realtime UPDATE を in-place 置換・INSERT/楽観記録を先頭 prepend するため受け取り順は
  // 時系列にならない。時刻編集・過去時刻の新規作成後も並びを保つよう描画直前に単一点ソートする。
  // DB/Realtime 行は全て UTC の同一形式ゆえ ISO 文字列 compare で足り、同値は sort の安定性で
  // 元順を保つ（growthLogs/集計の localeCompare 慣習と整合。prop は破壊せずコピーをソート）。
  const sortedLogs = useMemo(
    () => [...logs].sort((a, b) => b.logged_at.localeCompare(a.logged_at)),
    [logs],
  )

  if (sortedLogs.length === 0) {
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
        {sortedLogs.map((log) => (
          <BabyTimelineItem key={log.id} log={log} onEdit={onEdit} />
        ))}
      </div>
    </div>
  )
}
