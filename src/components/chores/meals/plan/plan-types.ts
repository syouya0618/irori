/**
 * 献立の画面が、献立の表示（`DinnerPlanView`）に加えて受け取る値の型。
 *
 * 境界指令を持たない中立モジュール（型だけ）。組み立てはサーバー
 * （`src/app/(main)/chores/meals/plan/plan-page-data.ts`）が行い、Client へは表示名に直した値だけを渡す
 * （食材辞書・レシピのカタログを画面の bundle へ載せない）。
 */

import type { PantryStatus, UnitId } from "@/lib/meals/types"

/** 料理の後に状態を更新できる食材（その料理の材料に当たる、登録済みの食材）。 */
export interface CookedPantryOption {
  id: string
  /** 開いた時点の版（`updated_at` の表記のまま）。 */
  version: string
  name: string
  /** 「300g」「数量不明」。 */
  quantityText: string
  status: PantryStatus
  statusLabel: string
}

/** この料理・この日の、自分の食後評価（記録済みのとき）。 */
export interface EntryFeedbackView {
  id: string
  version: string
  taste: 1 | 2 | 3 | null
  effort: 1 | 2 | 3 | null
  again: boolean | null
  excludeFromLearning: boolean
}

/** 手動料理の材料 1 件（編集フォームの初期値）。 */
export interface CustomIngredientView {
  name: string
  /** 「適量」「少々」は null。 */
  amount: number | null
  unit: UnitId
  optional: boolean
}

export interface PlanPageExtras {
  /** 枠 ID → 料理の後に更新できる食材。今日までの日の、作らなかった以外の枠だけ。 */
  pantryByEntry: Record<string, CookedPantryOption[]>
  /** 枠 ID → 自分の食後評価。今日までの日の枠だけ。 */
  feedbackByEntry: Record<string, EntryFeedbackView>
  /** 枠 ID → 手動料理の材料（材料が未登録なら空の配列）。 */
  customByEntry: Record<string, CustomIngredientView[]>
}

export const EMPTY_PLAN_PAGE_EXTRAS: PlanPageExtras = Object.freeze({
  pantryByEntry: Object.freeze({}),
  feedbackByEntry: Object.freeze({}),
  customByEntry: Object.freeze({}),
}) as PlanPageExtras
