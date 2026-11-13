/**
 * カレンダーでの「ごみの日」の表示と分類（家事機能 A: A-01 / A-02 / A-03 / A-04、V-A「同日の識別」）。
 *
 * - 同じ日に通常の予定とごみの予定が在る時、月のマス・選択日の一覧で区別できる（アイコン + 名称、
 *   読み上げにも種別が入る）。通常の予定の表示は変わらぬ
 * - 分類を読めなんだ時は予定を倒さず、「ごみの日ではない」とも描かぬ
 * - Google の予定も分類できる（出どころと用途は別の軸）
 * - 保存の結果が分からぬ時は、同じ内容で確かめ直せる（新しい操作を作らぬ）
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  purposes: [] as unknown[],
  purposeError: false,
}))

vi.mock("@/lib/supabase/client", () => {
  const channel = { on: () => channel, subscribe: () => channel }
  type Thenable = {
    abortSignal: () => Thenable
    then: (f?: ((v: unknown) => unknown) | null, r?: ((e: unknown) => unknown) | null) => Promise<unknown>
  }
  const thenable = (get: () => unknown): Thenable => {
    const t: Thenable = {
      abortSignal: () => t,
      then: (f, r) => Promise.resolve(get()).then(f, r),
    }
    return t
  }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
      from: (table: string) =>
        table === "event_purposes"
          ? {
              select: () => ({
                eq: () =>
                  thenable(() =>
                    db.purposeError
                      ? { data: null, error: { message: "synthetic", code: "" } }
                      : { data: db.purposes, error: null },
                  ),
              }),
            }
          : {
              select: () => ({
                eq: () => ({
                  lte: () => ({
                    gte: () => ({ order: () => thenable(() => ({ data: db.rows, error: null })) }),
                  }),
                }),
              }),
            },
    }),
  }
})
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("@/app/(main)/calendar/actions", () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({ error: null, eventId: "x" }),
  updateCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEventSeries: vi.fn().mockResolvedValue({ error: null }),
  fetchGoogleSyncSignal: vi.fn().mockResolvedValue({ lastSyncedAt: null }),
  fetchEventReminder: vi.fn().mockResolvedValue({ error: null, row: null }),
  setEventReminder: vi.fn().mockResolvedValue({ error: null, count: 1 }),
}))
vi.mock("@/app/(main)/chores/garbage/actions", () => ({
  submitGarbageRequest: vi.fn(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn(), warning: viMod.fn(), info: viMod.fn() } }
})
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { CalendarView } from "../calendar-view"
import { resetPendingCreatesPageStateForTest } from "../calendar-pending-creates"
import type { CalendarEventRecord } from "../use-month-events"
import { formatDayJa } from "../calendar-display"
import { fetchEventReminder, setEventReminder } from "@/app/(main)/calendar/actions"
import { submitGarbageRequest } from "@/app/(main)/chores/garbage/actions"
import { CHORE_PENDING_PREFIX } from "@/lib/domain/chore-pending"
import type { EventPurposeLoad, EventPurposeRow } from "@/lib/domain/garbage"

const submit = vi.mocked(submitGarbageRequest)

const USER = "a7000000-0000-4000-8000-000000000001"
const HOUSE = "a7000000-0000-4000-8000-0000000000aa"
const DAY = "2026-07-15"
const OTHER_DAY = "2026-07-16"
const GARBAGE_EVENT = "b7000000-0000-4000-8000-000000000001"
const NORMAL_EVENT = "b7000000-0000-4000-8000-000000000002"
const OTHER_EVENT = "b7000000-0000-4000-8000-000000000003"
const SERIES = "b7000000-0000-4000-8000-0000000000f0"
const GOOGLE_ROW = "b7000000-0000-4000-8000-000000000009"

function ev(o: Partial<CalendarEventRecord> & { id: string }): CalendarEventRecord {
  return {
    title: "予定",
    memo: null,
    is_all_day: true,
    start_date: DAY,
    end_date: o.start_date ?? DAY,
    start_at: null,
    end_at: null,
    source: "native",
    series_id: null,
    updated_at: "2026-07-01T00:00:00.000000+00:00",
    event_uid: o.source === "google" ? undefined : o.id,
    ...o,
  }
}

function purposeRow(o: Partial<EventPurposeRow> & { targetKey: string }): EventPurposeRow {
  return {
    id: "d7000000-0000-4000-8000-000000000001",
    scope: "event",
    purpose: "garbage",
    garbageKind: "燃えるごみ",
    remindDefault: null,
    reminderOptOut: false,
    updatedAt: "2026-07-01T00:00:00.000000+00:00",
    ...o,
  }
}
const ok = (...rows: EventPurposeRow[]): EventPurposeLoad => ({ status: "ok", rows })

const base = {
  householdId: HOUSE,
  userId: USER,
  initialView: { monthFirst: "2026-07-01", selectedDate: DAY },
}

function dayCell(ymd: string): HTMLElement {
  return within(screen.getByRole("group", { name: "日付を選ぶ" })).getByRole("button", {
    name: (name) => name.startsWith(`${formatDayJa(ymd)}、`),
  })
}
const agenda = () => screen.getByRole("region", { name: /の予定$/ })
const field = () => screen.getByTestId("garbage-purpose-field")
const choreKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(CHORE_PENDING_PREFIX))

async function openEvent(title: string) {
  await act(async () => {
    fireEvent.click(within(agenda()).getByText(title).closest("button")!)
  })
  await waitFor(() => expect(fetchEventReminder).toHaveBeenCalled())
}
/** 端末の控えを読み終える（保存を受けられる）まで待って、欄を開く。 */
async function openForm(buttonName: string) {
  fireEvent.click(within(field()).getByRole("button", { name: buttonName }))
  await waitFor(() =>
    expect(within(field()).getByRole("button", { name: /分類を保存|解除する|通常の予定に戻す/ })).toBeEnabled(),
  )
}

