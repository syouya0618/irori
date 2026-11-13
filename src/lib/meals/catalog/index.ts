/**
 * ごはんカタログの入口（食材辞書・レシピ・アレルゲン一覧・売場・子ども向け案内）。
 *
 * 境界指令を持たない中立モジュール。データはコード同梱で、DB へ seed しない。
 * カタログは大きいので、育児トップなど無関係な画面の bundle に載せないこと
 * （計算は Server Component / Server Action で行う）。
 *
 * 引き当ては ID の完全一致だけ。未知の ID（古い献立に残ったレシピ ID など）は
 * undefined を返すので、呼び出し側で表示を退化させる（落とさない）。
 */
import type {
  AllergenDef,
  DishRole,
  IngredientDef,
  RecipeDef,
} from "@/lib/meals/types"
import { ALLERGENS } from "@/lib/meals/catalog/allergens"
import { INGREDIENTS } from "@/lib/meals/catalog/ingredients"
import { RECIPES } from "@/lib/meals/catalog/recipes"

export * from "@/lib/meals/catalog/allergens"
export * from "@/lib/meals/catalog/child-guidance"
export * from "@/lib/meals/catalog/ingredients"
export * from "@/lib/meals/catalog/recipes"
export * from "@/lib/meals/catalog/sections"
export * from "@/lib/meals/catalog/tags"

export const ALLERGEN_BY_ID: ReadonlyMap<string, AllergenDef> = new Map(
  ALLERGENS.map((a) => [a.id, a]),
)

export const INGREDIENT_BY_ID: ReadonlyMap<string, IngredientDef> = new Map(
  INGREDIENTS.map((i) => [i.id, i]),
)

export const RECIPE_BY_ID: ReadonlyMap<string, RecipeDef> = new Map(
  RECIPES.map((r) => [r.id, r]),
)

export function getAllergen(id: string): AllergenDef | undefined {
  return ALLERGEN_BY_ID.get(id)
}

export function getIngredient(id: string): IngredientDef | undefined {
  return INGREDIENT_BY_ID.get(id)
}

export function getRecipe(id: string): RecipeDef | undefined {
  return RECIPE_BY_ID.get(id)
}

/** 料理区分の並び順（献立の表示順）。 */
export const DISH_ROLES: readonly DishRole[] = ["main", "side", "soup", "staple"]

export const DISH_ROLE_LABELS: Readonly<Record<DishRole, string>> = {
  main: "主菜",
  side: "副菜",
  soup: "汁物",
  staple: "主食",
}

/** 料理区分ごとのレシピ一覧（カタログの記載順）。 */
export const RECIPES_BY_ROLE: Readonly<Record<DishRole, readonly RecipeDef[]>> = {
  main: RECIPES.filter((r) => r.role === "main"),
  side: RECIPES.filter((r) => r.role === "side"),
  soup: RECIPES.filter((r) => r.role === "soup"),
  staple: RECIPES.filter((r) => r.role === "staple"),
}

/** 未知の区分（DB に残った古い値など）には空の一覧を返す。 */
export function listRecipesByRole(role: string): readonly RecipeDef[] {
  return RECIPES.filter((r) => r.role === role)
}

/** 取り分け案内（2 歳以降の幼児向け）を持つレシピ。 */
export const CHILD_SERVING_RECIPES: readonly RecipeDef[] = RECIPES.filter(
  (r) => r.childServing !== undefined,
)

/** 常備品の候補として提示してよい食材（提示だけ。自動登録はしない）。 */
export const STAPLE_CANDIDATE_INGREDIENTS: readonly IngredientDef[] =
  INGREDIENTS.filter((i) => i.stapleCandidate === true)
