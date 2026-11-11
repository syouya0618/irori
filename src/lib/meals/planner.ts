/**
 * 1〜7 日分の夕食献立（規則ベースの自動献立。生成 AI に依存しない）。
 *
 * 規則:
 * - 必須除外は絶対。候補を選ぶ前と、結果を返す直前の 2 回検証する。点数では緩めない。
 * - 採点の優先: 在庫利用 → 時間 → 好み（希望を含む）→ 重複回避 → 使い切り。
 * - 偏りを避ける: 主菜の主たんぱくを連日にせず、主菜・副菜で同じたんぱく源（卵・豚 …）は
 *   期間内 2 品までを目安にする。どちらも減点で、在庫で揃う料理と「魚多め」等の希望はそれより優先する。
 * - 主菜＋副菜が基本。主食・汁物は設定で足す。主食を含む料理（丼・カレー・麺）の日は主食を足さない。
 * - 主食の既定は「素の主食」（ごはん = 材料が主食の食材 1 つだけ）。麺・パン・炊き込みは、
 *   在庫で作れるとき・希望されたときに選ぶ。主食は調理時間の長さでは減点しない
 *   （炊飯は並行してできる。時間の希望が明示されたときは、その上限を主食でも守る）。
 * - 固定枠（pinned）と作り終えた枠（cooked）は、全体再生成・1 日差替え・1 品差替えのどれでも保持する。
 * - 1 日の差替えは、その日に在った区分（主食・汁物・手で足した枠を含む）を黙って消さない。
 *   区分ごとに 1 品を選び直し、同じ区分の 2 品目以降は残す。主食を含む主菜へ替わった日の主食だけは
 *   外し、外したことを `droppedEntries` で返す。
 * - 在庫の引当は**日付順に計画上で**行い、同じ在庫を複数日へ二重に配らない。
 *   実在庫は変更せず、引当は `allocations` として別に返す。
 *   「早く使いたい」・期限の近い食材は、日付順に選ぶ際の加点で前半の日へ寄せる。
 * - 候補が足りなくても除外を破らない。主菜・副菜は期間内で同じ料理を繰り返さず、
 *   足りない枠は `gaps` に理由つきで返す（主食・汁物は繰り返してよい）。
 * - 決定的: 同じ入力（`seed` を含む）からは同じ結果。乱数は使わず、`seed` からの決定的な揺らぎだけ。
 * - 子どもの人数や年齢から量を換算しない。人数は呼び出し側が渡す数だけを使う。
 */

import { daysBetweenYmd, isValidYmd, shiftYmd } from "@/lib/utils/date-jst"

import {
  buildExclusionSet,
  evaluateEntry,
  evaluateRecipe,
  type ExclusionSet,
  findPlanConflicts,
  partitionRecipes,
  type PlanConflict,
  type RecipePartition,
} from "./exclusions"
import { type CatalogInput, type CatalogView, lineageOf, toCatalogView } from "./lookup"
import {
  type IngredientMatch,
  type MatchableDish,
  matchDishToPantry,
  type PantryMatch,
  reserveConsumption,
  type Sufficiency,
} from "./pantry-match"
import { type PreferenceReason, scoreRecipePreference } from "./preferences"
import type {
  DishFeedback,
  DishRole,
  FoodExclusion,
  FoodPreference,
  PantryItem,
  PlanEntry,
  Quantity,
  RecipeDef,
  WishConstraints,
} from "./types"
import { toBaseAmount } from "./units"

/** 家族人数が未設定のときに明示して使う標準の人数。 */
export const DEFAULT_DINNER_SERVINGS = 2
export const MIN_PLAN_DAYS = 1
export const MAX_PLAN_DAYS = 7
export const MAX_SERVINGS = 20

export const PLAN_WEIGHTS = {
  stockReady: 40,
  stockCheck: 20,
  stockBuyMax: 16,
  useSoonPerItem: 8,
  useSoonMax: 16,
  expiringPerItem: 8,
  expiringMax: 16,
  overMaxMinutes: -30,
  minutesDivisor: 15,
  minutesMax: 6,
  preferenceClamp: 12,
  preferTag: 6,
  preferTagMax: 12,
  avoidTag: -15,
  preferRecipeTop: 10,
  preferRecipeStep: 2,
  // 連日・期間内 3 品目の減点は、在庫が無いときの候補どうしの点差（常備品の割合・時間・揺らぎの合計）
  // より大きく、「在庫で揃う」（stockReady）と買い足しの差よりは小さくする。
  // = 買い足しの候補どうしでは偏らせず、在庫で作れる料理は連日でも優先する。
  sameProteinAdjacent: -20,
  sameProteinTwoDays: -3,
  proteinThirdInPlan: -20,
  cookedWithin7Days: -10,
  cookedWithin14Days: -5,
  stapleAlreadyPlanned: -15,
  repeatedSoup: -10,
  repeatedStaple: -1,
  // 素の主食（ごはん）と、希望された主食への加点。在庫が無いときの他の主食の点
  // （買い足しの最大 stockBuyMax 未満 + 揺らぎ seedJitterMax 未満 = 18 未満）より大きく、
  // 在庫がある主食（stockCheck = 20 以上）よりは小さくする。
  // = 何も無ければ ごはん、在庫で作れる麺・パンがあればそちら。
  plainStaple: 18,
  useUpPerItem: 3,
  useUpMax: 6,
  seedJitterMax: 2,
} as const

/**
 * 主たんぱくを表すタグ（先に一致したものを採る）。無ければ材料の売場から推定する。
 * ひき肉の料理（ハンバーグ・麻婆豆腐・つくね）は肉の種類より先に「ひき肉」として数える。
 * 肉・魚を使う料理の卵・豆腐は副材料として扱う（親子丼は鶏、肉豆腐は牛）。
 */
export const PROTEIN_TAGS: readonly string[] = [
  "ground_meat", "pork", "chicken", "beef", "fish", "seafood", "egg", "tofu",
]

const ROLE_ORDER: readonly DishRole[] = ["main", "side", "staple", "soup"]

export interface PlannerOptions {
  /** 主食（ご飯など）の枠を足す。主食を含む料理の日は足さない。既定 false。 */
  includeStaple?: boolean
  /** 汁物の枠を足す。既定 false。 */
  includeSoup?: boolean
  /** 同点付近の候補を入れ替えるための種。省略時は揺らぎなし。 */
  seed?: number
  /** 希望から作った固定枠の出所（規則ベース = "auto"、AI 補助 = "ai_assisted"）。 */
  wishOrigin?: PlanEntry["origin"]
}

