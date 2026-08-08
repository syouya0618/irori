/**
 * CalendarView の描画・選択・google read-only の回帰テスト。
 * 初期描画は initialEvents を使い refetch を発火させないため、client は最小 mock で足りる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react"

// 最小 client mock: realtime 購読が throw しないだけの chainable スタブ
vi.mock("@/lib/supabase/client", () => {
  const channel = {
    on: () => channel,
    subscribe: () => channel,
  }
  return {
    createClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
      from: () => ({
        select: () => ({
          eq: () => ({
            lte: () => ({
              gte: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
            }),
          }),
        }),
      }),
    }),
  }
})
vi.mock("@/app/(main)/calendar/actions", () => ({
  createCalendarEvent: vi.fn().mockResolvedValue({ error: null, eventId: "x" }),
  updateCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEvent: vi.fn().mockResolvedValue({ error: null }),
  deleteCalendarEventSeries: vi.fn().mockResolvedValue({ error: null }),
  // V7 の同期シグナル。既定の props（syncScheduled=false）ではポーリングが
  // 走らぬため呼ばれぬが、mock に無いと import 段階で落ちる。
  fetchGoogleSyncSignal: vi.fn().mockResolvedValue({ lastSyncedAt: null }),
  // B-2: シートを開くと通知設定を 1 件引く。既定は「未設定」（row: null）。
  fetchEventReminder: vi.fn().mockResolvedValue({ error: null, row: null }),
  setEventReminder: vi.fn().mockResolvedValue({ error: null, count: 1 }),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { CalendarView } from "../calendar-view"
import type { CalendarEventRecord } from "../use-month-events"
import {
  createCalendarEvent,
  fetchEventReminder,
  setEventReminder,
} from "@/app/(main)/calendar/actions"
import { jstWallClockToIso } from "@/lib/utils/date-jst"

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

beforeEach(() => cleanup())

const base = {
  householdId: "house-1",
  initialMonthFirst: "2026-07-01",
}

describe("CalendarView", () => {
  it("曜日ヘッダと月グリッド(42セル)を描画する", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    expect(screen.getByText("2026年7月")).toBeInTheDocument()
    for (const w of ["月", "火", "水", "木", "金", "土", "日"]) {
      expect(screen.getAllByText(w).length).toBeGreaterThan(0)
    }
    // 日セル(aria-label "…を選択")が 42 個
    expect(screen.getAllByRole("button", { name: /を選択$/ })).toHaveLength(42)
  })

  it("日をタップするとアジェンダがその日に更新される", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15" })]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    const agenda = screen.getByText(/7月15日 の予定/).closest("section")!
    expect(within(agenda).getByText("検診")).toBeInTheDocument()
  })

  it("google 予定はタップしても read-only(更新ボタンなし・閉じるのみ)", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({ id: "g1", title: "会議", start_date: "2026-07-15", source: "google" }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByRole("button", { name: "閉じる" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "更新" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "削除" })).not.toBeInTheDocument()
  })

  it("google 詳細シートに終日イベントの日時行が出る", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({
            id: "g1",
            title: "会議",
            is_all_day: true,
            start_date: "2026-07-15",
            end_date: "2026-07-15",
            source: "google",
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日・終日")).toBeInTheDocument()
  })

  it("google 詳細シートに時刻付きイベントの日時行が出る", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({
            id: "g2",
            title: "会議",
            is_all_day: false,
            start_date: "2026-07-15",
            end_date: "2026-07-15",
            start_at: jstWallClockToIso("2026-07-15", "14:00"),
            end_at: jstWallClockToIso("2026-07-15", "15:00"),
            source: "google",
          }),
        ]}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日 14:00〜15:00")).toBeInTheDocument()
  })

  it("時刻付き予定で開始時刻を空にして保存してもクラッシュせず、シート内で弾く", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    fireEvent.change(screen.getByLabelText("タイトル"), {
      target: { value: "会議" },
    })
    // 終日を外して時刻フィールドを出す(セグメント「時刻あり」)
    fireEvent.click(screen.getByRole("button", { name: "時刻あり" }))
    // 既定 09:00 を空にする(date/time input は required 無しでクリア可能)
    const startTime = document.getElementById("cal-start-time") as HTMLInputElement
    fireEvent.change(startTime, { target: { value: "" } })
    // 追加(最初期は jstWallClockToIso の RangeError で無反応・保存も通知もなし。
    // 次に handleSubmit の toast で弾いていたが、シートが閉じて入力が消えた。
    // 現在はシート内の保存前検証で弾き、シートも入力も残す)
    // testing-library の name 文字列は既定で完全一致のため FAB「予定を追加」とは衝突しない
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    expect(screen.getByRole("alert")).toHaveTextContent("開始時刻を入力してください")
    expect(createCalendarEvent).not.toHaveBeenCalled()
    // シートは開いたままで、入力したタイトルも残っている
    expect(screen.getByRole("heading", { name: "予定を追加" })).toBeInTheDocument()
    expect((screen.getByLabelText("タイトル") as HTMLInputElement).value).toBe("会議")
  })

  it("月送りで選択日がその月へ寄り、アジェンダが範囲外日を誤表示しない", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(screen.getByText("2026年8月")).toBeInTheDocument()
    // アジェンダの対象日が 8月1日 に寄る(今日=7月のままにしない)
    expect(screen.getByText(/8月1日 の予定/)).toBeInTheDocument()
  })
})

/**
 * B-2: 新規作成 → 通知の書き込みまでの**結線**。
 *
 * `notification_preferences.event_default_minutes` が実際に通知行を生むのは
 * この経路だけじゃ。切れておっても Select は「30分前」と出たまま、エラーも出ず、
 * ただ**何も書かれぬ** — 画面からは一切見えぬ壊れ方をする。ゆえに結線そのものを撃つ。
 *
 * 予定の作成は `startTransition` の中で await されるため、`waitFor` で待つ。
 * ここで見ておるのは「呼ばれた」という**単調に真へ向かう**条件のみ
 * （時間とともに変わる集合を waitFor で数えるのは禁じ手ゆえ）。
 */
