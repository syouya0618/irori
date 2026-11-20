"use client"

import { useState } from "react"
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { CleaningLog } from "@/lib/domain/cleaning-schedule"
import { addMonthsClamped, daysInMonthOf, weekdayOfYmd } from "@/lib/domain/ymd-math"

export interface CleaningCalendarItem {
  id: string
  name: string
  /** 計算済みの「現在の1回」の予定日。複数回を推測して並べない。 */
  dueOn: string | null
  /** 最後に有効な履歴の実施日。記録が無いならnull。 */
  lastDoneOn: string | null
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const

/** 直近の有効な完了履歴と次回目安だけ表示。未来の実施や古い予定を実績に変えない。 */
export function calendarMarksForDate(
  ymd: string,
  items: readonly CleaningCalendarItem[],
  logs: readonly CleaningLog[],
): { completed: CleaningCalendarItem[]; scheduled: CleaningCalendarItem[] } {
  const byId = new Map(items.map((item) => [item.id, item]))
  const doneIds = new Set<string>()
  for (const log of logs) {
    if (log.voided_at === null && log.kind === "done" && log.done_on === ymd && byId.has(log.routine_id)) {
      doneIds.add(log.routine_id)
    }
  }
  // 履歴の一部が未取得でも、サーバーが集計した直近完了日は正本として数える。
  for (const item of items) if (item.lastDoneOn === ymd) doneIds.add(item.id)
  return {
    completed: items.filter((item) => doneIds.has(item.id)),
    scheduled: items.filter((item) => item.dueOn === ymd),
  }
}

export function CleaningCalendar({
  today,
  items,
  logs,
  historyFailed,
  historyTruncated,
  onOpenRoutine,
  onAddRoutine,
}: {
  today: string
  items: readonly CleaningCalendarItem[]
  logs: readonly CleaningLog[]
  historyFailed: boolean
  historyTruncated: boolean
  onOpenRoutine: (id: string) => void
  onAddRoutine: () => void
}) {
  const [month, setMonth] = useState(`${today.slice(0, 7)}-01`)
  const [selected, setSelected] = useState(today)
  const monthBefore = addMonthsClamped(month, -1)
  const monthAfter = addMonthsClamped(month, 1)
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const length = daysInMonthOf(year, monthNumber) ?? 0
  const offset = weekdayOfYmd(month) ?? 0
  const dates = Array.from({ length }, (_, index) => `${month.slice(0, 7)}-${String(index + 1).padStart(2, "0")}`)
  const chosen = selected.startsWith(month.slice(0, 7)) ? selected : null
  const chosenMarks = chosen !== null ? calendarMarksForDate(chosen, items, logs) : null

  function move(to: string | null) {
    if (to === null) return
    setMonth(to)
    setSelected(to.startsWith(today.slice(0, 7)) ? today : to)
  }

  return (
    <section aria-labelledby="cleaning-calendar-heading" className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" data-testid="cleaning-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-primary" aria-hidden="true" />
          <h2 id="cleaning-calendar-heading" className="text-base font-semibold">家事ルーティン記録</h2>
        </div>
        <Button type="button" className="min-h-11" onClick={onAddRoutine}>
          <Plus aria-hidden="true" />
          項目を追加
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        名前・場所・周期は家庭に合わせて自由に設定できます。終わったら下の項目から1タップで完了を記録します。
      </p>
      <div className="flex items-center justify-between gap-2">
        <Button aria-label="前の月を見る" type="button" variant="outline" size="icon" disabled={monthBefore === null} onClick={() => move(monthBefore)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p className="text-base font-semibold" aria-live="polite">{year}年{monthNumber}月</p>
        <Button aria-label="次の月を見る" type="button" variant="outline" size="icon" disabled={monthAfter === null} onClick={() => move(monthAfter)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs" role="grid" aria-label={`${year}年${monthNumber}月の家事カレンダー`}>
        {WEEKDAYS.map((name) => (
          <div key={name} role="columnheader" className={`py-1 font-medium ${name === "日" ? "text-destructive" : name === "土" ? "text-primary" : "text-muted-foreground"}`}>
            {name}
          </div>
        ))}
        {Array.from({ length: offset }, (_, index) => <div key={`padding-${index}`} role="gridcell" aria-hidden="true" />)}
        {dates.map((date) => {
          const marks = calendarMarksForDate(date, items, logs)
          const done = marks.completed.length
          const due = marks.scheduled.length
          const active = date === chosen
          const isToday = date === today
          return (
            <div key={date} role="gridcell">
              <button
                type="button"
                aria-label={`${monthNumber}月${Number(date.slice(8))}日: 完了${done}件・次回目安${due}件`}
                aria-pressed={active}
                onClick={() => setSelected(date)}
                className={`flex min-h-11 w-full flex-col items-center justify-center gap-1 rounded-xl border px-0.5 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring ${active ? "border-primary bg-primary/10 font-semibold" : isToday ? "border-primary" : "border-transparent hover:bg-muted"}`}
              >
                <span>{Number(date.slice(8))}</span>
                <span aria-hidden="true" className="flex min-h-2 items-center gap-0.5">
                  {done > 0 && <span className="size-2 rounded-full bg-emerald-700 dark:bg-emerald-300" />}
                  {due > 0 && <span className="size-2 rounded-full border-2 border-primary" />}
                </span>
              </button>
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-emerald-700" aria-hidden="true" />完了日</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-full border-2 border-primary" aria-hidden="true" />次回の目安日</span>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3" aria-live="polite">
        <h3 className="text-sm font-semibold">{chosen === null ? "日を選んでください" : `${monthNumber}月${Number(chosen.slice(8))}日の記録・予定`}</h3>
        {chosenMarks && chosenMarks.completed.length === 0 && chosenMarks.scheduled.length === 0 && (
          <p className="text-sm text-muted-foreground">この日に表示できる実施・予定はありません。</p>
        )}
        {chosenMarks && (chosenMarks.completed.length > 0 || chosenMarks.scheduled.length > 0) && (
          <ul className="flex flex-col gap-1">
            {[...new Set([...chosenMarks.completed, ...chosenMarks.scheduled].map((item) => item.id))].map((id) => {
              const item = items.find((entry) => entry.id === id)
              if (!item) return null
              const done = chosenMarks.completed.some((entry) => entry.id === id)
              const due = chosenMarks.scheduled.some((entry) => entry.id === id)
              return (
                <li key={id}>
                  <button type="button" onClick={() => onOpenRoutine(id)}
                    className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-2 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="min-w-0 break-words">{item.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{[done ? "完了" : "", due ? "次回目安" : ""].filter(Boolean).join(" / ")}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {(historyFailed || historyTruncated) && (
          <p role="note" className="text-xs text-muted-foreground">
            履歴の一部を読み込めていません。過去の完了日がすべて表示されるとは限りません。項目の詳細で確認してください。
          </p>
        )}
        <p className="text-xs text-muted-foreground">予定日は現在の各項目の「次回1回分」だけを表示します。過去の予定を完了記録にはしません。</p>
      </div>
    </section>
  )
}
