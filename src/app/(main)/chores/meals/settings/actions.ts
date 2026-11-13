"use server"

import { revalidatePath } from "next/cache"

import { MEALS_REVALIDATE_PATH } from "@/components/chores/meals/shared/meal-routes"
import { isRecord } from "@/lib/domain/child-sharing"
import {
  parseRpcOutcome,
  parseRpcStatus,
  rejectedResult,
  unknownResult,
  type ChoreSaveFailure,
  type ChoreSaveResult,
} from "@/lib/domain/rpc-outcome"
import { getRecipeTagLabel } from "@/lib/meals/catalog/tags"
import { getMealLookup, loadMealContext } from "@/lib/meals/server/context"
import { mealFailureOf, settleMealAction } from "@/lib/meals/server/meal-input"
import { countServingsMismatch } from "@/lib/meals/server/plan-requests"
import {
  dinnerSettingsFromRow,
  dinnerSettingsToRpcArgs,
  foodExclusionFromRow,
  foodExclusionToRpcArgs,
  foodPreferenceFromRow,
  foodPreferenceToRpcArgs,
  isDeletedEntity,
} from "@/lib/meals/server/rows"
import {
  SETTINGS_INPUT_MESSAGES,
  idOnlyIssue,
  saveDinnerSettingsIssue,
  saveFoodExclusionIssue,
  saveFoodPreferenceIssue,
  type DeleteDishFeedbackRequest,
  type DeleteFoodExclusionRequest,
  type DeleteFoodPreferenceRequest,
  type DinnerSettingsSaveSuccess,
  type FoodExclusionDeleteSuccess,
  type FoodExclusionSaveSuccess,
  type FoodPreferenceSaveSuccess,
  type MealDeleteSuccess,
  type PlanConflictReport,
  type SaveDinnerSettingsRequest,
  type SaveFoodExclusionRequest,
  type SaveFoodPreferenceRequest,
} from "@/lib/meals/server/settings-requests"
import { mealToday } from "@/lib/meals/server/today"
import { PLAN_CONFLICT_PARTS, buildExclusionResolutionView, buildPlanConflictReport } from "@/lib/meals/server/views"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseErrorRedacted } from "@/lib/supabase/log-error"
import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * 衝突を確かめる献立の範囲（今日から何日先まで）。DB が受ける献立の日付の上限
 * （`dinner_entry_parse` の「今日 + 400 日」）と同じにして、「今日以降」の枠を漏らさない。
 */
const PLAN_CONFLICT_HORIZON_DAYS = 400

/** 設定・除外・好みは、今夜・今あるもので・献立・買い物・レシピの全部に効く。ごはんの全画面と家事の入口を読み直す。 */
function revalidateMeals(): void {
  revalidatePath(MEALS_REVALIDATE_PATH, "layout")
  revalidatePath("/chores")
}

/** `{ status, id }` を返す削除 RPC の戻り値を読む。 */
function deleteOutcome(data: unknown, id: string): MealDeleteSuccess | ChoreSaveFailure {
  const status = parseRpcStatus(data)
  // 版を持たない削除は saved（消した）か replayed（既に無かった）だけ
  if (!isRecord(data) || (status !== "saved" && status !== "replayed") || data.id !== id) return unknownResult()
  revalidateMeals()
  return { status, id }
}

/**
 * 人数・汁物・調理時間の上限・常備品・子どもの食事の段階を保存する。
 *
 * - 常備品は食材の一覧に在る ID だけ（世帯が選んだものだけを保存し、初期値を足さない）。
 * - 食事の段階はロジックの語彙（`GUARDIAN_MEAL_STAGES`）だけ。子が世帯の子であることは DB が確かめる。
 * - 家族が先に変えていれば `conflict`（上書きしない。DB の最新を返す）。
 */
export async function saveDinnerSettings(
  request: SaveDinnerSettingsRequest,
): Promise<ChoreSaveResult<DinnerSettingsSaveSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = saveDinnerSettingsIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  const lookup = getMealLookup()
  if (!request.stapleIngredientIds.every((id) => lookup.index.byId.has(id))) {
    return rejectedResult("常備品に、食材の一覧にない食材が含まれています。選び直してください。")
  }

  return settleMealAction("save_dinner_settings", userId, async () => {
    const { data, error } = await supabase.rpc(
      "save_dinner_settings",
      dinnerSettingsToRpcArgs(
        {
          servings: request.servings,
          includeSoup: request.includeSoup,
          maxCookMinutes: request.maxCookMinutes,
          stapleIngredientIds: request.stapleIngredientIds,
          childStages: request.childStages,
        },
        request.version,
      ),
    )
    if (error) {
      logSupabaseErrorRedacted("meals", "save_dinner_settings failed", error, { userId })
      return mealFailureOf(error, {
        forbidden: "この設定を保存できません。世帯にいない子どもは設定できません。再読み込みして確認してください。",
      })
    }
    const outcome = parseRpcOutcome(data, "settings")
    if (!outcome) return unknownResult()
    if (isDeletedEntity(outcome.entity)) {
      if (outcome.status !== "conflict") return unknownResult()
      revalidateMeals()
      return { status: "conflict", settings: null, deleted: true }
    }
    const mapped = dinnerSettingsFromRow(outcome.entity)
    if (!mapped.ok) return unknownResult()
    revalidateMeals()
    if (outcome.status === "conflict") {
      return { status: outcome.status, settings: mapped.value, deleted: false, planServingsMismatch: null }
    }
    // 人数は枠の作成時に写してある。設定を変えても既存の枠は変えない — 違う人数の枠の数だけを返し、
    // 反映するかは利用者が選ぶ（R45）
    const planServingsMismatch = await countPlanServingsMismatch(auth.context, mapped.value.servings)
    return { status: outcome.status, settings: mapped.value, deleted: false, planServingsMismatch }
  })
}

