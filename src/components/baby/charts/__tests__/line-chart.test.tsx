import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

import { LineChart, resolveHorizontalPositions } from "../line-chart"

afterEach(cleanup)

function circleXs(container: HTMLElement): number[] {
  return [...container.querySelectorAll("circle")].map((c) => Number(c.getAttribute("cx")))
}

describe("LineChart の横軸（時間比例）", () => {
  it("t を渡すと点の横位置は時間に比例する（1 日後と 30 日後を同じ幅にしない）", () => {
    // 0 日・1 日・31 日: 等間隔なら 2 点目は中央、時間比例なら左端のすぐ隣
    const { container } = render(
      <LineChart
        ariaLabel="体重の推移"
        data={[
          { label: "4/1", value: 5000, t: 0 },
          { label: "4/2", value: 5100, t: 1 },
          { label: "5/2", value: 5600, t: 31 },
        ]}
        lineColorClassName="text-primary"
      />,
    )
    const [x0, x1, x2] = circleXs(container)
    const total = x2 - x0
    expect(total).toBeGreaterThan(0)
    // 2 点目は全幅の 1/31 の位置（等間隔の 1/2 ではない）
    expect((x1 - x0) / total).toBeCloseTo(1 / 31, 5)
  })

  it("t を渡さぬ系列は従来どおり配列順の等間隔（対照）", () => {
    const { container } = render(
      <LineChart
        ariaLabel="体重の推移"
        data={[
          { label: "a", value: 1 },
          { label: "b", value: 2 },
          { label: "c", value: 3 },
        ]}
        lineColorClassName="text-primary"
      />,
    )
    const [x0, x1, x2] = circleXs(container)
    expect((x1 - x0) / (x2 - x0)).toBeCloseTo(0.5, 5)
  })

  it("resolveHorizontalPositions: t が一部でも欠ける・全て同値なら等間隔へ退化し、1 点は中央", () => {
    expect(resolveHorizontalPositions([{ label: "a", value: 1, t: 3 }])).toEqual([0.5])
    expect(
      resolveHorizontalPositions([
        { label: "a", value: 1, t: 0 },
        { label: "b", value: 2 },
        { label: "c", value: 3, t: 10 },
      ]),
    ).toEqual([0, 0.5, 1])
    expect(
      resolveHorizontalPositions([
        { label: "a", value: 1, t: 5 },
        { label: "b", value: 2, t: 5 },
        { label: "c", value: 3, t: 5 },
      ]),
    ).toEqual([0, 0.5, 1])
    expect(
      resolveHorizontalPositions([
        { label: "a", value: 1, t: 0 },
        { label: "b", value: 2, t: 1 },
        { label: "c", value: 3, t: 4 },
      ]),
    ).toEqual([0, 0.25, 1])
  })
})

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
