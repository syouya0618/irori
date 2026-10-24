"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { CalendarDays } from "lucide-react"

import { agendaTimeDisplay } from "@/components/calendar/calendar-agenda"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import { eventsForDate } from "@/lib/domain/calendar-grid"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { shiftYmd, todayJstString } from "@/lib/utils/date-jst"

interface UpcomingEventsCardProps {
  initialEvents: CalendarEventRecord[]
  householdId: string
  /** サーバ描画時点の JST 今日(YYYY-MM-DD)。refetch 時はクライアントで再計算する。 */
  initialToday: string
  /**
   * マウント直後に一度取り直す。initialEvents が今日のものではない時（開いたまま日を
   * 跨いだ後に作り直された時）に立てる。復帰の visibilitychange を待つと、それまで
   * 前日の予定を「今日」と出し続けるため。**マウント時の値だけを使う**（後の変化は無視）。
   */
  refetchOnMount?: boolean
}

interface DayBucket {
  date: string
  label: string
  events: CalendarEventRecord[]
}

/** 「今日」「明日」の 2 バケットへ振り分ける。空のバケットは落とす。 */
function bucketTodayTomorrow(
  events: CalendarEventRecord[],
  today: string,
): DayBucket[] {
  return [
    { date: today, label: "今日" },
    { date: shiftYmd(today, 1), label: "明日" },
  ]
    .map((b) => ({ ...b, events: eventsForDate(events, b.date) }))
    .filter((b) => b.events.length > 0)
}

export function UpcomingEventsCard({
  initialEvents,
  householdId,
  initialToday,
  refetchOnMount = false,
}: UpcomingEventsCardProps) {
  const [events, setEvents] = useState(initialEvents)
  const [today, setToday] = useState(initialToday)
  const generationRef = useRef(0)

  const refetch = useCallback(async (signal?: AbortSignal) => {
    const generation = ++generationRef.current
    // 日跨ぎ対応: 復帰のたびに JST 今日を取り直す（深夜に開いたまま朝に復帰しても
    // 「今日・明日」が実際の日付に追従する）。タイマーは張らない。
    const nextToday = todayJstString()
    const nextTomorrow = shiftYmd(nextToday, 1)
    const supabase = createClient()
    // destructure と同じ一本の鎖に保つ（scripts/check-supabase-error-destructure.py は
    // `.select(` から上の destructure を辿る。変数に組み立ててから別の文で受けると
    // 走査から外れる）。signal が無い経路（復帰時の refetch）は abort されぬ signal を渡す。
    const { data, error } = await supabase
      .from("calendar_events")
      .select(CALENDAR_EVENT_COLUMNS)
      .eq("household_id", householdId)
      .gte("end_date", nextToday) // 重なり判定: end_date >= 今日
      .lte("start_date", nextTomorrow) //          AND start_date <= 明日
      .order("start_date")
      .abortSignal(signal ?? new AbortController().signal)

    // 離脱（アンマウント）後の応答は捨てる
    if (signal?.aborted) return
    // 復帰連打で古い応答が新しい結果を上書きしないよう世代トークンで捨てる
    // （use-month-events.ts の fetchGenerationRef と同流儀）
    if (generation !== generationRef.current) return
    if (error) {
      logSupabaseError("baby", "upcoming events lookup failed", error, {
        householdId,
      })
      return
    }
    if (data) {
      setToday(nextToday)
      setEvents(data as unknown as CalendarEventRecord[])
    }
  }, [householdId])

  // 復帰時に自己回復する。Realtime は購読しない（本番 postgres_changes は間欠的で
  // DELETE はフィルタ配信されないため refetch が唯一の担保。issue #91/#92）。
  // 世代ガード（generationRef）は refetch 側に残す — フックはリスナの張り外しのみ。
  useVisibilityRefetch(
    useCallback(() => {
      void refetch()
    }, [refetch]),
  )

  // 日跨ぎ後の作り直し（refetchOnMount）。旗はマウント時の値で固定する（親は日ごとに
  // key で作り直す）— prop に追従すると、作り直し直後に Server Action の revalidatePath で
  // 親の initialDate が今日へ追いつき旗が false へ反転した時、cleanup が取り直しを abort し
  // カードが空のまま残る。離脱時は abort し、解決後の反映を捨てる。
  const [refetchOnMountLatched] = useState(refetchOnMount)
  useEffect(() => {
    if (!refetchOnMountLatched) return
    const abortController = new AbortController()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- setState は外部（Supabase）の取得を await した後にしか起きぬ（同期の連鎖描画ではない）
    void refetch(abortController.signal)
    return () => {
      abortController.abort()
    }
  }, [refetchOnMountLatched, refetch])

  const buckets = bucketTodayTomorrow(events, today)

  // 0 件時は何も描画しない。**この早期 return は必ず全 hooks より後に置く** —
  // hooks の前へ移すと rules-of-hooks 違反になり、かつ上の refetch が mount
  // されず「朝 0 件で開いたまま→配偶者が予定追加→復帰しても出ない」が再発する
  // （page 側の条件レンダリングを避ける理由と同根）。
  if (buckets.length === 0) return null

  // 外余白は持たない。置き場は BabyDashboard（`flex flex-col gap-4 px-4`）で、
  // 0 件で null を返せば gap ごと消える（旧 /meals では自前の mx-4 mt-4 を持っていた）。
  return (
    <Link
      href="/calendar"
      aria-label="今日・明日の予定（カレンダーを開く）"
      className="glass flex min-h-11 flex-col gap-2 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04] transition-colors duration-200 hover:bg-muted/50 dark:hover:bg-muted/20"
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        <CalendarDays size={16} className="shrink-0 text-muted-foreground" />
        今日・明日の予定
      </span>

      {buckets.map((b) => (
        <div key={b.date} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">
            {b.label}
          </span>
          <ul className="flex flex-col gap-1">
            {b.events.map((e) => {
              // 時刻語彙は CalendarAgenda(CAL-2) と同一関数に委ねる（二重実装で
              // 「→」表記が drift するのを防ぐ）。バケットの日付視点で評価する。
              const time = agendaTimeDisplay(e, b.date)
              return (
                <li key={e.id} className="flex items-center gap-3">
                  <span className="flex w-14 shrink-0 flex-col text-xs tabular-nums text-muted-foreground">
                    {time.primary && <span>{time.primary}</span>}
                    {time.secondary && <span>{time.secondary}</span>}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {e.title}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </Link>
  )
}
