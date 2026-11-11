/**
 * 「使わない食材」の自由入力が何に解決するかを、設定画面で**登録の前に**確かめるための語彙。
 *
 * 境界指令を持たない中立モジュール（Server Component が `buildExclusionLexicon` で作り、Client Component が
 * `previewExclusionLabel` で引く）。食材辞書・レシピのカタログそのものは import しない — 画面の bundle へ
 * カタログ（材料・手順）を載せないため、判定（`resolveExclusionLabel`）が読む項目だけを page から渡す。
 *
 * ## 判定はサーバーと同じ関数
 * ここで判定の規則を書き直さない。`src/lib/meals/exclusions.ts` の `resolveExclusionLabel` に、項目を
 * 絞ったカタログを渡すだけ。絞ったカタログと実カタログで結果が一致することは、テストで固定する
 * （`resolveExclusionLabel` が読む項目が増えたら、そのテストが落ちる）。
 */

import { resolveExclusionLabel, type ExclusionResolution } from "@/lib/meals/exclusions"
import { toCatalogView, type CatalogView } from "@/lib/meals/lookup"
import type { AllergenDef, ExclusionReason, IngredientDef, RecipeDef } from "@/lib/meals/types"

/**
 * 判定（自由入力の解決）が読む食材の項目: 名前・別名・売場・アレルゲン・総称か（「〜類」の解決に使う）。
 * 由来（`derivedFrom` 等）は、解決した後の「どの料理を外すか」で使う項目で、解決そのものは読まない。
 */
export type LexiconIngredient = Pick<
  IngredientDef,
  "id" | "name" | "aliases" | "section" | "allergens" | "allergenInfo" | "generic"
>

export interface ExclusionLexicon {
  ingredients: LexiconIngredient[]
  /** 料理名の一致（「名前で判定」）に使う。材料・手順は載せない。 */
  recipes: { id: string; title: string }[]
  allergens: AllergenDef[]
}

/** カタログの索引から、判定が読む項目だけを取り出す（素の object。Client Component の props へ渡せる）。 */
export function buildExclusionLexicon(lookup: Pick<CatalogView, "index" | "recipes" | "allergens">): ExclusionLexicon {
  return {
    ingredients: [...lookup.index.byId.values()].map((def) => ({
      id: def.id,
      name: def.name,
      aliases: [...def.aliases],
      section: def.section,
      allergens: [...def.allergens],
      allergenInfo: def.allergenInfo,
      ...(def.generic === true ? { generic: true } : {}),
    })),
    recipes: lookup.recipes.map((recipe) => ({ id: recipe.id, title: recipe.title })),
    allergens: lookup.allergens.map((allergen) => ({ id: allergen.id, name: allergen.name, tier: allergen.tier })),
  }
}

/** 語彙から、判定に渡すカタログの索引を作る（1 度だけ作って使い回す）。 */
export function lexiconCatalog(lexicon: ExclusionLexicon): CatalogView {
  // 判定が料理について読むのは ID と料理名だけ。残りは型を満たすための空の値
  const recipes: RecipeDef[] = lexicon.recipes.map((recipe) => ({
    id: recipe.id,
    version: 0,
    title: recipe.title,
    role: "main",
    servings: 1,
    minutes: 0,
    ingredients: [],
    steps: [],
    tags: [],
    allergenStatus: "from_ingredients",
    source: { kind: "irori_original", note: "" },
  }))
  return toCatalogView({ ingredients: lexicon.ingredients, recipes, allergens: lexicon.allergens })
}

/** 自由入力が何に解決するか（登録の前の確認。サーバーの判定と同じ関数）。 */
export function previewExclusionLabel(label: string, reason: ExclusionReason, catalog: CatalogView): ExclusionResolution {
  return resolveExclusionLabel(label, reason, catalog)
}

