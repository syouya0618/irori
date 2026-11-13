/**
 * 献立・買い物・今夜の要約の「画面へ渡す形」の組み立て。
 *
 * **サーバー専用**（Server Component / Server Action から呼ぶ。カタログを import する `context.ts` を
 * 使うので、Client Component から値 import しない。型は `import type` で使ってよい）。
 *
 * - 料理名・売場・単位・理由は、ここで日本語の表示名へ直して渡す（Client へカタログを載せない）。
 * - 在庫の引当は**計画上**のもの（`reviewPlan`）。実在庫は変えない。
 * - 取得の失敗を「空」として返さない。`load*` は `{ ok: false }` を返し、画面が失敗表示にする。
 * - 「栄養」や「安全」を保証する文言は作らない。除外の判定の限界（名前の一致でしか判定できない
 *   除外）は `limitedExclusions` として画面へ渡す。
 */

import { isRecord } from "@/lib/domain/child-sharing"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"

import { formatProviderResetJst, mealAiConfig } from "../ai"
import { STORE_SECTIONS, storeSectionLabel } from "../catalog/sections"
import {
  blockedIngredientNames,
  buildExclusionSet,
  type ExclusionSet,
  partitionRecipes,
  type PlanConflict,
  undeterminedAllergyLabels,
} from "../exclusions"
import {
  buildGroceryNeeds,
  outstandingRequired,
  remainingToBuy,
  restockableAmount,
  type UncomputedDish,
} from "../grocery"
import { ingredientNameOf } from "../lookup"
import type { IngredientMatch, MatchReason, Sufficiency } from "../pantry-match"
import { type GapReason, type PinRejection, type PlannedEntry, reviewPlan } from "../planner"
import type { DishRole, FoodExclusion, PlanEntry, PlanEntryStatus, Quantity, StoreSection, UnitId } from "../types"
import { roundAmount, toBaseAmount } from "../units"
import {
  type MealContext,
  type MealLoadFailure,
  type MealSupabase,
  loadMealContext,
} from "./context"
import {
  PLAN_ORIGIN_LABELS,
  PLAN_STATUS_LABELS,
  SUFFICIENCY_DESCRIPTIONS,
  SUFFICIENCY_LABELS,
  dishRoleLabel,
  formatMealDateShort,
  formatMealDateWithRelative,
  formatQuantityJa,
  unitLabel,
} from "./format"
import { groceryHeldConflictsIn, groceryRange } from "./grocery-sync"
import {
  DINNER_AI_DAILY_LIMIT,
  type MealAiState,
  type MealAiStatusView,
  countServingsMismatch,
} from "./plan-requests"
import { type StoredGroceryItem, type StoredPlanEntry, groceryNeedsToRpc, toFiniteNumber } from "./rows"
import { mealDateRange, mealToday } from "./today"
import {
  type AgeRuleEnv,
  type ExclusionNoticeView,
  ageRuleEnvOf,
  buildAgeWarningViews,
  buildExclusionNotice,
  buildTitleAgeWarningViews,
  describeAutoConfirmHold,
  genericStockView,
} from "./views"

// ── 理由の文言 ─────────────────────────────────────────────────────

const MATCH_REASON_LABELS: Readonly<Record<MatchReason, string>> = {
  not_in_pantry: "食材に登録がありません",
  used_up: "使い切っています",
  expired: "食べる日には期限を過ぎています",
  short: "量が足りません",
  allocated: "ほかの日の献立で使う予定です",
  quantity_unknown: "数量が登録されていません",
  low: "残り少ないと登録されています",
  unit_mismatch: "単位が違うため量を比べられません",
  stale: "最後に確認してから日が経っています",
}

/** 埋められなかった枠の理由（除外を破って埋めることはしない）。 */
export function describePlanGap(reason: GapReason | "unfilled", role: DishRole): string {
  const label = dishRoleLabel(role)
  if (reason === "no_recipes") return `${label}のレシピがありません。`
  if (reason === "all_excluded") return `使わない食材の設定に当たらない${label}の候補がありません。`
  if (reason === "needs_label_check") return `残っている${label}の候補は、原材料の確認が必要なものだけです。`
  if (reason === "exhausted") return `使える${label}の候補を、この期間で使い切りました。`
  return `${label}がまだ決まっていません。`
}

/** 採用しなかった希望の固定の理由。 */
export function describePinRejection(reason: PinRejection): string {
  if (reason === "out_of_range") return "作る期間の外の日です。"
  if (reason === "unknown_recipe") return "この料理は一覧にありません。"
  if (reason === "excluded") return "使わない食材の設定に当たるため、固定しませんでした。"
  if (reason === "needs_label_check") return "原材料の確認が必要な料理のため、固定しませんでした。"
  return "その日は固定した料理・作った料理があるため、変更していません。"
}

// ── AI の状態 ──────────────────────────────────────────────────────

/** AI の状態を、画面へそのまま出せる形にする（鍵・アカウント ID・モデル名は載せない）。 */
export function mealAiStatusView(state: MealAiState, resetsAt: string | null = null): MealAiStatusView {
  const resetsAtLabel = resetsAt === null ? null : formatProviderResetJst(resetsAt)
  const keep = "自動献立はそのまま使えます。"
  let message: string
  if (state === "not_configured") message = `AI 補助は設定されていません。${keep}`
  else if (state === "available") message = "AI 補助を使えます（希望の文の読み取りだけを手伝います）。"
  else if (state === "household_limit") {
    message = `AI 補助は本日の上限（${DINNER_AI_DAILY_LIMIT} 回）に達しました。${keep}`
  } else if (state === "provider_exhausted") {
    message =
      resetsAtLabel === null
        ? `AI 補助の無料枠が終了しました。${keep}`
        : `AI 補助の無料枠が終了しました。${resetsAtLabel} 以降に再開します。${keep}`
  } else if (state === "temporary_failure") message = "今回は AI 補助を使えませんでした。規則による読み取りで続けます。"
  else message = `AI 補助の状態を確認できませんでした。${keep}`
  return { state, resetsAt: state === "provider_exhausted" ? resetsAt : null, resetsAtLabel, message }
}

