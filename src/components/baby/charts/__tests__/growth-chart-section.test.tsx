import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { GrowthChartSection } from "../growth-chart-section"

afterEach(cleanup)

describe("GrowthChartSection", () => {
  it("体重・身長それぞれの折れ線と最新値を表示する", () => {
    render(
      <GrowthChartSection
        series={{
          weight: [
            { date: "2026-04-01", value: 5000 },
            { date: "2026-04-11", value: 5200 },
          ],
          height: [{ date: "2026-04-11", value: 58 }],
        }}
      />,
    )
    expect(screen.getByRole("img", { name: "体重の推移" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "身長の推移" })).toBeInTheDocument()
    // 最新値（体重は最後の点 5200g → 5.2kg、身長 58cm）。直近の一覧にも同じ値が
    // 並ぶため、見出しの値は 1 つ以上あることで固定する
    expect(screen.getAllByText("5.2kg").length).toBeGreaterThan(0)
    expect(screen.getAllByText("58cm").length).toBeGreaterThan(0)
  })

  it("記録が全く無ければ登録を促す空状態を出す", () => {
    render(<GrowthChartSection series={{ weight: [], height: [] }} />)
    expect(screen.getByText(/成長記録を追加/)).toBeInTheDocument()
  })

  it("横軸は測定日の間隔に比例する（1 日後と 30 日後を同じ幅にしない）", () => {
    const { container } = render(
      <GrowthChartSection
        series={{
          weight: [
            { date: "2026-04-01", value: 5000 },
            { date: "2026-04-02", value: 5100 },
            { date: "2026-05-02", value: 5600 },
          ],
          height: [],
        }}
      />,
    )
    const chart = screen.getByRole("img", { name: "体重の推移" })
    const xs = [...chart.querySelectorAll("circle")].map((c) => Number(c.getAttribute("cx")))
    expect(xs).toHaveLength(3)
    // 4/1 → 4/2 は 1 日、4/1 → 5/2 は 31 日
    expect((xs[1] - xs[0]) / (xs[2] - xs[0])).toBeCloseTo(1 / 31, 5)
    expect(container).toBeTruthy()
  })

  it("SVG の title だけに頼らず、直近の測定を日付・値・単位のテキストで一覧する（年つき・新しい順）", () => {
    render(
      <GrowthChartSection
        series={{
          weight: [
            { date: "2025-12-30", value: 4800 },
            { date: "2026-01-05", value: 5000 },
            { date: "2026-02-01", value: 5400 },
            { date: "2026-03-01", value: 5900 },
            { date: "2026-04-01", value: 6300 },
          ],
          height: [{ date: "2026-04-01", value: 58 }],
        }}
      />,
    )
    const weightList = screen.getByRole("list", { name: "体重の直近の測定" })
    const items = [...weightList.querySelectorAll("li")].map((li) => li.textContent)
    // 直近 4 件・新しい順。年を跨ぐ系列ゆえ年を付ける
    expect(items).toEqual([
      "2026/4/16.3kg",
      "2026/3/15.9kg",
      "2026/2/15.4kg",
      "2026/1/55kg",
    ])
    const heightList = screen.getByRole("list", { name: "身長の直近の測定" })
    expect(heightList.textContent).toBe("2026/4/158cm")
  })
})
