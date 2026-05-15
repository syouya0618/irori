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
