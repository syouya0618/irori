"use client"

import { useId, useState } from "react"
import { AlertCircle, Check, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  CADENCE_UNIT_LABEL,
  cadenceIntervalOptions,
  CLEANING_DATE_MAX,
  CLEANING_DATE_MIN,
  CLEANING_LOCATION_MAX,
  CLEANING_NAME_MAX,
  isCleaningRequest,
  normalizeOptionalText,
  SCHEDULE_MODE_LABEL,
  type CleaningRoutineRequest,
} from "@/lib/domain/cleaning"
import {
  CADENCE_INTERVAL_MAX,
  CADENCE_UNITS,
  describeCadence,
  EMPTY_CLEANING_MARKS,
  formatYmdJa,
  routineStatusFromMarks,
  SCHEDULE_MODES,
  type CadenceUnit,
  type CleaningRoutine,
  type ScheduleMode,
} from "@/lib/domain/cleaning-schedule"
import { CLEANING_TEMPLATES, type CleaningTemplate } from "@/lib/domain/cleaning-templates"
import { newClientId } from "@/lib/utils/client-id"
import { segmentCn } from "@/lib/utils/segment-cn"
import { isValidYmd } from "@/lib/utils/date-jst"

const MODE_HELP: Record<ScheduleMode, string> = {
  fixed: "曜日や日付を決めて繰り返します。遅れて実施しても、次回は決めた曜日・日付のままです。",
  after_done: "実施した日から数えて次回を決めます。遅れて実施したら、次回もその分あとになります。",
}

/**
 * 掃除の項目の作成・編集フォーム。
 *
 * - 周期は「方式（決まった曜日・日付 / 実施してから一定期間後）」「単位（週・月・年）」「間隔」
 *   「基準日」を言葉で選び、その読み下し（「毎週土曜」「毎月31日（無い月は月末）」）を下に示す
 * - テンプレートは**入力欄を埋めるだけ**（選んでも保存せず、実施の記録も作らぬ）
 * - 行 ID は送信の時に 1 回だけ作る（編集は既存の ID と版）。保存は親（`onSubmit`）が行う
 * - `<form action>` を使わぬ（React 19 の自動リセットで入力が消えぬよう、onSubmit で受ける）
 *
 * ## 編集は「開いた時点の版」を送る
 * 入力欄は開いた時点の定義から作る。送る版も**その時点の版**に固定する（`base`）。フォームを
 * 開いたまま、定期再取得や画面への復帰で `editing` が新しい版へ差し替わっても、古い入力に新しい版を
 * 付けて送らぬ（付けると DB の版の照合が素通りし、家族が変えた周期を開いた時の値へ黙って巻き戻す）。
 * 版が進んだら「他の端末で変更されました」と告げて保存を止め、最新の内容を読み込み直してから
 * 編集し直させる（上書き保存の道は置かぬ — 全項目を開いた時点の値から送るため）。
 */
