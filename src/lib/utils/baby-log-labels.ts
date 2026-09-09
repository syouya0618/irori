import type {
  BabyLogType,
  FeedingType,
  DiaperType,
  PoopAmount,
  BreastStartSide,
} from "@/lib/types/database"

const logTypeLabels: Record<BabyLogType, string> = {
  feeding: "授乳",
  diaper: "おむつ",
  // `sleep` は記録導線ごと廃止した旧種別。Postgres は ENUM 値を削除できず
  // baby_log_type からは消えないため、`Record<BabyLogType, …>` の網羅性と、
  // 万一の残存行で undefined ラベルにならない退化のため定義だけ残す
  // （baby-timeline-item.tsx の logTypeConfig と同じ流儀）。
  sleep: "睡眠",
  temperature: "体温",
  growth: "成長記録",
  memo: "メモ",
}

const feedingTypeLabels: Record<FeedingType, string> = {
  // 母乳サイクル行。左右の内訳は formatBreastCounts で別に添える
  breast: "母乳",
  // 移行前の片側行（過去データ専用）。既存タイムラインの表示を変えないため据え置く
  breast_left: "左",
  breast_right: "右",
  bottle: "ミルク",
  solid: "離乳食",
  pumped: "搾乳",
}

const diaperTypeLabels: Record<DiaperType, string> = {
  pee: "おしっこ",
  poop: "うんち",
  both: "両方",
}

export function getLogTypeLabel(type: BabyLogType): string {
  return logTypeLabels[type]
}

export function getFeedingTypeLabel(type: FeedingType): string {
  return feedingTypeLabels[type]
}

export function getDiaperTypeLabel(type: DiaperType): string {
  return diaperTypeLabels[type]
}

const poopAmountLabels: Record<PoopAmount, string> = {
  small: "少量",
  large: "大量",
}

/**
 * うんちの量のラベル。DB は TEXT + CHECK ゆえ将来値が増えうる — 未知値は null へ
 * 退化させ（enum drift 防御・#159 と同じ流儀）、呼び出し側は「量の表示なし」で描く。
 */
export function getPoopAmountLabel(amount: string | null | undefined): string | null {
  if (amount === "small" || amount === "large") return poopAmountLabels[amount]
  return null
}

/**
 * おむつ行の要約（うんち / うんち（大量） / 両方（少量））。量は poop / both の
 * 行にしか付かない契約（chk_poop_amount_only_poop）だが、万一 pee 行に量が来ても
 * 描かない（表示側でも契約をミラーし、矛盾行を目立たせない）。
 */
export function formatDiaperSummary(
  type: DiaperType,
  amount: string | null | undefined,
): string {
  const base = getDiaperTypeLabel(type)
  if (type === "pee") return base
  const amountLabel = getPoopAmountLabel(amount)
  return amountLabel ? `${base}（${amountLabel}）` : base
}

const breastStartSideLabels: Record<BreastStartSide, string> = {
  left: "左",
  right: "右",
}

/** 開始側の短いラベル（左 / 右）。未知値・null は null（不明）。 */
export function getBreastStartSideLabel(
  side: string | null | undefined,
): string | null {
  if (side === "left" || side === "right") return breastStartSideLabels[side]
  return null
}

/**
 * タイムライン用「（左から）」。開始側を持つ母乳サイクル行だけに添える。
 * 未知値・null は空文字（旧行は開始側を持たぬのが正常ゆえ、欠落を目立たせない）。
 */
export function formatBreastStartSide(side: string | null | undefined): string {
  const label = getBreastStartSideLabel(side)
  return label ? `（${label}から）` : ""
}

/**
 * 母乳サイクルの左右の吸わせ回数を「左2・右1」へ整形する。
 *
 * 0 の側は省略する（左2・右0 → "左2"）。「右0」は情報量ゼロの雑音で、片側だけ
 * 吸わせた回のタイムラインを読みづらくするため。両側 0/null は空文字を返し、
 * 呼び出し側が「添える内訳が無い」を空判定できるようにする（breast 以外の行を
 * そのまま渡しても壊れない = #159 の未知値 null 退化と同じ流儀の多層防御）。
 */
export function formatBreastCounts(
  left: number | null,
  right: number | null,
): string {
  const parts: string[] = []
  if (left != null && left > 0) parts.push(`左${left}`)
  if (right != null && right > 0) parts.push(`右${right}`)
  return parts.join("・")
}

/**
 * 授乳時間（秒）を「M分S秒 / M分 / S秒」の日本語表記へ整形する。
 * duration_sec を timeline やトーストで秒精度表示するのに使う。
 */
export function formatDurationSec(rawSeconds: number): string {
  const total = Math.max(0, Math.round(rawSeconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m > 0 && s > 0) return `${m}分${s}秒`
  if (m > 0) return `${m}分`
  return `${s}秒`
}

/**
 * 母乳サイクルの左右別「回数+時間」表示（例: 左2回7分30秒・右1回5分）。
 * sides（breast_left_sec/right_sec）を持つ行のタイムライン表示に使う。
 * 合計は併記しない（左右の和と決まっており二重表示は密度を壊す）。
 *
 * - 0 秒の側は時間を省略（左1回）
 * - 0回0秒の側はその側ごと省略
 * - 回数 0 で時間だけある側は時間のみ（通常発生しないが防御）
 * - null は 0 扱い（旧行混在の防御）
 */
export function formatBreastSideBreakdown(
  leftCount: number | null,
  rightCount: number | null,
  leftSec: number | null,
  rightSec: number | null,
): string {
  const side = (label: string, count: number | null, sec: number | null) => {
    const c = count ?? 0
    const s = sec ?? 0
    if (c <= 0 && s <= 0) return ""
    const time = s > 0 ? formatDurationSec(s) : ""
    const times = c > 0 ? `${c}回` : ""
    return `${label}${times}${time}`
  }
  return [side("左", leftCount, leftSec), side("右", rightCount, rightSec)]
    .filter(Boolean)
    .join("・")
}

export function formatElapsedMinutes(rawMinutes: number): string {
  const minutes = Math.max(0, rawMinutes)
  if (minutes < 60) return `${minutes}分`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}時間${m}分` : `${h}時間`
}

export function minutesBetween(from: string, to: string): number {
  return Math.round(
    (new Date(to).getTime() - new Date(from).getTime()) / 60000,
  )
}