beforeEach(() => {
  cleanup()
  localStorage.clear()
  vi.clearAllMocks()
  resetPendingCreatesPageStateForTest()
  db.rows = []
  db.purposes = []
  db.purposeError = false
  submit.mockResolvedValue({ status: "saved" })
})

describe("同じ日に通常の予定とごみの予定が在る時の表示（A-01）", () => {
  const events = [
    ev({ id: NORMAL_EVENT, title: "歯医者", is_all_day: false, start_at: "2026-07-15T01:00:00.000Z" }),
    ev({ id: GARBAGE_EVENT, title: "収集の日" }),
    ev({ id: OTHER_EVENT, title: "保育園見学", start_date: OTHER_DAY }),
  ]
  const purposes = ok(purposeRow({ targetKey: GARBAGE_EVENT }))

  it("月のマス: ごみの帯と文字を出さずアイコンだけ、通常の予定の印と件数は維持する", () => {
    render(<CalendarView {...base} initialEvents={events} initialPurposes={purposes} />)
    const cell = dayCell(DAY)
    expect(cell).toHaveAccessibleName(`${formatDayJa(DAY)}、予定2件、ごみ（燃えるごみ）`)
    // 通常の予定の丸だけ。ごみの終日予定に付いていた帯は消す。
    expect(cell.querySelectorAll("[data-mark]")).toHaveLength(1)
    expect(cell.querySelector('[data-mark="band"]')).toBeNull()
    const mark = cell.querySelector("[data-garbage-mark]")
    expect(mark).not.toBeNull()
    expect(mark!.querySelectorAll("svg")).toHaveLength(1)
    expect(mark).toHaveTextContent("")
    expect(cell.textContent).not.toContain("燃える")
    // マスの中の印は読み上げから外し、種別はマスの名前が運ぶ
    expect(mark).toHaveAttribute("aria-hidden", "true")
  })

  it("ごみだけの日はラインも余白用の印もなく、アイコンだけが残る", () => {
    render(<CalendarView {...base} initialEvents={[events[1]]} initialPurposes={purposes} />)
    const cell = dayCell(DAY)
    expect(cell).toHaveAccessibleName(`${formatDayJa(DAY)}、予定1件、ごみ（燃えるごみ）`)
    expect(cell.querySelectorAll("[data-mark]")).toHaveLength(0)
    expect(cell.querySelector("[data-garbage-mark] svg")).not.toBeNull()
    expect(cell.textContent).not.toContain("燃える")
  })

  it("同日にごみが複数種類ならアイコンを並べ、ラインは付けない", () => {
    const second = ev({ id: NORMAL_EVENT, title: "資源の日" })
    const secondPurpose = purposeRow({
      id: "d7000000-0000-4000-8000-000000000099",
      targetKey: NORMAL_EVENT,
      garbageKind: "資源",
    })
    render(<CalendarView {...base} initialEvents={[events[1], second]}
      initialPurposes={ok(purposeRow({ targetKey: GARBAGE_EVENT }), secondPurpose)} />)
    const cell = dayCell(DAY)
    expect(cell.querySelectorAll("[data-mark]")).toHaveLength(0)
    expect(cell.querySelectorAll("[data-garbage-mark] svg")).toHaveLength(2)
    expect(cell).toHaveAccessibleName(/ごみ（燃えるごみ、資源）/)
  })

  it("ごみの無い日のマスは従来のまま（対照）", () => {
    render(<CalendarView {...base} initialEvents={events} initialPurposes={purposes} />)
    const cell = dayCell(OTHER_DAY)
    expect(cell.getAttribute("aria-label")).toMatch(/^\d+月\d+日（.）、予定1件$/)
    expect(cell.querySelector("[data-garbage-mark]")).toBeNull()
  })

  it("選択日の一覧: ごみの行にだけ「ごみ・名称」が出て、行の名前で区別できる", () => {
    render(<CalendarView {...base} initialEvents={events} initialPurposes={purposes} />)
    const garbageRow = within(agenda()).getByText("収集の日").closest("button")!
    const normalRow = within(agenda()).getByText("歯医者").closest("button")!
    expect(within(garbageRow).getByText("ごみ・燃えるごみ")).toBeInTheDocument()
    expect(garbageRow).toHaveAccessibleName(/収集の日.*ごみ・燃えるごみ/)
    expect(garbageRow.querySelector("[data-garbage-kind] svg")).not.toBeNull()
    // 通常の予定も読める・ごみとは言わぬ
    expect(normalRow).toHaveAccessibleName(/歯医者/)
    expect(normalRow.textContent).not.toContain("ごみ")
    // 凡例にも足す（ごみの日が在る時だけ）
    expect(screen.getByTestId("legend-garbage")).toHaveTextContent("ごみの日")
  })

  it("題が「燃えるごみ」でも、分類しておらねばごみの日として描かぬ（自動で確定せぬ）", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: GARBAGE_EVENT, title: "燃えるごみ" })]}
        initialPurposes={ok()}
      />,
    )
    expect(dayCell(DAY).getAttribute("aria-label")).toMatch(/、予定1件$/)
    expect(dayCell(DAY).querySelector("[data-garbage-mark]")).toBeNull()
    expect(screen.queryByTestId("legend-garbage")).toBeNull()
  })

  it("シリーズ既定は全ての回に出て、この回だけ通常へ戻した回には出ぬ（A-04）", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({ id: GARBAGE_EVENT, title: "収集", series_id: SERIES }),
          ev({ id: NORMAL_EVENT, title: "収集", series_id: SERIES, start_date: OTHER_DAY }),
        ]}
        initialPurposes={ok(
          purposeRow({ scope: "series", targetKey: SERIES, garbageKind: "資源", remindDefault: "prev_day_20" }),
          purposeRow({
            id: "d7000000-0000-4000-8000-000000000002",
            targetKey: NORMAL_EVENT,
            purpose: "normal",
            garbageKind: null,
          }),
        )}
      />,
    )
    expect(dayCell(DAY)).toHaveAccessibleName(/ごみ（資源）$/)
    expect(dayCell(OTHER_DAY).getAttribute("aria-label")).toMatch(/、予定1件$/)
  })
})

