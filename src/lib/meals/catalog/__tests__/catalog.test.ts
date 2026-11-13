import { describe, expect, it } from "vitest"
import { DEFAULT_EXCLUSION_TERMS, DEFAULT_NAME_MASKS } from "@/lib/meals/exclusion-terms"
import { foldName } from "@/lib/meals/normalize"
import type { RecipeDef, StoreSection, UnitId } from "@/lib/meals/types"
import {
  AGE_RESTRICTION_RULES,
  ALLERGEN_BY_ID,
  ALLERGEN_JUDGEMENT_DISCLAIMER,
  ALLERGEN_LIST_DISCLAIMER,
  ALLERGEN_LIST_META,
  ALLERGEN_LIST_VERSION_NOTE,
  ALLERGEN_TIER_LABELS,
  ALLERGENS,
  CHILD_GUIDANCE_DISCLAIMER,
  CHILD_SERVING_BLOCKED_INGREDIENT_IDS,
  CHILD_SERVING_RECIPES,
  CHILD_SERVING_ROUND_INGREDIENT_IDS,
  CHILD_SERVING_SCOPE_NOTE,
  CHILD_SERVING_STAGE_LABELS,
  CHILD_SERVING_UNSUPPORTED_TEXT,
  DISH_ROLE_LABELS,
  DISH_ROLES,
  getAllergen,
  getGuidanceSource,
  getIngredient,
  getRecipe,
  getRecipeTagLabel,
  GUIDANCE_SOURCES,
  INGREDIENT_BY_ID,
  INGREDIENTS,
  listRecipesByRole,
  QUICK_MAX_MINUTES,
  RECIPE_BY_ID,
  RECIPE_SOURCE_NOTE,
  RECIPE_TAGS,
  RECIPES,
  RECIPES_BY_ROLE,
  SEPARATE_BEFORE_SEASONING_NOTE,
  STAPLE_CANDIDATE_INGREDIENTS,
  STORE_SECTION_LABELS,
  STORE_SECTIONS,
  storeSectionLabel,
  storeSectionOrder,
  TODDLER_SERVING_NOTES,
  TODDLER_SERVING_TOPIC_LABELS,
  WEANING_GENERAL_NOTES,
  WEANING_STAGE_GUIDES,
} from "@/lib/meals/catalog"

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
const YMD = /^\d{4}-\d{2}-\d{2}$/

/** 照合の最小正規化（NFKC + 空白除去）。 */
const fold = (s: string) => s.normalize("NFKC").replace(/\s+/gu, "")
/** より強い畳み込み（英字小文字化 + カタカナ → ひらがな）。照合側がここまで畳んでも衝突しないことを確かめる。 */
const foldKana = (s: string) =>
  fold(s)
    .toLowerCase()
    .replace(/[ァ-ヶ]/gu, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))

const duplicates = (values: readonly string[]) =>
  values.filter((v, i) => values.indexOf(v) !== i)

const NUMERIC_UNITS: readonly UnitId[] = [
  "g", "kg", "ml", "l", "tsp", "tbsp", "cup",
  "piece", "pack", "bunch", "slice", "clove", "can", "sheet", "stalk", "bag", "block", "bowl",
]
const NON_NUMERIC_UNITS: readonly UnitId[] = ["to_taste", "pinch"]

/** 合算できる単位の族（g↔kg、ml↔l↔小さじ・大さじ・カップ。個数系は単位ごとに別）。 */
const unitFamily = (unit: UnitId): string => {
  if (unit === "g" || unit === "kg") return "mass"
  if (["ml", "l", "tsp", "tbsp", "cup"].includes(unit)) return "volume"
  return unit
}

/** 確認していない主張に使われがちな語。利用者向けの文言に現れてはならない。 */
const FORBIDDEN_CLAIM_WORDS = ["監修", "栄養バランス", "管理栄養士", "カロリー", "kcal"]

const recipeTexts = (r: RecipeDef): string[] => [
  r.title,
  r.source.note,
  ...r.steps,
  ...r.ingredients.map((i) => i.note ?? ""),
  ...(r.childServing?.instructions ?? []),
  ...(r.childServing?.cautions ?? []),
]

const byId = (id: string): RecipeDef => {
  const r = getRecipe(id)
  if (!r) throw new Error(`recipe not found: ${id}`)
  return r
}

const usesSection = (r: RecipeDef, section: StoreSection) =>
  r.ingredients.some((i) => getIngredient(i.ingredientId)?.section === section)

const usesAllergen = (r: RecipeDef, allergenId: string) =>
  r.ingredients.some((i) =>
    getIngredient(i.ingredientId)?.allergens.includes(allergenId),
  )

const hasVaries = (r: RecipeDef) =>
  r.ingredients.some(
    (i) => getIngredient(i.ingredientId)?.allergenInfo === "varies",
  )

// ── アレルゲン一覧 ─────────────────────────────────────────────────

