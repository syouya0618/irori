/**
 * ごはんの画面と Server Action が共有する「世帯の今の状態」の読み込み。
 *
 * **サーバー専用**（Server Component / Server Action / Route Handler から呼ぶ）。食材辞書と
 * レシピのカタログを import するので、Client Component から値 import しないこと
 * （育児トップなど無関係な画面の bundle に載せない）。型は `import type` で使ってよい。
 *
 * ## 契約
 * - 世帯 ID は呼び出し側が `getAuthContext()` から得た値を渡す（クライアントの入力を渡さない）。
 *   RLS が最終の門だが、全クエリに `.eq("household_id", householdId)` を重ねる。
 * - 読むのは `include` に挙げた部分だけ。部分ごとに並列に読む。
 * - **取得の失敗を「空」として返さない。** どれか 1 つでも読めなければ `{ ok: false, failures }`。
 *   画面は `requireMealContext()` で throw して error boundary へ渡すか、`failures` を見て
 *   区画ごとの失敗表示（`SectionError`）にする。
 * - **切られた応答を「全件」として返さない。** PostgREST は `max_rows`（1000）を超えた分を error なしで
 *   切り捨てる。一覧（在庫・除外・好み・食後評価・献立・買い物）は件数つきで読み、足りなければ続きを
 *   読み足す（`readAllRows`）。全件に届かなければ、その部分の取得失敗として返す。
 * - 行は読めたが中身を解釈できない場合:
 *   - 設定・献立の版 → 失敗（既定値や 0 と言い換えない）。
 *   - 必須除外 → 失敗（1 件でも読めなければ、除外の和集合が欠けたまま提案・確定してしまう）。
 *     一覧と削除を出す設定画面だけ `tolerateUnreadableExclusions` で受けられる。
 *   - それ以外 → 読めた行を返し、`unreadable` に件数を入れる（画面は件数を出す）。
 * - throw しない（Supabase の例外・中断も失敗として返す）。
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"
import type { Database } from "@/lib/types/database"
import { isValidYmd } from "@/lib/utils/date-jst"

import { ALLERGENS } from "../catalog/allergens"
import { INGREDIENTS } from "../catalog/ingredients"
import { RECIPES } from "../catalog/recipes"
import type { MealChild } from "../child-serving"
import { type CatalogView, toCatalogView } from "../lookup"
import {
  type DinnerPlanState,
  type DinnerSettings,
  EMPTY_DINNER_PLAN_STATE,
  type MappedRows,
  type MealTable,
  type RowIssue,
  type RowResult,
  type StoredDishFeedback,
  type StoredFoodExclusion,
  type StoredFoodPreference,
  type StoredGroceryItem,
  type StoredPantryItem,
  type StoredPlanEntry,
  defaultDinnerSettings,
  dinnerPlanStateFromRow,
  dinnerSettingsFromRow,
  dishFeedbackFromRow,
  foodExclusionFromRow,
  foodPreferenceFromRow,
  groceryItemFromRow,
  mapRows,
  pantryItemFromRow,
  planEntryFromRow,
} from "./rows"
import { feedbackWindowStart, mealDateRange, mealToday } from "./today"

export type MealSupabase = SupabaseClient<Database>

// ── カタログ ───────────────────────────────────────────────────────

/** 純粋ロジック（`suggestNow` / `generatePlan` / `buildGroceryNeeds` …）へ `catalog` として渡す入れ物。 */
export type MealLookup = CatalogView

let cachedLookup: MealLookup | null = null

/**
 * 同梱カタログ（食材辞書・レシピ・アレルゲン一覧）の索引。コード同梱の不変データなので
 * プロセス内で 1 度だけ作る（世帯のデータは含まない）。
 */
export function getMealLookup(): MealLookup {
  cachedLookup ??= toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })
  return cachedLookup
}

// ── 読む列（DB の列名。`select("*")` を使わない） ────────────────────

export const DINNER_SETTINGS_COLUMNS =
  "household_id, servings, include_soup, max_cook_minutes, staples, child_stages, updated_at"
export const PANTRY_ITEM_COLUMNS =
  "id, ingredient_id, name, quantity, unit, status, use_soon, storage, expires_on, confirmed_on, updated_at"
