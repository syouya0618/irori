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
  lastNursing: null,
  feedingIntervalMin: 180,
  now: NOW,
  date: TODAY,
  todayCounts: {
    feedingCount: 0,
    diaperCount: 0,
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
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
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

describe("BabySummaryBar の取得状態（P2-10 / レビュー P3-5）", () => {
  const counts = {
    feedingCount: 2,
    diaperCount: 3,
    peeCount: 2,
    poopCount: 1,
    breastCycleCount: 1,
    bottleCount: 1,
    pumpedCount: 0,
    solidCount: 0,
  }

  it.each(["loading", "error"] as const)(
    "%s の間は数字を出さず「—」にする（空配列を 0 回と偽らぬ）",
    (status) => {
      render(
        <BabySummaryBar
          {...baseProps}
          date={PAST_DATE}
          status={status}
          todayCounts={counts}
          lastFeeding={makeFeedingLog()}
        />,
      )
      const summary = screen.getByRole("group", { name: "4/5 のまとめ" })
      expect(summary).toHaveAttribute("aria-busy", "true")
      expect(within(summary).getAllByText("—")).toHaveLength(2)
      expect(within(summary).queryByText(/ミルク1/)).toBeNull()
      expect(screen.queryByText(formatTimeJst(PAST_FEEDING_LOGGED_AT))).toBeNull()
      expect(screen.queryByText(/おしっこ2・うんち1/)).toBeNull()
    },
  )

  it("対照: ready なら同じ props で数字が出る", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        date={PAST_DATE}
        status="ready"
        todayCounts={counts}
        lastFeeding={makeFeedingLog()}
      />,
    )
    const summary = screen.getByRole("group", { name: "4/5 のまとめ" })
    expect(summary).not.toHaveAttribute("aria-busy")
    expect(within(summary).getByText("母乳1・ミルク1")).toBeInTheDocument()
    expect(screen.getByText(formatTimeJst(PAST_FEEDING_LOGGED_AT))).toBeInTheDocument()
  })
})

describe("BabySummaryBar 今日のまとめ", () => {
  it("今日の授乳内訳・おむつ内訳(おしっこ/うんち)をひと目で表示する", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          // 授乳は種別内訳の排他分割（母乳1 + ミルク1 === feedingCount 2）
          feedingCount: 2,
          diaperCount: 3,
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

  it("おむつ0件のとき、今日のまとめは「おしっこ0・うんち0」", () => {
    render(<BabySummaryBar {...baseProps} />)
    const summary = screen.getByLabelText("今日のまとめ")
    expect(
      within(summary).getByText("おしっこ0・うんち0"),
    ).toBeInTheDocument()
    expect(screen.getAllByText("おしっこ0・うんち0")).toHaveLength(1)
  })

  it("おむつの内訳は今日のまとめの 1 か所だけに出す（以前の直近カードとの二重表示をやめた）", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        todayCounts={{
          feedingCount: 0,
          diaperCount: 2,
          peeCount: 1,
          poopCount: 2,
          breastCycleCount: 0,
          bottleCount: 0,
          pumpedCount: 0,
          solidCount: 0,
        }}
      />,
    )
    const summary = screen.getByRole("group", { name: "今日のまとめ" })
    expect(within(summary).getByText("おしっこ1・うんち2")).toBeInTheDocument()
    expect(screen.getAllByText("おしっこ1・うんち2")).toHaveLength(1)
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
})

describe("BabySummaryBar 次の授乳の目安", () => {
  function makeNursingLog(loggedAt: string): BabyLogData {
    return makeFeedingLog({
      id: "nursing-1",
      feeding_type: "breast",
      logged_at: loggedAt,
      amount_ml: null,
    })
  }

  it("今日・授乳ありのとき目安時刻と残り時間を表示する", () => {
    // NOW = 4/11 12:00。10:00 授乳開始 + 180分 → 13:00 目安（残り1時間）
    render(
      <BabySummaryBar
        {...baseProps}
        lastNursing={makeNursingLog("2026-04-11T10:00:00+09:00")}
        feedingIntervalMin={180}
      />,
    )
    expect(screen.getByText("次の授乳の目安")).toBeInTheDocument()
    expect(screen.getByText(formatTimeJst("2026-04-11T13:00:00+09:00"))).toBeInTheDocument()
    expect(screen.getByText(/あと1時間/)).toBeInTheDocument()
    // 旧「次の搾乳の目安」カードは廃止（並記しない）
    expect(screen.queryByText("次の搾乳の目安")).not.toBeInTheDocument()
  })

  it("目安を 30 分過ぎていると「30分 経過」を表示する（「そろそろです」の張り付き廃止）", () => {
    // 08:30 授乳 + 180分 → 11:30 目安。NOW 12:00 は 30 分超過
    render(
      <BabySummaryBar
        {...baseProps}
        lastNursing={makeNursingLog("2026-04-11T08:30:00+09:00")}
        feedingIntervalMin={180}
      />,
    )
    expect(screen.getByText("30分 経過")).toBeInTheDocument()
    expect(screen.queryByText("そろそろです")).not.toBeInTheDocument()
  })

  it("目安を 2時間10分 過ぎていると「2時間10分 経過」を表示する（時間+分の書式）", () => {
    // 06:50 授乳 + 180分 → 09:50 目安。NOW 12:00 は 130 分超過
    render(
      <BabySummaryBar
        {...baseProps}
        lastNursing={makeNursingLog("2026-04-11T06:50:00+09:00")}
        feedingIntervalMin={180}
      />,
    )
    expect(screen.getByText("2時間10分 経過")).toBeInTheDocument()
  })

  it("授乳が無ければ目安は表示しない", () => {
    render(<BabySummaryBar {...baseProps} lastNursing={null} />)
    expect(screen.queryByText("次の授乳の目安")).not.toBeInTheDocument()
  })

  it("過去日を見ているときは目安を表示しない（今日限定）", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        date={PAST_DATE}
        lastNursing={makeNursingLog("2026-04-05T10:00:00+09:00")}
      />,
    )
    expect(screen.queryByText("次の授乳の目安")).not.toBeInTheDocument()
  })

  it("最終授乳（搾乳を含む）と目安の起点（搾乳を除く）は別の値で描かれる", () => {
    // 11:50 に搾乳（最終授乳＝10分前）、直近の授乳は 10:00（目安は 13:00）。
    // 搾乳で目安が飛ばないこと・最終授乳表示の契約は変えないことの同時固定。
    render(
      <BabySummaryBar
        {...baseProps}
        lastFeeding={makeFeedingLog({
          id: "pumped-1",
          feeding_type: "pumped",
          logged_at: "2026-04-11T11:50:00+09:00",
          amount_ml: 60,
        })}
        lastNursing={makeNursingLog("2026-04-11T10:00:00+09:00")}
      />,
    )
    expect(screen.getByText("10分前")).toBeInTheDocument()
    expect(
      screen.getByText(formatTimeJst("2026-04-11T13:00:00+09:00")),
    ).toBeInTheDocument()
  })
})

