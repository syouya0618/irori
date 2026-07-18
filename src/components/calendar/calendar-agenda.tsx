"use client"

import { ExternalLink } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatTimeJst, toJstDateString } from "@/lib/utils/date-jst"
import type { CalendarEventRecord } from "./use-month-events"

interface CalendarAgendaProps {
  dateLabel: string
  events: CalendarEventRecord[]
  /** アジェンダの対象日(YYYY-MM-DD, JST)。多日イベントの表示分岐に使う。 */
  selectedDate: string
  onTapEvent: (event: CalendarEventRecord) => void
}

/** アジェンダ時刻セルの表示。primary=1段目, secondary=任意の2段目。 */
interface AgendaTimeDisplay {
  primary: string
  secondary?: string
}

/**
 * selectedDate 視点でイベントの時刻セル表示を決める(表示分岐の完全表)。
 * - 終日: 「終日」
 * - timed・当日開始・end 同日 or なし: 「14:00」(+終了あれば 2 段目「〜15:00」)
 * - timed・当日開始・end 翌日以降: 「14:00 →」
 * - timed・開始日 < selectedDate・end の JST 日 > selectedDate: 「→」(継続中)
 * - timed・開始日 < selectedDate・end の JST 日 = selectedDate: 「→ 02:00」
 * - timed・開始日 < selectedDate・end_at なし: 「→」(継続中扱いフォールバック)
 *
 * 開始日判定は start_date(グリッドのバケット基準と同一)、終了日判定は end_at の
 * JST 日(toJstDateString)を用いる。eventsForDate が start_date <= selectedDate を
 * 保証するため、開始判定は「= selectedDate」か「< selectedDate」の二択で網羅する。
 */
function agendaTimeDisplay(
  e: CalendarEventRecord,
  selectedDate: string,
): AgendaTimeDisplay {
  if (e.is_all_day) return { primary: "終日" }

  const endJstDay = e.end_at ? toJstDateString(e.end_at) : null

  if (e.start_date === selectedDate) {
    const startTime = e.start_at ? formatTimeJst(e.start_at) : ""
    if (!e.end_at) return { primary: startTime }
    // end 同日: 2 段表示 / end 翌日以降: 開始時刻 + 継続矢印
    if (endJstDay === selectedDate) {
      return { primary: startTime, secondary: `〜${formatTimeJst(e.end_at)}` }
    }
    return { primary: `${startTime} →` }
  }

  // start_date < selectedDate(前日以前に開始し当日へ継続)
  if (e.end_at && endJstDay === selectedDate) {
    return { primary: `→ ${formatTimeJst(e.end_at)}` }
  }
  return { primary: "→" }
}

export function CalendarAgenda({
  dateLabel,
  events,
  selectedDate,
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
            const time = agendaTimeDisplay(e, selectedDate)
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
                  <span className="flex w-14 shrink-0 flex-col text-xs tabular-nums text-muted-foreground">
                    {time.primary && <span>{time.primary}</span>}
                    {time.secondary && <span>{time.secondary}</span>}
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
