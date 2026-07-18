import { describe, it, expect } from "vitest"
import {
  aggregateSleep,
  summarizeTodayCounts,
  type AggregationLogInput,
} from "../baby-log-aggregation"
import { buildBabyWeeklySummary } from "../baby-weekly-summary"

/**
 * 睡眠集計「3面同値」の cross-implementation テスト（B-02 / I-11）。
 *
 * 同一入力 fixture に対し、PDF 集計（aggregateSleep）・週間サマリー
 * （buildBabyWeeklySummary）・今日のまとめ（summarizeTodayCounts）の
 * per-day 睡眠（分）が一致することを機械で固定する。#114 で第 3 の実装面
 * （summarizeTodayCounts）が増えて乖離した経緯の再発防止であり、将来第 4 の
 * 実装面が加わって乖離したら即赤になる。
 *
 * 注意（overclaim 回避）: 本テストは 3 つの純関数が同一入力で一致することの証明で
 * あり、クエリ（サーバ初回 vs クライアント refetch の窓、overlapLogs の網羅）が
 * 同一入力を供給することは証明しない。そちらは設計対称性 + 手動「日付ナビ往復」で担保する。
 */

function sleep(logged_at: string, ended_at: string | null): AggregationLogInput {
  return {
    log_type: "sleep",
    logged_at,
    ended_at,
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
  }
}

describe("睡眠集計 3面同値（PDF / 週間 / 今日のまとめ）", () => {
  const END = "2026-04-11"
  const START = "2026-04-05" // END - 6（週間 7 日窓）

  const fixture: AggregationLogInput[] = [
    // 集計開始日より前に始まった日跨ぎ睡眠（窓端 = AUDIT-067）: 04-05 に 90 分だけ計上
    sleep("2026-04-04T22:00:00+09:00", "2026-04-05T01:30:00+09:00"),
    // 窓内の日跨ぎ睡眠: 04-05 に 120 分 / 04-06 に 390 分
    sleep("2026-04-05T22:00:00+09:00", "2026-04-06T06:30:00+09:00"),
    // 単日睡眠: 04-07 に 90 分
    sleep("2026-04-07T13:00:00+09:00", "2026-04-07T14:30:00+09:00"),
    // 日跨ぎ睡眠: 04-10 に 270 分 / 04-11 に 390 分
    sleep("2026-04-10T19:30:00+09:00", "2026-04-11T06:30:00+09:00"),
    // 未完了睡眠（除外される）
    sleep("2026-04-11T09:00:00+09:00", null),
    // ended_at <= logged_at（除外される）
    sleep("2026-04-08T10:00:00+09:00", "2026-04-08T09:59:00+09:00"),
  ]

  it("PDF 集計 と 週間サマリー の per-day 睡眠分が一致", () => {
    const pdf = aggregateSleep(fixture, START, END)
    const weekly = buildBabyWeeklySummary(fixture, END, 7)
    const pdfByDate = new Map(pdf.map((d) => [d.date, d.totalMinutes]))
    for (const day of weekly) {
      expect(pdfByDate.get(day.date) ?? 0).toBe(day.sleepMinutes)
    }
  })

  it("今日のまとめ と 週間サマリー の per-day 睡眠分が一致", () => {
    const weekly = buildBabyWeeklySummary(fixture, END, 7)
    for (const day of weekly) {
      const today = summarizeTodayCounts(fixture, day.date).totalSleepMinutes
      expect(today).toBe(day.sleepMinutes)
    }
  })

  it("19:30→06:30 の日跨ぎで per-day 値が 270/390 に一致（round2 の 360分乖離の解消）", () => {
    const one = [sleep("2026-04-10T19:30:00+09:00", "2026-04-11T06:30:00+09:00")]
    const pdf = aggregateSleep(one, START, END)
    const weekly = buildBabyWeeklySummary(one, END, 7)
    const today10 = summarizeTodayCounts(one, "2026-04-10").totalSleepMinutes
    const today11 = summarizeTodayCounts(one, "2026-04-11").totalSleepMinutes

    const pdfByDate = new Map(pdf.map((d) => [d.date, d.totalMinutes]))
    const weeklyByDate = new Map(weekly.map((d) => [d.date, d.sleepMinutes]))

    expect(weeklyByDate.get("2026-04-10")).toBe(270)
    expect(weeklyByDate.get("2026-04-11")).toBe(390)
    expect(pdfByDate.get("2026-04-10")).toBe(270)
    expect(pdfByDate.get("2026-04-11")).toBe(390)
    expect(today10).toBe(270)
    expect(today11).toBe(390)
  })
})
