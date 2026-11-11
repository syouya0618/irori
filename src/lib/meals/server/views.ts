/**
 * ごはんの画面へ渡す「読み取りの組み立て」（今あるもので・レシピ詳細・設定）。
 *
 * **サーバー専用**（Server Component / Server Action から呼ぶ）。カタログ（食材辞書・レシピ）を
 * 使うので、Client Component から値 import しないこと。型は `import type` で使ってよい。
 * 返す値は素の object・配列・文字列だけ（Client Component の props へそのまま渡せる）。
 *
 * ## 規則
 * - **純粋**: 入力（`loadMealContext` が読んだ世帯の状態）だけから組み立てる。DB も時計も読まず、
 *   モジュール内に世帯の値を持たない。入力から消えた好み・評価は、結果にも理由にも現れない（C-75）。
 * - **外部へ何も送らない**（生成 AI も呼ばない）。子どもの名前・生年月日は画面の表示にだけ使う（C-61）。
 * - 判定はロジック（`suggest-now` / `exclusions` / `child-serving` / `pantry-match`）の結果を
 *   そのまま写す。ここで緩めない・言い換えない（「揃う」「分量要確認」「買い足し」を混ぜない。
 *   除外に当たる料理を候補へ戻さない）。
 * - 理由の文は、実在する設定・評価・在庫の記録からだけ作る（記録の ID を一緒に返す）。
 * - カタログに無い ID（古い記録に残った食材・レシピ・アレルゲン）は落とさず、表示だけを退化させる。
 */

import { ALLERGEN_LIST_META, ALLERGEN_LIST_VERSION_NOTE, ALLERGEN_TIER_LABELS } from "../catalog/allergens"
import {
  AGE_RESTRICTION_RULES,
  CHILD_SERVING_STAGE_LABELS,
  CHILD_SERVING_UNSUPPORTED_TEXT,
  getGuidanceSource,
} from "../catalog/child-guidance"
import { storeSectionLabel } from "../catalog/sections"
import { RECIPE_TAGS, getRecipeTagLabel } from "../catalog/tags"
import {
  GUARDIAN_MEAL_STAGES,
  GUARDIAN_MEAL_STAGE_LABELS,
  type AgeRuleWarning,
  type ChildServingReason,
  type GuardianMealStage,
  type MealChild,
  childAgeMonths,
  findAgeRuleWarnings,
  summarizeChildServing,
} from "../child-serving"
import {
  type BlockVia,
  type DishVerdict,
  type ExclusionSet,
  type Unverifiable,
  type UnverifiableReason,
  blockedIngredientNames,
  buildExclusionSet,
  evaluateRecipe,
  findPlanConflicts,
  resolveExclusionLabel,
} from "../exclusions"
import { allergenProfileOf, ingredientNameOf } from "../lookup"
import { type IngredientMatch, type LineState, type MatchReason, type Sufficiency, expiryStateOn } from "../pantry-match"
import { EFFORT_LABELS, TASTE_LABELS, describePreferenceReason } from "../preferences"
import { type NowSuggestion, type SuggestHint, suggestNow } from "../suggest-now"
import type {
  AllergenDef,
  AllergenListMeta,
  DishRole,
  ExclusionReason,
  FoodExclusion,
  FoodPreference,
  PantryItem,
  PlanEntry,
  Quantity,
  RecipeDef,
  RecipeIngredient,
} from "../types"
import { scaleQuantity } from "../units"
import { type MealChildProfile, type MealContext, type MealLookup, type MealMember, toMealChildren } from "./context"
import { EXCLUSION_REASON_LABELS, formatMealDateShort, formatMinutes, formatQuantityJa } from "./format"
import { DINNER_SERVINGS_MAX, DINNER_SERVINGS_MIN, type DinnerSettings } from "./rows"
import type { ExclusionResolutionView, PlanConflictReport, PlanConflictView } from "./settings-requests"

// ── 共通の表記 ─────────────────────────────────────────────────────

export const MATCH_REASON_LABELS: Readonly<Record<MatchReason, string>> = {
  not_in_pantry: "食材に登録がありません",
  used_up: "使い切っています",
  expired: "期限が過ぎています",
  short: "量が足りません",
  allocated: "ほかの日の献立に割り当て済みです",
  quantity_unknown: "数量が登録されていません",
  low: "残り少ないと登録されています",
  unit_mismatch: "登録した単位とレシピの単位を換算できません",
  stale: "最後に確認してから日が経っています",
}

export const LINE_STATE_LABELS: Readonly<Record<LineState, string>> = {
  enough: "ある",
  staple: "常備品",
  uncertain: "要確認",
  missing: "不足",
}

export const SUGGEST_HINT_TEXTS: Readonly<Record<SuggestHint, string>> = {
  pantry_empty: "使える食材が登録されていません。食材を登録すると、今あるもので作れる料理を探せます。",
  unresolved_items:
    "食材の一覧にない名前の食材があります（提案の材料に数えていません）。名前を見直すと候補が増えることがあります。",
  quantity_unknown: "数量が未登録の食材があります。数量を入れると「揃う」と判定できます。",
  stale_items: "最後の確認から日が経った食材があります。確認日を更新すると「揃う」と判定できます。",
  expired_items: "期限を過ぎた食材は、材料に数えていません。",
  used_up_items: "使い切った食材は、材料に数えていません。",
  all_excluded: "使わない食材の設定により、対象の料理がすべて候補から外れています。",
  no_recipes: "対象の料理がありません。",
}

/** 油・調味料の数え方（C-25）。常備品が未設定の世帯の「今あるもので」に添える。 */
export const STAPLE_RULE_NOTE =
  "油や調味料も、食材に登録するか「常備品」に設定したものだけを「ある」と数えます。常備品は設定で選べます。"

const UNNAMED_CHILD_LABEL = "名前未設定のお子さん"
const HOUSEHOLD_SUBJECT_LABEL = "家族全体"

function displayNameOf(member: MealMember | undefined): string | null {
  const name = member?.displayName.trim() ?? ""
  return name === "" ? null : name
}

function childLabelOf(child: Pick<MealChildProfile, "name"> | undefined): string {
  const name = child?.name.trim() ?? ""
  return name === "" ? UNNAMED_CHILD_LABEL : name
}

/** 月齢の表記（「2歳3か月」「8か月」）。分からなければ null。 */
export function formatChildAge(ageMonths: number | null): string | null {
  if (ageMonths === null || !Number.isFinite(ageMonths) || ageMonths < 0) return null
  const whole = Math.floor(ageMonths)
  const years = Math.floor(whole / 12)
  const rest = whole % 12
  if (years === 0) return `${rest}か月`
  return rest === 0 ? `${years}歳` : `${years}歳${rest}か月`
}

function formatMinAge(minAgeMonths: number): string {
  return minAgeMonths % 12 === 0 ? `${minAgeMonths / 12}歳` : `${minAgeMonths}か月`
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)]
}

function allergenNameOf(allergenId: string, allergens: readonly AllergenDef[]): string {
  return allergens.find((allergen) => allergen.id === allergenId)?.name ?? allergenId
}

export interface UnverifiableView {
  code: UnverifiableReason
  ingredientName: string | null
  text: string
}

function unverifiableView(item: Unverifiable, lookup: MealLookup): UnverifiableView {
  const name = item.ingredientId === null ? null : ingredientNameOf(item.ingredientId, lookup.index)
  const texts: Record<UnverifiableReason, string> = {
    varies_ingredient: `「${name ?? "材料"}」は商品によって原材料が異なります`,
    allergen_unconfirmed: "この料理のアレルゲン情報は確認できていません",
    unknown_ingredient: `「${name ?? "材料"}」は食材の一覧になく、原材料を確かめられません`,
    no_ingredients: "材料が登録されていないため、原材料を確かめられません",
    unknown_recipe: "料理の一覧にないため、材料を確かめられません",
  }
  return { code: item.reason, ingredientName: name, text: texts[item.reason] ?? "原材料を確かめられません" }
}

