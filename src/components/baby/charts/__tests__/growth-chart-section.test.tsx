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
    // 最新値（体重は最後の点 5200g → 5.2kg、身長 58cm）
    expect(screen.getByText("5.2kg")).toBeInTheDocument()
    expect(screen.getByText("58cm")).toBeInTheDocument()
  })

  it("記録が全く無ければ登録を促す空状態を出す", () => {
    render(<GrowthChartSection series={{ weight: [], height: [] }} />)
    expect(screen.getByText(/成長記録を追加/)).toBeInTheDocument()
  })
})
