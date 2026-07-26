import { describe, expect, it, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

import { BabyTimeline } from "../baby-timeline"
import type { BabyLogData } from "@/lib/types/baby"

afterEach(cleanup)

// フィクスチャは baby-log-form-sheet.test.tsx の bottleFeedingLog に倣い、
// 正しい `temperature` フィールドで型キャストなしに組む。
function feedingLog(overrides: Partial<BabyLogData> = {}): BabyLogData {
  return {
    id: "log-1",
    log_type: "feeding",
    logged_at: "2026-07-18T12:00:00.000Z",
    logged_by: "user-1",
    feeding_type: "bottle",
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
    created_at: "2026-07-18T12:00:00.000Z",
    ...overrides,
  }
}

// 各アイテムは <button> で描画されるため、DOM 順に読み出して並びを検証する。
// amount_ml をユニークにして summary（"…{n}ml"）から順序を復元する。
function renderedAmounts(): number[] {
  return screen.getAllByRole("button").map((btn) => {
    const m = btn.textContent?.match(/(\d+)ml/)
    return m ? Number(m[1]) : NaN
  })
}

describe("BabyTimeline の時系列降順ソート（タスクB: 時刻編集の並び保証）", () => {
  it("logs が順不同で渡されても logged_at 降順で描画する", () => {
    // 全て UTC 同一形式（本番の DB/Realtime 行と同じ）。amount_ml で位置を識別する。
    const logs = [
      feedingLog({ id: "a", logged_at: "2026-07-18T01:00:00.000Z", amount_ml: 10 }),
      feedingLog({ id: "b", logged_at: "2026-07-18T05:00:00.000Z", amount_ml: 30 }),
      feedingLog({ id: "c", logged_at: "2026-07-18T03:00:00.000Z", amount_ml: 20 }),
    ]
    render(<BabyTimeline logs={logs} onEdit={vi.fn()} />)
    // 05:00(30) → 03:00(20) → 01:00(10) の降順
    expect(renderedAmounts()).toEqual([30, 20, 10])
  })

  it("logged_at が同値の行は渡された元順を保つ（sort の安定性）", () => {
    const logs = [
      feedingLog({ id: "x", logged_at: "2026-07-18T05:00:00.000Z", amount_ml: 11 }),
      feedingLog({ id: "y", logged_at: "2026-07-18T05:00:00.000Z", amount_ml: 22 }),
      feedingLog({ id: "z", logged_at: "2026-07-18T05:00:00.000Z", amount_ml: 33 }),
    ]
    render(<BabyTimeline logs={logs} onEdit={vi.fn()} />)
    expect(renderedAmounts()).toEqual([11, 22, 33])
  })
})
