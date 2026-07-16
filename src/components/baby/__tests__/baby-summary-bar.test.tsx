import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"

import { BabySummaryBar } from "../baby-summary-bar"

afterEach(cleanup)

const NOW = new Date("2026-04-11T12:00:00+09:00")

const baseProps = {
  lastFeeding: null,
  activeSleep: null,
  lastSleepEndedAt: null,
  now: NOW,
  todayCounts: {
    feedingCount: 0,
    diaperCount: 0,
    sleepCount: 0,
    totalSleepMinutes: 0,
  },
}

describe("BabySummaryBar 今日のまとめ", () => {
  it("今日の授乳回数・合計睡眠・おむつ回数をひと目で表示する", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 2,
          diaperCount: 3,
          sleepCount: 1,
          totalSleepMinutes: 90,
        }}
      />,
    )
    const summary = screen.getByLabelText("今日のまとめ")
    expect(within(summary).getByText("2回")).toBeInTheDocument() // 授乳
    expect(within(summary).getByText("1時間30分")).toBeInTheDocument() // 睡眠
    expect(within(summary).getByText("3回")).toBeInTheDocument() // おむつ
  })

  it("記録ゼロの日は睡眠を 0分 と表示する", () => {
    render(<BabySummaryBar {...baseProps} />)
    const summary = screen.getByLabelText("今日のまとめ")
    expect(within(summary).getByText("0分")).toBeInTheDocument()
  })
})
