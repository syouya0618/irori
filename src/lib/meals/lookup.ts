/**
 * カタログ（食材辞書・レシピ・アレルゲン一覧）を引数で受け取るための共通の入れ物と、
 * 派生関係（`derivedFrom`）をたどる小さな関数。
 *
 * データは持たない。実カタログは `src/lib/meals/catalog/`、テストは自前の fixture を渡す。
 */

import { DEFAULT_EXCLUSION_TERMS, type ExclusionTermDef } from "./exclusion-terms"
import {
  buildIngredientIndex,
  type IngredientDict,
  type IngredientIndex,
  toIngredientIndex,
} from "./normalize"
import type { AllergenDef, AllergenId, IngredientDef, RecipeDef } from "./types"

export interface MealCatalog {
  ingredients: IngredientDict
  recipes: readonly RecipeDef[]
  /** 自由入力の除外をアレルゲン名へ解決するときに使う。無ければ解決しない。 */
  allergens?: readonly AllergenDef[]
  /**
   * 自由入力の除外の、総称・類義の語（「乳製品」「甲殻類」「魚」…）。
   * 省略時は既定の辞書（`DEFAULT_EXCLUSION_TERMS`）。このカタログに無い ID を指す語は使われない。
   */
  exclusionTerms?: readonly ExclusionTermDef[]
}

export interface CatalogView {
  readonly kind: "catalog-view"
  readonly index: IngredientIndex
  readonly recipes: readonly RecipeDef[]
  readonly recipeById: ReadonlyMap<string, RecipeDef>
  readonly allergens: readonly AllergenDef[]
  readonly exclusionTerms: readonly ExclusionTermDef[]
}

export type CatalogInput = MealCatalog | CatalogView

function isView(catalog: CatalogInput): catalog is CatalogView {
  return (catalog as CatalogView).kind === "catalog-view"
}

/** 繰り返し使うときは一度だけ作って渡す（同じ ID のレシピは先頭を採る）。 */
export function toCatalogView(catalog: CatalogInput): CatalogView {
  if (isView(catalog)) return catalog
  const recipeById = new Map<string, RecipeDef>()
  for (const recipe of catalog.recipes) {
    if (!recipeById.has(recipe.id)) recipeById.set(recipe.id, recipe)
  }
  return {
    kind: "catalog-view",
    index: toIngredientIndex(catalog.ingredients),
    recipes: [...recipeById.values()],
    recipeById,
    allergens: catalog.allergens ?? [],
    exclusionTerms: catalog.exclusionTerms ?? DEFAULT_EXCLUSION_TERMS,
  }
}

export function emptyIngredientIndex(): IngredientIndex {
  return buildIngredientIndex([])
}

/** 表示名。辞書に無い ID はそのまま返す（落とさない）。 */
export function ingredientNameOf(ingredientId: string, index: IngredientIndex): string {
  return index.byId.get(ingredientId)?.name ?? ingredientId
}

export interface Lineage {
  /** 自分自身を含まない、由来する食材の ID（推移的）。 */
  ancestors: readonly string[]
  /** 自分または由来のどこかが辞書に無い（= 成分を確かめられない）。 */
  hasUnknown: boolean
}

export interface LineageOptions {
  /**
   * 精製品の由来（`refinedFrom`。片栗粉 → じゃがいも）もたどる。
   * アレルギーの除外を広く及ぼすときだけ true にする。苦手・好み・アレルゲンの集計では使わない。
   */
  includeRefined?: boolean
}

function parentsOf(def: IngredientDef | undefined, options: LineageOptions): readonly string[] {
  if (!def) return []
  return options.includeRefined === true
    ? [...(def.derivedFrom ?? []), ...(def.refinedFrom ?? [])]
    : (def.derivedFrom ?? [])
}

/** `derivedFrom` を推移的にたどる。循環しても止まる。 */
export function lineageOf(ingredientId: string, index: IngredientIndex, options: LineageOptions = {}): Lineage {
  const ancestors: string[] = []
  const seen = new Set<string>([ingredientId])
  let hasUnknown = !index.byId.has(ingredientId)
  const queue: string[] = [...parentsOf(index.byId.get(ingredientId), options)]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (seen.has(current)) continue
    seen.add(current)
    ancestors.push(current)
    const def = index.byId.get(current)
    if (!def) {
      hasUnknown = true
      continue
    }
    queue.push(...parentsOf(def, options))
  }
  return { ancestors, hasUnknown }
}

export interface AllergenProfile {
  /** 自分と由来の食材が持つアレルゲンの和集合。 */
  allergens: ReadonlySet<AllergenId>
  /** 自分または由来に「商品により異なる」（varies）がある。 */
  varies: boolean
  /** 自分または由来が辞書に無く、成分を確かめられない。 */
  unknown: boolean
}

/** 食材 1 つのアレルゲン情報（派生元を含む）。 */
export function allergenProfileOf(ingredientId: string, index: IngredientIndex): AllergenProfile {
  const lineage = lineageOf(ingredientId, index)
  const allergens = new Set<AllergenId>()
  let varies = false
  for (const id of [ingredientId, ...lineage.ancestors]) {
    const def: IngredientDef | undefined = index.byId.get(id)
    if (!def) continue
    for (const allergen of def.allergens) allergens.add(allergen)
    if (def.allergenInfo === "varies") varies = true
  }
  return { allergens, varies, unknown: lineage.hasUnknown }
}

/** `targetId` 自身か、`targetId` に由来する食材か。 */
export function isSameOrDerivedFrom(
  ingredientId: string,
  targetId: string,
  index: IngredientIndex,
  options: LineageOptions = {},
): "same" | "derived" | null {
  if (ingredientId === targetId) return "same"
  return lineageOf(ingredientId, index, options).ancestors.includes(targetId) ? "derived" : null
}