describe("分類を読めなんだ時（予定の表示を倒さぬ・未分類と偽らぬ）", () => {
  it("予定は描き、ごみの印は出さず、その旨を文で言う。欄は変更させぬ", async () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: GARBAGE_EVENT, title: "収集の日" })]}
        initialPurposes={{ status: "failed" }}
      />,
    )
    expect(within(agenda()).getByText("収集の日")).toBeInTheDocument()
    expect(dayCell(DAY).getAttribute("aria-label")).toMatch(/、予定1件$/)
    expect(screen.getByText(/ごみの日の分類を読み込めませんでした/)).toBeInTheDocument()
    await openEvent("収集の日")
    expect(within(field()).getByText(/分類を読み込めていません/)).toBeInTheDocument()
    expect(within(field()).queryByRole("button", { name: "ごみの日にする" })).toBeNull()
  })

  it("「読み直す」で分類を取り直せば、印が出る", async () => {
    db.rows = [ev({ id: GARBAGE_EVENT, title: "収集の日" })]
    db.purposes = [
      { id: "d7000000-0000-4000-8000-000000000001", scope: "event", target_key: GARBAGE_EVENT, purpose: "garbage", garbage_kind: "古紙", remind_default: null, reminder_opt_out: false, updated_at: null },
    ]
    render(<CalendarView {...base} initialEvents={db.rows as CalendarEventRecord[]} initialPurposes={{ status: "failed" }} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "読み直す" }))
    })
    await waitFor(() => expect(dayCell(DAY)).toHaveAccessibleName(/ごみ（古紙）$/))
    expect(screen.queryByText(/ごみの日の分類を読み込めませんでした/)).toBeNull()
  })
})

