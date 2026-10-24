"use client"

import { Milk, Droplets, Thermometer, Ruler, StickyNote, Plus } from "lucide-react"
import { formatDiaryDateHeadingFromYmd } from "@/lib/domain/baby-diary"
import type { BabyLogType, FeedingType } from "@/lib/types/database"

interface BabyPastDayActionsProps {
  /** 追記する日（YYYY-MM-DD, JST）。見出しに日本語の日付で示す */
  date: string
  onCreateLog: (type: BabyLogType) => void
  onCreateFeeding: (type: FeedingType) => void
}

const buttonCn =
  "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition-colors duration-200 disabled:opacity-50"

/**
 * 過去日の「この日の記録を追加」（機能 C）。
 *
 * 今日のクイック記録（1 タップで「今」を記録する）とは意味を分け、過去日では必ず
 * 記録フォームを開いて日付・時刻を見える形で確かめてから保存する。かつて F-03 として
 * 見送った懸念（今の記録を誤って過去に保存する）は、(1) クイック記録を過去日に出さぬ
 * (2) フォームが日付を明示して持つ (3) appendLog が行の日付で窓を判定する、の 3 点で閉じた。
 */
export function BabyPastDayActions({
  date,
  onCreateLog,
  onCreateFeeding,
}: BabyPastDayActionsProps) {
  const dateLabel = formatDiaryDateHeadingFromYmd(date)
  return (
    <section aria-label="この日の記録を追加" className="flex flex-col gap-1.5">
      <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
        <Plus size={14} aria-hidden="true" />
        この日の記録を追加
      </h2>
      <p className="px-1 text-[11px] text-muted-foreground">
        {dateLabel} の記録として保存します。日付と時刻は記録画面で確かめられます
      </p>
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => onCreateFeeding("bottle")}
          className={`${buttonCn} bg-amber-50 text-amber-800 hover:bg-amber-100 active:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50 dark:active:bg-amber-900/70`}
        >
          <Milk size={16} />
          授乳
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("diaper")}
          className={`${buttonCn} bg-sky-50 text-sky-800 hover:bg-sky-100 active:bg-sky-200 dark:bg-sky-900/30 dark:text-sky-200 dark:hover:bg-sky-900/50 dark:active:bg-sky-900/70`}
        >
          <Droplets size={16} />
          おむつ
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("temperature")}
          className={`${buttonCn} bg-rose-50 text-rose-800 hover:bg-rose-100 active:bg-rose-200 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50 dark:active:bg-rose-900/70`}
        >
          <Thermometer size={16} />
          体温
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("growth")}
          className={`${buttonCn} bg-teal-50 text-teal-800 hover:bg-teal-100 active:bg-teal-200 dark:bg-teal-900/30 dark:text-teal-200 dark:hover:bg-teal-900/50 dark:active:bg-teal-900/70`}
        >
          <Ruler size={16} />
          成長
        </button>
        <button
          type="button"
          onClick={() => onCreateLog("memo")}
          className={`${buttonCn} bg-gray-100 text-gray-700 hover:bg-gray-200 active:bg-gray-300 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:active:bg-gray-600`}
        >
          <StickyNote size={16} />
          メモ
        </button>
      </div>
    </section>
  )
}