/**
 * AI 補助の今の状態（回数は計上しない）。env が揃っていなければ DB へ問い合わせない。
 * throw しない（確認できなければ `unknown`）。
 */
export async function loadMealAiStatus(supabase: MealSupabase): Promise<MealAiStatusView> {
  if (mealAiConfig().state !== "enabled") return mealAiStatusView("not_configured")
  try {
    const { data, error } = await supabase.rpc("dinner_ai_status")
    if (error) {
      logSupabaseErrorRedacted("meals", "dinner_ai_status failed", error)
      return mealAiStatusView("unknown")
    }
    if (!isRecord(data)) return mealAiStatusView("unknown")
    if (data.provider_exhausted === true) {
      return mealAiStatusView("provider_exhausted", typeof data.resets_at === "string" ? data.resets_at : null)
    }
    const used = toFiniteNumber(data.used)
    if (used === null) return mealAiStatusView("unknown")
    return mealAiStatusView(used >= DINNER_AI_DAILY_LIMIT ? "household_limit" : "available")
  } catch (err) {
    console.error("[meals] dinner_ai_status threw", { message: err instanceof Error ? err.message : String(err) })
    return mealAiStatusView("unknown")
  }
}

// ── 献立 ───────────────────────────────────────────────────────────

export interface StockLineView {
  name: string
  /** 足りない量や、確認が要る理由。 */
  detail: string
  /**
   * true = この材料の総称（「豚肉」「きのこ」など）で登録された食材があり、部位・種類の確認が要る
   * （`detail` にその旨を含む。数量は引き当てていない）。`buildDinnerPlanView` は必ず入れる。
   */
  genericStock?: boolean
}

export interface EntryStockView {
  level: Sufficiency
  label: string
  description: string
  /** 買い足しが要る材料。 */
  missing: StockLineView[]
  /** 在庫はあるが確認が要る材料（数量不明・残り少ない・単位違い・確認が古い）。 */
  toCheck: StockLineView[]
}

export interface EntryConflictView {
  /** `blocked` = 使わない食材に当たる。`label_check` = 成分を確かめられない。 */
  verdict: "blocked" | "label_check"
  message: string
  /**
   * true = この料理そのものに確認の要る材料は無く、判定できないアレルギーの除外
   * （`DinnerPlanView.exclusions.holdsAutoConfirm`）のためだけに「確認が必要」になっている。
   * `buildDinnerPlanView` は必ず入れる。
   */
  undeterminedHold?: boolean
}

export interface DinnerEntryView {
  id: string
  version: string
  date: string
  role: DishRole
  roleLabel: string
  position: number
  title: string
  /** カタログのレシピ。手動料理は null。 */
  recipeId: string | null
  isCustom: boolean
  /** 目安の調理時間（分）。手動料理・カタログに無いレシピは null。 */
  minutes: number | null
  servings: number
  pinned: boolean
  status: PlanEntryStatus
  statusLabel: string
  origin: PlanEntry["origin"]
  /** 「自動」（規則ベースの自動献立）/「AI 補助」/「手動」。 */
  originLabel: string
  /** 在庫との突き合わせ（計画上の引当）。作った・作らなかった枠、材料の無い手動料理は null。 */
  stock: EntryStockView | null
  /** 使わない食材の設定との衝突（置換はしていない。選び直せるように見せる）。 */
  conflict: EntryConflictView | null
  /** 買い物の自動計算の対象外（材料が未登録の手動料理・カタログに無いレシピ）。 */
  groceryUncomputed: boolean
  /**
   * 年齢の制約に触れる材料（例: 1 歳未満のはちみつ）と、該当する子ども（C-65）。料理は外さない・
   * 置き換えない — 注意として示すだけ（「今あるもので」・レシピ詳細と同じ文言）。月齢はその料理の日で数える。
   * 「作らなかった」枠は空。**子どもを読んでいないとき（`ageRulesChecked` が false）も空** — その場合は
   * 「注意なし」と言えない。`buildDinnerPlanView` は必ず入れる（型が省略可なのは、画面のテストの既存の
   * fixture を壊さないため）。
   */
  ageWarnings?: EntryAgeWarningView[]
  /**
   * 「作った」「作らなかった」を取り消したときに戻る状態（作る前に提案だったか確定だったか）。提案・確定の枠は null。
   * 省略は「確定」（型が省略可なのは、画面のテストの既存の fixture を壊さないため）。
   */
  restoreTo?: "proposed" | "confirmed" | null
}

/** 年齢の制約の注意 1 件（子ども 1 人 × 食材 1 つ）。 */
export interface EntryAgeWarningView {
  childId: string
  childName: string
  ingredientName: string
  /** true = 生年月日が未登録で判定できない（確認を促す）。 */
  ageUnknown: boolean
  /** 画面へそのまま出せる文。 */
  text: string
}

export interface MissingRoleView {
  role: DishRole
  roleLabel: string
  reason: GapReason | "unfilled"
  message: string
}

export interface DinnerDayView {
  date: string
  /** 「今日 11/12（水）」。 */
  label: string
  isToday: boolean
  isPast: boolean
  entries: DinnerEntryView[]
  /** 料理が 1 品でもある日の、足りない区分と理由。 */
  missingRoles: MissingRoleView[]
}

