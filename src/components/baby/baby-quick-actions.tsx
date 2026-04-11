"use client"

import { useTransition } from "react"
import { Loader2, Moon, Sun, Thermometer, Ruler, StickyNote } from "lucide-react"
import { toast } from "sonner"
import {
  recordFeeding,
  recordDiaper,
  startSleep,
  endSleep,
} from "@/app/(main)/baby/actions"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const FEEDING_OPTIONS: { value: FeedingType; label: string }[] = [
  { value: "breast_left", label: "左" },
  { value: "breast_right", label: "右" },
  { value: "bottle", label: "ミルク" },
  { value: "solid", label: "離乳食" },
]

const DIAPER_OPTIONS: { value: DiaperType; label: string }[] = [
  { value: "pee", label: "おしっこ" },
  { value: "poop", label: "うんち" },
  { value: "both", label: "両方" },
]

interface BabyQuickActionsProps {
  activeSleep: BabyLogData | null
  now: Date
  onCreateLog: (type: BabyLogType) => void
  onStartTimer: (type: FeedingType) => void
}

export function BabyQuickActions({
  activeSleep,
  now,
  onCreateLog,
  onStartTimer,
}: BabyQuickActionsProps) {
  const [isPending, startTransition] = useTransition()

  function handleFeeding(feedingType: FeedingType) {
    startTransition(async () => {
      const result = await recordFeeding({ feedingType })
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("授乳を記録しました")
    })
  }

  function handleDiaper(diaperType: DiaperType) {
    startTransition(async () => {
      const result = await recordDiaper({ diaperType })
      if (result.error) {
        toast.error(result.error)
        return
      }
      toast.success("おむつ交換を記録しました")
    })
  }

  function handleSleepToggle() {
    startTransition(async () => {
      if (activeSleep) {
        const result = await endSleep(activeSleep.id)
        if (result.error) {
          toast.error(result.error)
          return
        }
        const mins = minutesBetween(
          activeSleep.logged_at,
          new Date().toISOString(),
        )
        toast.success(`おはよう！（${formatElapsedMinutes(mins)}）`)
      } else {
        const result = await startSleep()
        if (result.error) {
          toast.error(result.error)
          return
        }
        toast.success("おやすみなさい")
      }
    })
  }

  const sleepElapsed = activeSleep
    ? minutesBetween(activeSleep.logged_at, now.toISOString())
    : null

  return (
    <div className="flex flex-col gap-3">
      {/* Feeding */}
      <div className="space-y-1.5">
        <span className="px-1 text-xs font-semibold text-muted-foreground">
          授乳
        </span>
        <div className="flex gap-1.5">
          {FEEDING_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() =>
                opt.value === "breast_left" || opt.value === "breast_right"
                  ? onStartTimer(opt.value)
                  : handleFeeding(opt.value)
              }
              disabled={isPending}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-amber-50 text-sm font-medium text-amber-800 transition-colors duration-200 hover:bg-amber-100 active:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50 dark:active:bg-amber-900/70"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-3">
        {/* Diaper */}
        <div className="flex-1 space-y-1.5">
          <span className="px-1 text-xs font-semibold text-muted-foreground">
            おむつ
          </span>
          <div className="flex gap-1.5">
            {DIAPER_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleDiaper(opt.value)}
                disabled={isPending}
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-sky-50 text-sm font-medium text-sky-800 transition-colors duration-200 hover:bg-sky-100 active:bg-sky-200 disabled:opacity-50 dark:bg-sky-900/30 dark:text-sky-200 dark:hover:bg-sky-900/50 dark:active:bg-sky-900/70"
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Sleep toggle */}
        <div className="w-28 space-y-1.5">
          <span className="px-1 text-xs font-semibold text-muted-foreground">
            睡眠
          </span>
          <button
            onClick={handleSleepToggle}
            disabled={isPending}
            className={`flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition-colors duration-200 disabled:opacity-50 ${
              activeSleep
                ? "bg-violet-100 text-violet-800 hover:bg-violet-200 active:bg-violet-300 dark:bg-violet-900/30 dark:text-violet-200 dark:hover:bg-violet-900/50 dark:active:bg-violet-900/70"
                : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100 active:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-200 dark:hover:bg-emerald-900/50 dark:active:bg-emerald-900/70"
            }`}
          >
            {isPending ? (
              <Loader2 size={16} className="animate-spin" />
            ) : activeSleep ? (
              <>
                <Sun size={16} />
                <span className="font-mono text-xs">
                  {sleepElapsed !== null
                    ? formatElapsedMinutes(sleepElapsed)
                    : "起こす"}
                </span>
              </>
            ) : (
              <>
                <Moon size={16} />
                ねんね
              </>
            )}
          </button>
        </div>
      </div>

      {/* その他（体温・成長・メモ） */}
      <div className="flex gap-1.5">
        <button
          onClick={() => onCreateLog("temperature")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-50 text-sm font-medium text-rose-800 transition-colors duration-200 hover:bg-rose-100 active:bg-rose-200 disabled:opacity-50 dark:bg-rose-900/30 dark:text-rose-200 dark:hover:bg-rose-900/50 dark:active:bg-rose-900/70"
        >
          <Thermometer size={16} />
          体温
        </button>
        <button
          onClick={() => onCreateLog("growth")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-teal-50 text-sm font-medium text-teal-800 transition-colors duration-200 hover:bg-teal-100 active:bg-teal-200 disabled:opacity-50 dark:bg-teal-900/30 dark:text-teal-200 dark:hover:bg-teal-900/50 dark:active:bg-teal-900/70"
        >
          <Ruler size={16} />
          成長
        </button>
        <button
          onClick={() => onCreateLog("memo")}
          disabled={isPending}
          className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gray-100 text-sm font-medium text-gray-700 transition-colors duration-200 hover:bg-gray-200 active:bg-gray-300 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700 dark:active:bg-gray-600"
        >
          <StickyNote size={16} />
          メモ
        </button>
      </div>
    </div>
  )
}
