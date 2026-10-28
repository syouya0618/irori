/**
 * 育児ホームの「最新を確認できたか」（2026-10-27 大型更新 テーマ C1）。
 *
 * 範囲（選択日の記録・週間・成長）ごとに、**最後に取得に成功した時刻**と、直近の取り直しが
 * 失敗したかを持つ。週だけ取れて日次が取れておらぬ時に「最新」と言わぬため、範囲を混ぜぬ。
 *
 * - 時刻はこの端末が応答を受け取った時刻（端末の時計）。サーバの保存時刻ではない
 * - navigator.onLine は使わぬ（接続のヒントは offline-banner の担当。取得の成否が事実）
 * - 「取得失敗」を「記録なし」と言わぬ: 失敗の範囲は数字ではなく「確認できません」を出す
 */
import { formatTimeJst } from "@/lib/utils/date-jst"

export type FreshnessRange = "logs" | "weekly" | "growth"

export const FRESHNESS_RANGES: readonly FreshnessRange[] = ["logs", "weekly", "growth"]

export const FRESHNESS_RANGE_LABELS: Record<FreshnessRange, string> = {
  logs: "この日の記録",
  weekly: "週間（直近8日）",
  growth: "成長の記録",
}

export interface RangeFreshness {
  /** 最後に取得に成功した時刻（epoch ms）。一度も成功しておらねば null */
  lastOkAt: number | null
  /** 直近の取得（取り直し）が失敗したか */
  failed: boolean
}

export type HomeFreshness = Record<FreshnessRange, RangeFreshness>

/**
 * 最終確認の時刻を読む時計（端末）。取得の応答を受けた時（イベント・effect の中）にだけ呼ぶ —
 * 描画中に壁時計を読むと React Compiler がマウント時の値で凍結する（today-clock-contract）。
 */
export function freshnessClockNow(): number {
  return Date.now()
}

/** 初回描画（サーバの取得）の結果から始める。成功した範囲は描画の時刻を最終確認とする */
export function initialFreshness(
  failed: Partial<Record<FreshnessRange, boolean>> = {},
  nowMs: number = Date.now(),
): HomeFreshness {
  const one = (r: FreshnessRange): RangeFreshness =>
    failed[r] ? { lastOkAt: null, failed: true } : { lastOkAt: nowMs, failed: false }
  return { logs: one("logs"), weekly: one("weekly"), growth: one("growth") }
}

/** 1 つの範囲の取得の結果を反映する（成功は時刻を進め、失敗は時刻を残して失敗だけ立てる） */
export function markFreshness(
  prev: HomeFreshness,
  range: FreshnessRange,
  ok: boolean,
  nowMs: number = Date.now(),
): HomeFreshness {
  const cur = prev[range]
  const next: RangeFreshness = ok
    ? { lastOkAt: nowMs, failed: false }
    : { lastOkAt: cur.lastOkAt, failed: true }
  if (next.lastOkAt === cur.lastOkAt && next.failed === cur.failed) return prev
  return { ...prev, [range]: next }
}

/** 最新を確認できておらぬ範囲（表示の対象から除く範囲を指定できる） */
export function staleRanges(
  f: HomeFreshness,
  exclude: readonly FreshnessRange[] = [],
): FreshnessRange[] {
  return FRESHNESS_RANGES.filter((r) => f[r].failed && !exclude.includes(r))
}

function hm(ms: number): string {
  return formatTimeJst(new Date(ms).toISOString())
}

/**
 * 「最新を確認できません」の文言。範囲と、その範囲の最終確認の時刻を添える（範囲ごとに時刻が
 * 違えば分けて書く）。一度も取れておらぬ範囲は「まだ読み込めていません」。
 */
export function describeStale(f: HomeFreshness, ranges: readonly FreshnessRange[]): string | null {
  if (ranges.length === 0) return null
  const byTime = new Map<string, string[]>()
  for (const r of ranges) {
    const t = f[r].lastOkAt
    const k = t === null ? "never" : hm(t)
    byTime.set(k, [...(byTime.get(k) ?? []), FRESHNESS_RANGE_LABELS[r]])
  }
  const parts = [...byTime.entries()].map(([time, labels]) =>
    time === "never"
      ? `${labels.join("・")}（まだ読み込めていません）`
      : `${labels.join("・")}（最終確認 ${time}）`,
  )
  return `最新を確認できません: ${parts.join("、")}`
}

/**
 * 保存と取得の状態の共通語（ホームの各所で同じ言葉を使う）。「記録済み」はサーバの確定行が
 * 在る時だけ。「結果を確認中」は応答不明（保存されたかもしれぬ）。
 */
export const HOME_STATUS_WORDS = {
  saving: "保存中",
  saved: "記録済み",
  unknown: "結果を確認中",
  stale: "最新を確認できません",
} as const

/** 「最新を確認できません」の次の操作の釦の文言 */
export const FRESHNESS_RETRY_LABEL = "もう一度読み込む"