export const FOOD_EXCLUSION_COLUMNS =
  "id, subject_kind, subject_profile_id, subject_child_id, reason, target_kind, target_id, custom_label, updated_at"
export const FOOD_PREFERENCE_COLUMNS = "id, scope, profile_id, target_kind, target_id, sentiment, updated_at"
export const DISH_FEEDBACK_COLUMNS =
  "id, profile_id, recipe_id, dish_title, eaten_on, taste, effort, again, exclude_from_learning, updated_at"
export const DINNER_PLAN_STATE_COLUMNS = "household_id, revision, grocery_revision"
export const DINNER_PLAN_ENTRY_COLUMNS =
  "id, plan_date, role, position, recipe_id, recipe_version, custom_title, custom_ingredients, servings, pinned, status, prior_status, origin, updated_at"
/**
 * 充当の台帳（`consumptions`）は、充当を記録した枠の ID だけを使う（`rows.ts` の `settledSourceAmount`）。
 * 同期の前（判定できないアレルギーで止めている間など）に、作った枠の出所が必要量に残っている分を引くため。
 * 量の合計と印の使い終わりは、DB が書いた列（`consumed_quantity` / `purchase_consumed`）を正本にする。
 */
export const GROCERY_ITEM_COLUMNS =
  "id, origin, item_key, ingredient_id, name, section, required_quantity, unit, required_note, needs_stock_check, sources, purchased_quantity, purchased, purchased_at, restocked_quantity, restock_ids, consumed_quantity, consumptions, purchase_consumed, note, plan_revision, still_needed, updated_at"

// ── 結果の型 ───────────────────────────────────────────────────────

export const MEAL_CONTEXT_PARTS = [
  "settings",
  "pantry",
  "exclusions",
  "preferences",
  "feedback",
  "plan",
  "grocery",
  "children",
  "members",
] as const
export type MealContextPart = (typeof MEAL_CONTEXT_PARTS)[number]

/** 利用者へ見せる名前（失敗表示の「〜を読み込めませんでした」に使う）。 */
export const MEAL_CONTEXT_PART_LABELS: Readonly<Record<MealContextPart, string>> = {
  settings: "ごはんの設定",
  pantry: "食材",
  exclusions: "使わない食材の設定",
  preferences: "好みの設定",
  feedback: "食後の評価",
  plan: "献立",
  grocery: "買い物リスト",
  children: "子どもの情報",
  members: "家族の情報",
}

/** 世帯の子ども。**名前・生年月日を外部 AI へ送らないこと。** */
export interface MealChildProfile {
  id: string
  /** 表示名。未設定は空文字（画面は「名前未設定」などへ退化させる）。 */
  name: string
  /** YYYY-MM-DD。未登録は null。 */
  birthDate: string | null
}

/** 世帯の正規メンバー（閲覧だけの招待は含まない）。 */
export interface MealMember {
  id: string
  displayName: string
}

export interface MealPlanContext {
  /** 献立全体の版（行が無い世帯は 0）。 */
  revision: number
  /** 買い物の自動項目を最後に同期したときの献立の版。 */
  groceryRevision: number | null
  /** 読んだ範囲（両端を含む）。 */
  from: string
  to: string
  /** 範囲内の枠。日付・区分・位置の順。 */
  entries: StoredPlanEntry[]
}

