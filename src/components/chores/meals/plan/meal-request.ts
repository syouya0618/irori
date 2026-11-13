/**
 * ごはんの保存操作の合併型（献立・買い物・食材・設定）と、その振り分け。
 *
 * 境界指令を持たない中立モジュール（食材辞書・レシピのカタログを import しない）。
 *
 * ## なぜ全部を 1 つにまとめるか
 * `useChoreSave` は端末の控えを種類（`"meal"`）ごとに読み、渡した型ガード（`isPayload`）に通らない
 * 控えを**読めない控え**として数える。画面ごとに別の型ガードを渡すと、買い物の画面で結果不明になった
 * 操作が、献立の画面では「読み取れない控え」になって保存を塞ぎ、確かめ直す手段が無いまま破棄だけが
 * できてしまう（破棄の後に打ち直せば二重になる）。献立と買い物の画面はこの合併型を使い、どの画面で
 * 結果不明になった操作でも、開いている画面から「同じ操作で確認」できるようにする。
 *
 * 献立（`DinnerRequest`）と買い物（`GroceryRequest`）はどちらも `op: "delete"` を持つが、要求の項目
 * （`entryId` / `id`）が違い、各型ガードは余分な項目を拒むので、1 つの値が両方に通ることは無い
 * （テストで固定）。食材・設定（`MealBasicsRequest`）の `op` は重ならない名前になっている。
 */

import { saveDinnerRequest } from "@/app/(main)/chores/meals/plan/actions"
import { saveGroceryRequest } from "@/app/(main)/chores/meals/shopping/actions"
import {
  isMealBasicsRequest,
  runMealBasicsRequest,
  type MealBasicsRequest,
  type MealBasicsSuccess,
} from "@/components/chores/meals/basics/meal-basics-request"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import {
  isDinnerRequest,
  isDinnerServingsRequest,
  isGroceryRequest,
  type DinnerRequest,
  type DinnerSaveSuccess,
  type DinnerServingsRequest,
  type GroceryRequest,
  type GrocerySaveSuccess,
} from "@/lib/meals/server/plan-requests"

/**
 * 献立の画面の操作（献立の保存操作と、人数の変更）。どちらも `saveDinnerRequest` が受ける。
 * 人数の変更（`servings` / `servings_upcoming`）は `op` が献立のどの操作とも重ならない。
 */
export type PlanRequest = DinnerRequest | DinnerServingsRequest

/** 献立の画面の操作か（人数の変更を含む）。 */
export function isPlanRequest(value: unknown): value is PlanRequest {
  return isDinnerRequest(value) || isDinnerServingsRequest(value)
}

export type MealRequest = PlanRequest | GroceryRequest | MealBasicsRequest
export type MealSaveSuccess = DinnerSaveSuccess | GrocerySaveSuccess | MealBasicsSuccess

export type MealRequestArea = "dinner" | "grocery" | "basics"

/** どの画面の操作か。どれにも読めなければ null。 */
export function mealRequestArea(value: unknown): MealRequestArea | null {
  if (isPlanRequest(value)) return "dinner"
  if (isGroceryRequest(value)) return "grocery"
  if (isMealBasicsRequest(value)) return "basics"
  return null
}

/** 送る値・端末の控えから読んだ値が、そのまま送れる要求か（`useChoreSave` の `isPayload`）。 */
export function isMealRequest(value: unknown): value is MealRequest {
  return mealRequestArea(value) !== null
}

/**
 * 合併型の要求を、対応する Server Action へ送る（`useChoreSave` の `run`）。
 * 認証・入力の検証・世帯の決定はすべて Action と DB が行う。ここは振り分けるだけ。
 */
export async function runMealRequest(request: MealRequest): Promise<MealSaveSuccess | ChoreSaveFailure> {
  if (isPlanRequest(request)) return saveDinnerRequest(request)
  if (isGroceryRequest(request)) return saveGroceryRequest(request)
  if (isMealBasicsRequest(request)) return runMealBasicsRequest(request)
  return { error: "入力内容を確認してください。", failure: "rejected" }
}

/** ほかの画面の操作を、開いている画面から確かめ直したときの文（その画面の詳しい文言は持たない）。 */
export const OTHER_SCREEN_SAVE_TEXTS = {
  saved: "ほかの画面で確認できていなかった操作は、保存されていました。",
  conflict:
    "ほかの画面で確認できていなかった操作は、別の端末が先に更新していたため、上書きしていません。最新の内容を確認してください。",
} as const
