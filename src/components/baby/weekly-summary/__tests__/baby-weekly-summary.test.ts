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
      }),
    )

    expect(html).toContain("週間サマリー")
    expect(html).toContain("3回")
    expect(html).toContain("2時間30分")
    expect(html).toContain('aria-label="直近7日の授乳回数"')
    expect(html).toContain('aria-label="直近7日の睡眠時間"')
    expect(html).toContain('aria-label="直近7日のおむつ交換回数"')
    expect(html).toContain("4/10")
    expect(html).toContain("4/11")
  })
})