describe("アレルゲン一覧（消費者庁の対象品目）", () => {
  it("ID は一意の snake_case で、名称も重複しない", () => {
    const ids = ALLERGENS.map((a) => a.id)
    expect(duplicates(ids)).toEqual([])
    for (const id of ids) expect(id).toMatch(SNAKE_CASE)
    expect(duplicates(ALLERGENS.map((a) => a.name))).toEqual([])
  })

  it("25 件以上あり、公式の記載順・表記どおり（特定原材料 9 + 準ずるもの 20）", () => {
    expect(ALLERGENS.length).toBeGreaterThanOrEqual(25)
    expect(
      ALLERGENS.filter((a) => a.tier === "mandatory").map((a) => a.name),
    ).toEqual([
      "えび", "カシューナッツ", "かに", "くるみ", "小麦", "そば", "卵", "乳", "落花生（ピーナッツ）",
    ])
    expect(
      ALLERGENS.filter((a) => a.tier === "recommended").map((a) => a.name),
    ).toEqual([
      "アーモンド", "あわび", "いか", "いくら", "オレンジ", "キウイフルーツ", "牛肉", "ごま", "さけ", "さば",
      "大豆", "鶏肉", "バナナ", "ピスタチオ", "豚肉", "マカダミアナッツ", "もも", "やまいも", "りんご", "ゼラチン",
    ])
    // 特定原材料が先、準ずるものが後。
    const firstRecommended = ALLERGENS.findIndex((a) => a.tier === "recommended")
    expect(
      ALLERGENS.slice(firstRecommended).every((a) => a.tier === "recommended"),
    ).toBe(true)
  })

  it("直近の改正を反映している（カシューナッツは義務、ピスタチオ・マカダミアナッツは推奨、まつたけは無い）", () => {
    expect(getAllergen("cashew")?.tier).toBe("mandatory")
    expect(getAllergen("walnut")?.tier).toBe("mandatory")
    expect(getAllergen("pistachio")?.tier).toBe("recommended")
    expect(getAllergen("macadamia")?.tier).toBe("recommended")
    expect(ALLERGENS.some((a) => a.name.includes("まつたけ"))).toBe(false)
    expect(getAllergen("matsutake")).toBeUndefined()
  })

  it("出典・版・確認日を持つ", () => {
    expect(ALLERGEN_LIST_META.sourceTitle).toContain("消費者庁")
    expect(ALLERGEN_LIST_META.sourceUrl).toMatch(/^https:\/\/www\.caa\.go\.jp\//)
    expect(ALLERGEN_LIST_META.version.length).toBeGreaterThan(0)
    expect(ALLERGEN_LIST_META.confirmedOn).toMatch(YMD)
    expect(ALLERGEN_LIST_VERSION_NOTE).toContain("カシューナッツ")
    expect(Object.keys(ALLERGEN_TIER_LABELS).sort()).toEqual(["mandatory", "recommended"])
  })

  it("件数を文言に埋め込まず、法令適合や不使用を保証しない", () => {
    for (const text of [ALLERGEN_LIST_DISCLAIMER, ALLERGEN_JUDGEMENT_DISCLAIMER, ALLERGEN_LIST_VERSION_NOTE]) {
      // 件数は ALLERGENS.length から求める（定数文言に数を書くと改正でずれる）。
      expect(text).not.toMatch(/\d+\s*(品目|種類|件)/u)
      expect(text).not.toMatch(/保証します|適合しています|含みません|安全です/u)
    }
    expect(ALLERGEN_LIST_DISCLAIMER).toContain("法令上の表示への適合を保証するものでもありません")
    expect(ALLERGEN_LIST_DISCLAIMER).toContain("自由入力")
    expect(ALLERGEN_JUDGEMENT_DISCLAIMER).toContain("原材料表示を必ず確認")
  })
})

// ── 食材辞書 ───────────────────────────────────────────────────────

describe("食材辞書", () => {
  it("ID は一意の snake_case で、目安の件数に収まる", () => {
    const ids = INGREDIENTS.map((i) => i.id)
    expect(duplicates(ids)).toEqual([])
    for (const id of ids) expect(id).toMatch(SNAKE_CASE)
    expect(INGREDIENTS.length).toBeGreaterThanOrEqual(130)
    expect(INGREDIENTS.length).toBeLessThanOrEqual(170)
    expect(INGREDIENT_BY_ID.size).toBe(INGREDIENTS.length)
  })

  it("売場・アレルゲン・由来がすべて解決する", () => {
    for (const i of INGREDIENTS) {
      expect(i.name.trim(), i.id).not.toBe("")
      expect(Object.keys(STORE_SECTION_LABELS), i.id).toContain(i.section)
      expect(["known", "varies"], i.id).toContain(i.allergenInfo)
      expect(duplicates(i.allergens), i.id).toEqual([])
      for (const a of i.allergens) expect(ALLERGEN_BY_ID.has(a), `${i.id} → ${a}`).toBe(true)
      for (const d of i.derivedFrom ?? []) {
        expect(d, i.id).not.toBe(i.id)
        expect(INGREDIENT_BY_ID.has(d), `${i.id} → ${d}`).toBe(true)
      }
    }
  })

  it("由来をたどっても循環せず、由来元のアレルゲンは派生品にも入っている", () => {
    for (const i of INGREDIENTS) {
      const seen = new Set<string>([i.id])
      let frontier = [...(i.derivedFrom ?? [])]
      while (frontier.length > 0) {
        const next: string[] = []
        for (const id of frontier) {
          expect(seen.has(id), `循環: ${i.id} → ${id}`).toBe(false)
          seen.add(id)
          const base = getIngredient(id)
          for (const a of base?.allergens ?? []) {
            expect(i.allergens, `${i.id} は ${id} 由来なのに ${a} を持たない`).toContain(a)
          }
          next.push(...(base?.derivedFrom ?? []))
        }
        frontier = next
      }
    }
  })

  it("精製品の由来（refinedFrom）・アレルギーの広げ先（allergySpread）・総称（generic）が辞書と食い違わない", () => {
    for (const i of INGREDIENTS) {
      for (const r of i.refinedFrom ?? []) {
        expect(r, i.id).not.toBe(i.id)
        expect(INGREDIENT_BY_ID.has(r), `${i.id} → ${r}`).toBe(true)
        // 同じ由来を「派生」と「精製」の両方に書かない（苦手に及ぼすかどうかが決まらなくなる）
        expect(i.derivedFrom ?? [], i.id).not.toContain(r)
      }
      // 広げ先は、その食材が持つアレルゲンの一部
      for (const a of i.allergySpread ?? []) expect(i.allergens, `${i.id} → ${a}`).toContain(a)
      if (i.generic === true) {
        // 総称は由来の根で、部位・種類（派生品）を 1 つ以上持つ
        expect(i.derivedFrom ?? [], i.id).toEqual([])
        expect(INGREDIENTS.some((other) => (other.derivedFrom ?? []).includes(i.id)), i.id).toBe(true)
      }
    }
    // 片栗粉はじゃがいもの精製品（苦手には及ぼさず、アレルギーにだけ及ぼす）
    expect(getIngredient("katakuriko")).toMatchObject({ refinedFrom: ["potato"] })
    expect(getIngredient("katakuriko")?.derivedFrom).toBeUndefined()
    expect(getIngredient("cherry_tomato")?.derivedFrom).toEqual(["tomato"])
    // 原因の成分を 1 つに決められない加工品は、広げ先を明示して絞る
    expect(getIngredient("soba")?.allergySpread).toEqual(["buckwheat"])
    expect(getIngredient("salad_oil")?.allergySpread).toEqual([])
    expect(INGREDIENTS.filter((i) => i.generic === true).map((i) => i.id).sort()).toEqual(["beef", "chicken", "mushroom", "pork"])
  })

  it("由来が無く成分が定まった食材で、複数のアレルゲンを持つものは広げ先を明示している（加工品の取りこぼし検査）", () => {
    // 素の食材（卵・牛乳）は 1 つのアレルゲンしか持たない。2 つ以上を持つ「由来なし・known」は
    // 加工品のはずなので、アレルギー登録を全アレルゲンへ広げないよう allergySpread を書く
    const suspicious = INGREDIENTS.filter(
      (i) =>
        (i.derivedFrom ?? []).length === 0 &&
        i.allergenInfo === "known" &&
        i.allergens.length >= 2 &&
        i.allergySpread === undefined,
    )
    expect(suspicious.map((i) => i.id)).toEqual([])
  })

  it("除外の総称・類義の語（DEFAULT_EXCLUSION_TERMS）は、実在する ID・売場だけを指す", () => {
    expect(DEFAULT_EXCLUSION_TERMS.length).toBeGreaterThan(10)
    const allTerms: string[] = []
    for (const term of DEFAULT_EXCLUSION_TERMS) {
      const label = term.terms[0]
      expect(term.terms.length, label).toBeGreaterThan(0)
      for (const a of term.allergenIds ?? []) expect(ALLERGEN_BY_ID.has(a), `${label} → ${a}`).toBe(true)
      for (const i of term.ingredientIds ?? []) expect(INGREDIENT_BY_ID.has(i), `${label} → ${i}`).toBe(true)
      for (const i of term.exceptIngredientIds ?? []) expect(INGREDIENT_BY_ID.has(i), `${label} → ${i}`).toBe(true)
      for (const s of term.sections ?? []) expect(Object.keys(STORE_SECTION_LABELS), `${label} → ${s}`).toContain(s)
      // 何も指さない語は置かない
      const targets = (term.allergenIds ?? []).length + (term.ingredientIds ?? []).length + (term.sections ?? []).length
      expect(targets, label).toBeGreaterThan(0)
      allTerms.push(...term.terms.map(foldName))
    }
    // 同じ語が 2 つの項目に現れない（どちらの意味かが決まらなくなる）
    expect(duplicates(allTerms)).toEqual([])
    for (const folded of allTerms) expect(folded).not.toBe("")
  })

  it("品目名を含むが、その品目ではない語（hides）は、本当にその品目を含むものを隠さない", () => {
    // 語の中に現れる品目名の、品目（アレルゲン ID / 食材 ID）
    const itemsNamed = (hide: string) => {
      const allergens = ALLERGENS.filter((a) =>
        [a.name, ...a.name.normalize("NFKC").split(/[()]/u)].map(foldName).includes(foldName(hide)),
      ).map((a) => a.id)
      const ingredients = INGREDIENTS.filter((i) => [i.name, ...i.aliases].map(foldName).includes(foldName(hide))).map((i) => i.id)
      return { allergens, ingredients }
    }
    // 食材の由来をたどったアレルゲンと食材
    const lineageOf = (id: string): { ids: Set<string>; allergens: Set<string> } => {
      const ids = new Set<string>()
      const allergens = new Set<string>()
      const stack = [id]
      while (stack.length > 0) {
        const current = stack.pop() as string
        if (ids.has(current)) continue
        ids.add(current)
        const def = INGREDIENT_BY_ID.get(current)
        for (const a of def?.allergens ?? []) allergens.add(a)
        stack.push(...(def?.derivedFrom ?? []), ...(def?.refinedFrom ?? []))
      }
      return { ids, allergens }
    }
    const masks = [
      ...DEFAULT_NAME_MASKS.map((mask) => ({ words: mask.words, hides: mask.hides, targets: [] as readonly string[] })),
      ...DEFAULT_EXCLUSION_TERMS.filter((term) => term.hides !== undefined).map((term) => ({
        words: term.terms,
        hides: term.hides ?? [],
        targets: term.ingredientIds ?? [],
      })),
    ]
    expect(masks.length).toBeGreaterThanOrEqual(4)
    for (const mask of masks) {
      for (const hide of mask.hides) {
        const named = itemsNamed(hide)
        // 隠す名前は辞書の名前（そうでなければ隠す意味が無い）
        expect(named.allergens.length + named.ingredients.length, hide).toBeGreaterThan(0)
        for (const word of mask.words) {
          // 語は隠す名前を含む
          expect(foldName(word).includes(foldName(hide)), `${word} ⊃ ${hide}`).toBe(true)
          // 語が食材名そのもの・語が指す食材の、どの由来にも隠す品目が無い（含むものを隠すと見落としになる）
          const self = INGREDIENTS.filter((i) => [i.name, ...i.aliases].map(foldName).includes(foldName(word))).map((i) => i.id)
          for (const id of [...self, ...mask.targets]) {
            const lineage = lineageOf(id)
            for (const a of named.allergens) expect(lineage.allergens.has(a), `${word}(${id}) は ${a} を含む`).toBe(false)
            for (const i of named.ingredients) expect(lineage.ids.has(i), `${word}(${id}) は ${i} から作られる`).toBe(false)
          }
        }
      }
    }
  })

  it("除外の語は、アレルゲン名・食材名そのものと重ならない（名前の完全一致が先に解決する語を二重に持たない）", () => {
    const exactNames = new Set<string>()
    for (const a of ALLERGENS) for (const part of [a.name, ...a.name.split(/[（）()]/u)]) exactNames.add(foldName(part))
    for (const i of INGREDIENTS) for (const raw of [i.name, ...i.aliases]) exactNames.add(foldName(raw))
    exactNames.delete("")
    const overlapping = DEFAULT_EXCLUSION_TERMS.flatMap((term) => term.terms).filter((word) => exactNames.has(foldName(word)))
    expect(overlapping).toEqual([])
  })

  it("表示名・別名は、正規化（NFKC・空白除去）後に同じ文字列が 2 つ現れない", () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const i of INGREDIENTS) {
      for (const raw of [i.name, ...i.aliases]) {
        expect(raw.trim(), i.id).not.toBe("")
        const key = fold(raw)
        const prev = seen.get(key)
        if (prev !== undefined) collisions.push(`${raw}: ${prev} / ${i.id}`)
        seen.set(key, i.id)
      }
    }
    expect(collisions).toEqual([])
  })

  it("かなを畳んでも、別の食材と衝突しない（さけ = 鮭 であって酒ではない）", () => {
    const seen = new Map<string, string>()
    const collisions: string[] = []
    for (const i of INGREDIENTS) {
      for (const raw of [i.name, ...i.aliases]) {
        const key = foldKana(raw)
        const prev = seen.get(key)
        if (prev !== undefined && prev !== i.id) collisions.push(`${raw}: ${prev} / ${i.id}`)
        seen.set(key, i.id)
      }
    }
    expect(collisions).toEqual([])
    expect(seen.get(foldKana("サケ"))).toBe("salmon")
    expect(seen.get(foldKana("料理酒"))).toBe("sake")
  })

  it("部位・加工品・似た名前を別名にしていない", () => {
    const resolve = (name: string) =>
      INGREDIENTS.find((i) => [i.name, ...i.aliases].some((n) => fold(n) === fold(name)))?.id
    // 肯定側: 表記ゆれは同じ食材に解決する。
    expect(resolve("たまねぎ")).toBe("onion")
    expect(resolve("タマネギ")).toBe("onion")
    expect(resolve("玉葱")).toBe("onion")
    expect(resolve("玉 ねぎ")).toBe("onion")
    // 危険側: 部位・加工品は別の食材。
    expect(resolve("豚こま")).toBe("pork_komagire")
    expect(resolve("豚バラ")).toBe("pork_belly_slice")
    expect(resolve("ツナ缶")).toBe("tuna_can")
    expect(resolve("まぐろ")).toBe("tuna")
    expect(resolve("木綿豆腐")).toBe("tofu_momen")
    expect(resolve("絹豆腐")).toBe("tofu_kinu")
    expect(getIngredient("tofu_momen")?.derivedFrom).toEqual(["soybean"])
    expect(getIngredient("tofu_kinu")?.derivedFrom).toEqual(["soybean"])
    expect(getIngredient("tuna_can")?.derivedFrom).toContain("tuna")
    // 複数の食材を指しうる語は、どれにも解決させない（部分一致もしない）。
    for (const ambiguous of ["ねぎ", "豆腐", "ひき肉", "肉", "魚", "油", "チーズ", "削り節", "玉"]) {
      expect(resolve(ambiguous), ambiguous).toBeUndefined()
    }
  })

  it("調味料・加工品のアレルゲンを構造化して持つ", () => {
    const allergens = (id: string) => getIngredient(id)?.allergens ?? []
    expect(allergens("soy_sauce")).toEqual(expect.arrayContaining(["wheat", "soybean"]))
    expect(allergens("miso")).toContain("soybean")
    expect(allergens("mayonnaise")).toContain("egg")
    for (const id of ["butter", "milk", "sliced_cheese", "pizza_cheese", "powdered_cheese", "yogurt", "fresh_cream"]) {
      expect(allergens(id), id).toContain("milk")
    }
    expect(allergens("sesame_oil")).toContain("sesame")
    expect(allergens("bacon")).toContain("pork")
    expect(allergens("ground_mixed")).toEqual(expect.arrayContaining(["beef", "pork"]))
    expect(allergens("udon")).toContain("wheat")
    expect(allergens("soba")).toContain("buckwheat")
    // 対照: 生鮮の野菜はアレルゲンを持たない。
    expect(allergens("onion")).toEqual([])
    expect(getIngredient("onion")?.allergenInfo).toBe("known")
  })

  it("商品で原材料が変わる加工品は varies（「書いていない = 含まない」と読ませない）", () => {
    const variesIds = [
      "curry_roux", "stew_roux", "dashi_granules", "consomme", "chicken_stock_granules",
      "worcester_sauce", "chuno_sauce", "oyster_sauce", "ketchup", "mentsuyu", "ponzu", "yakiniku_tare",
      "chikuwa", "kamaboko", "satsuma_age", "crab_stick", "ham", "bacon", "wiener",
      "bread", "panko", "mayonnaise", "doubanjiang",
    ]
    for (const id of variesIds) {
      expect(getIngredient(id)?.allergenInfo, id).toBe("varies")
    }
    // 対照: 基礎調味料・生鮮品は known。
    for (const id of ["soy_sauce", "miso", "salt", "sugar", "egg", "chicken_thigh", "tofu_momen"]) {
      expect(getIngredient(id)?.allergenInfo, id).toBe("known")
    }
  })

  it("常備品の候補に基本の調味料が入り、生鮮品は入らない", () => {
    const stapleIds = STAPLE_CANDIDATE_INGREDIENTS.map((i) => i.id)
    for (const id of ["salad_oil", "salt", "sugar", "soy_sauce", "miso", "mirin", "sake"]) {
      expect(stapleIds, id).toContain(id)
    }
    for (const id of ["onion", "chicken_thigh", "salmon", "egg", "tofu_momen"]) {
      expect(stapleIds, id).not.toContain(id)
    }
  })

  it("はちみつは 1 歳未満に使わない（出典つき・表記ゆれも同じ食材）", () => {
    const honey = getIngredient("honey")
    expect(honey?.ageRule).toEqual({ minAgeMonths: 12, sourceId: "mhlw_honey_leaflet" })
    expect(honey?.aliases).toEqual(expect.arrayContaining(["ハチミツ", "蜂蜜"]))
    expect(getGuidanceSource(honey?.ageRule?.sourceId ?? "")).toBeDefined()
    // 年齢制約は、出典表に解決するものだけ。辞書とルール表が食い違わない。
    const withRule = INGREDIENTS.filter((i) => i.ageRule !== undefined)
    for (const i of withRule) {
      expect(getGuidanceSource(i.ageRule?.sourceId ?? ""), i.id).toBeDefined()
      const rule = AGE_RESTRICTION_RULES.find((r) => r.ingredientIds.includes(i.id))
      expect(rule?.minAgeMonths, i.id).toBe(i.ageRule?.minAgeMonths)
    }
    expect(withRule.map((i) => i.id).sort()).toEqual(
      AGE_RESTRICTION_RULES.flatMap((r) => r.ingredientIds).sort(),
    )
    // 対照: 砂糖に年齢制約は無い。
    expect(getIngredient("sugar")?.ageRule).toBeUndefined()
  })
})

