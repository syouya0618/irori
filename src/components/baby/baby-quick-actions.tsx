"use client"

import { useTransition } from "react"
import { Loader2, Moon, Sun, Thermometer, Ruler, StickyNote } from "lucide-react"
import { toast } from "sonner"
import {
  recordFeeding,
  recordDiaper,
  startSleep,
  endSleep,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { formatElapsedMinutes, minutesBetween } from "@/lib/utils/baby-log-labels"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
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
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  onCreateLog: (type: BabyLogType) => void
  onStartTimer: (type: FeedingType) => void
  /**
   * endSleep 成功時に呼ばれる（B-01: 日跨ぎフォールバックの明示クリア +
   * B-03: logs 側の該当睡眠へ ended_at を楽観反映）。id と適用した ended_at を渡す。
   */
  onSleepEnded?: (id: string, endedAt: string) => void
  /**
   * 記録成功時に楽観 append する行を親へ渡す（B-03）。Realtime 単一経路を脱し、
   * #92 不達下でも timeline/回数を即時更新する。既存 echo は id 重複で吸収。
   *
   * 前提: quick actions は isToday ゲート下でのみ描画されるため、ここで作る行の
   * logged_at（client now）は常に選択日（当日）= timeline 窓と一致する（安全前提）。
   */
  onLogRecorded?: (log: BabyLogData) => void
  /** Undo 成功時にローカル state から除去する行の id を親へ渡す（B-03） */
  onLogRemoved?: (id: string) => void
}

export function BabyQuickActions({
  activeSleep,
  now,
  userId,
  onCreateLog,
  onStartTimer,
  onSleepEnded,
  onLogRecorded,
  onLogRemoved,
}: BabyQuickActionsProps) {
  const [isPending, startTransition] = useTransition()

  // 片手操作での押し間違いをその場で取り消せるようにする（記録直後のトーストから）
  function undoLog(logId: string, label: string) {
    startTransition(async () => {
      const result = await deleteLog(logId)
      if (result.error) {
        toast.error(result.error)
        return
      }
      // B-03: Realtime DELETE echo を待たずローカル state からも除去
      onLogRemoved?.(logId)
      toast.success(`${label}の記録を取り消しました`)
    })
  }

  function successWithUndo(message: string, label: string, logId: string | null) {
    if (logId) {
      toast.success(message, {
        action: { label: "取り消す", onClick: () => undoLog(logId, label) },
      })
    } else {
      toast.success(message)
    }
  }

  function handleFeeding(feedingType: FeedingType) {
    startTransition(async () => {
      const result = await recordFeeding({ feedingType })
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
          }),
        )
      }
      successWithUndo("授乳を記録しました", "授乳", result.id)
    })
  }

  function handleDiaper(diaperType: DiaperType) {
    startTransition(async () => {
      const result = await recordDiaper({ diaperType })
      if (result.error) {
        toast.error(result.error)
        return
      }
      // B-03: 返却 id で楽観 append（feeding/diaper は UNIQUE 防御が無いため、
      // #92 下の再タップ二重記録を止血する本命経路）
      if (result.id) {
        onLogRecorded?.(
          buildOptimisticLog({
            id: result.id,
            logType: "diaper",
            loggedBy: userId,
            diaperType,
          }),
        )
      }
      successWithUndo("おむつ交換を記録しました", "おむつ", result.id)
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
        // B-01/B-03: フォールバックの明示クリア + logs 側の睡眠へ ended_at を楽観反映
        // （Server Action 応答ベース = Realtime 不達 #92 でもトグルが「睡眠中」に張り付かない）
        const endedAt = new Date().toISOString()
        onSleepEnded?.(activeSleep.id, endedAt)
        const mins = minutesBetween(activeSleep.logged_at, endedAt)
        toast.success(`おはよう！（${formatElapsedMinutes(mins)}）`)
      } else {
        const result = await startSleep()
        if (result.error) {
          toast.error(result.error)
          return
        }
        // B-03: 睡眠開始も楽観 append。serverActiveSleep（B-01・日跨ぎ用の別 state）とは
        // 別で、同日開始の睡眠は logs に入る。deriveDashboardSummary が logs 優先ゆえ
        // トグルが即「起こす」へ。id dedupe により echo/serverActiveSleep と二重にならない。
        if (result.id) {
          onLogRecorded?.(
            buildOptimisticLog({
              id: result.id,
              logType: "sleep",
              loggedBy: userId,
              // ended_at は未設定 = アクティブ睡眠
            }),
          )
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
