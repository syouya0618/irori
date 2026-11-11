/**
 * 食物アレルギー表示の対象品目（消費者庁）。
 *
 * 境界指令を持たない中立モジュール。コード同梱の正本であり、DB へ seed しない。
 *
 * - 並びは公式の記載順（特定原材料 → 特定原材料に準ずるもの。各階層は五十音順、ゼラチンのみ末尾）。
 * - `name` は公式表記どおり。`id` は Irori 内部の安定 ID（公式の ID ではない）。
 * - 件数は定数で持たない。表示する件数は必ず `ALLERGENS.length` から求める。
 * - 品目は改正で増減する（2019 / 2023 / 2024 / 2026 年に変更があった）。
 *   DB に保存された未知の id は落とさず、表示だけを退化させること。
 */
import type { AllergenDef, AllergenListMeta } from "@/lib/meals/types"

const ALLERGEN_DATA = [
  // 特定原材料（表示義務）
  { id: "shrimp", name: "えび", tier: "mandatory" },
  { id: "cashew", name: "カシューナッツ", tier: "mandatory" },
  { id: "crab", name: "かに", tier: "mandatory" },
  { id: "walnut", name: "くるみ", tier: "mandatory" },
  { id: "wheat", name: "小麦", tier: "mandatory" },
  { id: "buckwheat", name: "そば", tier: "mandatory" },
  { id: "egg", name: "卵", tier: "mandatory" },
  { id: "milk", name: "乳", tier: "mandatory" },
  { id: "peanut", name: "落花生（ピーナッツ）", tier: "mandatory" },
  // 特定原材料に準ずるもの（表示推奨）
  { id: "almond", name: "アーモンド", tier: "recommended" },
  { id: "abalone", name: "あわび", tier: "recommended" },
  { id: "squid", name: "いか", tier: "recommended" },
  { id: "salmon_roe", name: "いくら", tier: "recommended" },
  { id: "orange", name: "オレンジ", tier: "recommended" },
  { id: "kiwifruit", name: "キウイフルーツ", tier: "recommended" },
  { id: "beef", name: "牛肉", tier: "recommended" },
  { id: "sesame", name: "ごま", tier: "recommended" },
  { id: "salmon", name: "さけ", tier: "recommended" },
  { id: "mackerel", name: "さば", tier: "recommended" },
  { id: "soybean", name: "大豆", tier: "recommended" },
  { id: "chicken", name: "鶏肉", tier: "recommended" },
  { id: "banana", name: "バナナ", tier: "recommended" },
  { id: "pistachio", name: "ピスタチオ", tier: "recommended" },
  { id: "pork", name: "豚肉", tier: "recommended" },
  { id: "macadamia", name: "マカダミアナッツ", tier: "recommended" },
  { id: "peach", name: "もも", tier: "recommended" },
  { id: "yam", name: "やまいも", tier: "recommended" },
  { id: "apple", name: "りんご", tier: "recommended" },
  { id: "gelatin", name: "ゼラチン", tier: "recommended" },
] as const satisfies readonly AllergenDef[]

/** カタログが知っているアレルゲン ID（食材辞書の型検査に使う）。 */
export type CatalogAllergenId = (typeof ALLERGEN_DATA)[number]["id"]

export const ALLERGENS: readonly AllergenDef[] = ALLERGEN_DATA

/** 一覧の出典・版・確認日。画面に「いつ・何を見て作った一覧か」を出すために使う。 */
export const ALLERGEN_LIST_META: AllergenListMeta = {
  sourceTitle:
    "消費者庁「食品表示基準について」（平成27年3月30日消食表第139号）別添 アレルゲンを含む食品に関する表示",
  sourceUrl:
    "https://www.caa.go.jp/policies/policy/food_labeling/food_labeling_act/assets/food_labeling_cms201_261001_07.pdf",
  // 品目構成が最後に変わった日（令和8年4月1日: カシューナッツを特定原材料へ、ピスタチオを準ずるものへ追加）。
  version: "caa-2026-04-01",
  confirmedOn: "2026-11-11",
}

/** 版の説明（画面の補足用）。 */
export const ALLERGEN_LIST_VERSION_NOTE =
  "令和8年4月1日の改正（カシューナッツを特定原材料へ、ピスタチオを特定原材料に準ずるものへ追加）までを反映しています。"

/** 階層の表示名（公式の呼称）。 */
export const ALLERGEN_TIER_LABELS: Readonly<Record<AllergenDef["tier"], string>> = {
  mandatory: "特定原材料",
  recommended: "特定原材料に準ずるもの",
}

/**
 * 一覧の性質についての注意。アレルギー設定の画面に必ず添える。
 * 「含まない」「適合している」とは書けない（表示制度は容器包装された加工食品が対象で、
 * 推奨品目は表示されないことがあり、経過措置中の品目もある）。
 */
export const ALLERGEN_LIST_DISCLAIMER =
  "この一覧は、消費者庁が容器包装された加工食品の表示対象として定めている品目です。すべてのアレルゲンを網羅するものではなく、法令上の表示への適合を保証するものでもありません。一覧にないものは自由入力で追加できます。"

/** 判定の限界についての注意。献立・レシピの画面で、アレルギーの除外があるときに添える。 */
export const ALLERGEN_JUDGEMENT_DISCLAIMER =
  "除外の判定は、Irori の食材辞書に登録した一般的な原材料にもとづきます。商品ごとの原材料や製造時の混入までは確認できません。使う商品の原材料表示を必ず確認してください。"
