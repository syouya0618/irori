import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

import { LineChart } from "../line-chart"

afterEach(cleanup)

describe("LineChart", () => {
  it("各データ点に「ラベル: 整形値」の title を出力する", () => {
    const { container } = render(
      <LineChart
        ariaLabel="体重の推移"
        data={[
          { label: "4/1", value: 5000 },
          { label: "4/8", value: 5200 },
        ]}
        lineColorClassName="text-primary"
        valueFormatter={(v) => `${(v / 1000).toFixed(2)}kg`}
      />,
    )
    const titles = [...container.querySelectorAll("title")].map((t) => t.textContent)
    expect(titles).toContain("4/1: 5.00kg")
    expect(titles).toContain("4/8: 5.20kg")
  })

  it("2点以上で折れ線(polyline)を描く", () => {
    const { container } = render(
      <LineChart
        ariaLabel="体重の推移"
        data={[
          { label: "4/1", value: 5000 },
          { label: "4/8", value: 5200 },
        ]}
        lineColorClassName="text-primary"
      />,
    )
    expect(container.querySelector("polyline")).not.toBeNull()
  })

  it("1点のみなら折れ線は描かず点だけ描く", () => {
    const { container } = render(
      <LineChart
        ariaLabel="体重の推移"
        data={[{ label: "4/1", value: 5000 }]}
        lineColorClassName="text-primary"
      />,
    )
    expect(container.querySelector("polyline")).toBeNull()
    expect(container.querySelectorAll("circle").length).toBe(1)
  })

  it("空データなら aria-label 付き svg と「記録なし」を出す", () => {
    const { container, getByText } = render(
      <LineChart ariaLabel="体重の推移" data={[]} lineColorClassName="text-primary" />,
    )
    expect(container.querySelector('svg[aria-label="体重の推移"]')).not.toBeNull()
    expect(getByText("記録なし")).toBeInTheDocument()
  })
})