/** 画面に出す、解決の結果の説明。 */
export interface ExclusionPreviewText {
  /**
   * `resolved` = 一覧と照合できた / `name_only` = 名前の一致でだけ外す /
   * `holds` = 判定できないアレルギー（全料理が未確認になり、献立を確定できなくなる。自動でも手でも） /
   * `no_effect` = 判定できない苦手（何も外さない）。
   */
  kind: "resolved" | "name_only" | "holds" | "no_effect"
  /** 判定できない入力に共通の 1 文（`holds` / `no_effect` のときだけ）。 */
  lead: string | null
  /** その入力を登録すると、どうなるか。 */
  effect: string
}

/** 判定できない入力に出す文（入力中・登録の後・登録済みの一覧で同じ文を使う）。 */
export const EXCLUSION_UNDETERMINED_LEAD = "この入力は自動では判定できません。一覧から選ぶか、食材名で登録してください。"
export const EXCLUSION_HOLDS_EFFECT =
  "登録すると、全料理が原材料の確認待ちになり、献立を確定できなくなります。"
export const EXCLUSION_NO_EFFECT = "この入力では何も除外されません。"

const NAMES_PREVIEW = 4

function namesText(names: string[]): string {
  const shown = names.slice(0, NAMES_PREVIEW).map((name) => `「${name}」`).join("")
  return names.length > NAMES_PREVIEW ? `${shown}ほか${names.length - NAMES_PREVIEW}件` : shown
}

/**
 * 解決の結果を、利用者向けの文にする。「必ず外します」と言うのは、一覧と照合できたときだけ。
 * 名前の一致でだけ外すときは、その限界を言う。判定できないときは、何が起きるかを正直に言う。
 */
export function describeExclusionPreview(resolution: ExclusionResolution, lexicon: ExclusionLexicon): ExclusionPreviewText {
  if (resolution.effect === "holds_auto_confirm") {
    return { kind: "holds", lead: EXCLUSION_UNDETERMINED_LEAD, effect: EXCLUSION_HOLDS_EFFECT }
  }
  if (resolution.effect === "no_effect") {
    return { kind: "no_effect", lead: EXCLUSION_UNDETERMINED_LEAD, effect: EXCLUSION_NO_EFFECT }
  }
  if (resolution.status === "resolved") {
    const allergenNames = resolution.allergenIds.map(
      (id) => lexicon.allergens.find((allergen) => allergen.id === id)?.name ?? id,
    )
    const ingredientNames = resolution.ingredientIds.map(
      (id) => lexicon.ingredients.find((ingredient) => ingredient.id === id)?.name ?? id,
    )
    const names = [...new Set([...allergenNames, ...ingredientNames])]
    return {
      kind: "resolved",
      lead: null,
      effect: `食材の一覧の${namesText(names)}として扱い、これを使う料理を献立と提案から外します。`,
    }
  }
  const ingredientCount = resolution.nameMatchedIngredientIds.length
  const recipeCount = resolution.nameMatchedRecipeIds.length
  const parts = [
    ...(ingredientCount > 0 ? [`食材 ${ingredientCount} 件`] : []),
    ...(recipeCount > 0 ? [`料理 ${recipeCount} 件`] : []),
  ]
  return {
    kind: "name_only",
    lead: null,
    effect: `食材の一覧にない名前のため、食材や料理の名前に含まれるかどうかで判定します（名前に入力を含む${parts.join("・")}を外します）。`,
  }
}

/** 登録済みの一覧で、判定できない除外に添える文（登録の後なので「登録すると」とは言わない）。 */
export const EXCLUSION_REGISTERED_TEXTS = {
  holds:
    "この登録は自動では判定できていません。この登録がある間、全料理が原材料の確認待ちになり、献立を確定できません。一覧から選ぶか、食材名で登録し直してください。",
  no_effect:
    "この登録は自動では判定できていません。この登録では何も除外されていません。一覧から選ぶか、食材名で登録し直してください。",
} as const
