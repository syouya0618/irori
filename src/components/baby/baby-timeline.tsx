"use client"

import { useMemo } from "react"
import Link from "next/link"
import { Baby, ChevronRight, RotateCw, Search, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BabyTimelineItem } from "./baby-timeline-item"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 選択日の記録の取得状態（P2-10）。
 * - ready: `logs` はこの日の行
 * - loading: 日付を切り替えて取得中。前の日の行は見せず、骨組みを出す
 * - error: 取得に失敗。前の日の行は見せず、失敗と再読み込みの導線を出す
 */
export type BabyTimelineStatus = "ready" | "loading" | "error"

interface BabyTimelineProps {
  logs: BabyLogData[]
  onEdit: (log: BabyLogData) => void
  /** 省略時は ready（取得状態を持たぬ呼び出し向け） */
  status?: BabyTimelineStatus
  /** error の時の「もう一度読み込む」 */
  onRetry?: () => void
  /**
   * 記録者（logged_by）の表示名を返す（機能 A）。null / 省略なら各行に記録者を出さぬ
   * （一人の世帯）。
   */
  recorderLabelFor?: ((loggedBy: string) => string) | null
}

function TimelineHeading() {
  return (
    <div className="flex items-center justify-between px-1">
      <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        タイムライン
      </h2>
      {/* 全履歴の検索（機能 B）。日記の「すべて」と同じ型の入口 */}
      <Link
        href="/baby/search"
        className="flex min-h-11 items-center gap-0.5 px-1 text-xs text-muted-foreground transition-colors duration-200 hover:text-foreground"
      >
        <Search size={13} className="shrink-0" />
        記録を探す
        <ChevronRight size={13} className="shrink-0" />
      </Link>
    </div>
  )
}

export function BabyTimeline({
  logs,
  onEdit,
  status = "ready",
  onRetry,
  recorderLabelFor = null,
}: BabyTimelineProps) {
  // タイムラインは logged_at 降順（新しい順）で描画する（contract）。dashboard 側は
  // Realtime UPDATE を in-place 置換・INSERT/楽観記録を先頭 prepend するため受け取り順は
  // 時系列にならない。時刻編集・過去時刻の新規作成後も並びを保つよう描画直前に単一点ソートする。
  // DB/Realtime 行は全て UTC の同一形式ゆえ ISO 文字列 compare で足り、同値は sort の安定性で
  // 元順を保つ（growthLogs/集計の localeCompare 慣習と整合。prop は破壊せずコピーをソート）。
  const sortedLogs = useMemo(
    () => [...logs].sort((a, b) => b.logged_at.localeCompare(a.logged_at)),
    [logs],
  )

  if (status === "loading") {
    return (
      <div className="flex flex-col gap-1">
        <TimelineHeading />
        {/* 骨組み（DESIGN_SYSTEM: 読み込み中 = Skeleton / animate-pulse）。行の高さは
            実際のアイテム（p-3 + size-10）に合わせ、取得後のずれを小さくする */}
        <div
          role="status"
          aria-label="記録を読み込み中"
          className="glass flex flex-col divide-y divide-border/30 rounded-2xl shadow-lg shadow-black/[0.04]"
        >
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 p-3" aria-hidden="true">
              <div className="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex flex-1 flex-col gap-1.5">
                <div className="h-3.5 w-2/5 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/5 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (status === "error") {
    return (
      <div className="flex flex-col gap-1">
        <TimelineHeading />
        <div
          role="alert"
          className="glass flex flex-col items-center gap-3 rounded-2xl px-4 py-8 shadow-lg shadow-black/[0.04]"
        >
          <TriangleAlert size={32} className="text-destructive" aria-hidden="true" />
          <p className="text-center text-sm text-muted-foreground">
            この日の記録を読み込めませんでした
          </p>
          <Button type="button" variant="outline" onClick={onRetry} className="min-h-11">
            <RotateCw size={16} />
            もう一度読み込む
          </Button>
        </div>
      </div>
    )
  }

  if (sortedLogs.length === 0) {
    return (
      <div className="flex flex-col gap-1">
        <TimelineHeading />
        <div className="flex flex-col items-center justify-center gap-3 py-10">
          <Baby size={48} className="text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">
            まだ記録がありません
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <TimelineHeading />
      <div className="glass rounded-2xl shadow-lg shadow-black/[0.04] divide-y divide-border/30">
        {sortedLogs.map((log) => (
          <BabyTimelineItem
            key={log.id}
            log={log}
            onEdit={onEdit}
            recorderLabel={recorderLabelFor ? recorderLabelFor(log.logged_by) : null}
          />
        ))}
      </div>
    </div>
  )
}
