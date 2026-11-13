"use client"

import { useId, useState, type ReactNode } from "react"
import { AlertCircle, BellRing, Check, Repeat } from "lucide-react"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  GARBAGE_KIND_MAX,
  GARBAGE_KIND_PRESETS,
  GARBAGE_MUTE_EFFECT,
  garbageMuteLabel,
  garbageReminderEffect,
  garbageRequestLabel,
  isGarbageRequest,
  normalizeGarbageKind,
  prevDayReminderPassed,
  type EventPurposeScope,
  type GarbageAction,
  type GarbageReminderChoice,
  type GarbageRequest,
  type ResolvedEventPurpose,
} from "@/lib/domain/garbage"
import { GarbageKindIcon } from "./garbage-kind-icon"

/** 分類の操作の起点にする予定（行 id と、利用者に見せる題・日時）。 */
export interface GarbageFormTarget {
  id: string
  title: string
  /** 「11月12日（木） 終日」等。どの回を操作しておるかを言う */
  whenLabel: string
  /** 繰り返し（シリーズ）の 1 回か。真なら範囲を選ばせる */
  isSeries: boolean
  /**
   * この回の開始日（YYYY-MM-DD）。前日 20:00 がもう過ぎておる回に「通知します」と言わぬために使う
   * （過ぎた時刻の通知は配信されぬ）
   */
  startDate: string
}

/**
 * フォームの操作。`mute` は画面だけの操作で、要求は「この回だけ・解除・通知を止める」になる
 * （シリーズ既定の回に、用途を持たぬ明示 OFF だけの行を作る = 分類はシリーズのまま）。
 */
type FormMode = GarbageAction | "mute"

interface GarbagePurposeFormProps {
  target: GarbageFormTarget
  /**
   * 今の用途（`resolveEventPurpose` の結果）。**`unknown` は渡さぬこと** — 今の分類を読めておらぬ
   * 予定を、読めぬまま書き換えさせぬ（呼び出し側が読み直しを促す）。
   */
  current: Exclude<ResolvedEventPurpose, { kind: "unknown" }>
  /** 範囲を固定する（ごみの画面の分類の一覧から開いた時）。省略すれば繰り返しの回では選ばせる */
  lockedScope?: EventPurposeScope
  /** 最初に選んでおく操作（省略時は「ごみの日にする」） */
  initialMode?: GarbageAction
  /** 新しい保存を受けられぬ（送信中・確認待ち）。保存ボタンを止める */
  disabled?: boolean
  onSubmit: (request: GarbageRequest, label: string) => void
  onCancel?: () => void
}

const CUSTOM = "__custom__"

const REMINDER_LABELS: Record<GarbageReminderChoice, string> = {
  prev_day_20: "前日 20:00 に通知する",
  off: "通知を止める",
  keep: "通知設定は変えない",
}

const MODE_LABELS: Record<FormMode, string> = {
  garbage: "ごみの日にする",
  normal: "この回だけ通常の予定に戻す",
  mute: "この回の通知だけ止める",
  clear: "分類を解除する",
}

function isPreset(label: string | null): boolean {
  return label !== null && GARBAGE_KIND_PRESETS.some((p) => p.label === label)
}

/**
 * ごみの分類のフォーム（分類・名称の変更・この回だけ通常へ戻す・解除）。
 *
 * - **タイトルから用途を推定せぬ**。名称は利用者が選ぶ・入力する（初期値は今の分類だけ）
 * - 繰り返しの回では**範囲を明示して選ばせる**（この回だけ / シリーズ全体）。未分類の回では
 *   既定を置かぬ（押すまで保存できぬ）
 * - **今回の保存で通知をどうするか**を必ず画面に出し、選ばせる。新しくごみの日にする時の
 *   初期選択は前日 20:00。既に分類済みの予定を直す時は「変えない」から始める（個別に止めた
 *   通知・変えた時刻を、名称の変更のついでに書き換えぬ）。シリーズ全体の通知を止めてある
 *   シリーズの回へ「この回だけ」の分類を足す時も「変えない」から始める（止めた通知を、
 *   名称の変更のついでに付け直さぬ）
 * - 前日 20:00 をもう過ぎておる回には「通知します」と言わず、届かぬことを言う
 * - シリーズ既定の回の通知だけを止めたい時は「この回の通知だけ止める」（この回だけの分類を
 *   作らぬ = シリーズから分岐させぬ）
 * - **見ておった分類の版は、フォームを開いた時点で固定して送る**（開いたままの間に家族が
 *   分類を変えても、古い入力で上書きせぬ。RPC が conflict で止める）
 * - 押下要素は `aria-pressed` のボタン（選択中は塗りに加えてチェックの印 = 色だけで示さぬ）
 */
