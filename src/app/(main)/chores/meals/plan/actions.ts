"use server"

/**
 * 献立（希望の解釈・作成・差替え・移動・固定・手動料理・確定・作った／作らなかった・食後評価）の
 * Server Action。
 *
 * ## 契約
 * - 冒頭で `getAuthContext()`。世帯 ID は受け取らない（余分な項目を持つ要求は型ガードが拒む）。
 * - 書込は SECURITY DEFINER の RPC だけ。RPC が `auth.uid()` から世帯を導出する。
 * - **自動献立（規則ベース）が中核**。生成 AI は希望の文の構造化だけを補助し、止まっていても
 *   同じ Action が規則だけで動く。AI の出力は候補集合・日付範囲・必須除外で検証し直す。
 * - 献立を作る・変える Action は、サーバーで最新の献立・在庫・必須除外を読み直してから計算する。
 *   希望（固定）は採用の直前に、候補集合・必須除外・日付範囲・献立の版で再検証する（AI を待つ間に
 *   除外や献立が変わっていたら採用しない）。
 * - 固定枠（pinned）と作った枠（cooked）は、作り直し・差替えのどの経路でも送らない・上書きしない
 *   （DB の `apply_dinner_plan` も固定枠を上書きしない）。固定・解除は明示の操作（`setDinnerPin`）だけ。
 * - 献立を変えた後は買い物の自動項目を同期する。同期の失敗で献立の成功を失敗と偽らず、
 *   `grocery: { ok: false, message }` として別に返す。
 * - 結果は `{ status }`（saved / replayed / conflict）か `{ error, failure }`。例外は結果不明として返す。
 *
 * AI 補助は最悪 8 秒 × 2 回 + 待ち時間かかる。**献立のページ（`plan/page.tsx`）で
 * `export const maxDuration = 30` を宣言すること**（Server Action の timeout は page の値で決まる）。
 */

import { createHash, randomUUID } from "node:crypto"

import { revalidatePath } from "next/cache"

import { MEALS_REVALIDATE_PATH } from "@/components/chores/meals/shared/meal-routes"
import {
  parseRpcOutcome,
  parseRpcStatus,
  rejectedResult,
  unknownResult,
  type ChoreSaveFailure,
  type RpcStatus,
} from "@/lib/domain/rpc-outcome"
import { isRecord } from "@/lib/domain/child-sharing"
import {
  MEAL_AI_LIMITS,
  type MealAiCandidate,
  type MealAiClaimResult,
  type MealAiResult,
  type MealAiWishInput,
  interpretWishWithAi,
  isEmptyWishConstraints,
  mealAiConfig,
  mealAiWeekday,
  mergeWishConstraints,
  parseDinnerAiClaim,
} from "@/lib/meals/ai"
import { getRecipeTagLabel } from "@/lib/meals/catalog/tags"
import {
  type ExclusionSet,
  type PlanConflict,
  blockedIngredientNames,
  buildExclusionSet,
  evaluateEntry,
  evaluateRecipe,
  findPlanConflicts,
  partitionRecipes,
} from "@/lib/meals/exclusions"
import { resolveIngredientId } from "@/lib/meals/normalize"
import {
  type PlanInput,
  type PlanResult,
  type PlannedEntry,
  checkPlanAdoption,
  generatePlan,
  replaceDay,
  replaceDish,
} from "@/lib/meals/planner"
import {
  type MealContext,
  type MealLookup,
  describeMealLoadFailures,
  getMealLookup,
  loadMealContext,
} from "@/lib/meals/server/context"
import { dishRoleLabel, formatMealDateShort } from "@/lib/meals/server/format"
import {
  DINNER_MESSAGES,
  type DinnerActor,
  dinnerFailureOf,
  loadPlanOperationState,
  logDinnerError,
  syncGroceryAutoItems,
} from "@/lib/meals/server/grocery-sync"
import { settleMealAction } from "@/lib/meals/server/meal-input"
import {
  type AddDinnerRecipeRequest,
  type ApplyCookedPantryUpdatesRequest,
  type ApplyDinnerServingsRequest,
  type ConfirmDinnerPlanRequest,
  type CustomIngredientInput,
  DINNER_AI_DAILY_LIMIT,
  DINNER_ENTRY_PAST_DAYS,
  DINNER_PLAN_START_MAX_AHEAD_DAYS,
  type DinnerEntryRef,
  type DinnerPlanMode,
  type DinnerRequest,
  type DinnerSaveResult,
  type DinnerSaveSuccess,
  type DinnerServingsRequest,
  type DroppedEntryNotice,
  GROCERY_HORIZON_DAYS,
  GROCERY_SYNC_FAILED_MESSAGE,
  type GenerateDinnerPlanRequest,
  type GrocerySyncReport,
  type InterpretWishRequest,
  type InterpretWishResult,
  type MealAiStatusView,
  type MoveDinnerEntryRequest,
  type PinRejectionNotice,
  type PlanGapNotice,
  type ReplaceDinnerDayRequest,
  type ReplaceDinnerDishRequest,
  type SaveCustomDishRequest,
  type SaveDishFeedbackRequest,
  type SetDinnerPinRequest,
  type SetDinnerServingsRequest,
  type WishPinConflictNotice,
  type WishSummaryItem,
  addedDishStatus,
  isAddDinnerRecipeRequest,
  isApplyCookedPantryUpdatesRequest,
  isApplyDinnerServingsRequest,
  isConfirmDinnerPlanRequest,
  isDinnerEntryRef,
  isDinnerRequest,
  isDinnerServingsRequest,
  isGenerateDinnerPlanRequest,
  isInterpretWishRequest,
  isMoveDinnerEntryRequest,
  isReplaceDinnerDayRequest,
  isReplaceDinnerDishRequest,
  isSaveCustomDishRequest,
  isSaveDishFeedbackRequest,
  isSetDinnerPinRequest,
  isSetDinnerServingsRequest,
  isUpcomingUncookedEntry,
  withoutOp,
} from "@/lib/meals/server/plan-requests"
import { describePinRejection, describePlanGap, mealAiStatusView } from "@/lib/meals/server/plan-views"
import {
  type PlanEntryInput,
  type StoredPlanEntry,
  dishFeedbackFromRow,
  dishFeedbackToRpcArgs,
  isDeletedEntity,
  pantryItemFromRow,
  pantryItemToRpc,
  planEntryFromRow,
  planEntryToRpc,
  planEntryToRpcWithId,
  toFiniteNumber,
} from "@/lib/meals/server/rows"
import { PLAN_HISTORY_DAYS, mealDateRange, mealToday } from "@/lib/meals/server/today"
import { describeAutoConfirmHold } from "@/lib/meals/server/views"
import type { PlanEntry, RecipeDef, RecipeIngredient, WishConstraints } from "@/lib/meals/types"
import { parseWish } from "@/lib/meals/wish-rules"
import { getAuthContext } from "@/lib/supabase/auth-context"
import type { Json } from "@/lib/types/database"
import { shiftYmd } from "@/lib/utils/date-jst"

const MESSAGES = {
  ...DINNER_MESSAGES,
  startOutOfRange: `開始日は今日から${DINNER_PLAN_START_MAX_AHEAD_DAYS}日先までの日を選んでください。`,
  dateOutOfRange: "この日付は扱えません。今日の前後の日を選んでください。",
  pastDate: "過ぎた日の献立は差し替えられません。",
  unreadablePlan: "献立に読めない記録があるため、作り直しを止めました。再読み込みして確認してください。",
  invalidWish: "希望の内容を確認できませんでした。希望を入れ直してから、もう一度お試しください。",
  goneEntry: "この料理は既に変更・削除されています。最新の献立を確認してください。",
  pinnedEntry: "固定した料理は差し替えません。差し替えるときは、先に固定を解除してください。",
  cookedEntry: "作った料理は変更できません。",
  noAlternative: "ほかの候補がありませんでした。料理はそのままです。",
  nothingToReplace: "この日は固定した料理・作った料理だけのため、差し替えるものがありません。",
  blockedPin: "使わない食材の設定に当たる料理は固定できません。料理を選び直してください。",
  noFreeSlot: "移動先の日は料理が多すぎます。先に料理を減らしてください。",
  notCustom: "一覧から選んだ料理は、ここでは編集できません。差し替えを使ってください。",
  customMoved: "料理の日付と区分は、移動で変えてください。",
  nothingToConfirm: "確定できる料理がありません。先に献立を作ってください。",
  futureFeedback: "これから食べる日の評価は記録できません。",
  unknownRecipe: "この料理は一覧にありません。",
  addPastDate: "過ぎた日の献立には足せません。今日以降の日を選んでください。",
  addRoleMismatch: "料理の区分が一覧と合いません。画面を読み込み直してください。",
  addBlocked: "使わない食材の設定に当たる料理は、献立に入れられません。",
  addLabelCheck: "原材料を確かめられない料理のため、ここからは献立に入れられません（確定の前に原材料の確認が要ります）。",
  addAlready: "この料理は、すでにこの日の献立に入っています（二重には足していません）。",
  addSlotTaken: "入れようとした枠に、別の端末が先に料理を入れました。上書きはしていません。",
  addStatusChanged: "この日の献立の状態（提案・確定）が、別の端末で先に変わりました。",
  addPlanChanged:
    "押した後に、献立が変わっていました（先に送った追加を別の端末が消した場合も含みます）。足し直してはいません。最新の献立を確かめて、もう一度入れてください。",
} as const

type PlanningParts = "settings" | "pantry" | "exclusions" | "preferences" | "feedback" | "plan"
type PlanningContext = MealContext<PlanningParts>

function revalidateMeals(): void {
  revalidatePath(MEALS_REVALIDATE_PATH, "layout")
  revalidatePath("/chores")
}

/** 認証 → Action 本体。例外（通信断・中断）は結果不明として返す（拒否と言い換えない）。 */
async function runDinnerAction(
  action: string,
  run: (actor: DinnerActor) => Promise<DinnerSaveResult>,
): Promise<DinnerSaveResult> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const { supabase, userId, householdId } = auth.context
  const actor: DinnerActor = { supabase, userId, householdId }
  return settleMealAction(action, userId, () => run(actor))
}

function conflictResult(
  detail: NonNullable<DinnerSaveSuccess["detail"]>,
  revision: number | null,
  notices: string[] = [],
): DinnerSaveSuccess {
  return { status: "conflict", detail, revision, notices, grocery: null }
}

/**
 * 献立を変えた後の、買い物の自動項目の同期。**throw しない・献立の結果を変えない**。
 * 操作 ID はその都度の新しい値（RPC は内容で upsert するので、行は増えない）。
 */
