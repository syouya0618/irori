"use client"

import { useId, useState, type ReactNode } from "react"
import Link from "next/link"
import { Check, ChevronRight, CircleHelp, Loader2, Minus, Plus } from "lucide-react"

import { MealNotice } from "@/components/chores/meals/shared/meal-notices"
import { Button } from "@/components/ui/button"
import type { GuardianMealStage } from "@/lib/meals/child-serving"
import { formatServings } from "@/lib/meals/server/format"
import { DINNER_SERVINGS_MAX, DINNER_SERVINGS_MIN, type DinnerSettings } from "@/lib/meals/server/rows"
import {
  MAX_COOK_MINUTES_MAX,
  MAX_COOK_MINUTES_MIN,
  STAPLES_MAX,
  type SaveDinnerSettingsRequest,
} from "@/lib/meals/server/settings-requests"
import type { SettingsChildView, SettingsStapleView, SettingsView } from "@/lib/meals/server/views"
import { cn } from "@/lib/utils"
import { segmentCn } from "@/lib/utils/segment-cn"

import { ChangedElsewhereNotice } from "../basics/changed-elsewhere-notice"
import { NATIVE_SELECT_CLASS, chipClass } from "../basics/field-classes"

const CARD = "glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"

/** 1 枚のカードが変える項目（残りは、サーバーが持っている今の値のまま送る）。 */
export type DinnerSettingsPatch = Partial<
  Pick<SaveDinnerSettingsRequest, "servings" | "includeSoup" | "maxCookMinutes" | "stapleIngredientIds" | "childStages">
>

/**
 * 設定の版の扱い（3 枚のカードに共通）。
 *
 * 設定（人数ほか）は 1 行で、版も 1 つ。カードは「触った時点の版」を入力と一緒に固定する。触った後に
 * 設定の版が進んだら、それが**この画面の自分の保存**（別のカードの保存）で進んだものかを親に尋ね、
 * そうでなければ（家族が別の端末で変えた）保存を止めて知らせる — 古い入力に新しい版を付けて送ると、
 * DB の版の照合が素通りし、家族の変更を古い入力で黙って巻き戻す。
 */
export interface SettingsVersionGuard {
  /** サーバーが持つ今の設定の版（未登録の世帯は null）。 */
  version: string | null
  /** `from` の版から `to` の版までが、この画面の自分の保存だけで進んだものか（同じ版なら true）。 */
  isOwnLineage: (from: string | null, to: string | null) => boolean
  /** 自分の保存の結果が、まだ画面へ届いていない（届くまで、古い値をもとにした保存を止める）。 */
  catchingUp: boolean
}

interface CardProps {
  /** 新しい保存を受けられない（送信中・確認待ち）。 */
  disabled: boolean
  saving: boolean
  guard: SettingsVersionGuard
  /**
   * 受け付けたら true。`baseVersion` は、入力を始めた時点の設定の版（触っていなければ今の版）。
   * 親は、その版から今の版までが自分の保存だけで進んだときにだけ送る。
   */
  onSave: (patch: DinnerSettingsPatch, baseVersion: string | null) => boolean
  /** 未保存の入力を持っているかを伝える（釦だけで変わる入力は、自動の取り直しの見送りに自動では数えられない）。 */
  onDraftChange?: (hasDraft: boolean) => void
}

function SaveButton({
  dirty,
  enabled = dirty,
  disabled,
  saving,
  catchingUp,
  label,
}: {
  /** 入力が、サーバーの今の値と違う。 */
  dirty: boolean
  /** 保存の釦を押せる（既定は `dirty`。未設定の世帯は、標準の値のままでも保存できる）。 */
  enabled?: boolean
  disabled: boolean
  saving: boolean
  catchingUp: boolean
  label: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={disabled || catchingUp || !enabled}>
          {saving && enabled && <Loader2 className="animate-spin" aria-hidden="true" />}
          {label}
        </Button>
        {dirty && <p className="text-sm text-muted-foreground">まだ保存していない変更があります。</p>}
      </div>
      {catchingUp && enabled && (
        <p role="status" className="text-sm text-muted-foreground">
          先ほど保存した設定を読み込んでいます。読み込めたら保存できます（進まないときは、画面の下の「今すぐ更新」を押してください）。
        </p>
      )}
    </div>
  )
}

/** 入力と、入力を始めた時点の設定の版（未登録の世帯は null）。 */
interface Versioned<T> {
  version: string | null
  value: T
}

const COOK_MINUTE_CHOICES = [15, 20, 30, 45, 60, 90, 120] as const

