"use client"

import { useId, useState } from "react"
import Link from "next/link"
import { Minus, Plus, Undo2 } from "lucide-react"

import { ChangedElsewhereNotice } from "@/components/chores/meals/basics/changed-elsewhere-notice"
import {
  ChoiceGroup,
  FeedbackChoiceFields,
  isEmptyFeedback,
  type FeedbackChoiceValue,
} from "@/components/chores/meals/shared/feedback-choices"
import { MEALS_PANTRY_HREF } from "@/components/chores/meals/shared/meal-routes"
import { Button } from "@/components/ui/button"
import { formatMealDateWithRelative } from "@/lib/meals/server/format"
import {
  GROCERY_HORIZON_DAYS,
  type CookedPantryUpdate,
  type DinnerRequest,
} from "@/lib/meals/server/plan-requests"
import type { DinnerEntryView } from "@/lib/meals/server/plan-views"
import { newClientId } from "@/lib/utils/client-id"
import { shiftYmd } from "@/lib/utils/date-jst"

import { NATIVE_SELECT, TEXT_LINK } from "./link-styles"
import type { PlanRequest } from "./meal-request"
import { PlanCustomDishForm } from "./plan-custom-dish-form"
import type { CookedPantryOption, CustomIngredientView, EntryFeedbackView } from "./plan-types"

/** 1 枠の人数の範囲（要求の型ガード `isSetDinnerServingsRequest` と同じ 1〜12）。 */
const SERVINGS_MIN = 1
const SERVINGS_MAX = 12

const PANTRY_CHOICES: readonly { value: CookedPantryUpdate["status"]; label: string }[] = [
  { value: "have", label: "まだある" },
  { value: "low", label: "残り少ない" },
  { value: "out", label: "使い切った" },
]

function MoveForm({
  entry,
  today,
  disabled,
  send,
}: {
  entry: DinnerEntryView
  today: string
  disabled: boolean
  send: (request: DinnerRequest) => boolean
}) {
  const selectId = useId()
  const dates = Array.from({ length: GROCERY_HORIZON_DAYS }, (_, index) => shiftYmd(today, index)).filter(
    (date) => date !== entry.date,
  )
  const [toDate, setToDate] = useState(dates[0] ?? "")
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">日付を移動</h3>
      <p className="text-sm text-muted-foreground">
        固定は料理に付いて行きます。移動先の料理はそのまま残します（入れ替えません）。
      </p>
      <label htmlFor={selectId} className="text-sm font-medium">
        移動先の日
      </label>
      <select
        id={selectId}
        className={NATIVE_SELECT}
        value={toDate}
        onChange={(event) => setToDate(event.target.value)}
      >
        {dates.map((date) => (
          <option key={date} value={date}>
            {formatMealDateWithRelative(date, today)}
          </option>
        ))}
      </select>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || toDate === ""}
        onClick={() => send({ op: "move", entryId: entry.id, version: entry.version, toDate })}
      >
        この日へ移動
      </Button>
    </section>
  )
}

/**
 * この料理だけ人数を変える（R45）。固定した料理・確定した料理も変えられる（料理・固定・状態はそのまま）。
 *
 * 触るまでは料理の今の人数を映す。**入力を始めた時点の版を固定して送る** — 入力の途中で料理の版が
 * 進んだら（家族が人数や料理を変えた）、古い入力に新しい版を付けて送らず、保存を止めて知らせる。
 */
