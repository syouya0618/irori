/**
 * 食材名の照合用正規化と、まとめ入力の解釈。
 *
 * 照合の規則（旧 Irori の欠陥 (b)「部分文字列の誤一致」を式ごと直したもの）:
 * - 比較する両辺へ同じ fold を掛け、**完全一致（表示名・別名）だけ**で辞書 ID へ解決する。
 * - `includes` による部分一致はしない（「豚」で「豚骨」「豚バラ」に解決しない）。
 * - 同じ名前が複数の食材に当たる辞書の衝突は、推測で選ばず未解決（null）にする。
 * - 解決できない名前は未解決のまま返す（呼び出し側が名前のまま保持する）。
 */

import type { IngredientDef, Quantity, UnitId } from "./types"

/** 小書き仮名→大書き仮名（「キヤベツ」と「キャベツ」を同一視する。両辺に掛けるので照合は壊れない）。 */
const SMALL_TO_LARGE_KANA: Readonly<Record<string, string>> = {
  "ぁ": "あ", "ぃ": "い", "ぅ": "う", "ぇ": "え", "ぉ": "お",
  "っ": "つ", "ゃ": "や", "ゅ": "ゆ", "ょ": "よ", "ゎ": "わ",
  "ゕ": "か", "ゖ": "け",
}

/**
 * 照合専用の正規化（表示名は変えない）。
 * NFKC → 空白（半角/全角）と中点を除去 → カタカナをひらがなへ → 小書き仮名を大書きへ → 英字を小文字へ。
 * 漢字とかなの表記ゆれ（玉ねぎ / たまねぎ）は吸収しない。辞書の別名で持つ。
 */
export function foldName(input: string): string {
  const nfkc = input.normalize("NFKC")
  let out = ""
  for (const ch of nfkc) {
    if (/\s/.test(ch) || ch === "・") continue
    const code = ch.codePointAt(0) ?? 0
    // カタカナ（U+30A1〜U+30F6）はひらがなへ。範囲外（ー 等）は素通し
    if (code >= 0x30a1 && code <= 0x30f6) {
      const hira = String.fromCodePoint(code - 0x60)
      out += SMALL_TO_LARGE_KANA[hira] ?? hira
    } else {
      out += SMALL_TO_LARGE_KANA[ch] ?? ch
    }
  }
  return out.toLowerCase()
}

// ── 食材辞書の索引 ─────────────────────────────────────────────────

export interface IngredientIndex {
  readonly kind: "ingredient-index"
  readonly byId: ReadonlyMap<string, IngredientDef>
  /** fold 済みの表示名・別名 → 食材 ID（衝突した名前は入らない）。 */
  readonly idByFoldedName: ReadonlyMap<string, string>
  /** 複数の食材に当たった名前（fold 済み）→ 食材 ID の一覧。カタログ検査用。 */
  readonly ambiguousNames: ReadonlyMap<string, readonly string[]>
}

/** 辞書は配列のままでも索引でも渡せる。繰り返し引くときは `buildIngredientIndex` を一度だけ呼ぶ。 */
export type IngredientDict = readonly IngredientDef[] | IngredientIndex

function isIndex(dict: IngredientDict): dict is IngredientIndex {
  return !Array.isArray(dict) && (dict as IngredientIndex).kind === "ingredient-index"
}

export function buildIngredientIndex(dict: readonly IngredientDef[]): IngredientIndex {
  const byId = new Map<string, IngredientDef>()
  const owners = new Map<string, string[]>()
  for (const def of dict) {
    if (byId.has(def.id)) continue
    byId.set(def.id, def)
    for (const raw of [def.name, ...def.aliases]) {
      const folded = foldName(raw)
      if (folded === "") continue
      const list = owners.get(folded) ?? []
      if (!list.includes(def.id)) list.push(def.id)
      owners.set(folded, list)
    }
  }
  const idByFoldedName = new Map<string, string>()
  const ambiguousNames = new Map<string, readonly string[]>()
  for (const [folded, ids] of owners) {
    if (ids.length === 1) idByFoldedName.set(folded, ids[0])
    else ambiguousNames.set(folded, ids)
  }
  return { kind: "ingredient-index", byId, idByFoldedName, ambiguousNames }
}

