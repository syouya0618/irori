"use client"

import { useState, useEffect, useMemo, useCallback, useRef } from "react"
import { createClient } from "@/lib/supabase/client"
import { BabyDateNav } from "./baby-date-nav"
import { BabySummaryBar } from "./baby-summary-bar"
import { BabyQuickActions } from "./baby-quick-actions"
import { BabyTimeline } from "./baby-timeline"
import { BabyLogFormSheet } from "./baby-log-form-sheet"
import { useNow } from "@/lib/hooks/use-now"
import { todayJstString, toJstDateString, shiftYmd } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

interface BabyDashboardProps {
  initialLogs: BabyLogData[]
  householdId: string
  userId: string
  initialDate: string
}

export function BabyDashboard({
  initialLogs,
  householdId,
  initialDate,
}: BabyDashboardProps) {
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<BabyLogData | null>(null)
  const now = useNow(60_000)

  const isToday = selectedDate === todayJstString()

  // Ref for selectedDate so Realtime callback sees the latest value
  const selectedDateRef = useRef(selectedDate)
  useEffect(() => {
    selectedDateRef.current = selectedDate
  }, [selectedDate])

  // Realtime subscription
  useEffect(() => {
    const supabase = createClient()

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
            if (toJstDateString(newLog.logged_at) !== selectedDateRef.current)
              return
            setLogs((prev) => {
              if (prev.some((l) => l.id === newLog.id)) return prev
              return [newLog, ...prev]
            })
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as BabyLogData
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
          }
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId])

  // Fetch logs when navigating to a different date
  useEffect(() => {
    const supabase = createClient()
    const nextDay = shiftYmd(selectedDate, 1)
    supabase
      .from("baby_logs")
      .select(
        "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, memo, created_at",
      )
      .eq("household_id", householdId)
      .gte("logged_at", `${selectedDate}T00:00:00+09:00`)
      .lt("logged_at", `${nextDay}T00:00:00+09:00`)
      .order("logged_at", { ascending: false })
      .then(({ data }) => {
        if (data) setLogs(data)
      })
  }, [selectedDate, householdId])

  // Derive summary in a single pass
  const { activeSleep, lastFeeding, diaperCount } = useMemo(() => {
    let activeSleep: BabyLogData | undefined
    let lastFeeding: BabyLogData | undefined
    let diaperCount = 0
    for (const l of logs) {
      if (!activeSleep && l.log_type === "sleep" && !l.ended_at)
        activeSleep = l
      if (!lastFeeding && l.log_type === "feeding") lastFeeding = l
      if (l.log_type === "diaper") diaperCount++
    }
    return { activeSleep: activeSleep ?? null, lastFeeding, diaperCount }
  }, [logs])

  const handleEdit = useCallback((log: BabyLogData) => {
    setEditingLog(log)
    setSheetOpen(true)
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
        now={now}
      />

      {isToday && (
        <BabyQuickActions activeSleep={activeSleep} now={now} />
      )}

      <BabyTimeline logs={logs} onEdit={handleEdit} />

      <BabyLogFormSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        log={editingLog}
      />
    </div>
  )
}
