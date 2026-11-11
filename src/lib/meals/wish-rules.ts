/**
 * 希望（自由入力）の、生成 AI を使わない解釈。
 *
 * 「金曜はカレー」「魚多め」「30分以内」「肉は少なめ」程度の短い文を `WishConstraints` へ直す。
 * - 入力はデータとして扱う（命令として実行しない。長さの上限あり）。
 * - 料理の固定は、渡された候補（必須除外を適用済みのレシピ）からだけ選ぶ。
 * - 解釈できなかった部分は捨てず、`unparsed` に原文のまま返す。
 * - ここで作るのは希望だけ。必須除外や在庫の判定は変えない。
 */

import { daysBetweenYmd, isValidYmd, shiftYmd, weekStartMonday } from "@/lib/utils/date-jst"

import { foldName } from "./normalize"
import type { DishRole, RecipeDef, WishConstraints } from "./types"

export const MAX_WISH_LENGTH = 200
export const MIN_WISH_MINUTES = 5
export const MAX_WISH_MINUTES = 180
const MAX_PREFER_RECIPES = 5

/**
 * 希望の語 → レシピのタグ候補。実際に使うのは、渡された候補のどれかが持つタグだけ。
 * 語は `foldName` 後の完全一致で引く。
 */
export const DEFAULT_WISH_TAG_WORDS: readonly (readonly [string, readonly string[]])[] = [
  ["魚", ["fish", "seafood"]],
  ["さかな", ["fish", "seafood"]],
  ["お魚", ["fish", "seafood"]],
  ["魚料理", ["fish", "seafood"]],
  ["肉", ["pork", "chicken", "beef", "ground_meat"]],
  ["お肉", ["pork", "chicken", "beef", "ground_meat"]],
  ["肉料理", ["pork", "chicken", "beef", "ground_meat"]],
  ["豚", ["pork"]],
  ["豚肉", ["pork"]],
  ["鶏", ["chicken"]],
  ["鶏肉", ["chicken"]],
  ["とり肉", ["chicken"]],
  ["チキン", ["chicken"]],
  ["牛", ["beef"]],
  ["牛肉", ["beef"]],
  ["ひき肉", ["ground_meat"]],
  ["野菜", ["vegetable"]],
  ["卵", ["egg"]],
  ["たまご", ["egg"]],
  ["豆腐", ["tofu"]],
  ["和食", ["japanese"]],
  ["和風", ["japanese"]],
  ["洋食", ["western"]],
  ["洋風", ["western"]],
  ["中華", ["chinese"]],
  ["カレー", ["curry"]],
  ["麺", ["noodle"]],
  ["めん", ["noodle"]],
  ["丼", ["donburi"]],
  ["どんぶり", ["donburi"]],
  ["パン", ["bread"]],
  ["煮物", ["simmer"]],
  ["炒め物", ["stir_fry"]],
  ["焼き物", ["pan_fry"]],
  ["揚げ物", ["deep_fry"]],
  ["蒸し物", ["steam"]],
  ["サラダ", ["dressed"]],
  ["あえ物", ["dressed"]],
  ["時短", ["quick"]],
  ["簡単", ["quick"]],
  ["手早く", ["quick"]],
]

/**
 * 固定・優先の候補。`role` は「同じ日・同じ区分へ 2 つ固定しない」の判定に使う
 * （無ければ区分を確かめられないので、同じ日の 2 つ目は固定にしない）。
 */
export type WishCandidate = Pick<RecipeDef, "id" | "title" | "tags"> & { role?: DishRole }

/** 同じ日・同じ区分に先の固定があり、固定にしなかった希望。 */
export interface WishPinConflict {
  /** 希望の原文（その部分）。 */
  text: string
  date: string
  /** 固定にしなかった料理。 */
  recipeId: string
  /** 先に固定した料理（こちらを残した）。 */
  keptRecipeId: string
  reason: "same_slot"
}

export interface WishParseInput {
  text: string
  startDate: string
  /** 1〜7。 */
  days: number
  /** 今日（「今日」「明日」の基準。YYYY-MM-DD）。 */
  today: string
  /** 必須除外を適用済みの候補。固定・優先はこの中からだけ選ぶ。 */
  recipes: readonly WishCandidate[]
  tagWords?: readonly (readonly [string, readonly string[]])[]
}

export type WishNote =
  | { kind: "pin"; text: string; date: string; recipeId: string }
  | { kind: "prefer_tag" | "avoid_tag"; text: string; tags: string[] }
  | { kind: "prefer_recipe"; text: string; recipeIds: string[] }
  | { kind: "max_minutes"; text: string; minutes: number }

