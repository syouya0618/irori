/**
 * ごはんの数量・日付・区分の日本語表記。
 *
 * 境界指令を持たない中立モジュール。**Client Component からも値 import してよい**
 * （食材辞書・レシピのカタログを import しないので、画面の bundle を重くしない）。
 *
 * 単位の表記は `units.ts` の `UNIT_LABELS` / `formatQuantity` が正本。ここは「不明」「未知の値」の
 * 表記と、DB の値に付ける表示名だけを足す。未知の値は throw せず、中立の語へ退化させる。
 */

import { isValidYmd } from "@/lib/utils/date-jst"

import type { Sufficiency } from "../pantry-match"
import type {
  DishRole,
  ExclusionReason,
  PantryStatus,
  PantryStorage,
  PlanEntry,
  PlanEntryStatus,
  Quantity,
} from "../types"
import { UNIT_LABELS, formatQuantity } from "../units"
import { daysFrom, weekdayLabel } from "./today"

export const QUANTITY_UNKNOWN_LABEL = "数量不明"

/** 数量の表記。null（数量を登録していない）は「数量不明」。 */
export function formatQuantityJa(quantity: Quantity | null | undefined): string {
  if (!quantity) return QUANTITY_UNKNOWN_LABEL
  // 未知の単位（DB が先に増えた場合）は量を捏造せず「数量不明」
  if (!Object.prototype.hasOwnProperty.call(UNIT_LABELS, quantity.unit)) return QUANTITY_UNKNOWN_LABEL
  const text = formatQuantity(quantity)
  return text === "量不明" ? QUANTITY_UNKNOWN_LABEL : text
}

/** 単位の表記。未知の単位は入力のまま返す（落とさない）。 */
export function unitLabel(unit: string | null | undefined): string {
  if (unit === null || unit === undefined || unit === "") return ""
  return Object.prototype.hasOwnProperty.call(UNIT_LABELS, unit)
    ? UNIT_LABELS[unit as keyof typeof UNIT_LABELS]
    : unit
}

function monthDayOf(ymd: string): { month: number; day: number } {
  return { month: Number(ymd.slice(5, 7)), day: Number(ymd.slice(8, 10)) }
}

/** 「11月12日（水）」。不正な日付は入力のまま返す。 */
export function formatMealDate(ymd: string): string {
  if (!isValidYmd(ymd)) return ymd
  const { month, day } = monthDayOf(ymd)
  return `${month}月${day}日（${weekdayLabel(ymd) ?? "?"}）`
}

/** 「11/12（水）」。狭い欄用。不正な日付は入力のまま返す。 */
export function formatMealDateShort(ymd: string): string {
  if (!isValidYmd(ymd)) return ymd
  const { month, day } = monthDayOf(ymd)
  return `${month}/${day}（${weekdayLabel(ymd) ?? "?"}）`
}

/** 今日から見た呼び方（今日・明日・あさって・昨日）。それ以外・不正な日付は null。 */
export function relativeDayLabel(ymd: string, today: string): string | null {
  const diff = daysFrom(today, ymd)
  if (diff === 0) return "今日"
  if (diff === 1) return "明日"
  if (diff === 2) return "あさって"
  if (diff === -1) return "昨日"
  return null
}

/** 「今日 11/12（水）」。相対の呼び方が無い日は日付だけ。 */
export function formatMealDateWithRelative(ymd: string, today: string): string {
  const relative = relativeDayLabel(ymd, today)
  const date = formatMealDateShort(ymd)
  return relative === null ? date : `${relative} ${date}`
}

/** 期限などの残り日数。今日 = 「今日まで」、過ぎた日 = 「n日超過」。不正な日付は null。 */
export function formatDaysLeft(ymd: string, today: string): string | null {
  const diff = daysFrom(today, ymd)
  if (diff === null) return null
  if (diff === 0) return "今日まで"
  return diff > 0 ? `あと${diff}日` : `${-diff}日超過`
}

/** 調理時間の目安。「約20分」。不正な値は「時間不明」。 */
export function formatMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return "時間不明"
  return `約${Math.round(minutes)}分`
}

/** 「2人分」。 */
export function formatServings(servings: number): string {
  return `${Number.isFinite(servings) ? servings : "?"}人分`
}

/** 料理区分。`catalog/index.ts` の `DISH_ROLE_LABELS` と同じ（Client へカタログを載せないための写し。テストで一致を固定）。 */
export const DISH_ROLE_LABELS_JA: Readonly<Record<DishRole, string>> = {
  main: "主菜",
  side: "副菜",
  soup: "汁物",
  staple: "主食",
}

export function dishRoleLabel(role: string): string {
  return Object.prototype.hasOwnProperty.call(DISH_ROLE_LABELS_JA, role)
    ? DISH_ROLE_LABELS_JA[role as DishRole]
    : "料理"
}

/** 献立の枠を作った経路。「自動」は規則ベースの自動献立、「AI 補助」は生成 AI の補助を経たもの。 */
export const PLAN_ORIGIN_LABELS: Readonly<Record<PlanEntry["origin"], string>> = {
  auto: "自動",
  ai_assisted: "AI 補助",
  manual: "手動",
}

export const PLAN_STATUS_LABELS: Readonly<Record<PlanEntryStatus, string>> = {
  proposed: "提案",
  confirmed: "確定",
  cooked: "作った",
  skipped: "作らなかった",
}

export const PANTRY_STATUS_LABELS: Readonly<Record<PantryStatus, string>> = {
  have: "ある",
  low: "残り少ない",
  out: "使い切った",
}

export const PANTRY_STORAGE_LABELS: Readonly<Record<PantryStorage, string>> = {
  fridge: "冷蔵",
  freezer: "冷凍",
  pantry: "常温",
}

/** 在庫との突き合わせの 3 段。 */
export const SUFFICIENCY_LABELS: Readonly<Record<Sufficiency, string>> = {
  ready: "揃う",
  check: "分量要確認",
  buy: "買い足し",
}

export const SUFFICIENCY_DESCRIPTIONS: Readonly<Record<Sufficiency, string>> = {
  ready: "必要な食材と量が揃っています",
  check: "食材はありますが、分量の確認が必要です",
  buy: "買い足しが必要です",
}

export const EXCLUSION_REASON_LABELS: Readonly<Record<ExclusionReason, string>> = {
  allergy: "アレルギー",
  dislike: "苦手",
}