describe("CalendarView - 新規作成時の通知の結線(B-2)", () => {
  // このファイルは既定で mock を clear せぬ（他テストの呼び出し履歴が残る）。
  // 「呼ばれておらぬ」を見る assert があるため、この describe だけ明示的に clear する。
  beforeEach(() => vi.clearAllMocks())

  const fillTitleAndSubmit = (title: string) => {
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: title } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
  }

  it("既定値が Select に入り、作成成功後にその通知が書かれる", async () => {
    render(
      <CalendarView {...base} initialEvents={[]} defaultReminderMinutes={30} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    // 既定値が画面に反映されておること（prefs → UI）
    expect(document.getElementById("cal-reminder")).toHaveTextContent("30分前")

    fillTitleAndSubmit("検診")
    // 作成で得た確定 id を宛先に通知を書くこと（UI → DB）
    await waitFor(() =>
      expect(setEventReminder).toHaveBeenCalledWith({ eventId: "x" }, "m30"),
    )
  })

  it("既定が「なし」なら通知は書かず、無駄な往復もせぬ", async () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    expect(document.getElementById("cal-reminder")).toHaveTextContent("なし")

    fillTitleAndSubmit("検診")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalled())
    expect(setEventReminder).not.toHaveBeenCalled()
  })

  // 繰り返し側の結線は UI から駆動できぬ（base-ui Select は jsdom で
  // `fireEvent` から選択できず、option は描画されるが `onValueChange` が発火せぬ。
  // 実測で確認。`@testing-library/user-event` は本リポに未導入）。
  // ゆえに宛先の決定規則を `reminderTargetFromCreateResult` へ切り出し、
  // **両分岐が同じ 1 行を呼ぶ**形にしてある。規則そのものの網羅は
  // `lib/domain/__tests__/event-reminder.test.ts` が持つ。

  it("作成が失敗したときは通知を書かぬ（宛先の無い通知を作らぬ）", async () => {
    vi.mocked(createCalendarEvent).mockResolvedValueOnce({
      error: "予定の作成に失敗しました。",
    } as unknown as Awaited<ReturnType<typeof createCalendarEvent>>)

    render(
      <CalendarView {...base} initialEvents={[]} defaultReminderMinutes={30} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    fillTitleAndSubmit("検診")
    await waitFor(() => expect(createCalendarEvent).toHaveBeenCalled())
    expect(setEventReminder).not.toHaveBeenCalled()
  })
})

/**
 * B-2: 既存予定を開いたときの**読み取りの結線**。
 *
 * 設定済みの通知を「なし」と表示してしまうと、利用者は気付かず上書きする。
 * ゆえに「開いたら引く」「引いた値が Select に出る」を撃つ。
 */
describe("CalendarView - 既存予定の通知の読み取り(B-2)", () => {
  beforeEach(() => vi.clearAllMocks())

  const openEvent = (record: CalendarEventRecord) => {
    render(<CalendarView {...base} initialEvents={[record]} />)
    fireEvent.click(screen.getByRole("button", { name: "2026-07-15 を選択" }))
    fireEvent.click(screen.getByText(record.title))
  }

  it("**google 予定**を開くと通知を引き、設定済みの値が Select に出る", async () => {
    vi.mocked(fetchEventReminder).mockResolvedValueOnce({
      error: null,
      row: { remind_kind: "prev_day_20", remind_minutes_before: null },
    })
    openEvent(ev({ id: "g1", title: "会議", source: "google" }))

    expect(fetchEventReminder).toHaveBeenCalledWith("g1")
    await waitFor(() =>
      expect(document.getElementById("cal-reminder")).toHaveTextContent("前日20時"),
    )
  })

  it("未設定の予定は「なし」で出る", async () => {
    vi.mocked(fetchEventReminder).mockResolvedValueOnce({ error: null, row: null })
    openEvent(ev({ id: "e1", title: "検診", source: "native" }))
    await waitFor(() =>
      expect(document.getElementById("cal-reminder")).toHaveTextContent("なし"),
    )
  })

  it("読み取りに失敗したら「なし」と偽らず、操作を止める", async () => {
    vi.mocked(fetchEventReminder).mockResolvedValueOnce({
      error: "通知設定の取得に失敗しました。",
      row: null,
    })
    openEvent(ev({ id: "e1", title: "検診", source: "native" }))
    await waitFor(() =>
      expect(document.getElementById("cal-reminder")).toBeDisabled(),
    )
  })

  it("新規作成では問い合わせず、個人の既定値から始める", () => {
    render(
      <CalendarView {...base} initialEvents={[]} defaultReminderMinutes={60} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "予定を追加" }))
    expect(fetchEventReminder).not.toHaveBeenCalled()
    expect(document.getElementById("cal-reminder")).toHaveTextContent("1時間前")
  })
})
