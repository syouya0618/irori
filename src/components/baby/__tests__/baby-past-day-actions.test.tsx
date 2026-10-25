import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { BabyPastDayActions } from "../baby-past-day-actions"

afterEach(cleanup)

describe("BabyPastDayActions（過去日の追記・機能 C）", () => {
  it("日付を日本語で示し、5 種の追記ボタンが 44px 以上で並ぶ", () => {
    render(
      <BabyPastDayActions date="2026-07-18" onCreateLog={vi.fn()} onCreateFeeding={vi.fn()} />,
    )
    expect(screen.getByRole("region", { name: "この日の記録を追加" })).toBeInTheDocument()
    expect(screen.getByText(/2026年7月18日\(土\) の記録として保存します/)).toBeInTheDocument()
    for (const name of ["授乳", "おむつ", "体温", "成長", "メモ"]) {
      const button = screen.getByRole("button", { name })
      // 44px 以上（min-h-11 = 44px / min-h-12 = 48px …）
      expect(button.className).toMatch(/\bmin-h-(1[1-9]|[2-9]\d)\b/)
    }
  })

  it("授乳はフォーム経由（onCreateFeeding）、他は種別つきで onCreateLog を呼ぶ", () => {
    const onCreateLog = vi.fn()
    const onCreateFeeding = vi.fn()
    render(
      <BabyPastDayActions
        date="2026-07-18"
        onCreateLog={onCreateLog}
        onCreateFeeding={onCreateFeeding}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "授乳" }))
    expect(onCreateFeeding).toHaveBeenCalledWith("bottle")
    fireEvent.click(screen.getByRole("button", { name: "おむつ" }))
    expect(onCreateLog).toHaveBeenLastCalledWith("diaper")
    fireEvent.click(screen.getByRole("button", { name: "体温" }))
    expect(onCreateLog).toHaveBeenLastCalledWith("temperature")
    fireEvent.click(screen.getByRole("button", { name: "成長" }))
    expect(onCreateLog).toHaveBeenLastCalledWith("growth")
    fireEvent.click(screen.getByRole("button", { name: "メモ" }))
    expect(onCreateLog).toHaveBeenLastCalledWith("memo")
  })
})