// ── 除外の表記 ─────────────────────────────────────────────────────

export interface ExclusionLabels {
  reasonLabel: string
  /** 何を除くか（アレルゲン名・食材名・自由入力の語）。 */
  targetLabel: string
  /** false = カタログに無い ID（表示は ID のまま。判定には引き続き使う）。 */
  targetKnown: boolean
  /** 誰の除外か（表示用。判定は世帯の和集合で、ここでは絞らない）。 */
  subjectLabel: string
}

interface PeopleIndex {
  members: ReadonlyMap<string, MealMember>
  children: ReadonlyMap<string, MealChildProfile>
}

function peopleIndex(members: readonly MealMember[], children: readonly MealChildProfile[]): PeopleIndex {
  return {
    members: new Map(members.map((member) => [member.id, member])),
    children: new Map(children.map((child) => [child.id, child])),
  }
}

function describeExclusion(exclusion: FoodExclusion, lookup: MealLookup, people: PeopleIndex): ExclusionLabels {
  const { target, subject } = exclusion
  let targetLabel: string
  let targetKnown = true
  if (target.kind === "allergen") {
    targetKnown = lookup.allergens.some((allergen) => allergen.id === target.allergenId)
    targetLabel = allergenNameOf(target.allergenId, lookup.allergens)
  } else if (target.kind === "ingredient") {
    targetKnown = lookup.index.byId.has(target.ingredientId)
    targetLabel = ingredientNameOf(target.ingredientId, lookup.index)
  } else {
    targetLabel = target.label
  }
  let subjectLabel = HOUSEHOLD_SUBJECT_LABEL
  if (subject.kind === "member") {
    const member = people.members.get(subject.profileId)
    subjectLabel = member ? (displayNameOf(member) ?? "家族（名前未設定）") : "世帯にいない人"
  } else if (subject.kind === "child") {
    const child = people.children.get(subject.childId)
    subjectLabel = child ? childLabelOf(child) : "世帯にいない子ども"
  }
  return {
    reasonLabel: EXCLUSION_REASON_LABELS[exclusion.reason] ?? "使わない食材",
    targetLabel,
    targetKnown,
    subjectLabel,
  }
}

/** 判定できない除外 1 件（どの食材・料理にも当たらず、**何も外せていない**）。 */
export interface UndeterminedExclusionView {
  exclusionId: string
  /** 入力された語（一覧に無い ID で登録された除外は、その ID）。 */
  label: string
  reason: ExclusionReason
  reasonLabel: string
  /**
   * `holds_auto_confirm` = アレルギー。該当する料理を見分けられないので、どの料理も自動では確定しない。
   * `no_effect` = 苦手。献立は止めないが、**何も除外されていない**。
   */
  effect: "holds_auto_confirm" | "no_effect"
}

/**
 * 世帯の「使わない食材」の全体の状態。`buildExclusionNotice` は全ての項目を必ず入れる
 * （`holdsAutoConfirm` 以下が型で省略可なのは、画面のテストの既存の fixture を壊さないため）。
 */
export interface ExclusionNoticeView {
  /** 除外が 1 件でも登録されている。 */
  hasAny: boolean
  /** アレルギーの除外が 1 件でもある（判定の限界の注意を添える）。 */
  hasAllergy: boolean
  /** 食材の一覧へ解決できず、名前の一致でしか判定できない除外（限界の注意を添える）。 */
  limited: { exclusionId: string; label: string }[]
  /**
   * true = 判定できない**アレルギー**の除外が登録されているため、どの料理も自動では確定しない
   * （全ての料理が「原材料の確認が必要」になる。原因の除外は `undetermined` の `holds_auto_confirm`）。
   */
  holdsAutoConfirm?: boolean
  /** 判定できない除外（アレルギー・苦手の両方）。画面は名前を挙げて、一覧から選び直すよう促す。 */
  undetermined?: UndeterminedExclusionView[]
  /** `holdsAutoConfirm` の理由を、画面へそのまま出せる文にしたもの。false のときは null。 */
  holdMessage?: string | null
}

/**
 * 判定できないアレルギーの除外のために、献立を確定できない旨の文（除外の名前を挙げる）。
 * 全料理が未確認になり、確定は自動でも手でも止まる（`confirmDinnerPlan`・1 品の追加）。「自動では」と弱めない。
 */
export function describeAutoConfirmHold(set: Pick<ExclusionSet, "holdsAutoConfirm" | "undetermined">): string | null {
  if (!set.holdsAutoConfirm) return null
  const labels = unique(set.undetermined.filter((item) => item.reason === "allergy").map((item) => item.label))
  const names = labels.map((label) => `「${label}」`).join("")
  return `判定できないアレルギーの登録${names === "" ? "" : `（${names}）`}があるため、料理の原材料を確かめられず、献立を確定できません。設定で一覧から選び直すと、該当する料理だけを外して確定できます。`
}

/** 除外の和集合から、画面へ渡す全体の状態を作る（今あるもので・レシピ詳細・献立・今夜・設定で同じ形）。 */
export function buildExclusionNotice(set: ExclusionSet): ExclusionNoticeView {
  return {
    hasAny: !set.isEmpty,
    hasAllergy: set.hasAllergy,
    limited: set.limited.map((item) => ({ exclusionId: item.exclusionId, label: item.label })),
    holdsAutoConfirm: set.holdsAutoConfirm,
    undetermined: set.undetermined.map((item) => ({
      exclusionId: item.exclusionId,
      label: item.label,
      reason: item.reason,
      reasonLabel: EXCLUSION_REASON_LABELS[item.reason] ?? "使わない食材",
      effect: item.reason === "allergy" ? "holds_auto_confirm" : "no_effect",
    })),
    holdMessage: describeAutoConfirmHold(set),
  }
}

// ── 献立との衝突（除外の設定を変えた後） ───────────────────────────

/**
 * 除外の和集合と、既存の献立（提案・確定の枠）の重なりを一覧にする。**置換はしない**（C-55）。
 * 固定した枠も対象（固定でも新しい除外を無視しない）。
 *
 * @param highlightExclusionIds 今回の変更に当たる除外の ID（`causedByThisChange` を立てる）。
 */
export function buildPlanConflictViews(
  entries: readonly PlanEntry[],
  exclusions: readonly FoodExclusion[],
  lookup: MealLookup,
  highlightExclusionIds: readonly string[] = [],
): PlanConflictView[] {
  const set = buildExclusionSet(exclusions, lookup)
  return findPlanConflicts(entries, set).map((conflict) => {
    const exclusionIds = unique(conflict.blockedBy.map((hit) => hit.exclusionId))
    return {
      entryId: conflict.entryId,
      date: conflict.date,
      role: conflict.role,
      title: conflict.title,
      pinned: conflict.pinned,
      status: conflict.status,
      verdict: conflict.verdict,
      ingredientNames: blockedIngredientNames(conflict.blockedBy, set),
      exclusionIds,
      unverifiable: unique(conflict.unverifiable.map((item) => item.reason)),
      causedByThisChange: exclusionIds.some((id) => highlightExclusionIds.includes(id)),
    }
  })
}

export const PLAN_CONFLICT_PARTS = ["exclusions", "plan"] as const
export type PlanConflictContext = MealContext<(typeof PLAN_CONFLICT_PARTS)[number]>

