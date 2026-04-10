import type { BabyLogType, FeedingType, DiaperType } from "@/lib/types/database"

const logTypeLabels: Record<BabyLogType, string> = {
  feeding: "授乳",
  diaper: "おむつ",
  sleep: "睡眠",
}

const feedingTypeLabels: Record<FeedingType, string> = {
  breast_left: "左",
  breast_right: "右",
  bottle: "ミルク",
  solid: "離乳食",
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

export function formatElapsedMinutes(minutes: number): string {
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
