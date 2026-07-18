"use client"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { toast } from "sonner"
import { createClient } from "@/lib/supabase/client"
import { logRealtimeStatus, logRealtimeEvent } from "@/lib/supabase/realtime-log"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyAgeHeader } from "./baby-age-header"
import { BabyDateNav } from "./baby-date-nav"
import { BabySummaryBar } from "./baby-summary-bar"
import { BabyQuickActions } from "./baby-quick-actions"
import { BabyTimeline } from "./baby-timeline"
import { BabyLogFormSheet } from "./baby-log-form-sheet"
import { FeedingTimer } from "./feeding-timer"
import { BabyWeeklySummary } from "./weekly-summary/baby-weekly-summary"
import { GrowthChartSection } from "./charts/growth-chart-section"
import { useNow } from "@/lib/hooks/use-now"
import { todayJstString, toJstDateString, shiftYmd } from "@/lib/utils/date-jst"
import { buildBabyWeeklySummary } from "@/lib/domain/baby-weekly-summary"
import {
  deriveDashboardSummary,
  mergeDateNavLogs,
} from "@/lib/domain/baby-dashboard-summary"
import {
  summarizeTodayCounts,
  buildGrowthSeries,
} from "@/lib/domain/baby-log-aggregation"
import { sleepOverlapMinutesForDate } from "@/lib/domain/baby-sleep-overlap"
import type { BabyLogData } from "@/lib/types/baby"
import type { BabyLogType, FeedingType } from "@/lib/types/database"

interface BabyDashboardProps {
  initialLogs: BabyLogData[]
  /**
   * 前夜開始・当日終了の overlap 睡眠（B-02）。今日のまとめの按分入力専用で
   * timeline（logs）には合流させない。選択日変更時は refetch で入れ替える。
   */
  initialOverlapLogs: BabyLogData[]
  initialWeeklyLogs: BabyLogData[]
  initialGrowthLogs: BabyLogData[]
  householdId: string
  userId: string
  initialDate: string
  lastSleepEndedAt: string | null
  activeSleepFallback: BabyLogData | null
  babyName: string | null
  babyBirthDate: string | null
}

/**
 * 前夜以前に開始し、選択日 `date` の JST 窓に重なる完了睡眠か（overlapLogs 判定）。
 * `date` 当日に開始した睡眠は logs 側に属するため除外し、二重計上を防ぐ。
 */
function isOverlapSleepFor(log: BabyLogData, date: string): boolean {
  return (
    log.log_type === "sleep" &&
    !!log.ended_at &&
    toJstDateString(log.logged_at) < date &&
    sleepOverlapMinutesForDate(log.logged_at, log.ended_at, date) > 0
  )
}

