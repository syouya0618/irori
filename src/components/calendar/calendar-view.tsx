"use client"

import { useState, useTransition } from "react"
import { ChevronLeft, ChevronRight, Plus } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { jstWallClockToIso } from "@/lib/utils/date-jst"
import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "@/app/(main)/calendar/actions"
import {
  useMonthEvents,
  OPTIMISTIC_EVENT_ID_PREFIX,
  type CalendarEventRecord,
} from "./use-month-events"
import { CalendarMonthView } from "./calendar-month-view"
import { CalendarAgenda } from "./calendar-agenda"
import {
  CalendarEventFormSheet,
  type CalendarEventFormValue,
} from "./calendar-event-form-sheet"

interface CalendarViewProps {
  initialEvents: CalendarEventRecord[]
  householdId: string
  initialMonthFirst: string
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
}: CalendarViewProps) {
  const m = useMonthEvents({ initialEvents, householdId, initialMonthFirst })
  const [pending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarEventRecord | null>(null)

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
    const startAt = v.isAllDay ? null : jstWallClockToIso(v.startDate, v.startTime)
    const endAt =
      v.isAllDay || !v.endTime ? null : jstWallClockToIso(v.endDate, v.endTime)
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
    // 日付/時刻が空だと toRecord の jstWallClockToIso が RangeError を投げ、
    // event handler の未捕捉例外で保存も toast も出ない無反応状態になる。
    // date/time input は required 無しでクリア可能なため、ここで明示的に弾く。
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
      })
    } else {
      // 新規: temp id で楽観挿入 → 成功で確定 id 差し替え / 失敗で除去
      const tempId = `${OPTIMISTIC_EVENT_ID_PREFIX}${optimisticSeq++}`
      const { record, startAt, endAt } = toRecord(v, tempId)
      m.upsertOptimistic(record)
      setSheetOpen(false)
      startTransition(async () => {
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
      })
    }
  }

  const handleDelete = (id: string) => {
    const snapshot = m.events.find((e) => e.id === id)
    m.removeOptimistic(id)
    setSheetOpen(false)
    startTransition(async () => {
      const res = await deleteCalendarEvent(id)
      if (res.error) {
        if (snapshot) m.upsertOptimistic(snapshot) // 復元
        toast.error(res.error)
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
      />
    </div>
  )
}
