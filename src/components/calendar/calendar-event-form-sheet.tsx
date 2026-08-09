"use client"

import { useState } from "react"
import { AlertCircle, Loader2, Trash2 } from "lucide-react"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatTimeJst } from "@/lib/utils/date-jst"
import { segmentCn } from "@/lib/utils/segment-cn"
import type {
  CalendarEventField,
  CalendarRepeat,
} from "@/lib/domain/calendar-validation"
import {
  applyStartDateShift,
  formValueToTimestamps,
  validateCalendarFormValue,
  type CalendarEventFormValue,
} from "@/lib/domain/calendar-form"
import {
  REMINDER_OPTIONS,
  deriveRemindAtIso,
  formatRemindAtLabel,
  type ReminderChoice,
  type ReminderState,
} from "@/lib/domain/event-reminder"
import type { CalendarEventRecord } from "./use-month-events"

// フォーム値の型は中立モジュール（calendar-form.ts）が正本。既存の import 元を
// 保つため型のみ再 export する（import type はビルド時に消えるため安全）。
export type { CalendarEventFormValue }

/** 新規/クリア時の既定開始時刻。initialValue と時刻クリアで共有し値のドリフトを防ぐ。 */
const DEFAULT_START_TIME = "09:00"

/** 繰り返し select の選択肢(base-ui Select の items = ラベル解決に使う)。 */
const REPEAT_OPTIONS: { value: CalendarRepeat; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "daily", label: "毎日" },
  { value: "weekly", label: "毎週" },
  { value: "monthly", label: "毎月" },
]

/** 新規作成時の繰り返し終了日の既定 = 開始日 + N ヶ月。 */
const DEFAULT_REPEAT_UNTIL_MONTHS = 3

/**
 * "YYYY-MM-DD" を月数シフトする(TZ 非依存。Date.UTC で overflow を正規化)。
 * 繰り返し終了日の既定値算出にのみ使う(UTC 罠を避けるため new Date(str) は使わない)。
 */
function addMonthsYmd(ymd: string, months: number): string {
  const [y, m, d] = ymd.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10)
}

/** エラー文言の DOM id。aria-describedby で不正な入力と紐付ける。 */
const ERROR_MESSAGE_ID = "cal-form-error"

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
  /** 繰り返しシリーズ全体を削除する(series_id を持つ予定の編集時のみ使う)。 */
  onDeleteSeries: (seriesId: string) => void
  /**
   * 通知設定の状態(B-2)。`loading` は既存予定を開いた直後の読み込み中。
   * 省略時は「なし」(未指定でも壊れぬよう既定を持たせる)。
   */
  reminder?: ReminderState
  /** 通知設定が変わった。新規予定では親が値を保持し、作成後に書き込む。 */
  onReminderChange?: (choice: ReminderChoice) => void
}

/**
 * 「通知」Select。**google 由来の read-only 詳細シートでも操作可**にするのが要点じゃ
 * (主の予定の多くは source='google' で、そこへ通知を付けられねば機能が半分しか働かぬ)。
 * 本文が read-only なのは `calendar_events` の UPDATE ポリシーが native 限定ゆえで、
 * 通知は**別テーブル**に出してあるためこの制約を受けぬ。
 */
