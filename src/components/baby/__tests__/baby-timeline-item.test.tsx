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
