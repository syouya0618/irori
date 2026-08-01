import type { BabyLogData } from "@/lib/types/baby"

/**
 * 授乳間隔（分）の許容範囲。DB CHECK（chk_feeding_interval_min）と一致させる。
 */
export const FEEDING_INTERVAL_MIN = 30
export const FEEDING_INTERVAL_MAX = 720
export const FEEDING_INTERVAL_DEFAULT = 180

/** 設定で選べる授乳間隔（分）。2〜4時間を30分刻み。 */
export const FEEDING_INTERVAL_OPTIONS = [120, 150, 180, 210, 240] as const

export interface NextFeedingEstimate {
  /** 次の授乳の目安時刻（ISO 文字列） */
  targetIso: string
  /** 目安時刻までの分。過ぎている場合は負値 */
  minutesUntil: number
}

/**
 * 最後の授乳の**開始時刻**＋間隔から「次の授乳の目安」を算出する純関数。
 *
 * 間隔の数え方は「開始 → 次の開始」（`logged_at` の開始時刻セマンティクスと同じ契約）。
 * ゆえに所要時間（duration_sec）を足し引きしない。
 *
 * lastFedAt は ISO タイムスタンプ（絶対時刻）ゆえ `new Date(iso)` で扱う
 *（`new Date('YYYY-MM-DD')` の UTC 罠には該当しない）。
 */
export function computeNextFeeding(
  lastFedAt: string,
  intervalMin: number,
  now: Date,
): NextFeedingEstimate {
  const targetMs = new Date(lastFedAt).getTime() + intervalMin * 60_000
  const minutesUntil = Math.round((targetMs - now.getTime()) / 60_000)
  return { targetIso: new Date(targetMs).toISOString(), minutesUntil }
}

/**
 * ログ列から「最後に赤子へ与えた授乳」を返す。無ければ null。
 *
 * **搾乳（feeding_type='pumped'）は除外する**: 搾乳は母乳を搾る行為であって赤子に
 * 与えてはいないため、次の授乳の目安をリセットしない。母乳（breast /
 * 移行前の breast_left・breast_right）・ミルク（bottle）・離乳食（solid）が起点。
 * 未知の feeding_type（DB 側 ENUM 追加に TS が未追随の期間）は**授乳として数える**
 * — 搾乳だけを名指しで外す形にしておくと、新種の授乳が無音で目安から漏れない。
 *
 * 比較は文字列でなく epoch で行う: 楽観 append 行（`toISOString()` の "Z"）と
 * サーバ行（"+00:00"）で表記が混在し、辞書順が時刻順と食い違うため
 *（`deriveDashboardSummary` と同じ理由）。dashboard の logs は logged_at 降順で
 * 入る前提だが、タイマー由来の行は開始時刻（過去）を持つため順序に依存しない。
 */
export function findLastNursing(logs: BabyLogData[]): BabyLogData | null {
  let latest: BabyLogData | null = null
  let latestEpoch = Number.NEGATIVE_INFINITY
  for (const log of logs) {
    if (log.log_type !== "feeding" || log.feeding_type === "pumped") continue
    const epoch = new Date(log.logged_at).getTime()
    // 不正 ISO（NaN）は比較に負けて選ばれない（NaN > x は常に false）
    if (epoch > latestEpoch) {
      latest = log
      latestEpoch = epoch
    }
  }
  return latest
}

/**
 * 授乳間隔（分）を許容範囲へ正規化する。設定 UI / Server Action の入力検証で使う。
 * 非有限・範囲外は null を返し、呼び出し側で「不正な値」として扱う。
 */
export function normalizeFeedingInterval(value: number): number | null {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value)
  if (rounded < FEEDING_INTERVAL_MIN || rounded > FEEDING_INTERVAL_MAX) {
    return null
  }
  return rounded
}