// ── 人数・汁物・調理時間 ───────────────────────────────────────────

interface BasicsDraft {
  servings: number
  includeSoup: boolean
  maxCookMinutes: number | null
}

/**
 * 人数・汁物・調理時間の上限。未設定の世帯には、標準の人数で計算していることを明示する
 * （保存するまでは未設定のまま。勝手に登録しない）。
 */
export function DinnerBasicsCard({
  settings,
  settingsMissing,
  disabled,
  saving,
  guard,
  onSave,
  onDraftChange,
}: CardProps & { settings: DinnerSettings; settingsMissing: boolean }) {
  const formId = useId()
  // 触るまでは、サーバーの今の値をそのまま見せる。触った時点の版を、入力と一緒に固定する
  const [draft, setDraft] = useState<Versioned<BasicsDraft> | null>(null)
  const value: BasicsDraft = draft?.value ?? {
    servings: settings.servings,
    includeSoup: settings.includeSoup,
    maxCookMinutes: settings.maxCookMinutes,
  }
  const dirty =
    draft !== null &&
    (value.servings !== settings.servings ||
      value.includeSoup !== settings.includeSoup ||
      value.maxCookMinutes !== settings.maxCookMinutes)
  // 触った後に、家族が別の端末で設定を変えた（自分の別のカードの保存で進んだ分は数えない）
  const changedElsewhere = draft !== null && !guard.isOwnLineage(draft.version, guard.version)
  // 未設定の世帯は、標準の値のままでも「保存」で登録できる
  const canSave = (dirty || settingsMissing) && !changedElsewhere

  const minuteChoices: number[] = [...COOK_MINUTE_CHOICES]
  if (
    value.maxCookMinutes !== null &&
    !minuteChoices.includes(value.maxCookMinutes) &&
    value.maxCookMinutes >= MAX_COOK_MINUTES_MIN &&
    value.maxCookMinutes <= MAX_COOK_MINUTES_MAX
  ) {
    minuteChoices.push(value.maxCookMinutes)
    minuteChoices.sort((a, b) => a - b)
  }

  function change(patch: Partial<BasicsDraft>) {
    setDraft((prev) => ({ version: prev !== null ? prev.version : guard.version, value: { ...value, ...patch } }))
    onDraftChange?.(true)
  }

  function reloadLatest() {
    setDraft(null)
    onDraftChange?.(false)
  }

  return (
    <form
      noValidate
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !guard.catchingUp && canSave) onSave(value, draft !== null ? draft.version : guard.version)
      }}
    >
      {changedElsewhere && dirty && <ChangedElsewhereNotice what="設定" onReload={reloadLatest} />}
      {settingsMissing && <MealNotice kind="defaultServings" />}

      <div className="flex flex-col gap-1">
        <p id={`${formId}-servings`} className="text-sm font-medium">
          作る人数
        </p>
        <div role="group" aria-labelledby={`${formId}-servings`} className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="人数を1人減らす"
            disabled={value.servings <= DINNER_SERVINGS_MIN}
            onClick={() => change({ servings: Math.max(DINNER_SERVINGS_MIN, value.servings - 1) })}
          >
            <Minus size={18} aria-hidden="true" />
          </Button>
          {/* 増減の結果を読み上げる（保存の結果の文（role="status"）とは別にする） */}
          <p data-testid="settings-servings" aria-live="polite" className="min-w-16 text-center text-lg font-semibold">
            {formatServings(value.servings)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="人数を1人増やす"
            disabled={value.servings >= DINNER_SERVINGS_MAX}
            onClick={() => change({ servings: Math.min(DINNER_SERVINGS_MAX, value.servings + 1) })}
          >
            <Plus size={18} aria-hidden="true" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          材料の量と買い物の量を、この人数で計算します。子どもの量を年齢から大人の何割と換算することはしていません。
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <p id={`${formId}-soup`} className="text-sm font-medium">
          汁物
        </p>
        <div role="group" aria-labelledby={`${formId}-soup`} className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              aria-pressed={value.includeSoup === option}
              onClick={() => change({ includeSoup: option })}
              className={cn(
                segmentCn(value.includeSoup === option),
                "inline-flex cursor-pointer items-center justify-center gap-1 focus-visible:outline-2 focus-visible:outline-ring",
              )}
            >
              {value.includeSoup === option && <Check size={14} className="shrink-0" aria-hidden="true" />}
              {option ? "献立に付ける" : "付けない"}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={`${formId}-minutes`} className="text-sm font-medium">
          1 品あたりの調理時間の上限
        </label>
        <select
          id={`${formId}-minutes`}
          className={NATIVE_SELECT_CLASS}
          value={value.maxCookMinutes === null ? "" : String(value.maxCookMinutes)}
          onChange={(event) => change({ maxCookMinutes: event.target.value === "" ? null : Number(event.target.value) })}
        >
          <option value="">上限なし</option>
          {minuteChoices.map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes}分まで
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          上限に収まる料理を先に選びます。収まる料理が足りないときは、超える料理をその旨と一緒に示します。
        </p>
      </div>

      <SaveButton
        dirty={dirty}
        enabled={canSave}
        disabled={disabled}
        saving={saving}
        catchingUp={guard.catchingUp}
        label="基本の設定を保存"
      />
    </form>
  )
}