export interface DinnerPlanView {
  today: string
  from: string
  to: string
  /** 献立全体の版（`generateDinnerPlan` などの `expectedRevision` に渡す）。 */
  revision: number
  /** 買い物リストが今の献立より古い（「献立から更新」を促す）。 */
  groceryStale: boolean
  servings: {
    value: number
    /** true = 設定が無く、標準の人数で計算している。 */
    isStandard: boolean
    /**
     * これからの未調理の枠（今日以降の提案・確定。固定を含む）のうち、人数が `value` と違う枠の数。
     * 数えるのは**読み込んだ範囲**（表示の 7 日と今日）だけ。0 でなければ、画面は「設定の人数と違う料理が
     * n 品ある」と知らせ、1 品ずつ（op `servings`）か、まとめて（op `servings_upcoming`）直せるようにする。
     * 勝手には書き換えない。`buildDinnerPlanView` は必ず入れる（型が省略可なのは、画面のテストの
     * 既存の fixture を壊さないため。画面が使い始めたら必須へ上げてよい）。
     */
    mismatchCount?: number
  }
  includeSoup: boolean
  maxCookMinutes: number | null
  days: DinnerDayView[]
  counts: { proposed: number; confirmed: number; cooked: number; conflicts: number }
  /** 辞書へ解決できず、名前の一致でしか判定できない除外の名前（判定の限界として示す）。 */
  limitedExclusions: string[]
  /**
   * 世帯の「使わない食材」の全体の状態（「今あるもので」と同じ形）。`holdsAutoConfirm` が true なら、
   * 判定できないアレルギーの除外のために全ての料理が「原材料の確認が必要」になっている
   * （原因の除外は `undetermined`、文は `holdMessage`）。`buildDinnerPlanView` は必ず入れる。
   */
  exclusions?: ExclusionNoticeView
  /** 読めなかった献立の行の数。 */
  unreadableEntries: number
  /**
   * 年齢の制約（`DinnerEntryView.ageWarnings`）を確かめたか。false = 子どもを読み込んでいない
   * （`loadMealContext` の `include` に `children` が無い）ので、注意の有無を言えない。
   */
  ageRulesChecked?: boolean
}

type PantryNameOf = (pantryItemId: string) => string | undefined

function stockLine(match: IngredientMatch, missing: boolean, pantryNameOf: PantryNameOf): StockLineView {
  const reasons = match.reasons.map((reason) => MATCH_REASON_LABELS[reason] ?? "確認が必要です")
  const short = match.shortBy && typeof match.shortBy.amount === "number" && match.shortBy.amount > 0
    ? `${missing ? "あと" : "確認できていない量 "}${formatQuantityJa(match.shortBy)}`
    : null
  // 総称（「豚肉」など）で登録された食材は同一視しない。どの登録のことかを添えて、確認を促す
  const generic = genericStockView(match, pantryNameOf)
  const parts = [...(short === null ? [] : [short]), ...reasons, ...(generic === null ? [] : [generic.text])]
  return {
    name: match.name,
    detail: parts.length === 0 ? "確認が必要です" : parts.join("・"),
    genericStock: generic !== null,
  }
}

function stockView(stock: PlannedEntry["stock"], pantryNameOf: PantryNameOf): EntryStockView | null {
  if (stock === null) return null
  return {
    level: stock.level,
    label: SUFFICIENCY_LABELS[stock.level],
    description: SUFFICIENCY_DESCRIPTIONS[stock.level],
    missing: stock.missing.map((match) => stockLine(match, true, pantryNameOf)),
    toCheck: stock.toCheck.map((match) => stockLine(match, false, pantryNameOf)),
  }
}

function conflictView(conflict: PlanConflict, set: ExclusionSet): EntryConflictView {
  if (conflict.verdict === "blocked") {
    const names = blockedIngredientNames(conflict.blockedBy, set)
    return {
      verdict: "blocked",
      message:
        names.length === 0
          ? "使わない食材の設定に当たります。選び直してください。"
          : `使わない食材の設定に当たります（${names.join("、")}）。選び直してください。`,
      undeterminedHold: false,
    }
  }
  const reasons = new Set(conflict.unverifiable.map((item) => item.reason))
  // 料理そのものに確認の要る材料が無いのに label_check なのは、判定できないアレルギーの除外のため。
  // 「商品により原材料が異なる材料を含みます」と言うと事実と違う
  const hold = reasons.size === 0 ? describeAutoConfirmHold(set) : null
  if (hold !== null) return { verdict: "label_check", message: hold, undeterminedHold: true }
  let message = "原材料の確認が必要です（商品により原材料が異なる材料を含みます）。"
  if (reasons.has("no_ingredients")) message = "材料が登録されていないため、使わない食材に当たるかを確かめられません。"
  else if (reasons.has("unknown_recipe")) message = "この料理は一覧に無いため、使わない食材に当たるかを確かめられません。"
  else if (reasons.has("unknown_ingredient")) message = "辞書に無い材料を含むため、原材料の確認が必要です。"
  return { verdict: "label_check", message, undeterminedHold: false }
}

function missingRolesOf(
  entries: readonly StoredPlanEntry[],
  includeSoup: boolean,
  reasonOf: (role: DishRole) => GapReason | "unfilled",
): MissingRoleView[] {
  const active = entries.filter((entry) => entry.status !== "skipped")
  if (active.length === 0) return []
  const wanted: DishRole[] = includeSoup ? ["main", "side", "soup"] : ["main", "side"]
  return wanted
    .filter((role) => !active.some((entry) => entry.role === role))
    .map((role) => {
      const reason = reasonOf(role)
      return { role, roleLabel: dishRoleLabel(role), reason, message: describePlanGap(reason, role) }
    })
}