/** `loadMealContext({ include: PLAN_CONFLICT_PARTS, planRange })` の結果から、衝突の報告を作る。 */
export function buildPlanConflictReport(
  ctx: PlanConflictContext,
  highlightExclusionIds: readonly string[] = [],
): PlanConflictReport {
  return {
    from: ctx.plan.from,
    to: ctx.plan.to,
    conflicts: buildPlanConflictViews(ctx.plan.entries, ctx.exclusions, ctx.lookup, highlightExclusionIds),
    unreadableEntries: ctx.unreadable.plan ?? 0,
    holdMessage: describeAutoConfirmHold(buildExclusionSet(ctx.exclusions, ctx.lookup)),
  }
}

/**
 * 登録された除外 1 件が、今のカタログで何に解決するか（判定と同じ規則。`saveFoodExclusion` の応答用）。
 * 自由入力は `resolveExclusionLabel`、一覧から選んだ品目は「一覧に在るか」で決まる。
 */
export function buildExclusionResolutionView(exclusion: FoodExclusion, lookup: MealLookup): ExclusionResolutionView {
  const { target, reason } = exclusion
  let status: ExclusionResolutionView["status"]
  let targetNames: string[]
  if (target.kind === "custom") {
    const resolution = resolveExclusionLabel(target.label, reason, lookup)
    status = resolution.status
    targetNames = unique([
      ...resolution.allergenIds.map((id) => allergenNameOf(id, lookup.allergens)),
      ...resolution.ingredientIds.map((id) => ingredientNameOf(id, lookup.index)),
    ])
  } else {
    // 一覧から選んだ品目。判定できるかは、判定そのもの（`buildExclusionSet`）に聞く（規則を二重に持たない）
    const known = buildExclusionSet([exclusion], lookup).undetermined.length === 0
    status = known ? "resolved" : "undetermined"
    const name =
      target.kind === "allergen"
        ? allergenNameOf(target.allergenId, lookup.allergens)
        : ingredientNameOf(target.ingredientId, lookup.index)
    targetNames = known ? [name] : []
  }
  const effect: ExclusionResolutionView["effect"] =
    status !== "undetermined" ? "excludes" : reason === "allergy" ? "holds_auto_confirm" : "no_effect"
  const label =
    target.kind === "custom"
      ? target.label
      : (targetNames[0] ?? (target.kind === "allergen" ? target.allergenId : target.ingredientId))
  let message: string
  if (effect === "holds_auto_confirm") {
    message = `「${label}」は、どの食材・料理に当たるかを判定できません。アレルギーとして登録されているため、料理の原材料を確かめられず、献立を確定できなくなります。一覧から選び直すと、該当する料理だけを外して確定できます。`
  } else if (effect === "no_effect") {
    message = `「${label}」は、どの食材・料理に当たるかを判定できません。このままでは何も除外されません。一覧から選び直してください。`
  } else if (status === "name_only") {
    message = `「${label}」は食材の一覧にありません。名前に「${label}」を含む食材・料理だけを外します（判定に限界があります）。`
  } else if (target.kind === "custom") {
    message = `「${label}」は ${targetNames.map((name) => `「${name}」`).join("")} として扱い、該当する料理を外します。`
  } else {
    message = `「${label}」を材料に含む料理を外します。`
  }
  return { status, effect, targetNames, message }
}

// ── 今あるもので ───────────────────────────────────────────────────

export const NOW_VIEW_PARTS = [
  "settings",
  "pantry",
  "exclusions",
  "preferences",
  "feedback",
  "children",
  "members",
] as const
export type NowViewContext = MealContext<(typeof NOW_VIEW_PARTS)[number]>

export interface NowLineView {
  ingredientId: string
  name: string
  optional: boolean
  /** 作る人数に合わせた必要量の表記。 */
  required: string
  state: LineState
  stateLabel: string
  /** その状態になった理由（在庫の記録にもとづく）。 */
  reasons: { code: MatchReason; label: string }[]
  /** 足りない量（`missing`）・確かめられていない量（`uncertain`）の表記。量で言えなければ null。 */
  shortBy: string | null
  /**
   * この材料の総称（「豚肉」「きのこ」など）で登録された食材があり、部位・種類を確かめる必要がある。
   * そのときだけ値を持つ（`state` は `uncertain`、`reasons` は空。数量は引き当てていない）。無ければ null。
   * `buildNowView` は必ず入れる。
   */
  genericStock?: GenericStockView | null
}

/** 総称で登録された食材が、ある材料の候補になっていること（同一視はしていない）。 */
export interface GenericStockView {
  pantryItemIds: string[]
  /** 登録されている名前（「豚肉」）。 */
  names: string[]
  /** 画面へそのまま出せる文。 */
  text: string
}

/** 総称で登録された食材を、材料 1 行の注意にする。該当が無ければ null。 */
export function genericStockView(
  line: Pick<IngredientMatch, "name" | "genericStock">,
  pantryNameOf: (pantryItemId: string) => string | undefined,
): GenericStockView | null {
  if (line.genericStock === undefined || line.genericStock.pantryItemIds.length === 0) return null
  const { pantryItemIds } = line.genericStock
  const names = unique(pantryItemIds.map((id) => pantryNameOf(id)).filter((name): name is string => name !== undefined && name !== ""))
  const stored = names.length === 0 ? "総称の名前" : names.map((name) => `「${name}」`).join("")
  return {
    pantryItemIds: [...pantryItemIds],
    names,
    text: `${stored}で登録されています。${line.name}に当たるか（部位・種類）を確認してください。`,
  }
}

export interface NowReasonView {
  kind: "use_soon" | "expiring" | "preference" | "time"
  /** 順位を上げた理由か、下げた理由か。 */
  tone: "plus" | "minus"
  text: string
  /** 根拠の記録（好みの設定・食後評価）の ID。在庫・時間の理由は null。 */
  recordId: string | null
}

export interface NowAgeWarningView {
  childId: string
  childName: string
  ingredientName: string
  /** true = 生年月日が未登録で判定できない（確認を促す）。 */
  ageUnknown: boolean
  text: string
}

export interface NowCandidateView {
  recipeId: string
  title: string
  role: DishRole
  minutes: number
  includesStaple: boolean
  /** 在庫との突き合わせ（この値で枠が決まる。枠をまたいで混ぜない）。 */
  level: Sufficiency
  /** 全材料の内訳（必須が先）。 */
  lines: NowLineView[]
  /** 必須材料のうち欠けているもの（買い足しの内訳）。 */
  missing: NowLineView[]
  /** 必須材料のうち確認が必要なもの。 */
  toCheck: NowLineView[]
  /** この順位になった理由（実在する在庫・設定・評価の記録からだけ作る）。 */
  reasons: NowReasonView[]
  /** 年齢の制約に触れる材料（例: 1 歳未満のはちみつ）。料理は候補から外さず、注意として示す。 */
  ageWarnings: NowAgeWarningView[]
  /** 取り分け案内（2 歳以降）を出せる子ども。料理が未対応・対象外なら空。 */
  servingChildren: { childId: string; childName: string }[]
}

export interface NowLabelCheckView {
  recipeId: string
  title: string
  role: DishRole
  minutes: number
  reasons: UnverifiableView[]
  /**
   * true = この料理そのものに確認の要る材料は無く、判定できないアレルギーの除外
   * （`NowView.exclusions.holdsAutoConfirm`）のためだけに候補から外している（`reasons` は空）。
   * `buildNowView` は必ず入れる。
   */
  undeterminedHold?: boolean
}

