"use client"

import { useState } from "react"
import { Loader2, Trash2 } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { CalendarEventRecord } from "./use-month-events"

export interface CalendarEventFormValue {
  title: string
  memo: string | null
  isAllDay: boolean
  startDate: string
  endDate: string
  startTime: string // "HH:MM"(終日なら未使用)
  endTime: string
}

/** "YYYY-MM-DD" を "M月D日" へ(TZ 非依存の文字列分解)。 */
function dayLabelJa(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number)
  return `${m}月${d}日`
}

/**
 * Google read-only 詳細シートの日時行テキストを組み立てる。
 * - 終日単日: 「7月15日・終日」 / 終日多日: 「7月15日 〜 7月17日・終日」
 * - 時刻付き単日: 「7月15日 14:00〜15:00」(終了なしは「7月15日 14:00」)
 * - 時刻付き多日: 「7月15日 14:00〜7月17日 15:00」
 */
function googleWhenLabel(e: CalendarEventRecord): string {
  if (e.is_all_day) {
    const range =
      e.start_date === e.end_date
        ? dayLabelJa(e.start_date)
        : `${dayLabelJa(e.start_date)} 〜 ${dayLabelJa(e.end_date)}`
    return `${range}・終日`
  }
  const start = e.start_at
    ? `${dayLabelJa(e.start_date)} ${formatTimeJst(e.start_at)}`
    : dayLabelJa(e.start_date)
  if (!e.end_at) return start
  const end =
    e.start_date === e.end_date
      ? formatTimeJst(e.end_at)
      : `${dayLabelJa(e.end_date)} ${formatTimeJst(e.end_at)}`
  return `${start}〜${end}`
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = 新規、native = 編集、google = read-only 詳細 */
  editing: CalendarEventRecord | null
  defaultDate: string
  saving: boolean
  onSubmit: (value: CalendarEventFormValue) => void
  onDelete: (id: string) => void
}

function initialValue(
  editing: CalendarEventRecord | null,
  defaultDate: string,
): CalendarEventFormValue {
  if (editing) {
    return {
      title: editing.title,
      memo: editing.memo,
      isAllDay: editing.is_all_day,
      startDate: editing.start_date,
      endDate: editing.end_date,
      startTime: editing.start_at ? formatTimeJst(editing.start_at) : "09:00",
      endTime: editing.end_at ? formatTimeJst(editing.end_at) : "",
    }
  }
  return {
    title: "",
    memo: null,
    isAllDay: true,
    startDate: defaultDate,
    endDate: defaultDate,
    startTime: "09:00",
    endTime: "",
  }
}

export function CalendarEventFormSheet({
  open,
  onOpenChange,
  editing,
  defaultDate,
  saving,
  onSubmit,
  onDelete,
}: Props) {
  // open/editing 変化でフォームを初期化(render-time conditional setState)。
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const currentKey = open ? (editing?.id ?? `new:${defaultDate}`) : null
  const [value, setValue] = useState<CalendarEventFormValue>(() =>
    initialValue(editing, defaultDate),
  )
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (open) setValue(initialValue(editing, defaultDate))
  }

  const isGoogle = editing?.source === "google"
  const isEditing = !!editing

  const set = <K extends keyof CalendarEventFormValue>(
    k: K,
    v: CalendarEventFormValue[K],
  ) => setValue((prev) => ({ ...prev, [k]: v }))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl safe-bottom">
        <SheetHeader>
          <SheetTitle>
            {isGoogle ? "予定（Google）" : isEditing ? "予定を編集" : "予定を追加"}
          </SheetTitle>
          <SheetDescription>
            {isGoogle
              ? "Google カレンダーの予定は閲覧のみです"
              : "夫婦で共有する予定です"}
          </SheetDescription>
        </SheetHeader>

        {isGoogle ? (
          <div className="flex flex-col gap-2 py-4">
            <p className="text-base font-medium">{editing.title}</p>
            <p className="text-sm tabular-nums text-muted-foreground">
              {googleWhenLabel(editing)}
            </p>
            {editing.memo && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {editing.memo}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="cal-title">タイトル</Label>
              <Input
                id="cal-title"
                value={value.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="例: 検診、保育園見学"
                className="h-11"
                autoFocus
              />
            </div>

            <label className="flex min-h-11 items-center justify-between">
              <span className="text-sm font-medium">終日</span>
              <input
                type="checkbox"
                checked={value.isAllDay}
                onChange={(e) => set("isAllDay", e.target.checked)}
                className="size-5 accent-primary"
              />
            </label>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="cal-start-date">開始日</Label>
                <Input
                  id="cal-start-date"
                  type="date"
                  value={value.startDate}
                  onChange={(e) => set("startDate", e.target.value)}
                  className="h-11"
                />
              </div>
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="cal-end-date">終了日</Label>
                <Input
                  id="cal-end-date"
                  type="date"
                  value={value.endDate}
                  onChange={(e) => set("endDate", e.target.value)}
                  className="h-11"
                />
              </div>
            </div>

            {!value.isAllDay && (
              <div className="flex gap-3">
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="cal-start-time">開始時刻</Label>
                  <Input
                    id="cal-start-time"
                    type="time"
                    value={value.startTime}
                    onChange={(e) => set("startTime", e.target.value)}
                    className="h-11"
                  />
                </div>
                <div className="flex flex-1 flex-col gap-2">
                  <Label htmlFor="cal-end-time">終了時刻（任意）</Label>
                  <Input
                    id="cal-end-time"
                    type="time"
                    value={value.endTime}
                    onChange={(e) => set("endTime", e.target.value)}
                    className="h-11"
                  />
                </div>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cal-memo">メモ（任意）</Label>
              <Input
                id="cal-memo"
                value={value.memo ?? ""}
                onChange={(e) => set("memo", e.target.value || null)}
                placeholder="場所や持ち物など"
                className="h-11"
              />
            </div>
          </div>
        )}

        <SheetFooter className="flex-row gap-3">
          {isGoogle ? (
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="flex-1 cursor-pointer"
            >
              閉じる
            </Button>
          ) : (
            <>
              {isEditing && (
                <Button
                  variant="ghost"
                  onClick={() => onDelete(editing.id)}
                  disabled={saving}
                  aria-label="削除"
                  className="size-11 shrink-0 cursor-pointer text-destructive hover:text-destructive"
                >
                  <Trash2 size={18} />
                </Button>
              )}
              <Button
                onClick={() => onSubmit(value)}
                disabled={saving}
                className="flex-1 cursor-pointer"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : null}
                {isEditing ? "更新" : "追加"}
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
