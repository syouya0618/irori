/**
 * スケジュールの曜日詳細に必要な材料表示をサーバーで組み立てる。
 * 食材辞書やレシピ全集をクライアントへ送らない。自動引当をここで再計算しない。
 */
import type { PlanPageExtras } from "@/components/chores/meals/plan/plan-types"
import type { DinnerPlanView } from "./plan-views"
import { formatQuantityJa } from "./format"
import { getMealLookup } from "./context"

export interface ScheduleIngredient {
  name: string
  quantityText: string
  optional: boolean
}

export interface ScheduleDishDetail {
  /** カタログの分量が何人分の目安か。手動料理・不明なレシピはnull。 */
  recipeServings: number | null
  ingredients: ScheduleIngredient[]
}

export type ScheduleDishDetails = Record<string, ScheduleDishDetail>

export function buildScheduleDishDetails(view: DinnerPlanView, extras: PlanPageExtras): ScheduleDishDetails {
  const lookup = getMealLookup()
  const result: ScheduleDishDetails = {}
  for (const day of view.days) {
    for (const entry of day.entries) {
      const recipe = entry.recipeId === null ? null : lookup.recipeById.get(entry.recipeId)
      if (recipe !== undefined && recipe !== null) {
        result[entry.id] = {
          recipeServings: recipe.servings,
          ingredients: recipe.ingredients.map((ingredient) => ({
            name: lookup.index.byId.get(ingredient.ingredientId)?.name ?? "未登録の食材",
            quantityText: formatQuantityJa(ingredient.quantity),
            optional: ingredient.optional === true,
          })),
        }
      } else {
        const custom = extras.customByEntry[entry.id] ?? []
        result[entry.id] = {
          recipeServings: null,
          ingredients: custom.map((ingredient) => ({
            name: ingredient.name,
            quantityText: formatQuantityJa({ amount: ingredient.amount, unit: ingredient.unit }),
            optional: ingredient.optional,
          })),
        }
      }
    }
  }
  return result
}
