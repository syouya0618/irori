"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { logRealtimeStatus, logRealtimeEvent } from "@/lib/supabase/realtime-log"
import {
  monthFirstOf,
  shiftMonth,
  currentMonthFirstJst,
  buildMonthGrid,
  bucketEventsByDate,
  eventsForDate,
  gridRangeOf,
  type CalendarEventLite,
} from "@/lib/domain/calendar-grid"
import { todayJstString } from "@/lib/utils/date-jst"
import type { CalendarEventSource } from "@/lib/types/database"

/** 作成の楽観行に使うローカル擬似 id の prefix。 */
export const OPTIMISTIC_EVENT_ID_PREFIX = "optimistic-cal-"

/** カレンダー UI が扱うイベント全体。CalendarEventLite を包含する。 */
export interface CalendarEventRecord extends CalendarEventLite {
  memo: string | null
  end_at: string | null
  source: CalendarEventSource
}

const EVENT_COLUMNS =
  "id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source"

interface UseMonthEventsArgs {
  initialEvents: CalendarEventRecord[]
  householdId: string
  initialMonthFirst: string
}

export function useMonthEvents({
  initialEvents,
  householdId,
  initialMonthFirst,
}: UseMonthEventsArgs) {
  const [events, setEvents] = useState<CalendarEventRecord[]>(initialEvents)
  const [monthFirst, setMonthFirst] = useState(monthFirstOf(initialMonthFirst))
  const [selectedDate, setSelectedDate] = useState<string>(todayJstString())

  const monthFirstRef = useRef(monthFirst)
  useEffect(() => {
    monthFirstRef.current = monthFirst
  }, [monthFirst])
  const fetchGenerationRef = useRef(0)

  const today = todayJstString()

  const grid = useMemo(() => buildMonthGrid(monthFirst, today), [monthFirst, today])
  const isCurrentMonth = monthFirst === currentMonthFirstJst()

  const eventsByDate = useMemo(() => {
    const { gridStart, gridEnd } = gridRangeOf(monthFirst)
    return bucketEventsByDate(events, gridStart, gridEnd)
  }, [events, monthFirst])

  const selectedEvents = useMemo(
    () => eventsForDate(events, selectedDate),
    [events, selectedDate],
  )

  const refetch = useCallback(
    async (targetMonthFirst: string) => {
      const generation = ++fetchGenerationRef.current
      const supabase = createClient()
      const { gridStart, gridEnd } = gridRangeOf(targetMonthFirst)
      const { data, error } = await supabase
        .from("calendar_events")
        .select(EVENT_COLUMNS)
        .eq("household_id", householdId)
        .lte("start_date", gridEnd) // 重なり判定: start_date <= gridEnd
        .gte("end_date", gridStart) //           AND end_date >= gridStart
        .order("start_date")

      // 月送り連打時に古い応答が新しい月を上書きしないよう世代トークンで捨てる
      if (generation !== fetchGenerationRef.current) return
      if (error) {
        logSupabaseError("calendar", "month lookup failed", error, { householdId })
        return
      }
      if (data) {
        // 楽観 temp 行は真値で置換される(refetch は真値のみで上書き)
        setEvents(data as unknown as CalendarEventRecord[])
      }
    },
    [householdId],
  )

  // 月変更で refetch
  const goToMonth = useCallback(
    (next: string) => {
      setMonthFirst(next)
      void refetch(next)
    },
    [refetch],
  )
  const goPrevMonth = useCallback(
    () => goToMonth(shiftMonth(monthFirstRef.current, -1)),
    [goToMonth],
  )
  const goNextMonth = useCallback(
    () => goToMonth(shiftMonth(monthFirstRef.current, 1)),
    [goToMonth],
  )
  const goToday = useCallback(() => {
    const m = currentMonthFirstJst()
    setSelectedDate(todayJstString())
    goToMonth(m)
  }, [goToMonth])

  // ---- 楽観更新ヘルパ ----
  const upsertOptimistic = useCallback((row: CalendarEventRecord) => {
    setEvents((prev) => {
      const idx = prev.findIndex((e) => e.id === row.id)
      if (idx === -1) return [...prev, row]
      const copy = [...prev]
      copy[idx] = row
      return copy
    })
  }, [])
  const removeOptimistic = useCallback((id: string) => {
    setEvents((prev) => prev.filter((e) => e.id !== id))
  }, [])
  const replaceOptimisticId = useCallback((tempId: string, realId: string) => {
    setEvents((prev) =>
      prev.map((e) => (e.id === tempId ? { ...e, id: realId } : e)),
    )
  }, [])
  const setAllEvents = useCallback((rows: CalendarEventRecord[]) => setEvents(rows), [])

  // Realtime(best-effort。#92 未解決でも下の visibilitychange refetch で自己回復)
  useEffect(() => {
    const supabase = createClient()
    const channelName = `calendar-${householdId}`
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "calendar_events",
          filter: `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent(channelName, payload)
          void refetch(monthFirstRef.current)
        },
      )
      .subscribe((status, err) => logRealtimeStatus(channelName, status, err))
    return () => {
      void supabase.removeChannel(channel)
    }
  }, [householdId, refetch])

  // 復帰時に自己回復(配偶者の削除・Google 同期の削除を拾う。DELETE は Realtime で
  // フィルタ配信されないため refetch が唯一の担保。issue #91/#92)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refetch(monthFirstRef.current)
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
    }
  }, [refetch])

  return {
    events,
    monthFirst,
    grid,
    isCurrentMonth,
    eventsByDate,
    selectedDate,
    setSelectedDate,
    selectedEvents,
    goPrevMonth,
    goNextMonth,
    goToday,
    refetch,
    upsertOptimistic,
    removeOptimistic,
    replaceOptimisticId,
    setAllEvents,
  }
}
