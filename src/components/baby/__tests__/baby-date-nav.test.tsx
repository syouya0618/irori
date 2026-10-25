import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { BabyDateNav } from "../baby-date-nav"

afterEach(cleanup)

const TODAY = "2026-10-19"

describe("BabyDateNav の日付ジャンプ（機能 B）", () => {
  it("日付ピッカーで過去日を選ぶとその日へ移動する", () => {
    const onDateChange = vi.fn()
    render(<BabyDateNav selectedDate={TODAY} today={TODAY} onDateChange={onDateChange} />)
    const picker = screen.getByLabelText("日付を選んで移動") as HTMLInputElement
    expect(picker.type).toBe("date")
    expect(picker.max).toBe(TODAY)
    fireEvent.change(picker, { target: { value: "2026-09-01" } })
    expect(onDateChange).toHaveBeenCalledWith("2026-09-01")
  })

  it("未来・不正・空は無視する（表示の選択日は動かさぬ）", () => {
    const onDateChange = vi.fn()
    render(<BabyDateNav selectedDate={TODAY} today={TODAY} onDateChange={onDateChange} />)
    const picker = screen.getByLabelText("日付を選んで移動")
    fireEvent.change(picker, { target: { value: "2026-10-20" } })
    fireEvent.change(picker, { target: { value: "" } })
    fireEvent.change(picker, { target: { value: "2026-02-30" } })
    expect(onDateChange).not.toHaveBeenCalled()
  })

  it("前の日・今日・次の日は従来どおり", () => {
    const onDateChange = vi.fn()
    render(<BabyDateNav selectedDate="2026-10-18" today={TODAY} onDateChange={onDateChange} />)
    fireEvent.click(screen.getByRole("button", { name: "前の日" }))
    expect(onDateChange).toHaveBeenLastCalledWith("2026-10-17")
    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    expect(onDateChange).toHaveBeenLastCalledWith(TODAY)
    fireEvent.click(screen.getByRole("button", { name: "次の日" }))
    expect(onDateChange).toHaveBeenLastCalledWith(TODAY)
  })
})

describe("BabyDateNav の過去日の帯（今日との見分け）", () => {
  it("過去日は「過去の日を表示中」の帯と「今日に戻る」を出す", () => {
    const onDateChange = vi.fn()
    render(<BabyDateNav selectedDate="2026-10-10" today={TODAY} onDateChange={onDateChange} />)
    expect(screen.getByText("過去の日を表示中")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "今日に戻る" }))
    expect(onDateChange).toHaveBeenCalledWith(TODAY)
  })

  it("対照: 今日は帯も「今日に戻る」も出さず、「次の日」は押せぬ", () => {
    render(<BabyDateNav selectedDate={TODAY} today={TODAY} onDateChange={vi.fn()} />)
    expect(screen.queryByText("過去の日を表示中")).toBeNull()
    expect(screen.queryByRole("button", { name: "今日に戻る" })).toBeNull()
    expect(screen.getByRole("button", { name: "次の日" })).toBeDisabled()
  })
})
