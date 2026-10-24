"use client"

import { ChevronRight, Timer, TriangleAlert } from "lucide-react"
import { useNow } from "@/lib/hooks/use-now"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { RunningTimer } from "./feeding-timer"

interface RunningTimerChipProps {
  running: RunningTimer
  /** タップでタイマーのシートを開き直す（計測はそのまま続いている） */
  onOpen: () => void
}

/** 経過秒 → "MM:SS"（1 時間以上は "H:MM:SS"） */
function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const mmss = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
  return h > 0 ? `${h}:${mmss}` : mmss
}

/**
 * ダッシュボードに出す「授乳を計測中」のチップ（UX-04a）。
 *
 * タイマーのシートを閉じても計測は端末に残るため、予定を見た後・別の記録を付けた後に
 * ここから戻れる。停め忘れ（stale）は経過を刻まず、記録か破棄を選ぶよう促す。
 * 時計は 1 秒刻み（シートの表示と同じ）。走っていない停め忘れでは刻まぬ。
 */
export function RunningTimerChip({ running, onOpen }: RunningTimerChipProps) {
  const now = useNow(1000, !running.stale)
  const elapsedSec = Math.max(
    0,
    Math.floor((now.getTime() - new Date(running.startedAt).getTime()) / 1000),
  )
  const sideLabel = running.side === "breast_left" ? "左" : "右"
  const startLabel = formatTimeJst(running.startedAt)
  const buttonCn =
    "glass flex min-h-11 w-full items-center gap-2.5 rounded-2xl px-3 py-2 text-left shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/50 active:bg-muted/70"

  if (running.stale) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`授乳の計測が残っています（${startLabel} 開始）。開いて記録するか破棄する`}
        className={buttonCn}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
          <TriangleAlert size={16} className="text-amber-700 dark:text-amber-300" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">授乳の計測が残っています</span>
          <span className="text-xs text-muted-foreground">
            {startLabel} 開始・記録するか破棄してください
          </span>
        </span>
        <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`授乳を計測中 ${formatClock(elapsedSec)}（${sideLabel}）。開く`}
      className={buttonCn}
    >
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/40">
        <Timer size={16} className="text-amber-700 dark:text-amber-300" />
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-sm font-medium">授乳を計測中</span>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {formatClock(elapsedSec)}
        </span>
        <span className="text-xs text-muted-foreground">{sideLabel}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted-foreground" />
    </button>
  )
}
