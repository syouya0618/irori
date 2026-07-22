import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BabyWeeklySummary } from "../baby-weekly-summary"

describe("BabyWeeklySummary", () => {
  it("週間合計と3種類のグラフを描画する", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [
          {
            date: "2026-04-10",
            feedingCount: 2,
            diaperCount: 1,
            sleepMinutes: 90,
          },
          {
            date: "2026-04-11",
            feedingCount: 1,
            diaperCount: 2,
            sleepMinutes: 60,
          },
        ],
        diaperBreakdown: { peeCount: 2, poopCount: 1 },
      }),
    )

    expect(html).toContain("週間サマリー")
    expect(html).toContain("3回")
    expect(html).toContain("2時間30分")
    // おむつは合算値（3回）ではなく「おしっこ/うんち」の2値内訳で表示する
    expect(html).toContain("おしっこ2・うんち1")
    expect(html).toContain('aria-label="直近7日の授乳回数"')
    expect(html).toContain('aria-label="直近7日の睡眠時間"')
    expect(html).toContain('aria-label="直近7日のおむつ交換回数"')
    expect(html).toContain("4/10")
    expect(html).toContain("4/11")
  })

  it("おむつ内訳は今日のまとめと同じ2値表示規約（合算表記は出ない）", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [
          {
            date: "2026-04-11",
            feedingCount: 0,
            diaperCount: 5,
            sleepMinutes: 0,
          },
        ],
        // both が両方に加算されるため peeCount+poopCount(7) が
        // diaperCount(5) を超えるケース
        diaperBreakdown: { peeCount: 4, poopCount: 3 },
      }),
    )

    // 内訳表示は上部ステータス・チャート見出しの2箇所に出る
    const matches = html.match(/おしっこ4・うんち3/g) ?? []
    expect(matches).toHaveLength(2)
  })
})
