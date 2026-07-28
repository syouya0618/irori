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
import { BabyDailyDiary } from "./baby-daily-diary"
import { BabyDiaryEditSheet } from "./baby-diary-edit-sheet"
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
  aggregateDiapers,
  sumDiaperBreakdown,
} from "@/lib/domain/baby-log-aggregation"
import { findLastPumped } from "@/lib/domain/baby-pumping"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import type { BabyLogData, BabyDiaryData } from "@/lib/types/baby"
import type { BabyLogType, FeedingType } from "@/lib/types/database"

interface BabyDashboardProps {
  initialLogs: BabyLogData[]
  initialWeeklyLogs: BabyLogData[]
  initialGrowthLogs: BabyLogData[]
  householdId: string
  userId: string
  initialDate: string
  /** 今日の育児日記（1日1本・無ければ null）。選択日変更時は refetch で入れ替える。 */
  initialDiary: BabyDiaryData | null
  /**
   * 今日より前の最後の授乳（批判レビュー P3）。深夜跨ぎサイクル（開始時刻が前日）は
   * 今日窓の logs に現れないため、当日に授乳が無い間の「最終授乳」表示を補完する。
   * isToday の時のみ使う（過去日のまとめへ漏らすと別日の時刻を表示してしまう）。
   */
  lastFeedingFallback: BabyLogData | null
  babyName: string | null
  babyBirthDate: string | null
  /** 搾乳間隔（分）。次の搾乳の目安の算出に使う（設定で変更可能） */
  pumpingIntervalMin: number
}