export interface PlanInput {
  startDate: string
  /** 1〜7。 */
  days: number
  /** 新しく作る枠の人数。 */
  servings: number
  /** 今日（在庫の最終確認の古さを判定する日）。省略時は `startDate`。 */
  today?: string
  /** 既存の枠（固定枠・作り終えた枠を含む）。期間外の枠は無視する。 */
  existingEntries: readonly PlanEntry[]
  pantry: readonly PantryItem[]
  exclusions: readonly FoodExclusion[]
  preferences?: readonly FoodPreference[]
  feedback?: readonly DishFeedback[]
  /** 期間より前に作った料理（重複回避に使う）。「作らなかった」枠は入れない。 */
  recentHistory?: readonly { date: string; recipeId: string }[]
  wish?: WishConstraints | null
  /** 世帯が設定した常備品。 */
  stapleIngredientIds?: readonly string[]
  catalog: CatalogInput
  options?: PlannerOptions
}

export interface PlanScore {
  total: number
  stock: number
  time: number
  preference: number
  variety: number
  useUp: number
  jitter: number
}

export interface EntryStock {
  level: Sufficiency
  missing: IngredientMatch[]
  toCheck: IngredientMatch[]
}

export interface PlannedEntry extends Omit<PlanEntry, "id"> {
  /** 既存の枠の ID。新しい枠は null（保存時に採番する）。 */
  id: string | null
  /** 引当などから参照するための鍵（既存は ID、新規は `new:日付:区分:位置`）。 */
  key: string
  title: string
  /** 既存の枠をそのまま残したもの。 */
  kept: boolean
  /** 在庫との突き合わせ（作り終えた枠・材料の無い手動料理は null）。 */
  stock: EntryStock | null
  /** 新しく選んだ枠の採点の内訳。 */
  score: PlanScore | null
  /** 実記録・明示設定に基づく好みの理由。 */
  preferenceReasons: PreferenceReason[]
}

export type GapReason =
  /** その料理区分のレシピがカタログに無い。 */
  | "no_recipes"
  /** 全ての候補が必須除外に当たる。 */
  | "all_excluded"
  /** 残る候補は原材料の確認が必要なものだけ。 */
  | "needs_label_check"
  /** 使える候補を期間内で使い切った。 */
  | "exhausted"

export interface PlanGap {
  date: string
  role: DishRole
  reason: GapReason
  detail: { total: number; blocked: number; labelCheck: number; alreadyUsed: number }
}

export interface StockAllocation {
  date: string
  entryKey: string
  pantryItemId: string
  ingredientId: string
  /** 基準単位での量。 */
  quantity: Quantity
  /** false = 最終確認が古い在庫からの見込み。 */
  certain: boolean
}

export type PinRejection =
  | "out_of_range"
  | "unknown_recipe"
  | "excluded"
  | "needs_label_check"
  | "slot_taken"

export interface PlanResult {
  startDate: string
  days: number
  /** 期間内の全ての枠（残した既存の枠 + 新しい枠）。日付・位置の順。 */
  entries: PlannedEntry[]
  /** 埋められなかった枠と理由。 */
  gaps: PlanGap[]
  /** 計画上の在庫の引当（実在庫は変えていない）。 */
  allocations: StockAllocation[]
  /** 残した既存の枠のうち、現在の必須除外に当たるもの（置換はしていない）。 */
  conflicts: PlanConflict[]
  /** 採用しなかった希望の固定。 */
  rejectedPins: { date: string; recipeId: string; reason: PinRejection }[]
  /** 結果に含まれない既存の枠（保存時に削除する対象）。 */
  removedEntryIds: string[]
  /** 差替えで他の候補が無く、元のまま残した枠。 */
  unchanged: { entryId: string; reason: "no_alternative" }[]
  /**
   * 1 日の差替えで、選び直さずに外した枠（`removedEntryIds` にも入る）。画面で知らせること。
   * `main_includes_staple` = 主食を含む主菜（丼・カレー・麺）へ替わったので、その日の主食を外した。
   */
  droppedEntries: { entryId: string; date: string; role: DishRole; reason: "main_includes_staple" }[]
}

export class PlanInputError extends RangeError {
  constructor(
    readonly code: "invalid_start_date" | "invalid_days" | "invalid_servings",
    message: string,
  ) {
    super(message)
    this.name = "PlanInputError"
  }
}

/** 期間と人数を検証する（不正なら PlanInputError）。 */
export function assertPlanInput(startDate: string, days: number, servings: number): void {
  if (!isValidYmd(startDate)) throw new PlanInputError("invalid_start_date", "startDate must be YYYY-MM-DD")
  if (!Number.isInteger(days) || days < MIN_PLAN_DAYS || days > MAX_PLAN_DAYS) {
    throw new PlanInputError("invalid_days", "days must be an integer from 1 to 7")
  }
  if (!Number.isFinite(servings) || servings <= 0 || servings > MAX_SERVINGS) {
    throw new PlanInputError("invalid_servings", "servings must be within 1 to 20")
  }
}

export function planDates(startDate: string, days: number): string[] {
  return Array.from({ length: days }, (_, i) => shiftYmd(startDate, i))
}

/** 重複回避に使う主たんぱくの鍵。タグが無ければ、肉・魚の材料の由来の根を使う。 */
export function mainProteinKey(recipe: RecipeDef, view: CatalogView): string | null {
  const tag = PROTEIN_TAGS.find((candidate) => recipe.tags.includes(candidate))
  if (tag) return `tag:${tag}`
  for (const ingredient of recipe.ingredients) {
    if (ingredient.optional === true) continue
    const def = view.index.byId.get(ingredient.ingredientId)
    if (!def || (def.section !== "meat" && def.section !== "fish")) continue
    const ancestors = lineageOf(def.id, view.index).ancestors
    const root = ancestors.find((id) => (view.index.byId.get(id)?.derivedFrom ?? []).length === 0)
    return `ingredient:${root ?? def.id}`
  }
  return null
}

/** `seed` と文字列から 0 以上 1 未満の決定的な値を作る（FNV-1a）。 */
function seededUnit(seed: number, text: string): number {
  let hash = 0x811c9dc5 ^ (seed | 0)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x100000000
}