function ReminderField({
  state,
  onChange,
  disabled,
  when,
}: {
  state: ReminderState
  onChange: (choice: ReminderChoice) => void
  disabled: boolean
  /** 予定の起点(通知時刻の予告に使う)。 */
  when: { isAllDay: boolean; startDate: string; startAt: string | null }
}) {
  const loading = state.status === "loading"
  const unsupported = state.status === "unsupported"
  const choice: ReminderChoice = state.status === "ready" ? state.choice : "none"

  // 予告は表示専用。真値は DB のトリガが導出する(ずれれば pgTAP と vitest が割れる)。
  const remindAt =
    state.status === "ready" ? deriveRemindAtIso(when, choice) : null
  const remindLabel = remindAt ? formatRemindAtLabel(remindAt) : null

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="cal-reminder">通知</Label>
      <Select
        items={REMINDER_OPTIONS}
        value={choice}
        onValueChange={(v) => onChange(v as ReminderChoice)}
        disabled={disabled || loading || unsupported}
      >
        <SelectTrigger id="cal-reminder" className="h-11 w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REMINDER_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 状態は文言で出す(色だけに頼らぬ)。 */}
      {loading && (
        <p className="text-xs text-muted-foreground">通知設定を読み込み中…</p>
      )}
      {unsupported && (
        <p className="text-xs text-muted-foreground">
          この予定には、このアプリがまだ知らない通知設定が入っています。誤って消さない
          よう変更できません。
        </p>
      )}
      {!loading && !unsupported && remindLabel && (
        <p className="text-xs tabular-nums text-muted-foreground">
          {remindLabel} に通知します
        </p>
      )}
    </div>
  )
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
      startTime: editing.start_at
        ? formatTimeJst(editing.start_at)
        : DEFAULT_START_TIME,
      endTime: editing.end_at ? formatTimeJst(editing.end_at) : "",
      // 編集モードは繰り返し変更をスコープ外とするため常に "none"。
      repeat: "none",
      repeatUntil: "",
    }
  }
  return {
    title: "",
    memo: null,
    isAllDay: true,
    startDate: defaultDate,
    endDate: defaultDate,
    startTime: DEFAULT_START_TIME,
    endTime: "",
    repeat: "none",
    repeatUntil: "",
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
  onDeleteSeries,
  reminder = { status: "ready", choice: "none" },
  onReminderChange,
}: Props) {
  // open/editing 変化でフォームを初期化(render-time conditional setState)。
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const currentKey = open ? (editing?.id ?? `new:${defaultDate}`) : null
  const [value, setValue] = useState<CalendarEventFormValue>(() =>
    initialValue(editing, defaultDate),
  )
  // 保存前検証で弾かれた内容(文言 + 該当項目)。null = エラーなし。
  const [error, setError] = useState<{
    message: string
    field: CalendarEventField
  } | null>(null)
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (open) {
      setValue(initialValue(editing, defaultDate))
      setError(null) // 前回の失敗を新しいフォームへ持ち越さない
    }
  }

  const isGoogle = editing?.source === "google"
  const isEditing = !!editing

  // 値を編集したらエラー表示は消す(修正中に赤いままにしない)。
  const update = (
    next: (prev: CalendarEventFormValue) => CalendarEventFormValue,
  ) => {
    setValue(next)
    setError(null)
  }

  const set = <K extends keyof CalendarEventFormValue>(
    k: K,
    v: CalendarEventFormValue[K],
  ) => update((prev) => ({ ...prev, [k]: v }))

  // 終日/時刻ありの切替。終日へ戻す時は入力済みの時刻を既定へクリアし、
  // 次に時刻ありへ戻った際に前回値が残らないようにする。
  const setAllDay = (isAllDay: boolean) =>
    update((prev) =>
      isAllDay
        ? { ...prev, isAllDay: true, startTime: DEFAULT_START_TIME, endTime: "" }
        : { ...prev, isAllDay: false },
    )

  // 繰り返し種別の切替。none 以外へ変える際、終了日が未入力なら開始日 + 3ヶ月を
  // 既定として補う(startDate 変更後に空へ戻していなければ既存値を尊重)。
  const setRepeat = (repeat: CalendarRepeat) =>
    update((prev) => ({
      ...prev,
      repeat,
      repeatUntil:
        repeat !== "none" && !prev.repeatUntil
          ? addMonthsYmd(prev.startDate, DEFAULT_REPEAT_UNTIL_MONTHS)
          : prev.repeatUntil,
    }))

  // 開始日の変更は終了日・繰り返し終了日を同差分でシフトする(期間を保つ)。
  const setStartDate = (startDate: string) =>
    update((prev) => applyStartDateShift(prev, startDate))

  /**
   * 保存前検証。サーバー Action と**同一の検証器**へ通し、失敗ならシートを
   * 開いたままエラーを出して onSubmit を呼ばない(入力を失わせない)。
   * サーバー側の検証は正しさの担保として残っており、ここは UX の一層目。
   */
  const handleSave = () => {
    const result = validateCalendarFormValue(value)
    if (result.error !== null) {
      setError({ message: result.error, field: result.field })
      return
    }
    onSubmit(value)
  }

  /** 該当項目の入力へ付ける aria(不正表示 + エラー文言との紐付け)。 */
  const fieldAria = (field: CalendarEventField) =>
    error?.field === field
      ? { "aria-invalid": true, "aria-describedby": ERROR_MESSAGE_ID }
      : {}

  // 編集中の予定が繰り返しシリーズに属するか(series_id を持つ native 行)。
  const seriesId = !isGoogle ? (editing?.series_id ?? null) : null

  // 通知の予告に使う起点。google は行の値、native は編集中のフォーム値から取る
  // (フォームで日時を動かせば予告も追随する)。
  const reminderWhen = isGoogle
    ? {
        isAllDay: editing.is_all_day,
        startDate: editing.start_date,
        startAt: editing.start_at,
      }
    : {
        isAllDay: value.isAllDay,
        startDate: value.startDate,
        startAt: formValueToTimestamps(value).startAt,
      }

  const reminderField = (
    <ReminderField
      state={reminder}
      onChange={(c) => onReminderChange?.(c)}
      disabled={saving || !onReminderChange}
      when={reminderWhen}
    />
  )

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
            {/* 本文は read-only でも通知だけは操作できる(B-2 の眼目)。 */}
            <div className="pt-2">{reminderField}</div>
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
                {...fieldAria("title")}
              />
            </div>

            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setAllDay(true)}
                className={`${segmentCn(value.isAllDay)} min-h-11`}
              >
                終日
              </button>
              <button
                type="button"
                onClick={() => setAllDay(false)}
                className={`${segmentCn(!value.isAllDay)} min-h-11`}
              >
                時刻あり
              </button>
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-2">
                <Label htmlFor="cal-start-date">開始日</Label>
                <Input
                  id="cal-start-date"
                  type="date"
                  value={value.startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="h-11"
                  {...fieldAria("startDate")}
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
                  {...fieldAria("endDate")}
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
                    {...fieldAria("startAt")}
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
                    {...fieldAria("endAt")}
                  />
                </div>
              </div>
            )}

            {/* 繰り返しは作成モードのみ(シリーズ編集はスコープ外)。 */}
            {!isEditing && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="cal-repeat">繰り返し</Label>
                <Select
                  items={REPEAT_OPTIONS}
                  value={value.repeat}
                  onValueChange={(v) => setRepeat(v as CalendarRepeat)}
                >
                  <SelectTrigger id="cal-repeat" className="h-11 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPEAT_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {value.repeat !== "none" && (
                  <div className="mt-2 flex flex-col gap-2">
                    <Label htmlFor="cal-repeat-until">繰り返しの終了日</Label>
                    <Input
                      id="cal-repeat-until"
                      type="date"
                      value={value.repeatUntil}
                      onChange={(e) => set("repeatUntil", e.target.value)}
                      className="h-11"
                      {...fieldAria("repeatUntil")}
                    />
                  </div>
                )}
              </div>
            )}

            {reminderField}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cal-memo">メモ（任意）</Label>
              <Input
                id="cal-memo"
                value={value.memo ?? ""}
                onChange={(e) => set("memo", e.target.value || null)}
                placeholder="場所や持ち物など"
                className="h-11"
                {...fieldAria("memo")}
              />
            </div>

            {/* 保存前検証のエラー。シートは開いたままで入力は保持される。 */}
            {error && (
              <p
                id={ERROR_MESSAGE_ID}
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                {error.message}
              </p>
            )}

            {/* 繰り返しシリーズに属する予定はシリーズ一括削除を提供する。
                既存の単発削除(フッタのゴミ箱)は「この 1 件のみ」を担い続ける。 */}
            {seriesId && (
              <Button
                variant="ghost"
                onClick={() => onDeleteSeries(seriesId)}
                disabled={saving}
                className="min-h-11 w-full cursor-pointer text-destructive hover:text-destructive"
              >
                <Trash2 size={18} />
                この繰り返し予定をすべて削除
              </Button>
            )}
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
                onClick={handleSave}
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