export function toIngredientIndex(dict: IngredientDict): IngredientIndex {
  return isIndex(dict) ? dict : buildIngredientIndex(dict)
}

/**
 * 名前を辞書の食材 ID へ解決する。正規化後の完全一致（表示名・別名）だけ。
 * 一致なし・空文字・辞書内で衝突している名前は null。
 */
export function resolveIngredientId(name: string, dict: IngredientDict): string | null {
  const folded = foldName(name)
  if (folded === "") return null
  return toIngredientIndex(dict).idByFoldedName.get(folded) ?? null
}

// ── 数量の緩い解釈 ─────────────────────────────────────────────────

/** 数値の後ろに付く単位の語（NFKC・小文字化した後の表記）。 */
const SUFFIX_UNIT_WORDS: readonly (readonly [string, UnitId])[] = [
  ["kg", "kg"], ["キロ", "kg"],
  ["g", "g"], ["グラム", "g"],
  ["ml", "ml"], ["cc", "ml"], ["ミリリットル", "ml"],
  ["l", "l"], ["リットル", "l"],
  ["個", "piece"], ["こ", "piece"], ["コ", "piece"], ["玉", "piece"],
  ["パック", "pack"],
  ["束", "bunch"], ["把", "bunch"], ["わ", "bunch"],
  ["切れ", "slice"], ["切", "slice"],
  ["かけ", "clove"], ["片", "clove"],
  ["缶", "can"],
  ["枚", "sheet"],
  ["本", "stalk"],
  ["袋", "bag"],
  ["丁", "block"],
  ["杯", "bowl"], ["膳", "bowl"],
  ["カップ", "cup"],
]
/**
 * 数値の後ろに付くが、レシピの単位へ換算できない数え方（NFKC・小文字化した後の表記）。
 * 数量としては読まない（`quantity: null` = 数量不明）。ただし食材名の一部や別の食材にはせず、
 * 原文を `quantityText` に残して確認画面で見せる（「米 2合」「しめじ 1株」「卵 1ケース」）。
 */
const UNCONVERTIBLE_COUNTER_WORDS: readonly string[] = [
  "合", "升", "株", "房", "山", "節", "腹", "さく", "柵", "尾", "匹", "羽", "貫", "粒", "斤",
  "ケース", "箱", "瓶", "びん", "ボトル", "ロール", "ブロック", "セット", "皿", "食", "人前", "人分",
]
/** 数値の前に付く単位の語。 */
const PREFIX_UNIT_WORDS: readonly (readonly [string, UnitId])[] = [
  ["大さじ", "tbsp"], ["おおさじ", "tbsp"], ["大匙", "tbsp"],
  ["小さじ", "tsp"], ["こさじ", "tsp"], ["小匙", "tsp"],
  ["カップ", "cup"],
]
const NON_NUMERIC_WORDS: readonly (readonly [string, UnitId])[] = [
  ["適量", "to_taste"], ["適宜", "to_taste"],
  ["少々", "pinch"], ["ひとつまみ", "pinch"],
]

const MAX_AMOUNT = 100_000
const NUMBER = String.raw`\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?`

function byLengthDesc(words: readonly (readonly [string, UnitId])[]): string {
  return [...words]
    .map(([word]) => word)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .join("|")
}

