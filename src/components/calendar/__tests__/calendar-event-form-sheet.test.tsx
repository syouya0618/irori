/**
 * CalendarEventFormSheet の「終日｜時刻あり」セグメントトグルの回帰テスト(CAL-3)。
 * - 発見性: 開いた瞬間に「時刻あり」の選択肢が見える(チェックボックスの解読不要)
 * - トグル切替で時刻入力が出現/非表示になる
 * - 終日へ戻すと入力済みの時刻値がクリアされる(startTime/endTime 両方)
 *
 * ポータル越し描画の取りこぼしと「要素が無い」を区別するため、各テストの冒頭で
 * 既知の要素(タイトルラベル)の存在を先に確認する(sanity anchor)。時刻入力の
 * 有無・値は既存テストに倣い document.getElementById で参照する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

import { CalendarEventFormSheet } from "../calendar-event-form-sheet"

beforeEach(() => cleanup())

function renderNewForm() {
  return render(
    <CalendarEventFormSheet
      open
      onOpenChange={() => {}}
      editing={null}
      defaultDate="2026-07-15"
      saving={false}
      onSubmit={vi.fn()}
      onDelete={vi.fn()}
    />,
  )
}

const startTimeInput = () =>
  document.getElementById("cal-start-time") as HTMLInputElement | null
const endTimeInput = () =>
  document.getElementById("cal-end-time") as HTMLInputElement | null

describe("CalendarEventFormSheet - 終日/時刻あり セグメント", () => {
  it("開いた瞬間に「終日」と「時刻あり」の選択肢が見える(発見性)", () => {
    renderNewForm()
    // sanity anchor: シートが描画されている
    expect(screen.getByText("タイトル")).toBeInTheDocument()

    expect(screen.getByRole("button", { name: "終日" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "時刻あり" })).toBeInTheDocument()
    // 既定は終日 → 時刻入力は出ていない
    expect(startTimeInput()).toBeNull()
  })

  it("「時刻あり」で時刻入力が現れ、「終日」で消える", () => {
    renderNewForm()
    expect(screen.getByText("タイトル")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    expect(startTimeInput()).not.toBeNull()
    expect(endTimeInput()).not.toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "終日" }))
    expect(startTimeInput()).toBeNull()
  })

  it("終日へ戻すと入力した開始/終了時刻がクリアされる", () => {
    renderNewForm()
    expect(screen.getByText("タイトル")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    const start = startTimeInput()!
    const end = endTimeInput()!
    fireEvent.change(start, { target: { value: "14:00" } })
    fireEvent.change(end, { target: { value: "15:00" } })
    expect(start.value).toBe("14:00")
    expect(end.value).toBe("15:00")

    // 終日 → 時刻あり に戻すと 14:00/15:00 は消え、既定(09:00 / 空)へ戻る
    fireEvent.click(screen.getByRole("button", { name: "終日" }))
    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    expect(startTimeInput()!.value).toBe("09:00")
    expect(endTimeInput()!.value).toBe("")
  })
})
