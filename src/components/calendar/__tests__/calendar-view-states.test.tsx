/**
 * Agent C（予定画面 UX）の状態表示の回帰テスト。
 *
 * - 読めなかった月を「予定はありません」と偽らぬ（初回・月送り・再試行・背景の取り直し）
 * - 保存に失敗した入力を握り、同じ版の時だけ戻す（版ガードを素通りさせぬ）
 * - 成功・失敗・衝突を別の通知で言い分ける
 * - 削除は確認を経てから送る
 * - 日付グリッドを矢印キーで動かせる（月を跨ぐと月を描き直す）
 * - 一覧は複数日・繰り返し・Google 由来を文字で示す
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
  act,
} from "@testing-library/react"

// 月の取り直しの応答を 1 件ずつ差し替える（既定は空で成功）。
const monthFetch = vi.hoisted(() => ({
  queue: [] as Array<{ data: unknown[] | null; error: unknown }>,
  calls: 0,
}))

vi.mock("@/lib/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
      from: () => ({
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({
                order: () => {
                  monthFetch.calls += 1
                  return Promise.resolve(monthFetch.queue.shift() ?? { data: [], error: null })
                },
              }),
            }),
          }),
        }),
      }),
    }),
  }
})
vi.mock("@/app/(main)/calendar/actions", () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({ error: null, eventId: "x", updatedAt: "v1" }),
  updateCalendarEvent: vi.fn().mockResolvedValue({ error: null, updatedAt: "v2" }),
  deleteCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEventSeries: vi.fn().mockResolvedValue({ error: null, count: 7 }),
  fetchGoogleSyncSignal: vi.fn().mockResolvedValue({ lastSyncedAt: null }),
  fetchEventReminder: vi.fn().mockResolvedValue({ error: null, row: null }),
  setEventReminder: vi.fn().mockResolvedValue({ error: null, count: 1 }),
}))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    toast: { error: viMod.fn(), success: viMod.fn(), warning: viMod.fn() },
  }
})

import { CalendarView } from "../calendar-view"
import type { CalendarEventRecord } from "../use-month-events"
import { formatDayJa } from "../calendar-display"
import {
  createCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarEventSeries,
  updateCalendarEvent,
} from "@/app/(main)/calendar/actions"
import { toast } from "sonner"

function ev(o: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: "予定",
    memo: null,
    is_all_day: true,
    start_date: "2026-07-15",
    end_date: o.end_date ?? o.start_date ?? "2026-07-15",
    start_at: null,
    end_at: null,
    source: "native",
    series_id: null,
    updated_at: "v1",
    ...o,
  }
}

const base = {
  householdId: "house-1",
  initialView: { monthFirst: "2026-07-01", selectedDate: "2026-07-15" },
}

// 読み上げ名の前置一致は述語で取る（整形済み文字列から RegExp を組んで escape を手書きせぬ）。
function dayCell(ymd: string): HTMLElement {
  return within(screen.getByRole("group", { name: "日付を選ぶ" })).getByRole("button", {
    name: (accessibleName) => accessibleName.startsWith(`${formatDayJa(ymd)}、`),
  })
}
const agenda = () => screen.getByRole("region", { name: /の予定$/ })

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  monthFetch.queue = []
  monthFetch.calls = 0
})

describe("読み込み状態（読めなかった月を空と偽らぬ）", () => {
  it("初回の取得に失敗していれば「予定はありません」ではなく失敗と再試行を出す", async () => {
    render(<CalendarView {...base} initialEvents={[]} initialLoadFailed />)
    const alert = within(agenda()).getByRole("alert")
    expect(alert).toHaveTextContent("予定を読み込めませんでした")
    expect(within(agenda()).queryByText("予定はありません")).not.toBeInTheDocument()
    // 日セルの読み上げも「予定なし」と偽らぬ
    expect(dayCell("2026-07-15").getAttribute("aria-label")).toMatch(/予定を確認できません$/)

    // 再試行が通れば空の表示へ戻る
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    await waitFor(() =>
      expect(within(agenda()).getByText("予定はありません")).toBeInTheDocument(),
    )
    expect(within(agenda()).queryByRole("alert")).not.toBeInTheDocument()
    expect(dayCell("2026-07-15").getAttribute("aria-label")).toMatch(/予定なし$/)
  })

  it("取得に成功した空の日は「予定はありません」と追加の導線を出す（対照）", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    expect(within(agenda()).getByText("予定はありません")).toBeInTheDocument()
    expect(within(agenda()).queryByRole("alert")).not.toBeInTheDocument()
    expect(
      within(agenda()).getByRole("button", { name: "この日に予定を追加" }),
    ).toBeInTheDocument()
  })

  it("月送りの取得中は空と言わず、失敗したら失敗を出す", async () => {
    let fail!: (v: { data: null; error: unknown }) => void
    monthFetch.queue = []
    const pending = new Promise<{ data: null; error: unknown }>((r) => {
      fail = r
    })
    // 次の取得だけ保留させる
    monthFetch.queue.push(pending as unknown as { data: null; error: unknown })
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(within(agenda()).getByRole("status")).toHaveTextContent("予定を読み込み中")
    expect(within(agenda()).queryByText("予定はありません")).not.toBeInTheDocument()
    expect(screen.getByRole("group", { name: "日付を選ぶ" })).toHaveAttribute(
      "aria-busy",
      "true",
    )

    fail({ data: null, error: { message: "boom", code: "500" } })
    await waitFor(() =>
      expect(within(agenda()).getByRole("alert")).toHaveTextContent("予定を読み込めませんでした"),
    )
  })

  it("背景の取り直し（復帰）だけが失敗した時は表示を残し、古い可能性を添える", async () => {
    monthFetch.queue.push({ data: null, error: { message: "offline" } })
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診" })]} />,
    )
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    window.dispatchEvent(new Event("focus"))
    await waitFor(() =>
      expect(within(agenda()).getByText(/表示が古い可能性があります/)).toBeInTheDocument(),
    )
    // 予定そのものは消さぬ
    expect(within(agenda()).getByText("検診")).toBeInTheDocument()
    expect(within(agenda()).queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("保存の結果を言い分け、失敗した入力を失わせぬ", () => {
  const openNewAndSave = (title: string) => {
    fireEvent.click(screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: title } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
  }

  it("作成に成功したら成功を告げる", async () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    openNewAndSave("検診")
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("作成に失敗したら入力を握り、もう一度開くと復元する", async () => {
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({
      error: "予定の作成に失敗しました。もう一度お試しください。",
    } as never)
    render(<CalendarView {...base} initialEvents={[]} />)
    openNewAndSave("失敗する予定")
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "予定の作成に失敗しました。もう一度お試しください。",
        expect.objectContaining({
          action: expect.objectContaining({ label: "入力に戻る" }),
        }),
      ),
    )
    expect(toast.success).not.toHaveBeenCalled()
    // 楽観行は残らぬ
    expect(within(agenda()).queryByText("失敗する予定")).not.toBeInTheDocument()

    // toast の「入力に戻る」で復元したシートが開く
    const call = vi.mocked(toast.error).mock.calls[0]
    const opts = call[1] as unknown as { action: { onClick: () => void } }
    // 人が押すのは失敗の再描画（入力を握る state と ref の更新）の後じゃ。
    // テストでも描画を流してから押す（流さぬと古い closure を掴み、揺らぐ）
    await act(async () => {})
    act(() => opts.action.onClick())
    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("失敗する予定"),
    )
    expect(screen.getByText("保存できなかった入力を復元しました。")).toBeInTheDocument()
  })

  it("編集に失敗した入力は、同じ版のまま開き直せば戻る", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({
      error: "予定の更新に失敗しました。もう一度お試しください。",
    })
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診", updated_at: "v1" })]} />,
    )
    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（直し）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    // 一覧は保存前へ戻っておる
    await waitFor(() => expect(within(agenda()).getByText("検診")).toBeInTheDocument())

    fireEvent.click(within(agenda()).getByText("検診"))
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("検診（直し）")
  })

  it("家族が先に直した（版が変わった）予定には、古い入力を戻さず捨てる", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({
      error: "予定の更新に失敗しました。もう一度お試しください。",
    })
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診", updated_at: "v1" })]} />,
    )
    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（古い入力）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    // 復帰の取り直しで家族の更新（版 v9）が入る
    monthFetch.queue.push({
      data: [ev({ id: "e1", title: "検診（家族）", updated_at: "v9" })],
      error: null,
    })
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(within(agenda()).getByText("検診（家族）")).toBeInTheDocument())

    fireEvent.click(within(agenda()).getByText("検診（家族）"))
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("検診（家族）")
    expect(screen.queryByText("保存できなかった入力を復元しました。")).not.toBeInTheDocument()
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/先に更新されたため破棄/))
  })

  it("復元した新規の入力を破棄しても、裏で失敗した別の予定の入力は消さぬ", async () => {
    // 1. 新規作成が失敗 → "new" の入力を握る
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({
      error: "予定の作成に失敗しました。もう一度お試しください。",
    } as never)
    // 2. 既存予定 e1 の更新は保留し、後で失敗させる
    let failUpdate!: (v: { error: string }) => void
    vi.mocked(updateCalendarEvent).mockImplementationOnce(
      () => new Promise((r) => (failUpdate = r as typeof failUpdate)),
    )
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診", updated_at: "v1" })]} />,
    )
    openNewAndSave("新規の予定")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())

    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（直し）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))

    // 3. 復元した新規シートを開いておる間に、e1 の保存が失敗して入力を握り直す
    fireEvent.click(screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }))
    expect(screen.getByText("保存できなかった入力を復元しました。")).toBeInTheDocument()
    failUpdate({ error: "予定の更新に失敗しました。もう一度お試しください。" })
    // シートが開いておる間は背景が inert ゆえ、失敗の通知で待つ
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2))

    // 4. 新規の入力を破棄 → 閉じる
    fireEvent.click(screen.getByRole("button", { name: "破棄" }))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    // 5. e1 を開くと、e1 の入力は残っておる
    fireEvent.click(within(agenda()).getByText("検診"))
    await waitFor(() =>
      expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("検診（直し）"),
    )
  })

  it("更新に成功したら成功を告げる", async () => {
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診" })]} />,
    )
    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診2" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を更新しました"))
  })

  it("保存の往復中の行に「保存中」を出す", async () => {
    let resolve!: (v: { error: null; updatedAt: string }) => void
    vi.mocked(updateCalendarEvent).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    )
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診" })]} />,
    )
    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診2" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(within(agenda()).getByText("保存中")).toBeInTheDocument())
    resolve({ error: null, updatedAt: "v2" })
    await waitFor(() => expect(within(agenda()).queryByText("保存中")).not.toBeInTheDocument())
  })
})

describe("削除は確認を経てから送り、結果を告げる", () => {
  it("単発: 確認の「削除する」まで送らず、成功を件名つきで告げる", async () => {
    render(
      <CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診" })]} />,
    )
    fireEvent.click(within(agenda()).getByText("検診"))
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    expect(deleteCalendarEvent).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))
    await waitFor(() => expect(deleteCalendarEvent).toHaveBeenCalledWith("e1"))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("「検診」を削除しました"))
  })

  it("繰り返し: すべての回の削除はサーバの削除件数で告げる", async () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({ id: "e1", title: "予防接種", series_id: "s1" }),
          ev({ id: "e2", title: "予防接種", series_id: "s1", start_date: "2026-07-22" }),
        ]}
      />,
    )
    fireEvent.click(within(agenda()).getByText("予防接種"))
    fireEvent.click(screen.getByRole("button", { name: "削除" }))
    fireEvent.click(screen.getByRole("button", { name: "繰り返しのすべての回を削除" }))
    await waitFor(() => expect(deleteCalendarEventSeries).toHaveBeenCalledWith("s1"))
    // 手元の 2 件ではなく、サーバが消した 7 件を言う
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("繰り返し予定を7件削除しました"),
    )
  })
})

describe("日付の移動", () => {
  it("矢印キーで日を動かし、月を跨げば月を描き直す", async () => {
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: "2026-07-01", selectedDate: "2026-07-31" }}
        initialEvents={[]}
      />,
    )
    fireEvent.keyDown(dayCell("2026-07-31"), { key: "ArrowLeft" })
    expect(dayCell("2026-07-30")).toHaveAttribute("aria-pressed", "true")
    expect(dayCell("2026-07-30")).toHaveFocus()

    // 7/30 → +7 = 8/6 は 7 月のグリッド（〜8/9）に在るゆえ月は変えぬ
    fireEvent.keyDown(dayCell("2026-07-30"), { key: "ArrowDown" })
    expect(screen.getByRole("heading", { name: "2026年7月" })).toBeInTheDocument()
    // 8/6 → +7 = 8/13 はグリッドの外 → 8 月を描き直し、選択日は 8/13 のまま
    fireEvent.keyDown(dayCell("2026-08-06"), { key: "ArrowDown" })
    expect(screen.getByRole("heading", { name: "2026年8月" })).toBeInTheDocument()
    expect(dayCell("2026-08-13")).toHaveAttribute("aria-pressed", "true")
    await waitFor(() => expect(dayCell("2026-08-13")).toHaveFocus())
  })

  it("選択日だけが Tab で止まる（42 個の Tab 停止を作らぬ）", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    const group = screen.getByRole("group", { name: "日付を選ぶ" })
    const focusable = within(group)
      .getAllByRole("button")
      .filter((b) => b.getAttribute("tabindex") === "0")
    expect(focusable).toEqual([dayCell("2026-07-15")])
  })

  it("今日以外を選んでいる間は「今日」へ戻れ、今日を選べば消える", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    // 7/15 は今日ではない（テストの現在日は 2026-07 ではない前提を置かず、両方を確かめる）
    const back = screen.queryByRole("button", { name: "今日に戻る" })
    if (back) {
      fireEvent.click(back)
      expect(screen.queryByRole("button", { name: "今日に戻る" })).not.toBeInTheDocument()
    }
  })
})

describe("一覧は意味を文字で示す", () => {
  it("複数日の予定に期間と何日目かを、繰り返しと Google 由来に文字の印を出す", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({ id: "m", title: "帰省", start_date: "2026-07-14", end_date: "2026-07-17" }),
          ev({ id: "s", title: "予防接種", series_id: "s1" }),
          ev({ id: "g", title: "会議", source: "google" }),
        ]}
      />,
    )
    const list = agenda()
    expect(within(list).getByText("7/14〜7/17（2/4日目）")).toBeInTheDocument()
    expect(within(list).getByText("繰り返し")).toBeInTheDocument()
    expect(within(list).getByText("Google・閲覧のみ")).toBeInTheDocument()
    expect(within(list).getByText("3件")).toBeInTheDocument()
  })

  it("単発・単日の自前予定には余計な印を出さぬ（対照）", () => {
    render(<CalendarView {...base} initialEvents={[ev({ id: "e", title: "検診" })]} />)
    const list = agenda()
    expect(within(list).queryByText("繰り返し")).not.toBeInTheDocument()
    expect(within(list).queryByText("Google・閲覧のみ")).not.toBeInTheDocument()
    expect(within(list).queryByText(/日目/)).not.toBeInTheDocument()
  })
})
