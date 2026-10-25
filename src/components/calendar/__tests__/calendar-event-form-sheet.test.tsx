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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"

import { CalendarEventFormSheet } from "../calendar-event-form-sheet"
import type { CalendarEventRecord } from "../use-month-events"
import * as dateJst from "@/lib/utils/date-jst"

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
    updated_at: o.updated_at ?? "2026-07-01T00:00:00.000000+00:00",
    ...o,
  }
}

function renderNewForm(overrides?: { onSubmit?: (v: unknown) => void }) {
  return render(
    <CalendarEventFormSheet
      open
      onOpenChange={() => {}}
      editing={null}
      defaultDate="2026-07-15"
      saving={false}
      onSubmit={overrides?.onSubmit ?? vi.fn()}
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
const titleInput = () =>
  document.getElementById("cal-title") as HTMLInputElement | null
const memoInput = () => document.getElementById("cal-memo") as HTMLInputElement | null
const startDateInput = () =>
  document.getElementById("cal-start-date") as HTMLInputElement | null
const endDateInput = () =>
  document.getElementById("cal-end-date") as HTMLInputElement | null

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

describe("CalendarEventFormSheet - シートの高さとスクロール", () => {
  /**
   * シートは画面下端に固定され高さは中身なり。上限もスクロール領域も無いと、
   * 「時刻あり」や繰り返しで中身が伸びた時に上端（閉じる・タイトル欄）が画面外へ
   * 押し出され、fixed ゆえスクロールでも戻せぬ。育児ログ側のシートと同じく
   * 上限 + 本文スクロール + 保存ボタンは本文の外（常時見える）に揃える。
   * jsdom は寸法を測れぬゆえ構造の契約で固定する。
   */
  it("入力欄は本文のスクロール領域に入り、保存ボタンはその外に在る", () => {
    renderNewForm()
    expect(screen.getByText("タイトル")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))

    const sheet = titleInput()!.closest('[data-slot="sheet-content"]')
    expect(sheet).not.toBeNull()
    expect(sheet?.className).toMatch(/max-h-\[85dvh\]/)

    const scroller = startTimeInput()!.closest(".overflow-y-auto")
    expect(scroller).not.toBeNull()
    expect(titleInput()!.closest(".overflow-y-auto")).toBe(scroller)

    const save = screen.getByRole("button", { name: "追加" })
    expect(scroller?.contains(save)).toBe(false)
    expect(sheet?.contains(save)).toBe(true)
  })

  it("本文は左右に余白を持つ（入力欄を画面端に密着させぬ）", () => {
    renderNewForm()
    const scroller = titleInput()!.closest(".overflow-y-auto")
    expect(scroller?.className).toMatch(/\bpx-4\b/)
  })
})

describe("CalendarEventFormSheet - 編集時の時刻 seed", () => {
  // <input type="time"> は "24:30" を不正値として空表示する。seed は h23 固定の
  // formatJstTimeInput で作る（date-jst.ts の注記どおり formatTimeJst は環境依存）。
  //
  // Node / jsdom の ICU は ja-JP でも h23 ゆえ、素のままでは formatTimeJst へ戻しても
  // 緑になる。ICU が h24 既定の環境を再現するため formatTimeJst だけを "24:30" に
  // 差し替える（server 側 actions.test.ts の「ICU h24 既定環境の再現」と同じ手）。
  it("深夜 0 時台の予定は 00:xx で seed される（formatTimeJst が 24:xx を返す環境でも）", () => {
    const spy = vi.spyOn(dateJst, "formatTimeJst").mockReturnValue("24:30")
    try {
      renderEditForm(
        ev({
          id: "midnight",
          is_all_day: false,
          start_date: "2026-07-15",
          end_date: "2026-07-15",
          start_at: "2026-07-14T15:30:00.000Z", // = JST 2026-07-15 00:30
          end_at: "2026-07-14T16:15:00.000Z", // = JST 01:15
        }),
      )
      expect(startTimeInput()!.value).toBe("00:30")
      expect(endTimeInput()!.value).toBe("01:15")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("CalendarEventFormSheet - 繰り返し(作成モードのみ)", () => {
  it("作成モードで繰り返し select が見え、既定「なし」・終了日入力は非表示", () => {
    renderNewForm()
    expect(screen.getByText("タイトル")).toBeInTheDocument()

    // 繰り返しラベル + trigger 表示値「なし」
    expect(screen.getByText("繰り返し")).toBeInTheDocument()
    // B-2 で「通知」Select も既定「なし」を出すようになったため、素の getByText では
    // multiple-match で割れる。trigger を id で名指しして**繰り返し側の**表示値を見る。
    expect(document.getElementById("cal-repeat")).toHaveTextContent("なし")
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

describe("CalendarEventFormSheet - 削除の確認（誤操作の防止）", () => {
  function renderDeletable(editing: CalendarEventRecord) {
    const onDelete = vi.fn()
    const onDeleteSeries = vi.fn()
    render(
      <CalendarEventFormSheet
        open
        onOpenChange={() => {}}
        editing={editing}
        defaultDate="2026-07-15"
        saving={false}
        onSubmit={vi.fn()}
        onDelete={onDelete}
        onDeleteSeries={onDeleteSeries}
      />,
    )
    return { onDelete, onDeleteSeries }
  }

  it("繰り返しの予定: 「削除」1 回では何も消さず、「この回だけ」と「すべての回」を選ばせる", () => {
    const { onDelete, onDeleteSeries } = renderDeletable(
      ev({ id: "e1", source: "native", series_id: "ser-9" }),
    )
    // 本文に即時の一括削除ボタンは置かぬ（1 タップで全回が消える導線を残さぬ）
    expect(screen.queryByRole("button", { name: /すべての回を削除/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(onDeleteSeries).not.toHaveBeenCalled()

    const dialog = screen.getByRole("group", { name: /削除|破棄|ログアウト/ })
    expect(dialog).toHaveTextContent("繰り返し予定を削除します")
    // 誤って押しても確定せぬよう、最初のフォーカスは取り消し側
    expect(screen.getByRole("button", { name: "キャンセル" })).toHaveFocus()

    fireEvent.click(screen.getByRole("button", { name: "繰り返しのすべての回を削除" }))
    expect(onDeleteSeries).toHaveBeenCalledWith("ser-9")
    expect(onDelete).not.toHaveBeenCalled()
  })

  it("繰り返しの予定: 「この回だけ削除」は単発削除だけを呼ぶ", () => {
    const { onDelete, onDeleteSeries } = renderDeletable(
      ev({ id: "e1", source: "native", series_id: "ser-9" }),
    )
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    fireEvent.click(screen.getByRole("button", { name: "この回だけ削除" }))
    expect(onDelete).toHaveBeenCalledWith("e1")
    expect(onDeleteSeries).not.toHaveBeenCalled()
  })

  it("単発の予定: 確認に一括削除の選択肢を出さず、「削除する」で 1 件だけ消す", () => {
    const { onDelete, onDeleteSeries } = renderDeletable(
      ev({ id: "e1", title: "検診", source: "native", series_id: null }),
    )
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    expect(screen.getByRole("group", { name: /削除|破棄|ログアウト/ })).toHaveTextContent("「検診」を削除しますか？")
    expect(screen.queryByRole("button", { name: /すべての回/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))
    expect(onDelete).toHaveBeenCalledWith("e1")
    expect(onDeleteSeries).not.toHaveBeenCalled()
  })

  it("キャンセルで確認を閉じ、何も消さずに編集へ戻る", () => {
    const { onDelete } = renderDeletable(ev({ id: "e1", source: "native" }))
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }))
    expect(screen.queryByRole("group", { name: /削除|破棄|ログアウト/ })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "更新" })).toBeInTheDocument()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it("Google 予定(閲覧のみ)では削除の導線そのものを出さない", () => {
    renderDeletable(ev({ id: "g1", source: "google", series_id: "ser-9" }))
    expect(screen.getByText("予定の詳細")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "削除" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /すべての回/ })).not.toBeInTheDocument()
  })

  it("繰り返しの 1 回を編集する時は「この回だけに適用」と明示する", () => {
    renderDeletable(ev({ id: "e1", source: "native", series_id: "ser-9" }))
    expect(screen.getByText(/変更はこの回だけに適用されます/)).toBeInTheDocument()
  })

  it("単発の編集ではその注記を出さぬ（対照）", () => {
    renderDeletable(ev({ id: "e1", source: "native", series_id: null }))
    expect(screen.queryByText(/変更はこの回だけに適用されます/)).not.toBeInTheDocument()
  })
})

describe("CalendarEventFormSheet - 入力途中で閉じない", () => {
  function renderWithOpenChange(editing: CalendarEventRecord | null = null) {
    const onOpenChange = vi.fn()
    render(
      <CalendarEventFormSheet
        open
        onOpenChange={onOpenChange}
        editing={editing}
        defaultDate="2026-07-15"
        saving={false}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onDeleteSeries={vi.fn()}
      />,
    )
    return onOpenChange
  }
  const pressEscape = () =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

  it("何も打っていなければ Esc でそのまま閉じる", () => {
    const onOpenChange = renderWithOpenChange()
    pressEscape()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("打ちかけの内容があれば閉じず、破棄の確認を出す", () => {
    const onOpenChange = renderWithOpenChange()
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    pressEscape()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("group", { name: /削除|破棄|ログアウト/ })).toHaveTextContent("入力中の内容を破棄して閉じますか？")
    expect(titleInput()!.value).toBe("検診")

    // 「編集を続ける」で戻れば入力はそのまま
    fireEvent.click(screen.getByRole("button", { name: "編集を続ける" }))
    expect(titleInput()!.value).toBe("検診")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // 明示的に破棄すれば閉じる
    pressEscape()
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("既存予定は値を元に戻せば確認なしで閉じる（差分で判定する）", () => {
    const onOpenChange = renderWithOpenChange(ev({ id: "e1", title: "検診" }))
    fireEvent.change(titleInput()!, { target: { value: "検診2" } })
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    pressEscape()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("確認を出した後に Esc をもう一度押しても、選ぶまで破棄せぬ", () => {
    const onOpenChange = renderWithOpenChange()
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    pressEscape()
    pressEscape()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(titleInput()!.value).toBe("検診")
  })

  it("親の保存中（別の予定・通知の往復）でも、打ちかけの入力を確認なしで捨てぬ", () => {
    const onOpenChange = vi.fn()
    render(
      <CalendarEventFormSheet
        open
        onOpenChange={onOpenChange}
        editing={null}
        defaultDate="2026-07-15"
        saving
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onDeleteSeries={vi.fn()}
      />,
    )
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    pressEscape()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole("group", { name: /破棄/ })).toBeInTheDocument()
  })

  it("復元した入力を確認で破棄したら、親が握る入力も消す（次に開いて蘇らせぬ）", () => {
    const onOpenChange = vi.fn()
    const onDiscardDraft = vi.fn()
    render(
      <CalendarEventFormSheet
        open
        onOpenChange={onOpenChange}
        editing={null}
        defaultDate="2026-07-15"
        saving={false}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onDeleteSeries={vi.fn()}
        initialDraft={{
          title: "保存できなかった題",
          memo: null,
          isAllDay: true,
          startDate: "2026-07-20",
          endDate: "2026-07-20",
          startTime: "09:00",
          endTime: "",
          repeat: "none",
          repeatUntil: "",
        }}
        onDiscardDraft={onDiscardDraft}
      />,
    )
    pressEscape()
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }))
    expect(onDiscardDraft).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("CalendarEventFormSheet - 保存できなかった入力の復元", () => {
  const draft = {
    title: "保存できなかった題",
    memo: "持ち物",
    isAllDay: true,
    startDate: "2026-07-20",
    endDate: "2026-07-20",
    startTime: "09:00",
    endTime: "",
    repeat: "none" as const,
    repeatUntil: "",
  }

  it("復元入力で始まり、その旨を出す。「破棄」で元の値へ戻し親へ伝える", () => {
    const onDiscardDraft = vi.fn()
    render(
      <CalendarEventFormSheet
        open
        onOpenChange={() => {}}
        editing={null}
        defaultDate="2026-07-15"
        saving={false}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        onDeleteSeries={vi.fn()}
        initialDraft={draft}
        onDiscardDraft={onDiscardDraft}
      />,
    )
    expect(titleInput()!.value).toBe("保存できなかった題")
    expect(startDateInput()!.value).toBe("2026-07-20")
    expect(screen.getByText("保存できなかった入力を復元しました。")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    expect(onDiscardDraft).toHaveBeenCalledTimes(1)
    expect(titleInput()!.value).toBe("")
    expect(startDateInput()!.value).toBe("2026-07-15")
  })

  it("復元入力が無ければ通知も出さぬ（対照）", () => {
    renderNewForm()
    expect(screen.queryByText("保存できなかった入力を復元しました。")).not.toBeInTheDocument()
  })
})

describe("CalendarEventFormSheet - 日時と繰り返しの予告", () => {
  it("入力中の日時を曜日つきの 1 行で示し、複数日の終日は日数を添える", () => {
    renderNewForm()
    expect(screen.getByText("7月15日（水）・終日")).toBeInTheDocument()
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-17" } })
    expect(
      screen.getByText("7月15日（水）〜7月17日（金）・終日（3日間）"),
    ).toBeInTheDocument()
  })

  it("時刻ありでは開始〜終了の時刻を示す", () => {
    renderNewForm()
    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    fireEvent.change(endTimeInput()!, { target: { value: "10:30" } })
    expect(screen.getByText("7月15日（水）09:00〜10:30")).toBeInTheDocument()
  })
})

describe("CalendarEventFormSheet - 保存前の検証(入力を失わない)", () => {
  it("終了日 < 開始日で「追加」しても onSubmit を呼ばず、入力は保持されエラーが出る", () => {
    const onSubmit = vi.fn()
    renderNewForm({ onSubmit })
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    fireEvent.change(memoInput()!, { target: { value: "母子手帳" } })
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-14" } })

    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    // シートを閉じる指示(onSubmit)は出ず、入力は 1 文字も失われていない
    expect(onSubmit).not.toHaveBeenCalled()
    expect(titleInput()!.value).toBe("検診")
    expect(memoInput()!.value).toBe("母子手帳")
    expect(endDateInput()!.value).toBe("2026-07-14")
    // サーバー検証と同一の文言が出る
    expect(screen.getByRole("alert")).toHaveTextContent(
      "終了日は開始日以降にしてください",
    )
  })

  // 本文は上限付きのスクロール領域ゆえ、エラーを本文の末尾に置くと、背の低い画面で
  // 最上部のまま「追加」を押した時に文言が画面外へ出て「押しても何も起きぬ」に見える。
  // 本文の外（保存ボタンの直上・常に見える位置）に置く。
  it("エラー文言はスクロール本文の外（保存ボタンと同じシート内）に出る", () => {
    renderNewForm()
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-14" } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    const alert = screen.getByRole("alert")
    expect(alert.closest(".overflow-y-auto")).toBeNull()
    expect(alert.closest('[data-slot="sheet-content"]')).not.toBeNull()
  })

  it("エラー時は該当入力に aria-invalid と aria-describedby が付く", () => {
    renderNewForm()
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-14" } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    const alert = screen.getByRole("alert")
    expect(endDateInput()!.getAttribute("aria-invalid")).toBe("true")
    expect(endDateInput()!.getAttribute("aria-describedby")).toBe(alert.id)
    // 無関係な入力には付かない
    expect(titleInput()!.getAttribute("aria-invalid")).toBeNull()
  })

  it("タイトル未入力も保存前に弾き、field=title 側に aria-invalid が付く", () => {
    const onSubmit = vi.fn()
    renderNewForm({ onSubmit })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("タイトルを入力してください")
    expect(titleInput()!.getAttribute("aria-invalid")).toBe("true")
  })

  it("入力を直すとエラー表示は消え、再度「追加」で onSubmit が呼ばれる", () => {
    const onSubmit = vi.fn()
    renderNewForm({ onSubmit })
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-14" } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    expect(screen.getByRole("alert")).toBeInTheDocument()

    fireEvent.change(endDateInput()!, { target: { value: "2026-07-16" } })
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(endDateInput()!.getAttribute("aria-invalid")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: "検診", endDate: "2026-07-16" }),
    )
  })

  it("検証を通れば onSubmit がフォーム値ごと呼ばれる(正常系の回帰)", () => {
    const onSubmit = vi.fn()
    renderNewForm({ onSubmit })
    fireEvent.change(titleInput()!, { target: { value: "検診" } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "検診",
        isAllDay: true,
        startDate: "2026-07-15",
        endDate: "2026-07-15",
      }),
    )
  })
})

describe("CalendarEventFormSheet - 開始日の変更に終了日が追従する", () => {
  it("開始日を動かすと終了日が同差分でシフトする", () => {
    renderNewForm()
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-17" } }) // 期間 = 2日
    fireEvent.change(startDateInput()!, { target: { value: "2026-07-20" } })
    expect(endDateInput()!.value).toBe("2026-07-22")
  })

  it("開始日をクリアしても終了日は消えない(差分が計算できないため据え置き)", () => {
    renderNewForm()
    fireEvent.change(endDateInput()!, { target: { value: "2026-07-17" } })
    fireEvent.change(startDateInput()!, { target: { value: "" } })
    expect(endDateInput()!.value).toBe("2026-07-17")
  })
  // 繰り返し終了日の追従は applyStartDateShift の単体テスト(calendar-form.test.ts)で
  // 固定する。base-ui Select は jsdom で popup を開けず、この経路を DOM から
  // 駆動できないため(実ブラウザ側は e2e の繰り返しテストが担保)。
})

/**
 * B-2「通知」Select。
 *
 * ## なぜ google 側を重く見るか
 * `calendar_events` の UPDATE ポリシーは **source='native' 限定**ゆえ、google 由来の
 * 予定は本文が read-only じゃ。しかし主の予定の多くは google 行で、そこへ通知を
 * 付けられねば機能が半分しか働かぬ。通知を**別テーブル**へ出したのはこのためで、
 * 「read-only シートでも通知だけは操作できる」が本機能の眼目そのものになる。
 * ゆえにここを回帰で固定する。
 */
const reminderTrigger = () =>
  document.getElementById("cal-reminder") as HTMLButtonElement | null

function renderSheet(props: Partial<React.ComponentProps<typeof CalendarEventFormSheet>>) {
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
      onReminderChange={vi.fn()}
      {...props}
    />,
  )
}

describe("CalendarEventFormSheet - 通知(B-2)", () => {
  it("新規作成で「通知」Select が出て、既定は「なし」", () => {
    renderSheet({})
    expect(screen.getByText("通知")).toBeInTheDocument()
    expect(reminderTrigger()).toHaveTextContent("なし")
  })

  it("既定値を渡せばその選択肢が出る(notification_preferences 由来の既定)", () => {
    renderSheet({ reminder: { status: "ready", choice: "m30" } })
    expect(reminderTrigger()).toHaveTextContent("30分前")
  })

  it("**google の read-only 詳細シートでも通知 Select は操作できる**", () => {
    renderSheet({
      editing: ev({ id: "g1", source: "google" }),
      reminder: { status: "ready", choice: "none" },
    })
    // sanity anchor: read-only の詳細シートであること
    expect(screen.getByText("予定の詳細")).toBeInTheDocument()
    // 本文は編集させぬ
    expect(document.getElementById("cal-title")).toBeNull()
    // が、通知だけは出ておりかつ有効
    const trigger = reminderTrigger()
    expect(trigger).toBeInTheDocument()
    expect(trigger).not.toBeDisabled()
  })

  it("google 予定に設定済みの通知は選択肢として表示される", () => {
    renderSheet({
      editing: ev({ id: "g1", source: "google" }),
      reminder: { status: "ready", choice: "prev_day_20" },
    })
    expect(reminderTrigger()).toHaveTextContent("前日20時")
  })

  it("読み込み中は操作させず、その旨を文言で出す(色だけに頼らぬ)", () => {
    renderSheet({
      editing: ev({ id: "e1", source: "native" }),
      reminder: { status: "loading" },
    })
    expect(reminderTrigger()).toBeDisabled()
    expect(screen.getByText(/読み込み中/)).toBeInTheDocument()
  })

  it("未知の通知設定は「なし」と偽らず、変更を止めて理由を出す", () => {
    renderSheet({
      editing: ev({ id: "e1", source: "native" }),
      reminder: { status: "unsupported" },
    })
    expect(reminderTrigger()).toBeDisabled()
    expect(screen.getByText(/まだ知らない通知設定/)).toBeInTheDocument()
  })

  describe("予告（現在時刻を 2026-07-01 に固定）", () => {
    // 予告は「過ぎた時刻なら届かぬ」と言い分けるゆえ、現在時刻に依存する。Date だけを偽る。
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(new Date("2026-07-01T00:00:00Z"))
    })
    afterEach(() => vi.useRealTimers())

    it("通知時刻の予告を出す(終日 7/15 の 30 分前 = 7月14日 23:30)", () => {
      renderSheet({
        editing: ev({ id: "g1", source: "google", start_date: "2026-07-15" }),
        reminder: { status: "ready", choice: "m30" },
      })
      expect(screen.getByText("7月14日 23:30 に通知します")).toBeInTheDocument()
    })

    it("前日20時の予告(7/15 → 7月14日 20:00)", () => {
      renderSheet({
        editing: ev({ id: "g1", source: "google", start_date: "2026-07-15" }),
        reminder: { status: "ready", choice: "prev_day_20" },
      })
      expect(screen.getByText("7月14日 20:00 に通知します")).toBeInTheDocument()
    })
  })

  it("通知時刻が既に過ぎていれば「通知します」と言わず、届かぬことを示す", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-07-14T15:00:00Z")) // = 7/15 00:00 JST
    try {
      renderSheet({
        editing: ev({ id: "g1", source: "google", start_date: "2026-07-15" }),
        reminder: { status: "ready", choice: "m30" },
      })
      expect(
        screen.getByText("7月14日 23:30 はすでに過ぎているため、通知は届きません"),
      ).toBeInTheDocument()
      expect(screen.queryByText(/に通知します$/)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it("「なし」のときは予告を出さぬ", () => {
    renderSheet({ reminder: { status: "ready", choice: "none" } })
    expect(screen.queryByText(/に通知します/)).not.toBeInTheDocument()
  })

  it("保存中は操作させぬ(二重送信の防止)", () => {
    renderSheet({
      editing: ev({ id: "e1", source: "native" }),
      reminder: { status: "ready", choice: "m10" },
      saving: true,
    })
    expect(reminderTrigger()).toBeDisabled()
  })
})
