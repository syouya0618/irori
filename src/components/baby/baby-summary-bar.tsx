"use client"

import { Milk, Droplets, Moon, Sun } from "lucide-react"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import type { BabyLogData } from "@/lib/types/baby"

interface BabySummaryBarProps {
  lastFeeding: BabyLogData | null
  diaperCount: number
  activeSleep: BabyLogData | null
  lastSleepEndedAt: string | null
  now: Date
}

export function BabySummaryBar({
  lastFeeding,
  diaperCount,
  activeSleep,
  lastSleepEndedAt,
  now,
}: BabySummaryBarProps) {
  const feedingElapsed = lastFeeding
    ? minutesBetween(lastFeeding.logged_at, now.toISOString())
    : null

  const sleepElapsed = activeSleep
    ? minutesBetween(activeSleep.logged_at, now.toISOString())
    : null

  // 覚醒時間: 起きている + 最後に起きた時刻がある場合に計算
  const awakeElapsed =
    !activeSleep && lastSleepEndedAt
      ? minutesBetween(lastSleepEndedAt, now.toISOString())
      : null

  return (
    <div className="grid grid-cols-3 gap-3">
      {/* Last feeding */}
      <div className="glass flex flex-col items-center gap-1.5 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
        <div className="flex size-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
          <Milk size={16} className="text-amber-700 dark:text-amber-300" />
        </div>
        <span className="text-[10px] text-muted-foreground">授乳</span>
        <span className="font-mono text-xs font-semibold">
          {feedingElapsed !== null
            ? formatElapsedMinutes(feedingElapsed) + "前"
            : "---"}
        </span>
      </div>

      {/* Diaper count */}
      <div className="glass flex flex-col items-center gap-1.5 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
        <div className="flex size-8 items-center justify-center rounded-full bg-sky-100 dark:bg-sky-900/40">
          <Droplets size={16} className="text-sky-700 dark:text-sky-300" />
        </div>
        <span className="text-[10px] text-muted-foreground">おむつ</span>
        <span className="font-mono text-xs font-semibold">
          {diaperCount > 0 ? `${diaperCount}回` : "---"}
        </span>
      </div>

      {/* Sleep status */}
      <div className="glass flex flex-col items-center gap-1.5 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
        <div
          className={`flex size-8 items-center justify-center rounded-full ${
            activeSleep
              ? "bg-violet-100 dark:bg-violet-900/40"
              : "bg-emerald-100 dark:bg-emerald-900/40"
          }`}
        >
          {activeSleep ? (
            <Moon size={16} className="text-violet-700 dark:text-violet-300" />
          ) : (
            <Sun size={16} className="text-emerald-700 dark:text-emerald-300" />
          )}
        </div>
        <span className="text-[10px] text-muted-foreground">
          {activeSleep ? "睡眠中" : "起きてる"}
        </span>
        <span className="font-mono text-xs font-semibold">
          {sleepElapsed !== null
            ? formatElapsedMinutes(sleepElapsed)
            : awakeElapsed !== null
              ? formatElapsedMinutes(awakeElapsed)
              : "---"}
        </span>
      </div>
    </div>
  )
}
