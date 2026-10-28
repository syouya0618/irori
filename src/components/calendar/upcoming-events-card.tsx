"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { CalendarDays, CloudOff, RotateCw, TriangleAlert } from "lucide-react"

import { agendaTimeDisplay } from "@/components/calendar/calendar-agenda"
import type { CalendarEventRecord } from "@/components/calendar/use-month-events"
import { HomeFoldToggle, HomeFoldedRow } from "@/components/baby/baby-collapsible-section"
import { CALENDAR_EVENT_COLUMNS } from "@/lib/domain/calendar-event-columns"
import { eventsForDate } from "@/lib/domain/calendar-grid"
import { FRESHNESS_RETRY_LABEL } from "@/lib/domain/freshness"
import {
  eventSeenMark,
  readEventsSeen,
  writeEventsSeen,
  type EventsSeen,
  type HandoffOwner,
} from "@/lib/domain/handoff"
import { useVisibilityRefetch } from "@/lib/hooks/use-visibility-refetch"
import { createClient } from "@/lib/supabase/client"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { formatTimeJst, shiftYmd, todayJstString } from "@/lib/utils/date-jst"

/** 予定の取り直しの期限（過ぎた応答は待たず、最新を確認できぬとして扱う） */
export const UPCOMING_FETCH_TIMEOUT_MS = 8_000

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
  /**
   * サーバでの初回取得が失敗した（2026-10-27）。`[]` を「予定なし」と偽らず、失敗と再試行を出す。
   * **マウント時の値だけを使う**。
   */
  initialLoadFailed?: boolean
  /**
   * 「この端末で見た予定」の記録の持ち主（C4 引き継ぎ。2026-10-28）。渡すと、このカードが見た予定の
   * id と版を読み書きし、初めて見る予定・見た後に更新された予定に印を付ける（時刻の閾値で前後を断定
   * せぬ。誰が直したかも言わぬ）。省略・null は印を出さず書かぬ
   */
  seenOwner?: HandoffOwner | null
  /** 畳んでおるか（ホームの任意の折り畳み。省略時は畳めぬ）。読めなんだ時は畳まぬ */
  folded?: boolean
  onFoldChange?: (folded: boolean) => void
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
  initialLoadFailed = false,
  seenOwner,
  folded = false,
  onFoldChange,
}: UpcomingEventsCardProps) {
  const [events, setEvents] = useState(initialEvents)
  const [today, setToday] = useState(initialToday)
  // 取得の状態（C1 鮮度）: 最後に成功した時刻と、直近の取り直しが失敗したか
  const [failed, setFailed] = useState(initialLoadFailed)
  // この端末で見た予定の記録（持ち主を渡された時）。マウント時に一度だけ読み（この表示の間は固定）、
  // 離れる時に今見えておる予定（id と版）を足して残す。時刻の閾値では比べぬ（handoff.ts の注記）
  const [eventsSeen, setEventsSeen] = useState<EventsSeen | null>(null)
  const seenOwnerKey = seenOwner ? `${seenOwner.userId}:${seenOwner.householdId}` : null
  useEffect(() => {
    if (!seenOwner) return
    setEventsSeen(readEventsSeen(seenOwner)) // eslint-disable-line react-hooks/set-state-in-effect -- 端末の保存は描画の後に読む（SSR と食い違わせぬ）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 持ち主の鍵が変わった時だけ読み直す
  }, [seenOwnerKey])
  // 離れる時に残す「今見えておる予定」。取得に失敗しておる間・畳んでおる間は残さぬ（見ておらぬ予定を
  // 「見た」ことにせぬ）
  const visibleForSeenRef = useRef<{ list: CalendarEventRecord[]; today: string } | null>(null)
  useEffect(() => {
    visibleForSeenRef.current =
      failed || folded
        ? null
        : {
            list: bucketTodayTomorrow(events, today)
              .flatMap((b) => b.events)
              .filter((e) => e.source === "native"),
            today,
          }
  }, [events, failed, folded, today])
  useEffect(() => {
    if (!seenOwner) return
    const owner = seenOwner
    const previous = readEventsSeen(owner)
    const save = () => {
      const visible = visibleForSeenRef.current
      if (visible) writeEventsSeen(owner, readEventsSeen(owner) ?? previous, visible.list, visible.today)
    }
    const onHide = () => {
      if (document.visibilityState === "hidden") save()
    }
    window.addEventListener("pagehide", save)
    document.addEventListener("visibilitychange", onHide)
    return () => {
      window.removeEventListener("pagehide", save)
      document.removeEventListener("visibilitychange", onHide)
      save()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 持ち主の鍵が変わった時だけ張り直す
  }, [seenOwnerKey])
  // 予定 1 件の印（持ち主が無い・Google の予定は印を出さぬ）
  const markFor = (e: CalendarEventRecord): "first-shown" | "updated" | null =>
    seenOwner && e.source === "native" ? eventSeenMark(e, eventsSeen) : null
  const [lastOkAt, setLastOkAt] = useState<number | null>(() =>
    initialLoadFailed ? null : Date.now(),
  )
  const [retrying, setRetrying] = useState(false)
  const generationRef = useRef(0)
  const inFlightRef = useRef<AbortController | null>(null)

  const refetch = useCallback(async (signal?: AbortSignal) => {
    const generation = ++generationRef.current
    // 期限とキャンセル: 前の取得を止め、外の signal（離脱）と期限のどちらでも止まる取得にする
    inFlightRef.current?.abort()
    const controller = new AbortController()
    inFlightRef.current = controller
    const onOuterAbort = () => controller.abort()
    signal?.addEventListener("abort", onOuterAbort)
    const timer = setTimeout(() => controller.abort(), UPCOMING_FETCH_TIMEOUT_MS)
    // 日跨ぎ対応: 復帰のたびに JST 今日を取り直す（深夜に開いたまま朝に復帰しても
    // 「今日・明日」が実際の日付に追従する）。タイマーは張らない。
    const nextToday = todayJstString()
    const nextTomorrow = shiftYmd(nextToday, 1)
    try {
      const supabase = createClient()
      // destructure と同じ一本の鎖に保つ（scripts/check-supabase-error-destructure.py は
      // `.select(` から上の destructure を辿る。変数に組み立ててから別の文で受けると
      // 走査から外れる）。
      const { data, error } = await supabase
        .from("calendar_events")
        .select(CALENDAR_EVENT_COLUMNS)
        .eq("household_id", householdId)
        .gte("end_date", nextToday) // 重なり判定: end_date >= 今日
        .lte("start_date", nextTomorrow) //          AND start_date <= 明日
        .order("start_date")
        .abortSignal(controller.signal)

      // 離脱（アンマウント）後の応答は捨てる
      if (signal?.aborted) return
      // 復帰連打で古い応答が新しい結果を上書きしないよう世代トークンで捨てる
      // （use-month-events.ts の fetchGenerationRef と同流儀）
      if (generation !== generationRef.current) return
      if (error) {
        logSupabaseError("baby", "upcoming events lookup failed", error, {
          householdId,
        })
        // 失敗を「予定なし」と偽らぬ（表示は直前の成功のまま、最新を確認できぬと出す）
        setFailed(true)
        return
      }
      if (data) {
        setToday(nextToday)
        setEvents(data as unknown as CalendarEventRecord[])
      }
      setFailed(false)
      setLastOkAt(Date.now())
    } catch (err) {
      if (signal?.aborted || generation !== generationRef.current) return
      console.error("[baby] upcoming events lookup threw", {
        householdId,
        message: err instanceof Error ? err.message : String(err),
      })
      setFailed(true)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onOuterAbort)
      if (inFlightRef.current === controller) inFlightRef.current = null
    }
  }, [householdId])

  // 離脱で in-flight の取り直しを止める
  useEffect(() => {
    return () => {
      inFlightRef.current?.abort()
    }
  }, [])

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

  const retry = () => {
    setRetrying(true)
    void refetch().finally(() => setRetrying(false))
  }

  const buckets = bucketTodayTomorrow(events, today)

  // 0 件時は何も描画しない。**この早期 return は必ず全 hooks より後に置く** —
  // hooks の前へ移すと rules-of-hooks 違反になり、かつ上の refetch が mount
  // されず「朝 0 件で開いたまま→配偶者が予定追加→復帰しても出ない」が再発する
  // （page 側の条件レンダリングを避ける理由と同根）。
  // ⚠️ 読めなんだ時は 0 件と言わぬ（2026-10-27）: 失敗と再試行を出す
  if (buckets.length === 0 && !failed) return null

  if (buckets.length === 0) {
    // 一度も読めておらぬ・読み直しも失敗した: 「予定なし」と偽らず、失敗を出す（畳まぬ）
    return (
      <section
        role="alert"
        aria-label="今日・明日の予定"
        className="glass flex flex-col gap-2 rounded-2xl px-4 py-3 shadow-lg shadow-black/[0.04]"
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <CalendarDays size={16} className="shrink-0 text-muted-foreground" />
          今日・明日の予定
        </span>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <TriangleAlert size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          予定を読み込めませんでした（予定がないとは限りません）
          {lastOkAt !== null ? `。最終確認 ${formatTimeJst(new Date(lastOkAt).toISOString())}` : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            aria-label={`予定を${FRESHNESS_RETRY_LABEL}`}
            className="flex min-h-11 cursor-pointer items-center gap-1 rounded-lg px-3 text-sm font-medium text-primary transition-colors duration-200 hover:bg-primary/10 disabled:opacity-50"
          >
            <RotateCw size={16} aria-hidden="true" />
            {FRESHNESS_RETRY_LABEL}
          </button>
          <Link
            href="/calendar"
            className="flex min-h-11 items-center px-3 text-sm text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            カレンダーを開く
          </Link>
        </div>
      </section>
    )
  }

  const count = buckets.reduce((n, b) => n + b.events.length, 0)
  if (folded && onFoldChange && !failed) {
    return (
      <HomeFoldedRow
        title="今日・明日の予定"
        summary={`${count}件`}
        icon={<CalendarDays size={20} />}
        onExpand={() => onFoldChange(false)}
      />
    )
  }

  // 外余白は持たない。置き場は BabyDashboard（`flex flex-col gap-4 px-4`）で、
  // 0 件で null を返せば gap ごと消える（旧 /meals では自前の mx-4 mt-4 を持っていた）。
  return (
    <section className="glass relative flex flex-col rounded-2xl shadow-lg shadow-black/[0.04]">
      <Link
        href="/calendar"
        aria-label="今日・明日の予定（カレンダーを開く）"
        className="flex min-h-11 flex-col gap-2 rounded-2xl px-4 py-3 transition-colors duration-200 hover:bg-muted/50 dark:hover:bg-muted/20"
      >
        <span className="flex items-center gap-2 pr-14 text-sm font-semibold">
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
                    {/* 題と印は折り返せる行に置く（文字 200% で印が横にはみ出した。2026-10-28 の再撮影） */}
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="min-w-0 max-w-full truncate text-sm">
                        {e.title}
                      </span>
                      {markFor(e) && (
                        // いつ・誰が作った/直したかは言わぬ。分かるのは「この端末で見たか」と「見た後に版が
                        // 進んだか」だけ（id と版の記録）
                        <span className="max-w-full rounded-full bg-primary/12 px-2 py-0.5 text-xs text-primary dark:bg-primary/20">
                          {markFor(e) === "first-shown" ? "この端末で初めて表示" : "前回の確認後に更新"}
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </Link>
      {/* 直近の取り直しが失敗: 表示は直前の成功のまま、その旨と再試行を出す */}
      {failed && (
        <div className="flex items-center gap-2 border-t border-border/40 px-4 py-2 text-xs text-muted-foreground">
          <CloudOff size={14} className="shrink-0" aria-hidden="true" />
          <span className="flex-1">
            最新を確認できません
            {lastOkAt !== null ? `（最終確認 ${formatTimeJst(new Date(lastOkAt).toISOString())}）` : ""}
          </span>
          <button
            type="button"
            onClick={retry}
            disabled={retrying}
            aria-label={`予定を${FRESHNESS_RETRY_LABEL}`}
            className="touch-target shrink-0 cursor-pointer rounded-lg px-2 font-medium text-primary transition-colors duration-200 hover:bg-primary/10 disabled:opacity-50"
          >
            {FRESHNESS_RETRY_LABEL}
          </button>
        </div>
      )}
      {onFoldChange && !failed && (
        <HomeFoldToggle
          title="今日・明日の予定"
          onFold={() => onFoldChange(true)}
          className="absolute top-0.5 right-1"
        />
      )}
    </section>
  )
}
