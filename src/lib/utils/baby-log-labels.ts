import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"

const logTypeLabels: Record<BabyLogType, string> = {
  feeding: "授乳",
  diaper: "おむつ",
  sleep: "睡眠",
  temperature: "体温",
  growth: "成長記録",
  memo: "メモ",
}

const feedingTypeLabels: Record<FeedingType, string> = {
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