export function GarbagePurposeForm({
  target,
  current,
  lockedScope,
  initialMode = "garbage",
  disabled = false,
  onSubmit,
  onCancel,
}: GarbagePurposeFormProps) {
  const baseId = useId()
  const seriesLabel = current.seriesLabel
  const hasSeriesDefault = seriesLabel !== null
  const eventGarbageLabel = current.kind === "garbage" && current.scope === "event" ? current.label : null
  const eventIsNormalException = current.kind === "normal" && current.exception
  const hasEventRow = eventGarbageLabel !== null || eventIsNormalException

  /** その範囲で、今すでに「ごみ」として保存されておる名称（無ければ null） */
  const labelAt = (s: EventPurposeScope | null): string | null =>
    s === "series" ? seriesLabel : s === "event" ? eventGarbageLabel : null

  /** この回の通知を、利用者が明示的に止めておるか（シリーズ既定で付いた通知を個別に切った回） */
  const eventOptedOut = current.kind === "garbage" && current.reminderOptOut
  /** この回が、シリーズ既定そのままでごみになっておるか（この回だけの分類の行を持たぬ） */
  const garbageBySeries = current.kind === "garbage" && current.scope === "series"

  const modesFor = (s: EventPurposeScope | null): FormMode[] => {
    const modes: FormMode[] = ["garbage"]
    if (s === "event" && hasSeriesDefault && !eventIsNormalException) modes.push("normal")
    // シリーズ既定の回の通知だけを止める（「ごみの日にする + 通知を止める」だと、この回だけの
    // 分類の行ができてシリーズから分岐する）。既に止めてある回には出さぬ
    if (s === "event" && garbageBySeries && !eventOptedOut) modes.push("mute")
    if (s === "series" ? hasSeriesDefault : s === "event" && hasEventRow) modes.push("clear")
    return modes
  }

  const defaultReminder = (m: FormMode, s: EventPurposeScope | null): GarbageReminderChoice => {
    if (m === "mute") return "off"
    if (m === "garbage") {
      if (s === "event") {
        // 明示的に止めた回・通常へ戻した回の通知を、名称の変更・例外の追加のついでに付け直さぬ
        if (eventOptedOut || eventIsNormalException) return "keep"
        if (labelAt("event") !== null) return "keep"
        // シリーズ既定の在る回へ「この回だけ」の分類を足す時は、シリーズの通知の既定に従う。
        // シリーズ全体の通知を止めてある（none）・既定を読めぬ（null）なら、通知には触れぬ
        if (hasSeriesDefault) return current.seriesRemindDefault === "prev_day_20" ? "prev_day_20" : "keep"
        return "prev_day_20"
      }
      return labelAt(s) === null ? "prev_day_20" : "keep"
    }
    return m === "normal" ? "off" : "keep"
  }

  const initialScope: EventPurposeScope | null =
    lockedScope ??
    (!target.isSeries
      ? "event"
      : current.kind === "garbage"
        ? current.scope
        : eventIsNormalException
          ? "event"
          : null)
  const startMode: FormMode = modesFor(initialScope).includes(initialMode) ? initialMode : "garbage"
  const startLabel = labelAt(initialScope) ?? (current.kind === "garbage" ? current.label : null)

  const [scope, setScope] = useState<EventPurposeScope | null>(initialScope)
  const [mode, setMode] = useState<FormMode>(startMode)
  const [kind, setKind] = useState<string | null>(
    startLabel === null ? null : isPreset(startLabel) ? startLabel : CUSTOM,
  )
  const [customText, setCustomText] = useState(startLabel !== null && !isPreset(startLabel) ? startLabel : "")
  const [reminder, setReminder] = useState<GarbageReminderChoice>(defaultReminder(startMode, initialScope))
  const [error, setError] = useState<string | null>(null)
  // 見ておった分類の版は、開いた時点で固定する（開いたままの間に props が新しい版へ差し替わっても、
  // 「開いた時点の入力 + 最新の版」を送って家族の変更を黙って上書きせぬ）
  const [seen] = useState(() => ({ series: current.seen.series, event: current.seen.event }))
  // 「前日 20:00 はもう過ぎたか」の基準時刻も開いた時点（描画のたびに時計を読まぬ）
  const [openedAt] = useState(() => Date.now())
  const prevDayPassed = prevDayReminderPassed(target.startDate, new Date(openedAt)) === true

  const modes = modesFor(scope)
  const reminderChoices: GarbageReminderChoice[] =
    mode === "garbage" ? ["prev_day_20", "off", "keep"] : mode === "mute" ? [] : ["off", "keep"]

  const chooseScope = (next: EventPurposeScope) => {
    const nextMode = modesFor(next).includes(mode) ? mode : "garbage"
    setScope(next)
    setMode(nextMode)
    setReminder(defaultReminder(nextMode, next))
    // その範囲で保存済みの名称が在れば、そこから始める（別の範囲の名称を持ち越して上書きさせぬ）
    const saved = labelAt(next)
    if (saved !== null) {
      setKind(isPreset(saved) ? saved : CUSTOM)
      if (!isPreset(saved)) setCustomText(saved)
    }
    setError(null)
  }

  const chooseMode = (next: FormMode) => {
    setMode(next)
    setReminder(defaultReminder(next, scope))
    setError(null)
  }

  const submit = () => {
    if (scope === null) {
      setError("変更する範囲（この回だけ / シリーズ全体）を選んでください。")
      return
    }
    let garbageKind: string | null = null
    if (mode === "garbage") {
      garbageKind = kind === CUSTOM ? normalizeGarbageKind(customText) : kind
      if (garbageKind === null) {
        setError(
          kind === CUSTOM
            ? `ごみの名称を 1〜${GARBAGE_KIND_MAX} 文字で入力してください。`
            : "ごみの名称を選んでください。",
        )
        return
      }
    }
    const request: GarbageRequest =
      mode === "mute"
        ? // 用途は書かず、この回の明示 OFF だけを残す（RPC は「この回だけ・解除・止める」で受ける）
          { op: "save", eventId: target.id, scope: "event", action: "clear", garbageKind: null, reminder: "off", seen }
        : { op: "save", eventId: target.id, scope, action: mode, garbageKind, reminder, seen }
    if (!isGarbageRequest(request)) {
      setError("入力内容を確認してください。")
      return
    }
    setError(null)
    onSubmit(request, mode === "mute" ? garbageMuteLabel(target.title) : garbageRequestLabel(request, target.title))
  }

  const scopeHint =
    scope === null
      ? "繰り返しの予定です。この回だけに付けるか、すべての回に付けるかを選んでください。"
      : scope === "series"
        ? "この予定のすべての回が対象です（これから追加される回も含みます）。"
        : target.isSeries
          ? "この回だけが対象です。ほかの回は変わりません。"
          : "この予定だけが対象です。"

  return (
    <div className="flex flex-col gap-4" data-testid="garbage-purpose-form">
      <p className="text-sm break-words">
        <span className="font-medium">「{target.title}」</span>
        <span className="text-muted-foreground tabular-nums">　{target.whenLabel}</span>
      </p>

      {target.isSeries && lockedScope === undefined ? (
        <div className="flex flex-col gap-2">
          <p id={`${baseId}-scope`} className="flex items-center gap-1.5 text-sm font-medium">
            <Repeat size={14} aria-hidden="true" />
            変更する範囲
          </p>
          <div className="flex gap-1.5" role="group" aria-labelledby={`${baseId}-scope`}>
            <button
              type="button"
              aria-pressed={scope === "event"}
              onClick={() => chooseScope("event")}
              className={cn(segmentCn(scope === "event"), "cursor-pointer")}
            >
              この回だけ
            </button>
            <button
              type="button"
              aria-pressed={scope === "series"}
              onClick={() => chooseScope("series")}
              className={cn(segmentCn(scope === "series"), "cursor-pointer")}
            >
              シリーズ全体
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{scopeHint}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          範囲: {scope === "series" ? "シリーズ全体。" : ""}
          {scopeHint}
        </p>
      )}

      {modes.length > 1 && (
        <div className="flex flex-col gap-2">
          <p id={`${baseId}-mode`} className="text-sm font-medium">
            操作
          </p>
          <div className="flex flex-col gap-1.5" role="group" aria-labelledby={`${baseId}-mode`}>
            {modes.map((m) => (
              <ChoiceButton key={m} pressed={mode === m} onClick={() => chooseMode(m)}>
                {m === "garbage" && labelAt(scope) !== null ? "名称・通知を変える" : MODE_LABELS[m]}
              </ChoiceButton>
            ))}
          </div>
        </div>
      )}

      {mode === "garbage" && (
        <div className="flex flex-col gap-2">
          <p id={`${baseId}-kind`} className="text-sm font-medium">
            ごみの名称
          </p>
          <div className="grid grid-cols-2 gap-1.5" role="group" aria-labelledby={`${baseId}-kind`}>
            {GARBAGE_KIND_PRESETS.map((preset) => (
              <ChoiceButton
                key={preset.label}
                pressed={kind === preset.label}
                onClick={() => {
                  setKind(preset.label)
                  setError(null)
                }}
              >
                <GarbageKindIcon label={preset.label} size={16} />
                <span className="min-w-0 break-words">{preset.label}</span>
              </ChoiceButton>
            ))}
            <ChoiceButton
              pressed={kind === CUSTOM}
              onClick={() => {
                setKind(CUSTOM)
                setError(null)
              }}
            >
              <GarbageKindIcon label={null} size={16} />
              <span className="min-w-0 break-words">その他（入力する）</span>
            </ChoiceButton>
          </div>
          {kind === CUSTOM && (
            <div className="flex flex-col gap-1">
              <Input
                aria-label={`ごみの名称（${GARBAGE_KIND_MAX}文字まで）`}
                value={customText}
                onChange={(e) => {
                  setCustomText(e.target.value)
                  setError(null)
                }}
                placeholder="例: 乾電池、剪定枝"
                className="h-11"
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                お住まいの地域での呼び名を 1〜{GARBAGE_KIND_MAX} 文字で入力できます。
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p id={`${baseId}-reminder`} className="flex items-center gap-1.5 text-sm font-medium">
          <BellRing size={14} aria-hidden="true" />
          今回の保存での通知
        </p>
        {reminderChoices.length > 0 && (
          <div className="flex flex-col gap-1.5" role="group" aria-labelledby={`${baseId}-reminder`}>
            {reminderChoices.map((choice) => (
              <ChoiceButton
                key={choice}
                pressed={reminder === choice}
                onClick={() => {
                  setReminder(choice)
                  setError(null)
                }}
              >
                {REMINDER_LABELS[choice]}
              </ChoiceButton>
            ))}
          </div>
        )}
        {/* 選んだ扱いで実際に何が起きるかを、保存の前に文で言う（範囲ごとに違う。前日 20:00 を
            過ぎた回には「通知します」と言わぬ） */}
        <p className="text-xs text-muted-foreground" data-testid="garbage-reminder-effect">
          {mode === "mute" ? GARBAGE_MUTE_EFFECT : garbageReminderEffect(reminder, scope ?? "event", prevDayPassed)}
        </p>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={submit} disabled={disabled} className="cursor-pointer">
          {mode === "clear"
            ? "解除する"
            : mode === "normal"
              ? "通常の予定に戻す"
              : mode === "mute"
                ? "通知だけ止める"
                : "分類を保存"}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel} className="cursor-pointer">
            やめる
          </Button>
        )}
      </div>
    </div>
  )
}

/** 選択肢の 1 つ（44px 以上。選択中は枠 + 地に加えてチェックの印を出す）。 */
function ChoiceButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-ring",
        pressed
          ? "border-primary bg-primary/10 font-medium text-foreground dark:bg-primary/20"
          : "border-border bg-transparent text-foreground hover:bg-muted/60 dark:hover:bg-muted/30",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
      {pressed && <Check size={16} className="shrink-0 text-primary" aria-hidden="true" />}
    </button>
  )
}
