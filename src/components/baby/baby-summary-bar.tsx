"use client"

import { Milk, Droplets, Timer } from "lucide-react"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import { todayJstString, formatTimeJst } from "@/lib/utils/date-jst"
import { computeNextPumping } from "@/lib/domain/baby-pumping"
import type { TodayCounts } from "@/lib/domain/baby-log-aggregation"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 授乳チップの値を種別内訳（母乳8・ミルク2・搾乳1・離乳食1）へ整形する。
 *
 * **なぜ合算「N回」をやめたか**: 母乳サイクル数を bottle/pumped/solid と混ぜて
 * 「授乳 N 回」と見せると、「母乳を何回あげたか」が読めない（混合数に化ける）。
 * おむつチップの「おしっこ2・うんち1」と同じ流儀で非ゼロのみを「・」で連結する。
 *
 * 全ゼロのときは `feedingCount` へ退避する: 記録のない日は 0 なので「0回」になり、
 * feeding 行はあるのに内訳が立たない日（`feeding_type` が未知 enum 値で null 退化
 * した #159 の経路）にだけ合算回数が出る — 行があるのに「0回」と嘘をつかないため。
 */
function formatFeedingBreakdown(counts: TodayCounts): string {
  const parts: string[] = []
  if (counts.breastCycleCount > 0) parts.push(`母乳${counts.breastCycleCount}`)
  if (counts.bottleCount > 0) parts.push(`ミルク${counts.bottleCount}`)
  if (counts.pumpedCount > 0) parts.push(`搾乳${counts.pumpedCount}`)
  if (counts.solidCount > 0) parts.push(`離乳食${counts.solidCount}`)
  if (parts.length > 0) return parts.join("・")
  return `${counts.feedingCount}回`
}

interface BabySummaryBarProps {
  lastFeeding: BabyLogData | null
  /** 最後の搾乳（feeding_type='pumped'）。次の搾乳の目安の起点に使う */
  lastPumped: BabyLogData | null
  /** 搾乳間隔（分・設定値）。最後の搾乳＋この間隔で次の目安を出す */
  pumpingIntervalMin: number
  now: Date
  todayCounts: TodayCounts
  /** 表示中の日付（YYYY-MM-DD、JST）。今日か過去日かでラベル・経過表示を切り替える */
  date: string
}

export function BabySummaryBar({
  lastFeeding,
  lastPumped,
  pumpingIntervalMin,
  now,
  todayCounts,
  date,
}: BabySummaryBarProps) {
  // isToday は now 引数由来で判定する（実行環境の実時計は見ない）。
  // テストで now を固定した際に実日付とズレて誤判定しないため。
  const isToday = date === todayJstString(now)
  const [, monthStr, dayStr] = date.split("-")
  const dateLabel = isToday
    ? "今日のまとめ"
    : `${Number(monthStr)}/${Number(dayStr)} のまとめ`

  const feedingElapsed =
    isToday && lastFeeding
      ? minutesBetween(lastFeeding.logged_at, now.toISOString())
      : null

  // 次の搾乳の目安: 今日の表示 + 最後の搾乳がある時のみ（最後の搾乳＋設定間隔）
  const nextPumping =
    isToday && lastPumped
      ? computeNextPumping(lastPumped.logged_at, pumpingIntervalMin, now)
      : null

  return (
    <div className="flex flex-col gap-3">
      {/* 今日のまとめ（ひと目化） */}
      <div
        role="group"
        aria-label={dateLabel}
        className="glass flex items-center justify-around rounded-2xl px-3 py-2.5 shadow-lg shadow-black/[0.04]"
      >
        <TodayStat
          icon={<Milk size={14} className="text-amber-600 dark:text-amber-400" />}
          label="授乳"
          value={formatFeedingBreakdown(todayCounts)}
        />
        <div className="h-8 w-px bg-border" aria-hidden="true" />
        <TodayStat
          icon={<Droplets size={14} className="text-sky-600 dark:text-sky-400" />}
          label="おむつ"
          value={`おしっこ${todayCounts.peeCount}・うんち${todayCounts.poopCount}`}
        />
      </div>

      {/* 直近の経過（最終授乳・おむつ） */}
      <div className="grid grid-cols-2 gap-3">
        {/* Last feeding */}
        <div className="glass flex flex-col items-center gap-1.5 rounded-2xl p-3 shadow-lg shadow-black/[0.04]">
          <div className="flex size-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <Milk size={16} className="text-amber-700 dark:text-amber-300" />
          </div>
          <span className="text-[10px] text-muted-foreground">最終授乳</span>
          <span className="font-mono text-xs font-semibold">
            {isToday
              ? feedingElapsed !== null
                ? formatElapsedMinutes(feedingElapsed) + "前"
                : "---"
              : // 過去日: lastFeeding はその日の logs 由来なので絶対時刻は正確
                lastFeeding
                ? formatTimeJst(lastFeeding.logged_at)
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
            {todayCounts.diaperCount > 0
              ? `おしっこ${todayCounts.peeCount}・うんち${todayCounts.poopCount}`
              : "---"}
          </span>
        </div>
      </div>

      {/* 次の搾乳の目安（最後の搾乳＋設定間隔）。搾乳記録がある今日だけ表示 */}
      {nextPumping && (
        <div className="glass flex items-center gap-2.5 rounded-2xl px-3 py-2.5 shadow-lg shadow-black/[0.04]">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
            <Timer size={16} className="text-amber-700 dark:text-amber-300" />
          </div>
          <span className="text-xs text-muted-foreground">次の搾乳の目安</span>
          <span className="ml-auto flex items-baseline gap-1.5">
            <span className="font-mono text-sm font-semibold">
              {formatTimeJst(nextPumping.targetIso)}
            </span>
            <span
              className={`text-[11px] ${
                nextPumping.minutesUntil > 0
                  ? "text-muted-foreground"
                  : "font-semibold text-amber-600 dark:text-amber-400"
              }`}
            >
              {nextPumping.minutesUntil > 0
                ? `あと${formatElapsedMinutes(nextPumping.minutesUntil)}`
                : "そろそろです"}
            </span>
          </span>
        </div>
      )}
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
    // 授乳・おむつの値は複合表示（母乳8・ミルク2 / おしっこ2・うんち1）ゆえ、
    // 横並びだと text-sm では狭い端末で行が溢れる。値を text-xs に落とし、
    // さらに min-w-0 を置いて flex アイテムが縮める（= 溢れた最悪ケースは
    // カードを横に破らず 2 行へ折り返す）ようにする。whitespace-nowrap は付けない。
    <div className="flex min-w-0 flex-col items-center gap-0.5 text-center">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <span className="text-xs font-semibold tabular-nums">{value}</span>
    </div>
  )
}
