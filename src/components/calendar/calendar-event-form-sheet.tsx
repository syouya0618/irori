"use client"

import { useEffect, useRef, useState } from "react"
import {
  AlertCircle,
  BellRing,
  CalendarClock,
  History,
  Loader2,
  Lock,
  Repeat,
  Trash2,
} from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { formatJstTimeInput, isFutureIso } from "@/lib/utils/date-jst"
import { segmentCn } from "@/lib/utils/segment-cn"
import type {
  CalendarEventField,
  CalendarRepeat,
} from "@/lib/domain/calendar-validation"
import {
  applyRepeatChange,
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
import { eventWhenLabel, repeatSummary } from "./calendar-display"

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

/** エラー文言の DOM id。aria-describedby で不正な入力と紐付ける。 */
const ERROR_MESSAGE_ID = "cal-form-error"

/** 検証の項目 → 入力の id（エラー時にその欄へフォーカスを移す）。 */
const FIELD_INPUT_ID: Record<CalendarEventField, string> = {
  title: "cal-title",
  memo: "cal-memo",
  startDate: "cal-start-date",
  endDate: "cal-end-date",
  startAt: "cal-start-time",
  endAt: "cal-end-time",
  repeatUntil: "cal-repeat-until",
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = 新規、native = 編集、google = read-only 詳細 */
  editing: CalendarEventRecord | null
  defaultDate: string
  saving: boolean
  onSubmit: (value: CalendarEventFormValue) => void
  /** この 1 件だけを削除する（繰り返しの一部なら「この回だけ」）。 */
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
  /**
   * 保存に失敗して戻ってきた入力。あればこれでフォームを始める
   * （打った内容を失わせぬ）。版の判定は親が済ませてから渡す。
   */
  initialDraft?: CalendarEventFormValue | null
  /** 復元した入力を捨てた（親の保持も消す）。 */
  onDiscardDraft?: () => void
}

/** 確認パネル。null = 通常のフッタ。 */
type Panel = null | "delete" | "discard"

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
  // 過ぎた時刻の通知は配信されぬ。黙って「通知します」と言わぬ（許容誤差 0 分）。
  const remindPassed = remindAt !== null && !isFutureIso(remindAt, 0)

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="cal-reminder" className="flex items-center gap-1.5">
        <BellRing size={14} aria-hidden="true" />
        通知
      </Label>
      <Select
        items={REMINDER_OPTIONS}
        value={choice}
        onValueChange={(v) => onChange(v as ReminderChoice)}
        disabled={disabled || loading || unsupported}
      >
        <SelectTrigger
          id="cal-reminder"
          className="h-11 w-full"
          aria-describedby="cal-reminder-status"
        >
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
      <p
        id="cal-reminder-status"
        aria-live="polite"
        className="text-xs tabular-nums text-muted-foreground"
      >
        {loading
          ? "通知設定を読み込み中…"
          : unsupported
            ? "この予定には、このアプリがまだ知らない通知設定が入っています。誤って消さないよう変更できません。"
            : remindLabel && remindPassed
              ? `${remindLabel} はすでに過ぎているため、通知は届きません`
              : remindLabel
                ? `${remindLabel} に通知します`
                : "通知しません"}
      </p>
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
      // <input type="time"> の seed は h23 固定の formatJstTimeInput で作る
      // （formatTimeJst は環境により深夜 0 時を "24:xx" と出し、欄が空になる）
      startTime: editing.start_at
        ? formatJstTimeInput(editing.start_at)
        : DEFAULT_START_TIME,
      endTime: editing.end_at ? formatJstTimeInput(editing.end_at) : "",
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

/** フォーム値の比較（入力途中の判定用）。memo の "" と null は同じとみなす。 */
function sameFormValue(a: CalendarEventFormValue, b: CalendarEventFormValue): boolean {
  return (
    a.title === b.title &&
    (a.memo ?? "") === (b.memo ?? "") &&
    a.isAllDay === b.isAllDay &&
    a.startDate === b.startDate &&
    a.endDate === b.endDate &&
    // 終日の時は時刻欄が見えておらぬゆえ比べぬ
    (a.isAllDay || (a.startTime === b.startTime && a.endTime === b.endTime)) &&
    a.repeat === b.repeat &&
    (a.repeat === "none" || a.repeatUntil === b.repeatUntil)
  )
}

/** 入力中の日時の 1 行要約。検証前の値ゆえ、組めない時は出さぬ。 */
function formWhenLabel(v: CalendarEventFormValue): string | null {
  if (!v.startDate || !v.endDate || v.endDate < v.startDate) return null
  const { startAt, endAt } = formValueToTimestamps(v)
  if (!v.isAllDay && !startAt) return null
  return eventWhenLabel({
    is_all_day: v.isAllDay,
    start_date: v.startDate,
    end_date: v.endDate,
    start_at: startAt,
    end_at: endAt,
  })
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
  initialDraft = null,
  onDiscardDraft,
}: Props) {
  // open/editing 変化でフォームを初期化(render-time conditional setState)。
  const [prevKey, setPrevKey] = useState<string | null>(null)
  const currentKey = open
    ? `${editing?.id ?? `new:${defaultDate}`}${initialDraft ? ":draft" : ""}`
    : null
  const [value, setValue] = useState<CalendarEventFormValue>(() =>
    initialDraft ?? initialValue(editing, defaultDate),
  )
  // 保存前検証で弾かれた内容(文言 + 該当項目)。null = エラーなし。
  const [error, setError] = useState<{
    message: string
    field: CalendarEventField
  } | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  const [draftRestored, setDraftRestored] = useState(false)
  if (currentKey !== prevKey) {
    setPrevKey(currentKey)
    if (open) {
      setValue(initialDraft ?? initialValue(editing, defaultDate))
      setError(null) // 前回の失敗を新しいフォームへ持ち越さない
      setPanel(null)
      setDraftRestored(initialDraft !== null)
    }
  }

  const isGoogle = editing?.source === "google"
  const isEditing = !!editing
  // 編集中の予定が繰り返しシリーズに属するか(series_id を持つ native 行)。
  const seriesId = !isGoogle ? (editing?.series_id ?? null) : null

  // 入力途中か（閉じる前に破棄を確かめる）。基準は開いた時点の予定（復元した入力ではない）。
  const dirty =
    !isGoogle && !sameFormValue(value, initialValue(editing, defaultDate))

  // 確認パネルを開いたら、まず「取り消し側」へフォーカスを置く（誤操作を確定させぬ）。
  const panelCancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (panel !== null) panelCancelRef.current?.focus()
  }, [panel])

  // 値を編集したらエラー表示は消す(修正中に赤いままにしない)。
  const update = (
    next: (prev: CalendarEventFormValue) => CalendarEventFormValue,
  ) => {
    setValue(next)
    setError(null)
    setPanel((p) => (p === "discard" ? null : p))
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

  // 繰り返し種別の切替（終了日の既定補完と、開始日が空・不正な時の扱いは
  // calendar-form.ts の applyRepeatChange が持つ）。
  const setRepeat = (repeat: CalendarRepeat) =>
    update((prev) => applyRepeatChange(prev, repeat))

  // 開始日の変更は終了日・繰り返し終了日を同差分でシフトする(期間を保つ)。
  const setStartDate = (startDate: string) =>
    update((prev) => applyStartDateShift(prev, startDate))

  /**
   * シートを閉じる要求（背景タップ・Esc・×）。入力途中なら閉じずに破棄の確認を出す。
   * Sheet は controlled ゆえ、親へ false を渡さねば開いたまま残る。
   */
  const handleOpenChange = (next: boolean) => {
    // ⚠️ `saving` では素通しせぬ: 親の pending は通知の即時保存・別の予定の保存とも共有で、
    // このシートの送信中とは限らぬ（送信はシートを閉じてから始まる）。
    // 確認を出した後の 2 度目の Esc・背景タップでも破棄せぬ（選ばせる）。
    if (!next && dirty) {
      setPanel("discard")
      return
    }
    onOpenChange(next)
  }

  /** 明示的に破棄して閉じる。復元した入力も親から消す（次に開いた時に蘇らせぬ）。 */
  const discardAndClose = () => {
    setPanel(null)
    if (initialDraft) onDiscardDraft?.()
    onOpenChange(false)
  }

  /**
   * 保存前検証。サーバー Action と**同一の検証器**へ通し、失敗ならシートを
   * 開いたままエラーを出して onSubmit を呼ばない(入力を失わせない)。
   * サーバー側の検証は正しさの担保として残っており、ここは UX の一層目。
   */
  const handleSave = () => {
    const result = validateCalendarFormValue(value)
    if (result.error !== null) {
      setError({ message: result.error, field: result.field })
      // 該当の欄を見える位置へ寄せる（赤枠で場所が分かる）。**focus はせぬ**: iOS では
      // 日付・時刻欄の focus でピッカーやキーボードが開き、文言（保存ボタンの直上）を覆う。
      // jsdom 等 scrollIntoView を持たぬ環境もあるゆえ、有る時だけ呼ぶ。
      const el = document.getElementById(FIELD_INPUT_ID[result.field])
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center" })
      }
      return
    }
    onSubmit(value)
  }

  /** 該当項目の入力へ付ける aria(不正表示 + エラー文言との紐付け)。 */
  const fieldAria = (field: CalendarEventField) =>
    error?.field === field
      ? { "aria-invalid": true, "aria-describedby": ERROR_MESSAGE_ID }
      : {}

  /** エラーの欄の名前（文言に「どこが」を添える。赤枠だけに頼らぬ）。 */
  const FIELD_LABEL: Record<CalendarEventField, string> = {
    title: "タイトル",
    memo: "メモ",
    startDate: "開始日",
    endDate: "終了日",
    startAt: "開始時刻",
    endAt: "終了時刻",
    repeatUntil: "繰り返しの終了日",
  }

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

  const whenLabel = isGoogle ? null : formWhenLabel(value)
  const repeatLabel =
    !isEditing && value.repeat !== "none"
      ? repeatSummary(value.startDate, value.repeat, value.repeatUntil)
      : null

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* 上限 + 本文スクロールは育児ログ側のシートと同じ形。シートは下端固定で高さは
          中身なりゆえ、上限が無いと「時刻あり」や繰り返しで伸びた分だけ上端（閉じる・
          タイトル欄）が画面外へ出て、fixed ゆえスクロールでも戻せぬ */}
      <SheetContent
        side="bottom"
        className="max-h-[85dvh] overflow-hidden rounded-t-2xl safe-bottom"
      >
        <SheetHeader>
          <SheetTitle>
            {isGoogle ? "予定の詳細" : isEditing ? "予定を編集" : "予定を追加"}
          </SheetTitle>
          <SheetDescription>
            {isGoogle
              ? "Google カレンダーの予定です。内容は閲覧のみで、通知だけ設定できます"
              : "家族で共有する予定です"}
          </SheetDescription>
        </SheetHeader>

        {isGoogle ? (
          <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-4">
            <span className="flex w-fit items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
              <Lock size={12} aria-hidden="true" />
              Google カレンダー・閲覧のみ
            </span>
            <p className="text-base font-medium">{editing.title}</p>
            <p className="flex items-start gap-1.5 text-sm tabular-nums text-muted-foreground">
              <CalendarClock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              {eventWhenLabel(editing)}
            </p>
            {editing.memo && (
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                {editing.memo}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              内容を変えるときは Google カレンダーで編集してください。次の同期で反映されます。
            </p>
            {/* 本文は read-only でも通知だけは操作できる(B-2 の眼目)。 */}
            <div className="pt-1">{reminderField}</div>
          </div>
        ) : (
          <div className="flex flex-col gap-5 overflow-y-auto px-4 pb-4">
            {draftRestored && (
              <div
                role="status"
                className="flex items-start gap-2 rounded-xl bg-primary/10 px-3 py-2 text-sm text-primary"
              >
                <History size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="flex-1">保存できなかった入力を復元しました。</span>
                <button
                  type="button"
                  onClick={() => {
                    setDraftRestored(false)
                    setValue(initialValue(editing, defaultDate))
                    setError(null)
                    onDiscardDraft?.()
                  }}
                  className="touch-target -my-2 shrink-0 cursor-pointer rounded-lg px-2 font-medium transition-colors duration-200 hover:bg-primary/10"
                >
                  破棄
                </button>
              </div>
            )}

            {seriesId && (
              <p className="flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                <Repeat size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                繰り返し予定の 1 回です。変更はこの回だけに適用されます。
              </p>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cal-title">タイトル</Label>
              <Input
                id="cal-title"
                value={value.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="例: 検診、保育園見学"
                className="h-11"
                autoFocus={!isEditing}
                {...fieldAria("title")}
              />
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-sm font-medium">日時</legend>
              <div className="flex gap-1.5" role="group" aria-label="終日または時刻あり">
                <button
                  type="button"
                  aria-pressed={value.isAllDay}
                  onClick={() => setAllDay(true)}
                  className={segmentCn(value.isAllDay)}
                >
                  終日
                </button>
                <button
                  type="button"
                  aria-pressed={!value.isAllDay}
                  onClick={() => setAllDay(false)}
                  className={segmentCn(!value.isAllDay)}
                >
                  時刻あり
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="flex min-w-0 flex-col gap-2">
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
                <div className="flex min-w-0 flex-col gap-2">
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
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex min-w-0 flex-col gap-2">
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
                    <div className="flex min-w-0 flex-col gap-2">
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
                </>
              )}

              {/* 入力中の日時を言葉で確かめられるようにする（日付欄の表記は端末で違う） */}
              {whenLabel && (
                <p
                  aria-live="polite"
                  className="flex items-start gap-1.5 text-xs tabular-nums text-muted-foreground"
                >
                  <CalendarClock size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                  {whenLabel}
                </p>
              )}
            </fieldset>

            {/* 繰り返しは作成モードのみ(シリーズ編集はスコープ外)。 */}
            {!isEditing && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="cal-repeat" className="flex items-center gap-1.5">
                  <Repeat size={14} aria-hidden="true" />
                  繰り返し
                </Label>
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
                  <div className="mt-1 flex flex-col gap-2">
                    <Label htmlFor="cal-repeat-until">繰り返しの終了日</Label>
                    <Input
                      id="cal-repeat-until"
                      type="date"
                      value={value.repeatUntil}
                      onChange={(e) => set("repeatUntil", e.target.value)}
                      className="h-11"
                      {...fieldAria("repeatUntil")}
                    />
                    {repeatLabel && (
                      <p aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
                        {repeatLabel}の予定を作成します
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {reminderField}

            <div className="flex flex-col gap-2">
              <Label htmlFor="cal-memo">メモ（任意）</Label>
              <Textarea
                id="cal-memo"
                rows={2}
                value={value.memo ?? ""}
                onChange={(e) => set("memo", e.target.value || null)}
                placeholder="場所や持ち物など"
                {...fieldAria("memo")}
              />
            </div>
          </div>
        )}

        {/* 保存前検証のエラー。シートは開いたままで入力は保持される。本文（上限付きの
            スクロール領域）の外、保存ボタンの直上に置く — 本文の中だと、背の低い画面で
            最上部のまま「追加」を押した時に文言が画面外へ出て、押しても何も起きぬように
            見える。該当の欄は赤枠 + scrollIntoView で示し、文言にも欄の名前を添える。 */}
        {!isGoogle && error && panel === null && (
          <div className="shrink-0 px-4">
            <p
              id={ERROR_MESSAGE_ID}
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                {/* 文言が既に欄の名前を含むなら重ねぬ（「タイトル: タイトルを…」にせぬ） */}
                {!error.message.includes(FIELD_LABEL[error.field]) && (
                  <span className="font-medium">{FIELD_LABEL[error.field]}: </span>
                )}
                {error.message}
              </span>
            </p>
          </div>
        )}

        <SheetFooter className="gap-2 border-t border-border/60">
          {isGoogle ? (
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              className="w-full cursor-pointer"
            >
              閉じる
            </Button>
          ) : panel === "discard" ? (
            <div role="group" aria-labelledby="cal-discard-title" className="flex flex-col gap-2">
              <p id="cal-discard-title" className="text-sm font-medium">
                入力中の内容を破棄して閉じますか？
              </p>
              <div className="flex gap-2">
                <Button
                  ref={panelCancelRef}
                  variant="outline"
                  onClick={() => setPanel(null)}
                  className="flex-1 cursor-pointer"
                >
                  編集を続ける
                </Button>
                <Button
                  variant="destructive"
                  onClick={discardAndClose}
                  className="flex-1 cursor-pointer"
                >
                  破棄して閉じる
                </Button>
              </div>
            </div>
          ) : panel === "delete" && editing ? (
            <div role="group" aria-labelledby="cal-delete-title" aria-describedby="cal-delete-desc" className="flex flex-col gap-2">
              <p id="cal-delete-title" className="text-sm font-medium">
                {seriesId ? "繰り返し予定を削除します" : `「${editing.title}」を削除しますか？`}
              </p>
              <p id="cal-delete-desc" className="text-xs text-muted-foreground">
                {seriesId
                  ? "この回だけ消すか、繰り返しのすべての回を消すかを選んでください。削除は元に戻せません。"
                  : "家族の画面からも消えます。削除は元に戻せません。"}
              </p>
              {seriesId ? (
                <div className="flex flex-col gap-2">
                  {/* 重さの違う 2 つを同じ見た目にせぬ: 1 回だけは枠線、全回は塗り */}
                  <Button
                    variant="outline"
                    onClick={() => onDelete(editing.id)}
                    disabled={saving}
                    className="w-full cursor-pointer text-destructive hover:text-destructive"
                  >
                    この回だけ削除
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => onDeleteSeries(seriesId)}
                    disabled={saving}
                    className="w-full cursor-pointer"
                  >
                    繰り返しのすべての回を削除
                  </Button>
                  <Button
                    ref={panelCancelRef}
                    variant="outline"
                    onClick={() => setPanel(null)}
                    className="w-full cursor-pointer"
                  >
                    キャンセル
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    ref={panelCancelRef}
                    variant="outline"
                    onClick={() => setPanel(null)}
                    className="flex-1 cursor-pointer"
                  >
                    キャンセル
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => onDelete(editing.id)}
                    disabled={saving}
                    className="flex-1 cursor-pointer"
                  >
                    削除する
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="flex gap-3">
              {isEditing && (
                <Button
                  variant="ghost"
                  onClick={() => setPanel("delete")}
                  disabled={saving}
                  className="shrink-0 cursor-pointer px-3 text-destructive hover:text-destructive"
                >
                  <Trash2 size={18} />
                  削除
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
            </div>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