describe("公開後回帰: 既存のごみ予定の保存と読み戻し", () => {
  it("既存のGoogle予定を分類した後、古いクライアント取得が空でもサーバーで確認した用途を表示する", async () => {
    const google = ev({
      id: GOOGLE_ROW, title: "燃えるごみ", source: "google",
      event_uid: "cal@example.invalid|garbage-2026",
      google_calendar_id: "cal@example.invalid", recurring_event_id: null,
    })
    db.rows = [google]
    db.purposes = [] // clientの古い値。保存後にここが更新されなくても表示すべき
    render(<CalendarView {...base} initialEvents={[google]} initialPurposes={ok()} />)
    await openEvent("燃えるごみ")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "燃えるごみ" }))
    submit.mockResolvedValueOnce({
      status: "saved",
      purposeLoad: ok(purposeRow({ targetKey: "cal@example.invalid|garbage-2026" })),
    })
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(within(field()).getByText("ごみ・燃えるごみ")).toBeInTheDocument())
    expect(within(field()).queryByText("ごみの日ではありません。")).toBeNull()
  })

  it("保存後の分類読み戻しが失敗したら『ごみの日ではありません』に戻さず、読み直しを案内する", async () => {
    const original = ev({ id: GARBAGE_EVENT, title: "可燃ごみ" })
    db.rows = [original]
    render(<CalendarView {...base} initialEvents={[original]} initialPurposes={ok()} />)
    await openEvent("可燃ごみ")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "燃えるごみ" }))
    submit.mockResolvedValueOnce({ status: "saved", purposeLoad: { status: "failed" } })
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(within(field()).getByText(/分類を読み込めていません/)).toBeInTheDocument())
    expect(within(field()).queryByText("ごみの日ではありません。")).toBeNull()
  })
})