export interface NowView {
  today: string
  servings: number
  /** true = 人数が未設定で、標準の人数で計算している。 */
  usingDefaultServings: boolean
  maxCookMinutes: number | null
  /** 必要な食材と量が揃う候補（基本 3 案）。 */
  ready: NowCandidateView[]
  /** 揃う候補の全件数。0 なら「揃う候補は 0 件」（黙って別の枠で埋めない）。 */
  readyTotal: number
  /** 食材はあるが分量などの確認が必要な候補。 */
  check: NowCandidateView[]
  checkTotal: number
  /** 買い足しが必要な候補（不足は `missing`）。 */
  buy: NowCandidateView[]
  buyTotal: number
  /** 原材料の確認が必要な料理（アレルギーの除外があり成分を確かめられない。候補にしない）。 */
  labelCheck: NowLabelCheckView[]
  /** 使わない食材の設定に当たって外した件数。 */
  excludedCount: number
  /** 揃う候補が 0 件のときの、入力見直しのヒント。 */
  hints: { code: SuggestHint; text: string }[]
  exclusions: ExclusionNoticeView
  /** 登録されている食材の件数と、食材の一覧に解決できていない食材。 */
  pantry: { total: number; unresolved: { id: string; name: string }[] }
  /**
   * 総称（「豚肉」「鶏肉」「牛肉」「きのこ」）で登録された、使える食材。部位・種類とは同一視しないので
   * 「揃う」には数えていない（その材料は「要確認」になり、行の `genericStock` に出る）。
   * 画面は名前を挙げて、具体的な名前で登録し直すよう促す。`buildNowView` は必ず入れる（無ければ空）。
   */
  genericItems?: NowGenericItemView[]
  /** 世帯が設定した常備品の件数（0 なら `STAPLE_RULE_NOTE` を添える）。 */
  stapleCount: number
  /** 読めなかった行の数（0 件の部分は載らない。画面は件数を出す）。 */
  unreadable: NowViewContext["unreadable"]
}

/** 総称で登録された食材 1 件（「今あるもので」の入力見直しの案内）。 */
export interface NowGenericItemView {
  pantryItemId: string
  /** 登録されている名前。 */
  name: string
  /** 食材の一覧での名前（総称）。 */
  ingredientName: string
  /** 画面へそのまま出せる文。 */
  text: string
}

interface CandidateEnv {
  today: string
  lookup: MealLookup
  pantryById: ReadonlyMap<string, PantryItem>
  nameOfMember: (profileId: string) => string | null
  children: readonly MealChild[]
  childById: ReadonlyMap<string, MealChildProfile>
  maxMinutes: number | null
}

function lineView(line: IngredientMatch, env: Pick<CandidateEnv, "pantryById">): NowLineView {
  return {
    ingredientId: line.ingredientId,
    name: line.name,
    optional: line.optional,
    required: formatQuantityJa(line.required),
    state: line.state,
    stateLabel: LINE_STATE_LABELS[line.state] ?? "要確認",
    reasons: line.reasons.map((code) => ({ code, label: MATCH_REASON_LABELS[code] ?? "確認が必要です" })),
    shortBy: line.shortBy === null ? null : formatQuantityJa(line.shortBy),
    genericStock: genericStockView(line, (id) => env.pantryById.get(id)?.name),
  }
}

function preferenceTargetLabel(target: FoodPreference["target"], lookup: MealLookup): string {
  if (target.kind === "recipe") return lookup.recipeById.get(target.id)?.title ?? target.id
  if (target.kind === "ingredient") return ingredientNameOf(target.id, lookup.index)
  return getRecipeTagLabel(target.id) ?? target.id
}

function candidateReasons(suggestion: NowSuggestion, env: CandidateEnv): NowReasonView[] {
  const reasons: NowReasonView[] = []
  const usedIds = unique(
    suggestion.match.lines.filter((line) => !line.optional).flatMap((line) => line.usedItemIds),
  )
  const used = usedIds
    .map((id) => env.pantryById.get(id))
    .filter((item): item is PantryItem => item !== undefined)
  const quote = (names: string[]) => names.map((name) => `「${name}」`).join("")

  const useSoon = unique(used.filter((item) => item.useSoon).map((item) => item.name))
  if (suggestion.score.useSoon > 0 && useSoon.length > 0) {
    reasons.push({ kind: "use_soon", tone: "plus", text: `早く使いたい${quote(useSoon)}を使います`, recordId: null })
  }
  // 期限を過ぎた在庫は突き合わせの時点で材料に数えていない。ここに出るのは当日までに使えるものだけ
  const expiring = unique(
    used.filter((item) => expiryStateOn(item.expiresOn, env.today) === "soon").map((item) => item.name),
  )
  if (suggestion.score.expiring > 0 && expiring.length > 0) {
    reasons.push({ kind: "expiring", tone: "plus", text: `期限が近い${quote(expiring)}を使います`, recordId: null })
  }

  for (const reason of suggestion.preferenceReasons) {
    // 点数に効いていない「ふつう」は文にならない（null）。理由に挙げない
    const base = describePreferenceReason(reason, env.nameOfMember)
    if (base === null) continue
    const detail =
      reason.kind === "explicit"
        ? preferenceTargetLabel(reason.target, env.lookup)
        : formatMealDateShort(reason.eatenOn)
    reasons.push({
      kind: "preference",
      tone: reason.points > 0 ? "plus" : "minus",
      text: `${base}（${detail}）`,
      recordId: reason.kind === "explicit" ? reason.preferenceId : reason.feedbackId,
    })
  }

  if (env.maxMinutes !== null && suggestion.recipe.minutes > env.maxMinutes) {
    reasons.push({
      kind: "time",
      tone: "minus",
      text: `調理時間の目安（${formatMinutes(suggestion.recipe.minutes)}）が、設定した上限（${env.maxMinutes}分）を超えます`,
      recordId: null,
    })
  }
  return reasons
}

function ageWarningText(warning: AgeRuleWarning, childName: string, ageLabel: string | null): string {
  const minAge = formatMinAge(warning.minAgeMonths)
  if (warning.ageUnknown) {
    return `${warning.ingredientName}を使います。${minAge}未満のお子さんには与えません。${childName}の生年月日が未登録のため、年齢を確認してください。`
  }
  return `${warning.ingredientName}を使います。${childName}${ageLabel ? `（${ageLabel}）` : ""}は${minAge}未満のため、与えません。`
}

/** 年齢の制約の判定に要る、世帯の子ども（判定用の形と、表示名を引く表）。 */
export interface AgeRuleEnv {
  lookup: MealLookup
  children: readonly MealChild[]
  childById: ReadonlyMap<string, MealChildProfile>
}

/** `children`（と食事の段階の設定）から、年齢の制約の判定に要る形を作る。 */
export function ageRuleEnvOf(
  lookup: MealLookup,
  children: readonly MealChildProfile[],
  settings: Pick<DinnerSettings, "childStages"> = { childStages: {} },
): AgeRuleEnv {
  return {
    lookup,
    children: toMealChildren(children, settings),
    childById: new Map(children.map((child) => [child.id, child])),
  }
}

/**
 * 材料に年齢の制約（例: 1 歳未満のはちみつ）が掛かる子どもへの注意。`onDate` はその料理を食べる日
 * （月齢はその日で数える）。料理は外さない・置き換えない — 注意として示すだけ。
 * 「今あるもので」・レシピ詳細・献立・今夜で同じ文言になるよう、ここだけで組み立てる。
 */
export function buildAgeWarningViews(
  ingredients: readonly RecipeIngredient[],
  env: AgeRuleEnv,
  onDate: string,
): NowAgeWarningView[] {
  return findAgeRuleWarnings(ingredients, env.children, onDate, env.lookup.index).map((warning) => {
    const child = env.childById.get(warning.childId)
    const childName = childLabelOf(child)
    const ageLabel = formatChildAge(childAgeMonths(child?.birthDate ?? null, onDate))
    return {
      childId: warning.childId,
      childName,
      ingredientName: warning.ingredientName,
      ageUnknown: warning.ageUnknown,
      text: ageWarningText(warning, childName, ageLabel),
    }
  })
}

/**
 * 手で入れた料理の**料理名**に、年齢の制約を持つ食材の名前（別名を含む）が入っているときの注意。
 * 手動料理の材料は任意で、登録された材料が全部とは限らない（「はちみつトースト」に材料が無い等）。
 * 材料から既に出ている食材は重ねない。
 */
