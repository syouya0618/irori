import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { BabyDailyDiary } from "../baby-daily-diary"
import type { BabyDiaryData } from "@/lib/types/baby"

afterEach(cleanup)

const diary: BabyDiaryData = {
  id: "d1",
  diary_date: "2026-07-22",
  content: "1行目\n2行目\n3行目",
  updated_at: "2026-07-22T12:00:00+09:00",
}

describe("BabyDailyDiary（その日の育児日記・日末セクション）", () => {
  it("日記の全文を常時表示する（改行保持・line-clamp なし）", () => {
    render(<BabyDailyDiary diary={diary} isToday={true} onEdit={() => {}} />)
    const body = screen.getByText(/1行目/)
    expect(body).toHaveClass("whitespace-pre-wrap")
    expect(body.className).not.toContain("line-clamp")
    expect(body.textContent).toBe("1行目\n2行目\n3行目")
  })

  it("タイトルは今日なら「今日の育児日記」、過去日なら「育児日記」", () => {
    const { rerender } = render(
      <BabyDailyDiary diary={diary} isToday={true} onEdit={() => {}} />,
    )
    expect(screen.getByText("今日の育児日記")).toBeInTheDocument()
    rerender(<BabyDailyDiary diary={diary} isToday={false} onEdit={() => {}} />)
    expect(screen.getByText("育児日記")).toBeInTheDocument()
  })

  it("本文タップで onEdit が呼ばれる", () => {
    const onEdit = vi.fn()
    render(<BabyDailyDiary diary={diary} isToday={true} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: "日記を編集" }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("日記が無い日は「日記を書く」を出し、タップで onEdit が呼ばれる（過去日も書ける）", () => {
    const onEdit = vi.fn()
    render(<BabyDailyDiary diary={null} isToday={false} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole("button", { name: /日記を書く/ }))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it("空の日でも /baby/diary への「すべて」導線が常在する", () => {
    render(<BabyDailyDiary diary={null} isToday={true} onEdit={() => {}} />)
    const link = screen.getByRole("link", { name: /すべて/ })
    expect(link).toHaveAttribute("href", "/baby/diary")
  })
})
