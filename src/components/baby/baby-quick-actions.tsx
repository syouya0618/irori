"use client"

import { useTransition } from "react"
import { Loader2, Moon, Sun } from "lucide-react"
import { toast } from "sonner"
import {
  recordFeeding,
  recordDiaper,
  startSleep,
  endSleep,
} from "@/app/(main)/baby/actions"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import type { FeedingType, DiaperType } from "@/lib/types/database"
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
}

export function BabyQuickActions({
  activeSleep,
  now,
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
              onClick={() => handleFeeding(opt.value)}
              disabled={isPending}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-amber-50 text-sm font-medium text-amber-800 transition-colors duration-200 hover:bg-amber-100 active:bg-amber-200 disabled:opacity-50"
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
                className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-sky-50 text-sm font-medium text-sky-800 transition-colors duration-200 hover:bg-sky-100 active:bg-sky-200 disabled:opacity-50"
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
                ? "bg-violet-100 text-violet-800 hover:bg-violet-200 active:bg-violet-300"
                : "bg-emerald-50 text-emerald-800 hover:bg-emerald-100 active:bg-emerald-200"
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
    </div>
  )
}