export function buildTitleAgeWarningViews(
  title: string,
  alreadyWarned: readonly NowAgeWarningView[],
  env: AgeRuleEnv,
  onDate: string,
): NowAgeWarningView[] {
  const hits: RecipeIngredient[] = []
  for (const def of env.lookup.index.byId.values()) {
    if (!def.ageRule) continue
    const names = [def.name, ...def.aliases].filter((name) => name !== "")
    if (!names.some((name) => title.includes(name))) continue
    hits.push({ ingredientId: def.id, quantity: { amount: null, unit: "to_taste" } })
  }
  if (hits.length === 0) return []
  const seen = new Set(alreadyWarned.map((warning) => `${warning.childId}|${warning.ingredientName}`))
  return buildAgeWarningViews(hits, env, onDate)
    .filter((warning) => !seen.has(`${warning.childId}|${warning.ingredientName}`))
    .map((warning) => ({ ...warning, text: `料理名から判断しました。${warning.text}` }))
}

function ageWarningViews(recipe: RecipeDef, env: CandidateEnv): NowAgeWarningView[] {
  return buildAgeWarningViews(recipe.ingredients, env, env.today)
}

function candidateView(suggestion: NowSuggestion, env: CandidateEnv): NowCandidateView {
  const { recipe, match } = suggestion
  const serving = summarizeChildServing(recipe, env.children, env.today, env.lookup.index)
  return {
    recipeId: recipe.id,
    title: recipe.title,
    role: recipe.role,
    minutes: recipe.minutes,
    includesStaple: recipe.includesStaple === true,
    level: suggestion.level,
    lines: match.lines.map((line) => lineView(line, env)),
    missing: match.missing.map((line) => lineView(line, env)),
    toCheck: match.toCheck.map((line) => lineView(line, env)),
    reasons: candidateReasons(suggestion, env),
    ageWarnings: ageWarningViews(recipe, env),
    servingChildren: serving.perChild
      .filter((entry) => entry.result.show !== null)
      .map((entry) => ({ childId: entry.childId, childName: childLabelOf(env.childById.get(entry.childId)) })),
  }
}

/**
 * 「今あるもので」の結果。`suggestNow` に在庫・除外・好み・評価・常備品を渡し、
 * 揃う候補（基本 3 案）・分量要確認・買い足し案を**別の枠**で返す。
 *
 * @example
 * const ctx = requireMealContext(await loadMealContext(supabase, householdId, { include: NOW_VIEW_PARTS }))
 * const view = buildNowView(ctx)
 */
export function buildNowView(
  ctx: NowViewContext,
  options: { roles?: readonly DishRole[]; limit?: number } = {},
): NowView {
  const { lookup, today, settings } = ctx
  const set = buildExclusionSet(ctx.exclusions, lookup)
  const result = suggestNow({
    today,
    servings: settings.servings,
    pantry: ctx.pantry,
    exclusions: ctx.exclusions,
    preferences: ctx.preferences,
    feedback: ctx.feedback,
    // 常備品は世帯が設定したものだけ（未登録の油・調味料を在庫ありと数えない）
    stapleIngredientIds: settings.stapleIngredientIds,
    catalog: lookup,
    roles: options.roles,
    maxMinutes: settings.maxCookMinutes,
    limit: options.limit,
  })

  const members = new Map(ctx.members.map((member) => [member.id, member]))
  const env: CandidateEnv = {
    today,
    lookup,
    pantryById: new Map(ctx.pantry.map((item) => [item.id, item])),
    nameOfMember: (profileId) => displayNameOf(members.get(profileId)),
    children: toMealChildren(ctx.children, settings),
    childById: new Map(ctx.children.map((child) => [child.id, child])),
    maxMinutes: settings.maxCookMinutes,
  }
  const views = (suggestions: readonly NowSuggestion[]) => suggestions.map((s) => candidateView(s, env))

  return {
    today,
    servings: settings.servings,
    usingDefaultServings: ctx.settingsMissing,
    maxCookMinutes: settings.maxCookMinutes,
    ready: views(result.ready),
    readyTotal: result.readyTotal,
    check: views(result.check),
    checkTotal: result.checkTotal,
    buy: views(result.buy),
    buyTotal: result.buyTotal,
    labelCheck: result.labelCheck.map(({ recipe, unverifiable }) => ({
      recipeId: recipe.id,
      title: recipe.title,
      role: recipe.role,
      minutes: recipe.minutes,
      reasons: unverifiable.map((item) => unverifiableView(item, lookup)),
      undeterminedHold: set.holdsAutoConfirm && unverifiable.length === 0,
    })),
    excludedCount: result.excludedCount,
    hints: result.hints.map((code) => ({ code, text: SUGGEST_HINT_TEXTS[code] ?? "食材の登録内容を確認してください。" })),
    exclusions: buildExclusionNotice(set),
    pantry: {
      total: ctx.pantry.length,
      unresolved: ctx.pantry
        .filter((item) => item.ingredientId === null)
        .map((item) => ({ id: item.id, name: item.name })),
    },
    genericItems: result.genericItems.map((item) => {
      const name = item.name.trim() === "" ? ingredientNameOf(item.ingredientId, lookup.index) : item.name
      return {
        pantryItemId: item.pantryItemId,
        name,
        ingredientName: ingredientNameOf(item.ingredientId, lookup.index),
        text: `「${name}」は部位・種類が分からないため、材料が揃っているとは数えていません。具体的な名前（部位・種類）で登録し直すと、候補に数えます。`,
      }
    }),
    stapleCount: settings.stapleIngredientIds.length,
    unreadable: ctx.unreadable,
  }
}

// ── レシピ詳細 ─────────────────────────────────────────────────────

export const RECIPE_DETAIL_PARTS = ["settings", "exclusions", "children", "members"] as const
export type RecipeDetailContext = MealContext<(typeof RECIPE_DETAIL_PARTS)[number]>

export interface GuidanceSourceView {
  id: string
  title: string
  publisher: string
  url: string
  pages: string
  confirmedOn: string
}

function sourceViews(sourceIds: readonly string[]): GuidanceSourceView[] {
  const views: GuidanceSourceView[] = []
  for (const id of unique(sourceIds)) {
    // 出典表に無い ID は表示を省く（出典を捏造しない）
    const source = getGuidanceSource(id)
    if (!source) continue
    views.push({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      url: source.url,
      pages: source.pages,
      confirmedOn: source.confirmedOn,
    })
  }
  return views
}

export interface RecipeIngredientView {
  ingredientId: string
  name: string
  optional: boolean
  note: string | null
  /** 作る人数に合わせた量（元のレシピの量から一度だけ計算する）。 */
  quantity: Quantity
  quantityText: string
  sectionLabel: string
  /** 食材辞書から導いたアレルゲン（由来する食材のぶんを含む）。 */
  allergens: { id: string; name: string }[]
  /**
   * 「原材料の確認が必要」の印。`varies` = 商品により原材料が異なる。`unknown` = 食材の一覧に無い。
   * null は印なし（辞書の一般的な原材料として `allergens` が成分を表す。混入までは表さない）。
   */
  labelCheck: "varies" | "unknown" | null
  /** 世帯の「使わない食材」に当たる材料。 */
  excluded: boolean
}

export interface RecipeAllergenView {
  id: string
  name: string
  tier: AllergenDef["tier"] | null
  tierLabel: string | null
  /** このアレルゲンを含む材料の表示名。 */
  ingredientNames: string[]
}

export interface RecipeExclusionHitView {
  exclusionId: string
  reason: ExclusionReason
  reasonLabel: string
  targetLabel: string
  subjectLabel: string
  /** 該当した材料の表示名（料理名だけで一致したときは空）。 */
  ingredientNames: string[]
  via: BlockVia[]
}

