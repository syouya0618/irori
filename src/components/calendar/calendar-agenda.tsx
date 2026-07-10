"use client"

import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { CalendarEventRecord } from "./use-month-events"

interface CalendarAgendaProps {
  dateLabel: string
  events: CalendarEventRecord[]
  onTapEvent: (event: CalendarEventRecord) => void
}

export function CalendarAgenda({
  dateLabel,
  events,
  onTapEvent,
}: CalendarAgendaProps) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-1 text-sm font-semibold text-muted-foreground">
        {dateLabel} の予定
      </h2>
      {events.length === 0 ? (
        <p className="px-1 py-4 text-center text-sm text-muted-foreground">
          予定はありません
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {events.map((e) => {
            const isGoogle = e.source === "google"
            return (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => onTapEvent(e)}
                  className={cn(
                    "glass flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-200",
                    "cursor-pointer hover:bg-muted/50 dark:hover:bg-muted/20",
                  )}
                >
                  <span className="w-14 shrink-0 text-xs tabular-nums text-muted-foreground">
                    {e.is_all_day
                      ? "終日"
                      : e.start_at
                        ? formatTimeJst(e.start_at)
                        : ""}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {e.title}
                  </span>
                  {isGoogle && (
                    <ExternalLink
                      size={14}
                      className="shrink-0 text-muted-foreground"
                      aria-label="Google カレンダーの予定（閲覧のみ）"
                    />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
