/**
 * 献立の操作の呼び名と、結果の文言（正本）。
 *
 * 境界指令を持たない中立モジュール。端末の控え（「保存できたか確認できていない操作」）に出す名前と、
 * 保存の後に画面へ出す文を、操作の内容（payload）だけから作る。
 */

import { formatMealDateShort } from "@/lib/meals/server/format"
import type { DinnerRequest, DinnerSaveSuccess, DinnerServingsRequest } from "@/lib/meals/server/plan-requests"

/** 枠 ID から料理名を引く（見つからなければ「料理」）。 */
export type DishTitleOf = (entryId: string) => string

function quoted(title: string): string {
  return `「${title === "" ? "料理" : title}」`
}

/** 端末の控えに残す名前（体言止め。80 文字以内に収まる長さ）。人数の変更（R45）を含む。 */
export function labelOfDinnerRequest(request: DinnerRequest | DinnerServingsRequest, titleOf: DishTitleOf): string {
  switch (request.op) {
    case "servings":
      return `${quoted(titleOf(request.entryId))}を${request.servings}人分に変更`
    case "servings_upcoming":
      return `これからの献立を${request.servings}人分に変更`
    case "generate":
      return `${formatMealDateShort(request.startDate)}から${request.days}日分の献立を作成`
    case "replace_day":
      return `${formatMealDateShort(request.date)}の献立を差し替え`
    case "replace_dish":
      return `${quoted(titleOf(request.entryId))}を差し替え`
    case "move":
      return `${quoted(titleOf(request.entryId))}を${formatMealDateShort(request.toDate)}へ移動`
    case "pin":
      return request.pinned
        ? `${quoted(titleOf(request.entryId))}を固定`
        : `${quoted(titleOf(request.entryId))}の固定を解除`
    case "custom_dish":
      return request.version === null ? `${quoted(request.title.trim())}を献立へ追加` : `${quoted(request.title.trim())}を変更`
    case "confirm":
      return `${formatMealDateShort(request.startDate)}からの献立を確定`
    case "cooked":
      return `${quoted(titleOf(request.entryId))}を「作った」に変更`
    case "skipped":
      return `${quoted(titleOf(request.entryId))}を「作らなかった」に変更`
    case "restore":
      return `${quoted(titleOf(request.entryId))}の記録を取り消し`
    case "delete":
      return `${quoted(titleOf(request.entryId))}を献立から外す`
    case "pantry_after_cooking":
      return `使った食材 ${request.updates.length} 件の状態を更新`
    case "feedback":
      return `${quoted(request.dishTitle.trim())}の評価を記録`
    case "add_recipe":
      return `${quoted(titleOf(request.id))}を${formatMealDateShort(request.date)}の献立へ追加`
  }
}

/** 保存が成立したとき（saved / replayed）の文。 */
export function successTextOfDinnerRequest(
  request: DinnerRequest | DinnerServingsRequest,
  result: Pick<DinnerSaveSuccess, "via" | "changedEntries">,
  titleOf: DishTitleOf,
): string {
  switch (request.op) {
    case "servings":
      return `${quoted(titleOf(request.entryId))}を${request.servings}人分にしました。買い物の量は、この人数で計算し直します。`
    case "servings_upcoming":
      // 何品を変えたかは、サーバーが数えた件数だけを言う（件数つきの文はサーバーの補足にも入る）
      return result.changedEntries === 0
        ? `これからの献立は、すでに${request.servings}人分でした。`
        : `これからの献立の人数を、${request.servings}人分にそろえました。買い物の量は、この人数で計算し直します。`
    case "generate":
      // 実際に通った経路だけを名乗る（AI を使っていない結果を「AI 補助」と言わない）
      return result.via === "ai_assisted"
        ? `${request.days}日分の献立を作りました（AI 補助で読み取った希望を使いました）。`
        : `${request.days}日分の献立を作りました（自動）。`
    case "replace_day":
      return `${formatMealDateShort(request.date)}の献立を差し替えました。`
    case "replace_dish":
      return `${quoted(titleOf(request.entryId))}を別の料理に差し替えました。`
    case "move":
      return `料理を${formatMealDateShort(request.toDate)}へ移動しました。`
    case "pin":
      return request.pinned
        ? `${quoted(titleOf(request.entryId))}を固定しました。作り直し・差し替えで変わりません。`
        : `${quoted(titleOf(request.entryId))}の固定を解除しました。`
    case "custom_dish":
      return request.version === null
        ? `${quoted(request.title.trim())}を献立へ追加しました。`
        : `${quoted(request.title.trim())}を変更しました。`
    case "confirm":
      return "献立を確定しました。確定した料理の材料を、買い物リストへ入れました。"
    case "cooked":
      return `${quoted(titleOf(request.entryId))}を「作った」にしました。食材は自動では減らしていません。`
    case "skipped":
      return `${quoted(titleOf(request.entryId))}を「作らなかった」にしました。好みの評価には使いません。`
    case "restore":
      return `${quoted(titleOf(request.entryId))}の記録を取り消し、作る前の状態へ戻しました。`
    case "delete":
      return "料理を献立から外しました。"
    case "pantry_after_cooking":
      return "選んだ食材の状態を更新しました。"
    case "feedback":
      return `${quoted(request.dishTitle.trim())}の評価を記録しました。`
    case "add_recipe":
      return `${quoted(titleOf(request.id))}を${formatMealDateShort(request.date)}の献立へ追加しました。`
  }
}

export const PLAN_CONFLICT_TEXTS = {
  stale_plan: "他の端末で献立が変更されました。上書きはしていません。最新の献立を確認してから、もう一度お試しください。",
  constraints_changed:
    "希望を読み取った後に、使わない食材の設定が変わりました。読み取った希望は適用していません。希望を入れ直してください。",
  gone: "この料理は、他の端末で既に変更・削除されています。最新の献立を確認してください。",
  row_changed: "他の端末で先に変更されていました。上書きはしていません。最新の内容を確認してください。",
  day_changed:
    "この日の献立が、他の端末で先に変わっていました。上書き・二重の追加はしていません。最新の献立を確かめてから、もう一度入れてください。",
} as const

/** conflict（上書きしていない）のときの文。内訳が無ければ献立の版の衝突として扱う。 */
export function conflictTextOfDinner(result: Pick<DinnerSaveSuccess, "detail">): string {
  const detail = result.detail ?? "stale_plan"
  return Object.prototype.hasOwnProperty.call(PLAN_CONFLICT_TEXTS, detail)
    ? PLAN_CONFLICT_TEXTS[detail]
    : PLAN_CONFLICT_TEXTS.stale_plan
}