export interface RecipeAgeWarningView {
  ingredientName: string
  minAgeMonths: number
  /** true = 生年月日が未登録で判定できない。false = 月齢が制約未満。 */
  ageUnknown: boolean
  title: string
  body: string
  sources: GuidanceSourceView[]
}

export type RecipeChildServingView =
  | {
      supported: true
      /** 案内の根拠。常に保護者が設定した食事の段階（月齢だけからは案内を出さない）。 */
      basis: "guardian_stage"
      label: string
      /** 何番目の手順（0 始まり）の前に取り分けるか。 */
      separateBeforeStep: number
      instructions: string[]
      cautions: string[]
      sources: GuidanceSourceView[]
    }
  | { supported: false; reason: ChildServingReason; text: string }

export interface RecipeChildView {
  childId: string
  name: string
  /** 「2歳3か月」。生年月日が未登録なら null。 */
  ageLabel: string | null
  /** 保護者が設定した食事の段階。未設定・読めない値は null（月齢から決めつけない）。 */
  stageLabel: string | null
  serving: RecipeChildServingView
  ageWarnings: RecipeAgeWarningView[]
}

export interface RecipeDetailView {
  today: string
  recipeId: string
  version: number
  title: string
  role: DishRole
  minutes: number
  includesStaple: boolean
  /** 元のレシピが何人分か。 */
  baseServings: number
  /** 表示している量が何人分か。 */
  servings: number
  /** true = 人数が未設定で、標準の人数で計算している（`servings` を指定したときは false）。 */
  usingDefaultServings: boolean
  ingredients: RecipeIngredientView[]
  steps: string[]
  tags: { id: string; label: string }[]
  sourceNote: string
  /** 食材辞書から導いたアレルゲンの一覧（公式の記載順）。一覧に無いものを「含まない」と読まないこと。 */
  allergens: RecipeAllergenView[]
  /** true = 原材料の確認が必要な材料がある、またはレシピのアレルゲン情報が未確認。 */
  needsLabelCheck: boolean
  /** 原材料の確認が必要な材料の表示名。 */
  labelCheckIngredientNames: string[]
  allergenStatus: RecipeDef["allergenStatus"]
  /** 世帯の「使わない食材」との関係。 */
  exclusion: {
    verdict: DishVerdict
    hits: RecipeExclusionHitView[]
    unverifiable: UnverifiableView[]
    notice: ExclusionNoticeView
  }
  /** 料理そのものの取り分け対応（子どもの登録が無くても分かるように）。 */
  childServing: { available: boolean; stageLabel: string | null; minAgeMonths: number | null }
  /** 料理に含まれる、年齢の制約を持つ材料（子どもの登録に依らない一般の注意）。 */
  ageRules: { ingredientName: string; minAgeMonths: number; title: string; body: string; sources: GuidanceSourceView[] }[]
  /** 子どもごとの取り分け案内（または未対応の理由）と、年齢の制約の警告。 */
  children: RecipeChildView[]
}

const CHILD_SERVING_HIDDEN_TEXTS: Readonly<Record<ChildServingReason, string>> = {
  未対応: CHILD_SERVING_UNSUPPORTED_TEXT,
  未設定: "生年月日または食事の段階を確認できないため、取り分け案内を表示していません。",
  離乳開始前: "離乳開始前のため、この料理の取り分け案内の対象外です。",
  対象月齢外: "この年齢・食事の段階は、この料理の取り分け案内の対象外です。",
}

function ageRuleTexts(ruleIngredientId: string, ruleIngredientName: string, minAgeMonths: number, sourceId: string) {
  const rule = AGE_RESTRICTION_RULES.find((candidate) => candidate.ingredientIds.includes(ruleIngredientId))
  return {
    title: rule?.title ?? `${ruleIngredientName}は${formatMinAge(minAgeMonths)}を過ぎてから`,
    body: rule?.body ?? "",
    sources: sourceViews(rule ? rule.sourceIds : [sourceId]),
  }
}

function resolveServings(requested: number | undefined, settings: DinnerSettings): { servings: number; fromRequest: boolean } {
  if (
    typeof requested === "number" &&
    Number.isInteger(requested) &&
    requested >= DINNER_SERVINGS_MIN &&
    requested <= DINNER_SERVINGS_MAX
  ) {
    return { servings: requested, fromRequest: true }
  }
  return { servings: settings.servings, fromRequest: false }
}

/**
 * レシピ詳細。カタログに無い ID は null（画面は `notFound()` へ渡す）。
 *
 * @param options.servings 表示する人数（1〜12 の整数）。不正・未指定なら世帯の設定の人数。
 */
