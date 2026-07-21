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
import { Loader2, Square, Check } from "lucide-react"
import { toast } from "sonner"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { clampFeedingDurationSec } from "@/lib/domain"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
import { useWakeLock } from "@/lib/hooks/use-wake-lock"
import { useNow } from "@/lib/hooks/use-now"
import { segmentCn } from "@/lib/utils/segment-cn"
import { formatDurationSec } from "@/lib/utils/baby-log-labels"
import type { FeedingType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const STORAGE_KEY = "irori:feeding-timer"
const MAX_TIMER_AGE_MS = 2 * 60 * 60 * 1000 // 2時間で stale 扱い

// 手動入力の上限。授乳（片側）は 15 分あれば足りるため 15 分までを選べる。
// 秒精度（duration_sec）で保存する（duration_min は round で併記される）。
const MANUAL_MAX_MINUTES = 15
const MANUAL_MINUTE_OPTIONS = Array.from(
  { length: MANUAL_MAX_MINUTES + 1 },
  (_, i) => i,
) // 0..15
const MANUAL_SECOND_OPTIONS = Array.from({ length: 60 }, (_, i) => i) // 0..59
const DEFAULT_MANUAL_MINUTES = 5

type TimerMode = "timer" | "manual"

interface TimerState {
  startedAt: string // ISO string
  feedingType: FeedingType
}

function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

/**
 * 手動入力の分・秒を保存用の秒数へ変換する。
 * 15 分（900 秒）を上限にクランプする（秒精度をそのまま保持）。
 */
function manualDurationSec(minutes: number, seconds: number): number {
  const totalSeconds = Math.min(
    minutes * 60 + seconds,
    MANUAL_MAX_MINUTES * 60,
  )
  return clampFeedingDurationSec(totalSeconds)
}

interface FeedingTimerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialFeedingType: FeedingType
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。タイマーは quick actions
   * （isToday ゲート下）からのみ開くため、logged_at（client now）は選択日と一致する。
   */
  onLogRecorded?: (log: BabyLogData) => void
}

export function FeedingTimer({
  open,
  onOpenChange,
  initialFeedingType,
  userId,
  onLogRecorded,
}: FeedingTimerProps) {
  const [feedingType, setFeedingType] = useState<FeedingType>(initialFeedingType)
  const [startedAt, setStartedAt] = useState<Date | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const isSavingRef = useRef(false)
  // 授乳時間の入力方式。タイマー（既定）と手動入力（分・秒）を切り替える。
  const [mode, setMode] = useState<TimerMode>("timer")
  const [manualMin, setManualMin] = useState(DEFAULT_MANUAL_MINUTES)
  const [manualSec, setManualSec] = useState(0)
  // タイマーが実際に走るのは timer モードの時だけ（手動入力中は tick / wake lock 不要）
  const timerRunning = open && mode === "timer" && !!startedAt
  const now = useNow(1000, timerRunning)
  const initializedRef = useRef(false)

  useWakeLock(timerRunning)

  // Restore or initialize timer on open
  useEffect(() => {
    if (!open) {
      initializedRef.current = false
      return
    }
    if (initializedRef.current) return
    initializedRef.current = true

    // 開くたびにタイマー方式・手動入力の既定へ戻す（前回 manual のまま開かない）
    setMode("timer")
    setManualMin(DEFAULT_MANUAL_MINUTES)
    setManualSec(0)

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

  // タイマー停止・手動記録の共通保存経路。durationSec（秒精度）で記録し、duration_min は
  // サーバ側で round 併記される。通信断 reject を握って永久 disabled を防ぐ
  // （recordFeeding は redirect しないため finally で isSaving を必ず戻せる）。
  async function saveFeeding(durationSec: number) {
    if (isSavingRef.current) return
    isSavingRef.current = true
    setIsSaving(true)

    let result: Awaited<ReturnType<typeof recordFeeding>>
    try {
      result = await recordFeeding({
        feedingType,
        durationSec,
      })
    } catch (err) {
      // recordFeeding は通信断で reject しうる。握り潰さず記録し、再試行を促す。
      console.error("[feeding-timer] recordFeeding が例外を投げました", {
        message: err instanceof Error ? err.message : String(err),
        feedingType,
        durationSec,
      })
      toast.error("授乳の記録に失敗しました。通信状況を確認してもう一度お試しください。")
      return
    } finally {
      // throw / 正常のいずれの経路でも必ず解除する（永久 disabled の防止）。
      // recordFeeding は redirect しないため finally で戻して問題ない。
      isSavingRef.current = false
      setIsSaving(false)
    }

    if (result.error) {
      toast.error(result.error)
      return
    }

    // B-03: 返却 id で楽観 append（Realtime を待たず timeline/回数を即時更新）
    if (result.id) {
      onLogRecorded?.(
        buildOptimisticLog({
          id: result.id,
          logType: "feeding",
          loggedBy: userId,
          feedingType,
          durationSec,
        }),
      )
    }

    localStorage.removeItem(STORAGE_KEY)
    setStartedAt(null)
    toast.success(`授乳を記録しました（${formatDurationSec(durationSec)}）`)
    onOpenChange(false)
  }

  function handleStop() {
    void saveFeeding(clampFeedingDurationSec(elapsedSeconds))
  }

  function handleManualRecord() {
    const totalSeconds = manualMin * 60 + manualSec
    if (totalSeconds <= 0) {
      toast.error("授乳時間を選んでください")
      return
    }
    void saveFeeding(manualDurationSec(manualMin, manualSec))
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
          <SheetTitle>授乳を記録</SheetTitle>
          <SheetDescription>
            {mode === "timer"
              ? "停止すると授乳時間が記録されます"
              : "授乳にかかった時間を選んで記録します"}
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

          {/* 入力方式の切替（タイマー / 手動） */}
          <div className="flex w-full gap-1.5">
            <button
              type="button"
              onClick={() => setMode("timer")}
              className={segmentCn(mode === "timer")}
            >
              タイマー
            </button>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className={segmentCn(mode === "manual")}
            >
              手動入力
            </button>
          </div>

          {mode === "timer" ? (
            <>
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
            </>
          ) : (
            <>
              {/* 分・秒ピッカー（15分まで） */}
              <div className="flex items-end justify-center gap-3">
                <div className="flex flex-col items-center gap-1">
                  <label
                    htmlFor="manual-min"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    分
                  </label>
                  <select
                    id="manual-min"
                    value={manualMin}
                    onChange={(e) => setManualMin(Number(e.target.value))}
                    disabled={isSaving}
                    className="min-h-11 rounded-lg border bg-background px-4 text-2xl font-bold tabular-nums transition-colors duration-200 disabled:opacity-50"
                  >
                    {MANUAL_MINUTE_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <span className="pb-2 text-2xl font-bold text-muted-foreground">
                  :
                </span>
                <div className="flex flex-col items-center gap-1">
                  <label
                    htmlFor="manual-sec"
                    className="text-xs font-medium text-muted-foreground"
                  >
                    秒
                  </label>
                  <select
                    id="manual-sec"
                    value={manualSec}
                    onChange={(e) => setManualSec(Number(e.target.value))}
                    disabled={isSaving}
                    className="min-h-11 rounded-lg border bg-background px-4 text-2xl font-bold tabular-nums transition-colors duration-200 disabled:opacity-50"
                  >
                    {MANUAL_SECOND_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {String(s).padStart(2, "0")}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 記録ボタン */}
              <Button
                onClick={handleManualRecord}
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
                    <Check size={20} />
                    記録する
                  </>
                )}
              </Button>
            </>
          )}

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