describe("BabySummaryBar の「今」カード（夜間に一瞥で読む面）", () => {
  it("今日は「最終授乳（開始から）」の経過を主値に、開始時刻と記録の要約（開始側つき）を添える", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        lastFeeding={makeFeedingLog({
          feeding_type: "breast",
          amount_ml: null,
          logged_at: "2026-04-11T10:00:00+09:00",
          breast_left_count: 2,
          breast_right_count: 1,
          breast_left_sec: 600,
          breast_right_sec: 420,
          duration_sec: 1020,
          breast_start_side: "left",
        })}
      />,
    )
    expect(screen.getByText("最終授乳（開始から）")).toBeInTheDocument()
    expect(screen.getByText("2時間前")).toBeInTheDocument()
    expect(
      screen.getByText(/^10:00 開始・母乳（左から） 左2回10分・右1回7分$/),
    ).toBeInTheDocument()
  })

  it("記録に開始側が無い行は推測で補わぬ（「次は右から」等の推奨も出さぬ）", () => {
    render(
      <BabySummaryBar
        {...baseProps}
        lastFeeding={makeFeedingLog({
          feeding_type: "breast",
          amount_ml: null,
          logged_at: "2026-04-11T10:00:00+09:00",
          breast_left_count: 1,
          breast_right_count: 1,
          breast_start_side: null,
        })}
      />,
    )
    expect(screen.queryByText(/左から|右から/)).toBeNull()
    expect(screen.queryByText(/次は/)).toBeNull()
    // 対照: 要約そのもの（開始側なしの形）は出ておる
    expect(screen.getByText(/^10:00 開始・母乳 左1・右1$/)).toBeInTheDocument()
  })

  it("取得中は目安も出さぬ（前の日の値を今の目安と偽らぬ）。対照: ready なら出す", () => {
    const nursing = makeFeedingLog({
      feeding_type: "breast",
      amount_ml: null,
      logged_at: "2026-04-11T10:00:00+09:00",
    })
    const view = render(
      <BabySummaryBar {...baseProps} lastFeeding={nursing} lastNursing={nursing} status="loading" />,
    )
    expect(screen.queryByText("次の授乳の目安")).toBeNull()
    view.rerender(
      <BabySummaryBar {...baseProps} lastFeeding={nursing} lastNursing={nursing} status="ready" />,
    )
    expect(screen.getByText("次の授乳の目安")).toBeInTheDocument()
  })

  it("差し込んだ面（クイック記録）は「今」カードとまとめの間に描く", () => {
    render(
      <BabySummaryBar {...baseProps}>
        <button type="button">差し込み</button>
      </BabySummaryBar>,
    )
    const now = screen.getByRole("region", { name: "今の授乳の状況" })
    const slot = screen.getByRole("button", { name: "差し込み" })
    const summary = screen.getByRole("group", { name: "今日のまとめ" })
    expect(now.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(slot.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
