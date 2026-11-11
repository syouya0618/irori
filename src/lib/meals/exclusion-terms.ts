/**
 * 「使わない食材」の自由入力で使われる、総称・類義の語の既定の辞書。
 *
 * 境界指令を持たない中立モジュール。`toCatalogView` が、カタログに語の辞書が渡されなかったときの
 * 既定として使う（差し替えは `MealCatalog.exclusionTerms`）。
 *
 * 規則:
 * - 語は `foldName` 後の**完全一致**で引く（「乳製品」「甲殻類」「えび・かに」「魚」「ひき肉」…）。
 *   アレルゲン名・食材名そのもの（「卵」「牛乳」「鶏卵」）は辞書と食材の別名が持つので、ここへ書かない。
 * - 指す先は ID だけ。渡されたカタログに無い ID は使わない（＝その語では「解決した」と言わない）。
 * - 迷ったら**広い側**へ書く（「ナッツ」に落花生を含める、「魚介」に甲殻類・貝を含める）。
 *   除外が広すぎれば利用者は気づけるが、狭すぎる除外は気づけない。
 * - アレルゲン（`allergenIds`）で指すと、そのアレルゲンを含む調味料・加工品まで外す。
 *   食材（`ingredientIds` / `sections`）で指すと、その食材と派生品を外す
 *   （アレルギーとして登録された素の食材は、`exclusions.ts` が同じアレルゲンの加工品へ広げる）。
 * - ここに無い語は、入力が品目名を含むか（「卵料理」⊃「卵」）、名前の一致で判定する。
 *   それでも当たらない語は「判定できない」になる（`exclusions.ts`）。
 *
 * ## 品目名を含むが、その品目ではない語（`hides`。2026-11-11）
 * 「含む」での照合（自由入力の推定・手動料理の料理名）は部分一致ゆえ、「焼きそば」⊃「そば」、
 * 「豆乳」⊃「乳」、「鶏もも」⊃「もも（桃）」、「さけるチーズ」⊃「さけ」で別の品目へ化ける。`hides` を持つ語は、
 * 文に現れたとき、**その語の中に現れた `hides` の名前を数えない**（語の外に同じ名前が別に在れば数える）。
 * - 語そのものが指すものは `ingredientIds` で書く（辞書に無い料理名の語。焼きそば → 焼きそば麺）。
 *   辞書の食材名そのもの（豆乳・鶏もも）は、食材として数えるので指す先を持たない — `DEFAULT_NAME_MASKS`（隠すだけ）へ書く。
 * - **本当にその品目を含む語へは書かない**（「ざるそば」「ぽん酢」⊃「酢」「塩鮭」⊃「塩」は隠さない。
 *   隠すと見落としになる）。迷う語は書かない（誤検出は安全側、見落としは危険側）。
 */

import type { AllergenId, StoreSection } from "./types"

export interface ExclusionTermDef {
  /** 照合する語（表記ゆれを並べる。カタカナ／ひらがな・中点・空白の違いは照合時に畳む）。 */
  terms: readonly string[]
  allergenIds?: readonly AllergenId[]
  ingredientIds?: readonly string[]
  /** 売場ごと指す（その売場の全ての食材）。食材が増えても漏れない。 */
  sections?: readonly StoreSection[]
  /** `sections` で指した中から外す食材。 */
  exceptIngredientIds?: readonly string[]
  /**
   * この語の中に現れても数えない品目名（アレルゲン名・食材名・別名）。上の「品目名を含むが、その品目ではない語」。
   * `hides` を持つ語は、自由入力の「含む」での照合と手動料理の料理名でも探す（`ingredientIds` があれば、その食材を含むとみなす）。
   */
  hides?: readonly string[]
}

const TREE_NUTS_AND_PEANUT: readonly AllergenId[] = ["walnut", "cashew", "almond", "pistachio", "macadamia", "peanut"]

