/**
 * ごはんの純粋ロジック用の小さな fixture（実カタログではない）。
 * 実カタログとの統合テストは別に持つ。ここは規則を固定するための最小の辞書とレシピ。
 */

import { toCatalogView } from "../lookup"
import type {
  AllergenDef,
  ChildServingGuide,
  DishRole,
  ExclusionReason,
  ExclusionTarget,
  FoodExclusion,
  IngredientDef,
  PantryItem,
  PlanEntry,
  Quantity,
  RecipeDef,
  RecipeIngredient,
  StoreSection,
  UnitId,
} from "../types"

export const TODAY = "2026-11-11"

export function q(amount: number | null, unit: UnitId): Quantity {
  return { amount, unit }
}

export function ing(ingredientId: string, amount: number | null, unit: UnitId, optional = false): RecipeIngredient {
  return optional ? { ingredientId, quantity: q(amount, unit), optional: true } : { ingredientId, quantity: q(amount, unit) }
}

function def(
  id: string,
  name: string,
  section: StoreSection,
  extra: Partial<IngredientDef> = {},
): IngredientDef {
  return { id, name, aliases: [], section, allergens: [], allergenInfo: "known", ...extra }
}

export const ALLERGENS: readonly AllergenDef[] = [
  { id: "egg", name: "卵", tier: "mandatory" },
  { id: "milk", name: "乳", tier: "mandatory" },
  { id: "wheat", name: "小麦", tier: "mandatory" },
  { id: "shrimp", name: "えび", tier: "mandatory" },
  { id: "peanut", name: "落花生（ピーナッツ）", tier: "mandatory" },
  { id: "soybean", name: "大豆", tier: "recommended" },
  { id: "pork", name: "豚肉", tier: "recommended" },
  { id: "chicken", name: "鶏肉", tier: "recommended" },
  { id: "salmon", name: "さけ", tier: "recommended" },
]

