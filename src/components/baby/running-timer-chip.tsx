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
  // 計測中は画面の最上部で他のカードと見間違えぬよう、ガラスではなく色の付いた面にする
  // （夜間に「計測が走っておるか」を一瞥で判る。DESIGN_SYSTEM の暖色の範囲）
  const buttonCn =
    "flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 px-3 py-2.5 text-left shadow-lg shadow-black/[0.04] transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"

  if (running.stale) {
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={`授乳の計測が残っています（${startLabel} 開始）。開いて記録するか破棄する`}
        className={`${buttonCn} border-amber-500/60 bg-amber-50 hover:bg-amber-100 active:bg-amber-200 dark:border-amber-500/50 dark:bg-amber-950/60 dark:hover:bg-amber-900/60 dark:active:bg-amber-900/80`}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-amber-700 text-white">
          <TriangleAlert size={20} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-base font-semibold">授乳の計測が残っています</span>
          <span className="text-sm text-foreground/90">
            {startLabel} 開始・タップして記録するか破棄
          </span>
        </span>
        <ChevronRight size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`授乳を計測中 ${formatClock(elapsedSec)}（${sideLabel}）。開く`}
      className={`${buttonCn} border-primary/50 bg-primary/10 hover:bg-primary/15 active:bg-primary/20 dark:bg-primary/15 dark:hover:bg-primary/20 dark:active:bg-primary/25`}
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Timer size={20} aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-foreground/90">
          授乳を計測中・{sideLabel}を吸わせ中
        </span>
        <span className="font-mono text-2xl font-bold leading-tight tabular-nums">
          {formatClock(elapsedSec)}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-0.5 text-sm font-medium text-foreground">
        開く
        <ChevronRight size={20} aria-hidden="true" />
      </span>
    </button>
  )
}
