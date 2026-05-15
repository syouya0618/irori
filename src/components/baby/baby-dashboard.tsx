"use client"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { BabyDateNav } from "./baby-date-nav"
import { BabySummaryBar } from "./baby-summary-bar"
import { BabyQuickActions } from "./baby-quick-actions"
import { BabyTimeline } from "./baby-timeline"
import { BabyLogFormSheet } from "./baby-log-form-sheet"
import { FeedingTimer } from "./feeding-timer"
import { BabyWeeklySummary } from "./weekly-summary/baby-weekly-summary"
import { useNow } from "@/lib/hooks/use-now"
import { todayJstString, toJstDateString, shiftYmd } from "@/lib/utils/date-jst"
import { buildBabyWeeklySummary } from "@/lib/domain/baby-weekly-summary"
import type { BabyLogData } from "@/lib/types/baby"
import type { BabyLogType, FeedingType } from "@/lib/types/database"

interface BabyDashboardProps {
  initialLogs: BabyLogData[]
  initialWeeklyLogs: BabyLogData[]
  householdId: string
  userId: string
  initialDate: string
  lastSleepEndedAt: string | null
}

export function BabyDashboard({
  initialLogs,
  initialWeeklyLogs,
  householdId,
  initialDate,
  lastSleepEndedAt,
}: BabyDashboardProps) {
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  const [weeklyLogs, setWeeklyLogs] =
    useState<BabyLogData[]>(initialWeeklyLogs)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<BabyLogData | null>(null)
  const [createLogType, setCreateLogType] = useState<BabyLogType | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [timerOpen, setTimerOpen] = useState(false)
  const [timerFeedingType, setTimerFeedingType] = useState<FeedingType>("breast_left")
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
          if (payload.eventType === "INSERT") {
            const newLog = payload.new as BabyLogData
            if (isRelevantToCurrentWeek(newLog)) {
              setWeeklyLogs((prev) => {
                if (prev.some((l) => l.id === newLog.id)) return prev
                return [newLog, ...prev]
              })
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
          }
        },
      )
      .subscribe()

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
    const abortController = new AbortController()

    supabase
      .from("baby_logs")
      .select(
        "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, memo, created_at",
      )
      .eq("household_id", householdId)
      .gte("logged_at", `${selectedDate}T00:00:00+09:00`)
      .lt("logged_at", `${nextDay}T00:00:00+09:00`)
      .order("logged_at", { ascending: false })
      .abortSignal(abortController.signal)
      .then(({ data }) => {
        if (!abortController.signal.aborted && data) setLogs(data)
      })

    return () => {
      abortController.abort()
    }
  }, [selectedDate, householdId])

  // Derive summary in a single pass
  const { activeSleep, lastFeeding, diaperCount, derivedLastSleepEndedAt } =
    useMemo(() => {
      let activeSleep: BabyLogData | undefined
      let lastFeeding: BabyLogData | undefined
      let derivedLastSleepEndedAt: string | null = null
      let diaperCount = 0
      for (const l of logs) {
        if (!activeSleep && l.log_type === "sleep" && !l.ended_at)
          activeSleep = l
        if (
          !derivedLastSleepEndedAt &&
          l.log_type === "sleep" &&
          l.ended_at
        )
          derivedLastSleepEndedAt = l.ended_at
        if (!lastFeeding && l.log_type === "feeding") lastFeeding = l
        if (l.log_type === "diaper") diaperCount++
      }
      return {
        activeSleep: activeSleep ?? null,
        lastFeeding,
        diaperCount,
        derivedLastSleepEndedAt,
      }
    }, [logs])

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

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      <BabyDateNav
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
      />

      <BabySummaryBar
        lastFeeding={lastFeeding ?? null}
        diaperCount={diaperCount}
        activeSleep={activeSleep}
        lastSleepEndedAt={effectiveLastSleepEndedAt}
        now={now}
      />

      {isToday && (
        <BabyQuickActions
          activeSleep={activeSleep}
          now={now}
          onCreateLog={handleCreateLog}
          onStartTimer={handleStartTimer}
        />
      )}

      <BabyWeeklySummary days={weeklySummary} />

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