describe("予定のシートから分類する（A-02 / A-03）", () => {
  it("Google の予定（本体は閲覧のみ）も分類でき、保存の後に一覧へ映る", async () => {
    const google = ev({
      id: GOOGLE_ROW,
      title: "資源回収",
      source: "google",
      event_uid: "cal@example.invalid|g1",
      google_calendar_id: "cal@example.invalid",
      recurring_event_id: null,
    })
    db.rows = [google]
    render(<CalendarView {...base} initialEvents={[google]} initialPurposes={ok()} />)
    await openEvent("資源回収")
    // 本体は閲覧のみのまま
    expect(screen.getByText("予定の詳細")).toBeInTheDocument()
    expect(within(field()).getByText("ごみの日ではありません。")).toBeInTheDocument()

    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "資源" }))
    // 保存が通った後の取り直しが返す分類
    db.purposes = [
      { id: "d7000000-0000-4000-8000-000000000003", scope: "event", target_key: "cal@example.invalid|g1", purpose: "garbage", garbage_kind: "資源", remind_default: null, reminder_opt_out: false, updated_at: null },
    ]
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    // 送るのは行 id と選択だけ（世帯も鍵も送らぬ）。単発ゆえ範囲は「この予定だけ」
    expect(submit).toHaveBeenCalledWith({
      op: "save",
      eventId: GOOGLE_ROW,
      scope: "event",
      action: "garbage",
      garbageKind: "資源",
      reminder: "prev_day_20",
      // 画面が見ておった分類の行の版（未分類 = 行なし）
      seen: { series: null, event: null },
    })
    // シートが開いておる間、背後の月は読み上げから外れる（role では引けぬ）ゆえ属性で見る
    await waitFor(() =>
      expect(document.querySelector(`button[data-date="${DAY}"]`)?.getAttribute("aria-label")).toMatch(
        /、予定1件、ごみ（資源）$/,
      ),
    )
    // 欄も保存後の分類を言い、フォームは畳まれる
    await waitFor(() => expect(within(field()).getByText("ごみ・資源")).toBeInTheDocument())
    expect(within(field()).queryByTestId("garbage-purpose-form")).toBeNull()
    // 分類の保存は通知設定も書きうるゆえ、通知の欄を読み直す（開いた時 + 保存の後）
    expect(vi.mocked(fetchEventReminder).mock.calls.length).toBeGreaterThanOrEqual(2)
    // 確定した控えは端末に残さぬ
    expect(choreKeys()).toEqual([])
  })

  it("繰り返しの回: 範囲を選ぶまで保存できず、選んだ範囲で送る", async () => {
    const first = ev({ id: GARBAGE_EVENT, title: "収集", series_id: SERIES })
    db.rows = [first]
    render(<CalendarView {...base} initialEvents={[first]} initialPurposes={ok()} />)
    await openEvent("収集")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "プラスチック" }))
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    expect(within(field()).getByRole("alert")).toHaveTextContent("変更する範囲")
    expect(submit).not.toHaveBeenCalled()

    fireEvent.click(within(field()).getByRole("button", { name: "シリーズ全体" }))
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: GARBAGE_EVENT, scope: "series", garbageKind: "プラスチック" }),
    )
  })

  it("分類済みの予定を直す時は、画面が見ておった行の版を載せて送る（R38）", async () => {
    const SERIES_VERSION = "2026-07-10T01:02:03.654321+00:00"
    const EVENT_VERSION = "2026-07-11T04:05:06.000001+00:00"
    const first = ev({ id: GARBAGE_EVENT, title: "収集", series_id: SERIES })
    db.rows = [first]
    const rows = [
      purposeRow({ scope: "series", targetKey: SERIES, garbageKind: "資源", remindDefault: "prev_day_20", updatedAt: SERIES_VERSION }),
      // この回の通知の明示 OFF だけの行（用途なし）も「見ておった行」
      purposeRow({
        id: "d7000000-0000-4000-8000-000000000002",
        targetKey: GARBAGE_EVENT,
        purpose: null,
        garbageKind: null,
        reminderOptOut: true,
        updatedAt: EVENT_VERSION,
      }),
    ]
    render(<CalendarView {...base} initialEvents={[first]} initialPurposes={ok(...rows)} />)
    await openEvent("収集")
    expect(within(field()).getByText(/この回の通知は止めています/)).toBeInTheDocument()
    // 分類済みの予定のフォームには「分類を解除する」（操作の選択）も出るゆえ、保存の釦は完全一致で待つ
    fireEvent.click(within(field()).getByRole("button", { name: "分類を変更・解除" }))
    await waitFor(() => expect(within(field()).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    // 版は表記のまま（マイクロ秒を落とさぬ）
    expect(submit).toHaveBeenCalledWith({
      op: "save",
      eventId: GARBAGE_EVENT,
      scope: "series",
      action: "garbage",
      garbageKind: "古紙",
      reminder: "keep",
      seen: { series: SERIES_VERSION, event: EVENT_VERSION },
    })
  })

  it("保存が conflict（別の端末が先に変えた）なら、保存済みとは言わず、分類を読み直す（R38）", async () => {
    const event = ev({ id: GARBAGE_EVENT, title: "収集の日" })
    db.rows = [event]
    render(<CalendarView {...base} initialEvents={[event]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    // 家族が先に「資源」に分類しておった。RPC は何も書かず conflict を返し、取り直しが今の分類を返す
    submit.mockResolvedValueOnce({ status: "conflict" })
    db.purposes = [
      { id: "d7000000-0000-4000-8000-000000000003", scope: "event", target_key: GARBAGE_EVENT, purpose: "garbage", garbage_kind: "資源", remind_default: null, reminder_opt_out: false, updated_at: "2026-07-12T00:00:00.000001+00:00" },
    ]
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(within(field()).getByRole("alert")).toHaveTextContent("上書きはしていません"))
    // 画面は家族の分類（資源）を出す。自分が選んだ「古紙」が保存されたとは言わぬ
    await waitFor(() => expect(within(field()).getByText("ごみ・資源")).toBeInTheDocument())
    expect(within(field()).queryByText("ごみ・古紙")).toBeNull()
    expect(choreKeys()).toEqual([])
  })

  it("新規の予定のシートには欄を出さぬ（まだ行が無い）", async () => {
    render(<CalendarView {...base} initialEvents={[]} initialPurposes={ok()} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ }))
    })
    expect(screen.getByText("予定を追加")).toBeInTheDocument()
    expect(screen.queryByTestId("garbage-purpose-field")).toBeNull()
  })
})

