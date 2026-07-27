import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { BabyTimelineItem } from "../baby-timeline-item"
import type { BabyLogData } from "@/lib/types/baby"

function feedingLog(overrides: Partial<BabyLogData>): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    logged_at: "2026-07-18T10:00:00+09:00",
    ended_at: null,
    feeding_type: "bottle",
    amount_ml: null,
    duration_min: null,
    duration_sec: null,
    diaper_type: null,
    temperature_c: null,
    weight_g: null,
    height_cm: null,
    memo: null,
    logged_by: "user-1",
    household_id: "hh-1",
    created_at: "2026-07-18T10:00:00+09:00",
    ...overrides,
  } as BabyLogData
}

describe("BabyTimelineItem の量表示（falsy 0 衝突: B-06 の表示側）", () => {
  it("amount_ml が 0 のとき「0ml」を表示する（0 は有効な記録値）", () => {
    render(<BabyTimelineItem log={feedingLog({ amount_ml: 0 })} onEdit={vi.fn()} />)
    expect(screen.getByText(/0ml/)).toBeInTheDocument()
  })

  it("amount_ml が null のとき量は表示しない", () => {
    render(<BabyTimelineItem log={feedingLog({ amount_ml: null })} onEdit={vi.fn()} />)
    expect(screen.queryByText(/ml/)).not.toBeInTheDocument()
  })

  it("amount_ml が正の値のとき従来どおり表示する", () => {
    render(<BabyTimelineItem log={feedingLog({ amount_ml: 120 })} onEdit={vi.fn()} />)
    expect(screen.getByText(/120ml/)).toBeInTheDocument()
  })
})

describe("BabyTimelineItem の授乳時間表示（秒精度）", () => {
  it("duration_sec があれば「M分S秒」で表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({ feeding_type: "breast_left", duration_sec: 160, duration_min: 3 })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText(/2分40秒/)).toBeInTheDocument()
  })

  it("秒が 0 の分ちょうどは「M分」で表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({ feeding_type: "breast_left", duration_sec: 180, duration_min: 3 })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText(/3分/)).toBeInTheDocument()
  })

  it("duration_sec が無く duration_min のみの旧データは「M分」にフォールバックする", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({ feeding_type: "breast_left", duration_sec: null, duration_min: 5 })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText(/5分/)).toBeInTheDocument()
  })
})

describe("BabyTimelineItem の母乳サイクル表示（feeding_type='breast'）", () => {
  // 注意: 上の feedingLog() は `as BabyLogData` cast を持つ（既存の temperature_c 等の
  // 名前ズレを通してしまう）。ゆえに counts は明示フィールド名で渡し、期待値も
  // **完全一致**で固定する — 正規表現の部分一致だと「内訳が出ていない」バグを
  // 通してしまうため（例: parts に空文字が混ざった `母乳  12分30秒`）。
  it("左右の回数と授乳時間を「母乳 左2・右1 12分30秒」の1行で表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "breast",
          breast_left_count: 2,
          breast_right_count: 1,
          duration_sec: 750,
          duration_min: 13,
        })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("母乳 左2・右1 12分30秒")).toBeInTheDocument()
  })

  it("片側だけ吸わせた回（左0・右2）は 0 の側を省いて「母乳 右2 …」と表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "breast",
          breast_left_count: 0,
          breast_right_count: 2,
          duration_sec: 300,
          duration_min: 5,
        })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("母乳 右2 5分")).toBeInTheDocument()
  })

  it("時間なしの母乳サイクルは「母乳 左1」だけを表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "breast",
          breast_left_count: 1,
          breast_right_count: 0,
          duration_sec: null,
          duration_min: null,
        })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("母乳 左1")).toBeInTheDocument()
  })

  it("counts が両方 0/null の壊れた行でも余分な空白を挟まず「母乳」だけを表示する", () => {
    // formatBreastCounts は内訳なしで "" を返す契約ゆえ、そのまま join すると
    // 「母乳  3分」のように二重空白が出る。空文字は push しないことを固定する。
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "breast",
          breast_left_count: null,
          breast_right_count: null,
          duration_sec: 180,
          duration_min: 3,
        })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("母乳 3分")).toBeInTheDocument()
  })

  it("移行前の片側行（breast_left）は従来どおり「左 …」表示のまま（回帰）", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "breast_left",
          breast_left_count: null,
          breast_right_count: null,
          duration_sec: 300,
          duration_min: 5,
        })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("左 5分")).toBeInTheDocument()
  })
})

describe("BabyTimelineItem のメモ表示（複数行・改行反映）", () => {
  it("メモログは全文を whitespace-pre-wrap で表示し改行を保持する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          log_type: "memo",
          feeding_type: null,
          memo: "1行目\n2行目",
        })}
        onEdit={vi.fn()}
      />,
    )
    const el = screen.getByText(/1行目/)
    expect(el).toHaveClass("whitespace-pre-wrap")
    expect(el.textContent).toBe("1行目\n2行目")
  })

  it("メモ本文が空のメモログは「メモ」を表示する", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({ log_type: "memo", feeding_type: null, memo: null })}
        onEdit={vi.fn()}
      />,
    )
    expect(screen.getByText("メモ")).toBeInTheDocument()
  })

  it("授乳など他タイプのメモ注記は要約 + 複数行注記（改行反映）で密度を保つ（回帰）", () => {
    render(
      <BabyTimelineItem
        log={feedingLog({
          feeding_type: "bottle",
          amount_ml: 120,
          memo: "よく飲んだ\nご機嫌",
        })}
        onEdit={vi.fn()}
      />,
    )
    // 要約行（量）は従来どおり残る
    expect(screen.getByText(/120ml/)).toBeInTheDocument()
    // 注記は複数行対応（改行反映・line-clamp-2）
    const note = screen.getByText(/よく飲んだ/)
    expect(note).toHaveClass("whitespace-pre-wrap")
    expect(note).toHaveClass("line-clamp-2")
    expect(note.textContent).toBe("よく飲んだ\nご機嫌")
  })
})

describe("BabyTimelineItem: 左右別授乳時間（sides）を持つサイクル行", () => {
  it("母乳 左2回7分30秒・右1回5分 の形で表示し、合計は併記しない", () => {
    const log = {
      id: "s1",
      log_type: "feeding",
      logged_at: "2026-07-27T10:00:00+09:00",
      logged_by: "u1",
      feeding_type: "breast",
      amount_ml: null,
      breast_left_count: 2,
      breast_right_count: 1,
      breast_left_sec: 450,
      breast_right_sec: 300,
      diaper_type: null,
      ended_at: null,
      temperature: null,
      weight_g: null,
      height_cm: null,
      duration_min: 13,
      duration_sec: 750,
      memo: null,
      created_at: "2026-07-27T10:12:30+09:00",
    } as BabyLogData
    render(<BabyTimelineItem log={log} onEdit={() => {}} />)
    expect(
      screen.getByText("母乳 左2回7分30秒・右1回5分"),
    ).toBeInTheDocument()
    // 合計（12分30秒）は左右の和と自明ゆえ併記しない
    expect(screen.queryByText(/12分30秒/)).not.toBeInTheDocument()
  })
})