async function syncAfterPlanChange(actor: DinnerActor, today: string): Promise<GrocerySyncReport> {
  try {
    const outcome = await syncGroceryAutoItems(actor, randomUUID(), { today })
    if (outcome.ok) return { ok: true, status: outcome.status }
    return { ok: false, message: GROCERY_SYNC_FAILED_MESSAGE }
  } catch (err) {
    console.error("[meals] grocery sync threw", {
      userId: actor.userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, message: GROCERY_SYNC_FAILED_MESSAGE }
  }
}

/** 献立が変わった（または変わっていた）ときの後始末: 買い物の同期と再検証。 */
async function settledSuccess(
  actor: DinnerActor,
  today: string,
  status: Exclude<RpcStatus, "conflict">,
  revision: number | null,
  extra: Partial<DinnerSaveSuccess> = {},
): Promise<DinnerSaveSuccess> {
  const grocery = await syncAfterPlanChange(actor, today)
  revalidateMeals()
  return { status, revision, notices: [], ...extra, grocery }
}

// ── 読み込み ───────────────────────────────────────────────────────

/** 献立を計算する Action が読む範囲（重複回避の履歴 〜 買い物の対象の最後の日）。 */
function planningRange(today: string): { from: string; to: string } {
  return { from: shiftYmd(today, -PLAN_HISTORY_DAYS), to: shiftYmd(today, GROCERY_HORIZON_DAYS - 1) }
}

async function loadPlanningContext(
  actor: DinnerActor,
  today: string,
): Promise<{ context: PlanningContext } | { failure: ChoreSaveFailure }> {
  const loaded = await loadMealContext(actor.supabase, actor.householdId, {
    include: ["settings", "pantry", "exclusions", "preferences", "feedback", "plan"],
    planRange: planningRange(today),
    today,
  })
  if (!loaded.ok) return { failure: rejectedResult(MESSAGES.readFailed) }
  return { context: loaded.context }
}

/** 1 枠の操作が読む範囲（少し前の日 〜 買い物の対象の最後の日）。 */
function entryRange(today: string): { from: string; to: string } {
  return { from: shiftYmd(today, -DINNER_ENTRY_PAST_DAYS), to: shiftYmd(today, GROCERY_HORIZON_DAYS - 1) }
}

function isWithin(date: string, range: { from: string; to: string }): boolean {
  return date >= range.from && date <= range.to
}

function isProtected(entry: Pick<PlanEntry, "pinned" | "status">): boolean {
  return entry.pinned || entry.status === "cooked"
}

function entryInputOf(entry: StoredPlanEntry, overrides: Partial<PlanEntryInput> = {}): PlanEntryInput {
  return {
    date: entry.date,
    role: entry.role,
    position: entry.position,
    recipeId: entry.recipeId,
    recipeVersion: entry.recipeVersion,
    customTitle: entry.customTitle,
    customIngredients: entry.customIngredients,
    servings: entry.servings,
    pinned: entry.pinned,
    status: entry.status,
    origin: entry.origin,
    ...overrides,
  }
}

/** その日の空いている位置（0〜9）。埋まっていれば null。 */
function freePosition(entries: readonly PlanEntry[], date: string, exceptId: string | null): number | null {
  const taken = new Set(entries.filter((entry) => entry.date === date && entry.id !== exceptId).map((entry) => entry.position))
  for (let position = 0; position <= 9; position += 1) {
    if (!taken.has(position)) return position
  }
  return null
}

// ── 1 枠の保存（save_dinner_entry） ────────────────────────────────

type EntrySave =
  | { ok: true; status: RpcStatus; revision: number | null; gone: boolean }
  | { ok: false; failure: ChoreSaveFailure }

async function saveEntry(
  actor: DinnerActor,
  id: string,
  version: string | null,
  input: PlanEntryInput,
): Promise<EntrySave> {
  const { data, error } = await actor.supabase.rpc("save_dinner_entry", {
    p_id: id,
    p_version: version,
    p_entry: planEntryToRpc(input) as unknown as Json,
  })
  if (error) {
    logDinnerError("save_dinner_entry failed", error, actor)
    return { ok: false, failure: dinnerFailureOf(error) }
  }
  const outcome = parseRpcOutcome(data, "entry")
  if (!outcome) return { ok: false, failure: unknownResult() }
  const revision = isRecord(data) ? toFiniteNumber(data.revision) : null
  if (isDeletedEntity(outcome.entity)) {
    // 行が既に無い。conflict 以外でこの印が来ることは無い（来たら結果不明）
    if (outcome.status !== "conflict") return { ok: false, failure: unknownResult() }
    return { ok: true, status: "conflict", revision, gone: true }
  }
  const row = planEntryFromRow(outcome.entity)
  if (!row.ok || row.value.id !== id) return { ok: false, failure: unknownResult() }
  return { ok: true, status: outcome.status, revision, gone: false }
}

/** 1 枠の保存の結果を応答へ直す（成立していれば買い物を同期する）。 */
async function finishEntrySave(
  actor: DinnerActor,
  today: string,
  saved: EntrySave,
  notices: string[] = [],
  extra: Partial<DinnerSaveSuccess> = {},
): Promise<DinnerSaveResult> {
  if (!saved.ok) return saved.failure
  if (saved.status === "conflict") {
    revalidateMeals()
    return conflictResult(saved.gone ? "gone" : "row_changed", saved.revision)
  }
  return settledSuccess(actor, today, saved.status, saved.revision, { ...extra, notices })
}

// ── 希望の解釈（献立は変えない） ───────────────────────────────────

function summarizeWish(constraints: WishConstraints, lookup: MealLookup): WishSummaryItem[] {
  const titleOf = (recipeId: string) => lookup.recipeById.get(recipeId)?.title ?? recipeId
  const items: WishSummaryItem[] = []
  for (const pin of constraints.pins) {
    items.push({
      kind: "pin",
      date: pin.date,
      dateLabel: formatMealDateShort(pin.date),
      recipeId: pin.recipeId,
      title: titleOf(pin.recipeId),
    })
  }
  for (const tag of constraints.preferTags) {
    items.push({ kind: "prefer_tag", tag, label: getRecipeTagLabel(tag) ?? tag })
  }
  for (const tag of constraints.avoidTags) {
    items.push({ kind: "avoid_tag", tag, label: getRecipeTagLabel(tag) ?? tag })
  }
  for (const recipeId of constraints.preferRecipeIds) {
    items.push({ kind: "prefer_recipe", recipeId, title: titleOf(recipeId) })
  }
  if (constraints.maxMinutes !== null) items.push({ kind: "max_minutes", minutes: constraints.maxMinutes })
  return items
}

/**
 * AI へ渡す候補。**必須除外を適用済みのレシピの ID・料理名・タグだけ**を新しいオブジェクトへ写す
 * （材料・アレルゲン・世帯の情報は載せない）。主菜・副菜を先に、上限まで。
 */
function aiCandidatesOf(allowed: readonly RecipeDef[]): MealAiCandidate[] {
  const order = ["main", "side", "soup", "staple"]
  return [...allowed]
    .sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role))
    .slice(0, MEAL_AI_LIMITS.candidates)
    .map((recipe) => ({ id: recipe.id, title: recipe.title, tags: [...recipe.tags] }))
}

/** AI が返した希望を、渡した候補と日付で検証し直す（アダプターの検証と二重。外れていれば採用しない）。 */
function isWithinAiInput(constraints: WishConstraints, input: MealAiWishInput): boolean {
  const ids = new Set(input.candidates.map((candidate) => candidate.id))
  const dates = new Set(input.dates.map((date) => date.date))
  return (
    constraints.pins.every((pin) => ids.has(pin.recipeId) && dates.has(pin.date)) &&
    constraints.preferRecipeIds.every((id) => ids.has(id))
  )
}

function aiStatusOf(result: MealAiResult): MealAiStatusView {
  if (result.status === "ok") return mealAiStatusView("available")
  switch (result.reason) {
    case "not_configured":
    case "misconfigured":
      return mealAiStatusView("not_configured")
    case "household_limit":
      return mealAiStatusView("household_limit")
    case "provider_exhausted":
      return mealAiStatusView("provider_exhausted", result.resetsAt ?? null)
    case "invalid_input":
      // 送れる内容が無く、呼んでいない（計上もしていない）
      return mealAiStatusView("available")
    default:
      return mealAiStatusView("temporary_failure")
  }
}

/**
 * 希望の文を解釈して、提案（`WishConstraints`）を返す。**献立は変更しない。**
 *
 * 1. 規則（`wish-rules`）で解釈する。候補は必須除外を適用済みのレシピだけ。
 * 2. AI 補助が有効で、規則で読めなかった部分が残ったときだけ、AI に構造化を頼む
 *    （希望文・対象日・除外を適用済みの候補の ID／料理名／タグだけを渡す）。
 *    AI の結果は規則の結果へ**足す**（`mergeWishConstraints`。規則で読めた固定・時間を置き換えない）。
 * 3. AI が使えない・何も読み取れなかった・規則の結果に何も足さなかったときは、規則の結果で続行する。
 *
 * 返した `constraints` は、`generateDinnerPlan` がもう一度（最新の除外・献立の版で）検証する。
 */
