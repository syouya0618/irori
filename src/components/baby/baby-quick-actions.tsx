"use client"

import { useTransition } from "react"
import { Thermometer, Ruler, StickyNote } from "lucide-react"
import { toast } from "sonner"
import {
  recordFeeding,
  recordDiaper,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { buildOptimisticLog } from "@/lib/domain/baby-optimistic-log"
// 通信断で Server Action が reject すると、startTransition 内の unhandled reject が
// 最寄りの error boundary へ bubble し全画面エラー化 + 記録が無言で失われる。
// 各ハンドラの reject を握ってトーストへ倒す（機序の詳細は offline-error.ts）。
import { toastOfflineError } from "@/lib/utils/offline-error"
import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"
import type { BabyLogData } from "@/lib/types/baby"

const FEEDING_OPTIONS: { value: FeedingType; label: string }[] = [
  { value: "breast_left", label: "左" },
  { value: "breast_right", label: "右" },
  { value: "bottle", label: "ミルク" },
  { value: "pumped", label: "搾乳" },
  { value: "solid", label: "離乳食" },
]

const DIAPER_OPTIONS: { value: DiaperType; label: string }[] = [
  { value: "pee", label: "おしっこ" },
  { value: "poop", label: "うんち" },
  { value: "both", label: "両方" },
]

interface BabyQuickActionsProps {
  /** 記録者（logged_by）。楽観 append 行の作成に使う（B-03） */
  userId: string
  onCreateLog: (type: BabyLogType) => void
  /** 搾乳など量ベースの授乳を create シートで開く（母乳のタイマー導線とは別） */
  onCreateFeeding: (type: FeedingType) => void
  onStartTimer: (type: FeedingType) => void
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
  userId,
  onCreateLog,
  onCreateFeeding,
  onStartTimer,
  onLogRecorded,
  onLogRemoved,
}: BabyQuickActionsProps) {
  const [isPending, startTransition] = useTransition()

  // 片手操作での押し間違いをその場で取り消せるようにする（記録直後のトーストから）
  function undoLog(logId: string, label: string) {
    startTransition(async () => {
      try {
        const result = await deleteLog(logId)
        if (result.error) {
          toast.error(result.error)
          return
        }
        // B-03: Realtime DELETE echo を待たずローカル state からも除去
        onLogRemoved?.(logId)
        toast.success(`${label}の記録を取り消しました`)
      } catch (err) {
        toastOfflineError("[baby-quick-actions] deleteLog(undo)", err)
      }
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

  // 授乳ボタンの振り分け: 母乳（左/右）はタイマー、搾乳は量入力のため create シート、
  // ミルク/離乳食は即時記録（従来どおり）。
  function handleFeedingOption(value: FeedingType) {
    if (value === "breast_left" || value === "breast_right") {
      onStartTimer(value)
    } else if (value === "pumped") {
      onCreateFeeding(value)
    } else {
      handleFeeding(value)
    }
  }

  function handleFeeding(feedingType: FeedingType) {
    startTransition(async () => {
      try {
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
      } catch (err) {
        toastOfflineError("[baby-quick-actions] recordFeeding", err)
      }
    })
  }

  function handleDiaper(diaperType: DiaperType) {
    startTransition(async () => {
      try {
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
      } catch (err) {
        toastOfflineError("[baby-quick-actions] recordDiaper", err)
      }
    })
  }

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
              onClick={() => handleFeedingOption(opt.value)}
              disabled={isPending}
              className="flex min-h-11 flex-1 items-center justify-center rounded-xl bg-amber-50 text-sm font-medium text-amber-800 transition-colors duration-200 hover:bg-amber-100 active:bg-amber-200 disabled:opacity-50 dark:bg-amber-900/30 dark:text-amber-200 dark:hover:bg-amber-900/50 dark:active:bg-amber-900/70"
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Diaper */}
      <div className="space-y-1.5">
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
