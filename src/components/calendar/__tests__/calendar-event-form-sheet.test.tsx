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
import type { CalendarEventRecord } from "../use-month-events"

beforeEach(() => cleanup())

function ev(o: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: o.title ?? "予定",
    memo: o.memo ?? null,
    is_all_day: o.is_all_day ?? true,
    start_date: o.start_date ?? "2026-07-15",
    end_date: o.end_date ?? o.start_date ?? "2026-07-15",
    start_at: o.start_at ?? null,
    end_at: o.end_at ?? null,
    source: o.source ?? "native",
    series_id: o.series_id ?? null,
    ...o,
  }
}

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
      onDeleteSeries={vi.fn()}
    />,
  )
}

function renderEditForm(
  editing: CalendarEventRecord,
  overrides?: { onDeleteSeries?: () => void },
) {
  return render(
    <CalendarEventFormSheet
      open
      onOpenChange={() => {}}
      editing={editing}
      defaultDate="2026-07-15"
      saving={false}
      onSubmit={vi.fn()}
      onDelete={vi.fn()}
      onDeleteSeries={overrides?.onDeleteSeries ?? vi.fn()}
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

describe("CalendarEventFormSheet - 繰り返し(作成モードのみ)", () => {
  it("作成モードで繰り返し select が見え、既定「なし」・終了日入力は非表示", () => {
    renderNewForm()
    expect(screen.getByText("タイトル")).toBeInTheDocument()

    // 繰り返しラベル + trigger 表示値「なし」
    expect(screen.getByText("繰り返し")).toBeInTheDocument()
    expect(screen.getByText("なし")).toBeInTheDocument()
    // repeat=none のため終了日入力は出ていない
    expect(document.getElementById("cal-repeat-until")).toBeNull()
  })

  it("編集モードでは繰り返し UI を出さない(シリーズ編集はスコープ外)", () => {
    renderEditForm(ev({ id: "e1", source: "native" }))
    // sanity anchor
    expect(screen.getByText("予定を編集")).toBeInTheDocument()

    expect(screen.queryByText("繰り返し")).not.toBeInTheDocument()
    expect(document.getElementById("cal-repeat")).toBeNull()
  })
})

describe("CalendarEventFormSheet - シリーズ一括削除", () => {
  it("series_id を持つ予定の編集で「すべて削除」ボタンが出て onDeleteSeries を呼ぶ", () => {
    const onDeleteSeries = vi.fn()
    renderEditForm(ev({ id: "e1", source: "native", series_id: "ser-9" }), {
      onDeleteSeries,
    })
    const btn = screen.getByRole("button", { name: /すべて削除/ })
    expect(btn).toBeInTheDocument()
    fireEvent.click(btn)
    expect(onDeleteSeries).toHaveBeenCalledWith("ser-9")
  })

  it("単発(series_id null)の編集では「すべて削除」ボタンを出さない", () => {
    renderEditForm(ev({ id: "e1", source: "native", series_id: null }))
    expect(screen.getByText("予定を編集")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /すべて削除/ }),
    ).not.toBeInTheDocument()
  })

  it("Google 予定(閲覧のみ)ではシリーズ削除ボタンを出さない", () => {
    renderEditForm(ev({ id: "g1", source: "google", series_id: "ser-9" }))
    expect(screen.getByText("予定（Google）")).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: /すべて削除/ }),
    ).not.toBeInTheDocument()
  })
})
