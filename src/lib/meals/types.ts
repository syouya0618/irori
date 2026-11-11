/**
 * ごはん（献立・在庫提案・買い物）の共有型。
 *
 * 境界指令を持たない中立モジュール（Server / Client どちらからも型 import 可）。
 * ここは「契約」だけを置く。データ（食材辞書・レシピ・アレルゲン一覧・取り分け案内）は
 * `src/lib/meals/catalog/`、純粋なアルゴリズムは `src/lib/meals/` 直下の各モジュールが持つ。
 *
 * 正本の所在（AI の出力や画面の入力で上書きしない）:
 * - 材料の数量・アレルゲン・年齢制約・売場: 食材辞書とレシピ（コード同梱）
 * - 必須除外・在庫・固定枠・買い物: アプリの DB と純粋関数
 */

// ── 単位 ───────────────────────────────────────────────────────────

/** 数値で合算できる単位の族。族をまたぐ換算（個↔g 等）はしない。 */
export type UnitFamily = "mass" | "volume" | "count" | "none"

/**
 * 単位。mass / volume は族の基準単位（g / ml）へ明示換算できる。
 * count 系は単位ごとに別の族として扱い、互いに換算しない。
 * `to_taste`（適量）・`pinch`（少々）は数値化しない。
 */
export type UnitId =
  | "g" | "kg"
  | "ml" | "l" | "tsp" | "tbsp" | "cup"
  | "piece" | "pack" | "bunch" | "slice" | "clove" | "can" | "sheet" | "stalk" | "bag" | "block" | "bowl"
  | "to_taste" | "pinch"

export interface Quantity {
  /** `to_taste` / `pinch` のときは null。それ以外は正の有限数。 */
  amount: number | null
  unit: UnitId
}

// ── 売場・料理区分 ─────────────────────────────────────────────────

export type StoreSection =
  | "vegetable" | "meat" | "fish" | "egg_dairy" | "soy" | "staple" | "seasoning" | "other"

export type DishRole = "main" | "side" | "staple" | "soup"

// ── アレルゲン（消費者庁の対象一覧に基づく） ───────────────────────

/** `catalog/allergens.ts` の `ALLERGENS[].id`。値の集合はデータ側が正本。 */
export type AllergenId = string

export interface AllergenDef {
  id: AllergenId
  /** 公式表記どおりの名称。 */
  name: string
  /** 表示義務（特定原材料）か、表示推奨（特定原材料に準ずるもの）か。 */
  tier: "mandatory" | "recommended"
}

export interface AllergenListMeta {
  /** 出典の文書名・版。 */
  sourceTitle: string
  sourceUrl: string
  /** 一覧の版を識別する情報（通知名・日付など）。 */
  version: string
  /** この一覧を一次資料で確認した日（YYYY-MM-DD）。 */
  confirmedOn: string
}

// ── 食材辞書 ───────────────────────────────────────────────────────

