import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { BarChart } from "../bar-chart"

describe("BarChart", () => {
  it("アクセシブルなSVG棒グラフを描画する", () => {
    const html = renderToStaticMarkup(
      React.createElement(BarChart, {
        ariaLabel: "直近7日の授乳回数",
        data: [
          { label: "4/10", value: 2 },
          { label: "4/11", value: 0 },
        ],
        barColorClassName: "text-amber-500",
        valueFormatter: (value) => `${value}回`,
      }),
    )

    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="直近7日の授乳回数"')
    expect(html).toContain("<title>4/10: 2回</title>")
    expect(html).toContain("text-amber-500")
    expect(html).not.toContain("NaN")
  })

  it("maxValue baseline で疎データの棒が満杯にならない", () => {
    const html = renderToStaticMarkup(
      React.createElement(BarChart, {
        ariaLabel: "直近7日の授乳回数",
        data: [{ label: "4/16", value: 1 }],
        maxValue: 8,
        barColorClassName: "text-amber-500",
        valueFormatter: (value) => `${value}回`,
      }),
    )

    // safeMax=8, normalized=1/8, height=max(4, 0.125*64)=8, y=12+64-8=68
    expect(html).toContain('width="280" height="8"')
    expect(html).toContain('y="68"')
    // 満杯（height=64 / y=12）になっていないこと
    expect(html).not.toContain('height="64"')
  })

  it("maxValue 未指定だと疎データの棒は満杯まで伸びる", () => {
    const html = renderToStaticMarkup(
      React.createElement(BarChart, {
        ariaLabel: "直近7日の授乳回数",
        data: [{ label: "4/16", value: 1 }],
        barColorClassName: "text-amber-500",
        valueFormatter: (value) => `${value}回`,
      }),
    )

    // safeMax=1, normalized=1, height=max(4, 1*64)=64, y=12+64-64=12
    expect(html).toContain('width="280" height="64"')
    expect(html).toContain('y="12"')
  })

  it("データが maxValue を上回ればグラフは伸びる", () => {
    const html = renderToStaticMarkup(
      React.createElement(BarChart, {
        ariaLabel: "直近7日の授乳回数",
        data: [{ label: "4/16", value: 16 }],
        maxValue: 8,
        barColorClassName: "text-amber-500",
        valueFormatter: (value) => `${value}回`,
      }),
    )

    // safeMax=max(8,16,1)=16, normalized=1, height=64, y=12
    expect(html).toContain('width="280" height="64"')
    expect(html).toContain('y="12"')
  })

  it("空データでも壊れた数値を出さない", () => {
    const html = renderToStaticMarkup(
      React.createElement(BarChart, {
        ariaLabel: "空のグラフ",
        data: [],
        barColorClassName: "text-sky-500",
      }),
    )

    expect(html).toContain('aria-label="空のグラフ"')
    expect(html).not.toContain("NaN")
    expect(html).not.toContain("Infinity")
  })
})
