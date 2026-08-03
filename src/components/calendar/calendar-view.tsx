"use client"

import { useState, useTransition } from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
// 送信値(start_at/end_at)の導出はシートの保存前検証と同じ関数を使い、
// 「検証した値」と「送る値」がずれないようにする。
import {
  formValueToTimestamps,
  type CalendarEventFormValue,
} from "@/lib/domain/calendar-form"
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarEventSeries,
  fetchGoogleSyncSignal,
} from "@/app/(main)/calendar/actions"
// startTransition 内の未処理 reject は error boundary へ bubble する（offline-error.ts）。
// 楽観挿入/削除を持つため、reject 経路でも result.error と同じ巻き戻しを行う。
import { toastOfflineError } from "@/lib/utils/offline-error"
import {
  useMonthEvents,
  OPTIMISTIC_EVENT_ID_PREFIX,
  type CalendarEventRecord,
} from "./use-month-events"
import { CalendarMonthView } from "./calendar-month-view"
import { CalendarAgenda } from "./calendar-agenda"
import { CalendarEventFormSheet } from "./calendar-event-form-sheet"
import { useGoogleSyncPoll } from "./use-google-sync-poll"

interface CalendarViewProps {
  initialEvents: CalendarEventRecord[]
  householdId: string
  initialMonthFirst: string
  /**
   * V7: サーバが `after()` で Google 同期を予約したか。
   * true のときだけ `last_synced_at` を数回ポーリングして前進を待つ。
   */
  syncScheduled?: boolean
  /** 予約時点の `last_synced_at`（ポーリングの基準値）。 */
  initialGoogleSyncedAt?: string | null
}

/** "YYYY-MM" を "YYYY年M月" へ */
function monthTitle(monthFirst: string): string {
  const [y, m] = monthFirst.split("-")
  return `${y}年${Number(m)}月`
}

/** "YYYY-MM-DD" を "M月D日" へ */
function dayLabel(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number)
  return `${m}月${d}日`
}

let optimisticSeq = 0