// ── 内部の作業状態 ─────────────────────────────────────────────────

/** これから計画へ置く枠（既存の枠、または希望から作った固定枠）。 */
type Seed = Omit<PlanEntry, "id"> & { id: string | null; kept: boolean }

interface Context {
  input: PlanInput
  view: CatalogView
  set: ExclusionSet
  dates: string[]
  today: string
  byRole: ReadonlyMap<DishRole, RecipePartition>
  itemTotals: ReadonlyMap<string, number>
  wish: WishConstraints | null
  /** 候補にできる素の主食（ごはん）のうち、希望の点の最大。素の主食が候補に無ければ 0。 */
  plainStapleWish: number
  options: Required<Pick<PlannerOptions, "includeStaple" | "includeSoup">> & PlannerOptions
}

interface ForcedSlot {
  date: string
  role: DishRole
  /**
   * その日に主食を含む料理（丼・カレー・麺）が在れば、選び直さずに外す（1 日の差替えの主食）。
   * 外した枠は `droppedEntries` で返す。
   */
  unlessDayIncludesStaple?: boolean
}

interface FillRequest {
  seeds: Seed[]
  /** この日は、足りない区分の枠を自動で埋める。 */
  fillDate: (date: string) => boolean
  /** 区分が既に埋まっていても必ず選び直す枠（1 品差替え）。 */
  forced: readonly ForcedSlot[]
  /** 候補にしないレシピ（差替え前の料理など）。 */
  avoid: ReadonlySet<string>
  /** 他の候補が無いときに元へ戻す枠（`日付|区分` → 元の枠）。 */
  fallback: ReadonlyMap<string, PlanEntry>
  rejectedPins: PlanResult["rejectedPins"]
}

interface WorkState {
  reserved: Map<string, number>
  usedRecipeIds: Set<string>
  proteinByDate: Map<string, string | null>
  /** たんぱく源の鍵 → 期間内の主菜・副菜の品数（固定枠・既存の枠を含む）。 */
  proteinDishCount: Map<string, number>
  cookedDates: Map<string, string[]>
  entries: PlannedEntry[]
  gaps: PlanGap[]
  allocations: StockAllocation[]
  unchanged: PlanResult["unchanged"]
  dropped: PlanResult["droppedEntries"]
}

function makeContext(input: PlanInput): Context {
  assertPlanInput(input.startDate, input.days, input.servings)
  const view = toCatalogView(input.catalog)
  const set = buildExclusionSet(input.exclusions, view)
  const byRole = new Map<DishRole, RecipePartition>()
  for (const role of ROLE_ORDER) {
    byRole.set(role, partitionRecipes(view.recipes.filter((recipe) => recipe.role === role), set))
  }
  const itemTotals = new Map<string, number>()
  for (const item of input.pantry) {
    const total = item.quantity ? toBaseAmount(item.quantity) : null
    if (total !== null) itemTotals.set(item.id, total)
  }
  const wish = input.wish ?? null
  const plainStapleWish = (byRole.get("staple")?.allowed ?? [])
    .filter((recipe) => isPlainStaple(recipe, view))
    .reduce((best, recipe) => Math.max(best, stapleWishPoints(recipe, wish)), 0)
  return {
    input,
    view,
    set,
    dates: planDates(input.startDate, input.days),
    today: input.today ?? input.startDate,
    byRole,
    itemTotals,
    wish,
    plainStapleWish,
    options: {
      ...input.options,
      includeStaple: input.options?.includeStaple ?? false,
      includeSoup: input.options?.includeSoup ?? false,
    },
  }
}

function slotKey(date: string, role: DishRole): string {
  return `${date}|${role}`
}

function recipeOf(seed: Pick<PlanEntry, "recipeId">, ctx: Context): RecipeDef | null {
  return seed.recipeId === null ? null : (ctx.view.recipeById.get(seed.recipeId) ?? null)
}

function dishOf(seed: Seed, ctx: Context): MatchableDish | null {
  const recipe = recipeOf(seed, ctx)
  if (recipe) return recipe
  if (seed.recipeId !== null) return null
  if (!seed.customIngredients || seed.customIngredients.length === 0) return null
  // 手動料理の材料は、その枠の人数ぶんとして登録されている
  return { ingredients: seed.customIngredients, servings: seed.servings }
}

function toStock(match: PantryMatch): EntryStock {
  return { level: match.level, missing: match.missing, toCheck: match.toCheck }
}

function matchFor(dish: MatchableDish, servings: number, date: string, ctx: Context, state: WorkState): PantryMatch {
  return matchDishToPantry(dish, servings, ctx.input.pantry, {
    eatOn: date,
    today: ctx.today,
    stapleIngredientIds: ctx.input.stapleIngredientIds,
    reserved: state.reserved,
    index: ctx.view.index,
  })
}

function recordAllocation(entry: PlannedEntry, match: PantryMatch, state: WorkState): void {
  reserveConsumption(state.reserved, match.consumption)
  for (const c of match.consumption) {
    state.allocations.push({
      date: entry.date,
      entryKey: entry.key,
      pantryItemId: c.pantryItemId,
      ingredientId: c.ingredientId,
      quantity: c.quantity,
      certain: c.certain,
    })
  }
}

function noteCooked(state: WorkState, recipeId: string | null, date: string): void {
  if (recipeId === null) return
  state.cookedDates.set(recipeId, [...(state.cookedDates.get(recipeId) ?? []), date])
}

/** 既存の枠・固定枠を計画へ置き、作り終えていなければ在庫を引き当てる。 */
function placeSeed(seed: Seed, ctx: Context, state: WorkState): PlannedEntry {
  const recipe = recipeOf(seed, ctx)
  const entry: PlannedEntry = {
    ...seed,
    key: seed.id ?? `new:${seed.date}:${seed.role}:${seed.position}`,
    title: recipe?.title ?? seed.customTitle ?? seed.recipeId ?? "",
    stock: null,
    score: null,
    preferenceReasons: [],
  }
  const dish = dishOf(seed, ctx)
  if (dish && seed.status !== "cooked" && seed.status !== "skipped") {
    const match = matchFor(dish, seed.servings, seed.date, ctx, state)
    entry.stock = toStock(match)
    recordAllocation(entry, match, state)
  }
  if (seed.status === "cooked") noteCooked(state, seed.recipeId, seed.date)
  if (recipe && seed.status !== "skipped") {
    state.usedRecipeIds.add(recipe.id)
    if (seed.role === "main") state.proteinByDate.set(seed.date, mainProteinKey(recipe, ctx.view))
  }
  state.entries.push(entry)
  return entry
}