// ── レシピ ─────────────────────────────────────────────────────────

describe("レシピカタログ", () => {
  it("ID・料理名は一意で、ID は snake_case", () => {
    expect(duplicates(RECIPES.map((r) => r.id))).toEqual([])
    expect(duplicates(RECIPES.map((r) => r.title))).toEqual([])
    for (const r of RECIPES) expect(r.id).toMatch(SNAKE_CASE)
    expect(RECIPE_BY_ID.size).toBe(RECIPES.length)
  })

  it("各レシピが版・区分・人数・時間・出所・アレルゲンの確認状態を持つ", () => {
    for (const r of RECIPES) {
      expect(Number.isInteger(r.version) && r.version >= 1, r.id).toBe(true)
      expect(DISH_ROLES, r.id).toContain(r.role)
      expect(r.servings, r.id).toBe(2)
      expect(Number.isInteger(r.minutes) && r.minutes > 0 && r.minutes <= 120, r.id).toBe(true)
      expect(r.title.trim(), r.id).not.toBe("")
      expect(r.source, r.id).toEqual({ kind: "irori_original", note: RECIPE_SOURCE_NOTE })
      expect(["from_ingredients", "unconfirmed"], r.id).toContain(r.allergenStatus)
    }
    expect(RECIPE_SOURCE_NOTE).toBe("Irori 独自作成")
  })

  it("全材料が食材辞書に解決し、from_ingredients は未解決の材料を含まない", () => {
    for (const r of RECIPES) {
      expect(r.ingredients.length, r.id).toBeGreaterThan(0)
      expect(duplicates(r.ingredients.map((i) => i.ingredientId)), r.id).toEqual([])
      const unresolved = r.ingredients.filter((i) => !INGREDIENT_BY_ID.has(i.ingredientId))
      expect(unresolved.map((i) => i.ingredientId), r.id).toEqual([])
      if (unresolved.length > 0) expect(r.allergenStatus, r.id).toBe("unconfirmed")
      // 必須材料が 1 つも無いレシピは「作れる」判定が常に真になってしまう。
      expect(r.ingredients.some((i) => i.optional !== true), r.id).toBe(true)
    }
  })

  it("数量が妥当（適量・少々は null、それ以外は正の有限数）", () => {
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        const { amount, unit } = i.quantity
        const label = `${r.id} / ${i.ingredientId}`
        if (NON_NUMERIC_UNITS.includes(unit)) {
          expect(amount, label).toBeNull()
        } else {
          expect(NUMERIC_UNITS, label).toContain(unit)
          expect(typeof amount === "number" && Number.isFinite(amount) && amount > 0, label).toBe(true)
        }
      }
    }
  })

  it("同じ食材は、どのレシピでも同じ単位の族で書く（買い物で合算できる）", () => {
    const families = new Map<string, Set<string>>()
    for (const r of RECIPES) {
      for (const i of r.ingredients) {
        if (NON_NUMERIC_UNITS.includes(i.quantity.unit)) continue
        const set = families.get(i.ingredientId) ?? new Set<string>()
        set.add(unitFamily(i.quantity.unit))
        families.set(i.ingredientId, set)
      }
    }
    const mixed = [...families].filter(([, set]) => set.size > 1).map(([id, set]) => `${id}: ${[...set].join("/")}`)
    expect(mixed).toEqual([])
  })

  it("手順が空でなく、具体的な文になっている", () => {
    for (const r of RECIPES) {
      expect(r.steps.length, r.id).toBeGreaterThanOrEqual(3)
      expect(r.steps.length, r.id).toBeLessThanOrEqual(8)
      for (const step of r.steps) {
        expect(step.trim().length, r.id).toBeGreaterThanOrEqual(4)
        expect(step, r.id).toMatch(/。$/u)
        // 番号は画面が振る。
        expect(step, r.id).not.toMatch(/^\s*(?:[\d０-９]+\s*[.．)）、:：]|[①-⑳]|手順\s*[\d０-９])/u)
      }
    }
  })

  it("件数の下限を満たす（主菜・副菜は各 14 以上、汁物 4 以上、主食 3 以上）", () => {
    const count = (role: string) => RECIPES.filter((r) => r.role === role).length
    expect(count("main")).toBeGreaterThanOrEqual(14)
    expect(count("side")).toBeGreaterThanOrEqual(14)
    expect(count("soup")).toBeGreaterThanOrEqual(4)
    expect(count("staple")).toBeGreaterThanOrEqual(3)
    expect(Object.values(RECIPES_BY_ROLE).reduce((n, list) => n + list.length, 0)).toBe(RECIPES.length)
    for (const role of DISH_ROLES) {
      expect(listRecipesByRole(role)).toEqual(RECIPES_BY_ROLE[role])
      expect(DISH_ROLE_LABELS[role].length).toBeGreaterThan(0)
    }
    expect(listRecipesByRole("dessert")).toEqual([])
  })

  it("主菜が肉・魚・卵・大豆に偏らず、主食を含む料理が 3〜6 件ある", () => {
    const mains = RECIPES_BY_ROLE.main
    for (const tag of ["chicken", "pork", "beef", "ground_meat", "fish", "egg", "tofu"]) {
      expect(mains.filter((r) => r.tags.includes(tag)).length, tag).toBeGreaterThanOrEqual(2)
    }
    const withStaple = mains.filter((r) => r.includesStaple === true)
    expect(withStaple.length).toBeGreaterThanOrEqual(3)
    expect(withStaple.length).toBeLessThanOrEqual(6)
    // 主食を含むと言うなら、米・麺などを材料に持つ。
    for (const r of withStaple) expect(usesSection(r, "staple"), r.id).toBe(true)
    // 対照: 主食を含まない主菜は、米・麺を材料に持たない。
    for (const r of mains.filter((m) => m.includesStaple !== true)) {
      expect(usesSection(r, "staple"), r.id).toBe(false)
    }
    // 主食・副菜・汁物は includesStaple を名乗らない。
    for (const r of RECIPES.filter((x) => x.role !== "main")) {
      expect(r.includesStaple, r.id).toBeUndefined()
    }
  })

  it("通常の条件でも、アレルギーの除外がある世帯でも、7 日分の主菜・副菜を組める量がある", () => {
    const mains = RECIPES_BY_ROLE.main
    const sides = RECIPES_BY_ROLE.side
    expect(mains.filter((r) => r.includesStaple !== true).length).toBeGreaterThanOrEqual(10)
    // 原材料が商品で変わる材料を含まない（アレルギー指定時も自動確定の候補に残れる）レシピ。
    expect(mains.filter((r) => !hasVaries(r)).length).toBeGreaterThanOrEqual(10)
    expect(sides.filter((r) => !hasVaries(r)).length).toBeGreaterThanOrEqual(10)
    expect(RECIPES_BY_ROLE.soup.filter((r) => !hasVaries(r)).length).toBeGreaterThanOrEqual(3)
    // 対照: varies の検出が働いている（ルウを使うカレーは該当する）。
    expect(hasVaries(byId("curry_rice"))).toBe(true)
    expect(hasVaries(byId("nikujaga"))).toBe(false)
  })

  it("カレーがある（「金曜はカレー」の固定に使える）", () => {
    const curries = RECIPES.filter((r) => r.tags.includes("curry"))
    expect(curries.length).toBeGreaterThanOrEqual(1)
    const curry = byId("curry_rice")
    expect(curry.title).toContain("カレー")
    expect(curry.role).toBe("main")
    expect(curry.includesStaple).toBe(true)
    expect(curry.tags).toContain("curry")
    expect(curry.ingredients.map((i) => i.ingredientId)).toContain("curry_roux")
    // 料理名に「カレー」を含むレシピは、必ず curry タグを持つ（名前とタグで結果が割れない）。
    for (const r of RECIPES.filter((x) => x.title.includes("カレー"))) {
      expect(r.tags, r.id).toContain("curry")
    }
  })

  it("タグは定義済みのものだけで、内容と食い違わない", () => {
    const tagIds: readonly string[] = RECIPE_TAGS.map((t) => t.id)
    expect(duplicates(tagIds)).toEqual([])
    for (const t of RECIPE_TAGS) expect(getRecipeTagLabel(t.id)).toBe(t.label)
    expect(getRecipeTagLabel("unknown_tag")).toBeUndefined()
    for (const r of RECIPES) {
      expect(r.tags.length, r.id).toBeGreaterThan(0)
      expect(duplicates(r.tags), r.id).toEqual([])
      for (const tag of r.tags) expect(tagIds, `${r.id} → ${tag}`).toContain(tag)
      // 時短は、時間の目安と必ず一致する。
      expect(r.tags.includes("quick"), r.id).toBe(r.minutes <= QUICK_MAX_MINUTES)
      // 肉の種類のタグは、その肉（アレルゲン）を材料に持つときだけ。
      for (const meat of ["chicken", "pork", "beef"]) {
        if (r.tags.includes(meat)) expect(usesAllergen(r, meat), `${r.id} → ${meat}`).toBe(true)
      }
      if (r.tags.includes("egg")) expect(usesAllergen(r, "egg"), r.id).toBe(true)
      if (r.tags.includes("tofu")) expect(usesSection(r, "soy"), r.id).toBe(true)
      if (r.tags.includes("fish")) expect(usesSection(r, "fish"), r.id).toBe(true)
      if (r.tags.includes("meatless")) expect(usesSection(r, "meat"), r.id).toBe(false)
      if (r.tags.includes("soup")) expect(r.role, r.id).toBe("soup")
    }
    // 逆向き: 主菜が肉・魚を使うなら、対応するタグを必ず持つ（「魚が食べたい」で漏れない）。
    for (const r of RECIPES_BY_ROLE.main) {
      for (const meat of ["chicken", "pork", "beef"]) {
        const usesMeat = r.ingredients.some((i) => {
          const def = getIngredient(i.ingredientId)
          return def?.section === "meat" && def.allergens.includes(meat)
        })
        expect(r.tags.includes(meat), `${r.id} → ${meat}`).toBe(usesMeat)
      }
      expect(r.tags.includes("fish"), r.id).toBe(usesSection(r, "fish"))
    }
  })

  it("確認していない主張（監修・栄養など）を利用者向けの文言に書いていない", () => {
    for (const r of RECIPES) {
      for (const text of recipeTexts(r)) {
        for (const word of FORBIDDEN_CLAIM_WORDS) {
          expect(text.includes(word), `${r.id}: ${word}`).toBe(false)
        }
      }
    }
    // 対照: 検査自体が働くこと（監修を含む文を拾える）。
    expect(FORBIDDEN_CLAIM_WORDS.some((w) => "管理栄養士監修のレシピ".includes(w))).toBe(true)
  })
})