export function CleaningRoutineForm({
  editing,
  today,
  disabled,
  saving,
  onSubmit,
  onCancel,
}: {
  /** 編集する項目。null なら新規 */
  editing: CleaningRoutine | null
  today: string
  disabled: boolean
  saving: boolean
  /** 受け付けたら true（塞がれておれば false。入力は残す） */
  onSubmit: (request: CleaningRoutineRequest) => boolean
  onCancel: () => void
}) {
  const formId = useId()
  // 開いた時点の定義（入力の初期値・送る版・「周期を変えたか」の基準）。props の差し替えでは動かさぬ
  const [base, setBase] = useState(editing)
  const [name, setName] = useState(editing?.name ?? "")
  const [location, setLocation] = useState(editing?.location ?? "")
  const [unit, setUnit] = useState<CadenceUnit>(editing?.cadence_unit ?? "week")
  const [interval, setIntervalValue] = useState(editing?.cadence_interval ?? 1)
  const [mode, setMode] = useState<ScheduleMode>(editing?.schedule_mode ?? "fixed")
  const [anchor, setAnchor] = useState(editing?.anchor_date ?? today)
  const [error, setError] = useState<string | null>(null)
  const [templateKey, setTemplateKey] = useState<string | null>(null)

  // 開いた後に、別の端末（または別の操作）が定義を変えた。開いた時点の入力では保存させぬ
  const changedElsewhere = base !== null && editing !== null && editing.updated_at !== base.updated_at

  /** 最新の定義を読み込み直す（入力は最新の値で作り直す。利用者の明示操作からだけ呼ぶ）。 */
  function reloadLatest() {
    if (editing === null) return
    setBase(editing)
    setName(editing.name)
    setLocation(editing.location ?? "")
    setUnit(editing.cadence_unit)
    setIntervalValue(editing.cadence_interval)
    setMode(editing.schedule_mode)
    setAnchor(editing.anchor_date)
    setError(null)
  }

  const schedule = { cadence_unit: unit, cadence_interval: interval, schedule_mode: mode, anchor_date: anchor }
  const reading = describeCadence(schedule)
  // 新規の時だけ、最初の予定日を先に見せる（固定周期は今日より前の予定日を数えぬ = DB と同じ規則）
  const firstDue =
    base === null && reading !== null
      ? routineStatusFromMarks(
          {
            ...schedule,
            postponed_occurrence: null,
            postponed_until: null,
            paused_at: null,
            resume_floor: mode === "fixed" ? today : null,
          },
          EMPTY_CLEANING_MARKS,
          today,
        ).dueOn
      : null
  const cadenceChanged =
    base !== null &&
    (base.cadence_unit !== unit ||
      base.cadence_interval !== interval ||
      base.schedule_mode !== mode ||
      base.anchor_date !== anchor)

  function changeUnit(next: CadenceUnit) {
    setUnit(next)
    // 単位ごとに間隔の上限が違う（週 52・月 24・年 10）。上限を越える値は持ち越さぬ
    if (interval > CADENCE_INTERVAL_MAX[next]) setIntervalValue(1)
    setError(null)
  }

  function applyTemplate(template: CleaningTemplate) {
    setName(template.name)
    setLocation(template.location)
    setUnit(template.cadenceUnit)
    setIntervalValue(template.cadenceInterval)
    setMode(template.scheduleMode)
    setTemplateKey(template.key)
    setError(null)
  }

  function submit() {
    // 釦は無効にしてあるが、Enter での送信もここで止める
    if (changedElsewhere) return
    const trimmedName = name.trim()
    if (trimmedName.length === 0) {
      setError("名前を入力してください。")
      return
    }
    if ([...trimmedName].length > CLEANING_NAME_MAX) {
      setError(`名前は${CLEANING_NAME_MAX}文字までにしてください。`)
      return
    }
    const normalizedLocation = normalizeOptionalText(location)
    if (normalizedLocation !== null && [...normalizedLocation].length > CLEANING_LOCATION_MAX) {
      setError(`場所は${CLEANING_LOCATION_MAX}文字までにしてください。`)
      return
    }
    if (!isValidYmd(anchor) || anchor < CLEANING_DATE_MIN || anchor > CLEANING_DATE_MAX) {
      setError(mode === "fixed" ? "基準にする日を選んでください。" : "最初の予定日を選んでください。")
      return
    }
    const request: CleaningRoutineRequest = {
      op: "routine",
      id: base?.id ?? newClientId(),
      // 版は開いた時点のもの（生きた props の版を読まぬ）
      version: base?.updated_at ?? null,
      name: trimmedName,
      location: normalizedLocation,
      cadenceUnit: unit,
      cadenceInterval: interval,
      scheduleMode: mode,
      anchorDate: anchor,
      archived: false,
    }
    if (!isCleaningRequest(request)) {
      setError("入力内容を確認してください。")
      return
    }
    setError(null)
    onSubmit(request)
  }

  const nameId = `${formId}-name`
  const locationId = `${formId}-location`
  const intervalId = `${formId}-interval`
  const anchorId = `${formId}-anchor`
  const errorId = `${formId}-error`

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
      {changedElsewhere && (
        <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3">
          <p className="flex items-start gap-2 text-sm text-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span className="min-w-0 break-words">
              他の端末でこの項目が変更されました。開いた時の入力のままでは保存できません（家族の変更を上書きしないためです）。最新の内容を読み込んでから、もう一度編集してください。
            </span>
          </p>
          <Button type="button" variant="outline" className="self-start" onClick={reloadLatest}>
            <RefreshCw aria-hidden="true" />
            最新の内容を読み込む
          </Button>
          <p className="text-sm text-muted-foreground">読み込むと、いま入力している内容は最新の内容に置き換わります。</p>
        </div>
      )}

      {base === null && (
        <section aria-labelledby={`${formId}-templates`} className="flex flex-col gap-2">
          <h3 id={`${formId}-templates`} className="text-sm font-semibold">
            テンプレートから入力する
          </h3>
          <p className="text-sm text-muted-foreground">
            選ぶと下の入力欄を埋めます。保存するまで登録されず、実施の記録も作りません。周期は目安なので、ご家庭に合わせて変えてください。
          </p>
          <ul className="flex flex-wrap gap-2">
            {CLEANING_TEMPLATES.map((template) => {
              const selected = templateKey === template.key
              return (
                <li key={template.key}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => applyTemplate(template)}
                    className={`flex min-h-11 cursor-pointer items-center gap-1 rounded-full border px-3 text-sm transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring ${
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-foreground hover:bg-muted"
                    }`}
                  >
                    {selected && <Check size={14} aria-hidden="true" />}
                    {template.name}
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      <div className="flex flex-col gap-2">
        <label htmlFor={nameId} className="text-sm font-medium">
          名前
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={CLEANING_NAME_MAX}
          autoComplete="off"
          placeholder="例: 浴室の排水口"
          className="h-11"
          aria-invalid={error !== null && name.trim().length === 0 ? true : undefined}
          aria-describedby={error !== null ? errorId : undefined}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={locationId} className="text-sm font-medium">
          場所（任意）
        </label>
        <Input
          id={locationId}
          value={location}
          maxLength={CLEANING_LOCATION_MAX}
          autoComplete="off"
          placeholder="例: 浴室"
          className="h-11"
          onChange={(event) => {
            setLocation(event.target.value)
            setError(null)
          }}
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">次回の決め方</legend>
        {SCHEDULE_MODES.map((value) => {
          const selected = mode === value
          return (
            <button
              key={value}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setMode(value)
                setError(null)
              }}
              className={`flex min-h-11 cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-left transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring ${
                selected ? "border-primary bg-primary/10" : "border-border bg-background hover:bg-muted"
              }`}
            >
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 ${
                  selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground"
                }`}
              >
                {selected && <Check size={12} strokeWidth={3} />}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-foreground">{SCHEDULE_MODE_LABEL[value]}</span>
                <span className="text-sm text-muted-foreground">{MODE_HELP[value]}</span>
              </span>
            </button>
          )
        })}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">周期</legend>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {CADENCE_UNITS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={unit === value}
              onClick={() => changeUnit(value)}
              className={`${segmentCn(unit === value)} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
            >
              {CADENCE_UNIT_LABEL[value]}
            </button>
          ))}
        </div>
        <label htmlFor={intervalId} className="text-sm text-muted-foreground">
          間隔
        </label>
        <select
          id={intervalId}
          value={String(interval)}
          onChange={(event) => {
            setIntervalValue(Number(event.target.value))
            setError(null)
          }}
          className="min-h-11 w-full rounded-xl border border-input bg-background px-3 text-base transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring"
        >
          {cadenceIntervalOptions(unit).map((option) => (
            <option key={option.value} value={String(option.value)}>
              {option.label}ごと
            </option>
          ))}
        </select>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={anchorId} className="text-sm font-medium">
          {mode === "fixed" ? "基準にする日" : "最初の予定日"}
        </label>
        <Input
          id={anchorId}
          type="date"
          value={anchor}
          min={CLEANING_DATE_MIN}
          max={CLEANING_DATE_MAX}
          className="h-11"
          onChange={(event) => {
            setAnchor(event.target.value)
            setError(null)
          }}
        />
        <p className="text-sm text-muted-foreground">
          {mode === "fixed"
            ? "この日の曜日・日付で繰り返します。実施した日ではなく、予定の基準です。"
            : "まだ記録が無い間の、最初の予定日です。実施した日としては記録されません。"}
        </p>
      </div>

      <div
        data-testid="cadence-reading"
        aria-live="polite"
        className="flex flex-col gap-1 rounded-xl bg-muted/60 px-3 py-2 text-sm"
      >
        <p className="font-medium break-words">{reading ?? "周期と日付を選んでください"}</p>
        {firstDue !== null && (
          <p className="text-muted-foreground">最初の予定日: {formatYmdJa(firstDue, today) ?? firstDue}</p>
        )}
        {cadenceChanged && (
          <p className="text-muted-foreground">
            周期を変えると延期は取り消され、変更前の予定日は期限超過として数え直しません。変更前の予定に付けた完了・スキップは新しい予定には引き継がず、新しい周期の最初の予定日から数えます（今日すでに実施を記録していれば、明日以降の予定日から）。前回実施日と履歴は変わりません。
          </p>
        )}
      </div>

      {error !== null && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <Button type="submit" disabled={disabled || changedElsewhere} className="min-h-12 w-full text-base">
          {saving ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              保存中...
            </>
          ) : base === null ? (
            "この内容で追加"
          ) : (
            "変更を保存"
          )}
        </Button>
        <Button type="button" variant="outline" className="w-full" onClick={onCancel}>
          やめる
        </Button>
      </div>
    </form>
  )
}
