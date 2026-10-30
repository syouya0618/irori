/**
 * 予定フォームの端末下書き（2026-10-27 テーマ B / AC08）と、予定作成の冪等 id・結果不明の扱い
 * （A4 / AC28 の画面側）、Google 予定の閲覧専用の出口・メモの定型・直近の予定（D / AC18）。
 *
 * 再読込は「CalendarView を unmount → 同じ localStorage のまま render し直す」で模す
 * （jsdom の localStorage はテストの間で clear する）。
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

const monthFetch = vi.hoisted(() => ({
  queue: [] as Array<{ data: unknown[] | null; error: unknown }>,
  signals: [] as AbortSignal[],
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
                order: () => ({
                  abortSignal: (signal: AbortSignal) => {
                    monthFetch.signals.push(signal)
                    return Promise.resolve(monthFetch.queue.shift() ?? { data: null, error: { message: "unset" } })
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    }),
  }
})
vi.mock("@/app/(main)/calendar/actions", () => ({
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEventSeries: vi.fn().mockResolvedValue({ error: null, count: 1 }),
  fetchGoogleSyncSignal: vi.fn().mockResolvedValue({ lastSyncedAt: null }),
  fetchEventReminder: vi.fn().mockResolvedValue({ error: null, row: null }),
  setEventReminder: vi.fn().mockResolvedValue({ error: null, count: 1 }),
}))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn(), warning: viMod.fn(), info: viMod.fn() } }
})

import { CalendarView } from "../calendar-view"
import { resetPendingCreatesPageStateForTest } from "../calendar-pending-creates"
import type { CalendarEventRecord } from "../use-month-events"
import { upcomingWithinLoaded } from "../calendar-upcoming-list"
import { appendMemoTemplate } from "../calendar-event-form-sheet"
import { createCalendarEvent, updateCalendarEvent } from "@/app/(main)/calendar/actions"
import { toast } from "sonner"
import { draftStorageKey } from "@/lib/domain/draft-storage"
import { listCalendarPendingCreates } from "@/lib/domain/calendar-pending-creates"
import { SAVE_RESEND_LABEL, SAVE_UNKNOWN_MESSAGE } from "@/lib/domain/save-attempt"
import { isClientId } from "@/lib/utils/client-id"

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
    updated_at: "2026-07-01T00:00:00.123456+00:00",
    ...o,
  }
}

const base = {
  householdId: "house-1",
  userId: "user-1",
  initialView: { monthFirst: "2026-07-01", selectedDate: "2026-07-15" },
}

const agenda = () => screen.getByRole("region", { name: /の予定$/ })
const openNew = () =>
  fireEvent.click(screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }))
const typeTitle = (title: string) =>
  fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: title } })
const titleValue = () => (screen.getByLabelText("タイトル") as HTMLInputElement).value
const lastCreateInput = () =>
  vi.mocked(createCalendarEvent).mock.calls.at(-1)![0] as { clientId?: string; title: string }
/** 「保存を確認中の予定」の件（v9: 作成ごとの控え） */
const pendingItem = (title: string) =>
  within(screen.getByRole("region", { name: "予定の追加の確認" }))
    .getByText(title)
    .closest("li") as HTMLElement
/** 端末に残った作成の控えの id（持ち主 user-1 / house-1） */
const pendingStored = () =>
  listCalendarPendingCreates({ userId: "user-1", householdId: "house-1" }).map((e) => e.clientId)

/** 「下書きを残して閉じる」で閉じる（入力途中の Esc は確認を出す） */
function closeKeepingDraft() {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
  fireEvent.click(screen.getByRole("button", { name: "下書きを残して閉じる" }))
}

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.mocked(createCalendarEvent).mockReset()
  vi.mocked(updateCalendarEvent).mockReset()
  monthFetch.queue = []
  monthFetch.signals = []
  localStorage.clear()
  // 試験の間の再読込: ページの寿命の状態（送信中・端末に書けなんだ予定の作成の控え）も空にする
  resetPendingCreatesPageStateForTest()
})