export function BabyDashboard({
  initialLogs,
  initialOverlapLogs,
  initialWeeklyLogs,
  initialGrowthLogs,
  householdId,
  initialDate,
  lastSleepEndedAt,
  activeSleepFallback,
  babyName,
  babyBirthDate,
}: BabyDashboardProps) {
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  // B-02: 前夜開始の overlap 睡眠。summarizeTodayCounts の入力にのみ合流させる
  // （timeline = logs には混ぜない）。logs とは logged_at レンジが排他のため重複しない。
  const [overlapLogs, setOverlapLogs] =
    useState<BabyLogData[]>(initialOverlapLogs)
  const [weeklyLogs, setWeeklyLogs] =
    useState<BabyLogData[]>(initialWeeklyLogs)
  const [growthLogs, setGrowthLogs] =
    useState<BabyLogData[]>(initialGrowthLogs)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<BabyLogData | null>(null)
  const [createLogType, setCreateLogType] = useState<BabyLogType | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [timerOpen, setTimerOpen] = useState(false)
  const [timerFeedingType, setTimerFeedingType] = useState<FeedingType>("breast_left")
  // 日跨ぎアクティブ睡眠のサーバフォールバック（B-01）。
  // state 保持にするのは endSleep 成功時に明示クリアするため
  // （Realtime 不達 #92 でもトグルが「睡眠中」へ戻らない）。
  const [serverActiveSleep, setServerActiveSleep] =
    useState<BabyLogData | null>(activeSleepFallback)
  const now = useNow(60_000)

  const today = todayJstString()
  const weeklyStartDate = useMemo(() => shiftYmd(today, -6), [today])
  const isToday = selectedDate === today

  // Ref for selectedDate so Realtime callback sees the latest value
  const selectedDateRef = useRef(selectedDate)
  const weeklyStartDateRef = useRef(weeklyStartDate)
  const todayRef = useRef(today)
  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])
  useEffect(() => {
    weeklyStartDateRef.current = weeklyStartDate
    todayRef.current = today
  }, [weeklyStartDate, today])

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient()
    const isRelevantToCurrentWeek = (log: BabyLogData) => {
      const logDate = toJstDateString(log.logged_at)
      if (logDate >= weeklyStartDateRef.current && logDate <= todayRef.current)
        return true

      if (log.log_type !== "sleep" || !log.ended_at) return false

      const weekStartMs = new Date(
        `${weeklyStartDateRef.current}T00:00:00+09:00`,
      ).getTime()
      const weekEndMs = new Date(
        `${shiftYmd(todayRef.current, 1)}T00:00:00+09:00`,
      ).getTime()
      const sleepStartMs = new Date(log.logged_at).getTime()
      const sleepEndMs = new Date(log.ended_at).getTime()

      return sleepEndMs > weekStartMs && sleepStartMs < weekEndMs
    }

    const channel = supabase
      .channel("baby_logs")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "baby_logs",
          filter: `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent("baby_logs", payload)
          if (payload.eventType === "INSERT") {
            const newLog = payload.new as BabyLogData
            if (newLog.log_type === "growth") {
              setGrowthLogs((prev) => {
                if (prev.some((l) => l.id === newLog.id)) return prev
                // 昇順維持のため logged_at で挿入位置を保つ（末尾追加後にソート）
                return [...prev, newLog].sort((a, b) =>
                  a.logged_at.localeCompare(b.logged_at),
                )
              })
            }
            if (isRelevantToCurrentWeek(newLog)) {
              setWeeklyLogs((prev) => {
                if (prev.some((l) => l.id === newLog.id)) return prev
                return [newLog, ...prev]
              })
            }
            // B-02: 前夜開始の overlap 睡眠は logged_at が選択日でないため下の logs
            // ガードで弾かれる。今日のまとめの按分入力として別 state に取り込む。
            if (isOverlapSleepFor(newLog, selectedDateRef.current)) {
              setOverlapLogs((prev) =>
                prev.some((l) => l.id === newLog.id)
                  ? prev
                  : [newLog, ...prev],
              )
            }
            if (toJstDateString(newLog.logged_at) !== selectedDateRef.current) {
              return
            }
            setLogs((prev) => {
              if (prev.some((l) => l.id === newLog.id)) return prev
              return [newLog, ...prev]
            })
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as BabyLogData
            if (updated.log_type === "growth") {
              setGrowthLogs((prev) => {
                const exists = prev.some((l) => l.id === updated.id)
                const next = exists
                  ? prev.map((l) => (l.id === updated.id ? updated : l))
                  : [...prev, updated]
                return next.sort((a, b) =>
                  a.logged_at.localeCompare(b.logged_at),
                )
              })
            }
            const belongsToWeek = isRelevantToCurrentWeek(updated)
            setWeeklyLogs((prev) => {
              const exists = prev.some((l) => l.id === updated.id)
              if (belongsToWeek && exists)
                return prev.map((l) => (l.id === updated.id ? updated : l))
              if (belongsToWeek && !exists) return [updated, ...prev]
              if (!belongsToWeek && exists)
                return prev.filter((l) => l.id !== updated.id)
              return prev
            })

            // B-01 フォールバックの同期: 前夜開始の未終了睡眠は選択日 logs に
            // 属さないため上下の分岐では扱われない。別端末で終了（ended_at 設定）
            // されたらクリアし、編集されたら追従させる。
            setServerActiveSleep((prev) => {
              if (!prev || prev.id !== updated.id) return prev
              return updated.ended_at ? null : updated
            })

            // B-02 overlap 睡眠の同期: 前夜開始の睡眠が終了（ended_at 設定）すると
            // 今日のまとめの按分入力に加わる。ended_at 解除・日付変更で範囲外へ出たら除く。
            // ここが「起こす」タップで今日のまとめが週間バーと同値になる live 経路。
            const belongsToOverlap = isOverlapSleepFor(
              updated,
              selectedDateRef.current,
            )
            setOverlapLogs((prev) => {
              const exists = prev.some((l) => l.id === updated.id)
              if (belongsToOverlap && exists)
                return prev.map((l) => (l.id === updated.id ? updated : l))
              if (belongsToOverlap && !exists) return [updated, ...prev]
              if (!belongsToOverlap && exists)
                return prev.filter((l) => l.id !== updated.id)
              return prev
            })

            const belongsToDate =
              toJstDateString(updated.logged_at) ===
              selectedDateRef.current
            setLogs((prev) => {
              const exists = prev.some((l) => l.id === updated.id)
              if (belongsToDate && exists)
                return prev.map((l) =>
                  l.id === updated.id ? updated : l,
                )
              if (belongsToDate && !exists) return [updated, ...prev]
              if (!belongsToDate && exists)
                return prev.filter((l) => l.id !== updated.id)
              return prev
            })
          } else if (payload.eventType === "DELETE") {
            const deleted = payload.old as { id: string }
            setLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setWeeklyLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setGrowthLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setOverlapLogs((prev) => prev.filter((l) => l.id !== deleted.id))
            setServerActiveSleep((prev) =>
              prev && prev.id === deleted.id ? null : prev,
            )
          }
        },
      )
      .subscribe((status, err) => {
        logRealtimeStatus("baby_logs", status, err)
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId])

  // Fetch logs when navigating to a different date (skip initial mount — initialLogs covers it)
  const initialDateRef = useRef(initialDate)
  useEffect(() => {
    if (selectedDate === initialDateRef.current) {
      initialDateRef.current = "" // allow re-fetch if user navigates away and back
      return
    }
    const supabase = createClient()
    const nextDay = shiftYmd(selectedDate, 1)
    const dayStart = `${selectedDate}T00:00:00+09:00`
    const abortController = new AbortController()

    supabase
      .from("baby_logs")
      .select(
        "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
      )
      .eq("household_id", householdId)
      .gte("logged_at", dayStart)
      .lt("logged_at", `${nextDay}T00:00:00+09:00`)
      .order("logged_at", { ascending: false })
      .abortSignal(abortController.signal)
      .then(({ data, error }) => {
        // 遷移離脱（abort）は成功/失敗いずれの分岐にも入れない。
        // 既存 AbortController 防御を保持し、離脱時の spurious toast を防ぐ。
        if (abortController.signal.aborted) return
        if (error) {
          // AUDIT-012: 従来は error を捨てて無言失敗していた（B-08）。
          logSupabaseError("baby", "date navigation fetch failed", error, {
            householdId,
            selectedDate,
          })
          toast.error("読み込みに失敗しました")
          return
        }
        if (data) {
          // H3-02: 無条件全置換だと in-flight 中に Realtime で先着した選択日の
          // 行が消える。id ベースの dedupe マージで先着行を保持する（B-08）。
          setLogs((prev) => mergeDateNavLogs(prev, data, selectedDate))
        }
      })

    // B-02: overlap 睡眠も選択日に合わせて refetch し、サーバ初回表示と窓を同一化する。
    // これを怠ると「過去日へ移動して今日へ戻る」往復で今日のまとめの睡眠分が経路依存で変動する。
    // 別 prop のため logs のマージ経路（mergeDateNavLogs / admission guard）は不変。
    supabase
      .from("baby_logs")
      .select(
        "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
      )
      .eq("household_id", householdId)
      .eq("log_type", "sleep")
      .lt("logged_at", dayStart)
      .gte("ended_at", dayStart)
      .order("logged_at", { ascending: false })
      .abortSignal(abortController.signal)
      .then(({ data, error }) => {
        if (abortController.signal.aborted) return
        if (error) {
          // logs 側の fetch が同時失敗時に toast を出すため、overlap 側は
          // 二重トースト回避で構造化ログのみ（握り潰しはしない）。
          logSupabaseError(
            "baby",
            "overlap sleep navigation fetch failed",
            error,
            { householdId, selectedDate },
          )
          return
        }
        if (data) setOverlapLogs(data)
      })

    return () => {
      abortController.abort()
    }
  }, [selectedDate, householdId])

  // Derive summary in a single pass
  // （B-01: 導出は純関数へ抽出。前夜開始の未終了睡眠は logs に現れないため
  //   サーバフォールバック serverActiveSleep で補完する）
  const { activeSleep, lastFeeding, derivedLastSleepEndedAt } = useMemo(
    () => deriveDashboardSummary(logs, serverActiveSleep),
    [logs, serverActiveSleep],
  )

  // 今日のまとめ: 選択日の logs に加え、前夜開始の overlap 睡眠を按分入力へ合流。
  // feeding/diaper は date フィルタ、sleep は当日窓へ按分され、週間/PDF と per-day 同値。
  const todayCounts = useMemo(
    () => summarizeTodayCounts([...logs, ...overlapLogs], selectedDate),
    [logs, overlapLogs, selectedDate],
  )

  // 成長曲線: 全期間の成長ログから体重/身長系列を組む
  const growthSeries = useMemo(
    () => buildGrowthSeries(growthLogs, "2000-01-01", today),
    [growthLogs, today],
  )

  // Today's logs-derived value takes priority (reactive to Realtime),
  // server prop is fallback for cross-day wakeup
  const effectiveLastSleepEndedAt = derivedLastSleepEndedAt ?? lastSleepEndedAt
  const weeklySummary = useMemo(
    () => buildBabyWeeklySummary(weeklyLogs, today),
    [weeklyLogs, today],
  )

  const handleEdit = useCallback((log: BabyLogData) => {
    setCreateLogType(null)
    setEditingLog(log)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  const handleCreateLog = useCallback((type: BabyLogType) => {
    setEditingLog(null)
    setCreateLogType(type)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  const handleStartTimer = useCallback((type: FeedingType) => {
    setTimerFeedingType(type)
    setTimerOpen(true)
  }, [])

  // endSleep 成功時の明示クリア（B-01）。UNIQUE index idx_one_active_sleep により
  // 未終了睡眠は高々 1 件ゆえ、どの睡眠を終了しても無条件クリアで正しい。
  // Realtime 不達（#92）でも fallback がトグルを「睡眠中」へ戻さないようにする。
  const handleSleepEnded = useCallback(() => {
    setServerActiveSleep(null)
  }, [])

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      <BabyAgeHeader
        babyName={babyName}
        babyBirthDate={babyBirthDate}
        referenceDate={today}
      />

      <BabyDateNav
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
      />

      <BabySummaryBar
        lastFeeding={lastFeeding}
        activeSleep={activeSleep}
        lastSleepEndedAt={effectiveLastSleepEndedAt}
        now={now}
        todayCounts={todayCounts}
      />

      {isToday && (
        <BabyQuickActions
          activeSleep={activeSleep}
          now={now}
          onCreateLog={handleCreateLog}
          onStartTimer={handleStartTimer}
          onSleepEnded={handleSleepEnded}
        />
      )}

      <BabyWeeklySummary days={weeklySummary} />

      <GrowthChartSection series={growthSeries} />

      <BabyTimeline logs={logs} onEdit={handleEdit} />

      <BabyLogFormSheet
        key={formKey}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        log={editingLog}
        createLogType={createLogType}
      />

      <FeedingTimer
        open={timerOpen}
        onOpenChange={setTimerOpen}
        initialFeedingType={timerFeedingType}
      />
    </div>
  )
}