const SUFFIX_PATTERN = new RegExp(
  String.raw`^(.*?)(${NUMBER})\s*(${byLengthDesc(SUFFIX_UNIT_WORDS)})$`,
)
const PREFIX_PATTERN = new RegExp(
  String.raw`^(.*?)(${byLengthDesc(PREFIX_UNIT_WORDS)})\s*(${NUMBER})$`,
)
const UNCONVERTIBLE_PATTERN = new RegExp(
  String.raw`^(.*?)(${NUMBER})\s*(${[...UNCONVERTIBLE_COUNTER_WORDS]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .join("|")})$`,
)
const NON_NUMERIC_PATTERN = new RegExp(String.raw`^(.*?)(${byLengthDesc(NON_NUMERIC_WORDS)})$`)
const BARE_NUMBER_PATTERN = new RegExp(String.raw`^${NUMBER}$`)

function lookupUnit(words: readonly (readonly [string, UnitId])[], word: string): UnitId | null {
  return words.find(([candidate]) => candidate === word)?.[1] ?? null
}

function parseNumber(text: string): number | null {
  const [numerator, denominator] = text.split("/")
  const top = Number(numerator)
  const bottom = denominator === undefined ? 1 : Number(denominator)
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null
  const value = top / bottom
  return value > 0 && value <= MAX_AMOUNT ? value : null
}

/** 解釈の前処理: NFKC、前後の空白除去、英字の小文字化（単位 `G` `ML` を拾うため）。 */
function prepare(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase()
}

interface SplitResult {
  name: string
  quantity: Quantity | null
  /** 数量として読もうとした部分の原文（解釈に失敗したときも残す）。 */
  quantityText: string | null
}

function stripNameTail(name: string): string {
  return name.replace(/[\s:×]+$/u, "").trim()
}

function splitNameAndQuantity(text: string): SplitResult {
  const prepared = prepare(text)
  const original = text.normalize("NFKC").trim()
  const nameOf = (lowered: string) => stripNameTail(original.slice(0, lowered.length))

  const suffix = SUFFIX_PATTERN.exec(prepared)
  if (suffix) {
    const unit = lookupUnit(SUFFIX_UNIT_WORDS, suffix[3])
    const amount = parseNumber(suffix[2])
    const quantityText = original.slice(suffix[1].length).trim()
    return {
      name: nameOf(suffix[1]),
      quantity: unit && amount !== null ? { amount, unit } : null,
      quantityText,
    }
  }
  const prefix = PREFIX_PATTERN.exec(prepared)
  if (prefix) {
    const unit = lookupUnit(PREFIX_UNIT_WORDS, prefix[2])
    const amount = parseNumber(prefix[3])
    const quantityText = original.slice(prefix[1].length).trim()
    return {
      name: nameOf(prefix[1]),
      quantity: unit && amount !== null ? { amount, unit } : null,
      quantityText,
    }
  }
  const unconvertible = UNCONVERTIBLE_PATTERN.exec(prepared)
  if (unconvertible) {
    // 換算できない数え方。数量は不明のまま、原文だけを残す
    return {
      name: nameOf(unconvertible[1]),
      quantity: null,
      quantityText: original.slice(unconvertible[1].length).trim(),
    }
  }
  const nonNumeric = NON_NUMERIC_PATTERN.exec(prepared)
  if (nonNumeric) {
    const unit = lookupUnit(NON_NUMERIC_WORDS, nonNumeric[2])
    return {
      name: nameOf(nonNumeric[1]),
      quantity: unit ? { amount: null, unit } : null,
      quantityText: original.slice(nonNumeric[1].length).trim(),
    }
  }
  return { name: original, quantity: null, quantityText: null }
}

/**
 * 「2個」「200ml」「大さじ1」「1/2本」「少々」のように、**全体が数量**の文字列を解釈する。
 * 名前が混じる・単位が無い・0 以下・上限超えは null。
 */
export function parseQuantityText(text: string): Quantity | null {
  const split = splitNameAndQuantity(text)
  return split.name === "" ? split.quantity : null
}

