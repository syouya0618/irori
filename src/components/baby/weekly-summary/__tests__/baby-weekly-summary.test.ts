import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BabyWeeklySummary } from "../baby-weekly-summary"

describe("BabyWeeklySummary", () => {
  it("週間合計と2種類のグラフを描画する", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [
          {
            date: "2026-04-10",
            feedingCount: 2,
            diaperCount: 1,
          },
          {
            date: "2026-04-11",
            feedingCount: 1,
            diaperCount: 2,
          },
        ],
        diaperBreakdown: { peeCount: 2, poopCount: 1 },
        average: { feedingPerDay: 1.5, diaperPerDay: 1.5, sampleDays: 7 },
      }),
    )

    expect(html).toContain("週間サマリー")
    // グラフ見出しの合計は **表示窓（7日）** のまま。ここが 8 日集計に化けたら赤にする。
    expect(html).toContain("3回")
    // おむつは合算値（3回）ではなく「おしっこ/うんち」の2値内訳で表示する
    expect(html).toContain("おしっこ2・うんち1")
    expect(html).toContain('aria-label="直近7日の授乳回数"')
    expect(html).toContain('aria-label="直近7日のおむつ交換回数"')
    expect(html).toContain("4/10")
    expect(html).toContain("4/11")
  })

  it("上段に1日あたりの平均と、その対象期間を出す", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [{ date: "2026-04-11", feedingCount: 1, diaperCount: 1 }],
        diaperBreakdown: { peeCount: 1, poopCount: 0 },
        average: { feedingPerDay: 8.3, diaperPerDay: 9.7, sampleDays: 7 },
      }),
    )

    expect(html).toContain("8.3回/日")
    expect(html).toContain("9.7回/日")
    // 期間の明示は必須。上段（昨日まで）と下段グラフ（今日を含む）は窓が違うため、
    // 書かねば「数字が合わぬ」となる。
    expect(html).toContain("昨日まで7日の平均")
  })

  it("整数の平均でも小数第1位まで出す（8回/日 ではなく 8.0回/日）", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [{ date: "2026-04-11", feedingCount: 8, diaperCount: 10 }],
        diaperBreakdown: { peeCount: 6, poopCount: 4 },
        average: { feedingPerDay: 8, diaperPerDay: 10, sampleDays: 7 },
      }),
    )

    expect(html).toContain("8.0回/日")
    expect(html).toContain("10.0回/日")
  })

  it("記録のあった日数が7未満なら、実際に割った日数をラベルに出す", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [{ date: "2026-04-11", feedingCount: 3, diaperCount: 2 }],
        diaperBreakdown: { peeCount: 2, poopCount: 0 },
        average: { feedingPerDay: 3, diaperPerDay: 2, sampleDays: 3 },
      }),
    )

    // 「7日の平均」と偽ってはならぬ。何日で割ったかを利用者に見せる。
    expect(html).toContain("記録のあった3日の平均")
    expect(html).not.toContain("昨日まで7日の平均")
  })

  it("平均が null なら 0.0 ではなく — を出す（本当に0回だったと誤読させない）", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [{ date: "2026-04-11", feedingCount: 0, diaperCount: 0 }],
        diaperBreakdown: { peeCount: 0, poopCount: 0 },
        average: null,
      }),
    )

    expect(html).not.toContain("0.0回/日")
    expect(html).toContain("平均を出せる記録がまだありません")
  })

  it("おむつ内訳は今日のまとめと同じ2値表示規約（合算表記は出ない）", () => {
    const html = renderToStaticMarkup(
      React.createElement(BabyWeeklySummary, {
        days: [
          {
            date: "2026-04-11",
            feedingCount: 0,
            diaperCount: 5,
          },
        ],
        // both が両方に加算されるため peeCount+poopCount(7) が
        // diaperCount(5) を超えるケース
        diaperBreakdown: { peeCount: 4, poopCount: 3 },
        average: { feedingPerDay: 0, diaperPerDay: 5, sampleDays: 7 },
      }),
    )

    // 内訳表示はチャート見出しの1箇所。上段ステータスは平均へ差し替わったため
    // 2 → 1 になった（**値 4/3 は据え置き**）。この値が変わったら取得窓 8 日が
    // おむつ内訳へ漏れた証拠ゆえ、数字の方は決して書き換えるな。
    const matches = html.match(/おしっこ4・うんち3/g) ?? []
    expect(matches).toHaveLength(1)
    // 合算表記（おむつ7回 等）は出さない規約
    expect(html).not.toContain("おむつ7回")
  })
})
