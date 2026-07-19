import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * 睡眠集計「按分」の共通ヘルパ（B-02 / I-11）。
 *
 * 睡眠を「開始日に全量計上」すると、日跨ぎ睡眠で
 * PDF 集計・週間サマリー・今日のまとめ の per-day 値が乖離する
 * （AUDIT-019/067/072、#114 で第 3 面が追加され悪化）。本モジュールの
 * `sleepOverlapMinutesForDate` を全実装面の唯一の按分ロジックとし、3 面同値を機械で担保する。
 */

/** JST 日付 "YYYY-MM-DD" の 00:00:00+09:00 を epoch ms で返す。 */
function jstDayStartMs(date: string): number {
  return new Date(`${date}T00:00:00+09:00`).getTime()
}

/**
 * 完了睡眠 [logged_at, ended_at] と JST 当日窓 [date 00:00, 翌日 00:00) の
 * 重なりを分で返す。日跨ぎ睡眠はこの窓と交差する部分のみを計上する。
 *
 * - 未完了睡眠（ended_at = null）は 0（完了セッションのみ集計する既存規約を維持）。
 * - ended_at <= logged_at や不正日時（NaN）も 0 にフォールバック（NaN 経路の防御）。
 * - 丸めは 1 (sleep, day) ペアごとに `Math.round(overlapMs / 60000)`。全実装面がこの
 *   単位で加算するため、per-day 合計が一致する（3面同値の要）。
 */
export function sleepOverlapMinutesForDate(
  loggedAt: string,
  endedAt: string | null,
  date: string,
): number {
  if (!endedAt) return 0
  const sleepStartMs = new Date(loggedAt).getTime()
  const sleepEndMs = new Date(endedAt).getTime()
  // NaN・逆転区間はここで 0 に落とす（`NaN > NaN` は false）。
  if (!(sleepEndMs > sleepStartMs)) return 0

  const dayStartMs = jstDayStartMs(date)
  const dayEndMs = jstDayStartMs(shiftYmd(date, 1))
  const overlapMs =
    Math.min(sleepEndMs, dayEndMs) - Math.max(sleepStartMs, dayStartMs)

  return overlapMs > 0 ? Math.round(overlapMs / 60000) : 0
}