/**
 * 献立の画面が読む部分。`children` は年齢の制約の注意（C-65）に要る — **献立を表示する読み込みは
 * この一覧を `include` に使うこと**（`children` を外すと、注意は出ず `ageRulesChecked` が false になる）。
 */
export const PLAN_VIEW_PARTS = ["settings", "pantry", "exclusions", "plan", "children"] as const

type ChildrenPart = Pick<MealContext<"children">, "children">
type PlanViewContext = MealContext<"settings" | "pantry" | "exclusions" | "plan"> & Partial<ChildrenPart>

/**
 * 1 枠の年齢の制約の注意。材料（カタログのレシピ・手動料理に登録した材料）と、手動料理の料理名から作る。
 * `env` が null（子どもを読んでいない）なら空。
 */
function entryAgeWarnings(
  entry: Pick<StoredPlanEntry, "date" | "status" | "recipeId" | "customTitle" | "customIngredients">,
  env: AgeRuleEnv | null,
): EntryAgeWarningView[] {
  if (env === null || entry.status === "skipped") return []
  const recipe = entry.recipeId === null ? undefined : env.lookup.recipeById.get(entry.recipeId)
  const ingredients = entry.recipeId === null ? (entry.customIngredients ?? []) : (recipe?.ingredients ?? [])
  const warnings = buildAgeWarningViews(ingredients, env, entry.date)
  if (entry.recipeId !== null) return warnings
  return [...warnings, ...buildTitleAgeWarningViews(entry.customTitle ?? "", warnings, env, entry.date)]
}

/**
 * 献立の画面の形を組み立てる（純粋。同じ入力からは同じ結果）。
 * `startDate` から `days` 日ぶん（1〜7）。範囲が不正なら null。
 */
export function buildDinnerPlanView(
  context: PlanViewContext,
  options: { startDate: string; days: number },
): DinnerPlanView | null {
  const range = mealDateRange(options.startDate, options.days)
  if (range === null) return null
  const { lookup, today, settings } = context
  const entries = context.plan.entries.filter((entry) => entry.date >= range.from && entry.date <= range.to)
  const set = buildExclusionSet(context.exclusions, lookup)
  const review = reviewPlan({
    startDate: range.from,
    days: options.days,
    servings: settings.servings,
    today,
    existingEntries: entries,
    pantry: context.pantry,
    exclusions: context.exclusions,
    stapleIngredientIds: settings.stapleIngredientIds,
    catalog: lookup,
  })
  const reviewed = new Map(review.entries.map((entry) => [entry.key, entry]))
  const conflicts = new Map(review.conflicts.map((conflict) => [conflict.entryId, conflict]))
  const ageEnv = context.children === undefined ? null : ageRuleEnvOf(lookup, context.children, settings)
  const pantryNames = new Map(context.pantry.map((item) => [item.id, item.name]))
  const pantryNameOf: PantryNameOf = (id) => pantryNames.get(id)

  // 足りない区分の理由は、今の除外で候補が残っているかで決める（残っていれば「まだ決まっていない」）
  const reasonByRole = new Map<DishRole, GapReason | "unfilled">()
  const reasonOf = (role: DishRole): GapReason | "unfilled" => {
    const cached = reasonByRole.get(role)
    if (cached !== undefined) return cached
    const partition = partitionRecipes(lookup.recipes.filter((recipe) => recipe.role === role), set)
    const total = partition.allowed.length + partition.labelCheck.length + partition.blocked.length
    const reason: GapReason | "unfilled" =
      total === 0
        ? "no_recipes"
        : partition.allowed.length > 0
          ? "unfilled"
          : partition.labelCheck.length > 0
            ? "needs_label_check"
            : "all_excluded"
    reasonByRole.set(role, reason)
    return reason
  }

  const toEntryView = (entry: StoredPlanEntry): DinnerEntryView => {
    const recipe = entry.recipeId === null ? undefined : lookup.recipeById.get(entry.recipeId)
    const conflict = conflicts.get(entry.id)
    const isCustom = entry.recipeId === null
    const active = entry.status === "proposed" || entry.status === "confirmed"
    return {
      id: entry.id,
      version: entry.version,
      date: entry.date,
      role: entry.role,
      roleLabel: dishRoleLabel(entry.role),
      position: entry.position,
      title: recipe?.title ?? entry.customTitle ?? "名前のない料理",
      recipeId: entry.recipeId,
      isCustom,
      minutes: recipe?.minutes ?? null,
      servings: entry.servings,
      pinned: entry.pinned,
      status: entry.status,
      statusLabel: PLAN_STATUS_LABELS[entry.status],
      origin: entry.origin,
      originLabel: PLAN_ORIGIN_LABELS[entry.origin],
      stock: stockView(reviewed.get(entry.id)?.stock ?? null, pantryNameOf),
      conflict: conflict ? conflictView(conflict, set) : null,
      groceryUncomputed:
        active && (isCustom ? !entry.customIngredients || entry.customIngredients.length === 0 : recipe === undefined),
      ageWarnings: entryAgeWarnings(entry, ageEnv),
      restoreTo: active ? null : (entry.priorStatus ?? "confirmed"),
    }
  }

  const days: DinnerDayView[] = range.dates.map((date) => {
    const dayEntries = entries
      .filter((entry) => entry.date === date)
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    return {
      date,
      label: formatMealDateWithRelative(date, today),
      isToday: date === today,
      isPast: date < today,
      entries: dayEntries.map(toEntryView),
      missingRoles: missingRolesOf(dayEntries, settings.includeSoup, reasonOf),
    }
  })

  const hasConfirmedAhead = context.plan.entries.some((entry) => entry.status === "confirmed" && entry.date >= today)
  const { revision, groceryRevision } = context.plan
  return {
    today,
    from: range.from,
    to: range.to,
    revision,
    // 判定できないアレルギーの間は、買い物の自動の更新を止めている（「献立から更新」を促さない。理由は保留の知らせで言う）
    groceryStale:
      !set.holdsAutoConfirm && groceryRevision !== revision && (groceryRevision !== null || hasConfirmedAhead),
    servings: {
      value: settings.servings,
      isStandard: context.settingsMissing,
      mismatchCount: countServingsMismatch(context.plan.entries, settings.servings, today),
    },
    includeSoup: settings.includeSoup,
    maxCookMinutes: settings.maxCookMinutes,
    days,
    counts: {
      proposed: entries.filter((entry) => entry.status === "proposed").length,
      confirmed: entries.filter((entry) => entry.status === "confirmed").length,
      cooked: entries.filter((entry) => entry.status === "cooked").length,
      conflicts: review.conflicts.length,
    },
    limitedExclusions: set.limited.map((item) => item.label),
    exclusions: buildExclusionNotice(set),
    unreadableEntries: context.unreadable.plan ?? 0,
    ageRulesChecked: ageEnv !== null,
  }
}

