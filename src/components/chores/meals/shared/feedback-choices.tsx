"use client"

import { CheckButton } from "@/components/chores/shared/check-button"
import { segmentCn } from "@/lib/utils/segment-cn"

/**
 * 食後の評価の入力（味・手間・また食べたいか・好みに反映しない）。
 *
 * 献立の 1 品シート（作った直後の記録）と、設定の「覚えた好み」（後からの編集。C-75）が同じ部品を使う。
 * 選択肢の語は `src/lib/meals/preferences.ts` の `TASTE_LABELS` / `EFFORT_LABELS` と同じ意味（3 = よい側）。
 */

export type FeedbackRating = 1 | 2 | 3

export interface FeedbackChoiceValue {
  taste: FeedbackRating | null
  effort: FeedbackRating | null
  again: boolean | null
  excludeFromLearning: boolean
}

export const FEEDBACK_TASTE_OPTIONS: readonly { value: FeedbackRating; label: string }[] = [
  { value: 3, label: "おいしい" },
  { value: 2, label: "ふつう" },
  { value: 1, label: "苦手" },
]
export const FEEDBACK_EFFORT_OPTIONS: readonly { value: FeedbackRating; label: string }[] = [
  { value: 3, label: "楽だった" },
  { value: 2, label: "ふつう" },
  { value: 1, label: "大変だった" },
]
export const FEEDBACK_AGAIN_OPTIONS: readonly { value: boolean; label: string }[] = [
  { value: true, label: "また食べたい" },
  { value: false, label: "しばらくいい" },
]

/** 味・手間・また食べたいかの、どれも選ばれていない（記録する中身が無い）。 */
export function isEmptyFeedback(value: FeedbackChoiceValue): boolean {
  return value.taste === null && value.effort === null && value.again === null
}

/** 1 つを選ぶ釦の組（もう一度押すと未選択へ戻る）。選択は塗りと `aria-pressed` で示す。 */
export function ChoiceGroup<T extends string | number | boolean>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: T; label: string }[]
  value: T | null
  onChange: (next: T | null) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div role="group" aria-label={label} className="flex gap-1 rounded-xl bg-muted/50 p-1">
        {options.map((option) => {
          const selected = value === option.value
          return (
            <button
              key={String(option.value)}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(selected ? null : option.value)}
              className={`${segmentCn(selected)} cursor-pointer focus-visible:outline-2 focus-visible:outline-ring`}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** 評価の 4 項目の入力欄。保存の釦と文は、使う側が持つ。 */
export function FeedbackChoiceFields({
  value,
  onChange,
}: {
  value: FeedbackChoiceValue
  onChange: (patch: Partial<FeedbackChoiceValue>) => void
}) {
  return (
    <>
      <ChoiceGroup label="味" options={FEEDBACK_TASTE_OPTIONS} value={value.taste} onChange={(taste) => onChange({ taste })} />
      <ChoiceGroup
        label="手間"
        options={FEEDBACK_EFFORT_OPTIONS}
        value={value.effort}
        onChange={(effort) => onChange({ effort })}
      />
      <ChoiceGroup
        label="また食べたいか"
        options={FEEDBACK_AGAIN_OPTIONS}
        value={value.again}
        onChange={(again) => onChange({ again })}
      />
      <div className="flex items-center gap-2">
        <CheckButton
          checked={value.excludeFromLearning}
          onCheckedChange={(excludeFromLearning) => onChange({ excludeFromLearning })}
          label="好みに反映しない"
        />
        <span className="text-sm">
          好みに反映しない
          <span className="block text-xs text-muted-foreground">
            その日の気分や体調によるもので、次の提案には使ってほしくないとき。
          </span>
        </span>
      </div>
    </>
  )
}
