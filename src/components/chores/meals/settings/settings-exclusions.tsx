"use client"

import { useId, useState } from "react"
import Link from "next/link"
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleCheck,
  CircleHelp,
  ExternalLink,
  Loader2,
  ShieldAlert,
  ThumbsDown,
  Trash2,
} from "lucide-react"

import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { PinnedMark, VerdictMark } from "@/components/chores/meals/shared/meal-marks"
import { MEALS_PLAN_HREF } from "@/components/chores/meals/shared/meal-routes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { EXCLUSION_REASON_LABELS, dishRoleLabel, formatMealDate } from "@/lib/meals/server/format"
import {
  EXCLUSION_LABEL_MAX,
  SETTINGS_INPUT_MESSAGES,
  saveFoodExclusionIssue,
  type PlanConflictReport,
  type SaveFoodExclusionRequest,
} from "@/lib/meals/server/settings-requests"
import type { SettingsExclusionView, SettingsView } from "@/lib/meals/server/views"
import type { ExclusionReason, FoodExclusion } from "@/lib/meals/types"
import { cn } from "@/lib/utils"
import { newClientId } from "@/lib/utils/client-id"
import { segmentCn } from "@/lib/utils/segment-cn"

import {
  MARK_ALERT_TONE,
  MARK_BADGE_CLASS,
  MARK_NEUTRAL_TONE,
  MARK_WARN_TONE,
  NATIVE_SELECT_CLASS,
  chipClass,
} from "../basics/field-classes"
import { EXCLUSION_REGISTERED_TEXTS, type ExclusionPreviewText } from "./exclusion-lexicon"

const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"

/** 表示義務・表示推奨の別（階層の公式の呼称に添える）。 */
const TIER_DUTY_LABELS: Record<SettingsView["allergens"]["items"][number]["tier"], string> = {
  mandatory: "表示義務",
  recommended: "表示推奨",
}

const REASONS: readonly ExclusionReason[] = ["allergy", "dislike"]
type TargetKind = FoodExclusion["target"]["kind"]
const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  allergen: "対象品目から",
  ingredient: "食材から",
  custom: "自由に入力",
}
const TARGET_KINDS: readonly TargetKind[] = ["allergen", "ingredient", "custom"]

function ReasonMark({ reason, label }: { reason: ExclusionReason; label: string }) {
  const Icon = reason === "allergy" ? ShieldAlert : ThumbsDown
  return (
    <span className={cn(MARK_BADGE_CLASS, reason === "allergy" ? MARK_ALERT_TONE : MARK_NEUTRAL_TONE)}>
      <Icon size={14} className="shrink-0" aria-hidden="true" />
      {label}
    </span>
  )
}

// ── 登録済みの一覧 ─────────────────────────────────────────────────