export function buildRecipeDetailView(
  ctx: RecipeDetailContext,
  recipeId: string,
  options: { servings?: number } = {},
): RecipeDetailView | null {
  const { lookup, today, settings } = ctx
  const recipe = lookup.recipeById.get(recipeId)
  if (!recipe) return null

  const { servings, fromRequest } = resolveServings(options.servings, settings)
  const set = buildExclusionSet(ctx.exclusions, lookup)
  const evaluation = evaluateRecipe(recipe, set)
  const people = peopleIndex(ctx.members, ctx.children)
  const exclusionById = new Map(ctx.exclusions.map((exclusion) => [exclusion.id, exclusion]))
  const excludedIngredientIds = new Set(
    evaluation.blockedBy.map((hit) => hit.ingredientId).filter((id): id is string => id !== null),
  )

  const allergenIngredients = new Map<string, string[]>()
  const labelCheckIngredientNames: string[] = []
  const ingredients: RecipeIngredientView[] = recipe.ingredients.map((ingredient) => {
    const def = lookup.index.byId.get(ingredient.ingredientId)
    const name = ingredientNameOf(ingredient.ingredientId, lookup.index)
    const profile = allergenProfileOf(ingredient.ingredientId, lookup.index)
    const labelCheck = profile.unknown ? "unknown" : profile.varies ? "varies" : null
    if (labelCheck !== null && !labelCheckIngredientNames.includes(name)) labelCheckIngredientNames.push(name)
    for (const allergenId of profile.allergens) {
      const names = allergenIngredients.get(allergenId) ?? []
      if (!names.includes(name)) names.push(name)
      allergenIngredients.set(allergenId, names)
    }
    const quantity = scaleQuantity(ingredient.quantity, recipe.servings, servings)
    return {
      ingredientId: ingredient.ingredientId,
      name,
      optional: ingredient.optional === true,
      note: ingredient.note ?? null,
      quantity,
      quantityText: formatQuantityJa(quantity),
      sectionLabel: storeSectionLabel(def?.section ?? "other"),
      allergens: [...profile.allergens].map((id) => ({ id, name: allergenNameOf(id, lookup.allergens) })),
      labelCheck,
      excluded: excludedIngredientIds.has(ingredient.ingredientId),
    }
  })

  // 公式の記載順。一覧に無い ID（古い辞書の値）は末尾に、名前を ID のまま出す
  const knownAllergens: RecipeAllergenView[] = lookup.allergens
    .filter((allergen) => allergenIngredients.has(allergen.id))
    .map((allergen) => ({
      id: allergen.id,
      name: allergen.name,
      tier: allergen.tier,
      tierLabel: ALLERGEN_TIER_LABELS[allergen.tier] ?? null,
      ingredientNames: allergenIngredients.get(allergen.id) ?? [],
    }))
  const unknownAllergens: RecipeAllergenView[] = [...allergenIngredients.keys()]
    .filter((id) => !lookup.allergens.some((allergen) => allergen.id === id))
    .map((id) => ({ id, name: id, tier: null, tierLabel: null, ingredientNames: allergenIngredients.get(id) ?? [] }))

  const hits: RecipeExclusionHitView[] = unique(evaluation.blockedBy.map((hit) => hit.exclusionId)).map(
    (exclusionId) => {
      const own = evaluation.blockedBy.filter((hit) => hit.exclusionId === exclusionId)
      const exclusion = exclusionById.get(exclusionId)
      const labels = exclusion ? describeExclusion(exclusion, lookup, people) : null
      return {
        exclusionId,
        reason: own[0].reason,
        reasonLabel: labels?.reasonLabel ?? EXCLUSION_REASON_LABELS[own[0].reason] ?? "使わない食材",
        targetLabel: labels?.targetLabel ?? "",
        subjectLabel: labels?.subjectLabel ?? HOUSEHOLD_SUBJECT_LABEL,
        ingredientNames: blockedIngredientNames(own, set),
        via: unique(own.map((hit) => hit.via)),
      }
    },
  )

  const mealChildren = toMealChildren(ctx.children, settings)
  const summary = summarizeChildServing(recipe, mealChildren, today, lookup.index)
  const children: RecipeChildView[] = ctx.children.map((child, index) => {
    const mealChild = mealChildren[index]
    const result = summary.perChild.find((entry) => entry.childId === child.id)?.result ?? {
      show: null,
      reason: "未設定" as const,
    }
    const stage = mealChild.mealStage
    const stageLabel =
      stage !== null && (GUARDIAN_MEAL_STAGES as readonly string[]).includes(stage)
        ? GUARDIAN_MEAL_STAGE_LABELS[stage as GuardianMealStage]
        : null
    const serving: RecipeChildServingView =
      result.show !== null
        ? {
            supported: true,
            basis: result.basis,
            label: result.label,
            separateBeforeStep: result.show.separateBeforeStep,
            instructions: [...result.show.instructions],
            cautions: [...result.show.cautions],
            sources: sourceViews(result.show.sourceIds),
          }
        : {
            supported: false,
            reason: result.reason,
            text: CHILD_SERVING_HIDDEN_TEXTS[result.reason] ?? CHILD_SERVING_UNSUPPORTED_TEXT,
          }
    return {
      childId: child.id,
      name: childLabelOf(child),
      ageLabel: formatChildAge(childAgeMonths(child.birthDate, today)),
      stageLabel,
      serving,
      ageWarnings: summary.warnings
        .filter((warning) => warning.childId === child.id)
        .map((warning) => ({
          ingredientName: warning.ingredientName,
          minAgeMonths: warning.minAgeMonths,
          ageUnknown: warning.ageUnknown,
          ...ageRuleTexts(
            warning.ruleIngredientId,
            ingredientNameOf(warning.ruleIngredientId, lookup.index),
            warning.minAgeMonths,
            warning.sourceId,
          ),
        })),
    }
  })

  // 子どもの登録に依らない一般の注意。生年月日の無い仮の子で、制約を持つ材料を全部挙げる
  const ageRules = findAgeRuleWarnings(
    recipe.ingredients,
    [{ id: "", birthDate: null, mealStage: null }],
    today,
    lookup.index,
  ).map((warning) => ({
    ingredientName: warning.ingredientName,
    minAgeMonths: warning.minAgeMonths,
    ...ageRuleTexts(
      warning.ruleIngredientId,
      ingredientNameOf(warning.ruleIngredientId, lookup.index),
      warning.minAgeMonths,
      warning.sourceId,
    ),
  }))

  return {
    today,
    recipeId: recipe.id,
    version: recipe.version,
    title: recipe.title,
    role: recipe.role,
    minutes: recipe.minutes,
    includesStaple: recipe.includesStaple === true,
    baseServings: recipe.servings,
    servings,
    usingDefaultServings: ctx.settingsMissing && !fromRequest,
    ingredients,
    steps: [...recipe.steps],
    tags: recipe.tags.map((id) => ({ id, label: getRecipeTagLabel(id) ?? id })),
    sourceNote: recipe.source.note,
    allergens: [...knownAllergens, ...unknownAllergens],
    needsLabelCheck: labelCheckIngredientNames.length > 0 || recipe.allergenStatus === "unconfirmed",
    labelCheckIngredientNames,
    allergenStatus: recipe.allergenStatus,
    exclusion: {
      verdict: evaluation.verdict,
      hits,
      unverifiable: evaluation.unverifiable.map((item) => unverifiableView(item, lookup)),
      notice: buildExclusionNotice(set),
    },
    childServing: {
      available: recipe.childServing !== undefined,
      stageLabel: recipe.childServing ? (CHILD_SERVING_STAGE_LABELS[recipe.childServing.stage] ?? null) : null,
      minAgeMonths: recipe.childServing?.minAgeMonths ?? null,
    },
    ageRules,
    children,
  }
}

// ── 設定画面 ───────────────────────────────────────────────────────

export const SETTINGS_VIEW_PARTS = [
  "settings",
  "exclusions",
  "preferences",
  "feedback",
  "children",
  "members",
] as const
export type SettingsViewContext = MealContext<(typeof SETTINGS_VIEW_PARTS)[number]>

export interface SettingsExclusionView extends ExclusionLabels {
  id: string
  reason: ExclusionReason
  target: FoodExclusion["target"]
  subject: FoodExclusion["subject"]
  /** true = 食材の一覧へ解決できず、名前の一致でしか判定できない。 */
  limited: boolean
  /**
   * この除外が献立へどう効いているか。`excludes` = 該当する料理を外す。
   * `holds_auto_confirm` = 判定できないアレルギー（何も外せていないので、どの料理も自動では確定しない）。
   * `no_effect` = 判定できない苦手（**何も除外されていない**）。
   * 後ろ 2 つは、一覧から選び直すよう促すこと。`buildSettingsView` は必ず入れる。
   */
  effect?: "excludes" | "holds_auto_confirm" | "no_effect"
}

export interface SettingsPreferenceView {
  id: string
  version: string
  scope: FoodPreference["scope"]
  /** 個人の好みの持ち主。家族共通は null。 */
  profileId: string | null
  /** 持ち主の表示名（家族共通は「家族共通」）。 */
  ownerLabel: string
  /** true = 見ている本人が変更・削除できる（家族共通、または本人の個人の好み）。 */
  editable: boolean
  target: FoodPreference["target"]
  targetLabel: string
  /** false = カタログに無い対象（採点には効かない。削除だけできる）。 */
  targetKnown: boolean
  sentiment: FoodPreference["sentiment"]
}

/** 「覚えた好み」= 食後の評価 1 件（誰が・いつ・何を）。 */
export interface SettingsFeedbackView {
  id: string
  profileId: string
  /** 評価した本人の表示名。 */
  who: string
  /** true = 見ている本人の評価（削除できるのは本人だけ）。 */
  mine: boolean
  eatenOn: string
  dishTitle: string
  recipeId: string | null
  taste: 1 | 2 | 3 | null
  tasteLabel: string | null
  effort: 1 | 2 | 3 | null
  effortLabel: string | null
  again: boolean | null
  /** true = その日の気分などで、好みへ反映しない記録。 */
  excludeFromLearning: boolean
}

export interface SettingsStapleView {
  id: string
  name: string
  sectionLabel: string
  selected: boolean
  /** false = 食材の一覧に無い ID（選択済みのものだけ。外すことはできる）。 */
  known: boolean
}

export interface SettingsChildView {
  childId: string
  name: string
  ageLabel: string | null
  /** 保護者が設定した食事の段階（保存されている値のまま）。未設定は null。 */
  stage: string | null
  /** 段階の表示名。未設定・アプリが知らない値は null。 */
  stageLabel: string | null
}