export type ViewResult<V> = { ok: true; view: V } | { ok: false; failures: MealLoadFailure[] }

/** 献立の画面のデータを読む。既定は今日から 7 日ぶん。範囲が不正なら取得の失敗として返す。 */
export async function loadDinnerPlanView(
  supabase: MealSupabase,
  householdId: string,
  options: { startDate?: string; days?: number; today?: string } = {},
): Promise<ViewResult<DinnerPlanView>> {
  const today = options.today ?? mealToday()
  const startDate = options.startDate ?? today
  const days = options.days ?? 7
  const range = mealDateRange(startDate, days)
  if (range === null) return { ok: false, failures: [{ part: "plan", kind: "query" }] }
  // 「買い物リストが古いか」は今日以降の確定の有無でも決まるので、今日も範囲へ含めて読む
  const from = range.from < today ? range.from : today
  const to = range.to > today ? range.to : today
  const loaded = await loadMealContext(supabase, householdId, {
    include: PLAN_VIEW_PARTS,
    planRange: { from, to },
    today,
  })
  if (!loaded.ok) return loaded
  const view = buildDinnerPlanView(loaded.context, { startDate, days })
  return view === null ? { ok: false, failures: [{ part: "plan", kind: "query" }] } : { ok: true, view }
}

// ── 買い物 ─────────────────────────────────────────────────────────

export interface GrocerySourceView {
  date: string
  /** 「11/12（水）」。 */
  dateLabel: string
  title: string
  quantityText: string
}

export type ShoppingItemState =
  /** まだ買うものがある。 */
  | "to_buy"
  /** 購入済み（数値の項目は残りが 0）。 */
  | "purchased"
  /** 献立からは不要になった（購入・メモの記録があるので残っている）。 */
  | "not_needed"

export interface ShoppingItemView {
  id: string
  version: string
  /** `auto` = 献立から自動で作った項目。`manual` = 手動で足した項目。 */
  origin: "auto" | "manual"
  name: string
  section: StoreSection
  sectionLabel: string
  sectionOverridden: boolean
  /** 数量で追える項目か（必要量が数値で、単位が分かる）。false の項目はチェックだけで記録する。 */
  numeric: boolean
  unit: UnitId | null
  unitLabel: string
  requiredAmount: number | null
  /** 「500g」。数値で追えない項目は「適量」などの表記、どちらも無ければ空。 */
  requiredText: string
  /** 買った量の**事実の合計**（「作った」でも減らない）。購入の操作はこの合計を基に送る。 */
  purchasedAmount: number
  restockedAmount: number
  /** 買った量のうち、作った（または確定のまま日が過ぎた）料理へ充当した量。「作った」の取り消しで戻る。 */
  consumedAmount: number
  /**
   * 残り = 必要量 −（購入量 − 在庫へ反映済みの量 − 作った料理へ充当した量）。数値で追えない項目は null。
   * 正本は `grocery.ts` の `remainingToBuy`。
   */
  remainingAmount: number | null
  remainingText: string | null
  /** 購入した量のうち、在庫へ足しておらず料理にも使っていない量（在庫へ足せる上限）。 */
  restockableAmount: number | null
  /** チェック（数値で追えない項目の購入済みの印。作った料理で使い終えた印は false）。 */
  checked: boolean
  /** 在庫の数量が不明で差し引いていない（「在庫量を確認」）。 */
  needsStockCheck: boolean
  note: string | null
  /** どの日のどの料理に必要か。 */
  sources: GrocerySourceView[]
  restockCount: number
  state: ShoppingItemState
}

export interface UncomputedDishView {
  entryId: string
  date: string
  dateLabel: string
  title: string
  /** `no_ingredients` = 材料が未登録の手動料理。`unknown_recipe` = 一覧に無いレシピ。 */
  reason: UncomputedDish["reason"]
  message: string
}