// ── 採点 ───────────────────────────────────────────────────────────

function stockPoints(match: PantryMatch): number {
  const w = PLAN_WEIGHTS
  const base =
    match.level === "ready"
      ? w.stockReady
      : match.level === "check"
        ? w.stockCheck
        : match.requiredCount === 0
          ? 0
          : Math.round((w.stockBuyMax * match.satisfiedCount) / match.requiredCount)
  return (
    base +
    Math.min(match.useSoonCount * w.useSoonPerItem, w.useSoonMax) +
    Math.min(match.expiringSoonCount * w.expiringPerItem, w.expiringMax)
  )
}

function timePoints(recipe: RecipeDef, wish: WishConstraints | null): number {
  const w = PLAN_WEIGHTS
  if (exceedsMaxMinutes(recipe, wish)) return w.overMaxMinutes
  // 主食は時間の長さで減点しない（ごはんの 60 分は炊飯時間で、他の料理と並行してできる。
  // 減点すると、在庫の無い世帯ではトースト・うどんばかりが選ばれる）
  if (recipe.role === "staple") return 0
  return -Math.min(w.minutesMax, recipe.minutes / w.minutesDivisor)
}

/** 素の主食: 必須の材料が主食の食材 1 つだけ（ごはん = 米を炊くだけ）。 */
export function isPlainStaple(recipe: RecipeDef, view: CatalogView): boolean {
  if (recipe.role !== "staple") return false
  const required = recipe.ingredients.filter((ingredient) => ingredient.optional !== true)
  return required.length === 1 && view.index.byId.get(required[0].ingredientId)?.section === "staple"
}

/**
 * 主食の選び分けには使わない希望のタグ。「時短」は主菜・副菜の手間の希望で、ごはんは並行して炊ける
 * （これで主食を選び分けると、時短の希望だけで主食がトースト・うどんの繰り返しになる）。
 * 調理時間の上限（`maxMinutes`）は別で、明示されたときは主食でも守る。
 */
const STAPLE_NEUTRAL_WISH_TAGS: readonly string[] = ["quick"]

/** 主食を選び分ける希望の強さ（`STAPLE_NEUTRAL_WISH_TAGS` を除いた希望の点）。 */
function stapleWishPoints(recipe: RecipeDef, wish: WishConstraints | null): number {
  if (!wish) return 0
  const preferTags = wish.preferTags.filter((tag) => !STAPLE_NEUTRAL_WISH_TAGS.includes(tag))
  return wishPoints(recipe, { ...wish, preferTags })
}

/**
 * 主食の既定を ごはん に寄せる加点。
 * - 素の主食（ごはん）に足す。ただし「米は少なめ」のように避けたいと希望されたときは足さない。
 * - 希望が ごはん より強く当たる主食（「パン」「麺」と言われたときのトースト・うどん）にも同じ点を
 *   足すので、そのときは希望の加点の分だけ上に来る。ごはんにも同じだけ当たる希望（「和食」）では足さない。
 */
function stapleDefaultPoints(recipe: RecipeDef, ctx: Context): number {
  if (recipe.role !== "staple") return 0
  const wished = stapleWishPoints(recipe, ctx.wish)
  if (isPlainStaple(recipe, ctx.view)) return wished >= 0 ? PLAN_WEIGHTS.plainStaple : 0
  return wished > Math.max(0, ctx.plainStapleWish) ? PLAN_WEIGHTS.plainStaple : 0
}

function exceedsMaxMinutes(recipe: RecipeDef, wish: WishConstraints | null): boolean {
  const max = wish?.maxMinutes ?? null
  return max !== null && recipe.minutes > max
}

function wishPoints(recipe: RecipeDef, wish: WishConstraints | null): number {
  if (!wish) return 0
  const w = PLAN_WEIGHTS
  const prefer = wish.preferTags.filter((tag) => recipe.tags.includes(tag)).length
  const avoid = wish.avoidTags.filter((tag) => recipe.tags.includes(tag)).length
  const rank = wish.preferRecipeIds.indexOf(recipe.id)
  const ranked = rank < 0 ? 0 : Math.max(0, w.preferRecipeTop - rank * w.preferRecipeStep)
  return Math.min(prefer * w.preferTag, w.preferTagMax) + avoid * w.avoidTag + ranked
}

function proteinPoints(recipe: RecipeDef, date: string, ctx: Context, state: WorkState): number {
  if (recipe.role !== "main") return 0
  const key = mainProteinKey(recipe, ctx.view)
  if (key === null) return 0
  const w = PLAN_WEIGHTS
  let points = 0
  for (const [offset, penalty] of [[1, w.sameProteinAdjacent], [2, w.sameProteinTwoDays]] as const) {
    for (const neighbor of [shiftYmd(date, -offset), shiftYmd(date, offset)]) {
      if (state.proteinByDate.get(neighbor) === key) points += penalty
    }
  }
  return points
}

/**
 * 偏りを数える鍵。たんぱく源のタグを全て数える（親子丼は鶏と卵、麻婆豆腐はひき肉・豚・豆腐）。
 * タグの無い主菜は、材料から推定した主たんぱくを使う。
 */
function proteinKeysOf(recipe: RecipeDef, view: CatalogView): string[] {
  const tags = PROTEIN_TAGS.filter((tag) => recipe.tags.includes(tag)).map((tag) => `tag:${tag}`)
  if (tags.length > 0) return tags
  const main = recipe.role === "main" ? mainProteinKey(recipe, view) : null
  return main === null ? [] : [main]
}

/** 期間内に置いた主菜・副菜のたんぱく源を数える（汁物・主食は数えない）。 */
function noteProteins(recipe: RecipeDef, ctx: Context, state: WorkState): void {
  if (!isUniqueRole(recipe.role)) return
  for (const key of proteinKeysOf(recipe, ctx.view)) {
    state.proteinDishCount.set(key, (state.proteinDishCount.get(key) ?? 0) + 1)
  }
}

