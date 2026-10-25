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

describe("BabyTimeline の記録者表示（機能 A）", () => {
  it("recorderLabelFor があれば各行の logged_by から名前を引いて出す", () => {
    const logs = [
      feedingLog({ id: "a", logged_by: "u1", amount_ml: 10 }),
      feedingLog({ id: "b", logged_by: "u2", amount_ml: 20 }),
    ]
    const names: Record<string, string> = { u1: "はな", u2: "たろう" }
    render(
      <BabyTimeline
        logs={logs}
        onEdit={vi.fn()}
        recorderLabelFor={(id) => names[id] ?? "家族"}
      />,
    )
    expect(screen.getByText("はな")).toBeInTheDocument()
    expect(screen.getByText("たろう")).toBeInTheDocument()
  })

  it("null なら出さぬ（一人の世帯）", () => {
    render(
      <BabyTimeline
        logs={[feedingLog({ id: "a", logged_by: "u1", amount_ml: 10 })]}
        onEdit={vi.fn()}
        recorderLabelFor={null}
      />,
    )
    expect(screen.queryByText("家族")).toBeNull()
  })
})

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

describe("BabyTimeline の空・件数・時刻の列", () => {
  it("空の今日は「まだ記録がありません」と、記録の釦の場所を示す", () => {
    render(<BabyTimeline logs={[]} onEdit={vi.fn()} isToday />)
    expect(screen.getByText("まだ記録がありません")).toBeInTheDocument()
    expect(screen.getByText(/「授乳」「おむつ」のボタンから記録できます/)).toBeInTheDocument()
  })

  it("空の過去日は「この日の記録を追加」を示す（今の記録の釦は過去日に無い）", () => {
    render(<BabyTimeline logs={[]} onEdit={vi.fn()} isToday={false} />)
    expect(screen.getByText(/「この日の記録を追加」から追記できます/)).toBeInTheDocument()
    expect(screen.queryByText(/ボタンから記録できます/)).toBeNull()
  })

  it("見出しに件数を出し、各行は時刻を先頭（左の列）に置く", () => {
    const logs = [
      feedingLog({ id: "a", amount_ml: 11, logged_at: "2026-07-18T01:05:00.000Z" }),
      feedingLog({ id: "b", amount_ml: 22, logged_at: "2026-07-18T03:00:00.000Z" }),
    ]
    render(<BabyTimeline logs={logs} onEdit={vi.fn()} />)
    expect(screen.getByText("2件・新しい順")).toBeInTheDocument()
    const rows = screen.getAllByRole("button")
    // JST 12:00 が先（新しい順）。行の文字の先頭が時刻
    expect(rows[0].textContent?.startsWith("12:00")).toBe(true)
    expect(rows[1].textContent?.startsWith("10:05")).toBe(true)
  })
})