// ── 取り分け案内（2 歳以降の幼児） ─────────────────────────────────

describe("取り分け案内（childServing）", () => {
  const SALTY_SEASONING = /しょうゆ|みそ|塩|ルウ|コンソメ|ソース|ケチャップ|マヨネーズ/u

  it("対応レシピが 3 件以上あり、主菜を含む", () => {
    expect(CHILD_SERVING_RECIPES.length).toBeGreaterThanOrEqual(3)
    expect(CHILD_SERVING_RECIPES.some((r) => r.role === "main")).toBe(true)
    expect(CHILD_SERVING_RECIPES.map((r) => r.id)).toEqual(
      RECIPES.filter((r) => r.childServing !== undefined).map((r) => r.id),
    )
  })

  it("対象は 2 歳以降で、出典に解決し、取り分ける位置が手順の範囲内にある", () => {
    for (const r of CHILD_SERVING_RECIPES) {
      const guide = r.childServing
      if (!guide) throw new Error(r.id)
      expect(guide.stage, r.id).toBe("toddler_2y_plus")
      expect(CHILD_SERVING_STAGE_LABELS[guide.stage].length, r.id).toBeGreaterThan(0)
      expect(guide.minAgeMonths, r.id).toBeGreaterThanOrEqual(24)
      expect(Number.isInteger(guide.separateBeforeStep), r.id).toBe(true)
      // 0 だと「何も調理する前」、手順数以上だと「存在しない手順の前」になる。
      expect(guide.separateBeforeStep, r.id).toBeGreaterThanOrEqual(1)
      expect(guide.separateBeforeStep, r.id).toBeLessThan(r.steps.length)
      expect(guide.instructions.length, r.id).toBeGreaterThanOrEqual(2)
      expect(guide.cautions.length, r.id).toBeGreaterThanOrEqual(2)
      for (const text of [...guide.instructions, ...guide.cautions]) {
        expect(text.trim().length, r.id).toBeGreaterThanOrEqual(4)
      }
      expect(guide.sourceIds.length, r.id).toBeGreaterThan(0)
      expect(duplicates(guide.sourceIds), r.id).toEqual([])
      for (const id of guide.sourceIds) {
        expect(getGuidanceSource(id), `${r.id} → ${id}`).toBeDefined()
      }
    }
  })

  it("取り分ける位置は、塩分のある調味料を入れる手順の直前である", () => {
    for (const r of CHILD_SERVING_RECIPES) {
      const at = r.childServing?.separateBeforeStep ?? -1
      // その手順で味付けが始まる。
      expect(r.steps[at], r.id).toMatch(SALTY_SEASONING)
      // それより前の手順では、まだ味付けしていない。
      for (const step of r.steps.slice(0, at)) {
        expect(step, r.id).not.toMatch(SALTY_SEASONING)
      }
      expect(r.childServing?.instructions[0], r.id).toMatch(/前に.*取り分ける/u)
      // 形・やわらかさ・薄味の注意を必ず持つ。
      const cautions = (r.childServing?.cautions ?? []).join("")
      expect(cautions, r.id).toMatch(/やわらか/u)
      expect(cautions, r.id).toMatch(/薄味/u)
    }
  })

  it("5 歳以下に避けるとされた食品・丸ごとでは与えない食品・年齢制約のある食材を含む料理は対応にしない", () => {
    const blocked = new Set([
      ...CHILD_SERVING_BLOCKED_INGREDIENT_IDS,
      ...CHILD_SERVING_ROUND_INGREDIENT_IDS,
    ])
    for (const id of blocked) expect(INGREDIENT_BY_ID.has(id), id).toBe(true)
    for (const id of ["konnyaku", "squid", "mochi", "peanuts", "soybean"]) {
      expect(blocked.has(id), id).toBe(true)
    }
    for (const r of CHILD_SERVING_RECIPES) {
      for (const i of r.ingredients) {
        expect(blocked.has(i.ingredientId), `${r.id} → ${i.ingredientId}`).toBe(false)
        expect(getIngredient(i.ingredientId)?.ageRule, `${r.id} → ${i.ingredientId}`).toBeUndefined()
      }
    }
  })

  it("対応していない料理は案内を持たない（一般案内があるだけで全料理を対応にしない）", () => {
    for (const id of ["tonjiru", "hamburg_steak", "chicken_karaage", "mapo_tofu", "steamed_rice"]) {
      expect(byId(id).childServing, id).toBeUndefined()
    }
    expect(CHILD_SERVING_RECIPES.length).toBeLessThan(RECIPES.length / 2)
    expect(CHILD_SERVING_UNSUPPORTED_TEXT).toBe("この料理の取り分け案内は未対応です")
  })

  it("肉じゃがは、調味料を入れる前に具を取り分ける（材料・手順に即している）", () => {
    const nikujaga = byId("nikujaga")
    const guide = nikujaga.childServing
    expect(guide?.separateBeforeStep).toBe(3)
    expect(nikujaga.steps[3]).toContain("しょうゆ")
    expect(guide?.instructions.join("")).toContain("じゃがいも")
    expect(guide?.instructions.join("")).toContain("小鍋")
  })

  it("はちみつを使う料理は実在し、取り分け対応ではなく、材料に注意書きを持つ", () => {
    const withHoney = RECIPES.filter((r) => r.ingredients.some((i) => i.ingredientId === "honey"))
    expect(withHoney.map((r) => r.id)).toEqual(["sweet_potato_honey_lemon"])
    for (const r of withHoney) {
      expect(r.childServing).toBeUndefined()
      expect(r.ingredients.find((i) => i.ingredientId === "honey")?.note).toContain("1歳未満")
    }
  })
})