export const INGREDIENTS: readonly IngredientDef[] = [
  def("pork", "豚肉", "meat", { aliases: ["ぶた肉", "豚こま"], allergens: ["pork"] }),
  def("pork_belly", "豚バラ", "meat", { aliases: ["豚ばら肉"], allergens: ["pork"], derivedFrom: ["pork"] }),
  def("tonkotsu", "豚骨", "meat", { allergens: ["pork"], derivedFrom: ["pork"] }),
  def("bacon", "ベーコン", "meat", { allergens: ["pork"], derivedFrom: ["pork"] }),
  def("chicken_thigh", "鶏もも肉", "meat", { aliases: ["鶏もも", "とりもも肉"], allergens: ["chicken"] }),
  def("salmon", "鮭", "fish", { aliases: ["さけ", "サーモン"], allergens: ["salmon"] }),
  def("tuna", "まぐろ", "fish", { aliases: ["マグロ", "鮪"] }),
  def("tuna_can", "ツナ缶", "fish", { aliases: ["ツナ"], derivedFrom: ["tuna"] }),
  def("shrimp", "えび", "fish", { aliases: ["海老"], allergens: ["shrimp"] }),
  def("egg", "卵", "egg_dairy", { aliases: ["たまご", "玉子"], allergens: ["egg"] }),
  def("mayonnaise", "マヨネーズ", "seasoning", { allergens: ["egg"], derivedFrom: ["egg"] }),
  def("milk", "牛乳", "egg_dairy", { aliases: ["ぎゅうにゅう"], allergens: ["milk"] }),
  def("butter", "バター", "egg_dairy", { allergens: ["milk"], derivedFrom: ["milk"] }),
  def("soybean", "大豆", "soy", { allergens: ["soybean"] }),
  def("tofu", "豆腐", "soy", { aliases: ["とうふ"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("miso", "みそ", "seasoning", { aliases: ["味噌"], allergens: ["soybean"], derivedFrom: ["soybean"] }),
  def("soy_sauce", "しょうゆ", "seasoning", {
    aliases: ["醤油"],
    allergens: ["wheat", "soybean"],
    derivedFrom: ["soybean"],
    stapleCandidate: true,
  }),
  def("curry_roux", "カレールウ", "seasoning", { aliases: ["カレールー"], allergens: ["wheat"], allergenInfo: "varies" }),
  def("onion", "玉ねぎ", "vegetable", { aliases: ["たまねぎ", "玉葱"] }),
  def("negi", "ねぎ", "vegetable", { aliases: ["長ねぎ"] }),
  def("carrot", "にんじん", "vegetable", { aliases: ["人参"] }),
  def("potato", "じゃがいも", "vegetable"),
  def("cabbage", "キャベツ", "vegetable"),
  def("spinach", "ほうれん草", "vegetable", { aliases: ["ほうれんそう"] }),
  def("tomato", "トマト", "vegetable"),
  def("rice", "米", "staple", { aliases: ["ご飯", "ごはん"] }),
  def("salt", "塩", "seasoning", { stapleCandidate: true }),
  def("oil", "サラダ油", "seasoning", { aliases: ["油"], stapleCandidate: true }),
  def("honey", "はちみつ", "seasoning", {
    aliases: ["蜂蜜"],
    ageRule: { minAgeMonths: 12, sourceId: "mhlw-honey" },
  }),
  def("honey_mustard", "ハニーマスタード", "seasoning", { derivedFrom: ["honey"] }),
]

export const TODDLER_GUIDE: ChildServingGuide = {
  stage: "toddler_2y_plus",
  minAgeMonths: 24,
  separateBeforeStep: 1,
  instructions: ["たれを絡める前に取り分ける"],
  cautions: ["食べやすい大きさに切る"],
  sourceIds: ["caa-choking-2021"],
}

function recipe(
  id: string,
  title: string,
  role: DishRole,
  minutes: number,
  tags: string[],
  ingredients: RecipeIngredient[],
  extra: Partial<RecipeDef> = {},
): RecipeDef {
  return {
    id,
    version: 1,
    title,
    role,
    servings: 2,
    minutes,
    ingredients,
    steps: ["下ごしらえをする", "加熱して味をととのえる"],
    tags,
    allergenStatus: "from_ingredients",
    source: { kind: "irori_original", note: "test fixture" },
    ...extra,
  }
}

export const RECIPES: readonly RecipeDef[] = [
  recipe("pork_ginger", "豚の生姜焼き風", "main", 15, ["pork", "japanese", "quick"], [
    ing("pork", 200, "g"),
    ing("onion", 0.5, "piece"),
    ing("soy_sauce", 1, "tbsp"),
    ing("oil", 1, "tsp"),
  ]),
  recipe("chicken_teriyaki", "鶏の照り焼き", "main", 20, ["chicken", "japanese"], [
    ing("chicken_thigh", 250, "g"),
    ing("soy_sauce", 2, "tbsp"),
    ing("oil", 1, "tsp"),
  ], { childServing: TODDLER_GUIDE }),
  recipe("salmon_grill", "鮭の塩焼き", "main", 15, ["fish", "japanese", "quick"], [
    ing("salmon", 2, "slice"),
    ing("salt", null, "pinch"),
  ]),
  recipe("pork_curry", "ポークカレー", "main", 40, ["pork", "curry"], [
    ing("pork", 200, "g"),
    ing("onion", 1, "piece"),
    ing("carrot", 1, "piece"),
    ing("potato", 2, "piece"),
    ing("curry_roux", 4, "piece"),
    ing("rice", 2, "bowl"),
  ], { includesStaple: true }),
  recipe("tofu_steak", "豆腐ステーキ", "main", 15, ["tofu", "quick"], [
    ing("tofu", 1, "block"),
    ing("soy_sauce", 1, "tbsp"),
    ing("oil", 1, "tsp"),
  ]),
  recipe("oyakodon", "親子丼", "main", 20, ["chicken", "donburi"], [
    ing("chicken_thigh", 150, "g"),
    ing("egg", 2, "piece"),
    ing("onion", 0.5, "piece"),
    ing("soy_sauce", 2, "tbsp"),
    ing("rice", 2, "bowl"),
  ], { includesStaple: true }),
  recipe("shrimp_egg", "えびと卵の炒め", "main", 15, ["seafood", "chinese"], [
    ing("shrimp", 150, "g"),
    ing("egg", 2, "piece"),
    ing("oil", 2, "tsp"),
  ]),
  recipe("honey_chicken", "はちみつチキン", "main", 25, ["chicken"], [
    ing("chicken_thigh", 250, "g"),
    ing("honey", 1, "tbsp"),
    ing("soy_sauce", 1, "tbsp"),
  ], { childServing: TODDLER_GUIDE }),
  recipe("pork_belly_cabbage", "豚バラとキャベツの炒め", "main", 15, ["pork", "quick"], [
    ing("pork_belly", 150, "g"),
    ing("cabbage", 200, "g"),
    ing("salt", null, "pinch"),
    ing("oil", 1, "tsp"),
  ]),
  recipe("spinach_ohitashi", "ほうれん草のおひたし", "side", 10, ["vegetable", "japanese"], [
    ing("spinach", 1, "bunch"),
    ing("soy_sauce", 1, "tsp"),
  ]),
  recipe("cabbage_salad", "キャベツの塩もみ", "side", 5, ["vegetable", "quick"], [
    ing("cabbage", 200, "g"),
    ing("salt", null, "pinch"),
  ]),
  recipe("tomato_salad", "トマトサラダ", "side", 5, ["vegetable", "quick"], [
    ing("tomato", 2, "piece"),
    ing("oil", 1, "tsp"),
    ing("salt", null, "pinch"),
  ]),
  recipe("carrot_kinpira", "にんじんのきんぴら", "side", 10, ["vegetable", "japanese"], [
    ing("carrot", 1, "piece"),
    ing("soy_sauce", 2, "tsp"),
    ing("oil", 1, "tsp"),
  ]),
  recipe("potato_salad", "ポテトサラダ", "side", 20, ["vegetable"], [
    ing("potato", 2, "piece"),
    ing("mayonnaise", 2, "tbsp"),
    ing("carrot", 0.25, "piece", true),
  ]),
  recipe("egg_roll", "卵焼き", "side", 10, ["egg", "japanese"], [
    ing("egg", 2, "piece"),
    ing("salt", null, "pinch"),
    ing("oil", 1, "tsp"),
  ]),
  recipe("bacon_cabbage", "ベーコンとキャベツの蒸し煮", "side", 10, ["vegetable"], [
    ing("bacon", 2, "slice"),
    ing("cabbage", 150, "g"),
  ]),
  recipe("hiyayakko", "冷ややっこ", "side", 5, ["tofu", "quick"], [
    ing("tofu", 0.5, "block"),
    ing("soy_sauce", 1, "tsp"),
    ing("negi", 0.25, "stalk", true),
  ]),
  recipe("rice_plain", "ご飯", "staple", 45, ["rice"], [ing("rice", 2, "bowl")]),
  recipe("miso_soup", "豆腐のみそ汁", "soup", 10, ["japanese"], [
    ing("miso", 2, "tbsp"),
    ing("tofu", 0.5, "block"),
    ing("negi", 0.25, "stalk", true),
  ]),
]

export const CATALOG = toCatalogView({ ingredients: INGREDIENTS, recipes: RECIPES, allergens: ALLERGENS })

export function recipeById(id: string): RecipeDef {
  const found = RECIPES.find((r) => r.id === id)
  if (!found) throw new Error(`fixture recipe not found: ${id}`)
  return found
}

let pantrySeq = 0

/** 在庫 1 件。既定は「ある・数量不明・今日確認・冷蔵」。 */
export function stock(ingredientId: string | null, overrides: Partial<PantryItem> = {}): PantryItem {
  pantrySeq += 1
  return {
    id: overrides.id ?? `p-${ingredientId ?? "unresolved"}-${pantrySeq}`,
    ingredientId,
    name: ingredientId ?? "名前のままの在庫",
    quantity: null,
    status: "have",
    useSoon: false,
    storage: "fridge",
    expiresOn: null,
    confirmedOn: TODAY,
    ...overrides,
  }
}

export function exclusion(
  id: string,
  reason: ExclusionReason,
  target: ExclusionTarget,
  subject: FoodExclusion["subject"] = { kind: "household" },
): FoodExclusion {
  return { id, reason, target, subject }
}

export function planEntry(overrides: Partial<PlanEntry> & Pick<PlanEntry, "id" | "date">): PlanEntry {
  return {
    role: "main",
    position: 0,
    recipeId: null,
    recipeVersion: null,
    customTitle: null,
    customIngredients: null,
    servings: 2,
    pinned: false,
    status: "confirmed",
    origin: "auto",
    ...overrides,
    ...(overrides.recipeId && overrides.recipeVersion === undefined ? { recipeVersion: 1 } : {}),
  }
}

/** 調味料を常備品にした世帯（未登録の調味料で全部が「買い足し」にならないようにする）。 */
export const STAPLES: readonly string[] = ["soy_sauce", "salt", "oil"]
