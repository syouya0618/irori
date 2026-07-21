import type { BabyLogData } from "@/lib/types/baby"

/**
 * 搾乳間隔（分）の許容範囲。DB CHECK（chk_pumping_interval_min）と一致させる。
 */
export const PUMPING_INTERVAL_MIN = 30
export const PUMPING_INTERVAL_MAX = 720
export const PUMPING_INTERVAL_DEFAULT = 180

/** 設定で選べる搾乳間隔（分）。2〜4時間を30分刻み。 */
export const PUMPING_INTERVAL_OPTIONS = [120, 150, 180, 210, 240] as const

export interface NextPumpingEstimate {
  /** 次の搾乳の目安時刻（ISO 文字列） */
  targetIso: string
  /** 目安時刻までの分。過ぎている場合は負値 */
  minutesUntil: number
}

/**
 * 最後の搾乳時刻＋間隔から「次の搾乳の目安」を算出する純関数。
 * lastPumpedAt は ISO タイムスタンプ（絶対時刻）ゆえ `new Date(iso)` で扱う
 *（`new Date('YYYY-MM-DD')` の UTC 罠には該当しない）。
 */
export function computeNextPumping(
  lastPumpedAt: string,
  intervalMin: number,
  now: Date,
): NextPumpingEstimate {
  const targetMs = new Date(lastPumpedAt).getTime() + intervalMin * 60_000
  const minutesUntil = Math.round((targetMs - now.getTime()) / 60_000)
  return { targetIso: new Date(targetMs).toISOString(), minutesUntil }
}

/**
 * ログ列から最後の搾乳（feeding_type='pumped'）を返す。無ければ null。
 * dashboard の logs は logged_at 降順で入る前提だが、順序に依存せず最大時刻を選ぶ。
 */
export function findLastPumped(logs: BabyLogData[]): BabyLogData | null {
  let latest: BabyLogData | null = null
  for (const log of logs) {
    if (log.log_type !== "feeding" || log.feeding_type !== "pumped") continue
    if (!latest || log.logged_at > latest.logged_at) latest = log
  }
  return latest
}

/**
 * 搾乳間隔（分）を許容範囲へ正規化する。設定 UI / Server Action の入力検証で使う。
 * 非有限・範囲外は null を返し、呼び出し側で「不正な値」として扱う。
 */
export function normalizePumpingInterval(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < PUMPING_INTERVAL_MIN || rounded > PUMPING_INTERVAL_MAX) {
    return null
  }
  return rounded
}