export function CalendarView({
  initialEvents,
  householdId,
  initialMonthFirst,
  syncScheduled = false,
  initialGoogleSyncedAt = null,
}: CalendarViewProps) {
  const m = useMonthEvents({ initialEvents, householdId, initialMonthFirst })
  const [pending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarEventRecord | null>(null)

  // V7: Google 同期の完了を拾う（Realtime を使わぬ唯一の削除反映経路）。
  useGoogleSyncPoll({
    enabled: syncScheduled,
    baseline: initialGoogleSyncedAt,
    fetchSignal: fetchGoogleSyncSignal,
    onAdvanced: () => {
      void m.refetch(m.monthFirst)
    },
  })

  const openNew = () => {
    setEditing(null)
    setSheetOpen(true)
  }
  const openEvent = (event: CalendarEventRecord) => {
    setEditing(event)
    setSheetOpen(true)
  }

  /** フォーム値を action 入力 + 楽観行へ変換 */
  function toRecord(
    v: CalendarEventFormValue,
    id: string,
  ): { record: CalendarEventRecord; startAt: string | null; endAt: string | null } {
    const { startAt, endAt } = formValueToTimestamps(v)
    return {
      record: {
        id,
        title: v.title.trim(),
        memo: v.memo,
        is_all_day: v.isAllDay,
        start_date: v.startDate,
        end_date: v.endDate,
        start_at: startAt,
        end_at: endAt,
        source: "native",
        series_id: null,
      },
      startAt,
      endAt,
    }
  }

  const handleSubmit = (v: CalendarEventFormValue) => {
    if (!v.title.trim()) {
      toast.error("タイトルを入力してください")
      return
    }
    // 以下 3 つはシート側の保存前検証(validateCalendarFormValue)で先に弾かれるが、
    // onSubmit を呼ぶ他経路・将来の変更に対する二重防御として残す。
    // 元々は toRecord の jstWallClockToIso が空値で RangeError を投げ、event handler の
    // 未捕捉例外で「保存も toast も出ない無反応」になる経路の防御だった(現在は
    // formValueToTimestamps が null へ倒すため throw はしないが、null のまま送ると
    // サーバー往復で弾かれるため手元の toast に倒す)。
    if (!v.startDate || !v.endDate) {
      toast.error("日付を入力してください")
      return
    }
    if (!v.isAllDay && !v.startTime) {
      toast.error("開始時刻を入力してください")
      return
    }
    const editingSnapshot = editing
    if (editingSnapshot) {
      // 編集: 楽観置換 → 失敗で復元
      const { record, startAt, endAt } = toRecord(v, editingSnapshot.id)
      m.upsertOptimistic(record)
      setSheetOpen(false)
      startTransition(async () => {
        try {
          const res = await updateCalendarEvent({
            id: editingSnapshot.id,
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
          })
          if (res.error) {
            m.upsertOptimistic(editingSnapshot) // 復元
            toast.error(res.error)
          }
        } catch (err) {
          // reject はサーバー未到達 = 確実に未更新。楽観置換を元へ戻す。
          m.upsertOptimistic(editingSnapshot) // 復元
          toastOfflineError("[calendar-view] updateCalendarEvent", err)
        }
      })
    } else if (v.repeat !== "none") {
      // 繰り返し作成: 複数行 materialize の楽観再現はコストに見合わないため楽観挿入を
      // スキップし、action 成功後に refetch(use-month-events の既存 refetch)。
      const { startAt, endAt } = toRecord(v, "recurring")
      setSheetOpen(false)
      startTransition(async () => {
        try {
          const res = await createCalendarEvent({
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
            repeat: v.repeat,
            repeatUntil: v.repeatUntil,
          })
          if (res.error) {
            toast.error(res.error)
          } else {
            void m.refetch(m.monthFirst)
          }
        } catch (err) {
          // この分岐だけは楽観挿入をしていない（上のコメント参照）ため巻き戻し不要。
          toastOfflineError("[calendar-view] createCalendarEvent(repeat)", err)
        }
      })
    } else {
      // 新規: temp id で楽観挿入 → 成功で確定 id 差し替え / 失敗で除去
      const tempId = `${OPTIMISTIC_EVENT_ID_PREFIX}${optimisticSeq++}`
      const { record, startAt, endAt } = toRecord(v, tempId)
      m.upsertOptimistic(record)
      setSheetOpen(false)
      startTransition(async () => {
        try {
          const res = await createCalendarEvent({
            title: v.title,
            memo: v.memo,
            isAllDay: v.isAllDay,
            startDate: v.startDate,
            endDate: v.endDate,
            startAt,
            endAt,
          })
          if (res.error || !("eventId" in res) || !res.eventId) {
            m.removeOptimistic(tempId)
            toast.error(res.error ?? "予定の作成に失敗しました。")
          } else {
            m.replaceOptimisticId(tempId, res.eventId)
          }
        } catch (err) {
          // reject はサーバー未到達 = 予定は作られていない。temp 行を残すと
          // 確定 id を持たない幽霊が居座るため必ず除去する。
          m.removeOptimistic(tempId)
          toastOfflineError("[calendar-view] createCalendarEvent", err)
        }
      })
    }
  }

  const handleDelete = (id: string) => {
    const snapshot = m.events.find((e) => e.id === id)
    m.removeOptimistic(id)
    setSheetOpen(false)
    startTransition(async () => {
      try {
        const res = await deleteCalendarEvent(id)
        if (res.error) {
          if (snapshot) m.upsertOptimistic(snapshot) // 復元
          toast.error(res.error)
        }
      } catch (err) {
        // reject はサーバー未到達 = 予定は残っている。復元しないと
        // 「消えたはずの予定が復帰で蘇る」不整合になる。
        if (snapshot) m.upsertOptimistic(snapshot) // 復元
        toastOfflineError("[calendar-view] deleteCalendarEvent", err)
      }
    })
  }

  // シリーズ一括削除: 楽観的に同 series_id の行を全除去 → 失敗でスナップショット復元。
  // 単発削除(単一 id 除去)と違い複数行を消すため setAllEvents で一括置換する。
  const handleDeleteSeries = (seriesId: string) => {
    const snapshot = m.events
    m.setAllEvents(m.events.filter((e) => e.series_id !== seriesId))
    setSheetOpen(false)
    startTransition(async () => {
      try {
        const res = await deleteCalendarEventSeries(seriesId)
        if (res.error) {
          m.setAllEvents(snapshot) // 復元
          toast.error(res.error)
        }
      } catch (err) {
        // reject はサーバー未到達 = シリーズは残っている。一括除去を巻き戻す。
        m.setAllEvents(snapshot) // 復元
        toastOfflineError("[calendar-view] deleteCalendarEventSeries", err)
      }
    })
  }

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      {/* 月ナビ */}
      <div className="glass flex items-center justify-between rounded-2xl px-2 py-1.5 shadow-lg shadow-black/[0.04]">
        <Button
          variant="ghost"
          onClick={m.goPrevMonth}
          aria-label="前の月"
          className="size-11 cursor-pointer"
        >
          <ChevronLeft size={20} />
        </Button>
        <div className="flex items-center gap-3">
          <span className="text-base font-semibold tabular-nums">
            {monthTitle(m.monthFirst)}
          </span>
          {!m.isCurrentMonth && (
            <button
              type="button"
              onClick={m.goToday}
              className="rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors duration-200 hover:bg-primary/20 dark:bg-primary/20"
            >
              今日
            </button>
          )}
        </div>
        <Button
          variant="ghost"
          onClick={m.goNextMonth}
          aria-label="次の月"
          className="size-11 cursor-pointer"
        >
          <ChevronRight size={20} />
        </Button>
      </div>

      <CalendarMonthView
        grid={m.grid}
        eventsByDate={m.eventsByDate}
        selectedDate={m.selectedDate}
        onSelectDate={m.setSelectedDate}
      />

      <CalendarAgenda
        dateLabel={dayLabel(m.selectedDate)}
        events={m.selectedEvents}
        selectedDate={m.selectedDate}
        onTapEvent={openEvent}
      />

      {/* FAB(親指圏) */}
      <Button
        onClick={openNew}
        aria-label="予定を追加"
        className="fixed right-5 bottom-24 z-10 size-14 rounded-full shadow-lg"
      >
        <Plus size={24} />
      </Button>

      <CalendarEventFormSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        editing={editing}
        defaultDate={m.selectedDate}
        saving={pending}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
        onDeleteSeries={handleDeleteSeries}
      />
    </div>
  )
}
