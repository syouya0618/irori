"use client"

import { useState } from "react"
import { CalendarDays, Check, ChevronLeft, ChevronRight, Plus } from "lucide-react"

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
/** 月の小さなマスだけで使う表示名。自由入力・保存値・読み上げ・詳細の名前は変えない。 */
const SHORT_NAMES = new Map([
  ["トイレ掃除", "トイレ"],
  ["お風呂掃除", "お風呂"],
  ["キッチン掃除", "キッチン"],
  ["洗濯槽掃除", "洗濯槽"],
  ["洗濯槽の掃除", "洗濯槽"],
  ["換気扇掃除", "換気扇"],
  ["玄関掃除", "玄関"],
])

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
  selectedDate,
  onSelectDate,
  onOpenRoutine,
  onAddRoutine,
}: {
  today: string
  items: readonly CleaningCalendarItem[]
  logs: readonly CleaningLog[]
  historyFailed: boolean
  historyTruncated: boolean
  /** クイック記録と共有する選択日。省略時はカレンダー内で管理する。 */
  selectedDate?: string
  onSelectDate?: (date: string) => void
  onOpenRoutine: (id: string) => void
  onAddRoutine?: () => void
}) {
  const [internalSelected, setInternalSelected] = useState(today)
  const selected = selectedDate ?? internalSelected
  // 月も同じ選択日から導く。親で日付を変えた時に、表示月と記録先が食い違わない。
  const month = `${selected.slice(0, 7)}-01`
  const monthBefore = addMonthsClamped(month, -1)
  const monthAfter = addMonthsClamped(month, 1)
  const year = Number(month.slice(0, 4))
  const monthNumber = Number(month.slice(5, 7))
  const length = daysInMonthOf(year, monthNumber) ?? 0
  const offset = weekdayOfYmd(month) ?? 0
  const dates = Array.from({ length }, (_, index) => `${month.slice(0, 7)}-${String(index + 1).padStart(2, "0")}`)
  const chosenMarks = calendarMarksForDate(selected, items, logs)
  const paddingAfter = (7 - ((offset + length) % 7)) % 7

  function select(date: string) {
    if (selectedDate === undefined) setInternalSelected(date)
    onSelectDate?.(date)
  }

  function move(to: string | null) {
    if (to === null) return
    select(to.startsWith(today.slice(0, 7)) ? today : to)
  }

  return (
    <section aria-labelledby="cleaning-calendar-heading" className="glass flex min-w-0 flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" data-testid="cleaning-calendar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} className="text-primary" aria-hidden="true" />
          <h2 id="cleaning-calendar-heading" className="text-base font-semibold">掃除カレンダー</h2>
        </div>
        <Button type="button" variant="ghost" className="text-primary" aria-label="今日に戻る" onClick={() => select(today)}>
          今日
        </Button>
      </div>
      <div className="flex items-center justify-between gap-2">
        <Button aria-label="前の月を見る" type="button" variant="outline" size="icon" disabled={monthBefore === null} onClick={() => move(monthBefore)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <p className="text-base font-semibold" aria-live="polite">{year}年{monthNumber}月</p>
        <Button aria-label="次の月を見る" type="button" variant="outline" size="icon" disabled={monthAfter === null} onClick={() => move(monthAfter)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <div className="-mx-4 min-w-0 overflow-x-auto px-2">
        <div className="grid min-w-[322px] grid-cols-7 gap-0 text-center text-sm" role="group" aria-label={`${year}年${monthNumber}月の家事カレンダー`}>
          {WEEKDAYS.map((name) => (
            <div key={name} className={`py-1 font-medium ${name === "日" ? "text-destructive" : name === "土" ? "text-primary" : "text-muted-foreground"}`}>
              {name}
            </div>
          ))}
          {Array.from({ length: offset }, (_, index) => <div key={`padding-${index}`} className="border border-border/60 bg-muted/30" aria-hidden="true" />)}
          {dates.map((date) => {
            const marks = calendarMarksForDate(date, items, logs)
            const done = marks.completed.length
            const due = marks.scheduled.length
            const active = date === selected
            const isToday = date === today
            const labels = [
              ...marks.completed.map((item) => ({ item, kind: "done" as const })),
              ...marks.scheduled.map((item) => ({ item, kind: "scheduled" as const })),
            ]
            // 3件以上は1件＋残り件数にし、文字を小さくせず2行に収める。
            const visibleLabels = labels.length > 2 ? labels.slice(0, 1) : labels
            const descriptions = [
              done > 0 ? `実施済み: ${marks.completed.map((item) => item.name).join("、")}` : "",
              due > 0 ? `次回目安: ${marks.scheduled.map((item) => item.name).join("、")}` : "",
            ].filter(Boolean)
            return (
              <div key={date} className="min-w-0 border border-border/60">
                <button
                  type="button"
                  aria-label={`${monthNumber}月${Number(date.slice(8))}日: 完了${done}件・次回目安${due}件${descriptions.length > 0 ? `。${descriptions.join("。")}` : ""}`}
                  aria-pressed={active}
                  aria-current={isToday ? "date" : undefined}
                  onClick={() => select(date)}
                  className={`flex min-h-18 min-w-11 w-full flex-col items-center gap-0.5 rounded-lg py-1 text-sm ring-2 ring-inset transition-colors duration-200 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${active ? "bg-primary/5 font-semibold ring-primary" : isToday ? "ring-primary/60" : "ring-transparent hover:bg-muted"}`}
                >
                  <span>{Number(date.slice(8))}</span>
                  <span aria-hidden="true" className="flex w-full min-w-0 flex-col gap-0.5">
                    {visibleLabels.map(({ item, kind }) => (
                      <span
                        key={`${kind}:${item.id}`}
                        title={item.name}
                        data-cleaning-mark={kind}
                        // 44pxの幅を文字に使う。1件だけなら2行、複数件なら各1行にして行高は変えない。
                        className={`w-full rounded text-sm leading-[1.125rem] ${labels.length === 1 ? "line-clamp-2 break-words [overflow-wrap:anywhere]" : "block truncate"} ${kind === "done" ? "bg-emerald-100 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200" : "bg-background font-medium text-primary ring-1 ring-primary ring-inset"}`}
                      >
                        {SHORT_NAMES.get(item.name) ?? item.name}
                      </span>
                    ))}
                    {labels.length > 2 && <span className="text-sm leading-[1.125rem] text-muted-foreground">+{labels.length - 1}件</span>}
                  </span>
                </button>
              </div>
            )
          })}
          {Array.from({ length: paddingAfter }, (_, index) => <div key={`trailing-${index}`} className="border border-border/60 bg-muted/30" aria-hidden="true" />)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-1"><Check size={14} className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />実施済み</span>
        <span className="flex items-center gap-1"><span className="size-3 rounded-sm border-2 border-primary" aria-hidden="true" />次回の目安</span>
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3" aria-live="polite">
        <h3 className="text-sm font-semibold">{monthNumber}月{Number(selected.slice(8))}日の記録・予定</h3>
        {chosenMarks.completed.length === 0 && chosenMarks.scheduled.length === 0 && (
          <p className="text-sm text-muted-foreground">この日に表示できる実施・予定はありません。</p>
        )}
        {(chosenMarks.completed.length > 0 || chosenMarks.scheduled.length > 0) && (
          <ul className="flex flex-wrap gap-2">
            {[...new Set([...chosenMarks.completed, ...chosenMarks.scheduled].map((item) => item.id))].map((id) => {
              const item = items.find((entry) => entry.id === id)
              if (!item) return null
              const done = chosenMarks.completed.some((entry) => entry.id === id)
              const due = chosenMarks.scheduled.some((entry) => entry.id === id)
              return (
                <li key={id} className="max-w-full">
                  <button type="button" onClick={() => onOpenRoutine(id)}
                    className={`flex min-h-11 min-w-11 max-w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring ${done ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900" : "border border-primary text-primary hover:bg-muted"}`}>
                    {done && <Check size={16} className="shrink-0" aria-hidden="true" />}
                    <span className="min-w-0 break-words [overflow-wrap:anywhere]">{item.name}</span>
                    <span className="sr-only">{[done ? "完了" : "", due ? "次回目安" : ""].filter(Boolean).join(" / ")}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {(historyFailed || historyTruncated) && (
          <p role="note" className="text-sm text-muted-foreground">
            履歴の一部を読み込めていません。過去の完了日がすべて表示されるとは限りません。項目の詳細で確認してください。
          </p>
        )}
        <p className="text-sm text-muted-foreground">次回の目安は、各項目の次の1回分です。</p>
        {onAddRoutine && (
          <Button type="button" variant="outline" className="self-start" onClick={onAddRoutine}>
            <Plus aria-hidden="true" />
            家事項目を設定
          </Button>
        )}
      </div>
    </section>
  )
}
