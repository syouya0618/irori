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
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import type { CalendarDateView } from "@/lib/domain/calendar-link"
import { isValidYmd, todayJstString } from "@/lib/utils/date-jst"
import type { CalendarEventSource } from "@/lib/types/database"

/** 作成の楽観行に使うローカル擬似 id の prefix。 */
export const OPTIMISTIC_EVENT_ID_PREFIX = "optimistic-cal-"

/** カレンダー UI が扱うイベント全体。CalendarEventLite を包含する。 */
export interface CalendarEventRecord extends CalendarEventLite {
  memo: string | null
  end_at: string | null
  source: CalendarEventSource
  /** 繰り返しシリーズ識別子(単発は null)。シリーズ一括削除の可否判定に使う。 */
  series_id: string | null
}

// SELECT カラムは中立モジュール（@/lib/domain/calendar-event-columns）に置く。
// "use client" のこのファイルから値を re-export すると Server Component 側で
// client reference に化けて実行時に壊れるため、ここでは import して使うだけ。

interface UseMonthEventsArgs {
  initialEvents: CalendarEventRecord[]
  householdId: string
  /**
   * B-6: 最初に描く「日と月」。**1 本の値で受けるのが要点じゃ**（`CalendarDateView`）。
   *
   * 日と月を別々の prop で受けると「8 月の日を 7 月のグリッドで選んだ」状態
   * ——どのセルも光らぬまま「8月1日 の予定」が出る割れ——が型で表現可能に残る。
   * サーバは `resolveCalendarDateView` が対で導いた値をそのまま渡す。
   * 月だけをここで導き直してはならぬ: `initialEvents` は `gridRangeOf(monthFirst)`
   * で既に取得済みゆえ、月を黙って動かすと**別範囲の events** を描くことになる。
   */
  initialView: CalendarDateView
}

export function useMonthEvents({
  initialEvents,
  householdId,
  initialView,
}: UseMonthEventsArgs) {
  const [events, setEvents] = useState<CalendarEventRecord[]>(initialEvents)
  const [monthFirst, setMonthFirst] = useState(monthFirstOf(initialView.monthFirst))
  // 不正値は今日へ倒す。サーバ（`resolveCalendarDateView`）が既に締めておるゆえ
  // ここは二重の防御じゃが、`isValidYmd` は同じ 1 実装を呼んでおる（二重実装ではない）。
  const [selectedDate, setSelectedDate] = useState<string>(
    isValidYmd(initialView.selectedDate) ? initialView.selectedDate : todayJstString(),
  )

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
        .select(CALENDAR_EVENT_COLUMNS)
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

  // 月変更で refetch。選択日もその月の 1 日へ寄せる(表示月とアジェンダの
  // 対象日が乖離し、範囲外の日を「予定はありません」と誤表示するのを防ぐ)。
  const goToMonth = useCallback(
    (next: string) => {
      setMonthFirst(next)
      setSelectedDate(monthFirstOf(next))
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
  // 今日へ: goToMonth と違い選択日は「今日」にする(月の 1 日でなく)。
  const goToday = useCallback(() => {
    const m = currentMonthFirstJst()
    setMonthFirst(m)
    setSelectedDate(todayJstString())
    void refetch(m)
  }, [refetch])

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
  // フィルタ配信されないため refetch が唯一の担保。issue #91/#92)。
  // 世代ガードは refetch 側(fetchGenerationRef)に残す — フックはリスナの張り外しのみ。
  useVisibilityRefetch(
    useCallback(() => {
      void refetch(monthFirstRef.current)
    }, [refetch]),
  )

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