/**
 * 期間内（固定枠・既に選んだ枠を含む）の主菜・副菜に同じたんぱく源が 2 品あれば、3 品目を避ける
 * （卵料理や豚肉料理ばかりの週にしない）。「魚多め」のように希望されたタグは対象にしない。
 */
function proteinOverusePoints(recipe: RecipeDef, ctx: Context, state: WorkState): number {
  if (!isUniqueRole(recipe.role)) return 0
  const wished = new Set((ctx.wish?.preferTags ?? []).map((tag) => `tag:${tag}`))
  const overused = proteinKeysOf(recipe, ctx.view).some(
    (key) => !wished.has(key) && (state.proteinDishCount.get(key) ?? 0) >= 2,
  )
  return overused ? PLAN_WEIGHTS.proteinThirdInPlan : 0
}

function historyPoints(recipe: RecipeDef, date: string, state: WorkState): number {
  let nearest: number | null = null
  for (const cookedOn of state.cookedDates.get(recipe.id) ?? []) {
    const days = daysBetweenYmd(cookedOn, date)
    if (days === null || days <= 0) continue
    nearest = nearest === null ? days : Math.min(nearest, days)
  }
  if (nearest === null) return 0
  if (nearest <= 7) return PLAN_WEIGHTS.cookedWithin7Days
  return nearest <= 14 ? PLAN_WEIGHTS.cookedWithin14Days : 0
}

/**
 * 主食・汁物を期間内で繰り返すときの減点（置いた回数に比例）。
 * 汁物は回して選ぶ。素の主食（ごはん）は毎日でもよいので減点しない。
 */
function repeatPoints(recipe: RecipeDef, ctx: Context, state: WorkState): number {
  if (isUniqueRole(recipe.role) || isPlainStaple(recipe, ctx.view)) return 0
  const times = state.entries.filter((e) => e.recipeId === recipe.id && e.status !== "skipped").length
  const perUse = recipe.role === "soup" ? PLAN_WEIGHTS.repeatedSoup : PLAN_WEIGHTS.repeatedStaple
  return times * perUse
}

/** 在庫を使い切る料理への加点（`use` で始まる名前は React Hook と誤認されるので避ける）。 */
function finishStockPoints(match: PantryMatch, ctx: Context, state: WorkState): number {
  let finished = 0
  for (const c of match.consumption) {
    const total = ctx.itemTotals.get(c.pantryItemId)
    if (total === undefined) continue
    const left = total - (state.reserved.get(c.pantryItemId) ?? 0) - (c.quantity.amount ?? 0)
    if (left <= 1e-6) finished += 1
  }
  return Math.min(finished * PLAN_WEIGHTS.useUpPerItem, PLAN_WEIGHTS.useUpMax)
}

interface Scored {
  recipe: RecipeDef
  match: PantryMatch
  score: PlanScore
  reasons: PreferenceReason[]
}

function scoreCandidate(recipe: RecipeDef, date: string, ctx: Context, state: WorkState): Scored {
  const match = matchFor(recipe, ctx.input.servings, date, ctx, state)
  const preference = scoreRecipePreference(
    recipe,
    { preferences: ctx.input.preferences ?? [], feedback: ctx.input.feedback ?? [] },
    ctx.view.index,
  )
  const clamp = PLAN_WEIGHTS.preferenceClamp
  const stock = stockPoints(match)
  const time = timePoints(recipe, ctx.wish)
  const wished = recipe.role === "staple" ? stapleWishPoints(recipe, ctx.wish) : wishPoints(recipe, ctx.wish)
  const pref = Math.max(-clamp, Math.min(clamp, preference.total)) + wished
  const dayHasStaple = state.entries.some((e) => e.date === date && e.role === "staple" && e.status !== "skipped")
  const variety =
    proteinPoints(recipe, date, ctx, state) +
    proteinOverusePoints(recipe, ctx, state) +
    (isUniqueRole(recipe.role) ? historyPoints(recipe, date, state) : 0) +
    repeatPoints(recipe, ctx, state) +
    stapleDefaultPoints(recipe, ctx) +
    (dayHasStaple && recipe.includesStaple === true ? PLAN_WEIGHTS.stapleAlreadyPlanned : 0)
  const useUp = finishStockPoints(match, ctx, state)
  const seed = ctx.options.seed
  const jitter =
    seed === undefined ? 0 : seededUnit(seed, `${date}:${recipe.id}`) * PLAN_WEIGHTS.seedJitterMax
  return {
    recipe,
    match,
    score: { total: stock + time + pref + variety + useUp + jitter, stock, time, preference: pref, variety, useUp, jitter },
    reasons: preference.reasons,
  }
}

// ── 枠を埋める ─────────────────────────────────────────────────────

function gapFor(date: string, role: DishRole, ctx: Context, alreadyUsed: number): PlanGap {
  const partition = ctx.byRole.get(role) ?? { allowed: [], labelCheck: [], blocked: [] }
  const total = partition.allowed.length + partition.labelCheck.length + partition.blocked.length
  const reason: GapReason =
    total === 0
      ? "no_recipes"
      : partition.allowed.length > 0
        ? "exhausted"
        : partition.labelCheck.length > 0
          ? "needs_label_check"
          : "all_excluded"
  return {
    date,
    role,
    reason,
    detail: { total, blocked: partition.blocked.length, labelCheck: partition.labelCheck.length, alreadyUsed },
  }
}

/** 主菜・副菜は期間内で同じ料理を繰り返さない。主食（ご飯）・汁物は繰り返してよい。 */
function isUniqueRole(role: DishRole): boolean {
  return role === "main" || role === "side"
}

/** 空いている位置。`preferred`（差替え前の位置）が空いていればそれを使う。 */
function nextPosition(date: string, state: WorkState, preferred?: number): number {
  const taken = new Set(state.entries.filter((e) => e.date === date).map((e) => e.position))
  if (preferred !== undefined && !taken.has(preferred)) return preferred
  let position = 0
  while (taken.has(position)) position += 1
  return position
}