describe("R35 分類の保存の応答は、その操作を送った欄（開くたびに別の編集セッション）だけを畳む", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }
  type Response = Awaited<ReturnType<typeof submitGarbageRequest>>
  const first = ev({ id: GARBAGE_EVENT, title: "収集の日" })
  const second = ev({ id: NORMAL_EVENT, title: "資源の日" })

  async function sendFromFirst(): Promise<{ resolve: (value: Response) => void }> {
    db.rows = [first, second]
    render(<CalendarView {...base} initialEvents={[first, second]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    const pending = deferred<Response>()
    submit.mockReturnValueOnce(pending.promise)
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    expect(submit).toHaveBeenCalledTimes(1)
    // 応答を待つ間に予定のシートを閉じる
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }))
    })
    await waitFor(() => expect(screen.queryByTestId("garbage-purpose-field")).toBeNull())
    return pending
  }

  it("危険側: 先の予定の応答は、送信中に開いた別の予定の欄を畳まず、選んだ内容を残す", async () => {
    const pending = await sendFromFirst()
    await openEvent("資源の日")
    fireEvent.click(within(field()).getByRole("button", { name: "ごみの日にする" }))
    const form = within(field()).getByTestId("garbage-purpose-form")
    fireEvent.click(within(form).getByRole("button", { name: "資源" }))

    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await waitFor(() => expect(within(field()).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    expect(within(field()).getByTestId("garbage-purpose-form")).toBe(form)
    expect(within(form).getByRole("button", { name: "資源", pressed: true })).toBeInTheDocument()
    // 先の予定の結果は、この欄の中には出さぬ
    expect(within(field()).queryByText(/保存しました/)).toBeNull()
  })

  it("危険側: 閉じて同じ予定を開き直した欄も別の編集セッションとして扱い、拒否の理由を中に出さぬ", async () => {
    const pending = await sendFromFirst()
    await openEvent("収集の日")
    fireEvent.click(within(field()).getByRole("button", { name: "ごみの日にする" }))
    const form = within(field()).getByTestId("garbage-purpose-form")
    fireEvent.click(within(form).getByRole("button", { name: "資源" }))

    await act(async () => {
      pending.resolve({ error: "この予定は見つかりません。", failure: "rejected" })
    })
    await waitFor(() => expect(within(field()).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    expect(within(field()).getByTestId("garbage-purpose-form")).toBe(form)
    expect(within(form).getByRole("button", { name: "資源", pressed: true })).toBeInTheDocument()
    expect(within(field()).queryByText(/見つかりません/)).toBeNull()
  })
})

describe("R35 先の予定の分類の応答で、開いておる別の予定の通知の欄を読み直さぬ（独立レビュー 7）", () => {
  // 止めた応答は、テストが途中で落ちても必ず解決する（React 19 は未完の非同期 transition に後の transition を
  // 巻き込むゆえ、残すと次のテストの「保存中」が解けぬ）
  const unsettled: Array<() => void> = []
  function deferred<T>(fallback?: T) {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    unsettled.push(() => resolve(fallback as T))
    return { promise, resolve }
  }
  afterEach(async () => {
    await act(async () => {
      for (const settle of unsettled.splice(0)) settle()
    })
    vi.mocked(fetchEventReminder).mockResolvedValue({ error: null, row: null })
  })
  type Response = Awaited<ReturnType<typeof submitGarbageRequest>>
  type ReminderWrite = Awaited<ReturnType<typeof setEventReminder>>
  const first = ev({ id: GARBAGE_EVENT, title: "収集の日" })
  const second = ev({ id: NORMAL_EVENT, title: "資源の日" })
  const reminder = () => document.getElementById("cal-reminder") as HTMLElement
  const readsOf = (eventId: string) => vi.mocked(fetchEventReminder).mock.calls.filter(([id]) => id === eventId).length

  /** 通知の Select（Base UI）を開いて選ぶ。 */
  async function chooseReminder(label: string) {
    await act(async () => {
      fireEvent.pointerDown(reminder(), { pointerType: "mouse", button: 0 })
      fireEvent.mouseDown(reminder(), { button: 0 })
      fireEvent.click(reminder())
    })
    const option = await screen.findByRole("option", { name: label })
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
      fireEvent.mouseUp(option, { button: 0 })
      fireEvent.click(option)
    })
  }

  it("危険側: B の通知を変えて送信中に A の分類の応答が届いても、B の欄を読み直さず、選んだ値のまま", async () => {
    db.rows = [first, second]
    render(<CalendarView {...base} initialEvents={[first, second]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    const pending = deferred<Response>({ status: "saved" })
    submit.mockReturnValueOnce(pending.promise)
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    // 応答を待つ間に A のシートを閉じ、B を開く
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "閉じる" }))
    })
    await waitFor(() => expect(screen.queryByTestId("garbage-purpose-field")).toBeNull())
    await act(async () => {
      fireEvent.click(within(agenda()).getByText("資源の日").closest("button")!)
    })
    await waitFor(() => expect(readsOf(NORMAL_EVENT)).toBe(1))
    await waitFor(() => expect(reminder()).toHaveTextContent("なし"))
    await waitFor(() => expect(reminder()).toBeEnabled())

    // B の通知を「前日20時」へ変える。書込は送信中のまま
    const write = deferred<ReminderWrite>({ error: null, count: 1 })
    vi.mocked(setEventReminder).mockReturnValueOnce(write.promise)
    await chooseReminder("前日20時")
    expect(setEventReminder).toHaveBeenCalledWith({ eventId: NORMAL_EVENT }, "prev_day_20")
    expect(reminder()).toHaveTextContent("前日20時")

    // A の応答が届く。この時サーバーの読みは B の書込より先（変更前の「なし」）を返しうる
    vi.mocked(fetchEventReminder).mockResolvedValue({ error: null, row: null })
    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await act(async () => {
      write.resolve({ error: null, count: 1 })
    })
    // 一覧は取り直すが、B の通知の欄は読み直さず、選んだ値のまま（変更前の値で止まらぬ）
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(reminder()).toHaveTextContent("前日20時")
    expect(screen.queryByText("通知設定を読み込み中…")).toBeNull()
    expect(readsOf(NORMAL_EVENT)).toBe(1)
  })

  it("危険側: 同じシートで分類を送った直後に通知を変えた時、分類の応答では読み直さず、通知の書込が終わってから 1 回だけ読み直す", async () => {
    const prevDay = {
      error: null,
      row: { remind_kind: "prev_day_20", remind_minutes_before: null, remind_at: "2026-07-14T11:00:00.000Z", passed: false },
    } as Awaited<ReturnType<typeof fetchEventReminder>>
    db.rows = [first]
    render(<CalendarView {...base} initialEvents={[first]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(1))
    await waitFor(() => expect(reminder()).toBeEnabled())
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    const pending = deferred<Response>({ status: "saved" })
    submit.mockReturnValueOnce(pending.promise)
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })

    // 分類の応答を待つ間に、同じ予定の通知を「前日20時」へ変える。書込は送信中のまま
    const write = deferred<ReminderWrite>({ error: null, count: 1 })
    vi.mocked(setEventReminder).mockReturnValueOnce(write.promise)
    await chooseReminder("前日20時")
    expect(setEventReminder).toHaveBeenCalledWith({ eventId: GARBAGE_EVENT }, "prev_day_20")

    // 分類の応答が届く。この時の読みは通知の書込より先（変更前の「なし」）を返しうる
    vi.mocked(fetchEventReminder).mockResolvedValue({ error: null, row: null })
    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await act(async () => {})
    // 書込の送信中は読み直さぬ（選んだ値のまま）
    expect(reminder()).toHaveTextContent("前日20時")
    expect(readsOf(GARBAGE_EVENT)).toBe(1)

    // 書込が終わったら 1 回だけ読み直す（分類の保存が書いた通知の変化も、ここで映る）
    vi.mocked(fetchEventReminder).mockResolvedValue(prevDay)
    await act(async () => {
      write.resolve({ error: null, count: 1 })
    })
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(2))
    await waitFor(() => expect(reminder()).toHaveTextContent("前日20時"))
    await act(async () => {})
    expect(readsOf(GARBAGE_EVENT)).toBe(2)
  })

  it("対照: 通知の書込が送信中でなければ、分類の応答ですぐ読み直す（書込の後の読み直しは足さぬ）", async () => {
    db.rows = [first]
    render(<CalendarView {...base} initialEvents={[first]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(1))
    await waitFor(() => expect(reminder()).toBeEnabled())
    // 先に通知を変えて、書込を終えておく
    await chooseReminder("前日20時")
    await waitFor(() => expect(setEventReminder).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(reminder()).toBeEnabled())
    expect(readsOf(GARBAGE_EVENT)).toBe(1)
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(2))
    await act(async () => {})
    expect(readsOf(GARBAGE_EVENT)).toBe(2)
  })

  it("対照: そのフォームから送った分類の応答では、開いておる予定の通知の欄を読み直す（分類の保存は通知も書きうる）", async () => {
    db.rows = [first]
    render(<CalendarView {...base} initialEvents={[first]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(1))
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))
    vi.mocked(fetchEventReminder).mockResolvedValue({
      error: null,
      row: { remind_kind: "prev_day_20", remind_minutes_before: null, remind_at: "2026-07-14T11:00:00.000Z", passed: false },
    } as Awaited<ReturnType<typeof fetchEventReminder>>)
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(readsOf(GARBAGE_EVENT)).toBe(2))
    await waitFor(() => expect(reminder()).toHaveTextContent("前日20時"))
  })
})

