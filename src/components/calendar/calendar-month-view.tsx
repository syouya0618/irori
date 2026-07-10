"use client"

import { cn } from "@/lib/utils"
import type { CalendarGridCell } from "@/lib/domain/calendar-grid"
import type { CalendarEventRecord } from "./use-month-events"

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"]

interface CalendarMonthViewProps {
  grid: CalendarGridCell[][]
  eventsByDate: Map<string, CalendarEventRecord[]>
  selectedDate: string
  onSelectDate: (date: string) => void
}

/** 1 セル最大 3 個の dot。native=warm orange、google=muted。終日は塗り・時刻付きは輪郭。 */
function EventDots({ events }: { events: CalendarEventRecord[] }) {
  const shown = events.slice(0, 3)
  const overflow = events.length - shown.length
  return (
    <div className="mt-0.5 flex items-center justify-center gap-0.5">
      {shown.map((e) => (
        <span
          key={e.id}
          className={cn(
            "size-1.5 rounded-full",
            e.source === "google"
              ? "bg-muted-foreground/50"
              : "bg-primary",
            !e.is_all_day && "border border-primary bg-transparent",
          )}
        />
      ))}
      {overflow > 0 && (
        <span className="text-[9px] leading-none text-muted-foreground">
          +{overflow}
        </span>
      )}
    </div>
  )
}

export function CalendarMonthView({
  grid,
  eventsByDate,
  selectedDate,
  onSelectDate,
}: CalendarMonthViewProps) {
  return (
    <div className="glass rounded-2xl p-2 shadow-lg shadow-black/[0.04]">
      <div className="grid grid-cols-7">
        {WEEKDAYS.map((w, i) => (
          <div
            key={w}
            className={cn(
              "pb-1 text-center text-xs font-medium",
              i === 5 && "text-blue-500 dark:text-blue-400",
              i === 6 && "text-red-500 dark:text-red-400",
              i < 5 && "text-muted-foreground",
            )}
          >
            {w}
          </div>
        ))}
        {grid.flat().map((cell) => {
          const dayEvents = eventsByDate.get(cell.date) ?? []
          const isSelected = cell.date === selectedDate
          const dayNum = Number(cell.date.slice(8, 10))
          return (
            <button
              key={cell.date}
              type="button"
              onClick={() => onSelectDate(cell.date)}
              aria-label={`${cell.date} を選択`}
              aria-pressed={isSelected}
              className={cn(
                "flex min-h-11 flex-col items-center rounded-lg py-1 transition-colors duration-200",
                "cursor-pointer hover:bg-muted/60 dark:hover:bg-muted/30",
                !cell.inMonth && "opacity-40",
                isSelected && "bg-primary/10 dark:bg-primary/20",
              )}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-sm tabular-nums",
                  cell.isToday &&
                    "bg-primary font-semibold text-primary-foreground",
                )}
              >
                {dayNum}
              </span>
              <EventDots events={dayEvents} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