function chooseFor(date: string, role: DishRole, request: FillRequest, ctx: Context, state: WorkState): Scored | null {
  const allowed = ctx.byRole.get(role)?.allowed ?? []
  const available = allowed.filter(
    (recipe) => !(isUniqueRole(role) && state.usedRecipeIds.has(recipe.id)) && !request.avoid.has(recipe.id),
  )
  // 時間の希望は、満たす候補が 1 つでもあればその中から選ぶ（無ければ減点して全体から選ぶ）
  const withinTime = available.filter((recipe) => !exceedsMaxMinutes(recipe, ctx.wish))
  const candidates = withinTime.length > 0 ? withinTime : available
  let best: Scored | null = null
  for (const recipe of candidates) {
    const scored = scoreCandidate(recipe, date, ctx, state)
    const better =
      best === null ||
      scored.score.total > best.score.total ||
      (scored.score.total === best.score.total && recipe.id < best.recipe.id)
    if (better) best = scored
  }
  return best
}

function placeChoice(
  date: string,
  role: DishRole,
  choice: Scored,
  preferredPosition: number | undefined,
  ctx: Context,
  state: WorkState,
): void {
  const position = nextPosition(date, state, preferredPosition)
  const entry: PlannedEntry = {
    id: null,
    key: `new:${date}:${role}:${position}`,
    date,
    role,
    position,
    recipeId: choice.recipe.id,
    recipeVersion: choice.recipe.version,
    customTitle: null,
    customIngredients: null,
    servings: ctx.input.servings,
    pinned: false,
    status: "proposed",
    origin: "auto",
    title: choice.recipe.title,
    kept: false,
    stock: toStock(choice.match),
    score: choice.score,
    preferenceReasons: choice.reasons,
  }
  recordAllocation(entry, choice.match, state)
  state.entries.push(entry)
  state.usedRecipeIds.add(choice.recipe.id)
  noteProteins(choice.recipe, ctx, state)
  if (role === "main") state.proteinByDate.set(date, mainProteinKey(choice.recipe, ctx.view))
}

function fillSlot(date: string, role: DishRole, request: FillRequest, ctx: Context, state: WorkState): void {
  const choice = chooseFor(date, role, request, ctx, state)
  const original = request.fallback.get(slotKey(date, role))
  if (choice) {
    placeChoice(date, role, choice, original?.position, ctx, state)
    return
  }
  if (original) {
    // 他の候補が無い。元の枠を残す（空にしない）
    const position = nextPosition(date, state, original.position)
    placeSeed({ ...original, position, kept: true }, ctx, state)
    const restored = recipeOf(original, ctx)
    if (restored) noteProteins(restored, ctx, state)
    state.unchanged.push({ entryId: original.id, reason: "no_alternative" })
    return
  }
  const alreadyUsed = (ctx.byRole.get(role)?.allowed ?? []).filter(
    (recipe) => (isUniqueRole(role) && state.usedRecipeIds.has(recipe.id)) || request.avoid.has(recipe.id),
  ).length
  state.gaps.push(gapFor(date, role, ctx, alreadyUsed))
}

function dayIncludesStaple(date: string, ctx: Context, state: WorkState): boolean {
  return state.entries.some(
    (e) => e.date === date && e.status !== "skipped" && recipeOf(e, ctx)?.includesStaple === true,
  )
}

function wantsRole(date: string, role: DishRole, ctx: Context, state: WorkState): boolean {
  const occupied = state.entries.some((e) => e.date === date && e.role === role && e.status !== "skipped")
  if (occupied) return false
  if (role === "staple") return ctx.options.includeStaple && !dayIncludesStaple(date, ctx, state)
  if (role === "soup") return ctx.options.includeSoup
  return true
}

function initialState(request: FillRequest, ctx: Context): WorkState {
  const state: WorkState = {
    reserved: new Map(),
    usedRecipeIds: new Set(),
    proteinByDate: new Map(),
    proteinDishCount: new Map(),
    cookedDates: new Map(),
    entries: [],
    gaps: [],
    allocations: [],
    unchanged: [],
    dropped: [],
  }
  for (const history of ctx.input.recentHistory ?? []) {
    if (isValidYmd(history.date)) noteCooked(state, history.recipeId, history.date)
  }
  for (const seed of request.seeds) {
    if (seed.status === "skipped") continue
    const recipe = recipeOf(seed, ctx)
    if (!recipe) continue
    state.usedRecipeIds.add(recipe.id)
    noteProteins(recipe, ctx, state)
    if (seed.role === "main" && !state.proteinByDate.has(seed.date)) {
      state.proteinByDate.set(seed.date, mainProteinKey(recipe, ctx.view))
    }
  }
  return state
}

function bySeedOrder(a: Seed, b: Seed): number {
  return a.position - b.position || (a.id ?? "").localeCompare(b.id ?? "")
}

/** 結果を返す直前の再検証。新しく選んだ枠が除外に当たっていたら外す（置き換えない）。 */
function dropDisallowed(ctx: Context, state: WorkState): void {
  const kept: PlannedEntry[] = []
  for (const entry of state.entries) {
    const recipe = entry.kept ? null : recipeOf(entry, ctx)
    if (entry.kept || (recipe && evaluateRecipe(recipe, ctx.set).allowed)) {
      kept.push(entry)
      continue
    }
    state.allocations = state.allocations.filter((a) => a.entryKey !== entry.key)
    state.gaps.push(gapFor(entry.date, entry.role, ctx, 0))
  }
  state.entries = kept
}

function runFill(request: FillRequest, ctx: Context): PlanResult {
  const state = initialState(request, ctx)
  for (const date of ctx.dates) {
    // 日付順に引き当てる。その日の既存の枠を先に置き、残りの在庫から新しい枠を選ぶ
    for (const seed of request.seeds.filter((s) => s.date === date).sort(bySeedOrder)) {
      placeSeed(seed, ctx, state)
    }
    const forcedSlots = request.forced.filter((slot) => slot.date === date)
    for (const role of ROLE_ORDER) {
      const forced = forcedSlots.find((slot) => slot.role === role)
      if (!forced && !(request.fillDate(date) && wantsRole(date, role, ctx, state))) continue
      if (forced?.unlessDayIncludesStaple === true && dayIncludesStaple(date, ctx, state)) {
        // 主食を含む主菜（丼・カレー・麺）の日には主食を置かない。外したことを返す（黙って消さない）
        const original = request.fallback.get(slotKey(date, role))
        if (original) state.dropped.push({ entryId: original.id, date, role, reason: "main_includes_staple" })
        continue
      }
      fillSlot(date, role, request, ctx, state)
    }
  }
  dropDisallowed(ctx, state)
  const entries = state.entries.sort(
    (a, b) => a.date.localeCompare(b.date) || a.position - b.position || a.key.localeCompare(b.key),
  )
  const keptIds = new Set(entries.map((e) => e.id).filter((id): id is string => id !== null))
  const inRange = inRangeEntries(ctx)
  return {
    startDate: ctx.input.startDate,
    days: ctx.input.days,
    entries,
    gaps: state.gaps,
    allocations: state.allocations,
    conflicts: findPlanConflicts(inRange.filter((e) => keptIds.has(e.id)), ctx.set),
    rejectedPins: request.rejectedPins,
    removedEntryIds: inRange.filter((e) => !keptIds.has(e.id)).map((e) => e.id).sort(),
    unchanged: state.unchanged,
    droppedEntries: state.dropped,
  }
}