describe("保存の結果が分からぬ時（X-09）", () => {
  it("控えを残し、同じ内容で確かめ直す。確かめられるまで新しい分類を受けぬ", async () => {
    const event = ev({ id: GARBAGE_EVENT, title: "収集の日" })
    db.rows = [event]
    render(<CalendarView {...base} initialEvents={[event]} initialPurposes={ok()} />)
    await openEvent("収集の日")
    await openForm("ごみの日にする")
    fireEvent.click(within(field()).getByRole("button", { name: "古紙" }))

    submit.mockRejectedValueOnce(new Error("synthetic lost response"))
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "分類を保存" }))
    })
    await waitFor(() => expect(within(field()).getByText("保存できたか確認できていない操作")).toBeInTheDocument())
    expect(choreKeys()).toHaveLength(1)
    const sent = submit.mock.calls[0][0]
    // 結果が分からぬ間は、新しい保存を受けぬ
    expect(within(field()).getByRole("button", { name: "分類を保存" })).toBeDisabled()

    // 確かめ直し: 同じ内容をそのまま送る（新しい操作を作らぬ）
    submit.mockResolvedValueOnce({ status: "replayed" })
    await act(async () => {
      fireEvent.click(within(field()).getByRole("button", { name: "同じ操作で確認" }))
    })
    expect(submit).toHaveBeenCalledTimes(2)
    expect(submit.mock.calls[1][0]).toEqual(sent)
    await waitFor(() => expect(choreKeys()).toEqual([]))
  })
})
