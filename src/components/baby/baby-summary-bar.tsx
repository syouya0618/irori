"use client"

import { Milk, Droplets, Moon, Sun } from "lucide-react"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import type { TodayCounts } from "@/lib/domain/baby-log-aggregation"
import type { BabyLogData } from "@/lib/types/baby"

interface BabySummaryBarProps {
  lastFeeding: BabyLogData | null
  activeSleep: BabyLogData | null
  lastSleepEndedAt: string | null
  now: Date
  todayCounts: TodayCounts
}

export function BabySummaryBar({
  lastFeeding,
  activeSleep,
  lastSleepEndedAt,
  now,
  todayCounts,
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
    <div className="flex flex-col gap-3">
      {/* 今日のまとめ（ひと目化） */}
      <div
        aria-label="今日のまとめ"
        className="glass flex items-center justify-around rounded-2xl px-3 py-2.5 shadow-lg shadow-black/[0.04]"
      >
        <TodayStat
          icon={<Milk size={14} className="text-amber-600 dark:text-amber-400" />}
          label="授乳"
          value={`${todayCounts.feedingCount}回`}
        />
        <div className="h-8 w-px bg-border" aria-hidden="true" />
        <TodayStat
          icon={<Moon size={14} className="text-violet-600 dark:text-violet-400" />}
          label="睡眠"
          value={formatElapsedMinutes(todayCounts.totalSleepMinutes)}
        />
        <div className="h-8 w-px bg-border" aria-hidden="true" />
        <TodayStat
          icon={<Droplets size={14} className="text-sky-600 dark:text-sky-400" />}
          label="おむつ"
          value={`${todayCounts.diaperCount}回`}
        />
      </div>

      {/* 直近の経過（次の授乳の目安・睡眠状態） */}
      <div className="grid grid-cols-3 gap-3">
        {/* Last feeding */}
        <div className="glass flex flex-col items-center gap-1.5 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
          <div className="flex size-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <Milk size={16} className="text-amber-700 dark:text-amber-300" />
          </div>
          <span className="text-[10px] text-muted-foreground">最終授乳</span>
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
            {todayCounts.diaperCount > 0 ? `${todayCounts.diaperCount}回` : "---"}
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
    </div>
  )
}

function TodayStat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <span className="text-sm font-semibold tabular-nums">{value}</span>
    </div>
  )
}