/**
 * これからの未調理の枠のうち、人数が `servings` と違う枠の数。読めなければ null
 * （「0 件」と言い換えない）。献立は書き換えない。
 */
async function countPlanServingsMismatch(
  { supabase, householdId, userId }: AuthContext,
  servings: number,
): Promise<number | null> {
  try {
    const today = mealToday()
    const loaded = await loadMealContext(supabase, householdId, {
      include: ["plan"],
      today,
      planRange: { from: today, to: shiftYmd(today, PLAN_CONFLICT_HORIZON_DAYS) },
    })
    if (!loaded.ok || (loaded.context.unreadable.plan ?? 0) > 0) return null
    return countServingsMismatch(loaded.context.plan.entries, servings, today)
  } catch (err) {
    console.error("[meals] plan servings check threw", {
      userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * 除外を変えた後の、今日以降の献立（提案・確定の枠。固定を含む）との重なり。**置換はしない。**
 * 読めなければ null（「重なりは無い」と言い換えない）。
 */
async function loadPlanConflicts(
  { supabase, householdId }: AuthContext,
  highlightExclusionIds: readonly string[],
): Promise<PlanConflictReport | null> {
  const today = mealToday()
  const loaded = await loadMealContext(supabase, householdId, {
    include: PLAN_CONFLICT_PARTS,
    today,
    planRange: { from: today, to: shiftYmd(today, PLAN_CONFLICT_HORIZON_DAYS) },
  })
  if (!loaded.ok) return null
  return buildPlanConflictReport(loaded.context, highlightExclusionIds)
}

/**
 * 「使わない食材」を登録する（アレルギー・苦手。対象: アレルゲン・食材・自由入力。
 * 対象者: 家族全体・メンバー・子ども）。どちらの理由も必須除外として世帯の全員に効く。
 *
 * 登録の後、今日以降の献立との重なりを計算して返す（**献立は書き換えない**。選び直すのは利用者）。
 * 同じ内容の除外が別の ID で登録済みなら `conflict`（その行を返す。二重に登録しない）。
 */
export async function saveFoodExclusion(
  request: SaveFoodExclusionRequest,
): Promise<ChoreSaveResult<FoodExclusionSaveSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = saveFoodExclusionIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const context = auth.context
  const { supabase, userId } = context

  // 新しく登録できるのは、今のカタログに在る品目だけ（未知の ID は判定に使えない）
  const lookup = getMealLookup()
  const { target } = request
  if (target.kind === "allergen" && !lookup.allergens.some((allergen) => allergen.id === target.allergenId)) {
    return rejectedResult("選んだ品目がアレルゲンの一覧にありません。選び直してください。")
  }
  if (target.kind === "ingredient" && !lookup.index.byId.has(target.ingredientId)) {
    return rejectedResult("選んだ食材が食材の一覧にありません。選び直すか、名前を自由に入力してください。")
  }

  const saved = await settleMealAction("save_food_exclusion", userId, async () => {
    const { data, error } = await supabase.rpc(
      "save_food_exclusion",
      foodExclusionToRpcArgs(request.id, { reason: request.reason, target, subject: request.subject }),
    )
    if (error) {
      logSupabaseErrorRedacted("meals", "save_food_exclusion failed", error, { userId })
      return mealFailureOf(error, {
        forbidden: "この設定を登録できません。世帯にいない人・子どもは対象にできません。再読み込みして確認してください。",
      })
    }
    const outcome = parseRpcOutcome(data, "exclusion")
    const mapped = outcome ? foodExclusionFromRow(outcome.entity) : null
    if (!outcome || !mapped || !mapped.ok) return unknownResult()
    // saved / replayed は要求の行そのもの。conflict は同じ内容の登録済みの行（別の ID）
    if (outcome.status !== "conflict" && mapped.value.id !== request.id) return unknownResult()
    return { status: outcome.status, exclusion: mapped.value }
  })
  if ("failure" in saved) return saved

  revalidateMeals()
  // 保存は成立している。重なりの計算の失敗で、保存を失敗と言い換えない
  const planConflicts = await loadPlanConflicts(context, [saved.exclusion.id]).catch(() => null)
  // 保存された除外が何に解決したか。判定できない入力（何も外せていない）を「登録した = 外れる」と見せない
  const resolution = buildExclusionResolutionView(saved.exclusion, lookup)
  return { ...saved, planConflicts, resolution }
}

/**
 * 「使わない食材」を削除する。正規メンバーなら誰でも削除できる（登録と同じ）。
 * 削除の後、残っている除外と今日以降の献立との重なりを返す。
 */
export async function deleteFoodExclusion(
  request: DeleteFoodExclusionRequest,
): Promise<ChoreSaveResult<FoodExclusionDeleteSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = idOnlyIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const context = auth.context
  const { supabase, userId } = context

  const deleted = await settleMealAction("delete_food_exclusion", userId, async () => {
    const { data, error } = await supabase.rpc("delete_food_exclusion", { p_id: request.id })
    if (error) {
      logSupabaseErrorRedacted("meals", "delete_food_exclusion failed", error, { userId })
      return mealFailureOf(error)
    }
    return deleteOutcome(data, request.id)
  })
  if ("failure" in deleted) return deleted

  const planConflicts = await loadPlanConflicts(context, []).catch(() => null)
  return { ...deleted, planConflicts }
}

/**
 * 好み（採点にだけ使う。必須除外ではない）を登録・変更する。
 *
 * - `scope: "household"` … 家族共通として明示した好み。正規メンバーなら誰でも変更できる。
 * - `scope: "personal"` … 個人の好み。**持ち主は常に呼び手**（要求に持ち主の項目は無く、DB が
 *   `auth.uid()` に固定する）。ほかの家族の個人の好みは DB が拒む。
 * - 同じ対象の好みが別の ID で登録済み・家族が先に変えていた → `conflict`（上書きしない）。
 */
export async function saveFoodPreference(
  request: SaveFoodPreferenceRequest,
): Promise<ChoreSaveResult<FoodPreferenceSaveSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = saveFoodPreferenceIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  const lookup = getMealLookup()
  const { target } = request
  const known =
    target.kind === "recipe"
      ? lookup.recipeById.has(target.id)
      : target.kind === "ingredient"
        ? lookup.index.byId.has(target.id)
        : getRecipeTagLabel(target.id) !== undefined
  if (!known) return rejectedResult("選んだ対象が一覧にありません。選び直してください。")

  return settleMealAction("save_food_preference", userId, async () => {
    const { data, error } = await supabase.rpc(
      "save_food_preference",
      foodPreferenceToRpcArgs(request.id, request.version, {
        scope: request.scope,
        target,
        sentiment: request.sentiment,
      }),
    )
    if (error) {
      logSupabaseErrorRedacted("meals", "save_food_preference failed", error, { userId })
      return mealFailureOf(error, { forbidden: "ほかの家族の個人の好みは変更できません。" })
    }
    const outcome = parseRpcOutcome(data, "preference")
    if (!outcome) return unknownResult()
    if (isDeletedEntity(outcome.entity)) {
      if (outcome.status !== "conflict" || outcome.entity.id !== request.id) return unknownResult()
      revalidateMeals()
      return { status: "conflict", preference: null, deleted: true }
    }
    const mapped = foodPreferenceFromRow(outcome.entity)
    if (!mapped.ok) return unknownResult()
    if (outcome.status !== "conflict" && mapped.value.id !== request.id) return unknownResult()
    revalidateMeals()
    return { status: outcome.status, preference: mapped.value, deleted: false }
  })
}

/**
 * 好みを削除する。家族共通の好みは正規メンバーなら誰でも、個人の好みは本人だけ（DB が拒む）。
 * 削除した好みは次の提案・献立の採点に使われない（採点は毎回 DB の行から計算する）。
 */
export async function deleteFoodPreference(
  request: DeleteFoodPreferenceRequest,
): Promise<ChoreSaveResult<MealDeleteSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = idOnlyIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  return settleMealAction("delete_food_preference", userId, async () => {
    const { data, error } = await supabase.rpc("delete_food_preference", { p_id: request.id })
    if (error) {
      logSupabaseErrorRedacted("meals", "delete_food_preference failed", error, { userId })
      return mealFailureOf(error, { forbidden: "ほかの家族の個人の好みは削除できません。" })
    }
    return deleteOutcome(data, request.id)
  })
}

/**
 * 「覚えた好み」（食後の評価 1 件）を削除する。評価は本人のもので、削除できるのも本人だけ（DB が拒む）。
 * 削除した評価は次の提案・献立の採点にも、「前回好評」などの理由にも使われない。
 */
export async function deleteDishFeedback(
  request: DeleteDishFeedbackRequest,
): Promise<ChoreSaveResult<MealDeleteSuccess>> {
  const auth = await getAuthContext()
  if (auth.error !== null) return rejectedResult(auth.error)
  const issue = idOnlyIssue(request)
  if (issue !== null) return rejectedResult(SETTINGS_INPUT_MESSAGES[issue])
  const { supabase, userId } = auth.context

  return settleMealAction("delete_dish_feedback", userId, async () => {
    const { data, error } = await supabase.rpc("delete_dish_feedback", { p_id: request.id })
    if (error) {
      logSupabaseErrorRedacted("meals", "delete_dish_feedback failed", error, { userId })
      return mealFailureOf(error, { forbidden: "ほかの家族の評価は削除できません。" })
    }
    return deleteOutcome(data, request.id)
  })
}
