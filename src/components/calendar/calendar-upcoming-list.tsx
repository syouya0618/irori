"use client"

import { useState } from "react"
import { ChevronDown, ChevronUp, ListOrdered, Lock } from "lucide-react"
import { gridRangeOf } from "@/lib/domain/calendar-grid"
import type { CalendarEventRecord, MonthLoadState } from "./use-month-events"
import { eventWhenLabel, formatShortDay } from "./calendar-display"

/** 一度に並べる上限（読み込んでいる範囲の中での件数。全件読込みはせぬ） */
export const UPCOMING_LIST_LIMIT = 10

/**
 * 読み込んでいる範囲（月グリッド）の中の、今日以降に終わる予定を開始順に並べる。
 * 範囲の外（翌月以降の予定）は読み込んでおらぬゆえ含めぬ — 呼び出し側は範囲を示すこと。
 */
export function upcomingWithinLoaded(
  events: readonly CalendarEventRecord[],
  today: string,
  limit: number = UPCOMING_LIST_LIMIT,
): { items: CalendarEventRecord[]; more: number } {
  const list = events
    .filter((e) => e.end_date >= today)
    .slice()
    .sort((a, b) => {
      // 進行中（今日より前に始まった）は今日の扱い。日付 → 終日を先 → 時刻
      const da = a.start_date < today ? today : a.start_date
      const db = b.start_date < today ? today : b.start_date
      if (da !== db) return da.localeCompare(db)
      if (a.is_all_day !== b.is_all_day) return a.is_all_day ? -1 : 1
      return (a.start_at ?? "").localeCompare(b.start_at ?? "")
    })
  return { items: list.slice(0, limit), more: Math.max(0, list.length - limit) }
}

interface CalendarUpcomingListProps {
  events: CalendarEventRecord[]
  monthFirst: string
  today: string
  loadState: MonthLoadState
  /** 行をタップ → その日の予定（アジェンダ）へ移る */
  onSelectDate: (ymd: string) => void
  onGoToday: () => void
}

/**
 * 「直近の予定」（2026-10-27 D）。月表示とその日のアジェンダは保ち、その下に今日以降の予定を
 * 並べる入口を置く。新しいカレンダー部品や全件の読み込みはせず、**今読み込んでいる月の範囲**から
 * 組む — その範囲を文字で示し、範囲の外を「予定なし」と言わぬ。既定は畳む（画面を長くせぬ）。
 */
export function CalendarUpcomingList({
  events,
  monthFirst,
  today,
  loadState,
  onSelectDate,
  onGoToday,
}: CalendarUpcomingListProps) {
  const [open, setOpen] = useState(false)
  const { gridStart, gridEnd } = gridRangeOf(monthFirst)
  const rangeLabel = `${formatShortDay(gridStart)}〜${formatShortDay(gridEnd)}`
  const unreliable = loadState === "loading" || loadState === "error"
  const todayInRange = today >= gridStart && today <= gridEnd
  const { items, more } = upcomingWithinLoaded(events, today)
  const panelId = "calendar-upcoming-panel"

  return (
    <section className="glass flex flex-col rounded-2xl shadow-lg shadow-black/[0.04]">
      <h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-12 w-full cursor-pointer items-center gap-3 rounded-2xl px-4 py-2.5 text-left transition-colors duration-200 hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <ListOrdered size={18} className="shrink-0 text-primary" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="text-sm font-semibold">直近の予定</span>
            <span className="text-xs font-normal text-muted-foreground">
              読み込んでいる範囲（{rangeLabel}）の今日以降
            </span>
          </span>
          {open ? (
            <ChevronUp size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <ChevronDown size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
        </button>
      </h2>
      {open && (
        <div id={panelId} className="flex flex-col gap-2 px-4 pb-4">
          {unreliable ? (
            <p className="text-sm text-muted-foreground">
              {loadState === "loading"
                ? "予定を読み込み中です"
                : "予定を読み込めなかったため、直近の予定を並べられません（予定がないとは限りません）"}
            </p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
              <p>
                {todayInRange || gridEnd >= today
                  ? `この範囲（${rangeLabel}）に今日以降の予定はありません。翌月以降は月を送って確かめてください。`
                  : `この範囲（${rangeLabel}）は今日より前です。`}
              </p>
              {!todayInRange && (
                <button
                  type="button"
                  onClick={onGoToday}
                  className="min-h-11 cursor-pointer rounded-lg px-2 font-medium text-primary transition-colors duration-200 hover:bg-primary/10"
                >
                  今日の月へ移る
                </button>
              )}
            </div>
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-border/40">
                {items.map((e) => {
                  const date = e.start_date < today ? today : e.start_date
                  return (
                    <li key={e.id}>
                      <button
                        type="button"
                        onClick={() => onSelectDate(date)}
                        className="flex min-h-12 w-full cursor-pointer items-center gap-3 py-2 text-left transition-colors duration-200 hover:bg-muted/40"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium">{e.title}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {eventWhenLabel(e)}
                          </span>
                        </span>
                        {e.source === "google" && (
                          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                            <Lock size={12} aria-hidden="true" />
                            Google
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <p className="text-xs text-muted-foreground">
                {more > 0
                  ? `ほかに${more}件あります（この範囲内）。日付を選ぶと、その日の予定を見られます。`
                  : "この範囲の外（翌月以降）の予定は、月を送ると表示されます。"}
              </p>
            </>
          )}
        </div>
      )}
    </section>
  )
}