function inRangeEntries(ctx: Context): PlanEntry[] {
  const dates = new Set(ctx.dates)
  return ctx.input.existingEntries.filter((entry) => dates.has(entry.date))
}

function isProtected(entry: PlanEntry): boolean {
  return entry.pinned || entry.status === "cooked"
}

// ── 希望の固定 ─────────────────────────────────────────────────────

function applyWishPins(seeds: Seed[], ctx: Context): PlanResult["rejectedPins"] {
  const rejected: PlanResult["rejectedPins"] = []
  const dates = new Set(ctx.dates)
  const reusable = inRangeEntries(ctx).filter((entry) => !isProtected(entry))
  for (const pin of ctx.wish?.pins ?? []) {
    const reject = (reason: PinRejection) => rejected.push({ date: pin.date, recipeId: pin.recipeId, reason })
    if (!dates.has(pin.date)) {
      reject("out_of_range")
      continue
    }
    const recipe = ctx.view.recipeById.get(pin.recipeId)
    if (!recipe) {
      reject("unknown_recipe")
      continue
    }
    const verdict = evaluateRecipe(recipe, ctx.set).verdict
    if (verdict !== "ok") {
      reject(verdict === "blocked" ? "excluded" : "needs_label_check")
      continue
    }
    const taken = seeds.some((s) => s.date === pin.date && s.role === recipe.role && s.status !== "skipped")
    if (taken) {
      reject("slot_taken")
      continue
    }
    const existing = reusable.find((entry) => entry.date === pin.date && entry.recipeId === recipe.id)
    const positions = new Set(seeds.filter((s) => s.date === pin.date).map((s) => s.position))
    let position = existing?.position ?? 0
    while (positions.has(position)) position += 1
    seeds.push({
      id: existing?.id ?? null,
      date: pin.date,
      role: recipe.role,
      position,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      customTitle: null,
      customIngredients: null,
      servings: existing?.servings ?? ctx.input.servings,
      pinned: true,
      status: existing?.status === "confirmed" ? "confirmed" : "proposed",
      origin: existing?.origin ?? ctx.options.wishOrigin ?? "auto",
      kept: false,
    })
  }
  return rejected
}

// ── 公開の操作 ─────────────────────────────────────────────────────

/**
 * 全体の（再）生成。固定枠と作り終えた枠は保持し、それ以外の期間内の枠を作り直す。
 * 希望の固定（`wish.pins`）は、除外に当たらず枠が空いているときだけ固定枠として置く。
 */
export function generatePlan(input: PlanInput): PlanResult {
  const ctx = makeContext(input)
  const seeds: Seed[] = inRangeEntries(ctx)
    .filter(isProtected)
    .map((entry) => ({ ...entry, kept: true }))
  const rejectedPins = applyWishPins(seeds, ctx)
  return runFill({ seeds, fillDate: () => true, forced: [], avoid: new Set(), fallback: new Map(), rejectedPins }, ctx)
}

/** 何も選び直さず、現在の枠の在庫引当・衝突だけを計算し直す（日付移動や設定変更の後に使う）。 */
export function reviewPlan(input: PlanInput): PlanResult {
  const ctx = makeContext(input)
  const seeds: Seed[] = inRangeEntries(ctx).map((entry) => ({ ...entry, kept: true }))
  return runFill({ seeds, fillDate: () => false, forced: [], avoid: new Set(), fallback: new Map(), rejectedPins: [] }, ctx)
}

export type ReplaceFailure = "out_of_range" | "not_found" | "pinned" | "cooked" | "nothing_to_replace"

export type ReplaceResult = { ok: true; plan: PlanResult } | { ok: false; reason: ReplaceFailure }

/**
 * 1 日の差替え。その日の固定枠・作り終えた枠は保持し、他の枠を直前と違う料理で選び直す。
 * 他の日の枠は一切変えない。
 *
 * その日に在った区分は、設定（主食・汁物を足すか）に依らず選び直す = 黙って消さない:
 * - 区分ごとに 1 品目（位置の順）を選び直す。他の候補が無ければ元の枠を残す（`unchanged`）。
 * - 同じ区分の 2 品目以降は、そのまま残す。
 * - 主食は「直前と違う料理」にしない（ごはんは ごはん のまま）。主食を含む主菜（丼・カレー・麺）へ
 *   替わったときだけ主食を外し、`droppedEntries` で返す。
 * - 「作らなかった」枠は選び直しの対象にせず、従来どおり差替えで置き換える。
 */
export function replaceDay(
  input: PlanInput,
  date: string,
  avoidRecipeIds: readonly string[] = [],
): ReplaceResult {
  const ctx = makeContext(input)
  if (!ctx.dates.includes(date)) return { ok: false, reason: "out_of_range" }
  const existing = inRangeEntries(ctx)
  const replaceable = existing.filter((entry) => entry.date === date && !isProtected(entry))
  const hasProtected = existing.some((entry) => entry.date === date && isProtected(entry))
  if (replaceable.length === 0 && hasProtected) return { ok: false, reason: "nothing_to_replace" }
  const fallback = new Map<string, PlanEntry>()
  const forced: ForcedSlot[] = []
  const reselectIds = new Set<string>()
  const byPosition = [...replaceable].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
  for (const entry of byPosition) {
    if (entry.status === "skipped") {
      reselectIds.add(entry.id)
      continue
    }
    const key = slotKey(entry.date, entry.role)
    // 同じ区分の 2 品目以降は選び直さず、そのまま残す
    if (fallback.has(key)) continue
    fallback.set(key, entry)
    reselectIds.add(entry.id)
    forced.push({ date, role: entry.role, unlessDayIncludesStaple: entry.role === "staple" })
  }
  // 主食は避ける対象にしない（ごはんを選び直して、別の主食へ替えない）
  const isStapleRecipe = (recipeId: string) => ctx.view.recipeById.get(recipeId)?.role === "staple"
  const avoid = new Set<string>(avoidRecipeIds.filter((id) => !isStapleRecipe(id)))
  for (const entry of replaceable) {
    if (entry.recipeId !== null && entry.role !== "staple") avoid.add(entry.recipeId)
  }
  const seeds: Seed[] = existing
    .filter((entry) => !reselectIds.has(entry.id))
    .map((entry) => ({ ...entry, kept: true }))
  const plan = runFill({ seeds, fillDate: (d) => d === date, forced, avoid, fallback, rejectedPins: [] }, ctx)
  return { ok: true, plan }
}