export interface IngredientDef {
  /** 安定 ID（snake_case）。変更しない。 */
  id: string
  /** 表示名。 */
  name: string
  /**
   * 同じ食材を指す別名。照合は「正規化後の完全一致」だけで行う（部分一致しない）。
   * 加工品・部位・似た名前を別名に入れない（例: 「豚こま」に「豚バラ」を入れない）。
   */
  aliases: readonly string[]
  section: StoreSection
  /** 含まれると分かっているアレルゲン（派生食材を含む。例: しょうゆ → 小麦・大豆）。 */
  allergens: readonly AllergenId[]
  /**
   * `known`: 上の一覧が成分を表す。
   * `varies`: 商品により原材料が異なる加工品（ルウ・だしの素・ソース等）。
   *   アレルギーの必須除外がある世帯では、自動確定の候補から外す。
   */
  allergenInfo: "known" | "varies"
  /** 由来する食材の ID（例: ベーコン → 豚肉、豆腐 → 大豆）。食材単位の除外を派生品へ及ぼすために使う。 */
  derivedFrom?: readonly string[]
  /**
   * 精製して元の食材とは別物として使う食品の、由来の食材 ID（例: 片栗粉 → じゃがいも）。
   * **アレルギー**として由来の食材を登録したときだけ除外を及ぼす（広く倒す）。
   * 苦手・好みには及ぼさない（じゃがいもが苦手でも、片栗粉でとろみを付けた料理は外さない）。
   */
  refinedFrom?: readonly string[]
  /**
   * アレルギーとしてこの食材を登録したとき、同じアレルゲンを含む他の食材へ除外を広げる対象。
   * 省略時: 由来（`derivedFrom`）が無く成分が定まった（`known`）食材は `allergens` の全て、それ以外は無し。
   * 「どの成分が原因か」を決められない加工品（そば = そば + 小麦、サラダ油 = 大豆油の配合）は、
   * ここで明示して絞る（空なら、その食材と派生品だけを外す）。
   */
  allergySpread?: readonly AllergenId[]
  /**
   * 部位・種類の総称（「豚肉」「きのこ」）。レシピの材料には使わない。
   * 在庫に総称で入っていても部位・種類と同一視せず、由来する材料は「確認が必要」へ回す。
   */
  generic?: boolean
  /** 常備品の候補として提示してよいか（提示だけ。自動登録はしない）。 */
  stapleCandidate?: boolean
  /** 一次資料で確認した年齢制約（月齢未満には使わない）。根拠は `sourceId`。 */
  ageRule?: { minAgeMonths: number; sourceId: string }
}

// ── レシピ ─────────────────────────────────────────────────────────

export interface RecipeIngredient {
  ingredientId: string
  quantity: Quantity
  /** true のとき、欠けていても「作れる」判定を妨げない。 */
  optional?: boolean
  /** 切り方などの補足（数量ではない）。 */
  note?: string
}

/** 取り分け案内が対象とする食事段階。乳児の離乳食（初期〜後期）は個別レシピでは扱わない。 */
export type ChildServingStage = "toddler_2y_plus"

export interface ChildServingGuide {
  stage: ChildServingStage
  /** この案内が対象とする最小月齢（2 歳以降 = 24）。 */
  minAgeMonths: number
  /** 何番目の手順（0 始まり）の前に取り分けるか。 */
  separateBeforeStep: number
  /** 味付け前に取り分ける工程（短い独自の説明）。 */
  instructions: readonly string[]
  /** 形状・柔らかさ・加熱などの注意。 */
  cautions: readonly string[]
  /** 根拠（`catalog/child-guidance.ts` の出典 ID）。空にしない。 */
  sourceIds: readonly string[]
}

export interface RecipeDef {
  /** 安定 ID（snake_case）。変更しない。 */
  id: string
  /** 材料・手順を変えたら上げる。献立・買い物はこの版を記録する。 */
  version: number
  title: string
  role: DishRole
  /** 何人分のレシピか。 */
  servings: number
  /** 調理時間の目安（分）。 */
  minutes: number
  /** 丼・カレー・麺など、主食を含む料理。true の日は主食を別に足さない。 */
  includesStaple?: boolean
  ingredients: readonly RecipeIngredient[]
  steps: readonly string[]
  /** 好み・希望の照合に使う語（例: "fish", "pork", "curry", "japanese", "quick"）。 */
  tags: readonly string[]
  /**
   * `from_ingredients`: 全材料が辞書にあり、アレルゲンは辞書から導出できる。
   * `unconfirmed`: 導出できない材料を含む。アレルギーの必須除外がある世帯では自動確定しない。
   */
  allergenStatus: "from_ingredients" | "unconfirmed"
  /** 取り分けに対応する場合だけ持つ。無ければ「この料理の取り分け案内は未対応」。 */
  childServing?: ChildServingGuide
  /** 出所と利用条件。初期カタログは独自作成のみ。 */
  source: { kind: "irori_original"; note: string }
}

// ── 在庫（食材） ───────────────────────────────────────────────────

export type PantryStatus = "have" | "low" | "out"
export type PantryStorage = "fridge" | "freezer" | "pantry"

