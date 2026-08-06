import { shiftYmd, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogType } from "@/lib/types/database"

export interface BabyWeeklySummaryLogInput {
  log_type: BabyLogType
  logged_at: string
}

export interface BabyWeeklySummaryDay {
  date: string
  feedingCount: number
  diaperCount: number
}

/**
 * 週間サマリーの棒グラフ y 軸スケールの最低基準値（baseline）。
 *
 * 疎データ（例: 6日ゼロ・1日だけ授乳1回）でローカル最大値正規化すると
 * 「1回」が画面いっぱいに伸び誤認を招くため、最低スケールを設ける。
 * データがこの値を上回ればグラフは伸びる（BarChart 側で
 * `Math.max(maxValue ?? 0, ...data values, 1)` を計算）。
 *
 * これらは Issue #15 由来の暫定デフォルト値であり、実運用後に
 * ユーザーのフィードバックを踏まえて再調整する想定。
 */
export const WEEKLY_CHART_BASELINE = {
  feedingCount: 8, // 授乳: 一日の目安上限（回）
  diaperCount: 10, // おむつ: 一日の目安上限（回）
} as const

/**
 * 週間サマリーの窓は **2 本ある**。1 本にまとめてはならぬ。
 *
 * - `WEEKLY_FETCH_DAYS`（8日）: 取得窓。Realtime の「週窓に入る/出る」判定もこちら。
 *   平均に「昨日までの 7 日」を使うため、今日のぶん 1 日ぶん余分に取る。
 * - `WEEKLY_DISPLAY_DAYS`（7日）: 表示窓。**グラフ・合計・おむつ内訳は全てこちら**。
 *   ここを取得窓と共有すると、既存の「授乳◯回」「おしっこN・うんちM」が
 *   無音で 8 日集計に化ける（`totalBabyWeeklySummary` は渡された配列を全て足すため）。
 * - `AVERAGE_WINDOW_DAYS`（7日）: 平均の対象。取得窓の**先頭**から数える
 *   ＝「昨日までの 7 日」。今日は経過途中ゆえ混ぜぬ（混ぜると朝ほど過小に出る）。
 *
 * このモジュールは境界指令（"use client" / "use server"）を持たぬ中立モジュールゆえ、
 * Server Component（`baby/page.tsx`）と Client Component（`baby-dashboard.tsx`）の
 * **両方から値として import してよい**。定数を client 側へ置くと、Server が値 import
 * した瞬間に実行時破壊が起きる（tsc も next build も vitest も緑のまま e2e で発覚する）。
 */
export const WEEKLY_FETCH_DAYS = 8
export const WEEKLY_DISPLAY_DAYS = 7
export const AVERAGE_WINDOW_DAYS = 7

export interface BabyWeeklyAverage {
  /** 1日あたりの授乳回数（小数第1位） */
  feedingPerDay: number
  /** 1日あたりのおむつ交換回数（小数第1位・`both` は 1 回として数える） */
  diaperPerDay: number
  /** 実際に割った日数。記録の無い日は分母から除くため 7 未満になりうる */
  sampleDays: number
}

function createEmptyDay(date: string): BabyWeeklySummaryDay {
  return {
    date,
    feedingCount: 0,
    diaperCount: 0,
  }
}

export function buildBabyWeeklySummary(
  logs: BabyWeeklySummaryLogInput[],
  endDate: string,
  days = 7,
): BabyWeeklySummaryDay[] {
  if (days <= 0) return []

  const startDate = shiftYmd(endDate, -(days - 1))
  const byDate = new Map<string, BabyWeeklySummaryDay>()

  for (let i = 0; i < days; i++) {
    const date = shiftYmd(startDate, i)
    byDate.set(date, createEmptyDay(date))
  }

  for (const log of logs) {
    if (log.log_type === "feeding") {
      const date = toJstDateString(log.logged_at)
      const day = byDate.get(date)
      if (!day) continue
      day.feedingCount++
    } else if (log.log_type === "diaper") {
      const date = toJstDateString(log.logged_at)
      const day = byDate.get(date)
      if (!day) continue
      day.diaperCount++
    }
  }

  return [...byDate.values()]
}

export function totalBabyWeeklySummary(days: BabyWeeklySummaryDay[]) {
  return days.reduce(
    (total, day) => ({
      feedingCount: total.feedingCount + day.feedingCount,
      diaperCount: total.diaperCount + day.diaperCount,
    }),
    { feedingCount: 0, diaperCount: 0 },
  )
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * 1日あたりの平均回数を返す。記録が 1 日も無ければ `null`（UI は「— 回/日」を出す）。
 *
 * **分母は「記録のあった日数」であって配列長ではない。**
 * 授乳もおむつも 0 件の日は「本当に 0 回だった」ではなく「記録しなかった」じゃ
 * （乳児が 1 日まったく飲まぬことはない）。配列長で割ると、使い始めの週や
 * 記録が飛んだ週で平均が無音で過小に出る — 今日を分母から外したのと同じ理由の
 * 過小評価を、分母の側で作ってしまう。しかも「飲みが減った」を判断する数字ゆえ
 * 向きが悪い。
 *
 * 割り切りとして、記録のある日に混ざった真の 0 は区別できぬ（原理的に不可能）。
 * 呼び出し側は `sampleDays` を UI に出し、何日で割ったかを利用者に見せること。
 *
 * **PDF レポートの `avgBottleMl` / `avgPumpedMl` とは別物じゃ**（同じ「平均」の語ゆえ
 * 混同しやすい）。あちらは `baby-log-aggregation.ts` の**その日の 1 回あたり ml**
 * （`totalBottleMl / bottleCount`）で、単位も粒度も違う。数字が突き合わされることは
 * ないゆえ揃える必要はないが、片方を直す時にもう片方を巻き込むな。
 */
export function averageBabyWeeklySummary(
  days: BabyWeeklySummaryDay[],
): BabyWeeklyAverage | null {
  const recorded = days.filter(
    (day) => day.feedingCount > 0 || day.diaperCount > 0,
  )
  if (recorded.length === 0) return null

  const totals = totalBabyWeeklySummary(recorded)
  return {
    feedingPerDay: roundToTenth(totals.feedingCount / recorded.length),
    diaperPerDay: roundToTenth(totals.diaperCount / recorded.length),
    sampleDays: recorded.length,
  }
}
