"use client"

import { useId, useState } from "react"
import { Check, Loader2, Pencil, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react"

import {
  FeedbackChoiceFields,
  isEmptyFeedback,
  type FeedbackChoiceValue,
} from "@/components/chores/meals/shared/feedback-choices"
import { Button } from "@/components/ui/button"
import { dishRoleLabel, formatMealDateShort } from "@/lib/meals/server/format"
import {
  SETTINGS_INPUT_MESSAGES,
  saveFoodPreferenceIssue,
  type SaveFoodPreferenceRequest,
} from "@/lib/meals/server/settings-requests"
import type { SettingsFeedbackView, SettingsPreferenceView, SettingsView } from "@/lib/meals/server/views"
import type { FoodPreference } from "@/lib/meals/types"
import { cn } from "@/lib/utils"
import { newClientId } from "@/lib/utils/client-id"
import { segmentCn } from "@/lib/utils/segment-cn"

import { ChangedElsewhereNotice } from "../basics/changed-elsewhere-notice"
import {
  MARK_BADGE_CLASS,
  MARK_NEUTRAL_TONE,
  MARK_OK_TONE,
  NATIVE_SELECT_CLASS,
} from "../basics/field-classes"

const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"

type Scope = FoodPreference["scope"]
type Sentiment = FoodPreference["sentiment"]
type TargetKind = FoodPreference["target"]["kind"]

const SCOPE_LABELS: Record<Scope, string> = { household: "家族共通", personal: "自分" }
const SCOPES: readonly Scope[] = ["household", "personal"]
const SENTIMENT_LABELS: Record<Sentiment, string> = { like: "好き", dislike: "苦手" }
const SENTIMENTS: readonly Sentiment[] = ["like", "dislike"]
const TARGET_KIND_LABELS: Record<TargetKind, string> = { recipe: "料理", ingredient: "食材", tag: "タグ" }
const TARGET_KINDS: readonly TargetKind[] = ["recipe", "ingredient", "tag"]

function SentimentMark({ sentiment }: { sentiment: Sentiment }) {
  const Icon = sentiment === "like" ? ThumbsUp : ThumbsDown
  return (
    <span className={cn(MARK_BADGE_CLASS, sentiment === "like" ? MARK_OK_TONE : MARK_NEUTRAL_TONE)}>
      <Icon size={14} className="shrink-0" aria-hidden="true" />
      {SENTIMENT_LABELS[sentiment] ?? "好み"}
    </span>
  )
}

// ── 好み（明示して登録したもの） ───────────────────────────────────

/**
 * 登録した好みの一覧。家族共通と個人を分けて出し、誰の好みかを書く。
 * 変えられるのは、家族共通の好みと、見ている本人の個人の好みだけ（ほかの家族の個人の好みは見るだけ）。
 */
export function PreferenceList({
  preferences,
  unreadable,
  disabled,
  busyId,
  onFlip,
  onDelete,
}: {
  preferences: SettingsPreferenceView[]
  unreadable: number
  disabled: boolean
  busyId: string | null
  onFlip: (preference: SettingsPreferenceView) => void
  onDelete: (preference: SettingsPreferenceView) => void
}) {
  const headingId = useId()
  const groups: { key: string; label: string; items: SettingsPreferenceView[] }[] = [
    { key: "household", label: "家族共通", items: preferences.filter((item) => item.scope === "household") },
    {
      key: "mine",
      label: "自分",
      items: preferences.filter((item) => item.scope === "personal" && item.editable),
    },
    {
      key: "others",
      label: "ほかの家族（見るだけ）",
      items: preferences.filter((item) => item.scope === "personal" && !item.editable),
    },
  ].filter((group) => group.items.length > 0)

  return (
    <div className={CARD}>
      <p className="text-sm font-semibold">登録した好み（{preferences.length}件）</p>
      {unreadable > 0 && (
        <p role="alert" className="text-sm text-foreground">
          読み取れない好みが {unreadable} 件あります。その分は提案に使っていません。
        </p>
      )}
      {preferences.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {unreadable > 0 ? "表示できる好みがありません。" : "好みは、まだ登録されていません。"}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <p id={`${headingId}-${group.key}`} className="text-xs font-semibold text-muted-foreground">
            {group.label}
          </p>
          <ul aria-labelledby={`${headingId}-${group.key}`} className="flex flex-col divide-y divide-border/60">
            {group.items.map((preference) => {
              const flipped: Sentiment = preference.sentiment === "like" ? "dislike" : "like"
              return (
                <li key={preference.id} data-testid="settings-preference" className="flex flex-col gap-2 py-3 first:pt-1">
                  <div className="flex flex-col gap-1">
                    <p className="text-base font-medium break-words [overflow-wrap:anywhere]">
                      {preference.targetLabel}
                    </p>
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                      <SentimentMark sentiment={preference.sentiment} />
                      <span>{TARGET_KIND_LABELS[preference.target.kind] ?? "対象"}</span>
                      <span className="break-words">{preference.ownerLabel}</span>
                    </p>
                    {!preference.targetKnown && (
                      <p className="text-xs text-muted-foreground">
                        今の一覧にない対象です。提案には使っていません（削除はできます）。
                      </p>
                    )}
                  </div>
                  {preference.editable && (
                    <div className="flex flex-wrap gap-2">
                      {preference.targetKnown && (
                        <Button
                          type="button"
                          variant="outline"
                          aria-label={`${preference.targetLabel}（${preference.ownerLabel}）を「${SENTIMENT_LABELS[flipped]}」に変える`}
                          disabled={disabled}
                          onClick={() => onFlip(preference)}
                        >
                          {busyId === preference.id && <Loader2 className="animate-spin" aria-hidden="true" />}
                          「{SENTIMENT_LABELS[flipped]}」に変える
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`${preference.targetLabel}（${preference.ownerLabel}）の好みを削除`}
                        disabled={disabled}
                        onClick={() => onDelete(preference)}
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </Button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * 好みの登録。家族共通／自分、対象（料理・食材・タグ）、好き／苦手を選ぶ。
 * 個人の好みの持ち主は常に送った本人（要求に持ち主の項目は無く、DB が決める）。
 */
export function PreferenceForm({
  options,
  disabled,
  saving,
  onSubmit,
}: {
  options: SettingsView["preferenceOptions"]
  disabled: boolean
  saving: boolean
  onSubmit: (request: SaveFoodPreferenceRequest, targetLabel: string) => boolean
}) {
  const formId = useId()
  const [scope, setScope] = useState<Scope>("household")
  const [kind, setKind] = useState<TargetKind>("recipe")
  const [targetId, setTargetId] = useState("")
  const [sentiment, setSentiment] = useState<Sentiment>("like")
  const [error, setError] = useState<string | null>(null)

  const targetOptions: { id: string; label: string }[] =
    kind === "recipe"
      ? options.recipes.map((recipe) => ({ id: recipe.id, label: `${recipe.title}（${dishRoleLabel(recipe.role)}）` }))
      : kind === "ingredient"
        ? options.ingredients.map((ingredient) => ({ id: ingredient.id, label: ingredient.name }))
        : options.tags.map((tag) => ({ id: tag.id, label: tag.label }))

  function submit() {
    const chosen = targetOptions.find((option) => option.id === targetId)
    if (!chosen) {
      setError(`${TARGET_KIND_LABELS[kind]}を選んでください。`)
      return
    }
    const request: SaveFoodPreferenceRequest = {
      id: newClientId(),
      version: null,
      scope,
      target: { kind, id: chosen.id },
      sentiment,
    }
    const issue = saveFoodPreferenceIssue(request)
    if (issue !== null) {
      setError(SETTINGS_INPUT_MESSAGES[issue])
      return
    }
    setError(null)
    onSubmit(request, chosen.label)
  }

  const segment = <T extends string>(
    labelId: string,
    values: readonly T[],
    labels: Record<T, string>,
    current: T,
    onChange: (value: T) => void,
  ) => (
    <div role="group" aria-labelledby={labelId} className="flex gap-1 rounded-xl bg-muted/50 p-1">
      {values.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={current === value}
          onClick={() => onChange(value)}
          className={cn(
            segmentCn(current === value),
            "inline-flex cursor-pointer items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-ring",
          )}
        >
          {current === value && <Check size={14} className="shrink-0" aria-hidden="true" />}
          {labels[value]}
        </button>
      ))}
    </div>
  )

  return (
    <form
      noValidate
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled) submit()
      }}
    >
      <p className="text-sm font-semibold">好みを追加</p>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-scope`} className="text-sm font-medium">
          誰の好みか
        </p>
        {segment(`${formId}-scope`, SCOPES, SCOPE_LABELS, scope, setScope)}
        <p className="text-xs text-muted-foreground">
          「家族共通」は家族の誰でも変更できます。「自分」は自分だけが変更でき、家族にも表示されます。
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-kind`} className="text-sm font-medium">
          対象の種類
        </p>
        {segment(`${formId}-kind`, TARGET_KINDS, TARGET_KIND_LABELS, kind, (value) => {
          setKind(value)
          setTargetId("")
          setError(null)
        })}
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-target`} className="text-sm font-medium">
          {TARGET_KIND_LABELS[kind]}
        </label>
        <select
          id={`${formId}-target`}
          className={NATIVE_SELECT_CLASS}
          value={targetId}
          onChange={(event) => {
            setTargetId(event.target.value)
            setError(null)
          }}
        >
          <option value="">選んでください</option>
          {targetOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-sentiment`} className="text-sm font-medium">
          好き・苦手
        </p>
        {segment(`${formId}-sentiment`, SENTIMENTS, SENTIMENT_LABELS, sentiment, setSentiment)}
        <p className="text-xs text-muted-foreground">
          ここの「苦手」は順位を下げるだけです。必ず外したいものは、上の「使わない食材」に登録してください。
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="self-start" disabled={disabled}>
        {saving && <Loader2 className="animate-spin" aria-hidden="true" />}
        好みを登録
      </Button>
    </form>
  )
}

// ── 覚えた好み（食後の評価） ───────────────────────────────────────

function againLabel(again: boolean | null): string {
  if (again === null) return "未回答"
  return again ? "はい" : "いいえ"
}

/** 自分の評価を直すのに要る値（Server Component が読んだ行から渡す。表示用の一覧には無い）。 */
export interface FeedbackEditSeed {
  /** 開いた時点の版（`updated_at` の表記のまま）。 */
  version: string
  /** 保存されている料理名（レシピの評価でも、記録した時の名前が入っている）。 */
  dishTitle: string
}

/** 編集中の評価。版は、編集を開いた時点のものを固定する。 */
interface FeedbackEditing {
  id: string
  version: string
  value: FeedbackChoiceValue
}

/**
 * 「覚えた好み」= 食後の評価の一覧（誰が・いつ・何を・味／手間／また食べたい）。
 * 評価は本人のもので、直せるのも削除できるのも本人だけ。削除した評価は、次の提案にも理由にも使わない。
 *
 * 編集（C-75）は、献立の画面に出なくなった古い評価（7 日より前）もここから直せるようにするもの。
 * 送る版は**編集を開いた時点の版**（開いたまま別の端末が同じ評価を変えたら、保存を止めて知らせる）。
 */
export function FeedbackList({
  feedback,
  since,
  unreadable,
  disabled,
  busyId,
  editSeeds = {},
  onDelete,
  onSave,
  onDraftChange,
}: {
  feedback: SettingsFeedbackView[]
  /** 評価を読んだ範囲の開始日。 */
  since: string
  unreadable: number
  disabled: boolean
  busyId: string | null
  /** 評価の ID → 編集に要る値。**自分の評価の分だけ**（無い行には編集の釦を出さない）。 */
  editSeeds?: Record<string, FeedbackEditSeed>
  onDelete: (feedback: SettingsFeedbackView) => void
  /** 受け付けたら true。`version` は編集を開いた時点の版。 */
  onSave?: (feedback: SettingsFeedbackView, seed: FeedbackEditSeed, version: string, value: FeedbackChoiceValue) => boolean
  /** 編集を開いているか（釦だけで変わる未保存の入力）を伝える。 */
  onDraftChange?: (hasDraft: boolean) => void
}) {
  const [confirming, setConfirming] = useState<string | null>(null)
  const [editing, setEditing] = useState<FeedbackEditing | null>(null)
  const seedOf = (id: string): FeedbackEditSeed | null =>
    Object.prototype.hasOwnProperty.call(editSeeds, id) ? editSeeds[id] : null

  function openEditor(row: SettingsFeedbackView, seed: FeedbackEditSeed) {
    setConfirming(null)
    setEditing({
      id: row.id,
      version: seed.version,
      value: { taste: row.taste, effort: row.effort, again: row.again, excludeFromLearning: row.excludeFromLearning },
    })
    onDraftChange?.(true)
  }

  function closeEditor() {
    setEditing(null)
    onDraftChange?.(false)
  }

  return (
    <div className={CARD}>
      <p className="text-sm text-muted-foreground">
        食後に付けた評価です（{formatMealDateShort(since)}以降の {feedback.length} 件）。「前回おいしいと答えた」などの理由は、ここにある記録だけから作ります。自分の評価は、ここで直すことも削除することもできます（献立の画面に出なくなった古い評価も含みます）。削除した評価は次の提案から使いません。
      </p>
      {unreadable > 0 && (
        <p role="alert" className="text-sm text-foreground">
          読み取れない評価が {unreadable} 件あります。その分は提案に使っていません。
        </p>
      )}
      {feedback.length === 0 ? (
        <p className="text-sm">
          {unreadable > 0
            ? "表示できる評価がありません。"
            : "まだ評価がありません。献立で「作った」料理に評価を付けると、ここに表示されます。"}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {feedback.map((row) => {
            const seed = row.mine ? seedOf(row.id) : null
            const isEditing = editing !== null && editing.id === row.id
            // 編集を開いた後に、同じ評価が別の端末（献立の画面など）で変わった
            const changedElsewhere = isEditing && (seed === null || seed.version !== editing.version)
            return (
            <li key={row.id} data-testid="settings-feedback" className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-sm text-muted-foreground">
                    <span className="break-words">{row.who}</span>
                    {row.mine && "（自分）"}・{formatMealDateShort(row.eatenOn)}
                  </p>
                  <p className="text-base font-medium break-words [overflow-wrap:anywhere]">{row.dishTitle}</p>
                  <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">味:</dt>
                      <dd>{row.tasteLabel ?? "未回答"}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">手間:</dt>
                      <dd>{row.effortLabel ?? "未回答"}</dd>
                    </div>
                    <div className="flex gap-1">
                      <dt className="text-muted-foreground">また食べたい:</dt>
                      <dd>{againLabel(row.again)}</dd>
                    </div>
                  </dl>
                  {row.excludeFromLearning && (
                    <p className={cn(MARK_BADGE_CLASS, MARK_NEUTRAL_TONE, "w-fit")}>好みに反映しない記録</p>
                  )}
                </div>
                {row.mine && (
                  <div className="flex shrink-0 gap-2">
                    {seed !== null && onSave !== undefined && (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        aria-label={`${formatMealDateShort(row.eatenOn)}の「${row.dishTitle}」の評価を編集`}
                        aria-expanded={isEditing}
                        disabled={disabled}
                        onClick={() => (isEditing ? closeEditor() : openEditor(row, seed))}
                      >
                        <Pencil size={18} aria-hidden="true" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={`${formatMealDateShort(row.eatenOn)}の「${row.dishTitle}」の評価を削除`}
                      disabled={disabled}
                      onClick={() => {
                        if (isEditing) closeEditor()
                        setConfirming(row.id)
                      }}
                    >
                      {busyId === row.id ? (
                        <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Trash2 size={18} aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
              {isEditing && (
                <div
                  role="group"
                  aria-label={`${formatMealDateShort(row.eatenOn)}の「${row.dishTitle}」の評価の編集`}
                  className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/40 p-3"
                >
                  {changedElsewhere && (
                    <ChangedElsewhereNotice
                      what="この評価"
                      onReload={() => (seed === null ? closeEditor() : openEditor(row, seed))}
                    />
                  )}
                  <FeedbackChoiceFields
                    value={editing.value}
                    onChange={(patch) =>
                      setEditing((prev) => (prev === null ? prev : { ...prev, value: { ...prev.value, ...patch } }))
                    }
                  />
                  {isEmptyFeedback(editing.value) && (
                    <p className="text-sm text-muted-foreground">
                      味・手間・また食べたいかの、どれかを選んでください。評価そのものを消すときは、削除を使います。
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      disabled={disabled || changedElsewhere || isEmptyFeedback(editing.value)}
                      onClick={() => {
                        if (changedElsewhere || seed === null || onSave === undefined) return
                        onSave(row, seed, editing.version, editing.value)
                      }}
                    >
                      {busyId === row.id && <Loader2 className="animate-spin" aria-hidden="true" />}
                      評価を更新
                    </Button>
                    <Button type="button" variant="outline" onClick={closeEditor}>
                      やめる
                    </Button>
                  </div>
                </div>
              )}
              {confirming === row.id && (
                <>
                  <p className="text-sm text-muted-foreground">
                    この評価を削除します。元に戻せません。削除した評価は、次の提案と理由の表示から使いません。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={disabled}
                      onClick={() => {
                        setConfirming(null)
                        onDelete(row)
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