export interface ShoppingView {
  today: string
  /** 自動計算の対象の範囲（今日から）。 */
  from: string
  to: string
  /** 売場ごとの「まだ買うもの」。 */
  sections: { section: StoreSection; label: string; items: ShoppingItemView[] }[]
  purchased: ShoppingItemView[]
  notNeeded: ShoppingItemView[]
  toBuyCount: number
  /** 献立・食材が変わっており、「献立から更新」で自動項目を計算し直す必要がある。 */
  stale: boolean
  /** 買い物の自動計算の対象外の料理（材料の追加へつなげる）。 */
  uncomputed: UncomputedDishView[]
  /**
   * 確定だが、使わない食材の設定に当たる・確かめられないため、材料を買い物に入れていない料理（献立で選び直す）。
   * 献立の状態は変えていない。`exclusionsUnreadable` のときは照らせていないので空。
   */
  heldDishes: HeldDishView[]
  /** 使わない食材の設定を読めず、献立と照らせていない（買い物の更新も止まる）。 */
  exclusionsUnreadable: boolean
  /**
   * 判定できないアレルギーの登録のために、買い物の自動の更新を止めている（要再確認）。`labels` はその登録の名前。
   * 今のリスト・購入の記録・手動項目は、止める前のまま見せる（同期は何も書いていない）。止めている間は
   * `stale` を立てない（「献立から更新」でも同じ理由で止まる）。止めていなければ null。
   */
  autoHold: { labels: string[] } | null
  /** 常備品として買い物に出していない食材の名前。 */
  stapleAssumed: string[]
  /** 読めなかった買い物の行の数。 */
  unreadableItems: number
}

export interface HeldDishView {
  entryId: string
  date: string
  /** 「11/12（水）」。 */
  dateLabel: string
  title: string
  /** `blocked` = 使わない食材の設定に当たる。`label_check` = 原材料を確かめられない。 */
  verdict: "blocked" | "label_check"
  message: string
}

function rawAmount(quantity: { amount: number | null } | null): number {
  return quantity !== null && typeof quantity.amount === "number" ? quantity.amount : 0
}

/** 基準単位（g / ml …）の量を、その項目の単位の量へ戻す。戻せなければ null。 */
function inItemUnit(base: Quantity | null, unit: UnitId | null): number | null {
  if (base === null || typeof base.amount !== "number" || unit === null) return null
  const factor = toBaseAmount({ amount: 1, unit })
  return factor === null || factor <= 0 ? null : roundAmount(base.amount / factor)
}

/**
 * 買い物の 1 項目を画面の形にする（純粋）。量はすべて**その項目の単位**で返す
 * （Action が受ける量と同じ単位）。残りの計算は `grocery.ts` の `remainingToBuy` が正本。
 */
export function toShoppingItemView(item: StoredGroceryItem): ShoppingItemView {
  const numeric = item.required !== null && item.unit !== null
  const remainingAmount = numeric ? inItemUnit(remainingToBuy(item), item.unit) : null
  const remaining = remainingAmount === null || item.unit === null ? null : { amount: remainingAmount, unit: item.unit }
  let state: ShoppingItemState
  if (item.origin === "auto" && !item.stillNeeded) state = "not_needed"
  else if (numeric) state = remainingAmount !== null && remainingAmount > 0 ? "to_buy" : "purchased"
  else state = item.checked ? "purchased" : "to_buy"

  // 必要量は「今の必要量」（作って充当を記録した枠の分を、同期の前でも数えない）。残りの計算と同じ値
  const required = outstandingRequired(item)
  const requiredParts: string[] = []
  if (required !== null) requiredParts.push(formatQuantityJa(required))
  if (item.requiredNote !== null) requiredParts.push(item.requiredNote)
  return {
    id: item.id,
    version: item.version,
    origin: item.origin,
    name: item.name,
    section: item.section,
    sectionLabel: storeSectionLabel(item.section),
    sectionOverridden: item.sectionOverridden,
    numeric,
    unit: item.unit,
    unitLabel: unitLabel(item.unit),
    requiredAmount: numeric ? rawAmount(required) : null,
    requiredText: requiredParts.join("・"),
    purchasedAmount: rawAmount(item.purchased),
    restockedAmount: rawAmount(item.restocked),
    consumedAmount: rawAmount(item.consumed ?? null),
    remainingAmount,
    remainingText: remaining !== null && remaining.amount > 0 ? formatQuantityJa(remaining) : null,
    restockableAmount: inItemUnit(restockableAmount(item), item.unit),
    checked: item.checked,
    needsStockCheck: item.needsStockCheck,
    note: item.note,
    sources: item.sources.map((source) => ({
      date: source.date,
      dateLabel: formatMealDateShort(source.date),
      title: source.title,
      quantityText: formatQuantityJa(source.quantity),
    })),
    restockCount: item.restockCount,
    state,
  }
}

type ShoppingViewContext = MealContext<"settings" | "pantry" | "plan" | "grocery">

function isAutoListStale(context: ShoppingViewContext, needs: ReturnType<typeof buildGroceryNeeds>["needs"]): boolean {
  const { items, rejected } = groceryNeedsToRpc(needs)
  if (rejected.length > 0) return true
  const stored = new Map<string, StoredGroceryItem>()
  for (const item of context.grocery) {
    if (item.origin === "auto" && item.stillNeeded && item.itemKey !== null) {
      stored.set(item.itemKey.replace(":", "|"), item)
    }
  }
  if (stored.size !== items.length) return true
  for (const need of items) {
    const item = stored.get(need.item_key)
    if (!item) return true
    const storedAmount = item.required === null ? null : item.required.amount
    if (storedAmount !== need.required_quantity) return true
    if ((item.unit ?? null) !== (need.unit ?? null)) return true
    if (item.needsStockCheck !== need.needs_stock_check) return true
    if ((item.requiredNote ?? null) !== (need.required_note ?? null)) return true
  }
  return false
}

/**
 * 献立から不要になった自動項目のうち、見せるものが無い行（購入をすべて作った料理に使い、印も使い終え、
 * メモも補充も無い）。DB は「作った」の取り消しで購入を戻せるよう充当の台帳ごと残すが、画面には出さない
 * （充当を購入から引いていた頃に行ごと消えていたものと同じ見え方）。
 */
