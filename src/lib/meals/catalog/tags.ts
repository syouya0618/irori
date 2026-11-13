/**
 * レシピのタグ（好み・希望の照合に使う語）の一覧と表示名。
 *
 * 境界指令を持たない中立モジュール。レシピの `tags` はここにある ID だけを使う
 * （カタログ検査テストで固定）。タグは並べ替えと希望の解釈にだけ使い、
 * アレルギーなどの必須除外の判定には使わない（判定は食材辞書の構造化情報で行う）。
 */

export type RecipeTagGroup = "protein" | "genre" | "style" | "method" | "trait"

export interface RecipeTagDef {
  id: string
  label: string
  group: RecipeTagGroup
}

export const RECIPE_TAGS = [
  // 主な食材
  { id: "chicken", label: "鶏肉", group: "protein" },
  { id: "pork", label: "豚肉", group: "protein" },
  { id: "beef", label: "牛肉", group: "protein" },
  { id: "ground_meat", label: "ひき肉", group: "protein" },
  { id: "fish", label: "魚", group: "protein" },
  { id: "egg", label: "卵", group: "protein" },
  { id: "tofu", label: "豆腐・大豆製品", group: "protein" },
  { id: "vegetable", label: "野菜", group: "protein" },
  // ジャンル
  { id: "japanese", label: "和食", group: "genre" },
  { id: "western", label: "洋食", group: "genre" },
  { id: "chinese", label: "中華", group: "genre" },
  // 料理の形
  { id: "curry", label: "カレー", group: "style" },
  { id: "donburi", label: "丼", group: "style" },
  { id: "noodle", label: "麺", group: "style" },
  { id: "rice", label: "ごはんもの", group: "style" },
  { id: "bread", label: "パン", group: "style" },
  { id: "soup", label: "汁物", group: "style" },
  // 調理法
  { id: "simmer", label: "煮物", group: "method" },
  { id: "stir_fry", label: "炒め物", group: "method" },
  { id: "pan_fry", label: "焼き物", group: "method" },
  { id: "deep_fry", label: "揚げ物", group: "method" },
  { id: "steam", label: "蒸し物", group: "method" },
  { id: "dressed", label: "あえ物・サラダ", group: "method" },
  // 特徴
  // `quick` は調理時間の目安が QUICK_MAX_MINUTES 分以内のレシピにだけ付ける。
  { id: "quick", label: "時短", group: "trait" },
  // `meatless` は肉・肉加工品を使わないレシピに付ける（だしのかつお節などは含みうる）。
  { id: "meatless", label: "肉を使わない", group: "trait" },
] as const satisfies readonly RecipeTagDef[]

export type RecipeTagId = (typeof RECIPE_TAGS)[number]["id"]

/** `quick` を付ける調理時間の上限（分）。 */
export const QUICK_MAX_MINUTES = 15

const TAG_BY_ID: ReadonlyMap<string, RecipeTagDef> = new Map(
  RECIPE_TAGS.map((t) => [t.id, t]),
)

/** タグの表示名。未知のタグは undefined（呼び出し側で表示を省く）。 */
export function getRecipeTagLabel(id: string): string | undefined {
  return TAG_BY_ID.get(id)?.label
}