// ── 子ども向け案内（出典つきデータ） ───────────────────────────────

describe("子ども向け案内", () => {
  const guidanceTexts = [
    CHILD_SERVING_SCOPE_NOTE,
    CHILD_SERVING_UNSUPPORTED_TEXT,
    SEPARATE_BEFORE_SEASONING_NOTE,
    ...WEANING_GENERAL_NOTES,
    ...WEANING_STAGE_GUIDES.flatMap((s) => [s.label, s.ageLabel, s.texture]),
    ...AGE_RESTRICTION_RULES.flatMap((r) => [r.title, r.body]),
    ...TODDLER_SERVING_NOTES.map((n) => n.text),
  ]

  it("出典表は ID が一意で、公的機関の URL・該当箇所・確認日を持つ", () => {
    expect(duplicates(GUIDANCE_SOURCES.map((s) => s.id))).toEqual([])
    for (const s of GUIDANCE_SOURCES) {
      expect(s.id).toMatch(SNAKE_CASE)
      expect(s.title.trim(), s.id).not.toBe("")
      expect(s.publisher.trim(), s.id).not.toBe("")
      expect(s.url, s.id).toMatch(/^https:\/\/www\.(mhlw|cfa|caa)\.go\.jp\//)
      expect(s.pages.trim(), s.id).not.toBe("")
      expect(s.confirmedOn, s.id).toMatch(YMD)
      expect(["direct", "summary"], s.id).toContain(s.verification)
      expect(s.supports.trim(), s.id).not.toBe("")
    }
    expect(getGuidanceSource("no_such_source")).toBeUndefined()
  })

  it("案内はすべて出典に解決し、出典を持たない案内は無い", () => {
    const groups: readonly (readonly { sourceIds: readonly string[] }[])[] = [
      WEANING_STAGE_GUIDES,
      AGE_RESTRICTION_RULES,
      TODDLER_SERVING_NOTES,
    ]
    for (const group of groups) {
      for (const item of group) {
        expect(item.sourceIds.length).toBeGreaterThan(0)
        for (const id of item.sourceIds) expect(getGuidanceSource(id), id).toBeDefined()
      }
    }
    // 出典表に、どこからも参照されない資料を置かない。
    const used = new Set<string>([
      ...groups.flatMap((g) => g.flatMap((item) => [...item.sourceIds])),
      ...CHILD_SERVING_RECIPES.flatMap((r) => [...(r.childServing?.sourceIds ?? [])]),
      ...INGREDIENTS.flatMap((i) => (i.ageRule ? [i.ageRule.sourceId] : [])),
    ])
    expect(GUIDANCE_SOURCES.filter((s) => !used.has(s.id)).map((s) => s.id)).toEqual([])
  })

  it("離乳段階の一般案内は 4 段階で、月齢は「頃」つきの目安。個別レシピの対応とは別と明記する", () => {
    expect(WEANING_STAGE_GUIDES.map((s) => s.label)).toEqual([
      "離乳初期", "離乳中期", "離乳後期", "離乳完了期",
    ])
    expect(WEANING_STAGE_GUIDES.map((s) => [s.approxFromMonths, s.approxToMonths])).toEqual([
      [5, 6], [7, 8], [9, 11], [12, 18],
    ])
    for (const s of WEANING_STAGE_GUIDES) {
      expect(s.ageLabel, s.id).toMatch(/頃$/u)
      expect(s.ageLabel, s.id).toContain(`${s.approxFromMonths}〜${s.approxToMonths}か月`)
      expect(s.texture.trim(), s.id).not.toBe("")
      expect(s.sourceIds, s.id).toContain("cfa_weaning_guide_2019")
    }
    expect(WEANING_GENERAL_NOTES.join("")).toContain("目安")
    expect(WEANING_GENERAL_NOTES.join("")).toMatch(/個別のレシピが離乳食に対応していることを示すものではありません/u)
    // 離乳段階に対応した個別レシピは無い（段階は toddler_2y_plus だけ）。
    expect(Object.keys(CHILD_SERVING_STAGE_LABELS)).toEqual(["toddler_2y_plus"])
    expect(CHILD_SERVING_SCOPE_NOTE).toContain("2歳以降")
  })

  it("はちみつの年齢制約は 1 歳未満・加熱しても不可・はちみつ入りの食品も対象", () => {
    const rule = AGE_RESTRICTION_RULES.find((r) => r.id === "honey_under_12m")
    expect(rule?.minAgeMonths).toBe(12)
    expect(rule?.ingredientIds).toEqual(["honey"])
    expect(rule?.body).toContain("1歳未満")
    expect(rule?.body).toContain("はちみつ入り")
    expect(rule?.body).toContain("加熱")
    expect(rule?.sourceIds).toContain("mhlw_honey_leaflet")
    for (const r of AGE_RESTRICTION_RULES) {
      for (const id of r.ingredientIds) expect(INGREDIENT_BY_ID.has(id), id).toBe(true)
    }
  })

  it("幼児の一般注意は薄味・形・避けたい食品・食べ方を持ち、一次資料で確認できていない事柄を書かない", () => {
    expect(duplicates(TODDLER_SERVING_NOTES.map((n) => n.id))).toEqual([])
    const topics = new Set(TODDLER_SERVING_NOTES.map((n) => n.topic))
    expect([...topics].sort()).toEqual(Object.keys(TODDLER_SERVING_TOPIC_LABELS).sort())
    const all = TODDLER_SERVING_NOTES.map((n) => n.text).join("")
    expect(all).toContain("薄味")
    expect(all).toContain("4等分")
    expect(all).toContain("ナッツ")
    // 食塩の目標量（1〜2 歳は男女で異なる）。
    const salt = TODDLER_SERVING_NOTES.find((n) => n.id === "light_seasoning")
    expect(salt?.text).toContain("3.0g未満")
    expect(salt?.text).toContain("2.5g未満")
    expect(salt?.text).toContain("3.5g未満")
    expect(salt?.sourceIds).toEqual(["mhlw_dri_2025_sodium"])
    // 確認できていないもの（こんにゃくゼリー、パン）は書かない。
    for (const text of guidanceTexts) {
      expect(text).not.toContain("ゼリー")
      expect(text).not.toContain("パン")
    }
  })

  it("安全を断定せず、監修の有無を偽らない", () => {
    expect(CHILD_GUIDANCE_DISCLAIMER).toMatch(/監修は受けていません/u)
    expect(CHILD_GUIDANCE_DISCLAIMER).toContain("一般的な注意")
    const childServingTexts = CHILD_SERVING_RECIPES.flatMap((r) => [
      ...(r.childServing?.instructions ?? []),
      ...(r.childServing?.cautions ?? []),
    ])
    for (const text of [...guidanceTexts, ...childServingTexts, CHILD_GUIDANCE_DISCLAIMER]) {
      expect(text).not.toMatch(/安全です|安心して|そのまま食べられ|問題ありません|大丈夫/u)
    }
    // 監修の語は、受けていないと明示する 1 文言にだけ現れる。
    for (const text of guidanceTexts) {
      for (const word of FORBIDDEN_CLAIM_WORDS) expect(text.includes(word), word).toBe(false)
    }
    expect(CHILD_GUIDANCE_DISCLAIMER).not.toContain("管理栄養士")
    expect(CHILD_GUIDANCE_DISCLAIMER).not.toContain("栄養バランス")
  })
})

// ── 売場 ───────────────────────────────────────────────────────────

describe("売場の表示名と並び順", () => {
  it("区分は一意で、表示名の表と一致する", () => {
    expect(duplicates(STORE_SECTIONS.map((s) => s.id))).toEqual([])
    expect(duplicates(STORE_SECTIONS.map((s) => s.label))).toEqual([])
    expect(STORE_SECTIONS.map((s) => s.id).sort()).toEqual(Object.keys(STORE_SECTION_LABELS).sort())
    for (const s of STORE_SECTIONS) {
      expect(STORE_SECTION_LABELS[s.id]).toBe(s.label)
      expect(storeSectionLabel(s.id)).toBe(s.label)
    }
  })

  it("辞書が使う区分はすべて定義済みで、どの区分にも食材がある", () => {
    const used = new Set(INGREDIENTS.map((i) => i.section))
    expect([...used].sort()).toEqual(STORE_SECTIONS.map((s) => s.id).sort())
  })

  it("並び順は配列の順で、未知の区分は末尾・「その他」表示へ退化する", () => {
    expect(STORE_SECTIONS.map((s) => storeSectionOrder(s.id))).toEqual(
      STORE_SECTIONS.map((_, i) => i),
    )
    expect(storeSectionOrder("vegetable")).toBeLessThan(storeSectionOrder("seasoning"))
    expect(storeSectionOrder("frozen")).toBe(STORE_SECTIONS.length)
    expect(storeSectionLabel("frozen")).toBe(STORE_SECTION_LABELS.other)
  })
})

// ── 引き当て ───────────────────────────────────────────────────────

describe("ID の引き当て", () => {
  it("既知の ID は定義を返し、未知の ID は undefined（落とさない）", () => {
    expect(getRecipe("curry_rice")?.title).toBe("カレーライス")
    expect(getIngredient("onion")?.name).toBe("玉ねぎ")
    expect(getAllergen("wheat")?.name).toBe("小麦")
    expect(getRecipe("no_such_recipe")).toBeUndefined()
    expect(getIngredient("no_such_ingredient")).toBeUndefined()
    expect(getAllergen("no_such_allergen")).toBeUndefined()
    // 名前では引けない（ID の完全一致だけ）。
    expect(getRecipe("カレーライス")).toBeUndefined()
    expect(getIngredient("玉ねぎ")).toBeUndefined()
  })
})