function isUsedUpLeftover(view: ShoppingItemView): boolean {
  return (
    view.state === "not_needed" &&
    roundAmount(view.purchasedAmount - view.consumedAmount) <= 0 &&
    !view.checked &&
    view.note === null &&
    view.restockedAmount === 0 &&
    view.restockCount === 0
  )
}

const HELD_DISH_MESSAGES = {
  blocked: "使わない食材の設定に当たる材料があるため、この料理の材料は買い物に入れていません。献立で選び直してください。",
  label_check:
    "原材料を確かめられない材料があるため、この料理の材料は買い物に入れていません。献立で確かめるか、選び直してください。",
  noIngredients:
    "材料が登録されていないため、使わない食材に当たるかを確かめられません。この料理は買い物の自動計算に入れていません。献立で材料を登録するか、選び直してください。",
  unknownRecipe:
    "この料理は一覧に無いため、使わない食材に当たるかを確かめられません。この料理の材料は買い物に入れていません。献立で選び直してください。",
  /** 自動の更新を止めている間（要再確認）に、当たると分かっている料理。材料は止める前のリストに残りうる。 */
  blockedWhileHeld:
    "使わない食材の設定に当たります。買い物リストの自動の更新を止めているため、この料理の材料がリストに残っていることがあります。献立で選び直してください。",
} as const

/**
 * 買い物に入れていない料理の理由。献立の画面（`conflictView`）と同じ分け方で、事実と違う理由を出さない。
 * 判定できないアレルギーの登録がある間はここへ来ない（同期を止めておるので「入れていない」とは言えない。
 * `buildShoppingView` が `autoHold` と `blockedWhileHeld` で言い分ける）。
 */
function heldDishMessage(conflict: PlanConflict): string {
  if (conflict.verdict === "blocked") return HELD_DISH_MESSAGES.blocked
  const reasons = new Set(conflict.unverifiable.map((item) => item.reason))
  if (reasons.has("no_ingredients")) return HELD_DISH_MESSAGES.noIngredients
  if (reasons.has("unknown_recipe")) return HELD_DISH_MESSAGES.unknownRecipe
  return HELD_DISH_MESSAGES.label_check
}

/**
 * 買い物の画面の形を組み立てる（純粋）。
 * @param exclusions 使わない食材の設定。null = 読めなかった（照らせない。古いかも判断しない。当たる料理も言えない）。
 */
export function buildShoppingView(
  context: ShoppingViewContext,
  exclusions: readonly FoodExclusion[] | null,
): ShoppingView | null {
  const { today, lookup } = context
  const range = groceryRange(today)
  if (range === null) return null
  // 同期（grocery-sync.ts）と同じ判定で、当たる確定の料理を外して必要量を計算する（古いかの比較も同じ前提）
  const set = exclusions === null ? null : buildExclusionSet(exclusions, lookup)
  const held = set === null ? [] : groceryHeldConflictsIn(context.plan.entries, set)
  const conflictOf = new Map(held.map((conflict) => [conflict.entryId, conflict]))
  const needs = buildGroceryNeeds({
    entries: context.plan.entries,
    from: range.from,
    to: range.to,
    pantry: context.pantry,
    today,
    stapleIngredientIds: context.settings.stapleIngredientIds,
    catalog: lookup,
    heldEntryIds: new Set(conflictOf.keys()),
  })
  const views = context.grocery.map(toShoppingItemView).filter((view) => !isUsedUpLeftover(view))
  const byName =(a: ShoppingItemView, b: ShoppingItemView) => a.name.localeCompare(b.name, "ja") || a.id.localeCompare(b.id)
  const toBuy = views.filter((view) => view.state === "to_buy")
  // 判定できないアレルギーの間、同期は送らない（grocery-sync.ts）。リストは止める前のまま。「入れていない」とは言えない
  // ので、保留の一覧には当たると分かっている料理だけを、止めていることを添えて出す
  const autoHold = set !== null && set.holdsAutoConfirm ? { labels: undeterminedAllergyLabels(set) } : null
  const heldDishes = needs.held
    .map((dish) => ({ dish, conflict: conflictOf.get(dish.entryId) }))
    .filter(({ conflict }) => autoHold === null || conflict?.verdict === "blocked")
    .map(({ dish, conflict }) => ({
      entryId: dish.entryId,
      date: dish.date,
      dateLabel: formatMealDateShort(dish.date),
      title: dish.title === "" ? "名前のない料理" : dish.title,
      verdict: conflict?.verdict ?? ("blocked" as const),
      message:
        autoHold !== null
          ? HELD_DISH_MESSAGES.blockedWhileHeld
          : conflict
            ? heldDishMessage(conflict)
            : HELD_DISH_MESSAGES.blocked,
    }))
  return {
    today,
    from: range.from,
    to: range.to,
    sections: STORE_SECTIONS.map((def) => ({
      section: def.id,
      label: def.label,
      items: toBuy.filter((view) => view.section === def.id).sort(byName),
    })).filter((group) => group.items.length > 0),
    purchased: views.filter((view) => view.state === "purchased").sort(byName),
    notNeeded: views.filter((view) => view.state === "not_needed").sort(byName),
    toBuyCount: toBuy.length,
    // 読めない献立の行・読めない除外があるとき・自動の更新を止めているときは比べられない（同期も止まる）。
    // 古いとは断定せず、別に知らせる
    stale:
      (context.unreadable.plan ?? 0) > 0 || exclusions === null || autoHold !== null
        ? false
        : isAutoListStale(context, needs.needs),
    heldDishes,
    exclusionsUnreadable: exclusions === null,
    autoHold,
    uncomputed: needs.uncomputed.map((dish) => ({
      entryId: dish.entryId,
      date: dish.date,
      dateLabel: formatMealDateShort(dish.date),
      title: dish.title === "" ? "名前のない料理" : dish.title,
      reason: dish.reason,
      message:
        dish.reason === "no_ingredients"
          ? "材料が登録されていないため、買い物の自動計算に入っていません。"
          : "一覧に無い料理のため、買い物の自動計算に入っていません。",
    })),
    stapleAssumed: needs.stapleAssumed.map((staple) => ingredientNameOf(staple.ingredientId, lookup.index)),
    unreadableItems: context.unreadable.grocery ?? 0,
  }
}