export function BabyDashboard({
  initialLogs,
  initialWeeklyLogs,
  initialGrowthLogs,
  householdId,
  userId,
  initialDate,
  initialDiary,
  lastFeedingFallback,
  babyName,
  babyBirthDate,
  pumpingIntervalMin,
}: BabyDashboardProps) {
  const [logs, setLogs] = useState<BabyLogData[]>(initialLogs)
  const [weeklyLogs, setWeeklyLogs] =
    useState<BabyLogData[]>(initialWeeklyLogs)
  const [growthLogs, setGrowthLogs] =
    useState<BabyLogData[]>(initialGrowthLogs)
  const [selectedDate, setSelectedDate] = useState(initialDate)
  // 選択日の育児日記（1日1本）。日付変更で refetch、保存/削除は編集シートから反映。
  const [diary, setDiary] = useState<BabyDiaryData | null>(initialDiary)
  const [diaryEditOpen, setDiaryEditOpen] = useState(false)
  const [diaryKey, setDiaryKey] = useState(0)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editingLog, setEditingLog] = useState<BabyLogData | null>(null)
  const [createLogType, setCreateLogType] = useState<BabyLogType | null>(null)
  // 搾乳など量ベースの授乳を create シートで開く際の初期授乳タイプ（B: 搾乳導線）
  const [createFeedingType, setCreateFeedingType] =
    useState<FeedingType | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [timerOpen, setTimerOpen] = useState(false)
  const [timerFeedingType, setTimerFeedingType] = useState<FeedingType>("breast_left")
  // 「今日より前の最後の授乳」フォールバック（P3）。state 保持にするのは、深夜跨ぎ
  // サイクルの記録直後（timeline へは入場できない）に FeedingTimer からこの値を
  // 即時更新するため（さもなくばリロードまで最終授乳が旧値/「---」に留まる）。
  const [serverLastFeeding, setServerLastFeeding] =
    useState<BabyLogData | null>(lastFeedingFallback)
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
      return (
        logDate >= weeklyStartDateRef.current && logDate <= todayRef.current
      )
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

  // 育児日記（1日1本）の Realtime 購読（issue #155）。baby_logs とは別 channel で
  // 分離し、購読ブロックの blast radius を最小化する。
  // INSERT/UPDATE のみ反映する: household_id フィルタ付き購読では DELETE の old が
  // PK のみで配信されない（migration 20260723000001 / calendar_events と同制約）。
  // DELETE（配偶者の空保存）は date-nav refetch と下の visibilitychange refetch で回収する。
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel("baby_diaries")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "baby_diaries",
          filter: `household_id=eq.${householdId}`,
        },
        (payload) => {
          logRealtimeEvent("baby_diaries", payload)
          if (
            payload.eventType === "INSERT" ||
            payload.eventType === "UPDATE"
          ) {
            const next = payload.new as BabyDiaryData
            // 選択日と一致する日記だけ反映する（selectedDate は deps 外のため ref 読み）。
            // diary_date は DATE 列で Realtime は "YYYY-MM-DD" を配信するが、万一
            // 時刻付き（"...T00:00:00"）で来ても guard が silent 全滅しないよう
            // 先頭10文字で比較する（mock では検出不能な wire フォーマット境界の保険。
            // DATE 列ゆえ toJstDateString の timestamptz 変換は使わない）。
            // `?.` は diary_date 欠落の payload（本番の channel 分離下では届かないが
            // 防御）を安全に no-op にする。
            if (next.diary_date?.slice(0, 10) !== selectedDateRef.current) return
            setDiary(next)
          }
          // DELETE は配信されない（上記）。refetch 経路で回収する。
        },
      )
      .subscribe((status, err) => {
        logRealtimeStatus("baby_diaries", status, err)
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [householdId])

  // タブ復帰時に選択日の日記を再取得し、DELETE 非配信（配偶者の空保存）を回収する
  // （calendar use-month-events と同流儀。issue #91/#92/#155）。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return
      const supabase = createClient()
      const date = selectedDateRef.current
      void supabase
        .from("baby_diaries")
        .select("id, diary_date, content, updated_at")
        .eq("household_id", householdId)
        .eq("diary_date", date)
        .maybeSingle()
        .then(({ data, error }) => {
          if (error) {
            logSupabaseError("baby", "diary visibility refetch failed", error, {
              householdId,
              date,
            })
            // 同一日の取り直しゆえ、失敗時は現在の本文を保持する（date-nav の
            // fail-to-empty とは異なり cross-date stale の危険が無い）。
            return
          }
          // refetch 中に日付が変わっていたら反映しない（往復中の stale 反映防止）。
          if (selectedDateRef.current !== date) return
          setDiary(data ?? null)
        })
    }
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("focus", onVisible)
    return () => {
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("focus", onVisible)
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
      .select(BABY_LOG_COLUMNS)
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

    // 育児日記（1日1本）も選択日に合わせて refetch する。無い日は正常系（maybeSingle）。
    supabase
      .from("baby_diaries")
      .select("id, diary_date, content, updated_at")
      .eq("household_id", householdId)
      .eq("diary_date", selectedDate)
      .abortSignal(abortController.signal)
      .maybeSingle()
      .then(({ data, error }) => {
        if (abortController.signal.aborted) return
        if (error) {
          // logs 側の fetch が同時失敗時に toast を出すため、日記側は
          // 二重トースト回避で構造化ログのみ（握り潰しはしない）。
          logSupabaseError("baby", "diary navigation fetch failed", error, {
            householdId,
            selectedDate,
          })
          // logs の「stale 保持」流儀とあえて変えて fail-to-empty に倒す:
          // 前の日の本文が選択日の日記として残ると、タップ→保存で「前日の本文を
          // 別日として upsert する」事故経路になるため（レビュー W-1）。
          setDiary(null)
          return
        }
        setDiary(data ?? null)
      })

    return () => {
      abortController.abort()
    }
  }, [selectedDate, householdId])

  // Derive summary in a single pass
  // （導出は純関数へ抽出。P3: 深夜跨ぎサイクルは前日行になり logs に現れないため
  //   serverLastFeeding で補完する。ただし今日表示の時のみ。過去日は「その日の授乳」
  //   を表示する契約ゆえ、別日の fallback を混ぜると過去日のまとめに嘘の時刻が出る）
  const { lastFeeding } = useMemo(
    () => deriveDashboardSummary(logs, isToday ? serverLastFeeding : null),
    [logs, serverLastFeeding, isToday],
  )

  // 次の搾乳の目安: 選択日の logs から最後の搾乳を導出（サマリバーで isToday 時のみ表示）
  const lastPumped = useMemo(() => findLastPumped(logs), [logs])

  // 今日のまとめ: 選択日の logs を date フィルタで集計する（週間/PDF と per-day 同値）。
  const todayCounts = useMemo(
    () => summarizeTodayCounts(logs, selectedDate),
    [logs, selectedDate],
  )

  // 成長曲線: 全期間の成長ログから体重/身長系列を組む
  const growthSeries = useMemo(
    () => buildGrowthSeries(growthLogs, "2000-01-01", today),
    [growthLogs, today],
  )

  const weeklySummary = useMemo(
    () => buildBabyWeeklySummary(weeklyLogs, today),
    [weeklyLogs, today],
  )

  // 週間のおしっこ/うんち内訳: aggregateDiapers（PDF と同じ日別集計）の出力から
  // pee+both / poop+both を導出する（weeklyLogs は weeklyStartDate〜today のクエリ窓）。
  const weeklyDiaperBreakdown = useMemo(
    () =>
      sumDiaperBreakdown(
        aggregateDiapers(weeklyLogs, weeklyStartDate, today),
      ),
    [weeklyLogs, weeklyStartDate, today],
  )

  const handleEdit = useCallback((log: BabyLogData) => {
    setCreateLogType(null)
    setCreateFeedingType(null)
    setEditingLog(log)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  const handleCreateLog = useCallback((type: BabyLogType) => {
    setEditingLog(null)
    setCreateLogType(type)
    // feeding 以外の create では前回の搾乳導線の残りを持ち越さない
    setCreateFeedingType(null)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  // 搾乳など量ベースの授乳を create シートで記録する導線（母乳のタイマーとは別）
  const handleCreateFeeding = useCallback((type: FeedingType) => {
    setEditingLog(null)
    setCreateLogType("feeding")
    setCreateFeedingType(type)
    setFormKey((k) => k + 1)
    setSheetOpen(true)
  }, [])

  const handleStartTimer = useCallback((type: FeedingType) => {
    setTimerFeedingType(type)
    setTimerOpen(true)
  }, [])

  // B-03: 記録系 Server Action の成功時に、返却 id で組んだ楽観ログを logs へ前置きする。
  // 既存 Realtime INSERT ハンドラ（上）と同じ id 重複ガードを持たせ、echo が後追いで
  // 届いても二重 append しない（同 id INSERT はスキップされる）。
  // 楽観 append が正しいのは記録導線が全て isToday ゲート下にあるからこそ
  // （F-03 過去日クイック記録の解禁時は要再検討 — baby-optimistic-log.ts の注記参照）。
  const appendLog = useCallback((log: BabyLogData) => {
    setLogs((prev) => (prev.some((l) => l.id === log.id) ? prev : [log, ...prev]))
  }, [])

  // B-03: Undo（quick actions の取り消し）・削除の成功時にローカル state から除去する。
  // Realtime DELETE echo が後追いで来ても filter は冪等ゆえ二重除去にならない。
  const removeLog = useCallback((id: string) => {
    setLogs((prev) => prev.filter((l) => l.id !== id))
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
        lastPumped={lastPumped}
        pumpingIntervalMin={pumpingIntervalMin}
        now={now}
        todayCounts={todayCounts}
        date={selectedDate}
      />

      {isToday && (
        <BabyQuickActions
          userId={userId}
          onCreateLog={handleCreateLog}
          onCreateFeeding={handleCreateFeeding}
          onStartTimer={handleStartTimer}
          onLogRecorded={appendLog}
          onLogRemoved={removeLog}
        />
      )}

      <BabyWeeklySummary
        days={weeklySummary}
        diaperBreakdown={weeklyDiaperBreakdown}
      />

      <GrowthChartSection series={growthSeries} />

      <BabyTimeline logs={logs} onEdit={handleEdit} />

      {/* その日の育児日記（1日1本・ぴよログ流）。日末に全文を常時表示する。
          /baby/diary への導線はセクションヘッダの「すべて」に集約（旧 Link カード廃止）。 */}
      <BabyDailyDiary
        diary={diary}
        isToday={isToday}
        onEdit={() => {
          setDiaryKey((k) => k + 1)
          setDiaryEditOpen(true)
        }}
      />

      <BabyDiaryEditSheet
        key={diaryKey}
        open={diaryEditOpen}
        onOpenChange={setDiaryEditOpen}
        diaryDate={selectedDate}
        initialContent={diary?.content ?? ""}
        onSaved={setDiary}
      />

      <BabyLogFormSheet
        key={formKey}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        log={editingLog}
        createLogType={createLogType}
        createFeedingType={createFeedingType}
        userId={userId}
        onLogRecorded={appendLog}
        onLogRemoved={removeLog}
      />

      <FeedingTimer
        open={timerOpen}
        onOpenChange={setTimerOpen}
        initialFeedingType={timerFeedingType}
        userId={userId}
        onLogRecorded={appendLog}
        onPrevDayLogRecorded={(log) =>
          // 深夜跨ぎサイクル（前日行）は timeline へ入れず、最終授乳 fallback のみ
          // 即時更新する（P3）。より新しい既存 fallback を古い行で上書きしない防御付き
          // （実運用では新記録が常に最新だが、比較は epoch で行い表記混在に耐える）。
          setServerLastFeeding((prev) =>
            prev &&
            new Date(prev.logged_at).getTime() >
              new Date(log.logged_at).getTime()
              ? prev
              : log,
          )
        }
      />
    </div>
  )
}