export interface ParsedIngredientInput {
  /** 入力された名前（表示用。fold はしない）。 */
  name: string
  /** 解釈できなければ null（数量不明として扱う）。 */
  quantity: Quantity | null
  /** 数量として読めなかった数字など。確認画面で見せるために残す。 */
  quantityText: string | null
}

/**
 * 1 件分の入力（「玉ねぎ 2個」「牛乳200ml」「卵」）を名前と数量へ分ける。
 * 数量だけの入力（「200ml」）は名前として残し、数量は null にする。
 */
export function parseIngredientLine(line: string): ParsedIngredientInput {
  const split = splitNameAndQuantity(line)
  if (split.name === "") {
    return { name: line.normalize("NFKC").trim(), quantity: null, quantityText: null }
  }
  return split
}

const CHUNK_SEPARATOR = /[\n\r,、。;]+/u
const MAX_BULK_ITEMS = 100

/** 全体が「数値 + 換算できない数え方」（「2合」「1株」「1ケース」）か。 */
function isUnconvertibleQuantity(token: string): boolean {
  const match = UNCONVERTIBLE_PATTERN.exec(prepare(token))
  return match !== null && match[1] === ""
}

/** 「2 個」「大さじ 2」のように空白で割れた数量を 1 つの語へ戻す。 */
function mergeSplitUnits(tokens: readonly string[]): string[] {
  const merged: string[] = []
  for (let i = 0; i < tokens.length; i += 1) {
    const current = tokens[i]
    const next = tokens[i + 1]
    const startsQuantity =
      BARE_NUMBER_PATTERN.test(prepare(current)) ||
      lookupUnit(PREFIX_UNIT_WORDS, prepare(current)) !== null
    const joinsToQuantity =
      next !== undefined &&
      (parseQuantityText(`${current}${next}`) !== null || isUnconvertibleQuantity(`${current}${next}`))
    if (next !== undefined && startsQuantity && joinsToQuantity) {
      merged.push(`${current}${next}`)
      i += 1
      continue
    }
    merged.push(current)
  }
  return merged
}

/**
 * まとめ入力を 1 件ずつへ分ける（改行・読点・カンマ・空白）。
 * 空白で区切られた「数量だけ」の語は直前の名前へ付ける（「玉ねぎ 2個」）。
 * 単位の無い数字（「豚こま 300」）と、換算できない数え方（「米 2合」「しめじ 1株」）は数量にせず、
 * 別の食材にもせず、直前の名前の `quantityText` に残す（数量は不明のまま）。
 * 件数は 100 件で打ち切る（超過分は捨てず `truncated` で知らせる）。
 */
export function parseBulkInput(text: string): {
  items: ParsedIngredientInput[]
  truncated: boolean
} {
  const items: ParsedIngredientInput[] = []
  for (const chunk of text.normalize("NFKC").split(CHUNK_SEPARATOR)) {
    const tokens = mergeSplitUnits(chunk.split(/\s+/u).filter((token) => token !== ""))
    let previous: ParsedIngredientInput | null = null
    for (const token of tokens) {
      const quantity = parseQuantityText(token)
      const isBareNumber = BARE_NUMBER_PATTERN.test(prepare(token))
      if (previous && previous.quantity === null && previous.quantityText === null) {
        if (quantity !== null) {
          previous.quantity = quantity
          previous.quantityText = token
          continue
        }
        if (isBareNumber || isUnconvertibleQuantity(token)) {
          previous.quantityText = token
          continue
        }
      }
      previous = parseIngredientLine(token)
      items.push(previous)
    }
  }
  return {
    items: items.slice(0, MAX_BULK_ITEMS),
    truncated: items.length > MAX_BULK_ITEMS,
  }
}

/** まとめ入力の名前だけを返す（重複は fold 後の一致で 1 つにまとめる）。 */
export function splitBulkNames(text: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const item of parseBulkInput(text).items) {
    const folded = foldName(item.name)
    if (folded === "" || seen.has(folded)) continue
    seen.add(folded)
    names.push(item.name)
  }
  return names
}