/** 買い物の画面のデータを読む。 */
export async function loadShoppingView(
  supabase: MealSupabase,
  householdId: string,
  options: { today?: string } = {},
): Promise<ViewResult<ShoppingView>> {
  const today = options.today ?? mealToday()
  const range = groceryRange(today)
  if (range === null) return { ok: false, failures: [{ part: "grocery", kind: "query" }] }
  // 使わない食材の設定は別に読む: 読めなくても買い物リスト（店で見る記録）は出し、照らせていないことを知らせる。
  // 読めないときに空の除外で計算して「当たる料理は無い」と言うことはしない
  const [loaded, excluded] = await Promise.all([
    loadMealContext(supabase, householdId, {
      include: ["settings", "pantry", "plan", "grocery"],
      planRange: range,
      today,
    }),
    loadMealContext(supabase, householdId, { include: ["exclusions"], today }),
  ])
  if (!loaded.ok) return loaded
  const view = buildShoppingView(loaded.context, excluded.ok ? excluded.context.exclusions : null)
  return view === null ? { ok: false, failures: [{ part: "grocery", kind: "query" }] } : { ok: true, view }
}

// ── 今夜の要約（/chores/meals と /chores のハブ用） ────────────────

export interface TonightSummary {
  today: string
  dinner: {
    /** `none` = 今日の献立が無い。 */
    state: "none" | PlanEntryStatus
    stateLabel: string
    dishes: {
      id: string
      title: string
      roleLabel: string
      status: PlanEntryStatus
      /** 年齢の制約の注意（`DinnerEntryView.ageWarnings` と同じ規則）。`buildTonightSummary` は必ず入れる。 */
      ageWarnings?: EntryAgeWarningView[]
    }[]
  }
  /** まだ買うものの件数。 */
  toBuyCount: number
  /** 年齢の制約を確かめたか。false = 子どもを読み込んでいないので、注意の有無を言えない。 */
  ageRulesChecked?: boolean
  /**
   * 世帯の「使わない食材」の全体の状態（`DinnerPlanView.exclusions` と同じ形）。`holdsAutoConfirm` が true なら、
   * 判定できないアレルギーの除外のために、どの料理も自動では確定しない（文は `holdMessage`）。
   * null = 除外を読み込んでいない（`include` に `exclusions` が無い）ので、状態を言えない。
   * `buildTonightSummary` は必ず入れる。
   */
  exclusions?: ExclusionNoticeView | null
}

/**
 * 今夜の画面（/chores/meals）が読む部分。`children` は年齢の制約の注意（C-65）に要る
 * （`exclusions` は同じ読み込みで作る衝突の警告 `buildPlanConflictReport` 用）。
 */
export const TONIGHT_VIEW_PARTS = ["plan", "grocery", "exclusions", "children"] as const

type TonightContext = MealContext<"plan" | "grocery"> &
  Partial<ChildrenPart> &
  Partial<Pick<MealContext<"exclusions">, "exclusions">>

/** 今日の献立と、まだ買うものの件数（純粋）。 */
export function buildTonightSummary(context: TonightContext): TonightSummary {
  const { today, lookup } = context
  const ageEnv = context.children === undefined ? null : ageRuleEnvOf(lookup, context.children)
  const entries = context.plan.entries
    .filter((entry) => entry.date === today)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  // 1 品でも進んでいる状態を代表にする（作った > 確定 > 提案 > 作らなかった）
  const order: PlanEntryStatus[] = ["cooked", "confirmed", "proposed", "skipped"]
  const state = order.find((status) => entries.some((entry) => entry.status === status)) ?? "none"
  return {
    today,
    dinner: {
      state,
      stateLabel: state === "none" ? "未定" : PLAN_STATUS_LABELS[state],
      dishes: entries.map((entry) => ({
        id: entry.id,
        title:
          (entry.recipeId === null ? entry.customTitle : lookup.recipeById.get(entry.recipeId)?.title) ??
          "名前のない料理",
        roleLabel: dishRoleLabel(entry.role),
        status: entry.status,
        ageWarnings: entryAgeWarnings(entry, ageEnv),
      })),
    },
    toBuyCount: context.grocery.map(toShoppingItemView).filter((view) => view.state === "to_buy").length,
    ageRulesChecked: ageEnv !== null,
    exclusions:
      context.exclusions === undefined ? null : buildExclusionNotice(buildExclusionSet(context.exclusions, lookup)),
  }
}

/**
 * 今夜の要約を読む。**throw しない** — ハブは 1 区画の失敗で全体を倒さない
 * （`ok: false` のときは「読み込めませんでした」を出し、「献立なし」と偽らない）。
 */
export async function loadTonightSummary(
  supabase: MealSupabase,
  householdId: string,
  options: { today?: string } = {},
): Promise<{ ok: true; summary: TonightSummary } | { ok: false; failures: MealLoadFailure[] }> {
  const today = options.today ?? mealToday()
  const loaded = await loadMealContext(supabase, householdId, {
    include: ["plan", "grocery"],
    planRange: { from: today, to: today },
    today,
  })
  if (!loaded.ok) return loaded
  return { ok: true, summary: buildTonightSummary(loaded.context) }
}