export async function interpretDinnerWish(request: InterpretWishRequest): Promise<InterpretWishResult> {
  if (!isInterpretWishRequest(request)) return { ok: false, error: MESSAGES.invalid }
  const auth = await getAuthContext()
  if (auth.error !== null) return { ok: false, error: auth.error }
  const { supabase, userId, householdId } = auth.context
  const actor: DinnerActor = { supabase, userId, householdId }
  try {
    const today = mealToday()
    const range = mealDateRange(request.startDate, request.days)
    if (
      range === null ||
      range.from < today ||
      range.from > shiftYmd(today, DINNER_PLAN_START_MAX_AHEAD_DAYS)
    ) {
      return { ok: false, error: MESSAGES.startOutOfRange }
    }
    const loaded = await loadMealContext(supabase, householdId, {
      include: ["exclusions", "plan"],
      planRange: { from: range.from, to: range.to },
      today,
    })
    if (!loaded.ok) {
      return { ok: false, error: `${describeMealLoadFailures(loaded.failures)}を読み込めませんでした。` }
    }
    const context = loaded.context
    const { lookup } = context
    const set = buildExclusionSet(context.exclusions, lookup)
    // 固定・優先は、必須除外に当たらず原材料の確認も要らない候補からだけ選ぶ
    const allowed = partitionRecipes(lookup.recipes, set).allowed
    const rules = parseWish({
      text: request.wish,
      startDate: range.from,
      days: request.days,
      today,
      recipes: allowed,
    })

    // 同じ日・同じ区分への 2 つ目の固定は、規則が「読めたうえで固定にしなかった」希望。原文は
    // `rules.unparsed` にも入るが、読めなかった部分ではない — これだけのために AI を呼ばない
    const conflictTexts = new Set(rules.pinConflicts.map((conflict) => conflict.text))
    const unreadByRules = rules.unparsed.filter((text) => !conflictTexts.has(text))

    let via: "ai" | "rules" = "rules"
    let constraints = rules.constraints
    let unparsed = rules.unparsed
    let ai: MealAiStatusView
    const wish = request.wish.trim()
    if (mealAiConfig().state !== "enabled") {
      ai = mealAiStatusView("not_configured")
    } else if (wish === "" || unreadByRules.length === 0) {
      // 規則だけで読めた。AI は呼ばない（回数も使わない）
      ai = mealAiStatusView("available")
    } else {
      const dates = range.dates.flatMap((date) => {
        const weekday = mealAiWeekday(date)
        return weekday === null ? [] : [{ date, weekday }]
      })
      const input: MealAiWishInput = { wish, dates, candidates: aiCandidatesOf(allowed) }
      const result = await interpretWishWithAi(input, {
        claim: () => claimAiCall(actor),
        markExhausted: (until) => markAiExhausted(actor, until),
      })
      ai = aiStatusOf(result)
      if (
        result.status === "ok" &&
        !isEmptyWishConstraints(result.constraints) &&
        isWithinAiInput(result.constraints, input)
      ) {
        // AI の結果は、規則で読めた希望へ**足す**（置き換えない）。規則が読めた固定・時間は、AI が
        // それを返さなくても残る（AI 補助を有効にしただけで「金曜はカレー」の固定が消えない）
        const merged = mergeWishConstraints(
          rules.constraints,
          result.constraints,
          (recipeId) => lookup.recipeById.get(recipeId)?.role ?? null,
        )
        // AI の分で何も増えなければ、規則の結果のまま（「AI 補助で読み取った」と名乗らない）
        if (merged.added) {
          via = "ai"
          constraints = merged.constraints
          // 固定にしなかった希望の原文は、AI が残りを読んだ後も残す（固定されていないことを隠さない）
          unparsed = rules.unparsed.filter((text) => conflictTexts.has(text))
        }
      }
    }

    const titleOf = (recipeId: string) => lookup.recipeById.get(recipeId)?.title ?? recipeId
    const pinConflicts: WishPinConflictNotice[] = rules.pinConflicts.map((conflict) => {
      const role = lookup.recipeById.get(conflict.keptRecipeId)?.role
      const dateLabel = formatMealDateShort(conflict.date)
      const title = titleOf(conflict.recipeId)
      const keptTitle = titleOf(conflict.keptRecipeId)
      return {
        text: conflict.text,
        date: conflict.date,
        dateLabel,
        recipeId: conflict.recipeId,
        title,
        keptRecipeId: conflict.keptRecipeId,
        keptTitle,
        message: `${dateLabel}の${role === undefined ? "同じ区分" : dishRoleLabel(role)}は「${keptTitle}」を固定したため、「${title}」は固定していません（同じ日の同じ区分に 2 つは固定できません）。どちらかに決めて入れ直してください。`,
      }
    })

    // 希望どおりに固定できない日（固定済み・作った料理が同じ区分にある）を先に知らせる
    const pinNotices: string[] = []
    for (const pin of constraints.pins) {
      const recipe = lookup.recipeById.get(pin.recipeId)
      if (!recipe) continue
      const taken = context.plan.entries.some(
        (entry) => entry.date === pin.date && entry.role === recipe.role && isProtected(entry),
      )
      if (taken) {
        pinNotices.push(
          `${formatMealDateShort(pin.date)}の${dishRoleLabel(recipe.role)}は固定した料理・作った料理があるため、変更しません。`,
        )
      }
    }

    return {
      ok: true,
      via,
      constraints,
      summary: summarizeWish(constraints, lookup),
      unparsed,
      pinConflicts,
      truncated: rules.truncated,
      ai,
      revision: context.plan.revision,
      pinNotices,
    }
  } catch (err) {
    console.error("[meals] interpret wish threw", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return { ok: false, error: MESSAGES.readFailed }
  }
}

/** 世帯の回数を 1 回ぶん確保する（上限 10。retry も 1 回として計上される）。読めなければ throw。 */
async function claimAiCall(actor: DinnerActor): Promise<MealAiClaimResult> {
  const { data, error } = await actor.supabase.rpc("claim_dinner_ai_call", { p_limit: DINNER_AI_DAILY_LIMIT })
  if (error) {
    logDinnerError("claim_dinner_ai_call failed", error, actor)
    throw new Error("claim_dinner_ai_call failed")
  }
  const claim = parseDinnerAiClaim(data)
  if (claim === null) throw new Error("claim_dinner_ai_call returned an unexpected shape")
  return claim
}

/**
 * 日次無料枠の枯渇を記録する（全世帯の呼出しを次の再開時刻まで止める）。
 * service role 専用の RPC なので、`getAuthContext()` を通過したこの Action の中で、枯渇を受けた
 * ときにだけ admin client を動的 import して呼ぶ（テーブルの読み書きには使わない）。
 */
async function markAiExhausted(actor: DinnerActor, until: Date): Promise<void> {
  const { createAdminClient } = await import("@/lib/supabase/admin")
  const supabase = createAdminClient()
  const { error } = await supabase.rpc("mark_dinner_ai_exhausted", { p_until: until.toISOString() })
  if (error) {
    logDinnerError("mark_dinner_ai_exhausted failed", error, actor)
    throw new Error("mark_dinner_ai_exhausted failed")
  }
}

// ── 希望の再検証 ───────────────────────────────────────────────────

type WishCheck =
  | { ok: true; wish: WishConstraints }
  /** `invalid` = カタログに無い ID・範囲外の日（改ざん・壊れた入力）。`changed` = 解釈の後に除外が変わった。 */
  | { ok: false; kind: "invalid" | "changed" }

/**
 * 希望（固定・優先）を、今の候補集合・必須除外・日付範囲で検証し直す。
 * 献立の版は呼び出し側が先に確かめる（ここへ来る時点で一致している）。
 */
function recheckWish(
  constraints: WishConstraints,
  context: PlanningContext,
  startDate: string,
  days: number,
): WishCheck {
  const { lookup } = context
  const knownTags = new Set(lookup.recipes.flatMap((recipe) => recipe.tags))
  if (![...constraints.preferTags, ...constraints.avoidTags].every((tag) => knownTags.has(tag))) {
    return { ok: false, kind: "invalid" }
  }
  if (!constraints.preferRecipeIds.every((id) => lookup.recipeById.has(id))) return { ok: false, kind: "invalid" }

  const proposed: { date: string; role: RecipeDef["role"]; recipeId: string }[] = []
  const slots = new Set<string>()
  for (const pin of constraints.pins) {
    const recipe = lookup.recipeById.get(pin.recipeId)
    if (!recipe) return { ok: false, kind: "invalid" }
    const slot = `${pin.date}|${recipe.role}`
    // 同じ日・同じ区分へ 2 つ固定する希望は、どちらを採るかをサーバーが決めない
    if (slots.has(slot)) return { ok: false, kind: "invalid" }
    slots.add(slot)
    proposed.push({ date: pin.date, role: recipe.role, recipeId: recipe.id })
  }
  const adoption = checkPlanAdoption({
    baseRevision: context.plan.revision,
    currentRevision: context.plan.revision,
    startDate,
    days,
    proposed,
    currentEntries: context.plan.entries,
    exclusions: context.exclusions,
    catalog: lookup,
  })
  if (!adoption.ok) {
    const problems = adoption.problems.map((item) => item.problem)
    if (problems.some((problem) => problem === "out_of_range" || problem === "unknown_recipe" || problem === "role_mismatch")) {
      return { ok: false, kind: "invalid" }
    }
    if (problems.some((problem) => problem === "excluded" || problem === "needs_label_check")) {
      return { ok: false, kind: "changed" }
    }
    // 固定済み・作った枠への固定（protected_slot）は、枠を保持したまま作成へ進む（結果で知らせる）
  }

  const set = buildExclusionSet(context.exclusions, lookup)
  return {
    ok: true,
    wish: {
      pins: constraints.pins.map((pin) => ({ date: pin.date, recipeId: pin.recipeId })),
      preferTags: [...constraints.preferTags],
      avoidTags: [...constraints.avoidTags],
      maxMinutes: constraints.maxMinutes,
      // 優先の希望は、今の除外で候補に残るものだけ（残らないものは候補に無いので効かない）
      preferRecipeIds: constraints.preferRecipeIds.filter((id) => {
        const recipe = lookup.recipeById.get(id)
        return recipe !== undefined && evaluateRecipe(recipe, set).allowed
      }),
    },
  }
}

// ── 作成・差替えの共通 ─────────────────────────────────────────────

/** 操作 ID と枠の鍵から、行 ID を決定的に作る（同じ操作の再送が同じ内容になる）。 */
function entryIdFor(operationId: string, key: string): string {
  const hex = createHash("sha256").update(`${operationId}|${key}`).digest("hex")
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** 同点付近の候補を入れ替える種（同じ操作 ID からは同じ値）。 */
function seedFor(operationId: string): number {
  return parseInt(operationId.replace(/-/g, "").slice(0, 7), 16)
}

function planInputOf(
  context: PlanningContext,
  window: { startDate: string; days: number },
  options: { servings?: number; wish?: WishConstraints | null; plannerOptions?: PlanInput["options"] } = {},
): PlanInput {
  const { settings, today } = context
  const wish = options.wish ?? null
  // 設定の調理時間の上限は、希望に時間の指定が無いときの既定として使う
  const maxMinutes = wish?.maxMinutes ?? settings.maxCookMinutes
  const merged: WishConstraints | null =
    wish === null && maxMinutes === null
      ? null
      : {
          pins: wish?.pins ?? [],
          preferTags: wish?.preferTags ?? [],
          avoidTags: wish?.avoidTags ?? [],
          preferRecipeIds: wish?.preferRecipeIds ?? [],
          maxMinutes,
        }
  return {
    startDate: window.startDate,
    days: window.days,
    servings: options.servings ?? settings.servings,
    today,
    existingEntries: context.plan.entries,
    pantry: context.pantry,
    exclusions: context.exclusions,
    preferences: context.preferences,
    feedback: context.feedback,
    // 期間より前に作った料理（作った記録と、過ぎた日の確定）。提案だけ・作らなかった枠は入れない
    recentHistory: context.plan.entries.flatMap((entry) =>
      entry.recipeId !== null &&
      entry.date < window.startDate &&
      (entry.status === "cooked" || (entry.status === "confirmed" && entry.date < today))
        ? [{ date: entry.date, recipeId: entry.recipeId }]
        : [],
    ),
    wish: merged,
    stapleIngredientIds: settings.stapleIngredientIds,
    catalog: context.lookup,
    options: { includeSoup: settings.includeSoup, ...options.plannerOptions },
  }
}

/** 「もう出さない」料理の希望から、カタログに在る ID だけを残す（候補を減らすだけで、増やす経路にならない）。 */
function knownRecipeIds(ids: readonly string[] | undefined, lookup: MealLookup): string[] {
  return (ids ?? []).filter((id) => lookup.recipeById.has(id))
}

/** 差替えで計算に使う 7 日の窓（今日からの 1 週間に入る日は今日から。先の日はその日で終わる 7 日）。 */
function windowAround(date: string, today: string): { startDate: string; days: number } {
  return { startDate: date <= shiftYmd(today, 6) ? today : shiftYmd(date, -6), days: 7 }
}

/**
 * 計算した献立のうち、`apply_dinner_plan` へ送る枠（範囲内の、固定でも作った枠でもないもの）。
 * 新しく選んだ枠が今の必須除外に当たっていないことを、送る直前にもう一度確かめる。
 */
function entriesToApply(
  plan: PlanResult,
  range: { from: string; to: string },
  context: PlanningContext,
  operationId: string,
  mapOrigin: (entry: PlannedEntry) => PlanEntry["origin"],
): { ok: true; entries: (ReturnType<typeof planEntryToRpcWithId>)[] } | { ok: false } {
  const set = buildExclusionSet(context.exclusions, context.lookup)
  const entries: ReturnType<typeof planEntryToRpcWithId>[] = []
  for (const entry of plan.entries) {
    if (!isWithin(entry.date, range)) continue
    // 既存の固定枠・作った枠は送らない（DB に残っている行をそのまま保つ）
    if (entry.status === "cooked" || (entry.kept && entry.pinned)) continue
    if (entry.status !== "proposed" && entry.status !== "confirmed") return { ok: false }
    if (!entry.kept) {
      const recipe = entry.recipeId === null ? undefined : context.lookup.recipeById.get(entry.recipeId)
      if (!recipe || !evaluateRecipe(recipe, set).allowed) return { ok: false }
    }
    entries.push(
      planEntryToRpcWithId(entry.id ?? entryIdFor(operationId, entry.key), {
        date: entry.date,
        role: entry.role,
        position: entry.position,
        recipeId: entry.recipeId,
        recipeVersion: entry.recipeVersion,
        customTitle: entry.customTitle,
        customIngredients: entry.customIngredients,
        servings: entry.servings,
        pinned: entry.pinned,
        status: entry.status,
        origin: entry.kept ? entry.origin : mapOrigin(entry),
      }),
    )
  }
  return { ok: true, entries }
}

type ApplyOutcome =
  | { ok: true; status: RpcStatus; revision: number | null; skipped: number }
  | { ok: false; failure: ChoreSaveFailure }

async function applyPlan(
  actor: DinnerActor,
  args: { operationId: string; expectedRevision: number; from: string; to: string; entries: unknown[] },
): Promise<ApplyOutcome> {
  const { data, error } = await actor.supabase.rpc("apply_dinner_plan", {
    p_operation_id: args.operationId,
    p_expected_revision: args.expectedRevision,
    p_range_start: args.from,
    p_range_end: args.to,
    p_entries: args.entries as unknown as Json,
  })
  if (error) {
    logDinnerError("apply_dinner_plan failed", error, actor)
    return { ok: false, failure: dinnerFailureOf(error) }
  }
  const status = parseRpcStatus(data)
  if (status === null || !isRecord(data)) return { ok: false, failure: unknownResult() }
  return {
    ok: true,
    status,
    revision: toFiniteNumber(data.revision),
    skipped: Array.isArray(data.skipped) ? data.skipped.length : 0,
  }
}

function gapNotices(plan: PlanResult): PlanGapNotice[] {
  return plan.gaps.map((gap) => ({
    date: gap.date,
    role: gap.role,
    reason: gap.reason,
    message: `${formatMealDateShort(gap.date)}: ${describePlanGap(gap.reason, gap.role)}`,
  }))
}

/**
 * 「原材料の確認が必要な候補しか残っていない」空き枠の理由が、判定できないアレルギーの除外
 * （何も外せていないので、どの料理も自動では確定しない）なら、その説明文。そうでなければ null。
 * 空き枠の文だけだと「どの材料の確認か」が分からず、原因（登録した除外）へ辿れない。
 */
function autoConfirmHoldOf(gaps: readonly PlanGapNotice[], context: Pick<PlanningContext, "exclusions" | "lookup">): string | null {
  if (!gaps.some((gap) => gap.reason === "needs_label_check")) return null
  return describeAutoConfirmHold(buildExclusionSet(context.exclusions, context.lookup))
}

/** 1 日の差替えで外した枠（主食を含む主菜へ替わった日の主食）を、料理名つきの知らせにする。 */
function droppedNotices(plan: PlanResult, context: Pick<PlanningContext, "plan" | "lookup">): DroppedEntryNotice[] {
  return plan.droppedEntries.map((dropped) => {
    const entry = context.plan.entries.find((candidate) => candidate.id === dropped.entryId)
    const title =
      (entry === undefined
        ? undefined
        : entry.recipeId === null
          ? (entry.customTitle ?? undefined)
          : context.lookup.recipeById.get(entry.recipeId)?.title) ?? dishRoleLabel(dropped.role)
    return {
      entryId: dropped.entryId,
      date: dropped.date,
      role: dropped.role,
      title,
      reason: dropped.reason,
      message: `${formatMealDateShort(dropped.date)}: 主食を含む料理（丼・カレー・麺など）に替わったため、${dishRoleLabel(dropped.role)}の「${title}」を献立から外しました。`,
    }
  })
}

/**
 * 応答を失った再送か（同じ操作 ID の作り直しが既に成立している）。計算し直す前に確かめる
 * （計算し直すと、在庫や献立が変わった分だけ内容が変わり、別の操作として拒まれうる）。
 */
async function replayOrStale(
  actor: DinnerActor,
  today: string,
  operationId: string,
  expectedRevision: number,
): Promise<{ done: DinnerSaveResult } | { done: null }> {
  const state = await loadPlanOperationState(actor)
  if (!state.ok) return { done: state.failure }
  if (state.state.lastOperationId === operationId) {
    return { done: await settledSuccess(actor, today, "replayed", state.state.revision) }
  }
  if (state.state.revision !== expectedRevision) {
    revalidateMeals()
    return { done: conflictResult("stale_plan", state.state.revision) }
  }
  return { done: null }
}

// ── 作成 ───────────────────────────────────────────────────────────

/**
 * 1〜7 日分の献立を作る（提案として保存する）。固定枠と作った枠は保持する。
 * 希望（`constraints`）は採用の直前に検証し直し、献立の版が違えば conflict として最新の版を返す。
 */
export async function generateDinnerPlan(request: GenerateDinnerPlanRequest): Promise<DinnerSaveResult> {
  if (!isGenerateDinnerPlanRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("generate_dinner_plan", async (actor) => {
    const today = mealToday()
    const range = mealDateRange(request.startDate, request.days)
    if (range === null || range.from < today || range.from > shiftYmd(today, DINNER_PLAN_START_MAX_AHEAD_DAYS)) {
      return rejectedResult(MESSAGES.startOutOfRange)
    }
    const early = await replayOrStale(actor, today, request.operationId, request.expectedRevision)
    if (early.done) return early.done

    const loaded = await loadPlanningContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    // 読み込みの間に版が進んだ（別の端末の操作）。古い前提で作らない
    if (context.plan.revision !== request.expectedRevision) {
      revalidateMeals()
      return conflictResult("stale_plan", context.plan.revision)
    }
    if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)

    let wish: WishConstraints | null = null
    if (request.constraints !== null) {
      const checked = recheckWish(request.constraints, context, range.from, request.days)
      if (!checked.ok) {
        if (checked.kind === "invalid") return rejectedResult(MESSAGES.invalidWish)
        // 希望を解釈した後に、使わない食材の設定が変わった。古い希望を今の献立へ当てない
        revalidateMeals()
        return conflictResult("constraints_changed", context.plan.revision, [
          "希望を読み取った後に、使わない食材の設定が変わりました。希望を入れ直してください。",
        ])
      }
      wish = checked.wish
    }

    // 「AI 補助」と名乗るのは、AI 補助が有効な環境で、AI が構造化した希望を実際に使うときだけ
    const via: DinnerPlanMode =
      request.mode === "ai_assisted" && wish !== null && !isEmptyWishConstraints(wish) && mealAiConfig().state === "enabled"
        ? "ai_assisted"
        : "auto"
    const shapesChoice =
      wish !== null &&
      (wish.preferTags.length > 0 || wish.avoidTags.length > 0 || wish.preferRecipeIds.length > 0 || wish.maxMinutes !== null)
    const plan = generatePlan(
      planInputOf(context, { startDate: range.from, days: request.days }, {
        servings: request.servings,
        wish,
        plannerOptions: { includeStaple: request.includeStaple === true, seed: seedFor(request.operationId), wishOrigin: via },
      }),
    )
    const toApply = entriesToApply(plan, range, context, request.operationId, (entry) =>
      // 希望の固定は planner が出所を付ける。選び直した枠は、AI の条件が選び方に効いたときだけ「AI 補助」
      entry.pinned ? entry.origin : via === "ai_assisted" && shapesChoice ? "ai_assisted" : "auto",
    )
    if (!toApply.ok) return rejectedResult(MESSAGES.saveFailed)

    const applied = await applyPlan(actor, {
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      from: range.from,
      to: range.to,
      entries: toApply.entries,
    })
    if (!applied.ok) return applied.failure
    if (applied.status === "conflict") {
      revalidateMeals()
      return conflictResult("stale_plan", applied.revision)
    }

    const gaps = gapNotices(plan)
    const rejectedPins: PinRejectionNotice[] = plan.rejectedPins.map((pin) => ({
      ...pin,
      message: `${formatMealDateShort(pin.date)}: ${describePinRejection(pin.reason)}`,
    }))
    const hold = autoConfirmHoldOf(gaps, context)
    const notices = [
      ...(hold === null ? [] : [hold]),
      ...gaps.map((gap) => gap.message),
      ...rejectedPins.map((pin) => pin.message),
    ]
    if (applied.skipped > 0) notices.push("固定した料理・作った料理は、そのまま残しました。")
    return settledSuccess(actor, today, applied.status, applied.revision, {
      via,
      gaps,
      rejectedPins,
      notices,
      ...(hold === null ? {} : { autoConfirmHold: hold }),
    })
  })
}

// ── 1 日の差替え ───────────────────────────────────────────────────

/** その日の、固定でも作った枠でもない料理を、直前と違う料理で選び直す。他の日は変えない。 */
export async function replaceDinnerDay(request: ReplaceDinnerDayRequest): Promise<DinnerSaveResult> {
  if (!isReplaceDinnerDayRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("replace_dinner_day", async (actor) => {
    const today = mealToday()
    const { date } = request
    if (date < today) return rejectedResult(MESSAGES.pastDate)
    if (date > shiftYmd(today, GROCERY_HORIZON_DAYS - 1)) return rejectedResult(MESSAGES.dateOutOfRange)
    const early = await replayOrStale(actor, today, request.operationId, request.expectedRevision)
    if (early.done) return early.done

    const loaded = await loadPlanningContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    if (context.plan.revision !== request.expectedRevision) {
      revalidateMeals()
      return conflictResult("stale_plan", context.plan.revision)
    }
    if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)

    const input = planInputOf(context, windowAround(date, today), {
      plannerOptions: { seed: seedFor(request.operationId) },
    })
    const replaced = replaceDay(input, date, knownRecipeIds(request.avoidRecipeIds, context.lookup))
    if (!replaced.ok) {
      return rejectedResult(replaced.reason === "nothing_to_replace" ? MESSAGES.nothingToReplace : MESSAGES.dateOutOfRange)
    }
    const { plan } = replaced
    const changed = plan.entries.some((entry) => entry.date === date && !entry.kept)
    if (!changed) {
      // 何も選び直せなかった。書かずに、理由を返す
      const gaps = gapNotices(plan).filter((gap) => gap.date === date)
      // 判定できないアレルギーの除外があると、候補は 1 つも残らない。空き枠の文だけでは原因へ辿れない
      const hold = describeAutoConfirmHold(buildExclusionSet(context.exclusions, context.lookup))
      if (hold !== null) return rejectedResult(hold)
      return rejectedResult(gaps.length > 0 ? gaps.map((gap) => gap.message).join(" ") : MESSAGES.noAlternative)
    }
    const toApply = entriesToApply(plan, { from: date, to: date }, context, request.operationId, () => "auto")
    if (!toApply.ok) return rejectedResult(MESSAGES.saveFailed)

    const applied = await applyPlan(actor, {
      operationId: request.operationId,
      expectedRevision: request.expectedRevision,
      from: date,
      to: date,
      entries: toApply.entries,
    })
    if (!applied.ok) return applied.failure
    if (applied.status === "conflict") {
      revalidateMeals()
      return conflictResult("stale_plan", applied.revision)
    }
    const gaps = gapNotices(plan).filter((gap) => gap.date === date)
    const hold = autoConfirmHoldOf(gaps, context)
    // 選び直さずに外した枠（主食を含む主菜へ替わった日の主食）は、黙って消さずに料理名つきで知らせる
    const droppedEntries = droppedNotices(plan, context)
    const notices = [
      ...(hold === null ? [] : [hold]),
      ...droppedEntries.map((dropped) => dropped.message),
      ...gaps.map((gap) => gap.message),
    ]
    if (plan.unchanged.length > 0) notices.push("ほかの候補が無い料理は、そのまま残しました。")
    return settledSuccess(actor, today, applied.status, applied.revision, {
      gaps,
      notices,
      droppedEntries,
      ...(hold === null ? {} : { autoConfirmHold: hold }),
    })
  })
}

// ── 1 品の差替え ───────────────────────────────────────────────────

/**
 * 1 品だけを、直前と違う料理で選び直す（固定した料理・作った料理は拒否）。
 *
 * 応答を失った後の再送は、枠の版が進んでいるので conflict になる（もう一度別の料理へ替えない）。
 */
export async function replaceDinnerDish(request: ReplaceDinnerDishRequest): Promise<DinnerSaveResult> {
  if (!isReplaceDinnerDishRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("replace_dinner_dish", async (actor) => {
    const today = mealToday()
    const loaded = await loadPlanningContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    if (target.version !== request.version) {
      // 画面が見ていた料理と違う（別の端末の変更、または応答を失った自分の差替え）。もう一度は替えない
      revalidateMeals()
      return conflictResult("row_changed", context.plan.revision)
    }
    if (target.date < today) return rejectedResult(MESSAGES.pastDate)
    if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)

    const input = planInputOf(context, windowAround(target.date, today), {
      plannerOptions: { seed: seedFor(request.entryId) },
    })
    const replaced = replaceDish(input, target.id, knownRecipeIds(request.avoidRecipeIds, context.lookup))
    if (!replaced.ok) {
      if (replaced.reason === "pinned") return rejectedResult(MESSAGES.pinnedEntry)
      if (replaced.reason === "cooked") return rejectedResult(MESSAGES.cookedEntry)
      return rejectedResult(MESSAGES.dateOutOfRange)
    }
    const chosen = replaced.plan.entries.find(
      (entry) => entry.date === target.date && entry.role === target.role && !entry.kept,
    )
    if (!chosen || chosen.recipeId === null) {
      const gap = gapNotices(replaced.plan).find((item) => item.date === target.date && item.role === target.role)
      // 判定できないアレルギーの除外があると、候補は 1 つも残らない。「ほかの候補が無い」だけでは原因へ辿れない
      const hold = describeAutoConfirmHold(buildExclusionSet(context.exclusions, context.lookup))
      if (hold !== null) return rejectedResult(hold)
      return rejectedResult(gap ? gap.message : MESSAGES.noAlternative)
    }
    const recipe = context.lookup.recipeById.get(chosen.recipeId)
    const set = buildExclusionSet(context.exclusions, context.lookup)
    if (!recipe || !evaluateRecipe(recipe, set).allowed) return rejectedResult(MESSAGES.saveFailed)

    // 同じ行（同じ ID・同じ位置・同じ人数）の料理だけを替える。選び直した料理は提案へ戻す
    const saved = await saveEntry(
      actor,
      target.id,
      request.version,
      entryInputOf(target, {
        recipeId: recipe.id,
        recipeVersion: recipe.version,
        customTitle: null,
        customIngredients: null,
        pinned: false,
        status: "proposed",
        origin: "auto",
      }),
    )
    return finishEntrySave(actor, today, saved)
  })
}

// ── 1 枠の読み込みと、状態・固定・移動 ─────────────────────────────

type EntryParts = "plan" | "exclusions" | "settings"

async function loadEntryContext(
  actor: DinnerActor,
  today: string,
): Promise<{ context: MealContext<EntryParts> } | { failure: ChoreSaveFailure }> {
  const loaded = await loadMealContext(actor.supabase, actor.householdId, {
    include: ["plan", "exclusions", "settings"],
    planRange: entryRange(today),
    today,
  })
  if (!loaded.ok) return { failure: rejectedResult(MESSAGES.readFailed) }
  return { context: loaded.context }
}

/** 固定する・固定を解除する（明示の操作）。使わない食材に当たる料理は固定しない。 */
export async function setDinnerPin(request: SetDinnerPinRequest): Promise<DinnerSaveResult> {
  if (!isSetDinnerPinRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("set_dinner_pin", async (actor) => {
    const today = mealToday()
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    if (request.pinned && target.pinned !== true) {
      // 固定でも新しい必須除外を無視しない（選び直してから固定する）
      const set = buildExclusionSet(context.exclusions, context.lookup)
      if (evaluateEntry(target, set).verdict === "blocked") return rejectedResult(MESSAGES.blockedPin)
    }
    const saved = await saveEntry(actor, target.id, request.version, entryInputOf(target, { pinned: request.pinned }))
    return finishEntrySave(actor, today, saved)
  })
}

// ── 人数 ───────────────────────────────────────────────────────────

/** 手動料理は、登録した材料が「その枠の人数ぶん」の実量。人数を変えても材料の量は書き換えない。 */
const CUSTOM_SERVINGS_NOTICE =
  "手で入れた料理の材料の量は、人数を変えても変わりません。量は料理の編集で直してください。"

/**
 * 1 枠の人数を変える（R45）。固定した料理・確定した料理も変えられる（料理・固定・状態はそのまま）。
 * 作った料理は変えない。買い物の必要量は、成立した後の同期で新しい人数から計算し直される。
 */
export async function setDinnerEntryServings(request: SetDinnerServingsRequest): Promise<DinnerSaveResult> {
  if (!isSetDinnerServingsRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("set_dinner_entry_servings", async (actor) => {
    const today = mealToday()
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    if (target.status === "cooked") return rejectedResult(MESSAGES.cookedEntry)
    const saved = await saveEntry(actor, target.id, request.version, entryInputOf(target, { servings: request.servings }))
    const notices = target.recipeId === null && target.customIngredients !== null ? [CUSTOM_SERVINGS_NOTICE] : []
    return finishEntrySave(actor, today, saved, notices)
  })
}

/**
 * これからの未調理の枠（今日以降の提案・確定。固定を含む）を、まとめて `servings` 人分にする（R45）。
 * **設定の保存は献立を書き換えない** — 設定の人数を変えた後に、利用者が選んだときだけ呼ぶ。
 *
 * - 作った・作らなかった枠と、過ぎた日の枠には触れない。既にその人数の枠は書かない。
 * - 1 品ずつ版つきで書く。途中で止まっても、変えた分の買い物の同期と再検証は走らせ、変えた件数を伝える。
 *   同じ要求を送り直せば、残りだけが続きから変わる（献立の版に依らないので「古い版」の衝突にならない）。
 * - 別の端末が先に変えた枠は上書きせず、conflict として知らせる（そこまでに変えた分は残る）。
 */
export async function applyServingsToUpcomingDinners(request: ApplyDinnerServingsRequest): Promise<DinnerSaveResult> {
  if (!isApplyDinnerServingsRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("apply_dinner_servings", async (actor) => {
    const today = mealToday()
    const { servings } = request
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    // 読めない枠が在ると「これからの枠を全部そろえた」と言えない
    if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)
    const targets = context.plan.entries.filter(
      (entry) => isUpcomingUncookedEntry(entry, today) && entry.servings !== servings,
    )
    if (targets.length === 0) {
      return {
        status: "replayed",
        revision: context.plan.revision,
        notices: [`これからの献立は、すでに${servings}人分です。`],
        grocery: null,
        changedEntries: 0,
      }
    }

    let changed = 0
    let revision: number | null = context.plan.revision
    /** 途中で止まったとき: 変えた分の買い物の同期と再検証を走らせてから、変えた件数を添える。 */
    const settlePartial = async (): Promise<string> => {
      if (changed === 0) return ""
      await syncAfterPlanChange(actor, today)
      revalidateMeals()
      return ` ${changed}品は${servings}人分に変更済みです。もう一度押すと、残りを続けて変更します。`
    }
    for (const entry of targets) {
      const saved = await saveEntry(actor, entry.id, entry.version, entryInputOf(entry, { servings }))
      if (!saved.ok) {
        const partial = await settlePartial()
        return { ...saved.failure, error: `${saved.failure.error}${partial}` }
      }
      if (saved.status === "conflict") {
        const grocery = changed > 0 ? await syncAfterPlanChange(actor, today) : null
        revalidateMeals()
        return {
          status: "conflict",
          detail: saved.gone ? "gone" : "row_changed",
          revision: saved.revision,
          notices: [
            `別の端末が先に変えた料理があったため、そこで止めました（${changed}品は${servings}人分に変更済み）。最新の献立を確かめて、もう一度お試しください。`,
          ],
          grocery,
          changedEntries: changed,
        }
      }
      changed += 1
      revision = saved.revision
    }
    const notices = [`これからの献立${changed}品を${servings}人分にしました。`]
    if (targets.some((entry) => entry.recipeId === null && entry.customIngredients !== null)) {
      notices.push(CUSTOM_SERVINGS_NOTICE)
    }
    return settledSuccess(actor, today, "saved", revision, { notices, changedEntries: changed })
  })
}

/**
 * 1 品を別の日へ移す。固定は料理に付いて行く。作った料理は動かさない。
 *
 * 移動先の料理（固定した料理を含む）は**そのまま残す** — 押しのけない・入れ替えない。移動先に同じ区分の
 * 料理があれば、その日は同じ区分が 2 品になる（知らせを返す。入れ替えたいときは、もう 1 品を逆へ移す）。
 */
export async function moveDinnerEntry(request: MoveDinnerEntryRequest): Promise<DinnerSaveResult> {
  if (!isMoveDinnerEntryRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("move_dinner_entry", async (actor) => {
    const today = mealToday()
    const range = entryRange(today)
    if (request.toDate < today || !isWithin(request.toDate, range)) return rejectedResult(MESSAGES.dateOutOfRange)
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    if (target.status === "cooked") return rejectedResult(MESSAGES.cookedEntry)

    // 既に移動先に在る（応答を失った再送）なら、位置を変えずに同じ内容を送る（replayed になる）
    const position =
      target.date === request.toDate ? target.position : freePosition(context.plan.entries, request.toDate, target.id)
    if (position === null) return rejectedResult(MESSAGES.noFreeSlot)
    const sameRole = context.plan.entries.some(
      (entry) =>
        entry.id !== target.id && entry.date === request.toDate && entry.role === target.role && entry.status !== "skipped",
    )
    const saved = await saveEntry(
      actor,
      target.id,
      request.version,
      entryInputOf(target, { date: request.toDate, position }),
    )
    const notices = sameRole
      ? [`${formatMealDateShort(request.toDate)}は${dishRoleLabel(target.role)}が 2 品になりました。元の料理はそのまま残しています。`]
      : []
    return finishEntrySave(actor, today, saved, notices)
  })
}

/**
 * 一覧のレシピ 1 品を、指定の日の献立へ**足す**（「今あるもので」・レシピ詳細から。R48 / ④）。
 *
 * - その日の既存の料理・固定枠には触れない（作り直し・差し替えではない）。空いている枠へ固定・手動で 1 行足す。
 *   入れる日が空である必要は無い（金曜に固定したカレーが在っても、副菜を足せる）。
 * - 書込は `save_dinner_entry` に新しい ID・版 NULL で送る（その ID が既に在れば、同じ内容なら replayed、
 *   違えば conflict。**上書きしない**）。新しく足すとき（その ID の行が無いとき）は、押した時点の献立の版
 *   （`expectedRevision`）と今の版を比べ、違えば書かずに conflict（レビュー[中 5]: 先の追加が成立した後に別の端末が
 *   消していても、削除の印は残らない。追加・削除ともに版を進めるので、版で見分ける）。あわせて、押した時点に
 *   固定した位置・状態が今のその日でも成り立つかを確かめる（枠が埋まった・状態が変わった・同じ料理が入った →
 *   conflict。読み直させる。改ざんされた要求への守りも兼ねる）。
 * - **再送（同じ ID）は確かめずにそのまま送る** — 先の送信が成立していれば、日が埋まり・状態が変わっていても
 *   replayed になる（検査で拒むと、成立した追加を「入らなかった」と言ってしまう）。
 * - 状態はその日に合わせる（画面が `addedDishStatus` で決めて固定し、サーバーが照らす）。確定済みの日へ足した料理は
 *   確定として買い物に入る。足す料理も使わない食材で判定し、「当たる」「未確認」は入れない（確定に混ぜない）。
 */
export async function addDinnerRecipe(request: AddDinnerRecipeRequest): Promise<DinnerSaveResult> {
  if (!isAddDinnerRecipeRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("add_dinner_recipe", async (actor) => {
    const today = mealToday()
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const recipe = context.lookup.recipeById.get(request.recipeId)
    if (!recipe) return rejectedResult(MESSAGES.unknownRecipe)
    const input: PlanEntryInput = {
      date: request.date,
      role: request.role,
      position: request.position,
      recipeId: recipe.id,
      recipeVersion: recipe.version,
      customTitle: null,
      customIngredients: null,
      servings: request.servings,
      pinned: true,
      status: request.status,
      origin: "manual",
    }

    const existing = context.plan.entries.find((entry) => entry.id === request.id)
    let notices: string[] = []
    if (!existing) {
      // 新しく足す: 押した時点に固定した内容が、今のその日でも成り立つか
      if (request.date < today) return rejectedResult(MESSAGES.addPastDate)
      if (!isWithin(request.date, entryRange(today))) return rejectedResult(MESSAGES.dateOutOfRange)
      if (recipe.role !== request.role) return rejectedResult(MESSAGES.addRoleMismatch)
      // 読めない枠が在ると、空いている枠・その日の状態を確かめられない
      if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)
      const set = buildExclusionSet(context.exclusions, context.lookup)
      const verdict = evaluateRecipe(recipe, set).verdict
      if (verdict === "blocked") return rejectedResult(MESSAGES.addBlocked)
      if (verdict === "label_check") return rejectedResult(describeAutoConfirmHold(set) ?? MESSAGES.addLabelCheck)

      const day = context.plan.entries.filter((entry) => entry.date === request.date)
      const dayChanged = (notice: string) => {
        revalidateMeals()
        return conflictResult("day_changed", context.plan.revision, [notice])
      }
      // 押した後に献立が変わっていたら書かない（レビュー[中 5]）。行が無いのは「先の送信が届かなかった」か
      // 「届いた後に別の端末が消した」かで、削除の印は残らないので行からは見分けられない。追加も削除も献立の版を
      // 進めるので、版が押した時と同じなら前者（何も起きていない）。違えば消された料理を蘇らせうるので止める
      if (context.plan.revision !== request.expectedRevision) return dayChanged(MESSAGES.addPlanChanged)
      if (day.some((entry) => entry.recipeId === recipe.id && entry.status !== "skipped")) {
        return dayChanged(MESSAGES.addAlready)
      }
      if (day.some((entry) => entry.role === request.role && entry.position === request.position)) {
        return dayChanged(MESSAGES.addSlotTaken)
      }
      if (addedDishStatus(day) !== request.status) return dayChanged(MESSAGES.addStatusChanged)
      const sameRole = day.some((entry) => entry.role === recipe.role && entry.status !== "skipped")
      if (sameRole) {
        notices = [
          `${formatMealDateShort(request.date)}は${dishRoleLabel(recipe.role)}が 2 品になりました。元の料理はそのまま残しています。`,
        ]
      }
    }

    const saved = await saveEntry(actor, request.id, null, input)
    if (!saved.ok && saved.failure.failure === "conflict") {
      // 23505（枠が埋まっていた。読んだ後に別の端末が入れた）。上書きせず、読み直させる
      revalidateMeals()
      return conflictResult("day_changed", null, [MESSAGES.addSlotTaken])
    }
    return finishEntrySave(actor, today, saved, notices)
  })
}

async function setEntryStatus(
  action: string,
  request: DinnerEntryRef,
  next: (entry: StoredPlanEntry, today: string) => PlanEntry["status"] | ChoreSaveFailure,
): Promise<DinnerSaveResult> {
  if (!isDinnerEntryRef(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction(action, async (actor) => {
    const today = mealToday()
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    const status = next(target, today)
    if (typeof status !== "string") return status
    const saved = await saveEntry(actor, target.id, request.version, entryInputOf(target, { status }))
    return finishEntrySave(actor, today, saved)
  })
}

/**
 * 「作った」にする（今日までの日だけ。未来の日は拒否）。
 * **在庫は自動では減らさない** — 使った食材の更新は、利用者が選んで `applyCookedPantryUpdates` で送る。
 */
export async function markDinnerCooked(request: DinnerEntryRef): Promise<DinnerSaveResult> {
  return setEntryStatus("mark_dinner_cooked", request, (entry, today) =>
    entry.date > today ? rejectedResult(MESSAGES.futureCooked) : "cooked",
  )
}

/** 「作らなかった」にする（好みの評価には使わない記録）。 */
export async function markDinnerSkipped(request: DinnerEntryRef): Promise<DinnerSaveResult> {
  return setEntryStatus("mark_dinner_skipped", request, () => "skipped")
}

/**
 * 「作った」「作らなかった」を取り消して、**その前の状態**（提案か確定。DB が遷移の時に `prior_status` へ保持）へ戻す。
 * 提案のまま「作った」にした料理を確定へ戻すと、元は買い物に入っていなかった料理が買い物へ入るため、常に確定へは戻さない。
 * 記録が無い（この列より前の行）ときは確定へ戻す。
 * 既に提案・確定の枠（応答を失った取り消しの再送・二重の取り消し）は、今の状態をそのまま送る（DB が replayed を返す）。
 * 買い物の充当は、続く同期がこの料理の分だけを外す（在庫は変えない）。
 *
 * **確定へ戻すときも、使わない食材で判定し直す**（「作らなかった」の後に除外が増えていることがある）。「当たる」
 * 「未確認」なら確定へは戻さず提案へ戻し、そう知らせる（確定は「問題なし」の料理だけ = 買い物に入れない）。
 */
export async function restoreDinnerEntry(request: DinnerEntryRef): Promise<DinnerSaveResult> {
  if (!isDinnerEntryRef(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("restore_dinner_entry", async (actor) => {
    const today = mealToday()
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const target = context.plan.entries.find((entry) => entry.id === request.entryId)
    if (!target) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
    const recorded = target.status === "cooked" || target.status === "skipped"
    let status: PlanEntry["status"] = recorded ? (target.priorStatus ?? "confirmed") : target.status
    let warning: DinnerSaveSuccess["exclusionWarning"] | null = null
    if (recorded && status === "confirmed") {
      const set = buildExclusionSet(context.exclusions, context.lookup)
      if (evaluateEntry(target, set).verdict !== "ok") {
        status = "proposed"
        warning = entryExclusionWarning(target, set, true)
      }
    }
    const saved = await saveEntry(actor, target.id, request.version, entryInputOf(target, { status }))
    return finishEntrySave(actor, today, saved, warning ? [warning.message] : [], warning ? { exclusionWarning: warning } : {})
  })
}

/** 1 品を献立から消す（手動で足した料理の取り消しなど）。 */
export async function deleteDinnerEntry(request: DinnerEntryRef): Promise<DinnerSaveResult> {
  if (!isDinnerEntryRef(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("delete_dinner_entry", async (actor) => {
    const today = mealToday()
    const { data, error } = await actor.supabase.rpc("delete_dinner_entry", {
      p_id: request.entryId,
      p_version: request.version,
    })
    if (error) {
      logDinnerError("delete_dinner_entry failed", error, actor)
      return dinnerFailureOf(error)
    }
    const status = parseRpcStatus(data)
    if (status === null || !isRecord(data)) return unknownResult()
    const revision = toFiniteNumber(data.revision)
    if (status === "conflict") {
      revalidateMeals()
      return conflictResult("row_changed", revision)
    }
    return settledSuccess(actor, today, status, revision)
  })
}

// ── 使わない食材との照合（問題なし / 当たる / 未確認） ─────────────

function titlesOf(conflicts: readonly PlanConflict[]): string {
  return conflicts.map((conflict) => conflict.title || "名前のない料理").join("、")
}

/**
 * 確定を止めるときの文。「当たる」と「未確認」を分けて言う（何も確定していないこと・直し方も）。
 * 判定できないアレルギーの除外のためだけに全てが「未確認」なら、その除外を名指しする。
 */
function confirmHoldMessage(conflicts: readonly PlanConflict[], set: ExclusionSet): string {
  const blocked = conflicts.filter((conflict) => conflict.verdict === "blocked")
  const unverified = conflicts.filter((conflict) => conflict.verdict === "label_check")
  const parts: string[] = []
  if (blocked.length > 0) {
    parts.push(`使わない食材の設定に当たる料理が${blocked.length}品あります（${titlesOf(blocked)}）。`)
  }
  if (unverified.length > 0) {
    const hold = describeAutoConfirmHold(set)
    parts.push(
      hold !== null && unverified.every((conflict) => conflict.unverifiable.length === 0)
        ? hold
        : `原材料を確かめられない料理が${unverified.length}品あります（${titlesOf(unverified)}）。材料を登録すると確かめられます。`,
    )
  }
  return `${parts.join("")}何も確定していません。選び直すか、材料を見直してから確定してください。`
}

/** 確定を外して提案へ戻したときに添える文。 */
const DEMOTED_TEXT = "確定を外し、提案へ戻しました（買い物リストからも外れます）。"

/**
 * 1 品の料理の、使わない食材の照合の警告（問題なしなら null）。手動料理の保存・取り消しで使う
 * （保存は止めない = 下書きとして残す。「当たる」「未確認」の料理は確定に混ぜない — `confirmDinnerPlan` が止める）。
 * 判定は登録した材料の正規化 ID・派生・アレルゲン（マヨネーズ → 卵）と、手動料理の料理名（`evaluateEntry`）。
 *
 * @param demoted 確定だった料理を、この照合のために提案へ戻したか（そう言う。「このままでは確定できません」とは言わない
 *   — 既に確定していた料理だから）。
 */
function entryExclusionWarning(
  entry: PlanEntry,
  set: ExclusionSet,
  demoted: boolean,
): NonNullable<DinnerSaveSuccess["exclusionWarning"]> | null {
  const evaluation = evaluateEntry(entry, set)
  const name =
    entry.recipeId === null ? (entry.customTitle ?? "料理") : (set.view.recipeById.get(entry.recipeId)?.title ?? "料理")
  const title = `「${name}」`
  const tail = (fix: string) => (demoted ? `${DEMOTED_TEXT}${fix}まで確定できません。` : `このままでは確定できません。${fix}てください。`)
  if (evaluation.verdict === "blocked") {
    const names = blockedIngredientNames(evaluation.blockedBy, set)
    return {
      verdict: "blocked",
      message: `${title}は使わない食材の設定に当たります${names.length > 0 ? `（${names.join("、")}）` : ""}。${demoted ? "" : "献立には残しましたが、"}${tail("料理か材料を選び直し")}`,
    }
  }
  if (evaluation.verdict === "label_check") {
    const reasons = new Set(evaluation.unverifiable.map((item) => item.reason))
    if (reasons.has("no_ingredients")) {
      return {
        verdict: "label_check",
        message: `材料が登録されていないため、${title}が使わない食材に当たるかを確かめられません。${tail("材料を登録し")}`,
      }
    }
    const hold = reasons.size === 0 ? describeAutoConfirmHold(set) : null
    return {
      verdict: "label_check",
      message:
        hold === null
          ? `${title}は原材料を確かめられない材料を含みます。${tail("材料を見直し")}`
          : `${hold}${demoted ? DEMOTED_TEXT : ""}`,
    }
  }
  return null
}

// ── 手動料理 ───────────────────────────────────────────────────────

/** 手動料理の材料を、食材辞書の ID へ解決する。解決できない名前は捨てずに返す。 */
function resolveCustomIngredients(
  inputs: readonly CustomIngredientInput[],
  lookup: MealLookup,
): { ingredients: RecipeIngredient[]; unresolved: string[] } {
  const ingredients: RecipeIngredient[] = []
  const unresolved: string[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const id =
      input.ingredientId !== undefined
        ? lookup.index.byId.has(input.ingredientId)
          ? input.ingredientId
          : null
        : resolveIngredientId(input.name ?? "", lookup.index)
    if (id === null) {
      unresolved.push(input.name ?? input.ingredientId ?? "")
      continue
    }
    // 同じ食材・同じ単位の重複は、どちらの量かを決めずに拒む側へ倒す
    const key = `${id}|${input.unit}`
    if (seen.has(key)) {
      unresolved.push(lookup.index.byId.get(id)?.name ?? id)
      continue
    }
    seen.add(key)
    const ingredient: RecipeIngredient = { ingredientId: id, quantity: { amount: input.amount, unit: input.unit } }
    if (input.optional === true) ingredient.optional = true
    ingredients.push(ingredient)
  }
  return { ingredients, unresolved }
}

/**
 * 手動料理（一覧に無い料理）を足す・直す。材料は任意（未登録なら買い物の自動計算の対象外）。
 *
 * 手で入れた料理は**固定として保存**する（献立の作り直しで消えない。外すのは明示の解除・削除だけ）。
 * 材料は「その枠の人数ぶん」として扱う。
 */
export async function saveCustomDish(request: SaveCustomDishRequest): Promise<DinnerSaveResult> {
  if (!isSaveCustomDishRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("save_custom_dish", async (actor) => {
    const today = mealToday()
    if (!isWithin(request.date, entryRange(today))) return rejectedResult(MESSAGES.dateOutOfRange)
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded

    let customIngredients: RecipeIngredient[] | null = null
    if (request.ingredients !== null) {
      const resolved = resolveCustomIngredients(request.ingredients, context.lookup)
      if (resolved.unresolved.length > 0) {
        return rejectedResult(
          `次の食材は材料として登録できません（辞書に無い・重複している）: ${resolved.unresolved.join("、")}。名前を見直すか、外して保存してください。`,
        )
      }
      // 空の一覧は「材料なし」（自動計算の対象外）として保存する
      customIngredients = resolved.ingredients.length > 0 ? resolved.ingredients : null
    }

    const existing = context.plan.entries.find((entry) => entry.id === request.id)
    let input: PlanEntryInput
    if (existing) {
      if (existing.recipeId !== null) return rejectedResult(MESSAGES.notCustom)
      if (existing.status === "cooked") return rejectedResult(MESSAGES.cookedEntry)
      if (existing.date !== request.date || existing.role !== request.role) return rejectedResult(MESSAGES.customMoved)
      input = entryInputOf(existing, {
        customTitle: request.title.trim(),
        customIngredients,
        servings: request.servings ?? existing.servings,
      })
    } else {
      if (request.version !== null) return conflictResult("gone", context.plan.revision, [MESSAGES.goneEntry])
      const position = freePosition(context.plan.entries, request.date, null)
      if (position === null) return rejectedResult(MESSAGES.noFreeSlot)
      input = {
        date: request.date,
        role: request.role,
        position,
        recipeId: null,
        recipeVersion: null,
        customTitle: request.title.trim(),
        customIngredients,
        servings: request.servings ?? context.settings.servings,
        pinned: true,
        status: "proposed",
        origin: "manual",
      }
    }
    // 使わない食材との照合（材料の正規化 ID・派生・アレルゲンと、料理名）。保存は止めず、確定に混ぜないことを言う。
    // 確定済みの料理を「当たる」「未確認」の内容へ直したら、確定のままにしない（提案へ戻す = 買い物からも外れる）。
    // 戻すかは直した後の内容だけで決まるので、応答を失った再送も同じ内容になる（replayed）
    const set = buildExclusionSet(context.exclusions, context.lookup)
    const demoted = input.status === "confirmed" && evaluateEntry({ id: request.id, ...input }, set).verdict !== "ok"
    if (demoted) input = { ...input, status: "proposed" }
    const saved = await saveEntry(actor, request.id, request.version, input)
    const warning = entryExclusionWarning({ id: request.id, ...input }, set, demoted)
    const notices = [
      ...(warning === null ? [] : [warning.message]),
      ...(customIngredients === null
        ? ["材料が登録されていないため、この料理は買い物の自動計算に入りません。材料を足すと計算されます。"]
        : []),
    ]
    return finishEntrySave(actor, today, saved, notices, warning === null ? {} : { exclusionWarning: warning })
  })
}

// ── 確定 ───────────────────────────────────────────────────────────

/**
 * 範囲内の提案を「確定」にする（確定した料理だけが買い物の自動計算に入る）。
 *
 * 使わない食材の設定に当たる料理が 1 品でも在れば、何も確定しない（置換もしない。選び直してから確定する）。
 *
 * 書込は `confirm_dinner_entries` の 1 トランザクション（**全部確定するか、何も変えないか**。版は 1 回だけ進む）。
 * 1 品ずつ書くと、途中で止まった後のやり直しが「自分の途中経過」で版違いの conflict になり、確定済みの分の
 * 買い物の同期も走らないまま残る。応答を失った後のやり直しは、何も書かれていなければ同じ版でそのまま確定し、
 * 書かれていれば範囲に提案が残っていないので replayed（買い物の同期はやり直す）になる。
 */
export async function confirmDinnerPlan(request: ConfirmDinnerPlanRequest): Promise<DinnerSaveResult> {
  if (!isConfirmDinnerPlanRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("confirm_dinner_plan", async (actor) => {
    const today = mealToday()
    const range = mealDateRange(request.startDate, request.days)
    if (range === null || !isWithin(range.from, entryRange(today)) || !isWithin(range.to, entryRange(today))) {
      return rejectedResult(MESSAGES.dateOutOfRange)
    }
    const loaded = await loadEntryContext(actor, today)
    if ("failure" in loaded) return loaded.failure
    const { context } = loaded
    const inRange = context.plan.entries.filter((entry) => isWithin(entry.date, range))
    const proposed = inRange.filter((entry) => entry.status === "proposed")
    if (proposed.length === 0) {
      // 応答を失った再送（全部が既に確定している）
      if (inRange.some((entry) => entry.status === "confirmed" || entry.status === "cooked")) {
        return settledSuccess(actor, today, "replayed", context.plan.revision)
      }
      return rejectedResult(MESSAGES.nothingToConfirm)
    }
    // 画面が見ていた献立と違う（別の端末が作り直した等）。見ていない料理を確定しない
    if (context.plan.revision !== request.expectedRevision) {
      revalidateMeals()
      return conflictResult("stale_plan", context.plan.revision)
    }
    if ((context.unreadable.plan ?? 0) > 0) return rejectedResult(MESSAGES.unreadablePlan)
    // 確定するのは「問題なし」の料理だけ。「当たる」も「未確認」（材料未登録の手動料理・原材料を確かめられない材料）も、
    // 固定・手動を含めて 1 品でも在れば何も確定しない（除外を確かめ済みの献立へ、確かめていない料理を混ぜない）
    const set = buildExclusionSet(context.exclusions, context.lookup)
    const conflicts = findPlanConflicts(proposed, set)
    if (conflicts.length > 0) return rejectedResult(confirmHoldMessage(conflicts, set))

    const { data, error } = await actor.supabase.rpc("confirm_dinner_entries", {
      p_expected_revision: request.expectedRevision,
      p_entries: proposed.map((entry) => ({ id: entry.id, version: entry.version })) as unknown as Json,
    })
    if (error) {
      logDinnerError("confirm_dinner_entries failed", error, actor)
      return dinnerFailureOf(error)
    }
    const status = parseRpcStatus(data)
    if (status === null || !isRecord(data)) return unknownResult()
    const revision = toFiniteNumber(data.revision)
    if (status === "conflict") {
      // 読んだ後に別の端末が変えた。1 品も確定していない。最新を見せる
      revalidateMeals()
      const detail = data.detail === "gone" ? "gone" : data.detail === "stale_plan" ? "stale_plan" : "row_changed"
      return conflictResult(detail, revision)
    }
    return settledSuccess(actor, today, status, revision)
  })
}

// ── 料理後の食材の更新 ─────────────────────────────────────────────

/**
 * 料理の後に、利用者が選んだ食材だけ状態（ある・残り少ない・使い切った）を更新する。
 * **選ばれなかった食材には触れない**（献立やレシピの量から自動では減らさない）。
 */
export async function applyCookedPantryUpdates(request: ApplyCookedPantryUpdatesRequest): Promise<DinnerSaveResult> {
  if (!isApplyCookedPantryUpdatesRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("apply_cooked_pantry_updates", async (actor) => {
    const today = mealToday()
    const loaded = await loadMealContext(actor.supabase, actor.householdId, { include: ["pantry"], today })
    if (!loaded.ok) return rejectedResult(MESSAGES.readFailed)
    const pantry = new Map(loaded.context.pantry.map((item) => [item.id, item]))

    let conflicts = 0
    let written = 0
    for (const update of request.updates) {
      const item = pantry.get(update.id)
      if (!item) {
        conflicts += 1
        continue
      }
      const { data, error } = await actor.supabase.rpc("save_pantry_item", {
        p_id: item.id,
        p_version: update.version,
        p_item: pantryItemToRpc({
          ingredientId: item.ingredientId,
          name: item.name,
          quantity: update.quantity === undefined ? item.quantity : update.quantity,
          status: update.status,
          useSoon: update.status === "out" ? false : item.useSoon,
          storage: item.storage,
          expiresOn: item.expiresOn,
          confirmedOn: today,
        }) as unknown as Json,
      })
      if (error) {
        logDinnerError("save_pantry_item (after cooking) failed", error, actor)
        return dinnerFailureOf(error)
      }
      const outcome = parseRpcOutcome(data, "item")
      if (!outcome) return unknownResult()
      if (outcome.status === "conflict") {
        conflicts += 1
        continue
      }
      const row = isDeletedEntity(outcome.entity) ? null : pantryItemFromRow(outcome.entity)
      if (!row || !row.ok || row.value.id !== item.id) return unknownResult()
      if (outcome.status === "saved") written += 1
    }

    // 在庫が変わると買い物の必要量も変わる
    const grocery = await syncAfterPlanChange(actor, today)
    revalidateMeals()
    if (conflicts > 0) {
      return {
        status: "conflict",
        detail: "row_changed",
        revision: null,
        notices: [`${conflicts}件は別の端末で変更・削除されていたため、更新していません。最新の食材を確認してください。`],
        grocery,
      }
    }
    return { status: written > 0 ? "saved" : "replayed", revision: null, notices: [], grocery }
  })
}

// ── 食後評価 ───────────────────────────────────────────────────────

/**
 * 食後評価（本人・料理・日付で 1 件）。味・手間・また食べたいを分けて記録する。
 * 評価した本人は DB が呼び手に固定する（送らない）。`excludeFromLearning` を立てた記録は好みへ反映しない。
 */
export async function saveDishFeedback(request: SaveDishFeedbackRequest): Promise<DinnerSaveResult> {
  if (!isSaveDishFeedbackRequest(request)) return rejectedResult(MESSAGES.invalid)
  return runDinnerAction("save_dish_feedback", async (actor) => {
    const today = mealToday()
    if (request.eatenOn > today) return rejectedResult(MESSAGES.futureFeedback)
    // カタログに無い ID を「料理」として好みの学習へ入れない
    if (request.recipeId !== null && !getMealLookup().recipeById.has(request.recipeId)) {
      return rejectedResult(MESSAGES.unknownRecipe)
    }
    const { data, error } = await actor.supabase.rpc(
      "save_dish_feedback",
      dishFeedbackToRpcArgs(request.id, request.version, {
        recipeId: request.recipeId,
        dishTitle: request.dishTitle,
        eatenOn: request.eatenOn,
        taste: request.taste,
        effort: request.effort,
        again: request.again,
        excludeFromLearning: request.excludeFromLearning,
      }),
    )
    if (error) {
      logDinnerError("save_dish_feedback failed", error, actor)
      return dinnerFailureOf(error)
    }
    const outcome = parseRpcOutcome(data, "feedback")
    if (!outcome) return unknownResult()
    revalidateMeals()
    if (isDeletedEntity(outcome.entity)) {
      return outcome.status === "conflict" ? conflictResult("gone", null) : unknownResult()
    }
    const row = dishFeedbackFromRow(outcome.entity)
    if (!row.ok) return unknownResult()
    if (outcome.status === "conflict") {
      // 別の ID で、同じ料理・同じ日の自分の評価が既に在る場合もここへ来る
      return conflictResult("row_changed", null, [
        row.value.id === request.id
          ? "この評価は別の端末で更新されていました。最新の内容を確認してください。"
          : "この料理のこの日の評価は、既に記録されています。記録済みの評価を直してください。",
      ])
    }
    if (row.value.id !== request.id || row.value.profileId !== actor.userId) return unknownResult()
    return { status: outcome.status, revision: null, notices: [], grocery: null }
  })
}

// ── 1 つの入口（useChoreSave 用） ──────────────────────────────────

/**
 * 献立の保存操作をまとめて受ける入口（`op` で振り分ける）。個々の Action と同じ検証・認証を通る。
 * 人数の変更（`servings` / `servings_upcoming`）もここで受ける。
 */
export async function saveDinnerRequest(request: DinnerRequest | DinnerServingsRequest): Promise<DinnerSaveResult> {
  if (isDinnerServingsRequest(request)) {
    return request.op === "servings"
      ? setDinnerEntryServings(withoutOp(request))
      : applyServingsToUpcomingDinners(withoutOp(request))
  }
  if (!isDinnerRequest(request)) return rejectedResult(MESSAGES.invalid)
  switch (request.op) {
    case "generate":
      return generateDinnerPlan(withoutOp(request))
    case "replace_day":
      return replaceDinnerDay(withoutOp(request))
    case "replace_dish":
      return replaceDinnerDish(withoutOp(request))
    case "move":
      return moveDinnerEntry(withoutOp(request))
    case "pin":
      return setDinnerPin(withoutOp(request))
    case "custom_dish":
      return saveCustomDish(withoutOp(request))
    case "confirm":
      return confirmDinnerPlan(withoutOp(request))
    case "cooked":
      return markDinnerCooked(withoutOp(request))
    case "skipped":
      return markDinnerSkipped(withoutOp(request))
    case "restore":
      return restoreDinnerEntry(withoutOp(request))
    case "delete":
      return deleteDinnerEntry(withoutOp(request))
    case "pantry_after_cooking":
      return applyCookedPantryUpdates(withoutOp(request))
    case "feedback":
      return saveDishFeedback(withoutOp(request))
    case "add_recipe":
      return addDinnerRecipe(withoutOp(request))
    default:
      return rejectedResult(MESSAGES.invalid)
  }
}