interface MealContextByPart {
  settings: {
    settings: DinnerSettings
    /** true = 設定の行が無く、既定値（標準の人数）を使っている。 */
    settingsMissing: boolean
  }
  pantry: { pantry: StoredPantryItem[] }
  exclusions: { exclusions: StoredFoodExclusion[] }
  preferences: { preferences: StoredFoodPreference[] }
  feedback: { feedback: StoredDishFeedback[]; feedbackSince: string }
  plan: { plan: MealPlanContext }
  grocery: { grocery: StoredGroceryItem[] }
  children: { children: MealChildProfile[] }
  members: { members: MealMember[] }
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never

export interface MealContextBase {
  householdId: string
  /** JST の今日。 */
  today: string
  lookup: MealLookup
  /** 部分ごとの「読めなかった行」の数（0 件の部分は載らない）。 */
  unreadable: Partial<Record<MealContextPart, number>>
  /** 読めなかった行・退化させた値の明細（ログ・設定画面の整理用）。 */
  issues: RowIssue[]
}

/** `include` に挙げた部分だけを持つ。 */
export type MealContext<K extends MealContextPart = MealContextPart> = MealContextBase &
  UnionToIntersection<MealContextByPart[K]>

export interface MealLoadFailure {
  part: MealContextPart
  /** `query` = 取得できなかった（通信・権限・中断）。`unreadable` = 行は届いたが解釈できない。 */
  kind: "query" | "unreadable"
}

export type MealContextResult<K extends MealContextPart> =
  | { ok: true; context: MealContext<K> }
  | { ok: false; failures: MealLoadFailure[] }

export interface LoadMealContextOptions<K extends MealContextPart> {
  include: readonly K[]
  /** JST の今日（既定は現在）。 */
  today?: string
  /** 献立を読む範囲（両端を含む）。`plan` を読むのに渡さなければ今日から 7 日ぶん。 */
  planRange?: { from: string; to: string }
  /** 食後評価を読む範囲の開始日（既定は今日から 180 日前）。 */
  feedbackSince?: string
  /** 読めない必須除外が在っても失敗にしない（一覧と削除を出す設定画面だけが使う）。 */
  tolerateUnreadableExclusions?: boolean
  /** 取得の中断（Route Handler の期限など）。 */
  signal?: AbortSignal
  /** 取得の期限（ms）。既定 `MEAL_LOAD_TIMEOUT_MS`。期限切れは取得の失敗として返す。 */
  timeoutMs?: number
}

/** 1 回の読み込み（全部分の並列取得）の期限。応答の無い DB を待ち続けない。 */
export const MEAL_LOAD_TIMEOUT_MS = 10_000

// ── 部分ごとの読み込み ─────────────────────────────────────────────

type PartLoad<V> =
  | { ok: true; values: V; unreadable: number; issues: RowIssue[] }
  | { ok: false; kind: MealLoadFailure["kind"] }

interface LoadEnv {
  supabase: MealSupabase
  householdId: string
  today: string
  /** 全クエリへ渡す中断の合図（期限 + 呼び出し側の中断）。 */
  signal: AbortSignal
  /** 呼び出し側が渡した中断の合図（期限切れと区別して、記録するかを決める）。 */
  callerSignal: AbortSignal | undefined
}

type QueryError = Parameters<typeof logSupabaseErrorRedacted>[2]

function queryFailed(env: LoadEnv, part: MealContextPart, error: QueryError): { ok: false; kind: "query" } {
  // 呼び出し側の中断は意図どおりなので記録しない。家庭の入力（食材名など）を載せうる details は出さない
  if (!env.callerSignal?.aborted) {
    logSupabaseErrorRedacted("meals", `${part} lookup failed`, error, { householdId: env.householdId })
  }
  return { ok: false, kind: "query" }
}

function rowsLoaded<T, V>(
  env: LoadEnv,
  part: MealContextPart,
  table: MealTable,
  data: unknown,
  mapOne: (row: unknown) => RowResult<T>,
  toValues: (rows: T[]) => V,
): PartLoad<V> {
  const mapped: MappedRows<T> | null = mapRows(table, data, mapOne)
  // error が無いのに配列でない = 「0 件」ではなく「読めていない」
  if (mapped === null) {
    console.error("[meals] lookup returned a non-array", { part, householdId: env.householdId })
    return { ok: false, kind: "unreadable" }
  }
  if (mapped.issues.length > 0) {
    // 行の中身は出さない（ID と列名だけ）
    console.error("[meals] rows could not be read as stored", {
      part,
      householdId: env.householdId,
      unreadable: mapped.unreadable,
      issues: mapped.issues.slice(0, 20),
    })
  }
  return { ok: true, values: toValues(mapped.rows), unreadable: mapped.unreadable, issues: mapped.issues }
}

// ── 全件の読み込み（PostgREST の行数上限で切られた応答を「全件」と扱わない） ───────

/**
 * 1 つの読み込みで続きを読む回数の上限。PostgREST の `max_rows`（`supabase/config.toml` は 1000）で
 * 1 回の応答が切られても、この回数ぶんまでは読み足す（1000 行 × 20 = 2 万行。世帯のデータには十分）。
 */
const MEAL_ROWS_MAX_PAGES = 20

type RowsReply = { data: unknown; error: QueryError | null; count?: number | null }
type RowsQuery = PromiseLike<RowsReply> & { range: (from: number, to: number) => PromiseLike<RowsReply> }

type AllRows =
  | { ok: true; data: unknown }
  | { ok: false; error: QueryError }
  /** 全件に届かなかった（読んでいる最中に行が減った・上限の回数を超えた）。 */
  | { ok: false; error: null; got: number; total: number }

/**
 * 条件に合う行を**全件**読む。`build` は `select(列, { count: "exact" })` つきの問い合わせを、
 * 呼ぶたびに新しく作って返す（問い合わせは 1 度しか送れない）。
 *
 * PostgREST は `max_rows` を超えた分を **error なしで**切り捨てる。件数（`count`）と届いた行数を比べ、
 * 足りなければ続きを `range` で読み足す。読み足しても全件に届かなければ、欠けた一覧を返さず失敗にする
 * （「取得の失敗を空として返さない」と同じ契約: 欠けた除外・在庫・評価で提案や確定をさせない）。
 * 件数が返らない応答では比べられないので、届いた行をそのまま返す。
 */
async function readAllRows(build: () => RowsQuery): Promise<AllRows> {
  const first = await build()
  if (first.error) return { ok: false, error: first.error }
  const total = typeof first.count === "number" ? first.count : null
  if (!Array.isArray(first.data) || total === null || first.data.length >= total) return { ok: true, data: first.data }

  const rows: unknown[] = [...first.data]
  for (let page = 1; page < MEAL_ROWS_MAX_PAGES && rows.length < total; page += 1) {
    const next = await build().range(rows.length, total - 1)
    if (next.error) return { ok: false, error: next.error }
    if (!Array.isArray(next.data) || next.data.length === 0) break
    rows.push(...next.data)
  }
  // 読み足しの間に行が動くと、同じ行が 2 度届きうる。ID で 1 件にしてから数える
  const seen = new Set<unknown>()
  const unique = rows.filter((row) => {
    const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined
    if (id === undefined || id === null) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (unique.length < total) return { ok: false, error: null, got: unique.length, total }
  return { ok: true, data: unique }
}

/** `readAllRows` の失敗を、その部分の取得失敗として返す（欠けた行数は件数だけを記録する）。 */
function allRowsFailed(env: LoadEnv, part: MealContextPart, failed: Extract<AllRows, { ok: false }>): { ok: false; kind: "query" } {
  if (failed.error !== null) return queryFailed(env, part, failed.error)
  console.error("[meals] lookup could not read every row", {
    part,
    householdId: env.householdId,
    got: failed.got,
    total: failed.total,
  })
  return { ok: false, kind: "query" }
}

async function loadSettings(env: LoadEnv): Promise<PartLoad<MealContextByPart["settings"]>> {
  const { data, error } = await env.supabase
    .from("dinner_settings")
    .select(DINNER_SETTINGS_COLUMNS)
    .eq("household_id", env.householdId)
    .abortSignal(env.signal)
    .maybeSingle()
  if (error) return queryFailed(env, "settings", error)
  // 行が無い = 未設定（取得の失敗とは別）。既定値を使い、その旨を返す
  if (data === null) {
    return { ok: true, values: { settings: defaultDinnerSettings(), settingsMissing: true }, unreadable: 0, issues: [] }
  }
  const result = dinnerSettingsFromRow(data)
  if (!result.ok) {
    console.error("[meals] settings row could not be read", { householdId: env.householdId, field: result.field })
    return { ok: false, kind: "unreadable" }
  }
  return {
    ok: true,
    values: { settings: result.value, settingsMissing: false },
    unreadable: 0,
    issues: result.degraded.map((field) => ({
      table: "dinner_settings" as const,
      id: null,
      kind: "degraded" as const,
      field,
    })),
  }
}

async function loadPantry(env: LoadEnv): Promise<PartLoad<MealContextByPart["pantry"]>> {
  const all = await readAllRows(() =>
    env.supabase
      .from("pantry_items")
      .select(PANTRY_ITEM_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .abortSignal(env.signal),
  )
  if (!all.ok) return allRowsFailed(env, "pantry", all)
  return rowsLoaded(env, "pantry", "pantry_items", all.data, pantryItemFromRow, (pantry) => ({ pantry }))
}

async function loadExclusions(
  env: LoadEnv,
  tolerateUnreadable: boolean,
): Promise<PartLoad<MealContextByPart["exclusions"]>> {
  const all = await readAllRows(() =>
    env.supabase
      .from("food_exclusions")
      .select(FOOD_EXCLUSION_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .abortSignal(env.signal),
  )
  // 必須除外は 1 件でも欠ければ和集合が欠ける。全件を読めなければ失敗
  if (!all.ok) return allRowsFailed(env, "exclusions", all)
  const loaded = rowsLoaded(env, "exclusions", "food_exclusions", all.data, foodExclusionFromRow, (exclusions) => ({
    exclusions,
  }))
  // 読めない除外が 1 件でも在れば、世帯の和集合は欠けている。欠けたまま渡さない
  if (loaded.ok && loaded.unreadable > 0 && !tolerateUnreadable) return { ok: false, kind: "unreadable" }
  return loaded
}

async function loadPreferences(env: LoadEnv): Promise<PartLoad<MealContextByPart["preferences"]>> {
  const all = await readAllRows(() =>
    env.supabase
      .from("food_preferences")
      .select(FOOD_PREFERENCE_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .abortSignal(env.signal),
  )
  if (!all.ok) return allRowsFailed(env, "preferences", all)
  return rowsLoaded(env, "preferences", "food_preferences", all.data, foodPreferenceFromRow, (preferences) => ({
    preferences,
  }))
}

async function loadFeedback(env: LoadEnv, since: string): Promise<PartLoad<MealContextByPart["feedback"]>> {
  // 食後評価は 180 日ぶんを読む（2 人が毎晩 3 品を評価すると 1000 行を超える）。古い側を黙って欠かさない
  const all = await readAllRows(() =>
    env.supabase
      .from("dish_feedback")
      .select(DISH_FEEDBACK_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .gte("eaten_on", since)
      .order("eaten_on", { ascending: false })
      .order("id", { ascending: true })
      .abortSignal(env.signal),
  )
  if (!all.ok) return allRowsFailed(env, "feedback", all)
  return rowsLoaded(env, "feedback", "dish_feedback", all.data, dishFeedbackFromRow, (feedback) => ({
    feedback,
    feedbackSince: since,
  }))
}

async function loadPlanState(env: LoadEnv): Promise<PartLoad<DinnerPlanState>> {
  const { data, error } = await env.supabase
    .from("dinner_plan_state")
    .select(DINNER_PLAN_STATE_COLUMNS)
    .eq("household_id", env.householdId)
    .abortSignal(env.signal)
    .maybeSingle()
  if (error) return queryFailed(env, "plan", error)
  // 行が無い世帯の版は 0（DB の RPC と同じ扱い）
  if (data === null) return { ok: true, values: { ...EMPTY_DINNER_PLAN_STATE }, unreadable: 0, issues: [] }
  const result = dinnerPlanStateFromRow(data)
  if (!result.ok) {
    // 版を 0 と言い換えると、古い版で献立を上書きする要求を作ってしまう
    console.error("[meals] plan state row could not be read", { householdId: env.householdId, field: result.field })
    return { ok: false, kind: "unreadable" }
  }
  return { ok: true, values: result.value, unreadable: 0, issues: [] }
}

async function loadPlanEntries(
  env: LoadEnv,
  range: { from: string; to: string },
): Promise<PartLoad<StoredPlanEntry[]>> {
  const all = await readAllRows(() =>
    env.supabase
      .from("dinner_plan_entries")
      .select(DINNER_PLAN_ENTRY_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .gte("plan_date", range.from)
      .lte("plan_date", range.to)
      .order("plan_date", { ascending: true })
      .order("role", { ascending: true })
      .order("position", { ascending: true })
      .abortSignal(env.signal),
  )
  if (!all.ok) return allRowsFailed(env, "plan", all)
  return rowsLoaded(env, "plan", "dinner_plan_entries", all.data, planEntryFromRow, (entries) => entries)
}

async function loadPlan(
  env: LoadEnv,
  range: { from: string; to: string },
): Promise<PartLoad<MealContextByPart["plan"]>> {
  const [state, entries] = await Promise.all([loadPlanState(env), loadPlanEntries(env, range)])
  if (!state.ok) return state
  if (!entries.ok) return entries
  return {
    ok: true,
    values: {
      plan: {
        revision: state.values.revision,
        groceryRevision: state.values.groceryRevision,
        from: range.from,
        to: range.to,
        entries: entries.values,
      },
    },
    unreadable: entries.unreadable,
    issues: entries.issues,
  }
}

async function loadGrocery(env: LoadEnv): Promise<PartLoad<MealContextByPart["grocery"]>> {
  const all = await readAllRows(() =>
    env.supabase
      .from("grocery_items")
      .select(GROCERY_ITEM_COLUMNS, { count: "exact" })
      .eq("household_id", env.householdId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .abortSignal(env.signal),
  )
  if (!all.ok) return allRowsFailed(env, "grocery", all)
  const index = getMealLookup().index
  return rowsLoaded(
    env,
    "grocery",
    "grocery_items",
    all.data,
    (row) => groceryItemFromRow(row, (ingredientId) => index.byId.get(ingredientId)?.section),
    (grocery) => ({ grocery }),
  )
}

async function loadChildren(env: LoadEnv): Promise<PartLoad<MealContextByPart["children"]>> {
  const { data, error } = await env.supabase
    .from("children")
    .select("id, name, birth_date")
    .eq("household_id", env.householdId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .abortSignal(env.signal)
  if (error) return queryFailed(env, "children", error)
  if (!Array.isArray(data)) return { ok: false, kind: "unreadable" }
  const children: MealChildProfile[] = data.map((row) => ({
    id: row.id,
    name: typeof row.name === "string" ? row.name : "",
    // 読めない生年月日は「未登録」（年齢の制約は「確認できない」側へ倒れる）
    birthDate: isValidYmd(row.birth_date) ? row.birth_date : null,
  }))
  return { ok: true, values: { children }, unreadable: 0, issues: [] }
}

async function loadMembers(env: LoadEnv): Promise<PartLoad<MealContextByPart["members"]>> {
  // 閲覧だけの役割は名指しで除く（役割が増えても、正規メンバーが黙って一覧から漏れない向き）
  const { data, error } = await env.supabase
    .from("profiles")
    .select("id, display_name")
    .eq("household_id", env.householdId)
    .eq("is_approved", true)
    .neq("role", "viewer")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .abortSignal(env.signal)
  if (error) return queryFailed(env, "members", error)
  if (!Array.isArray(data)) return { ok: false, kind: "unreadable" }
  const members: MealMember[] = data.map((row) => ({
    id: row.id,
    displayName: typeof row.display_name === "string" ? row.display_name : "",
  }))
  return { ok: true, values: { members }, unreadable: 0, issues: [] }
}

/** 例外（fetch の reject・中断）を、その部分の取得失敗として返す。 */
async function guarded<V>(env: LoadEnv, part: MealContextPart, load: () => Promise<PartLoad<V>>): Promise<PartLoad<V>> {
  try {
    return await load()
  } catch (err) {
    if (!env.callerSignal?.aborted) {
      console.error("[meals] lookup threw", {
        part,
        householdId: env.householdId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return { ok: false, kind: "query" }
  }
}

function resolvePlanRange(
  today: string,
  requested: { from: string; to: string } | undefined,
): { from: string; to: string } | null {
  if (requested === undefined) {
    const range = mealDateRange(today, 7)
    return range === null ? null : { from: range.from, to: range.to }
  }
  if (!isValidYmd(requested.from) || !isValidYmd(requested.to) || requested.from > requested.to) return null
  return { from: requested.from, to: requested.to }
}

/**
 * 世帯のごはんの状態を、`include` に挙げた部分だけ並列に読む。
 *
 * @example
 * const result = await loadMealContext(supabase, householdId, { include: ["settings", "pantry", "exclusions"] })
 * const ctx = requireMealContext(result) // 読めなければ throw（error boundary が受ける）
 * ctx.pantry // StoredPantryItem[]（include に無い部分は型に現れない）
 */
export async function loadMealContext<const K extends MealContextPart>(
  supabase: MealSupabase,
  householdId: string,
  options: LoadMealContextOptions<K>,
): Promise<MealContextResult<K>> {
  const today = options.today ?? mealToday()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? MEAL_LOAD_TIMEOUT_MS)
  const env: LoadEnv = {
    supabase,
    householdId,
    today,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    callerSignal: options.signal,
  }
  const include = [...new Set<MealContextPart>(options.include)]

  // 引数の不備を「空」で返さない（世帯 ID・日付が壊れた呼び出しは全部分の失敗にする）
  const planRange = include.includes("plan") ? resolvePlanRange(today, options.planRange) : null
  const feedbackSince = options.feedbackSince ?? feedbackWindowStart(today)
  const invalid: MealContextPart[] = []
  if (householdId === "" || !isValidYmd(today)) invalid.push(...include)
  else {
    if (include.includes("plan") && planRange === null) invalid.push("plan")
    if (include.includes("feedback") && !isValidYmd(feedbackSince)) invalid.push("feedback")
  }
  if (invalid.length > 0) {
    console.error("[meals] context was requested with invalid arguments", { parts: invalid })
    return { ok: false, failures: invalid.map((part) => ({ part, kind: "query" as const })) }
  }

  const loaders: Record<MealContextPart, () => Promise<PartLoad<object>>> = {
    settings: () => loadSettings(env),
    pantry: () => loadPantry(env),
    exclusions: () => loadExclusions(env, options.tolerateUnreadableExclusions === true),
    preferences: () => loadPreferences(env),
    feedback: () => loadFeedback(env, feedbackSince as string),
    plan: () => loadPlan(env, planRange as { from: string; to: string }),
    grocery: () => loadGrocery(env),
    children: () => loadChildren(env),
    members: () => loadMembers(env),
  }
  const loads = await Promise.all(
    include.map(async (part) => ({ part, load: await guarded(env, part, loaders[part]) })),
  )

  const failures: MealLoadFailure[] = []
  const unreadable: Partial<Record<MealContextPart, number>> = {}
  const issues: RowIssue[] = []
  const values: Record<string, unknown> = {}
  for (const { part, load } of loads) {
    if (!load.ok) {
      failures.push({ part, kind: load.kind })
      continue
    }
    Object.assign(values, load.values)
    if (load.unreadable > 0) unreadable[part] = load.unreadable
    issues.push(...load.issues)
  }
  if (failures.length > 0) return { ok: false, failures }

  const base: MealContextBase = { householdId, today, lookup: getMealLookup(), unreadable, issues }
  return { ok: true, context: { ...values, ...base } as MealContext<K> }
}

// ── 失敗の扱い ─────────────────────────────────────────────────────

/** 「食材・献立を読み込めませんでした。」の主語（読めなかった部分の名前）。 */
export function describeMealLoadFailures(failures: readonly MealLoadFailure[]): string {
  const labels = [...new Set(failures.map((failure) => MEAL_CONTEXT_PART_LABELS[failure.part]))]
  return labels.length === 0 ? "ごはんの情報" : labels.join("・")
}

export class MealContextError extends Error {
  readonly failures: readonly MealLoadFailure[]

  constructor(failures: readonly MealLoadFailure[]) {
    super(`${describeMealLoadFailures(failures)}を読み込めませんでした`)
    this.name = "MealContextError"
    this.failures = failures
  }
}

/** 読めなければ throw する（画面全体を error boundary へ渡す画面用）。 */
export function requireMealContext<K extends MealContextPart>(result: MealContextResult<K>): MealContext<K> {
  if (!result.ok) throw new MealContextError(result.failures)
  return result.context
}

/** 読めなかった行の合計（画面の「読めない記録が n 件あります」に使う）。 */
export function totalUnreadable(context: Pick<MealContextBase, "unreadable">): number {
  return Object.values(context.unreadable).reduce((sum, count) => sum + (count ?? 0), 0)
}

// ── ロジックへ渡す形 ───────────────────────────────────────────────

/**
 * 取り分け・年齢制約の判定（`child-serving.ts`）へ渡す形。食事段階は保護者の設定から引く
 * （未設定は null。月齢から段階を決めつけない）。名前は載せない。
 */
export function toMealChildren(
  children: readonly MealChildProfile[],
  settings: Pick<DinnerSettings, "childStages">,
): MealChild[] {
  return children.map((child) => ({
    id: child.id,
    birthDate: child.birthDate,
    mealStage: Object.prototype.hasOwnProperty.call(settings.childStages, child.id)
      ? settings.childStages[child.id]
      : null,
  }))
}
