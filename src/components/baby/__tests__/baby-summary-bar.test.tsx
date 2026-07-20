import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup, within } from "@testing-library/react"

import { BabySummaryBar } from "../baby-summary-bar"
import { formatTimeJst } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

afterEach(cleanup)

// NOW が JST で表す日付と一致させる（isToday 判定は date === todayJstString(now)）
const NOW = new Date("2026-04-11T12:00:00+09:00")
const TODAY = "2026-04-11"
const PAST_DATE = "2026-04-05"
const PAST_FEEDING_LOGGED_AT = "2026-04-05T09:15:00+09:00"

const baseProps = {
  lastFeeding: null,
  lastPumped: null,
  pumpingIntervalMin: 180,
  activeSleep: null,
  lastSleepEndedAt: null,
  now: NOW,
  date: TODAY,
  todayCounts: {
    feedingCount: 0,
    diaperCount: 0,
    sleepCount: 0,
    totalSleepMinutes: 0,
  },
}

function makeFeedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    logged_at: PAST_FEEDING_LOGGED_AT,
    logged_by: "user-1",
    feeding_type: "bottle",
    amount_ml: 120,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    memo: null,
    created_at: PAST_FEEDING_LOGGED_AT,
    ...overrides,
  }
}

function makeSleepLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-2",
    log_type: "sleep",
    logged_at: "2026-04-05T06:00:00+09:00",
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    memo: null,
    created_at: "2026-04-05T06:00:00+09:00",
    ...overrides,
  }
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

  it("role=group で今日のまとめがアクセシブルネームとして公開される", () => {
    render(<BabySummaryBar {...baseProps} />)
    expect(
      screen.getByRole("group", { name: "今日のまとめ" }),
    ).toBeInTheDocument()
  })

  it("過去日を選択している場合はラベルが「M/D のまとめ」に切り替わる", () => {
    render(<BabySummaryBar {...baseProps} date={PAST_DATE} />)
    expect(
      screen.getByRole("group", { name: "4/5 のまとめ" }),
    ).toBeInTheDocument()
    expect(screen.queryByText("今日のまとめ")).not.toBeInTheDocument()
  })

  it("過去日では最終授乳が相対経過ではなく絶対時刻で表示される", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        date={PAST_DATE}
        lastFeeding={makeFeedingLog()}
      />,
    )
    // role=group（ひと目まとめ部分）は残るが、最終授乳カードはその外側の
    // 「直近の経過」グリッドにあるため、画面全体を対象に検証する
    expect(
      screen.getByRole("group", { name: "4/5 のまとめ" }),
    ).toBeInTheDocument()
    // 経過表示（「◯◯前」形式）は出ない
    expect(screen.queryByText(/前$/)).not.toBeInTheDocument()
    // 絶対時刻（JST HH:MM）が出る
    expect(
      screen.getByText(formatTimeJst(PAST_FEEDING_LOGGED_AT)),
    ).toBeInTheDocument()
  })

  it("過去日では睡眠中カードの経過表示も出ない（非表示）", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        date={PAST_DATE}
        activeSleep={makeSleepLog()}
      />,
    )
    // ラベル（睡眠中）自体は残るが、経過時間（時間表記）は出ない
    expect(screen.getByText("睡眠中")).toBeInTheDocument()
    expect(screen.queryByText(/\d+時間/)).not.toBeInTheDocument()
  })
})

describe("BabySummaryBar 次の搾乳の目安", () => {
  function makePumpedLog(loggedAt: string): BabyLogData {
    return makeFeedingLog({
      id: "pumped-1",
      feeding_type: "pumped",
      logged_at: loggedAt,
      amount_ml: 60,
    })
  }

  it("今日・搾乳ありのとき目安時刻と残り時間を表示する", () => {
    // NOW = 4/11 12:00。10:00 搾乳 + 180分 → 13:00 目安（残り1時間）
    render(
      <BabySummaryBar
        {...baseProps}
        lastPumped={makePumpedLog("2026-04-11T10:00:00+09:00")}
        pumpingIntervalMin={180}
      />,
    )
    expect(screen.getByText("次の搾乳の目安")).toBeInTheDocument()
    expect(screen.getByText(formatTimeJst("2026-04-11T13:00:00+09:00"))).toBeInTheDocument()
    expect(screen.getByText(/あと1時間/)).toBeInTheDocument()
  })

  it("目安を過ぎていると「そろそろです」を表示する", () => {
    // 08:00 搾乳 + 180分 → 11:00 目安。NOW 12:00 は過ぎている
    render(
      <BabySummaryBar
        {...baseProps}
        lastPumped={makePumpedLog("2026-04-11T08:00:00+09:00")}
        pumpingIntervalMin={180}
      />,
    )
    expect(screen.getByText("そろそろです")).toBeInTheDocument()
  })

  it("搾乳が無ければ目安は表示しない", () => {
    render(<BabySummaryBar {...baseProps} lastPumped={null} />)
    expect(screen.queryByText("次の搾乳の目安")).not.toBeInTheDocument()
  })

  it("過去日を見ているときは目安を表示しない（今日限定）", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        date={PAST_DATE}
        lastPumped={makePumpedLog("2026-04-05T10:00:00+09:00")}
      />,
    )
    expect(screen.queryByText("次の搾乳の目安")).not.toBeInTheDocument()
  })
})