// ── 常備品 ─────────────────────────────────────────────────────────

/**
 * 常備品（いつも家にあるものとして「ある」と数える食材）。**初めは何も選ばれていない**
 * （油や調味料を、暗黙に在庫ありと数えない）。候補は提示するだけで、選ぶのは世帯。
 */
export function DinnerStaplesCard({
  staples,
  disabled,
  saving,
  guard,
  onSave,
  onDraftChange,
}: CardProps & { staples: SettingsStapleView[] }) {
  const headingId = useId()
  const known = staples.filter((staple) => staple.known)
  const unknownCount = staples.length - known.length
  const savedIds = known.filter((staple) => staple.selected).map((staple) => staple.id)
  const [draft, setDraft] = useState<Versioned<string[]> | null>(null)
  const selected = draft?.value ?? savedIds
  const dirty =
    draft !== null && (selected.length !== savedIds.length || selected.some((id) => !savedIds.includes(id)))
  const changedElsewhere = draft !== null && !guard.isOwnLineage(draft.version, guard.version)
  const canSave = dirty && !changedElsewhere

  const sections: { label: string; items: SettingsStapleView[] }[] = []
  for (const staple of known) {
    const section = sections.find((candidate) => candidate.label === staple.sectionLabel)
    if (section) section.items.push(staple)
    else sections.push({ label: staple.sectionLabel, items: [staple] })
  }

  function toggle(id: string) {
    const next = selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id]
    setDraft((prev) => ({ version: prev !== null ? prev.version : guard.version, value: next }))
    onDraftChange?.(true)
  }

  function reloadLatest() {
    setDraft(null)
    onDraftChange?.(false)
  }

  return (
    <form
      noValidate
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !guard.catchingUp && canSave) {
          onSave({ stapleIngredientIds: selected.slice(0, STAPLES_MAX) }, draft !== null ? draft.version : guard.version)
        }
      }}
    >
      {changedElsewhere && dirty && <ChangedElsewhereNotice what="設定" onReload={reloadLatest} />}
      <p className="text-sm text-muted-foreground">
        いつも家にあるものだけを選んでください。選んだ食材は、食材に登録していなくても「ある」と数えます。初めは何も選ばれていません。
      </p>
      <p data-testid="settings-staple-count" className="text-sm font-medium">
        {selected.length === 0 ? "常備品は選ばれていません。" : `${selected.length}件を選択中`}
      </p>
      {sections.map((section) => (
        <div key={section.label} className="flex flex-col gap-1">
          <p id={`${headingId}-${section.label}`} className="text-xs font-semibold text-muted-foreground">
            {section.label}
          </p>
          <ul aria-labelledby={`${headingId}-${section.label}`} className="flex flex-wrap gap-2">
            {section.items.map((staple) => {
              const on = selected.includes(staple.id)
              return (
                <li key={staple.id}>
                  <button type="button" aria-pressed={on} onClick={() => toggle(staple.id)} className={chipClass(on)}>
                    {on && <Check size={14} className="shrink-0" aria-hidden="true" />}
                    {staple.name}
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
      {unknownCount > 0 && (
        <p className="flex items-start gap-2 text-sm">
          <CircleHelp size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>
            食材の一覧にない常備品が {unknownCount} 件保存されています（提案には使っていません）。次に設定を保存すると外れます。
          </span>
        </p>
      )}
      <SaveButton
        dirty={dirty}
        enabled={canSave}
        disabled={disabled}
        saving={saving}
        catchingUp={guard.catchingUp}
        label="常備品を保存"
      />
    </form>
  )
}

// ── 子どもの食事の段階 ─────────────────────────────────────────────

/**
 * 子どもの食事の段階。**保護者が選ぶ**（月齢から決めつけない。月齢の目安は添えるだけで、
 * 初期値にもしない）。段階は取り分け案内の表示にだけ使う。
 */
export function DinnerChildStagesCard({
  childViews,
  stageOptions,
  stageHints,
  guide,
  disabled,
  saving,
  guard,
  onSave,
  onDraftChange,
}: CardProps & {
  childViews: SettingsChildView[]
  stageOptions: SettingsView["stageOptions"]
  /** child_id → 月齢からの目安の文。 */
  stageHints: Record<string, string>
  /** 離乳の段階の一般案内（Server Component が描いたもの）。 */
  guide?: ReactNode
}) {
  const formId = useId()
  const isOption = (value: string | null): value is GuardianMealStage =>
    value !== null && stageOptions.some((option) => option.value === value)
  const savedOf = (child: SettingsChildView): GuardianMealStage | null => (isOption(child.stage) ? child.stage : null)
  const [draft, setDraft] = useState<Versioned<Record<string, GuardianMealStage | null>> | null>(null)
  const valueOf = (child: SettingsChildView): GuardianMealStage | null =>
    draft !== null && Object.prototype.hasOwnProperty.call(draft.value, child.childId)
      ? draft.value[child.childId]
      : savedOf(child)
  const dirty = childViews.some((child) => valueOf(child) !== savedOf(child))
  const changedElsewhere = draft !== null && !guard.isOwnLineage(draft.version, guard.version)
  const canSave = dirty && !changedElsewhere

  function submit() {
    const childStages: Record<string, GuardianMealStage> = {}
    for (const child of childViews) {
      const stage = valueOf(child)
      if (stage !== null) childStages[child.childId] = stage
    }
    onSave({ childStages }, draft !== null ? draft.version : guard.version)
  }

  function reloadLatest() {
    setDraft(null)
    onDraftChange?.(false)
  }

  return (
    <form
      noValidate
      className={CARD}
      onSubmit={(event) => {
        event.preventDefault()
        if (!disabled && !guard.catchingUp && canSave) submit()
      }}
    >
      {changedElsewhere && dirty && <ChangedElsewhereNotice what="設定" onReload={reloadLatest} />}
      <p className="text-sm text-muted-foreground">
        食事の段階は保護者が選びます。月齢だけでは発達や食べている物は分からないため、自動では決めません。選んだ段階は、レシピの取り分け案内を出すかどうかにだけ使います。
      </p>

      {childViews.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">お子さんが登録されていません。登録すると、ここで食事の段階を選べます。</p>
          <Link
            href="/children"
            prefetch={false}
            className="inline-flex min-h-11 min-w-11 items-center gap-1 rounded-lg border border-border bg-background px-3 text-sm font-medium transition-colors duration-200 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring dark:border-input dark:bg-input/30"
          >
            子どもの管理へ
            <ChevronRight size={16} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {childViews.map((child) => {
            const selectId = `${formId}-${child.childId}`
            const unreadableStage = child.stage !== null && !isOption(child.stage)
            return (
              <li key={child.childId} data-testid="settings-child" className="flex flex-col gap-1">
                <label htmlFor={selectId} className="text-sm font-medium break-words [overflow-wrap:anywhere]">
                  {child.name}
                  <span className="font-normal text-muted-foreground">
                    （{child.ageLabel ?? "生年月日は未登録"}）
                  </span>
                </label>
                <select
                  id={selectId}
                  className={NATIVE_SELECT_CLASS}
                  value={valueOf(child) ?? ""}
                  onChange={(event) => {
                    const next = event.target.value
                    setDraft((prev) => ({
                      version: prev !== null ? prev.version : guard.version,
                      value: { ...(prev?.value ?? {}), [child.childId]: isOption(next) ? next : null },
                    }))
                    onDraftChange?.(true)
                  }}
                >
                  <option value="">未設定</option>
                  {stageOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {unreadableStage && (
                  <p className="text-sm text-foreground">
                    保存されている段階を、このアプリで読み取れません。選び直してください。
                  </p>
                )}
                {Object.prototype.hasOwnProperty.call(stageHints, child.childId) && (
                  <p className="text-xs break-words text-muted-foreground">{stageHints[child.childId]}</p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {childViews.length > 0 && (
        <SaveButton
          dirty={dirty}
          enabled={canSave}
          disabled={disabled}
          saving={saving}
          catchingUp={guard.catchingUp}
          label="食事の段階を保存"
        />
      )}
      {guide}
      <MealNotice kind="childServingScope" />
    </form>
  )
}
