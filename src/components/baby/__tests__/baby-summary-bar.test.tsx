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
    peeCount: 0,
    poopCount: 0,
    breastCycleCount: 0,
    bottleCount: 0,
    pumpedCount: 0,
    solidCount: 0,
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
    breast_left_count: null,
    breast_right_count: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
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
    breast_left_count: null,
    breast_right_count: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-04-05T06:00:00+09:00",
    ...overrides,
  }
}

describe("BabySummaryBar 今日のまとめ", () => {
  it("今日の授乳内訳・合計睡眠・おむつ内訳(おしっこ/うんち)をひと目で表示する", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          // 授乳は種別内訳の排他分割（母乳1 + ミルク1 === feedingCount 2）
          feedingCount: 2,
          diaperCount: 3,
          sleepCount: 1,
          totalSleepMinutes: 90,
          peeCount: 2, // pee 1件 + both 1件
          poopCount: 1, // poop 0件 + both 1件
          breastCycleCount: 1,
          bottleCount: 1,
          pumpedCount: 0,
          solidCount: 0,
        }}
      />,
    )
    const summary = screen.getByLabelText("今日のまとめ")
    // 授乳は合算「2回」ではなく種別内訳で表示する（母乳サイクル数が
    // ミルク/搾乳と混ざって「N回」に化ける欠陥の回帰防止）
    expect(within(summary).getByText("母乳1・ミルク1")).toBeInTheDocument()
    expect(within(summary).queryByText("2回")).not.toBeInTheDocument()
    expect(within(summary).getByText("1時間30分")).toBeInTheDocument() // 睡眠
    // おむつは合算値ではなく「おしっこ/うんち」の2値内訳で表示する
    expect(
      within(summary).getByText("おしっこ2・うんち1"),
    ).toBeInTheDocument()
    expect(within(summary).queryByText("3回")).not.toBeInTheDocument()
  })

  it("同日に母乳1・ミルク1・搾乳1がある日は「母乳1・ミルク1・搾乳1」で、合計3回とは表示しない", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 3,
          // 「3回」が授乳の合算表示でないことを一意に示すため、おむつは 3 以外にする
          diaperCount: 2,
          sleepCount: 0,
          totalSleepMinutes: 0,
          peeCount: 1,
          poopCount: 1,
          breastCycleCount: 1,
          bottleCount: 1,
          pumpedCount: 1,
          solidCount: 0,
        }}
      />,
    )
    const summary = screen.getByLabelText("今日のまとめ")
    expect(
      within(summary).getByText("母乳1・ミルク1・搾乳1"),
    ).toBeInTheDocument()
    // 母乳サイクル数が bottle/pumped と混ざって「3回」に化けていないこと
    expect(within(summary).queryByText("3回")).not.toBeInTheDocument()
  })

  it("離乳食も含む4種類そろった日は非ゼロを「・」で全て連結する", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 12,
          diaperCount: 0,
          sleepCount: 0,
          totalSleepMinutes: 0,
          peeCount: 0,
          poopCount: 0,
          breastCycleCount: 8,
          bottleCount: 2,
          pumpedCount: 1,
          solidCount: 1,
        }}
      />,
    )
    const summary = screen.getByLabelText("今日のまとめ")
    expect(
      within(summary).getByText("母乳8・ミルク2・搾乳1・離乳食1"),
    ).toBeInTheDocument()
  })

  it("授乳が1件もない日は「0回」と表示する", () => {
    render(<BabySummaryBar {...baseProps} />)
    const summary = screen.getByLabelText("今日のまとめ")
    expect(within(summary).getByText("0回")).toBeInTheDocument()
  })

  it("feeding_type が null の行しかない日（#159 の未知値 null 退化）は合算回数へフォールバックする", () => {
    // 内訳が全ゼロでも授乳行が存在する日に「0回」と嘘をつかないための退避路。
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 2,
          diaperCount: 0,
          sleepCount: 0,
          totalSleepMinutes: 0,
          peeCount: 0,
          poopCount: 0,
          breastCycleCount: 0,
          bottleCount: 0,
          pumpedCount: 0,
          solidCount: 0,
        }}
      />,
    )
    const summary = screen.getByLabelText("今日のまとめ")
    expect(within(summary).getByText("2回")).toBeInTheDocument()
  })

  it("記録ゼロの日は睡眠を 0分 と表示する", () => {
    render(<BabySummaryBar {...baseProps} />)
    const summary = screen.getByLabelText("今日のまとめ")
    expect(within(summary).getByText("0分")).toBeInTheDocument()
  })

  it("おむつ0件のとき、今日のまとめは「おしっこ0・うんち0」、直近カードは「---」", () => {
    render(<BabySummaryBar {...baseProps} />)
    const summary = screen.getByLabelText("今日のまとめ")
    expect(
      within(summary).getByText("おしっこ0・うんち0"),
    ).toBeInTheDocument()
    // 直近カード側は diaperCount===0 のとき "---" にフォールバックするため、
    // 内訳文言は画面全体で今日のまとめの1箇所のみに出る
    expect(screen.getAllByText("おしっこ0・うんち0")).toHaveLength(1)
  })

  it("おむつ記録があるとき、今日のまとめ・直近カードの両方に同じ内訳を表示する", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 0,
          diaperCount: 2,
          sleepCount: 0,
          totalSleepMinutes: 0,
          peeCount: 1,
          poopCount: 2,
          breastCycleCount: 0,
          bottleCount: 0,
          pumpedCount: 0,
          solidCount: 0,
        }}
      />,
    )
    expect(screen.getAllByText("おしっこ1・うんち2")).toHaveLength(2)
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