export interface PantryItem {
  id: string
  /** 辞書に解決できたときだけ入る。null は未解決（名前のまま扱い、提案の材料に数えない）。 */
  ingredientId: string | null
  name: string
  /** 数量は任意。null は「数量不明」。 */
  quantity: Quantity | null
  status: PantryStatus
  useSoon: boolean
  storage: PantryStorage | null
  /** YYYY-MM-DD（JST）。 */
  expiresOn: string | null
  /** 最終確認日 YYYY-MM-DD（JST）。 */
  confirmedOn: string
}

// ── 必須除外（アレルギー・苦手） ───────────────────────────────────

export type ExclusionReason = "allergy" | "dislike"

export type ExclusionTarget =
  | { kind: "allergen"; allergenId: AllergenId }
  | { kind: "ingredient"; ingredientId: string }
  /** 自由入力。辞書へ解決できなければ名前の一致でしか判定できない。 */
  | { kind: "custom"; label: string }

export interface FoodExclusion {
  id: string
  reason: ExclusionReason
  target: ExclusionTarget
  /** 誰の除外か（表示用）。判定は世帯の和集合で行い、ここでは絞らない。 */
  subject:
    | { kind: "household" }
    | { kind: "member"; profileId: string }
    | { kind: "child"; childId: string }
}

// ── 好み（採点にだけ使う。必須除外ではない） ───────────────────────

export interface FoodPreference {
  id: string
  /** `household` は家族共通として明示したもの。`personal` は本人だけが変更できる。 */
  scope: "household" | "personal"
  profileId: string | null
  target: { kind: "recipe" | "ingredient" | "tag"; id: string }
  sentiment: "like" | "dislike"
}

export interface DishFeedback {
  id: string
  /** 評価した本人。集約しても失わない。 */
  profileId: string
  recipeId: string | null
  /** YYYY-MM-DD（JST）。 */
  eatenOn: string
  /** 1 = 苦手 / 2 = ふつう / 3 = おいしい。 */
  taste: 1 | 2 | 3 | null
  /** 1 = 大変 / 2 = ふつう / 3 = 楽。 */
  effort: 1 | 2 | 3 | null
  again: boolean | null
  /** その日の気分など、好みに反映しない記録。 */
  excludeFromLearning: boolean
}

// ── 献立 ───────────────────────────────────────────────────────────

export type PlanEntryStatus = "proposed" | "confirmed" | "cooked" | "skipped"

export interface PlanEntry {
  id: string
  /** YYYY-MM-DD（JST）。 */
  date: string
  role: DishRole
  position: number
  /** カタログのレシピ。手動料理は null で `customTitle` を持つ。 */
  recipeId: string | null
  recipeVersion: number | null
  customTitle: string | null
  /** 手動料理の材料（未登録なら null = 買い物の自動計算の対象外）。 */
  customIngredients: readonly RecipeIngredient[] | null
  servings: number
  pinned: boolean
  status: PlanEntryStatus
  /** どの経路がこの枠を作ったか。表示の正直さのために保持する。 */
  origin: "auto" | "manual" | "ai_assisted"
}

/** 希望（自由入力やボタン）を構造化したもの。AI も規則ベースの解釈もこの形を返す。 */
export interface WishConstraints {
  /** 「金曜はカレー」等。採用時に固定枠になる。 */
  pins: readonly { date: string; recipeId: string }[]
  preferTags: readonly string[]
  avoidTags: readonly string[]
  maxMinutes: number | null
  /** 候補の並び替え希望（先頭ほど優先）。必須除外や在庫の判定は変えない。 */
  preferRecipeIds: readonly string[]
}

// ── 買い物 ─────────────────────────────────────────────────────────

export interface GrocerySource {
  date: string
  recipeId: string | null
  title: string
  quantity: Quantity
}

export interface GroceryNeed {
  /** 自動項目の同一性（食材 ID + 単位の族）。再計算で同じ鍵へ upsert する。 */
  itemKey: string
  ingredientId: string
  name: string
  section: StoreSection
  /** 族の基準単位での必要量。数値化できない分は `nonNumeric` に残す。 */
  required: Quantity | null
  /** 「適量」「少々」など、合算しなかった表記。 */
  nonNumeric: readonly string[]
  /** 在庫の数量が不明で差し引いていないとき true（「在庫量を確認」）。 */
  needsStockCheck: boolean
  sources: readonly GrocerySource[]
}