export interface SettingsView {
  today: string
  /** 見ている本人。 */
  viewerId: string
  settings: DinnerSettings
  /** true = 設定が未登録で、標準の人数などの既定値を表示している。 */
  settingsMissing: boolean
  /** アレルゲンの選択肢（公式の記載順）と、一覧の出典。件数は `allergens.items.length` から求める。 */
  allergens: {
    items: { id: string; name: string; tier: AllergenDef["tier"]; tierLabel: string }[]
    meta: AllergenListMeta
    versionNote: string
  }
  exclusions: SettingsExclusionView[]
  /** 読めなかった除外の行の数（0 でなければ「全部は表示できていない」と出す）。 */
  unreadableExclusions: number
  exclusionNotice: ExclusionNoticeView
  preferences: SettingsPreferenceView[]
  feedback: SettingsFeedbackView[]
  /** 食後評価を読んだ範囲の開始日。 */
  feedbackSince: string
  /** 常備品の候補（提示だけ。自動登録はしない）と、選択済みの常備品。 */
  staples: SettingsStapleView[]
  children: SettingsChildView[]
  /** 食事の段階の選択肢（ロジックの語彙どおり）。 */
  stageOptions: { value: GuardianMealStage; label: string }[]
  members: { id: string; displayName: string; isViewer: boolean }[]
  /** 好みの対象の選択肢。 */
  preferenceOptions: {
    recipes: { id: string; title: string; role: DishRole }[]
    ingredients: { id: string; name: string }[]
    tags: { id: string; label: string }[]
  }
  /** 除外の対象に選べる食材。 */
  ingredientOptions: { id: string; name: string; sectionLabel: string }[]
  unreadable: SettingsViewContext["unreadable"]
}

/**
 * 設定画面用。アレルゲン一覧と出典・登録済みの除外・好み・食後評価の一覧・常備品の候補・
 * 子どもの食事の段階。
 *
 * 除外を `loadMealContext` の `tolerateUnreadableExclusions: true` で読むこと（読めない行が在っても、
 * 読めた除外の一覧と削除を出せるようにする。件数は `unreadableExclusions`）。
 *
 * @param viewerId 見ている本人（`getAuthContext()` の `userId`）。クライアントの入力を渡さない。
 */
export function buildSettingsView(ctx: SettingsViewContext, viewerId: string): SettingsView {
  const { lookup, today, settings } = ctx
  const people = peopleIndex(ctx.members, ctx.children)
  const set = buildExclusionSet(ctx.exclusions, lookup)
  const limitedIds = new Set(set.limited.map((item) => item.exclusionId))
  const undeterminedReasons = new Map(set.undetermined.map((item) => [item.exclusionId, item.reason]))
  const ingredientDefs = [...lookup.index.byId.values()]

  const preferences: SettingsPreferenceView[] = ctx.preferences.map((preference) => {
    const { target } = preference
    const targetKnown =
      target.kind === "recipe"
        ? lookup.recipeById.has(target.id)
        : target.kind === "ingredient"
          ? lookup.index.byId.has(target.id)
          : getRecipeTagLabel(target.id) !== undefined
    const owner = preference.profileId === null ? undefined : people.members.get(preference.profileId)
    return {
      id: preference.id,
      version: preference.version,
      scope: preference.scope,
      profileId: preference.profileId,
      ownerLabel:
        preference.scope === "household" ? "家族共通" : owner ? (displayNameOf(owner) ?? "家族（名前未設定）") : "世帯にいない人",
      editable: preference.scope === "household" || preference.profileId === viewerId,
      target,
      targetLabel: preferenceTargetLabel(target, lookup),
      targetKnown,
      sentiment: preference.sentiment,
    }
  })

  const feedback: SettingsFeedbackView[] = [...ctx.feedback]
    .sort((a, b) => b.eatenOn.localeCompare(a.eatenOn) || a.id.localeCompare(b.id))
    .map((row) => {
      const member = people.members.get(row.profileId)
      const recipeTitle = row.recipeId === null ? undefined : lookup.recipeById.get(row.recipeId)?.title
      return {
        id: row.id,
        profileId: row.profileId,
        who: member ? (displayNameOf(member) ?? "家族（名前未設定）") : "世帯にいない人",
        mine: row.profileId === viewerId,
        eatenOn: row.eatenOn,
        dishTitle: recipeTitle ?? (row.dishTitle.trim() !== "" ? row.dishTitle : "名前のない料理"),
        recipeId: row.recipeId,
        taste: row.taste,
        tasteLabel: row.taste === null ? null : (TASTE_LABELS[row.taste] ?? null),
        effort: row.effort,
        effortLabel: row.effort === null ? null : (EFFORT_LABELS[row.effort] ?? null),
        again: row.again,
        excludeFromLearning: row.excludeFromLearning,
      }
    })

  const selected = new Set(settings.stapleIngredientIds)
  const candidateStaples: SettingsStapleView[] = ingredientDefs
    .filter((def) => def.stapleCandidate === true || selected.has(def.id))
    .map((def) => ({
      id: def.id,
      name: def.name,
      sectionLabel: storeSectionLabel(def.section),
      selected: selected.has(def.id),
      known: true,
    }))
  const unknownStaples: SettingsStapleView[] = settings.stapleIngredientIds
    .filter((id) => !lookup.index.byId.has(id))
    .map((id) => ({ id, name: id, sectionLabel: storeSectionLabel("other"), selected: true, known: false }))

  return {
    today,
    viewerId,
    settings,
    settingsMissing: ctx.settingsMissing,
    allergens: {
      items: lookup.allergens.map((allergen) => ({
        id: allergen.id,
        name: allergen.name,
        tier: allergen.tier,
        tierLabel: ALLERGEN_TIER_LABELS[allergen.tier] ?? "",
      })),
      meta: { ...ALLERGEN_LIST_META },
      versionNote: ALLERGEN_LIST_VERSION_NOTE,
    },
    exclusions: ctx.exclusions.map((exclusion) => ({
      id: exclusion.id,
      reason: exclusion.reason,
      target: exclusion.target,
      subject: exclusion.subject,
      limited: limitedIds.has(exclusion.id),
      effect: !undeterminedReasons.has(exclusion.id)
        ? ("excludes" as const)
        : undeterminedReasons.get(exclusion.id) === "allergy"
          ? ("holds_auto_confirm" as const)
          : ("no_effect" as const),
      ...describeExclusion(exclusion, lookup, people),
    })),
    unreadableExclusions: ctx.unreadable.exclusions ?? 0,
    exclusionNotice: buildExclusionNotice(set),
    preferences,
    feedback,
    feedbackSince: ctx.feedbackSince,
    staples: [...candidateStaples, ...unknownStaples],
    children: ctx.children.map((child) => {
      const stage = Object.prototype.hasOwnProperty.call(settings.childStages, child.id)
        ? settings.childStages[child.id]
        : null
      return {
        childId: child.id,
        name: childLabelOf(child),
        ageLabel: formatChildAge(childAgeMonths(child.birthDate, today)),
        stage,
        stageLabel:
          stage !== null && (GUARDIAN_MEAL_STAGES as readonly string[]).includes(stage)
            ? GUARDIAN_MEAL_STAGE_LABELS[stage as GuardianMealStage]
            : null,
      }
    }),
    stageOptions: GUARDIAN_MEAL_STAGES.map((value) => ({ value, label: GUARDIAN_MEAL_STAGE_LABELS[value] })),
    members: ctx.members.map((member) => ({
      id: member.id,
      displayName: displayNameOf(member) ?? "家族（名前未設定）",
      isViewer: member.id === viewerId,
    })),
    preferenceOptions: {
      recipes: lookup.recipes.map((recipe) => ({ id: recipe.id, title: recipe.title, role: recipe.role })),
      ingredients: ingredientDefs.map((def) => ({ id: def.id, name: def.name })),
      tags: RECIPE_TAGS.map((tag) => ({ id: tag.id, label: tag.label })),
    },
    ingredientOptions: ingredientDefs.map((def) => ({
      id: def.id,
      name: def.name,
      sectionLabel: storeSectionLabel(def.section),
    })),
    unreadable: ctx.unreadable,
  }
}