describe("予定の作成: 冪等 id と結果不明（AC28 の画面側）", () => {
  it("作成は UUID の clientId を送り、例外（結果不明）の後の「同じ内容でもう一度送る」は同じ id・同じ内容で送る", async () => {
    vi.mocked(createCalendarEvent)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ error: null, eventId: "srv-1", updatedAt: "v1", replayed: true })
    monthFetch.queue.push({ data: [], error: null })
    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        SAVE_UNKNOWN_MESSAGE,
        expect.objectContaining({ action: expect.objectContaining({ label: SAVE_RESEND_LABEL }) }),
      ),
    )
    const first = lastCreateInput()
    expect(isClientId(first.clientId)).toBe(true)
    // 「保存に失敗」とは言わぬ（届いて作られたかもしれぬ）
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringMatching(/失敗しました/), expect.anything())

    const opts = vi.mocked(toast.error).mock.calls[0][1] as unknown as { action: { onClick: () => void } }
    await act(async () => {})
    act(() => opts.action.onClick())
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    const second = lastCreateInput()
    expect(second.clientId).toBe(first.clientId)
    expect(second).toEqual(first)
    // replayed = 応答を失った前回の作成が成立しておった。追加したとは言わず、保存済みと二重でないことを言う（v9）
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("「検診」は保存されていました（二重には追加していません）"),
    )
    expect(localStorage.getItem(draftStorageKey({ userId: "user-1", householdId: "house-1" }, { kind: "calendar-event-new" }))).toBeNull()
    expect(pendingStored()).toEqual([])
  })

  it("作成の送信中に開いた新しいシートは、先の作成が結果不明になった後、黙って別の id で送らず確認を出す（独立レビュー v8rc2 CAL-INFLIGHT-SECOND-CREATE）", async () => {
    let rejectFirst: (e: unknown) => void = () => {}
    vi.mocked(createCalendarEvent)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ error: null, eventId: "srv-9", updatedAt: "v1" })
    monthFetch.queue.push({ data: [], error: null })
    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    const firstId = lastCreateInput().clientId

    // 先の作成が返る前に、もう一度追加を開いて同じ予定を打つ
    openNew()
    typeTitle("検診")
    // 先の作成が結果不明になる（応答を失った。作られたかもしれぬ）
    await act(async () => {
      rejectFirst(new TypeError("Failed to fetch"))
    })
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(SAVE_UNKNOWN_MESSAGE, expect.anything()))
    await waitFor(() => expect(screen.getByRole("button", { name: "追加" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "追加" }))

    // 送らずに、確かめられていない作成が在ることを示す
    const guard = await screen.findByRole("alert")
    expect(guard).toHaveTextContent("保存できたか確かめられていない予定の作成があります")
    expect(guard).toHaveTextContent("検診")
    expect(createCalendarEvent).toHaveBeenCalledTimes(1)

    // 明示に別の予定として追加すれば、新しい id で送る
    fireEvent.click(screen.getByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(lastCreateInput().clientId).not.toBe(firstId)
    expect(lastCreateInput().title).toBe("検診")
  })

  it("「別の予定として追加」の後も、先の結果不明の作成は端末に残り、再読込の後に同じ id で送り直せる（独立レビュー v8rc3 RC3-CAL-ACK-DROPS-HELD-UNKNOWN）", async () => {
    let rejectFirst: (e: unknown) => void = () => {}
    vi.mocked(createCalendarEvent)
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject }))
      .mockResolvedValueOnce({ error: null, eventId: "srv-y", updatedAt: "v1" })
    monthFetch.queue.push({ data: [], error: null })
    const view = render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    const firstId = lastCreateInput().clientId
    openNew()
    typeTitle("面談")
    await act(async () => {
      rejectFirst(new TypeError("Failed to fetch"))
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "追加" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    fireEvent.click(await screen.findByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    expect(lastCreateInput().title).toBe("面談")

    // 再読込（先の結果不明の作成の控えは端末に残っておる。v9: 「保存を確認中の予定」から件ごとに送り直す）
    view.unmount()
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({ error: null, eventId: "srv-x", updatedAt: "v1", replayed: true })
    render(<CalendarView {...base} initialEvents={[]} />)
    // 「追加」は控えの入力で始めぬ（凍結した送信内容を書き換えて同じ id で送る道を作らぬ）
    openNew()
    expect(titleValue()).toBe("")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    expect(pendingItem("検診")).toHaveTextContent(/保存できたか確認できていません/)
    fireEvent.click(within(pendingItem("検診")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(3))
    expect(lastCreateInput().clientId).toBe(firstId)
    expect(lastCreateInput().title).toBe("検診")
  })

  it("結果不明のまま再読込しても、控えの同じ clientId・同じ内容で送り直せる", async () => {
    vi.mocked(createCalendarEvent).mockRejectedValueOnce(new TypeError("Failed to fetch"))
    monthFetch.queue.push({ data: [], error: null })
    const view = render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("予防接種")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const first = lastCreateInput()

    // 再読込
    view.unmount()
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({ error: null, eventId: "srv-2", updatedAt: "v1" })
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(within(pendingItem("予防接種")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(lastCreateInput()).toEqual(first)
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    expect(pendingStored()).toEqual([])
  })

  it("conflict（同じ id の予定が在るが内容か回の並びが今は違う）は作成済みとして控えを畳み、一覧の確認を促す。次の作成は新しい id", async () => {
    vi.mocked(createCalendarEvent)
      .mockResolvedValueOnce({
        error: "この予定は少し前に別の内容で作成済みです。予定の一覧で確かめてください。",
        failure: "conflict",
      })
      .mockResolvedValueOnce({ error: null, eventId: "srv-3", updatedAt: "v1" })
    monthFetch.queue.push({ data: [], error: null })
    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("面談")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringMatching(/「面談」は作成済みでした。.*別の内容で作成済み/),
        expect.anything(),
      ),
    )
    const firstId = lastCreateInput().clientId
    expect(toast.success).not.toHaveBeenCalled()
    // 行は在ると分かった（二重にも成功にもせぬ）。控えは残さぬ
    expect(pendingStored()).toEqual([])
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()

    openNew()
    expect(titleValue()).toBe("")
    typeTitle("面談（別）")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(lastCreateInput().clientId).not.toBe(firstId)
  })

  it("成功した単発の作成は、楽観行をサーバの eventId で確定する（もう一度開くと確定 id で更新する）", async () => {
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({
      error: null,
      eventId: "srv-9",
      updatedAt: "2026-07-01T00:00:00.999999+00:00",
    })
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({ error: null, updatedAt: "v3" })
    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("健診")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を追加しました"))
    fireEvent.click(within(agenda()).getByText("健診"))
    typeTitle("健診（午後）")
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(updateCalendarEvent).toHaveBeenCalled())
    expect(vi.mocked(updateCalendarEvent).mock.calls[0][0]).toMatchObject({
      id: "srv-9",
      expectedUpdatedAt: "2026-07-01T00:00:00.999999+00:00",
    })
  })
})