/**
 * 1 品の差替え。対象の枠だけを、直前と違う料理で選び直す（固定枠・作り終えた枠は拒否）。
 * 他の候補が無ければ元の枠を残し、`plan.unchanged` で知らせる。
 */
export function replaceDish(
  input: PlanInput,
  entryId: string,
  avoidRecipeIds: readonly string[] = [],
): ReplaceResult {
  const ctx = makeContext(input)
  const existing = inRangeEntries(ctx)
  const target = existing.find((entry) => entry.id === entryId)
  if (!target) return { ok: false, reason: "not_found" }
  if (target.status === "cooked") return { ok: false, reason: "cooked" }
  if (target.pinned) return { ok: false, reason: "pinned" }
  const avoid = new Set<string>(avoidRecipeIds)
  if (target.recipeId !== null) avoid.add(target.recipeId)
  const seeds: Seed[] = existing
    .filter((entry) => entry.id !== entryId)
    .map((entry) => ({ ...entry, kept: true }))
  const plan = runFill(
    {
      seeds,
      fillDate: () => false,
      forced: [{ date: target.date, role: target.role }],
      avoid,
      fallback: new Map([[slotKey(target.date, target.role), target]]),
      rejectedPins: [],
    },
    ctx,
  )
  return { ok: true, plan }
}

export type MoveResult =
  | { ok: true; entries: PlanEntry[] }
  | { ok: false; reason: "invalid_date" | "cooked" }

/**
 * 日付移動。2 つの日の枠を丸ごと入れ替える（移動先が空なら単なる移動）。
 * 固定は枠に付いて行く。作り終えた枠がある日は動かさない（記録の日付を変えない）。
 * 引当と衝突は、結果を `reviewPlan` へ渡して計算し直す。
 */
export function moveDay(entries: readonly PlanEntry[], fromDate: string, toDate: string): MoveResult {
  if (!isValidYmd(fromDate) || !isValidYmd(toDate)) return { ok: false, reason: "invalid_date" }
  if (fromDate === toDate) return { ok: true, entries: [...entries] }
  const touchesCooked = entries.some(
    (entry) => (entry.date === fromDate || entry.date === toDate) && entry.status === "cooked",
  )
  if (touchesCooked) return { ok: false, reason: "cooked" }
  return {
    ok: true,
    entries: entries.map((entry) => {
      if (entry.date === fromDate) return { ...entry, date: toDate }
      if (entry.date === toDate) return { ...entry, date: fromDate }
      return entry
    }),
  }
}

// ── 提案の採用前の再検証 ───────────────────────────────────────────

export interface AdoptionCheckInput {
  /** 提案を作ったときの計画の版。 */
  baseRevision: number
  /** 採用しようとしている今の計画の版。 */
  currentRevision: number
  startDate: string
  days: number
  proposed: readonly { date: string; role: DishRole; recipeId: string }[]
  /** 今の計画の枠（固定枠・作り終えた枠の保護に使う）。 */
  currentEntries: readonly PlanEntry[]
  exclusions: readonly FoodExclusion[]
  catalog: CatalogInput
}

export type AdoptionProblem =
  | "stale_revision"
  | "out_of_range"
  | "unknown_recipe"
  | "role_mismatch"
  | "excluded"
  | "needs_label_check"
  | "protected_slot"

export type AdoptionCheck =
  | { ok: true }
  | { ok: false; problems: { problem: AdoptionProblem; date: string | null; recipeId: string | null }[] }

/**
 * 待っている間に計画が変わっていないか、提案が今の制約を満たすかを採用の直前に確かめる。
 * 版が違えば内容を見ずに拒否する（古い応答を今の計画へ当てない）。
 */
export function checkPlanAdoption(input: AdoptionCheckInput): AdoptionCheck {
  if (input.baseRevision !== input.currentRevision) {
    return { ok: false, problems: [{ problem: "stale_revision", date: null, recipeId: null }] }
  }
  assertPlanInput(input.startDate, input.days, 1)
  const view = toCatalogView(input.catalog)
  const set = buildExclusionSet(input.exclusions, view)
  const dates = new Set(planDates(input.startDate, input.days))
  const problems: { problem: AdoptionProblem; date: string | null; recipeId: string | null }[] = []
  for (const item of input.proposed) {
    const add = (problem: AdoptionProblem) => problems.push({ problem, date: item.date, recipeId: item.recipeId })
    if (!dates.has(item.date)) {
      add("out_of_range")
      continue
    }
    const recipe = view.recipeById.get(item.recipeId)
    if (!recipe) {
      add("unknown_recipe")
      continue
    }
    if (recipe.role !== item.role) add("role_mismatch")
    const verdict = evaluateRecipe(recipe, set).verdict
    if (verdict !== "ok") add(verdict === "blocked" ? "excluded" : "needs_label_check")
    const protectedSlot = input.currentEntries.some(
      (entry) => entry.date === item.date && entry.role === item.role && isProtected(entry),
    )
    if (protectedSlot) add("protected_slot")
  }
  return problems.length === 0 ? { ok: true } : { ok: false, problems }
}

/** 既存の枠 1 件が今の必須除外に当たるか（固定の解除や採用前の確認に使う）。 */
export function isEntryAllowed(entry: PlanEntry, exclusions: readonly FoodExclusion[], catalog: CatalogInput): boolean {
  return evaluateEntry(entry, buildExclusionSet(exclusions, toCatalogView(catalog))).allowed
}
