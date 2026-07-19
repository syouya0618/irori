import type { BabyLogData } from "@/lib/types/baby"

export interface BabyDashboardSummary {
  activeSleep: BabyLogData | null
  lastFeeding: BabyLogData | null
  derivedLastSleepEndedAt: string | null
}

/**
 * BabyDashboard のまとめ表示（アクティブ睡眠・最終授乳・最後の睡眠終了時刻）を
 * 選択日の logs（logged_at 降順前提）から 1 パスで導出する純関数。
 *
 * B-01（日跨ぎアクティブ睡眠の袋小路）対応:
 * 前夜に開始し未終了のままの睡眠は「選択日の logs」に現れない
 * （logged_at が前日のため当日窓のクエリから外れる）。その場合でも
 * サーバで別途取得した未終了睡眠 `activeSleepFallback` を用いることで、
 * 翌日の UI からトグルで終了できるようにする。
 * ローカル導出が優先（Realtime に反応する）で、fallback は補完のみ。
 * UNIQUE 部分 index idx_one_active_sleep により未終了睡眠は世帯あたり
 * 高々 1 件のため、両者が同時に別の睡眠を指すことはない。
 */
export function deriveDashboardSummary(
  logs: BabyLogData[],
  activeSleepFallback: BabyLogData | null,
): BabyDashboardSummary {
  let activeSleep: BabyLogData | undefined
  let lastFeeding: BabyLogData | undefined
  let derivedLastSleepEndedAt: string | null = null
  for (const l of logs) {
    if (!activeSleep && l.log_type === "sleep" && !l.ended_at)
      activeSleep = l
    if (!derivedLastSleepEndedAt && l.log_type === "sleep" && l.ended_at)
      derivedLastSleepEndedAt = l.ended_at
    if (!lastFeeding && l.log_type === "feeding") lastFeeding = l
  }
  return {
    activeSleep: activeSleep ?? activeSleepFallback,
    lastFeeding: lastFeeding ?? null,
    derivedLastSleepEndedAt,
  }
}