describe("予定フォームの端末下書き（AC08）", () => {
  it("編集中に閉じて再読込しても、同じ予定・同じ版なら入力を戻す。別の予定には入れ違えぬ", async () => {
    const events = [
      ev({ id: "e1", title: "検診" }),
      ev({ id: "e2", title: "保育園見学" }),
    ]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（持ち物あり）")
    closeKeepingDraft()

    view.unmount()
    render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("保育園見学"))
    expect(titleValue()).toBe("保育園見学")
    expect(screen.queryByText(/入力を復元しました/)).not.toBeInTheDocument()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })

    fireEvent.click(within(agenda()).getByText("検診"))
    expect(titleValue()).toBe("検診（持ち物あり）")
    expect(screen.getByText("保存していない入力を復元しました。")).toBeInTheDocument()
  })

  it("別の利用者の端末では、前の利用者の下書きを戻さぬ", () => {
    const events = [ev({ id: "e1", title: "検診" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("前の利用者の入力")
    closeKeepingDraft()
    view.unmount()

    render(<CalendarView {...base} userId="user-2" initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    expect(titleValue()).toBe("検診")
  })

  it("「破棄して閉じる」はその予定の下書きだけを消す", () => {
    const events = [ev({ id: "e1", title: "検診" }), ev({ id: "e2", title: "見学" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("見学"))
    typeTitle("見学（10時）")
    closeKeepingDraft()
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（直し）")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }))
    view.unmount()

    render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    expect(titleValue()).toBe("検診")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(within(agenda()).getByText("見学"))
    expect(titleValue()).toBe("見学（10時）")
  })

  it("更新が例外（結果不明）でも、取り直した予定が入力と同じ中身なら保存済みとして扱い「家族が先に更新」と言わぬ", async () => {
    const V1 = "2026-07-01T00:00:00.100000+00:00"
    const V2 = "2026-07-01T00:00:05.200000+00:00"
    vi.mocked(updateCalendarEvent).mockRejectedValueOnce(new TypeError("Failed to fetch"))
    // 結果不明の後の取り直し: 自分の更新は成立しておった（版 V2・中身は入力と同じ）
    monthFetch.queue.push({ data: [ev({ id: "e1", title: "検診（午後）", updated_at: V2 })], error: null })
    render(<CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診", updated_at: V1 })]} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（午後）")
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(SAVE_UNKNOWN_MESSAGE, expect.anything()),
    )
    await waitFor(() => expect(within(agenda()).getByText("検診（午後）")).toBeInTheDocument())

    fireEvent.click(within(agenda()).getByText("検診（午後）"))
    expect(titleValue()).toBe("検診（午後）")
    expect(screen.queryByText(/別の端末で更新されています/)).not.toBeInTheDocument()
    expect(screen.queryByText(/入力を復元しました/)).not.toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith("前回の変更は保存されていました")
  })

  it("下書きの後に別の端末で中身が変わっていたら、フォームは最新の内容で始め、下書きは読むだけ", () => {
    const events = [ev({ id: "e1", title: "検診", updated_at: "v1" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（自分の入力）")
    closeKeepingDraft()
    view.unmount()

    render(<CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診（家族）", updated_at: "v2" })]} />)
    fireEvent.click(within(agenda()).getByText("検診（家族）"))
    expect(titleValue()).toBe("検診（家族）")
    const stale = screen.getByText("この予定は別の端末で更新されています。下は最新の内容です。")
      .closest("[role=status]") as HTMLElement
    expect(within(stale).getByText("検診（自分の入力）")).toBeInTheDocument()
    // 誰が直したかは断定せぬ
    expect(stale.textContent).not.toMatch(/家族が|妻|夫/)
    fireEvent.click(within(stale).getByRole("button", { name: "残っていた入力を破棄" }))
    expect(screen.queryByText(/別の端末で更新されています/)).not.toBeInTheDocument()
  })

  it("古い版の下書きを読むだけで見せておる間に打ち直しても、その下書きを上書きせぬ（破棄を選ぶまで残す。v7）", () => {
    const events = [ev({ id: "e1", title: "検診", memo: "長いメモ", updated_at: "v1" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（自分の入力）")
    closeKeepingDraft()
    view.unmount()

    const latest = [ev({ id: "e1", title: "検診（家族）", updated_at: "v2" })]
    const second = render(<CalendarView {...base} initialEvents={latest} />)
    fireEvent.click(within(agenda()).getByText("検診（家族）"))
    // 打ち直しの途中で画面を閉じた（閉じる時の書き出しが走る）
    typeTitle("検診（打ち直し途中）")
    second.unmount()

    render(<CalendarView {...base} initialEvents={latest} />)
    fireEvent.click(within(agenda()).getByText("検診（家族）"))
    const stale = screen.getByText("この予定は別の端末で更新されています。下は最新の内容です。")
      .closest("[role=status]") as HTMLElement
    expect(within(stale).getByText("検診（自分の入力）")).toBeInTheDocument()
    expect(stale.textContent).toContain("ここで打った内容はこの端末に残りません")
  })

  it("送信の途中で画面が落ちたら、再読込の後は「保存していない」と言わず「確認できていない」で戻す（v7）", async () => {
    // 返らぬ送信（画面が落ちる前に応答が来ぬ）。試験の終わりで必ず解決させる — 残すと React 19 の async
    // transition が後の試験のシートの pending まで立てたままにする（v8 で後ろに足した試験で露見）
    let settleHanging: () => void = () => {}
    vi.mocked(updateCalendarEvent).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settleHanging = () => resolve({ error: "届かなかった", conflict: undefined } as never)
        }),
    )
    const events = [ev({ id: "e1", title: "検診", updated_at: "v1" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（午後）")
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(updateCalendarEvent).toHaveBeenCalledTimes(1))
    view.unmount()

    // 届かなかった（版は v1 のまま）
    render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    expect(titleValue()).toBe("検診（午後）")
    expect(screen.getByText(/保存できたか確認できていない入力を復元しました/)).toBeInTheDocument()
    expect(screen.queryByText("保存していない入力を復元しました。")).not.toBeInTheDocument()
    await act(async () => {
      settleHanging()
    })
  })

  it("保存の往復中に開き直して打った入力は、先の保存の成功で消さぬ（v7）", async () => {
    type UpdateResult = Awaited<ReturnType<typeof updateCalendarEvent>>
    let resolveUpdate: (v: UpdateResult) => void = () => {}
    vi.mocked(updateCalendarEvent).mockImplementationOnce(
      () => new Promise<UpdateResult>((resolve) => (resolveUpdate = resolve)),
    )
    const events = [ev({ id: "e1", title: "検診", updated_at: "v1" })]
    const view = render(<CalendarView {...base} initialEvents={events} />)
    fireEvent.click(within(agenda()).getByText("検診"))
    typeTitle("検診（午後）")
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(updateCalendarEvent).toHaveBeenCalledTimes(1))

    // 往復中に開き直して続きを打ち、間引きの書き出しまで待つ
    fireEvent.click(within(agenda()).getByText("検診（午後）"))
    typeTitle("検診（午後・持ち物）")
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    await act(async () => {
      resolveUpdate({ error: null, updatedAt: "v2" })
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("予定を更新しました"))
    view.unmount()

    render(<CalendarView {...base} initialEvents={[ev({ id: "e1", title: "検診（午後）", updated_at: "v2" })]} />)
    fireEvent.click(within(agenda()).getByText("検診（午後）"))
    // 打った続きは消えておらぬ（版が進んだゆえ読むだけで見せる）
    const stale = screen.getByText("この予定は別の端末で更新されています。下は最新の内容です。")
      .closest("[role=status]") as HTMLElement
    expect(within(stale).getByText("検診（午後・持ち物）")).toBeInTheDocument()
  })

  it("保持期限の注記を出す（端末下書きはバックアップではない）", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    expect(screen.getByText(/この端末のこのブラウザにだけ7日間残ります/)).toBeInTheDocument()
  })
})

describe("予定の読み込み: 期限とキャンセル", () => {
  it("月送りは前の取得を abort し、取得には AbortSignal を渡す", async () => {
    const pending = new Promise<{ data: unknown[] | null; error: unknown }>(() => {})
    monthFetch.queue.push(pending as unknown as { data: null; error: unknown })
    monthFetch.queue.push({ data: [], error: null })
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(monthFetch.signals).toHaveLength(1)
    expect(monthFetch.signals[0].aborted).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(monthFetch.signals).toHaveLength(2)
    expect(monthFetch.signals[0].aborted).toBe(true)
    await waitFor(() => expect(within(agenda()).getByText("予定はありません")).toBeInTheDocument())
  })
})

describe("Google の予定・メモの定型・直近の予定（AC18）", () => {
  it("Google の予定は閲覧のみで、理由と Google カレンダー・設定への出口を出す（編集の導線は出さぬ）", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "g1", title: "歯医者", source: "google" })]}
      />,
    )
    fireEvent.click(within(agenda()).getByText("歯医者"))
    expect(screen.getByText(/内容は変えられません/)).toBeInTheDocument()
    const gcal = screen.getByRole("link", { name: "Google カレンダーを開く" })
    expect(gcal).toHaveAttribute("href", "https://calendar.google.com/")
    expect(gcal).toHaveAttribute("rel", expect.stringContaining("noopener"))
    expect(screen.getByRole("link", { name: "設定で連携を確かめる" })).toHaveAttribute("href", "/settings")
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument()
    expect(screen.queryByLabelText("タイトル")).not.toBeInTheDocument()
  })

  it("メモの定型は既存の文を消さずに末尾の行へ足し、「担当」が引き受けの印でないと添える", () => {
    expect(appendMemoTemplate(null, "担当: ")).toBe("担当: ")
    expect(appendMemoTemplate("母子手帳", "持ち物: ")).toBe("母子手帳\n持ち物: ")
    expect(appendMemoTemplate("母子手帳\n", "持ち物: ")).toBe("母子手帳\n持ち物: ")

    render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    fireEvent.change(screen.getByLabelText("メモ（任意）"), { target: { value: "受付 9:30" } })
    fireEvent.click(screen.getByRole("button", { name: "担当を書く" }))
    expect((screen.getByLabelText("メモ（任意）") as HTMLTextAreaElement).value).toBe("受付 9:30\n担当: ")
    expect(screen.getByText("「担当」は書いた人のメモです。相手が引き受けたことは表しません。")).toBeInTheDocument()
  })

  it("直近の予定は読み込んでいる範囲から今日以降を開始順に並べ、範囲を文字で示す", () => {
    const today = "2026-07-15"
    const { items, more } = upcomingWithinLoaded(
      [
        ev({ id: "past", start_date: "2026-07-01" }),
        ev({ id: "later", start_date: "2026-07-20" }),
        ev({ id: "ongoing", start_date: "2026-07-14", end_date: "2026-07-16" }),
        ev({ id: "timed", start_date: "2026-07-15", is_all_day: false, start_at: "2026-07-15T01:00:00Z" }),
        ev({ id: "allday", start_date: "2026-07-15" }),
      ],
      today,
      3,
    )
    expect(items.map((e) => e.id)).toEqual(["ongoing", "allday", "timed"])
    expect(more).toBe(1)

    render(<CalendarView {...base} initialEvents={[ev({ id: "e1", title: "健診", start_date: "2099-07-20" })]} />)
    const toggle = screen.getByRole("button", { name: /直近の予定/ })
    // e2e（calendar.spec の並び順）が agenda を名前つき region で絞る前提: 「直近の予定」は名前を
    // 持つ region にならず、その見出しの釦は agenda の外にある
    expect(screen.getAllByRole("region", { name: /の予定$/ })).toHaveLength(1)
    expect(within(agenda()).queryByRole("button", { name: /直近の予定/ })).toBeNull()
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(toggle.textContent).toMatch(/読み込んでいる範囲（.+〜.+）の今日以降/)
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
  })
})

describe("作成ごとの控え: 無関係な作成・破棄・成功・拒否は、他の作成の控えを消さぬ（v8rc4 確認の P-A/P-C/P-D/P-E/P-F を v9 の不変条件へ）", () => {
  const callInput = (i: number) =>
    vi.mocked(createCalendarEvent).mock.calls[i][0] as { clientId: string; title: string }
  const wait = (ms: number) =>
    act(async () => {
      await new Promise((r) => setTimeout(r, ms))
    })

  /** X を送信中 → 新しいシート → X が結果不明 → 「別の予定として追加」→ Y の結果は second で決める */
  async function ackFlow(second: () => void) {
    let rejectFirst: (e: unknown) => void = () => {}
    vi.mocked(createCalendarEvent).mockImplementationOnce(
      () => new Promise((_, reject) => { rejectFirst = reject }),
    )
    second()
    monthFetch.queue.push({ data: [], error: null }, { data: [], error: null }, { data: [], error: null })
    const view = render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診X")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    openNew()
    typeTitle("面談Y")
    await act(async () => {
      rejectFirst(new TypeError("Failed to fetch"))
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "追加" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    fireEvent.click(await screen.findByRole("button", { name: "別の予定として追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    return { view, xId: callInput(0).clientId, yId: callInput(1).clientId }
  }

  it("P-A: Y も結果不明 → 「追加」を開いて打っても、X と Y の控えは両方とも残る（下書きの書き手は控えに触れぬ）", async () => {
    const { xId, yId } = await ackFlow(() =>
      vi.mocked(createCalendarEvent).mockRejectedValueOnce(new TypeError("Failed to fetch")),
    )
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length).toBeGreaterThanOrEqual(2))
    openNew()
    expect(titleValue()).toBe("")
    typeTitle("別の入力")
    await wait(600)
    expect(pendingStored().sort()).toEqual([xId, yId].sort())
    // 日の予定の region（e2e が `/の予定$/` で絞る）は 1 つのまま（控えの一覧の名前と取り違えぬ）
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "下書きを残して閉じる" }))
    expect(screen.getAllByRole("region", { name: /の予定$/ })).toHaveLength(1)
  })

  it("P-C: Y が 1 度きりの送信で拒否 → X は確認中のまま残り、次の「追加」は確認を出して黙って送らぬ。Y は「保存できなかった」で入力に戻れる", async () => {
    const { xId, yId } = await ackFlow(() =>
      vi.mocked(createCalendarEvent).mockResolvedValueOnce({ error: "保存できませんでした", failure: "rejected" } as never),
    )
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(pendingStored()).toContain(xId)
    expect(pendingItem("面談Y")).toHaveTextContent(/保存できませんでした/)
    expect(pendingItem("検診X")).toHaveTextContent(/保存できたか確認できていません/)
    openNew()
    typeTitle("面談Y")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    const guard = await screen.findByRole("alert")
    expect(guard).toHaveTextContent("検診X")
    // 保存できなかった Y（行は無い）は確認に数えぬ
    expect(guard).not.toHaveTextContent("面談Y")
    expect(createCalendarEvent).toHaveBeenCalledTimes(2)
    expect(callInput(1).clientId).toBe(yId)
  })

  it("P-D: 新しいシートを開いて「破棄」・「破棄して閉じる」をしても、X の控えは消えぬ", async () => {
    const { xId } = await ackFlow(() =>
      vi.mocked(createCalendarEvent).mockRejectedValueOnce(new TypeError("Failed to fetch")),
    )
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length).toBeGreaterThanOrEqual(2))
    openNew()
    typeTitle("捨てる入力")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }))
    expect(pendingStored()).toContain(xId)
  })

  it("P-F: 確認が出たシートを「破棄して閉じる」で閉じても、X は端末に残り、再読込の後に一覧から同じ id で送り直せる", async () => {
    let rejectFirst: (e: unknown) => void = () => {}
    vi.mocked(createCalendarEvent).mockImplementationOnce(
      () => new Promise((_, reject) => { rejectFirst = reject }),
    )
    monthFetch.queue.push({ data: [], error: null }, { data: [], error: null })
    const view = render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診X")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(1))
    const xId = callInput(0).clientId
    openNew()
    typeTitle("検診X")
    await act(async () => {
      rejectFirst(new TypeError("Failed to fetch"))
    })
    await waitFor(() => expect(screen.getByRole("button", { name: "追加" })).not.toBeDisabled())
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await screen.findByRole("alert")
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "破棄して閉じる" }))
    expect(pendingStored()).toEqual([xId])
    view.unmount()
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({ error: null, eventId: xId, updatedAt: "v1", replayed: true })
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalledTimes(2))
    expect(callInput(1).clientId).toBe(xId)
  })

  it("P-E: 結果不明の X の送り直しが conflict（作成済みで、その後に内容が変わった）なら、控えを畳み、再読込の後に「同じ内容で送れば二重にならぬ」と偽らぬ", async () => {
    vi.mocked(createCalendarEvent).mockRejectedValueOnce(new TypeError("Failed to fetch"))
    monthFetch.queue.push({ data: [], error: null }, { data: [], error: null }, { data: [], error: null })
    let view = render(<CalendarView {...base} initialEvents={[]} />)
    openNew()
    typeTitle("検診X")
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    const xId = callInput(0).clientId
    view.unmount()
    view = render(<CalendarView {...base} initialEvents={[]} />)
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({ error: "この予定は少し前に別の内容で作成済みです。", failure: "conflict" } as never)
    fireEvent.click(within(pendingItem("検診X")).getByRole("button", { name: SAVE_RESEND_LABEL }))
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(callInput(1).clientId).toBe(xId)
    // 送信内容は凍結（直した内容を同じ id で送らぬ）
    expect(callInput(1)).toEqual(callInput(0))
    view.unmount()
    expect(pendingStored()).toEqual([])
    render(<CalendarView {...base} initialEvents={[]} />)
    expect(screen.queryByText(/同じ内容で送れば二重になりません/)).toBeNull()
    expect(screen.queryByRole("region", { name: "予定の追加の確認" })).toBeNull()
  })
})

vi.mock("next/navigation",()=>({useRouter:()=>({push:vi.fn()})}))
