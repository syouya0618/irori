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
  /**
   * 更新の版（PostgREST が返した表記のまま）。編集の保存で `expectedUpdatedAt` として
   * 送り、別の端末が先に直した予定を巻き戻さぬ。作成応答の前の楽観行だけ null。
   */
  updated_at: string | null
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
  /**
   * サーバでの初回取得が失敗したか。true なら最初から「読み込めなかった」を出す
   * （`[]` を「予定はありません」と描かせぬ）。
   */
  initialLoadFailed?: boolean
}

/**
 * 表示中の月の取得状態。
 * - `idle`: 表示は最新（または最後の取得に成功）
 * - `loading`: 利用者の操作（月送り・今日・再試行）で別の月を取り直し中。
 *   旧い月の行は新しい範囲を埋めぬゆえ、空欄を「予定はありません」と言わせぬ
 * - `error`: その月を一度も取れていない（表示は当てにならぬ）
 * - `stale`: 背景の取り直し（Realtime・復帰）だけが失敗した。表示は直前の成功時点のまま
 */
export type MonthLoadState = "idle" | "loading" | "error" | "stale"

export function useMonthEvents({
  initialEvents,
  householdId,
  initialView,
  initialLoadFailed = false,
}: UseMonthEventsArgs) {
  const [events, setEvents] = useState<CalendarEventRecord[]>(initialEvents)
  const [loadState, setLoadState] = useState<MonthLoadState>(
    initialLoadFailed ? "error" : "idle",
  )
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

  /**
   * 月を取り直す。`foreground` は利用者の操作による取得（月送り・今日・再試行）で、
   * 待つ間は `loading`、失敗は `error` を立てる。背景の取得（Realtime・復帰・同期完了）は
   * 画面を空にせず、失敗しても表示を残したまま `stale` だけを立てる。
   */
  const refetch = useCallback(
    async (targetMonthFirst: string, opts: { foreground?: boolean } = {}) => {
      const generation = ++fetchGenerationRef.current
      if (opts.foreground) setLoadState("loading")
      const supabase = createClient()
      const { gridStart, gridEnd } = gridRangeOf(targetMonthFirst)
      let data: unknown[] | null = null
      let failed = false
      try {
        const res = await supabase
          .from("calendar_events")
          .select(CALENDAR_EVENT_COLUMNS)
          .eq("household_id", householdId)
          .lte("start_date", gridEnd) // 重なり判定: start_date <= gridEnd
          .gte("end_date", gridStart) //           AND end_date >= gridStart
          .order("start_date")
        if (res.error) {
          // 世代が古くとも失敗は記録する（真因を辿れるように）
          logSupabaseError("calendar", "month lookup failed", res.error, { householdId })
          failed = true
        } else {
          data = res.data as unknown[] | null
        }
      } catch (err) {
        console.error("[calendar] month lookup threw", {
          householdId,
          message: err instanceof Error ? err.message : String(err),
        })
        failed = true
      }

      // 月送り連打時に古い応答が新しい月を上書きしないよう世代トークンで捨てる
      if (generation !== fetchGenerationRef.current) return
      if (failed) {
        // 背景の失敗でも、まだ一度も取れていない（loading / error）なら error のまま。
        setLoadState((prev) =>
          opts.foreground || prev === "loading" || prev === "error" ? "error" : "stale",
        )
        return
      }
      if (data) {
        // 楽観 temp 行は真値で置換される(refetch は真値のみで上書き)
        setEvents(data as unknown as CalendarEventRecord[])
      }
      setLoadState("idle")
    },
    [householdId],
  )

  // 月変更で refetch。選択日もその月の 1 日へ寄せる(表示月とアジェンダの
  // 対象日が乖離し、範囲外の日を「予定はありません」と誤表示するのを防ぐ)。
  const goToMonth = useCallback(
    (next: string) => {
      setMonthFirst(next)
      setSelectedDate(monthFirstOf(next))
      void refetch(next, { foreground: true })
    },
    [refetch],
  )
  /**
   * 日付へ移る（キーボードの矢印で月を跨いだ時など）。同じ月なら選ぶだけ、
   * 別の月ならその月を描き直し、選択日は**指定日のまま**にする。
   */
  const goToDate = useCallback(
    (date: string) => {
      if (!isValidYmd(date)) return
      const nextMonth = monthFirstOf(date)
      setSelectedDate(date)
      if (nextMonth !== monthFirstRef.current) {
        setMonthFirst(nextMonth)
        void refetch(nextMonth, { foreground: true })
      }
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
    setSelectedDate(todayJstString())
    // 既に今月なら取り直さぬ（選択日だけ今日へ戻す）
    if (m === monthFirstRef.current) return
    setMonthFirst(m)
    void refetch(m, { foreground: true })
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
  const replaceOptimisticId = useCallback(
    (tempId: string, realId: string, updatedAt: string | null = null) => {
      setEvents((prev) =>
        prev.map((e) =>
          e.id === tempId
            ? { ...e, id: realId, updated_at: updatedAt ?? e.updated_at }
            : e,
        ),
      )
    },
    [],
  )
  const setAllEvents = useCallback((rows: CalendarEventRecord[]) => setEvents(rows), [])
  /**
   * いま表示中の月を取り直す。非同期の応答（保存の衝突・作成の完了・同期の完了）の後で
   * 呼ぶ経路は、呼び出し時点の `monthFirst` を閉じ込めると、待つ間に月を送った利用者の
   * 新しい月を旧月の範囲で上書きしてしまう。ゆえに ref の最新値を読む。
   */
  const refetchCurrent = useCallback(
    () => refetch(monthFirstRef.current),
    [refetch],
  )
  /** 「読み込めませんでした」からの再試行（利用者の操作ゆえ foreground）。 */
  const retry = useCallback(
    () => refetch(monthFirstRef.current, { foreground: true }),
    [refetch],
  )

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
    goToDate,
    today,
    loadState,
    retry,
    refetch,
    refetchCurrent,
    upsertOptimistic,
    removeOptimistic,
    replaceOptimisticId,
    setAllEvents,
  }
}
