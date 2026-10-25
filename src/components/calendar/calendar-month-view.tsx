"use client"

import { useEffect, useRef, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"
import { shiftYmd } from "@/lib/utils/date-jst"
import type { CalendarGridCell } from "@/lib/domain/calendar-grid"
import type { CalendarEventRecord } from "./use-month-events"
import { formatDayJa } from "./calendar-display"

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]

interface CalendarMonthViewProps {
  grid: CalendarGridCell[][]
  eventsByDate: Map<string, CalendarEventRecord[]>
  selectedDate: string
  onSelectDate: (date: string) => void
  /**
   * 矢印キーで表示範囲の外（前月・翌月）へ出る時に呼ぶ。省略時は範囲内だけ動く。
   * 月を描き直す責務は親（useMonthEvents.goToDate）が持つ。
   */
  onNavigateDate?: (date: string) => void
  /** 月の取り直し中。グリッドを aria-busy にする（空欄を「予定なし」と読ませぬ）。 */
  busy?: boolean
  /** 件数が当てにならぬ（読み込み中・失敗）。読み上げで「予定なし」と言わぬ。 */
  countsUnknown?: boolean
}

/**
 * 1 日あたり最大 3 個の印。**色と形の両方**で意味を運ぶ:
 * - 形: 終日・複数日 = 横長の帯 / 時刻付き = 丸
 * - 色: irori の予定 = warm orange / Google 由来 = 灰
 *
 * 以前は時刻付きの印に `border-primary` を後から重ねており、Google の時刻付き予定まで
 * オレンジの輪になって irori の予定と見分けられなかった。色の指定は source だけで決める。
 */
function EventMarks({ events }: { events: CalendarEventRecord[] }) {
  const shown = events.slice(0, 3)
  const overflow = events.length - shown.length
  return (
    <span className="mt-0.5 flex h-2 items-center justify-center gap-0.5" aria-hidden="true">
      {shown.map((e) => {
        const isGoogle = e.source === "google"
        const isBand = e.is_all_day || e.start_date !== e.end_date
        return (
          <span
            key={e.id}
            data-mark={isBand ? "band" : "dot"}
            data-source={e.source}
            className={cn(
              "rounded-full",
              isBand ? "h-1 w-2.5" : "size-1.5",
              isGoogle ? "bg-muted-foreground/60" : "bg-primary",
            )}
          />
        )
      })}
      {overflow > 0 && (
        <span className="text-[10px] leading-none text-muted-foreground">
          +{overflow}
        </span>
      )}
    </span>
  )
}

/**
 * セルの読み上げ名: 「10月24日（土）、今日、予定 3 件」。ISO の生値は読ませぬ。
 * 月を読めておらぬ間（読み込み中・失敗）は件数を言わぬ —— 「予定なし」と偽らぬ。
 */
function cellLabel(cell: CalendarGridCell, count: number, countsUnknown: boolean): string {
  const parts = [formatDayJa(cell.date)]
  if (cell.isToday) parts.push("今日")
  parts.push(countsUnknown ? "予定を確認できません" : count > 0 ? `予定${count}件` : "予定なし")
  return parts.join("、")
}

const KEY_DELTAS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

export function CalendarMonthView({
  grid,
  eventsByDate,
  selectedDate,
  onSelectDate,
  onNavigateDate,
  busy = false,
  countsUnknown = false,
}: CalendarMonthViewProps) {
  const gridRef = useRef<HTMLDivElement>(null)
  // 月を跨いだ矢印移動の行き先。描き直しの後でなければ要素が無いゆえ effect で当てる。
  const pendingFocusRef = useRef<string | null>(null)
  useEffect(() => {
    const target = pendingFocusRef.current
    if (!target) return
    const el = gridRef.current?.querySelector<HTMLButtonElement>(
      `[data-date="${target}"]`,
    )
    if (el) {
      el.focus()
      pendingFocusRef.current = null
    }
  }, [grid, selectedDate])
  const cells = grid.flat()
  const gridDates = new Set(cells.map((c) => c.date))
  // 選択日がグリッドに無い（月送りの直後など）時は、月の 1 日に Tab が止まるようにする
  const tabStop = gridDates.has(selectedDate)
    ? selectedDate
    : (cells.find((c) => c.inMonth)?.date ?? cells[0]?.date)

  /**
   * 矢印キーで日を動かす（WAI-ARIA の日付グリッドの慣例）。移動先がグリッド内ならその場で
   * 選んでフォーカスを移し、外なら親へ渡して月を描き直させる。
   */
  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const delta = KEY_DELTAS[e.key]
    if (delta === undefined) return
    e.preventDefault()
    const next = shiftYmd(date, delta)
    if (gridDates.has(next)) {
      onSelectDate(next)
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
        ?.focus()
      return
    }
    if (!onNavigateDate) return
    pendingFocusRef.current = next
    onNavigateDate(next)
  }

  return (
    <div className="glass rounded-2xl p-2 shadow-lg shadow-black/[0.04]">
      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={cn(
              "pb-1 text-center text-xs font-medium",
              i === 5 && "text-blue-600 dark:text-blue-400",
              i === 6 && "text-red-600 dark:text-red-400",
              i < 5 && "text-muted-foreground",
            )}
          >
            {w}
          </div>
        ))}
      </div>
      <div
        ref={gridRef}
        className="grid grid-cols-7"
        role="group"
        aria-label="日付を選ぶ"
        aria-busy={busy || undefined}
      >
        {cells.map((cell) => {
          const dayEvents = eventsByDate.get(cell.date) ?? []
          const isSelected = cell.date === selectedDate
          const dayNum = Number(cell.date.slice(8, 10))
          return (
            <button
              key={cell.date}
              type="button"
              data-date={cell.date}
              onClick={() => onSelectDate(cell.date)}
              onKeyDown={(e) => handleKeyDown(e, cell.date)}
              tabIndex={cell.date === tabStop ? 0 : -1}
              aria-label={cellLabel(cell, dayEvents.length, countsUnknown)}
              aria-pressed={isSelected}
              aria-current={cell.isToday ? "date" : undefined}
              className={cn(
                "flex min-h-12 flex-col items-center justify-start rounded-xl py-1 transition-colors duration-200",
                "cursor-pointer hover:bg-muted/60 dark:hover:bg-muted/30",
                !cell.inMonth && "opacity-45",
                isSelected &&
                  "bg-primary/12 ring-1 ring-primary/50 ring-inset dark:bg-primary/20",
              )}
            >
              <span
                className={cn(
                  "flex size-7 items-center justify-center rounded-full text-sm tabular-nums",
                  cell.isToday && "bg-primary font-semibold text-primary-foreground",
                  !cell.isToday && isSelected && "font-semibold text-primary",
                )}
              >
                {dayNum}
              </span>
              <EventMarks events={dayEvents} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