export interface WishParseResult {
  constraints: WishConstraints
  /** 解釈できた部分（確認表示用）。 */
  understood: WishNote[]
  /**
   * 解釈できなかった部分（原文）。同じ日・同じ区分への 2 つ目の固定（`pinConflicts`）の原文も入る
   * （固定にしなかったことが、この一覧だけを見る画面でも分かるように）。
   */
  unparsed: string[]
  /**
   * 同じ日・同じ区分に先の固定があったため、固定にしなかった希望。
   * どちらを採るかは利用者が決める（「同じ日に主菜を 2 つは固定できません」と知らせる）。
   */
  pinConflicts: WishPinConflict[]
  /** 長さの上限で切り捨てた。 */
  truncated: boolean
}

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"] as const
const WEEKDAY_PATTERN = /([月火水木金土日])曜日?/gu
const RELATIVE_DAYS: readonly (readonly [string, number])[] = [
  ["明後日", 2], ["あさって", 2], ["明日", 1], ["あした", 1], ["あす", 1], ["今日", 0], ["きょう", 0],
]
const MONTH_DAY_PATTERN = /(\d{1,2})\s*(?:\/|月)\s*(\d{1,2})\s*日?/gu
const DAY_ONLY_PATTERN = /(?<![\d/月])(\d{1,2})日/gu
const MINUTES_PATTERN =
  /(\d{1,3})\s*分\s*(?:以内|以下|まで|くらい|程度)?(?:で|に)?(?:作りたい|作れるもの|作れる|できるもの|がいい|希望)?/u

const PREFER_SUFFIX = /(?:を|は|が)?(?:多め|おおめ|中心|メイン|たっぷり|増やして|増やす)(?:に|で)?$/u
const AVOID_SUFFIX = /(?:を|は|が)?(?:少なめ|すくなめ|控えめ|ひかえめ|なし|抜き|ぬき|減らして|減らす)(?:に|で)?$/u
const LEADING_PARTICLE = /^[はにのをがでもと:]/u
const TRAILING_PHRASES =
  /(?:にしてほしい|にして|にする|にしたい|がいいな|がいい|が良い|が食べたい|を食べたい|食べたい|希望)$/u
const TRAILING_PARTICLE = /[はにのをがでも]$/u

interface Range {
  dates: string[]
  today: string
}

/** 月曜 = 0 … 日曜 = 6。 */
function weekdayIndex(ymd: string): number | null {
  const monday = weekStartMonday(ymd)
  return monday === null ? null : daysBetweenYmd(monday, ymd)
}

interface DateHit {
  date: string | null
  text: string
}

function findDates(part: string, range: Range): DateHit[] {
  const hits: DateHit[] = []
  for (const match of part.matchAll(WEEKDAY_PATTERN)) {
    const target = WEEKDAYS.indexOf(match[1] as (typeof WEEKDAYS)[number])
    hits.push({ date: range.dates.find((d) => weekdayIndex(d) === target) ?? null, text: match[0] })
  }
  for (const [word, offset] of RELATIVE_DAYS) {
    if (!part.includes(word) || hits.some((hit) => hit.text.includes(word))) continue
    const date = shiftYmd(range.today, offset)
    hits.push({ date: range.dates.includes(date) ? date : null, text: word })
  }
  for (const match of part.matchAll(MONTH_DAY_PATTERN)) {
    const suffix = `-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`
    hits.push({ date: range.dates.find((d) => d.endsWith(suffix)) ?? null, text: match[0] })
  }
  if (!hits.some((hit) => /\d/u.test(hit.text))) {
    for (const match of part.matchAll(DAY_ONLY_PATTERN)) {
      const suffix = `-${match[1].padStart(2, "0")}`
      hits.push({ date: range.dates.find((d) => d.endsWith(suffix)) ?? null, text: match[0] })
    }
  }
  return hits
}

/**
 * 料理や食材を表す語の候補を、削る量の少ない順に返す。
 * 助詞に見える文字で始まる・終わる料理名（「にら玉」「肉じゃが」）を壊さないよう、
 * 元の語を先に試し、合わなければ 1 文字ずつ助詞を外す。
 */
function wordVariants(text: string): string[] {
  const variants: string[] = []
  const push = (value: string) => {
    const trimmed = value.trim()
    if (trimmed !== "" && !variants.includes(trimmed)) variants.push(trimmed)
  }
  const withoutPhrase = text.trim().replace(TRAILING_PHRASES, "")
  for (const tail of [text, withoutPhrase, withoutPhrase.trim().replace(TRAILING_PARTICLE, "")]) {
    let current = tail.trim()
    push(current)
    while (LEADING_PARTICLE.test(current)) {
      current = current.slice(1).trim()
      push(current)
    }
  }
  return variants
}

