"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Loader2, Square } from "lucide-react"
import { toast } from "sonner"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { useWakeLock } from "@/lib/hooks/use-wake-lock"
import { useNow } from "@/lib/hooks/use-now"
import { segmentCn } from "@/lib/utils/segment-cn"
import type { FeedingType } from "@/lib/types/database"

const STORAGE_KEY = "irori:feeding-timer"
const MAX_TIMER_AGE_MS = 2 * 60 * 60 * 1000 // 2時間で stale 扱い

interface TimerState {
  startedAt: string // ISO string
  feedingType: FeedingType
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

interface FeedingTimerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFeedingType: FeedingType
}

export function FeedingTimer({
  open,
  onOpenChange,
  initialFeedingType,
}: FeedingTimerProps) {
  const [feedingType, setFeedingType] = useState<FeedingType>(initialFeedingType)
  const [startedAt, setStartedAt] = useState<Date | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const isSavingRef = useRef(false)
  const now = useNow(1000, open && !!startedAt)
  const initializedRef = useRef(false)

  useWakeLock(open && !!startedAt)

  // Restore or initialize timer on open
  useEffect(() => {
    if (!open) {
      initializedRef.current = false
      return
    }
    if (initializedRef.current) return
    initializedRef.current = true

    // Try to restore from localStorage (stale タイマーは破棄)
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const state: TimerState = JSON.parse(saved)
        const savedTime = new Date(state.startedAt)
        if (Date.now() - savedTime.getTime() < MAX_TIMER_AGE_MS) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorageからのタイマー復元
          setStartedAt(savedTime)
          setFeedingType(state.feedingType)
          return
        }
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }

    // Start new timer
    const start = new Date()
    setStartedAt(start)
    setFeedingType(initialFeedingType)
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ startedAt: start.toISOString(), feedingType: initialFeedingType }),
    )
  }, [open, initialFeedingType])

  // Persist feeding type changes
  const handleTypeChange = useCallback(
    (type: FeedingType) => {
      setFeedingType(type)
      if (startedAt) {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ startedAt: startedAt.toISOString(), feedingType: type }),
        )
      }
    },
    [startedAt],
  )

  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((now.getTime() - startedAt.getTime()) / 1000))
    : 0
  const elapsedMinutes = Math.round(elapsedSeconds / 60)

  async function handleStop() {
    if (isSavingRef.current) return
    isSavingRef.current = true
    setIsSaving(true)

    const duration = Math.max(1, elapsedMinutes)
    const result = await recordFeeding({
      feedingType,
      durationMin: duration,
    })

    isSavingRef.current = false
    setIsSaving(false)

    if (result.error) {
      toast.error(result.error)
      return
    }

    localStorage.removeItem(STORAGE_KEY)
    setStartedAt(null)
    toast.success(`授乳を記録しました（${duration}分）`)
    onOpenChange(false)
  }

  function handleCancel() {
    localStorage.removeItem(STORAGE_KEY)
    setStartedAt(null)
    onOpenChange(false)
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen && startedAt && !isSavingRef.current) {
      // Sheet dismissed by swipe — treat as cancel
      localStorage.removeItem(STORAGE_KEY)
      setStartedAt(null)
    }
    onOpenChange(isOpen)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader className="pb-2">
          <SheetTitle>授乳タイマー</SheetTitle>
          <SheetDescription>
            停止すると授乳時間が記録されます
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col items-center gap-6 px-4 py-6">
          {/* 左右切替 */}
          <div className="flex w-full gap-1.5">
            <button
              type="button"
              onClick={() => handleTypeChange("breast_left")}
              className={segmentCn(feedingType === "breast_left")}
            >
              左
            </button>
            <button
              type="button"
              onClick={() => handleTypeChange("breast_right")}
              className={segmentCn(feedingType === "breast_right")}
            >
              右
            </button>
          </div>

          {/* 経過時間 */}
          <div className="font-mono text-5xl font-bold tabular-nums tracking-tight">
            {formatTimer(elapsedSeconds)}
          </div>

          {/* 停止ボタン */}
          <Button
            onClick={handleStop}
            disabled={isSaving}
            size="lg"
            className="min-h-14 w-full rounded-2xl text-lg font-semibold"
          >
            {isSaving ? (
              <>
                <Loader2 className="animate-spin" />
                記録中...
              </>
            ) : (
              <>
                <Square size={20} className="fill-current" />
                停止して記録
              </>
            )}
          </Button>

          <button
            type="button"
            onClick={handleCancel}
            className="text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            キャンセル（記録しない）
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
