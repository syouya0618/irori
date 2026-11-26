"use client"

import { useId, useState, type ReactNode } from "react"
import { CalendarDays, Check, ChevronDown, ChevronUp, Loader2, Plus, BrushCleaning } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CLEANING_DATE_MIN } from "@/lib/domain/cleaning"
import type { CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import { isValidYmd } from "@/lib/utils/date-jst"
import { CleaningRoutineIcon } from "./cleaning-routine-icon"

const QUICK_ITEM_LIMIT = 5

/** 実施日の選択と記録。項目の順序は保存順のまま保ち、押すたびに位置を変えない。 */
export function CleaningQuickRecord({
  today,
  selectedDate,
  routines,
  completedIds,
  pendingIds,
  disabled,
  busyRoutineId,
  onSelectDate,
  onRecord,
  onAddRoutine,
  children,
}: {
  today: string
  selectedDate: string
  routines: readonly CleaningRoutine[]
  completedIds: ReadonlySet<string>
  /** 最新の実施日を再確認するまで、同じ日の重複記録を受けない項目。 */
  pendingIds?: ReadonlySet<string>
  disabled: boolean
  busyRoutineId: string | null
  onSelectDate: (date: string) => void
  onRecord: (id: string) => void
  onAddRoutine: () => void
  children?: ReactNode
}) {
  const dateId = useId()
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? routines : routines.slice(0, QUICK_ITEM_LIMIT)
  const future = selectedDate > today

  return (
    <section aria-labelledby="cleaning-quick-heading" className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="cleaning-quick-heading" className="flex items-center gap-2 text-base font-semibold">
          <BrushCleaning size={20} className="text-primary" aria-hidden="true" />
          掃除を記録
        </h2>
        <div className="flex items-center gap-2">
          <label htmlFor={dateId} className="flex items-center gap-1 text-sm font-medium">
            <CalendarDays size={16} aria-hidden="true" />実施日
          </label>
          <Input id={dateId} type="date" value={selectedDate} min={CLEANING_DATE_MIN} max={today}
            className="h-11 w-auto min-w-0 text-base" aria-describedby={future ? `${dateId}-future` : undefined}
            onChange={(event) => {
              const date = event.target.value
              if (isValidYmd(date) && date >= CLEANING_DATE_MIN && date <= today) onSelectDate(date)
            }} />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="text-sm text-muted-foreground">終わった掃除をタップして記録。</p>
        {routines.length > QUICK_ITEM_LIMIT && (
          <Button type="button" variant="ghost" className="min-h-11" aria-expanded={showAll}
            aria-controls="cleaning-quick-items" onClick={() => setShowAll((value) => !value)}>
            {showAll ? "表示を減らす" : `全項目を見る（${routines.length}件）`}
            {showAll ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        )}
      </div>
      {future && <p id={`${dateId}-future`} role="note" className="text-sm text-muted-foreground">未来の日は実施を記録できません。今日までの日付を選んでください。</p>}
      <div id="cleaning-quick-items" className="grid grid-cols-3 gap-2">
        {visible.map((routine) => {
          const done = completedIds.has(routine.id)
          const busy = busyRoutineId === routine.id
          const pending = pendingIds?.has(routine.id) === true
          return (
            <button key={routine.id} type="button" aria-pressed={done}
              aria-label={`${routine.name}${pending ? "の記録を確認中" : done ? "はこの日記録済み" : "を選択日に記録"}`}
              disabled={disabled || future || done || pending} onClick={() => onRecord(routine.id)}
              className={`relative flex min-h-20 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default ${done ? "border-emerald-700/20 bg-emerald-50 text-emerald-800 dark:border-emerald-300/25 dark:bg-emerald-950/40 dark:text-emerald-200" : "border-primary/25 bg-primary/5 text-foreground hover:bg-primary/10 disabled:opacity-50"}`}>
              {busy ? <Loader2 size={24} className="animate-spin" aria-hidden="true" /> : <CleaningRoutineIcon name={routine.name} location={routine.location} size={24} />}
              {done && <Check size={16} className="absolute top-1.5 right-1.5" aria-hidden="true" />}
              <span className="w-full text-sm font-medium break-words [overflow-wrap:anywhere]">{routine.name}</span>
              {done && <span className="text-xs">記録済み</span>}
              {pending && <span className="text-xs">確認中</span>}
            </button>
          )
        })}
        <button type="button" aria-label="掃除項目を追加" onClick={onAddRoutine}
          className="flex min-h-20 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-muted-foreground/50 px-2 py-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
          <Plus size={24} aria-hidden="true" />項目を追加
        </button>
      </div>
      {children}
    </section>
  )
}