export const DEFAULT_EXCLUSION_TERMS: readonly ExclusionTermDef[] = [
  // ── 乳 ──
  {
    terms: [
      "乳製品", "乳成分", "乳類", "牛乳製品", "乳たんぱく", "乳蛋白", "カゼイン", "乳清", "ホエイ",
      "脱脂粉乳", "スキムミルク", "粉ミルク", "練乳", "乳糖",
    ],
    allergenIds: ["milk"],
  },
  { terms: ["チーズ", "チーズ類"], ingredientIds: ["sliced_cheese", "pizza_cheese", "powdered_cheese"] },
  // ── 卵 ──
  {
    terms: ["卵白", "卵黄", "生卵", "生たまご", "全卵", "卵類", "卵製品", "ゆで卵", "茹で卵", "温泉卵", "うずらの卵", "うずら卵"],
    allergenIds: ["egg"],
  },
  { terms: ["魚卵", "筋子", "すじこ"], allergenIds: ["salmon_roe"] },
  // ── 小麦・大豆 ──
  {
    terms: ["小麦製品", "小麦類", "小麦たんぱく", "小麦蛋白", "グルテン", "強力粉", "中力粉", "全粒粉", "麩"],
    allergenIds: ["wheat"],
  },
  { terms: ["大豆製品", "大豆類", "大豆たんぱく", "大豆蛋白"], allergenIds: ["soybean"] },
  { terms: ["豆腐", "とうふ", "お豆腐"], ingredientIds: ["tofu_momen", "tofu_kinu", "koya_tofu"] },
  // ── 甲殻類・貝・魚 ──
  { terms: ["甲殻類", "甲殻", "えび・かに", "かに・えび", "海老・蟹", "蟹・海老", "海老・かに"], allergenIds: ["shrimp", "crab"] },
  { terms: ["蟹", "蟹類"], allergenIds: ["crab"] },
  { terms: ["貝", "貝類", "二枚貝", "巻貝", "巻き貝"], allergenIds: ["abalone"], ingredientIds: ["asari"] },
  {
    // 魚（えび・いか・貝は含めない。練り物・缶詰は魚として含める）
    terms: [
      "魚", "さかな", "お魚", "魚類", "魚料理", "青魚", "白身魚", "赤身魚", "生魚", "焼き魚", "煮魚",
      "刺身", "お刺身", "さしみ",
    ],
    allergenIds: ["salmon", "mackerel"],
    sections: ["fish"],
    exceptIngredientIds: ["shrimp", "squid", "asari"],
  },
  {
    terms: ["魚介", "魚介類", "魚貝", "魚貝類", "海鮮", "海産物", "水産物", "シーフード"],
    allergenIds: ["salmon", "mackerel", "shrimp", "crab", "squid", "abalone", "salmon_roe"],
    sections: ["fish"],
  },
  { terms: ["サーモン", "鮭類", "鮭フレーク", "鮭缶"], allergenIds: ["salmon"] },
  // ── 肉 ──
  { terms: ["肉", "お肉", "肉類", "肉全般", "肉料理", "獣肉"], allergenIds: ["beef", "pork", "chicken"], sections: ["meat"] },
  { terms: ["ひき肉", "挽き肉", "挽肉", "ひきにく", "ミンチ", "ミンチ肉"], ingredientIds: ["ground_chicken", "ground_pork", "ground_mixed"] },
  { terms: ["豚", "ぶた"], ingredientIds: ["pork"] },
  { terms: ["鶏", "とり", "鳥", "鳥肉", "かしわ"], ingredientIds: ["chicken"] },
  { terms: ["牛", "ぎゅう"], ingredientIds: ["beef"] },
  { terms: ["加工肉", "ハム・ソーセージ", "ハム・ベーコン"], ingredientIds: ["bacon", "ham", "wiener"] },
  // ── 木の実・いも・果物・その他 ──
  { terms: ["ナッツ", "ナッツ類", "木の実", "木の実類", "種実類", "ツリーナッツ", "堅果", "堅果類"], allergenIds: TREE_NUTS_AND_PEANUT },
  { terms: ["山芋", "山いも", "山の芋", "やまのいも", "とろろ", "自然薯", "大和芋", "大和いも"], allergenIds: ["yam"] },
  {
    terms: ["果物", "くだもの", "フルーツ", "果実"],
    ingredientIds: ["apple", "banana", "kiwi", "orange", "peach", "lemon"],
  },
  { terms: ["麺", "めん", "麺類", "めん類"], ingredientIds: ["udon", "soba", "somen", "spaghetti", "macaroni", "chinese_noodles"] },
  { terms: ["海藻", "海草", "海藻類"], ingredientIds: ["kombu", "wakame", "nori", "hijiki"] },
  // ── 品目名を含むが、その品目ではない語（`hides`）──
  // 指す先は食材（加工品）止まり。アレルギーでも、そのアレルゲン全体（小麦・乳）へは広げない
  // （辞書の加工品 = 豆乳・鶏もも肉・焼きそば麺 と同じ扱い。R23: 原因の成分を推測しない）
  // 焼きそば・中華そばは小麦の中華麺（そば粉の「そば」ではない）
  { terms: ["焼きそば", "焼そば", "やきそば", "中華そば"], ingredientIds: ["chinese_noodles"], hides: ["そば"] },
  // さけるチーズはチーズ（乳製品）。「さけ」は鮭ではない
  { terms: ["さけるチーズ"], ingredientIds: ["sliced_cheese", "pizza_cheese", "powdered_cheese"], hides: ["さけ"] },
]

/**
 * 品目名を含むが、その品目ではない語のうち、**指す先を持たない**もの（辞書の食材名そのもの・部位の語）。
 * 文に現れたら、その語の中の `hides` を数えないだけ（語そのものは、食材名なら食材として数える）。
 * `DEFAULT_EXCLUSION_TERMS` に置かないのは、あちらが「自由入力の完全一致で何かを指す語」の辞書だから
 * （何も指さない語・食材名と同じ語を置かない、という規則をカタログのテストが守っている）。
 */
export interface NameMaskDef {
  /** 照合する語（`foldName` 後の部分一致で探す）。 */
  words: readonly string[]
  /** 語の中に現れても数えない品目名。 */
  hides: readonly string[]
}

export const DEFAULT_NAME_MASKS: readonly NameMaskDef[] = [
  // 豆乳は大豆（乳ではない）
  { words: ["豆乳"], hides: ["乳"] },
  // 鶏・豚・牛の「もも」は部位（桃ではない）
  { words: ["鶏もも", "とりもも", "豚もも", "牛もも", "もも肉"], hides: ["もも"] },
  // 胡桃はくるみ（桃ではない）・こまつなは小松菜（ツナではない）・すいかは西瓜（いかではない）
  { words: ["胡桃"], hides: ["桃"] },
  { words: ["こまつな"], hides: ["つな"] },
  { words: ["すいか"], hides: ["いか"] },
]