export function ExclusionList({
  exclusions,
  customNotes = {},
  unreadable,
  disabled,
  busyId,
  onDelete,
}: {
  exclusions: SettingsExclusionView[]
  /**
   * 自由入力の除外が、今の食材の一覧で何に解決するか（除外の ID → 説明）。
   * 判定できない除外（何も外せていない・献立の自動の確定を止めている）に印を付ける。
   */
  customNotes?: Record<string, ExclusionPreviewText>
  /** 読めなかった除外の行の数。 */
  unreadable: number
  disabled: boolean
  /** 削除を送信中の除外の ID。 */
  busyId: string | null
  onDelete: (exclusion: SettingsExclusionView) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  return (
    <div className={CARD}>
      <p className="text-sm font-semibold">登録済み（{exclusions.length}件）</p>
      {unreadable > 0 && (
        <p role="alert" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span>
            読み取れない設定が {unreadable} 件あります。全部は表示できていません。外すべき食材が分からないため、読み取れるまで献立と提案は表示しません。アプリを更新すると読み取れる場合があります。
          </span>
        </p>
      )}
      {exclusions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {unreadable > 0 ? "表示できる設定がありません。" : "使わない食材は、まだ登録されていません。"}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {exclusions.map((exclusion) => {
            const isConfirming = confirming === exclusion.id
            const note = Object.prototype.hasOwnProperty.call(customNotes, exclusion.id) ? customNotes[exclusion.id] : null
            const undetermined = note !== null && (note.kind === "holds" || note.kind === "no_effect")
            return (
              <li key={exclusion.id} data-testid="settings-exclusion" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="text-base font-medium break-words [overflow-wrap:anywhere]">{exclusion.targetLabel}</p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <ReasonMark reason={exclusion.reason} label={exclusion.reasonLabel} />
                      <span className="break-words">{exclusion.subjectLabel}</span>
                    </p>
                    {note !== null && undetermined ? (
                      // 判定できない除外: 「外している」と読める表示にしない（何が起きているかを言う）
                      <div data-testid="settings-exclusion-undetermined" className="flex flex-col gap-1">
                        <p className={cn(MARK_BADGE_CLASS, MARK_WARN_TONE, "w-fit")}>
                          <CircleHelp size={14} className="shrink-0" aria-hidden="true" />
                          自動では判定できません
                        </p>
                        <p className="text-sm break-words text-foreground">
                          {note.kind === "holds" ? EXCLUSION_REGISTERED_TEXTS.holds : EXCLUSION_REGISTERED_TEXTS.no_effect}
                        </p>
                      </div>
                    ) : note !== null ? (
                      <p className="text-xs break-words text-muted-foreground">{note.effect}</p>
                    ) : (
                      exclusion.limited && (
                        <p className="text-xs text-muted-foreground">
                          食材の一覧にない名前のため、食材や料理の名前に含まれるかどうかで判定します。
                        </p>
                      )
                    )}
                    {!exclusion.targetKnown && (
                      <p className="text-xs text-muted-foreground">
                        今の一覧にない品目です（記号のまま表示しています）。判定には引き続き使います。
                      </p>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={`${exclusion.targetLabel}（${exclusion.reasonLabel}・${exclusion.subjectLabel}）を削除`}
                    disabled={disabled}
                    onClick={() => setConfirming(exclusion.id)}
                  >
                    {busyId === exclusion.id ? (
                      <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 size={18} aria-hidden="true" />
                    )}
                  </Button>
                </div>
                {isConfirming && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {note !== null && note.kind === "holds"
                        ? `削除すると、「${exclusion.targetLabel}」のために止めていた献立の自動の確定が、再び使えるようになります。`
                        : note !== null && note.kind === "no_effect"
                          ? `「${exclusion.targetLabel}」は何も除外していないため、削除しても献立と提案は変わりません。`
                          : `削除すると、「${exclusion.targetLabel}」を含む料理が献立と提案に出るようになります。`}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="destructive"
                        disabled={disabled}
                        onClick={() => {
                          setConfirming(null)
                          onDelete(exclusion)
                        }}
                      >
                        削除する
                      </Button>
                      <Button type="button" variant="outline" onClick={() => setConfirming(null)}>
                        やめる
                      </Button>
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

// ── 登録フォーム ───────────────────────────────────────────────────

/**
 * 「使わない食材」の登録。アレルギー／苦手、誰の分か、対象（消費者庁の対象品目・食材・自由入力）を選ぶ。
 *
 * - 対象品目の件数は、渡された一覧の長さから出す（数字を文に埋め込まない）。出典・版・確認日を添える。
 * - 行 ID は送信の時に 1 回だけ作る。保存は親（`onSubmit`）が行う。
 * - 自由入力は、**登録の前に**何に解決するかを示す（`previewCustom`）。食材の一覧と照合できない入力は
 *   「必ず外します」と言わず、登録すると何が起きるか（アレルギー = 献立を自動では確定しなくなる／
 *   苦手 = 何も除外されない）を言う。登録そのものは止めない（選ぶのは利用者）。
 */
export function ExclusionForm({
  allergens,
  ingredientOptions,
  members,
  childOptions,
  disabled,
  saving,
  previewCustom,
  onSubmit,
  onDraftChange,
}: {
  allergens: SettingsView["allergens"]
  ingredientOptions: SettingsView["ingredientOptions"]
  members: SettingsView["members"]
  childOptions: { id: string; name: string }[]
  disabled: boolean
  saving: boolean
  /**
   * 自由入力が何に解決するか（サーバーの判定と同じ規則）。語彙を渡されていない画面では undefined
   * （そのときは「登録の後に一覧で確認」と言う。照合できたとは言わない）。
   */
  previewCustom?: (label: string, reason: ExclusionReason) => ExclusionPreviewText
  /** 受け付けたら true。`targetLabel` は控えと通知に使う表示名。 */
  onSubmit: (request: SaveFoodExclusionRequest, targetLabel: string) => boolean
  /** 釦だけで変わる未保存の選択（理由・品目のチップ・対象の選び方）に触れたことを伝える。 */
  onDraftChange?: (hasDraft: boolean) => void
}) {
  const formId = useId()
  const [reason, setReason] = useState<ExclusionReason>("allergy")
  const [subjectKey, setSubjectKey] = useState("household")
  const [kind, setKind] = useState<TargetKind>("allergen")
  const [allergenId, setAllergenId] = useState<string | null>(null)
  const [ingredientId, setIngredientId] = useState("")
  const [label, setLabel] = useState("")
  const [error, setError] = useState<string | null>(null)

  // 自由入力が何に解決するか。上限を超えた入力・空の入力は判定しない（登録もできない）
  const trimmedLabel = label.trim()
  const customPreview =
    kind === "custom" && trimmedLabel !== "" && [...trimmedLabel].length <= EXCLUSION_LABEL_MAX && previewCustom
      ? previewCustom(trimmedLabel, reason)
      : null
  const customUndetermined =
    customPreview !== null && (customPreview.kind === "holds" || customPreview.kind === "no_effect")

  const tiers = (["mandatory", "recommended"] as const).map((tier) => ({
    tier,
    items: allergens.items.filter((item) => item.tier === tier),
  }))
  const ingredientSections: { label: string; items: SettingsView["ingredientOptions"] }[] = []
  for (const option of ingredientOptions) {
    const section = ingredientSections.find((candidate) => candidate.label === option.sectionLabel)
    if (section) section.items.push(option)
    else ingredientSections.push({ label: option.sectionLabel, items: [option] })
  }

  function subjectOf(): FoodExclusion["subject"] | null {
    if (subjectKey === "household") return { kind: "household" }
    const [prefix, id] = subjectKey.split(":")
    if (prefix === "member" && members.some((member) => member.id === id)) return { kind: "member", profileId: id }
    if (prefix === "child" && childOptions.some((child) => child.id === id)) return { kind: "child", childId: id }
    return null
  }

  function submit() {
    const subject = subjectOf()
    if (subject === null) {
      setError(SETTINGS_INPUT_MESSAGES.subject)
      return
    }
    let target: FoodExclusion["target"]
    let targetLabel: string
    if (kind === "allergen") {
      const chosen = allergens.items.find((item) => item.id === allergenId)
      if (!chosen) {
        setError("対象の品目を選んでください。")
        return
      }
      target = { kind: "allergen", allergenId: chosen.id }
      targetLabel = chosen.name
    } else if (kind === "ingredient") {
      const chosen = ingredientOptions.find((option) => option.id === ingredientId)
      if (!chosen) {
        setError("食材を選んでください。")
        return
      }
      target = { kind: "ingredient", ingredientId: chosen.id }
      targetLabel = chosen.name
    } else {
      target = { kind: "custom", label: label.trim() }
      targetLabel = label.trim()
    }
    const request: SaveFoodExclusionRequest = { id: newClientId(), reason, target, subject }
    const issue = saveFoodExclusionIssue(request)
    if (issue !== null) {
      setError(SETTINGS_INPUT_MESSAGES[issue])
      return
    }
    setError(null)
    onSubmit(request, targetLabel)
  }

  return (
    <form
      noValidate
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
      <p className="text-sm font-semibold">使わない食材を追加</p>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-reason`} className="text-sm font-medium">
          理由
        </p>
        <div role="group" aria-labelledby={`${formId}-reason`} className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {REASONS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={reason === value}
              onClick={() => {
                setReason(value)
                onDraftChange?.(true)
              }}
              className={cn(
                segmentCn(reason === value),
                "inline-flex cursor-pointer items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-ring",
              )}
            >
              {reason === value && <Check size={14} className="shrink-0" aria-hidden="true" />}
              {EXCLUSION_REASON_LABELS[value]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          一覧から選んだ品目・食材は、アレルギー・苦手のどちらで登録しても、献立と提案から必ず外します（点数や AI で緩めません）。自由に入力した名前は、食材の一覧と照合できた場合に限って外します。
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-subject`} className="text-sm font-medium">
          誰の分か
        </label>
        <select
          id={`${formId}-subject`}
          className={NATIVE_SELECT_CLASS}
          value={subjectKey}
          onChange={(event) => setSubjectKey(event.target.value)}
        >
          <option value="household">家族全体</option>
          {members.map((member) => (
            <option key={member.id} value={`member:${member.id}`}>
              {member.displayName}
              {member.isViewer ? "（自分）" : ""}
            </option>
          ))}
          {childOptions.map((child) => (
            <option key={child.id} value={`child:${child.id}`}>
              {child.name}（子ども）
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          誰の分で登録しても、家族全員の献立から外します（表示のための区別です）。
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-kind`} className="text-sm font-medium">
          対象の選び方
        </p>
        <div role="group" aria-labelledby={`${formId}-kind`} className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {TARGET_KINDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value)
                setError(null)
                onDraftChange?.(true)
              }}
              className={`${segmentCn(kind === value)} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
            >
              {TARGET_KIND_LABELS[value]}
            </button>
          ))}
        </div>
      </div>

      {kind === "allergen" && (
        <div className="flex flex-col gap-3">
          <p data-testid="settings-allergen-count" className="text-sm">
            消費者庁が表示の対象としている {allergens.items.length} 品目から選べます。
          </p>
          {tiers.map(({ tier, items }) => (
            <div key={tier} className="flex flex-col gap-1">
              <p id={`${formId}-tier-${tier}`} className="text-xs font-semibold text-muted-foreground">
                {items[0]?.tierLabel ?? ""}（{TIER_DUTY_LABELS[tier]}・{items.length}品目）
              </p>
              <ul aria-labelledby={`${formId}-tier-${tier}`} className="flex flex-wrap gap-2">
                {items.map((item) => {
                  const on = allergenId === item.id
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setAllergenId(on ? null : item.id)
                          setError(null)
                          onDraftChange?.(true)
                        }}
                        className={chipClass(on)}
                      >
                        {on && <Check size={14} className="shrink-0" aria-hidden="true" />}
                        {item.name}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <p className="font-semibold">一覧の出典</p>
            <a
              href={allergens.meta.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg text-sm text-foreground underline decoration-border underline-offset-4 transition-colors duration-200 hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{allergens.meta.sourceTitle}</span>
              <ExternalLink size={14} className="shrink-0" aria-hidden="true" />
              <span className="sr-only">（新しいタブで開きます）</span>
            </a>
            <p className="break-words">
              版: {allergens.meta.version}・確認日: {allergens.meta.confirmedOn}
            </p>
            <p className="break-words">{allergens.versionNote}</p>
          </div>
          <MealNotice kind="allergenList" />
        </div>
      )}

      {kind === "ingredient" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${formId}-ingredient`} className="text-sm font-medium">
            食材
          </label>
          <select
            id={`${formId}-ingredient`}
            className={NATIVE_SELECT_CLASS}
            value={ingredientId}
            onChange={(event) => {
              setIngredientId(event.target.value)
              setError(null)
            }}
          >
            <option value="">選んでください</option>
            {ingredientSections.map((section) => (
              <optgroup key={section.label} label={section.label}>
                {section.items.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <p className="text-xs text-muted-foreground">
            選んだ食材と、その食材から作られる食材（例: 大豆を選ぶと豆腐やみそ）を使う料理を外します。
          </p>
        </div>
      )}

      {kind === "custom" && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${formId}-label`} className="text-sm font-medium">
            名前（{EXCLUSION_LABEL_MAX}文字まで）
          </label>
          <Input
            id={`${formId}-label`}
            className="h-11"
            value={label}
            maxLength={EXCLUSION_LABEL_MAX * 2}
            placeholder="例: パクチー"
            aria-describedby={`${formId}-label-preview`}
            onChange={(event) => {
              setLabel(event.target.value)
              setError(null)
            }}
          />
          {/* 入力に合わせて変わる確認。打つたびに割り込まないよう、控えめに読み上げる（polite） */}
          <div id={`${formId}-label-preview`} aria-live="polite" className="flex flex-col gap-1">
            {customPreview !== null &&
              (customUndetermined ? (
                <div
                  data-testid="exclusion-preview"
                  data-kind={customPreview.kind}
                  className="flex flex-col gap-1 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm text-foreground"
                >
                  <p className="flex items-start gap-2 font-semibold">
                    <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                    <span className="min-w-0 break-words">{customPreview.lead}</span>
                  </p>
                  <p className="break-words">{customPreview.effect}</p>
                  {/* 判定できない語は「適用済み」にしない。具体的な品目・食材を選び直す道を、その場に出す */}
                  <div className="flex flex-wrap gap-2" data-testid="exclusion-reselect">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setKind("allergen")
                        setError(null)
                        onDraftChange?.(true)
                      }}
                    >
                      対象品目から選び直す
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        setKind("ingredient")
                        setError(null)
                        onDraftChange?.(true)
                      }}
                    >
                      食材から選び直す
                    </Button>
                  </div>
                </div>
              ) : (
                <p
                  data-testid="exclusion-preview"
                  data-kind={customPreview.kind}
                  className="flex items-start gap-2 text-sm text-foreground"
                >
                  {customPreview.kind === "resolved" ? (
                    <CircleCheck
                      size={16}
                      className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400"
                      aria-hidden="true"
                    />
                  ) : (
                    <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0 break-words">{customPreview.effect}</span>
                </p>
              ))}
            {kind === "custom" && trimmedLabel !== "" && previewCustom === undefined && (
              <p className="text-sm text-foreground">
                この入力が食材の一覧と照合できるかは、登録の後に一覧で確認してください。照合できない入力は、献立から外せません。
              </p>
            )}
          </div>
          <MealNotice kind="customExclusion" />
        </div>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={disabled}>
        {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
        使わない食材に登録
      </Button>
      {customUndetermined && (
        <p className="text-xs text-muted-foreground">
          このまま登録することもできますが、上の注意のとおりに扱われます。
        </p>
      )}
    </form>
  )
}

// ── 献立との重なり ─────────────────────────────────────────────────

/**
 * 「使わない食材」と、今日以降の献立（提案・確定の枠。固定を含む）の重なり。
 * **献立は書き換えていない**ことを言い、該当の日・料理を並べて、献立の画面へ送る。
 *
 * @param report null = 確かめられなかった（「重なりは無い」と言わない）。
 * @param highlightIds この画面で登録した除外の ID（該当する行に印を付ける）。
 */
export function PlanConflictPanel({
  report,
  highlightIds,
}: {
  report: PlanConflictReport | null
  highlightIds: readonly string[]
}) {
  const headingId = useId()
  const planLink = (
    <Link
      href={MEALS_PLAN_HREF}
      prefetch={false}
      className="inline-flex min-h-11 min-w-11 items-center gap-1 self-start rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring dark:border-input dark:bg-input/30"
    >
      献立で選び直す
      <ChevronRight size={16} aria-hidden="true" />
    </Link>
  )

  return (
    <section aria-labelledby={headingId} className={CARD}>
      <h3 id={headingId} className="text-sm font-semibold">
        今の献立との重なり
      </h3>
      {report !== null && report.holdMessage !== null && report.holdMessage !== undefined && (
        // 判定できないアレルギーの登録のために、提案・確定の全ての料理が「確認が必要」に並んでいる。
        // 料理ごとの問題ではなく、登録が原因であることを先に言う
        <p data-testid="settings-conflict-hold" className="flex items-start gap-2 text-sm text-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {report.holdMessage}
            下の料理は、料理そのものの材料の問題ではなく、この登録のために「確認が必要」になっています。
          </span>
        </p>
      )}
      {report === null ? (
        <>
          <p role="alert" className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              献立との重なりを確かめられませんでした。重なりが無いとは限りません。献立の画面で確認してください。
            </span>
          </p>
          {planLink}
        </>
      ) : report.conflicts.length === 0 ? (
        <>
          <p className="flex items-start gap-2 text-sm">
            <CircleCheck size={16} className="mt-0.5 shrink-0 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
            <span>
              今日以降の献立に、使わない食材と重なる料理は見つかりませんでした。
              {report.unreadableEntries > 0 &&
                `ただし、読み取れない献立が ${report.unreadableEntries} 件あり、その分は確かめられていません。`}
            </span>
          </p>
          {report.unreadableEntries > 0 && planLink}
        </>
      ) : (
        <>
          <p role="alert" className="flex items-start gap-2 text-sm">
            <AlertCircle size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
            <span>
              今日以降の献立に、使わない食材と重なる料理が {report.conflicts.length} 件あります。献立は自動では変えていません（固定した料理も含みます）。献立の画面で選び直してください。
            </span>
          </p>
          <ul aria-labelledby={headingId} className="flex flex-col divide-y divide-border/60">
            {report.conflicts.map((conflict) => {
              const fromThisChange =
                conflict.causedByThisChange || conflict.exclusionIds.some((id) => highlightIds.includes(id))
              return (
                <li key={conflict.entryId} data-testid="settings-plan-conflict" className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                    <span>{formatMealDate(conflict.date)}</span>
                    <span>{dishRoleLabel(conflict.role)}</span>
                    {conflict.pinned && <PinnedMark />}
                  </p>
                  <p className="text-base font-medium break-words [overflow-wrap:anywhere]">{conflict.title}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <VerdictMark verdict={conflict.verdict} />
                    {fromThisChange && (
                      <span className={cn(MARK_BADGE_CLASS, MARK_NEUTRAL_TONE)}>今回の登録に該当</span>
                    )}
                  </div>
                  {conflict.ingredientNames.length > 0 && (
                    <p className="text-sm break-words text-muted-foreground">
                      該当する材料: {conflict.ingredientNames.join("・")}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
          {report.unreadableEntries > 0 && (
            <p className="text-sm text-muted-foreground">
              読み取れない献立が {report.unreadableEntries} 件あり、その分は確かめられていません。
            </p>
          )}
          {planLink}
        </>
      )}
    </section>
  )
}