interface Matcher {
  recipes: readonly WishCandidate[]
  tagsOfWord: (word: string) => string[]
}

function makeMatcher(input: WishParseInput): Matcher {
  const available = new Set(input.recipes.flatMap((recipe) => recipe.tags))
  const table = new Map<string, readonly string[]>()
  for (const [word, tags] of input.tagWords ?? DEFAULT_WISH_TAG_WORDS) table.set(foldName(word), tags)
  return {
    recipes: input.recipes,
    tagsOfWord: (word) => (table.get(foldName(word)) ?? []).filter((tag) => available.has(tag)),
  }
}

function byCloseness(a: WishCandidate, b: WishCandidate): number {
  return a.title.length - b.title.length || a.id.localeCompare(b.id)
}

function tagsOfText(text: string, matcher: Matcher): string[] {
  for (const variant of wordVariants(text)) {
    const tags = matcher.tagsOfWord(variant)
    if (tags.length > 0) return tags
  }
  return []
}

function recipesOfText(text: string, matcher: Matcher): WishCandidate[] {
  for (const variant of wordVariants(text)) {
    const recipes = findRecipes(variant, matcher)
    if (recipes.length > 0) return recipes
  }
  return []
}

/** 料理を表す語に合う候補。料理名の完全一致 → 料理名に含む → タグ、の順で最初に見つかった組。 */
function findRecipes(word: string, matcher: Matcher): WishCandidate[] {
  const folded = foldName(word)
  if (folded === "") return []
  const exact = matcher.recipes.filter((recipe) => foldName(recipe.title) === folded)
  if (exact.length > 0) return [...exact].sort(byCloseness)
  if (folded.length >= 2) {
    const partial = matcher.recipes.filter((recipe) => foldName(recipe.title).includes(folded))
    if (partial.length > 0) return [...partial].sort(byCloseness)
  }
  const tags = matcher.tagsOfWord(word)
  if (tags.length === 0) return []
  return matcher.recipes
    .filter((recipe) => recipe.tags.some((tag) => tags.includes(tag)))
    .sort(byCloseness)
}

interface Draft {
  pins: { date: string; recipeId: string }[]
  preferTags: string[]
  avoidTags: string[]
  maxMinutes: number | null
  preferRecipeIds: string[]
  understood: WishNote[]
  pinConflicts: WishPinConflict[]
}

function addUnique(target: string[], values: readonly string[]): void {
  for (const value of values) if (!target.includes(value)) target.push(value)
}

function parseMinutes(part: string, draft: Draft): boolean {
  const match = MINUTES_PATTERN.exec(part)
  if (!match || part.replace(match[0], "").trim() !== "") return false
  const minutes = Number(match[1])
  if (minutes < MIN_WISH_MINUTES || minutes > MAX_WISH_MINUTES) return false
  draft.maxMinutes = draft.maxMinutes === null ? minutes : Math.min(draft.maxMinutes, minutes)
  draft.understood.push({ kind: "max_minutes", text: part, minutes })
  return true
}

function parsePins(part: string, range: Range, matcher: Matcher, draft: Draft): boolean {
  const hits = findDates(part, range)
  if (hits.length === 0) return false
  if (hits.some((hit) => hit.date === null)) return false
  let rest = part
  for (const hit of hits) rest = rest.replace(hit.text, "")
  const recipe = recipesOfText(rest, matcher)[0]
  if (!recipe) return false
  for (const hit of hits) {
    const date = hit.date as string
    if (draft.pins.some((pin) => pin.date === date && pin.recipeId === recipe.id)) continue
    // 同じ日・同じ区分へ 2 つは固定しない（どちらを採るかをここで決めない。先の固定を残して知らせる）。
    // 区分が分からない候補どうしは、同じ区分かもしれないので固定にしない側へ倒す
    const taken = draft.pins.find((pin) => {
      if (pin.date !== date) return false
      const pinnedRole = matcher.recipes.find((candidate) => candidate.id === pin.recipeId)?.role
      return pinnedRole === undefined || recipe.role === undefined || pinnedRole === recipe.role
    })
    if (taken) {
      draft.pinConflicts.push({ text: part, date, recipeId: recipe.id, keptRecipeId: taken.recipeId, reason: "same_slot" })
      continue
    }
    draft.pins.push({ date, recipeId: recipe.id })
    draft.understood.push({ kind: "pin", text: part, date, recipeId: recipe.id })
  }
  return true
}