function ServingsForm({
  entry,
  householdServings,
  disabled,
  send,
}: {
  entry: DinnerEntryView
  householdServings: number
  disabled: boolean
  send: (request: PlanRequest) => boolean
}) {
  const labelId = useId()
  const [draft, setDraft] = useState<{ version: string; servings: number } | null>(null)
  const servings = draft?.servings ?? entry.servings
  const changedElsewhere = draft !== null && draft.version !== entry.version
  const dirty = servings !== entry.servings
  const change = (next: number) =>
    setDraft((prev) => ({ version: prev?.version ?? entry.version, servings: Math.min(SERVINGS_MAX, Math.max(SERVINGS_MIN, next)) }))

  return (
    <section className="flex flex-col gap-2" data-testid="entry-servings">
      <h3 id={labelId} className="text-sm font-semibold">
        人数
      </h3>
      {changedElsewhere && <ChangedElsewhereNotice what="この料理" ownChangePossible onReload={() => setDraft(null)} />}
      <p className="text-sm text-muted-foreground">
        この料理だけ人数を変えます。買い物の量は、この料理の人数で計算します（設定の人数は{householdServings}人分）。
        {entry.isCustom && "手で入れた料理の材料の量は、人数を変えても変わりません。"}
      </p>
      <div role="group" aria-labelledby={labelId} className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="人数を1人減らす"
          disabled={servings <= SERVINGS_MIN}
          onClick={() => change(servings - 1)}
        >
          <Minus size={18} aria-hidden="true" />
        </Button>
        {/* 増減の結果を読み上げる */}
        <p data-testid="entry-servings-value" aria-live="polite" className="min-w-16 text-center text-lg font-semibold">
          {servings}人分
        </p>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="人数を1人増やす"
          disabled={servings >= SERVINGS_MAX}
          onClick={() => change(servings + 1)}
        >
          <Plus size={18} aria-hidden="true" />
        </Button>
        {servings !== householdServings && (
          <Button type="button" variant="ghost" onClick={() => change(householdServings)}>
            設定の人数にする
          </Button>
        )}
      </div>
      <Button
        type="button"
        variant="outline"
        className="self-start"
        disabled={disabled || changedElsewhere || !dirty}
        onClick={() => {
          if (changedElsewhere || !dirty) return
          // 版は入力を始めた時点のもの
          send({ op: "servings", entryId: entry.id, version: draft?.version ?? entry.version, servings })
        }}
      >
        人数を保存
      </Button>
    </section>
  )
}

function CookedPantryForm({
  options,
  disabled,
  send,
}: {
  options: CookedPantryOption[]
  disabled: boolean
  send: (request: DinnerRequest) => boolean
}) {
  const [choices, setChoices] = useState<Record<string, CookedPantryUpdate["status"]>>({})
  // 版が変わった食材（別の端末の更新・自分の更新の後）の選択は使わない
  const updates: CookedPantryUpdate[] = options.flatMap((option) => {
    const status = choices[`${option.id}|${option.version}`]
    return status === undefined ? [] : [{ id: option.id, version: option.version, status }]
  })

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">使った食材の状態を更新</h3>
      <p className="text-sm text-muted-foreground">
        食材は自動では減らしません。状態を変えたい食材だけ選んでください。選ばなかった食材はそのままです。
      </p>
      {options.length === 0 ? (
        <div className="flex flex-col items-start gap-1 text-sm">
          <p>この料理の材料に当たる食材は、登録されていません。</p>
          <Link href={MEALS_PANTRY_HREF} prefetch={false} className={TEXT_LINK}>
            食材の画面で確認する
          </Link>
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {options.map((option) => {
              const key = `${option.id}|${option.version}`
              return (
                <li key={key} className="flex flex-col gap-1">
                  <ChoiceGroup
                    label={`${option.name}（今: ${option.statusLabel}・${option.quantityText}）`}
                    options={PANTRY_CHOICES}
                    value={choices[key] ?? null}
                    onChange={(next) =>
                      setChoices((prev) => {
                        const { [key]: _removed, ...rest } = prev
                        void _removed
                        return next === null ? rest : { ...rest, [key]: next }
                      })
                    }
                  />
                </li>
              )
            })}
          </ul>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={disabled || updates.length === 0}
            onClick={() => send({ op: "pantry_after_cooking", updates })}
          >
            選んだ食材を更新（{updates.length}件）
          </Button>
        </>
      )}
    </section>
  )
}

function FeedbackForm({
  entry,
  saved,
  disabled,
  send,
}: {
  entry: DinnerEntryView
  saved: EntryFeedbackView | null
  disabled: boolean
  send: (request: DinnerRequest) => boolean
}) {
  const [value, setValue] = useState<FeedbackChoiceValue>({
    taste: saved?.taste ?? null,
    effort: saved?.effort ?? null,
    again: saved?.again ?? null,
    excludeFromLearning: saved?.excludeFromLearning ?? false,
  })
  const { taste, effort, again } = value
  const exclude = value.excludeFromLearning

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">食後の評価</h3>
      <p className="text-sm text-muted-foreground">
        あなたの評価として記録します（家族の評価とは別です）。味・手間・また食べたいかは、それぞれ分けて記録します。
      </p>
      <FeedbackChoiceFields value={value} onChange={(patch) => setValue((prev) => ({ ...prev, ...patch }))} />
      <Button
        type="button"
        className="self-start"
        disabled={disabled || isEmptyFeedback(value)}
        onClick={() =>
          send({
            op: "feedback",
            // 記録済みの評価はその ID と版で直す。新規は送る時に 1 回だけ ID を作る
            id: saved?.id ?? newClientId(),
            version: saved?.version ?? null,
            recipeId: entry.recipeId,
            dishTitle: entry.title,
            eatenOn: entry.date,
            taste,
            effort,
            again,
            excludeFromLearning: exclude,
          })
        }
      >
        {saved === null ? "評価を記録" : "評価を更新"}
      </Button>
    </section>
  )
}