function parseTagAmount(part: string, matcher: Matcher, draft: Draft): boolean {
  for (const [pattern, kind] of [[PREFER_SUFFIX, "prefer_tag"], [AVOID_SUFFIX, "avoid_tag"]] as const) {
    if (!pattern.test(part)) continue
    const tags = tagsOfText(part.replace(pattern, ""), matcher)
    if (tags.length === 0) return false
    addUnique(kind === "prefer_tag" ? draft.preferTags : draft.avoidTags, tags)
    draft.understood.push({ kind, text: part, tags })
    return true
  }
  return false
}

function parseDishWish(part: string, matcher: Matcher, draft: Draft): boolean {
  const tags = tagsOfText(part, matcher)
  if (tags.length > 0) {
    addUnique(draft.preferTags, tags)
    draft.understood.push({ kind: "prefer_tag", text: part, tags })
    return true
  }
  const recipeIds = recipesOfText(part, matcher)
    .slice(0, MAX_PREFER_RECIPES)
    .map((recipe) => recipe.id)
  if (recipeIds.length === 0) return false
  addUnique(draft.preferRecipeIds, recipeIds)
  draft.understood.push({ kind: "prefer_recipe", text: part, recipeIds })
  return true
}

function parsePart(part: string, range: Range, matcher: Matcher, draft: Draft): boolean {
  return (
    parseMinutes(part, draft) ||
    parsePins(part, range, matcher, draft) ||
    (findDates(part, range).length === 0 &&
      (parseTagAmount(part, matcher, draft) || parseDishWish(part, matcher, draft)))
  )
}

/**
 * 希望文を規則だけで解釈する。同じ入力からは同じ結果。
 * 期間が不正なら、何も解釈せず全文を `unparsed` に返す。
 */
export function parseWish(input: WishParseInput): WishParseResult {
  const normalized = input.text.normalize("NFKC").trim()
  const truncated = normalized.length > MAX_WISH_LENGTH
  const text = normalized.slice(0, MAX_WISH_LENGTH)
  const draft: Draft = {
    pins: [],
    preferTags: [],
    avoidTags: [],
    maxMinutes: null,
    preferRecipeIds: [],
    understood: [],
    pinConflicts: [],
  }
  const unparsed: string[] = []
  const validRange =
    isValidYmd(input.startDate) && isValidYmd(input.today) && Number.isInteger(input.days) && input.days >= 1 && input.days <= 7
  if (!validRange) {
    return {
      constraints: toConstraints(draft),
      understood: [],
      unparsed: text === "" ? [] : [text],
      pinConflicts: [],
      truncated,
    }
  }
  const range: Range = {
    dates: Array.from({ length: input.days }, (_, i) => shiftYmd(input.startDate, i)),
    today: input.today,
  }
  const matcher = makeMatcher(input)
  for (const segment of text.split(/[\n\r、。,;]+/u)) {
    const whole = segment.trim()
    if (whole === "") continue
    if (parsePart(whole, range, matcher, draft)) continue
    // 空白で並べた複数の希望（「金曜はカレー 魚多め」）を 1 つずつ試す
    const parts = whole.split(/\s+/u).filter((part) => part !== "")
    if (parts.length < 2) {
      unparsed.push(whole)
      continue
    }
    for (const part of parts) {
      if (!parsePart(part, range, matcher, draft)) unparsed.push(part)
    }
  }
  // 固定にしなかった希望は、読み取れた希望として見せない。原文を未解釈の一覧へ足す
  for (const conflict of draft.pinConflicts) {
    if (!unparsed.includes(conflict.text)) unparsed.push(conflict.text)
  }
  return {
    constraints: toConstraints(draft),
    understood: draft.understood,
    unparsed,
    pinConflicts: draft.pinConflicts,
    truncated,
  }
}

function toConstraints(draft: Draft): WishConstraints {
  return {
    pins: draft.pins,
    // 同じタグを「多め」と「少なめ」の両方に言われたら、控える側を優先する
    preferTags: draft.preferTags.filter((tag) => !draft.avoidTags.includes(tag)),
    avoidTags: draft.avoidTags,
    maxMinutes: draft.maxMinutes,
    preferRecipeIds: draft.preferRecipeIds,
  }
}

/** 何も希望が無い状態。 */
export const EMPTY_WISH: WishConstraints = {
  pins: [],
  preferTags: [],
  avoidTags: [],
  maxMinutes: null,
  preferRecipeIds: [],
}