function RemoveSection({
  entry,
  disabled,
  send,
}: {
  entry: DinnerEntryView
  disabled: boolean
  send: (request: DinnerRequest) => boolean
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">献立から外す</h3>
      {confirming ? (
        <>
          <p className="text-sm text-muted-foreground">
            「{entry.title}」をこの日の献立から外します。家族の端末からも見えなくなります。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => send({ op: "delete", entryId: entry.id, version: entry.version })}
            >
              外す
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              やめる
            </Button>
          </div>
        </>
      ) : (
        <Button type="button" variant="outline" className="self-start" onClick={() => setConfirming(true)}>
          この料理を献立から外す
        </Button>
      )}
    </section>
  )
}

/**
 * 1 品の操作（下シートの中身）。枠の状態で出す操作が変わる:
 *
 * - 提案・確定: 日付の移動、人数の変更、手動料理の材料の編集、献立から外す
 * - 作った: 使った食材の状態の更新（**利用者が選んだ食材だけ**）、食後の評価、取り消し
 * - 作らなかった: 取り消し（「作らなかった」は好みの評価に使わない）
 */
export function PlanEntryPanel({
  entry,
  dayLabel,
  today,
  householdServings,
  pantry,
  feedback,
  custom,
  disabled,
  saving,
  send,
  onClose,
}: {
  entry: DinnerEntryView
  dayLabel: string
  today: string
  /** 世帯の設定の人数（1 品の人数の変更で、設定とのずれを示す）。渡されなければ人数の変更を出さない。 */
  householdServings?: number
  pantry: CookedPantryOption[]
  feedback: EntryFeedbackView | null
  /** 手動料理の材料（手動料理でなければ null）。 */
  custom: CustomIngredientView[] | null
  disabled: boolean
  saving: boolean
  send: (request: PlanRequest) => boolean
  onClose: () => void
}) {
  const active = entry.status === "proposed" || entry.status === "confirmed"
  // 取り消しで戻る先（作る前に提案だった料理は提案へ。確定へ戻すと、買い物に無かった料理が買い物へ入る）
  const restoreLabel = entry.restoreTo === "proposed" ? "提案" : "確定"

  return (
    <div className="flex flex-col gap-6">
      {/* 過ぎた日の、まだ作っていない料理も、今日以降へ移せる */}
      {active && <MoveForm entry={entry} today={today} disabled={disabled} send={send} />}

      {/* 固定した料理・確定した料理も、人数だけを変えられる（作った料理は変えない） */}
      {active && householdServings !== undefined && (
        <ServingsForm entry={entry} householdServings={householdServings} disabled={disabled} send={send} />
      )}

      {active && entry.isCustom && custom !== null && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">料理名と材料</h3>
          <PlanCustomDishForm
            // 保存で版が進んだら、入力を保存済みの内容から作り直す
            key={entry.version}
            editing={{
              id: entry.id,
              version: entry.version,
              title: entry.title,
              role: entry.role,
              ingredients: custom,
            }}
            date={entry.date}
            dateLabel={dayLabel}
            disabled={disabled}
            saving={saving}
            onSubmit={send}
            onCancel={onClose}
          />
        </section>
      )}

      {entry.status === "cooked" && (
        <>
          <CookedPantryForm options={pantry} disabled={disabled} send={send} />
          <FeedbackForm
            key={feedback === null ? "new" : `${feedback.id}:${feedback.version}`}
            entry={entry}
            saved={feedback}
            disabled={disabled}
            send={send}
          />
        </>
      )}

      {(entry.status === "cooked" || entry.status === "skipped") && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">記録を取り消す</h3>
          <p className="text-sm text-muted-foreground">
            {entry.status === "cooked"
              ? `「作った」を取り消して、${restoreLabel}へ戻します。買い物リストで使ったことにした購入は戻ります。更新した食材の状態と評価は、そのまま残ります。`
              : `「作らなかった」を取り消して、${restoreLabel}へ戻します。「作らなかった」は好みの評価には使っていません。`}
          </p>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            disabled={disabled}
            onClick={() => send({ op: "restore", entryId: entry.id, version: entry.version })}
          >
            <Undo2 aria-hidden="true" />
            {entry.status === "cooked" ? "「作った」を取り消す" : "「作らなかった」を取り消す"}
          </Button>
        </section>
      )}

      {active && <RemoveSection entry={entry} disabled={disabled} send={send} />}
    </div>
  )
}
