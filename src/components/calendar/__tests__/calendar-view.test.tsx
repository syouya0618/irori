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

// 月の取り直し（refetch）が返す行。既定は空。編集の衝突テストだけがサーバの最新行を置く。
// `gridEnds` は取り直しが問い合わせた範囲の終端（どの月を取り直したかの記録）。
const monthRows = vi.hoisted(() => ({ rows: [] as unknown[], gridEnds: [] as string[] }))

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
            lte: (_col: string, gridEnd: string) => {
              monthRows.gridEnds.push(gridEnd)
              return {
                gte: () => ({
                  // 取得には期限とキャンセル（abortSignal）が付く（2026-10-27）
                  order: () => ({
                    abortSignal: () => Promise.resolve({ data: monthRows.rows, error: null }),
                  }),
                }),
              }
            },
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
  return { toast: { error: viMod.fn(), success: viMod.fn(), warning: viMod.fn(), info: viMod.fn() } }
})

import { CalendarView } from "../calendar-view"
import { resetPendingCreatesPageStateForTest } from "../calendar-pending-creates"
import type { CalendarEventRecord } from "../use-month-events"
import { formatDayJa } from "../calendar-display"

/**
 * 日セル。読み上げ名は「7月15日（水）、予定1件」の形（ISO の生値は読ませぬ）。
 * 前置一致は述語で取る（整形済み文字列から RegExp を組んで escape を手書きせぬ）。
 */
function dayCell(ymd: string): HTMLElement {
  return within(screen.getByRole("group", { name: "日付を選ぶ" })).getByRole("button", {
    name: (accessibleName) => accessibleName.startsWith(`${formatDayJa(ymd)}、`),
  })
}
/** FAB。名前は「7月15日（水）に予定を追加」（空の日の「この日に予定を追加」とは別）。 */
function fab(): HTMLElement {
  return screen.getByRole("button", { name: /^\d+月\d+日（.）に予定を追加$/ })
}
import {
  createCalendarEvent,
  fetchEventReminder,
  setEventReminder,
  updateCalendarEvent,
} from "@/app/(main)/calendar/actions"
import { toast } from "sonner"
import { jstWallClockToIso, todayJstString } from "@/lib/utils/date-jst"

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

beforeEach(() => {
  cleanup()
  // 試験の間の再読込: ページの寿命の状態（送信中・端末に書けなんだ予定の作成の控え）も空にする
  resetPendingCreatesPageStateForTest()
})

// ⚠️ **既存の振る舞いを一字も変えぬ形で 1 本の prop へ移す。** 旧 base は
// `initialMonthFirst: "2026-07-01"` だけを渡し、選択日は「今日」に倒れておった
// （＝月と日が食い違った対じゃ）。「月送りで選択日がその月へ寄る」テストは
// その前提に依っておるゆえ、ここで同じ対を**明示して**渡す。
const base = {
  householdId: "house-1",
  initialView: { monthFirst: "2026-07-01", selectedDate: todayJstString() },
}

describe("CalendarView", () => {
  it("曜日ヘッダと月グリッド(42セル)を描画する", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    expect(screen.getByText("2026年7月")).toBeInTheDocument()
    for (const w of ["月", "火", "水", "木", "金", "土", "日"]) {
      expect(screen.getAllByText(w).length).toBeGreaterThan(0)
    }
    // 日セルが 42 個。読み上げ名は日付と件数を言い、ISO の生値（2026-07-15）を出さぬ
    const cells = within(screen.getByRole("group", { name: "日付を選ぶ" })).getAllByRole(
      "button",
    )
    expect(cells).toHaveLength(42)
    for (const c of cells) {
      expect(c.getAttribute("aria-label")).toMatch(/^\d+月\d+日（.）(、今日)?、(予定なし|予定\d+件)$/)
    }
  })

  /**
   * 予定画面に FAB が在る間だけ、殻の下端トーストを FAB の上へ退避させる（DESIGN_SYSTEM.md
   * 「浮く操作（FAB）とトーストの契約」）。画面を離れて（unmount して）も属性が残ると、FAB の無い
   * 育児・設定画面のトーストが FAB の分だけ浮いたままになる。
   */
  it("予定画面の mount で <html data-fab> が立ち、画面を離れる（unmount）と外れる", () => {
    document.documentElement.removeAttribute("data-fab")
    const view = render(<CalendarView {...base} initialEvents={[]} />)
    expect(fab()).toBeInTheDocument()
    expect(document.documentElement.hasAttribute("data-fab")).toBe(true)
    view.unmount()
    expect(document.documentElement.hasAttribute("data-fab")).toBe(false)
  })

  it("今日のセルだけが aria-current=date を持つ（選択とは別の印）", () => {
    const today = todayJstString()
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: `${today.slice(0, 7)}-01`, selectedDate: today }}
        initialEvents={[]}
      />,
    )
    const group = screen.getByRole("group", { name: "日付を選ぶ" })
    const current = group.querySelectorAll('[aria-current="date"]')
    expect(current).toHaveLength(1)
    expect(current[0]).toBe(dayCell(today))
  })

  it("日セルの印は Google 由来を灰・irori をオレンジで分け、時刻付き Google を orange にせぬ", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[
          ev({
            id: "g1",
            title: "会議",
            source: "google",
            is_all_day: false,
            start_date: "2026-07-15",
            start_at: jstWallClockToIso("2026-07-15", "14:00"),
          }),
          ev({ id: "n1", title: "検診", start_date: "2026-07-15" }),
        ]}
      />,
    )
    const marks = dayCell("2026-07-15").querySelectorAll("[data-mark]")
    expect(marks).toHaveLength(2)
    const google = Array.from(marks).find((el) => el.getAttribute("data-source") === "google")!
    const native = Array.from(marks).find((el) => el.getAttribute("data-source") === "native")!
    expect(google.getAttribute("data-mark")).toBe("dot")
    expect(google.className).not.toMatch(/primary/)
    expect(native.getAttribute("data-mark")).toBe("band")
    expect(native.className).toMatch(/bg-primary/)
  })

  it("日をタップするとアジェンダがその日に更新される", () => {
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15" })]}
      />,
    )
    fireEvent.click(dayCell("2026-07-15"))
    const agenda = screen.getByRole("heading", { name: /^7月15日（.）\s?の予定/ }).closest("section")!
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
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("会議"))
    // 閉じる手段は下端の「閉じる」と、全シート共通の右上の ×（sr-only の名前も「閉じる」）の 2 つだけ
    const closes = screen.getAllByRole("button", { name: "閉じる" })
    expect(closes).toHaveLength(2)
    expect(closes.filter((b) => b.getAttribute("data-slot") === "sheet-close")).toHaveLength(1)
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
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日（水）・終日")).toBeInTheDocument()
    // 閲覧のみであることを文字で示す（色やアイコンだけに頼らぬ）
    expect(screen.getByText("Google カレンダー・閲覧のみ")).toBeInTheDocument()
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
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("会議"))
    expect(screen.getByText("7月15日（水）14:00〜15:00")).toBeInTheDocument()
  })

  it("時刻付き予定で開始時刻を空にして保存してもクラッシュせず、シート内で弾く", () => {
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(fab())
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
    // FAB の名前は「…に予定を追加」ゆえ、完全一致の「追加」はシートの保存ボタンだけ
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
    expect(screen.getByRole("heading", { name: /^8月1日（.）\s?の予定/ })).toBeInTheDocument()
  })
})

/**
 * B-6: 通知の着地日（`/calendar?date=`）。
 *
 * サーバは `resolveCalendarDateView` で **選択日と月を対で** 導き、`initialView`
 * として 1 本で渡す。ここは受け取り側 —— 渡された日で開くこと・今日を渡せば
 * 従来どおり今日であること・壊れた値で画面を落とさぬことを固定する
 * （`initialView.selectedDate` を無視する実装は「日をタップする」既存テストを
 * 全部緑で通り抜ける）。
 *
 * 「月と日が食い違う対」を撃つテストは**置かぬ**: 対で受ける型にした時点で
 * 定義された振る舞いが無く、何を期待値にしても実装の写しになるゆえ
 * （分離を型で塞いだことがそのまま検出器じゃ）。
 */
describe("CalendarView — initialView.selectedDate（B-6）", () => {
  it("渡された日でアジェンダが開き、その日のセルが選択状態になる", () => {
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: "2026-09-01", selectedDate: "2026-09-01" }}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-09-01" })]}
      />,
    )
    expect(screen.getByText("2026年9月")).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: /^9月1日（.）\s?の予定/ })).toBeInTheDocument()
    // 色だけでなく aria-pressed でも選択が分かること（設計規約: 色依存の禁止）。
    expect(dayCell("2026-09-01")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    const agenda = screen.getByRole("heading", { name: /^9月1日（.）\s?の予定/ }).closest("section")!
    expect(within(agenda).getByText("検診")).toBeInTheDocument()
  })

  it("月の途中の日でも、その日が選ばれる（月初へ丸めぬ）", () => {
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: "2026-09-01", selectedDate: "2026-09-20" }}
        initialEvents={[]}
      />,
    )
    expect(screen.getByRole("heading", { name: /^9月20日（.）\s?の予定/ })).toBeInTheDocument()
  })

  it("今日を渡せば今日が選ばれる（既存の振る舞いを変えぬ）", () => {
    const today = todayJstString()
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: `${today.slice(0, 7)}-01`, selectedDate: today }}
        initialEvents={[]}
      />,
    )
    expect(dayCell(today)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })

  it("不正な日付が届いても画面は死なず今日へ倒れる（二重の防御）", () => {
    // サーバ側で既に締めておるゆえ本来到達せぬが、ここが throw すると
    // buildMonthGrid まで巻き込んで**カレンダーが白紙**になる。
    const today = todayJstString()
    render(
      <CalendarView
        householdId="house-1"
        initialView={{ monthFirst: `${today.slice(0, 7)}-01`, selectedDate: "2026-02-30" }}
        initialEvents={[]}
      />,
    )
    expect(dayCell(today)).toHaveAttribute(
      "aria-pressed",
      "true",
    )
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
    fireEvent.click(fab())
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
    fireEvent.click(fab())
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
    fireEvent.click(fab())
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
    fireEvent.click(dayCell("2026-07-15"))
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
    fireEvent.click(fab())
    expect(fetchEventReminder).not.toHaveBeenCalled()
    expect(document.getElementById("cal-reminder")).toHaveTextContent("1時間前")
  })
})

/**
 * 予定の編集は開いた時点の版（updated_at）を送る楽観的排他。配偶者が先に直した予定を、
 * 古い画面からの保存で無言のまま巻き戻さぬ（育児日記 P1-06 と同じ契約）。
 */
describe("CalendarView - 編集の版（楽観的排他）", () => {
  const V1 = "2026-07-15T00:00:00.111111+00:00"
  const V2 = "2026-07-15T00:05:00.222222+00:00"

  beforeEach(() => {
    vi.clearAllMocks()
    monthRows.rows = []
  })

  const openAndSave = (newTitle: string, currentTitle: string) => {
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText(currentTitle))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: newTitle } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
  }

  it("保存は開いた時点の版を送り、応答の新しい版を次の保存で送る", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({ error: null, updatedAt: V2 })
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    openAndSave("検診（1回目）", "検診")
    await waitFor(() =>
      expect(updateCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({ id: "e1", title: "検診（1回目）", expectedUpdatedAt: V1 }),
      ),
    )
    // 自分の保存で進んだ版を持たねば、続けて直した時に自分の保存と衝突する
    await waitFor(() => expect(screen.getByText("検診（1回目）")).toBeInTheDocument())

    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({ error: null, updatedAt: V1 })
    openAndSave("検診（2回目）", "検診（1回目）")
    await waitFor(() =>
      expect(updateCalendarEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "検診（2回目）", expectedUpdatedAt: V2 }),
      ),
    )
  })

  it("衝突なら手元の楽観表示を捨て、エラーを出して最新を取り直す", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({
      error: "この予定は別の端末で先に更新されていました（家族またはご自身）。",
      conflict: true,
    })
    monthRows.rows = [
      ev({ id: "e1", title: "検診（家族が変更）", start_date: "2026-07-15", updated_at: V2 }),
    ]
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    openAndSave("検診（自分の古い画面から）", "検診")
    // 衝突は「失敗」(error) と別の「警告」として出す。入力を握って送り直させぬゆえ
    // 「入力に戻る」ではなく「最新を開く」を添える
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringMatching(/先に更新されていました/),
        expect.objectContaining({
          action: expect.objectContaining({ label: "最新を開く" }),
        }),
      ),
    )
    expect(toast.error).not.toHaveBeenCalled()
    // サーバの最新（家族の変更）が出て、古い画面からの自分の変更は残らぬ
    await waitFor(() => expect(screen.getByText("検診（家族が変更）")).toBeInTheDocument())
    expect(screen.queryByText("検診（自分の古い画面から）")).not.toBeInTheDocument()
  })

  it("衝突でない失敗（読み直し不能など）は取り直さず、開いた時点の表示へ戻すだけ", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({
      error: "予定を更新できたか確かめられませんでした。",
    })
    monthRows.rows = [
      ev({ id: "e1", title: "取り直したら出る行", start_date: "2026-07-15", updated_at: V2 }),
    ]
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    openAndSave("検診（変更）", "検診")
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText("検診")).toBeInTheDocument())
    expect(screen.queryByText("取り直したら出る行")).not.toBeInTheDocument()
  })
})

/**
 * 独立レビュー P2-1: シートは開いた時点の行を握る。保存の応答待ち（保存ボタンは無効）に
 * 開き直したシートや、作成の応答前に開いた行が、自分の保存と偽の衝突を起こさぬこと。
 * ただし辿るのは**自分の保存が進めた版だけ**（家族の更新を取り直した版で上書きせぬ）。
 */
describe("CalendarView - 自分の保存で進んだ版を辿る（偽の衝突を作らぬ）", () => {
  const V1 = "2026-07-15T00:00:00.111111+00:00"
  const V2 = "2026-07-15T00:05:00.222222+00:00"

  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    return { promise, resolve }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    monthRows.rows = []
    monthRows.gridEnds = []
  })

  it("保存の応答待ちに開き直したシートから保存しても、自分の保存で進んだ版を送る", async () => {
    const first = deferred<{ error: null; updatedAt: string }>()
    vi.mocked(updateCalendarEvent).mockImplementationOnce(() => first.promise)
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({ error: null, updatedAt: V1 })
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（1回目）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    // 応答の前に開き直す（シートは保存後の中身・保存前の版 V1 を握る）
    fireEvent.click(screen.getByText("検診（1回目）"))
    first.resolve({ error: null, updatedAt: V2 })
    await waitFor(() => expect(screen.getByRole("button", { name: "更新" })).toBeEnabled())
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（2回目）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() =>
      expect(updateCalendarEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "e1", title: "検診（2回目）", expectedUpdatedAt: V2 }),
      ),
    )
  })

  it("シートを開いたまま家族の更新（V2）を取り直しても、開いた時点の V1 を送る", async () => {
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({
      error: "この予定は別の端末で先に更新されていました（家族またはご自身）。",
      conflict: true,
    })
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("検診"))
    // シートを開いたまま、復帰の取り直しで家族の更新（版 V2）が手元の一覧に入る
    monthRows.rows = [
      ev({ id: "e1", title: "検診（家族が変更）", start_date: "2026-07-15", updated_at: V2 }),
    ]
    const before = monthRows.gridEnds.length
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true })
    window.dispatchEvent(new Event("focus"))
    await waitFor(() => expect(monthRows.gridEnds.length).toBeGreaterThan(before))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（古い画面）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    // 手元の最新（家族の V2）を読んで送ると家族の変更を上書きできてしまう。開いた時点の V1
    await waitFor(() =>
      expect(updateCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({ title: "検診（古い画面）", expectedUpdatedAt: V1 }),
      ),
    )
  })

  it("作成の応答前に開いた行を応答後に保存すると、確定 id と版で送り、幽霊行を残さぬ", async () => {
    const created = deferred<{ error: null; eventId: string; updatedAt: string }>()
    vi.mocked(createCalendarEvent).mockImplementationOnce(() => created.promise)
    vi.mocked(updateCalendarEvent).mockResolvedValueOnce({ error: null, updatedAt: V2 })
    render(<CalendarView {...base} initialEvents={[]} />)
    fireEvent.click(fab())
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "予防接種" } })
    fireEvent.click(screen.getByRole("button", { name: "追加" }))
    // 応答の前に楽観行（一時 id・版 null）を開く
    fireEvent.click(screen.getByText("予防接種"))
    created.resolve({ error: null, eventId: "ev-real", updatedAt: V1 })
    await waitFor(() => expect(screen.getByRole("button", { name: "更新" })).toBeEnabled())
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "予防接種（2回目）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    await waitFor(() =>
      expect(updateCalendarEvent).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: "ev-real", expectedUpdatedAt: V1 }),
      ),
    )
    await waitFor(() => expect(screen.getByText("予防接種（2回目）")).toBeInTheDocument())
    // 一時 id の行が別に足されて元の件名が残る（幽霊行）ことが無い
    expect(screen.queryByText("予防接種")).not.toBeInTheDocument()
  })

  it("衝突の後の取り直しは、待つ間に送った月（いま表示中の月）を読む", async () => {
    const first = deferred<{ error: string; conflict: true }>()
    vi.mocked(updateCalendarEvent).mockImplementationOnce(() => first.promise)
    render(
      <CalendarView
        {...base}
        initialEvents={[ev({ id: "e1", title: "検診", start_date: "2026-07-15", updated_at: V1 })]}
      />,
    )
    fireEvent.click(dayCell("2026-07-15"))
    fireEvent.click(screen.getByText("検診"))
    fireEvent.change(screen.getByLabelText("タイトル"), { target: { value: "検診（変更）" } })
    fireEvent.click(screen.getByRole("button", { name: "更新" }))
    fireEvent.click(screen.getByRole("button", { name: "次の月" }))
    expect(screen.getByText("2026年8月")).toBeInTheDocument()
    const augustEnd = monthRows.gridEnds.at(-1)
    first.resolve({ error: "この予定は別の端末で先に更新されていました。", conflict: true })
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    await waitFor(() => expect(monthRows.gridEnds.length).toBeGreaterThanOrEqual(2))
    // 最後の取り直しは 8 月の範囲（7 月へ巻き戻して 8 月の表示を上書きせぬ）
    expect(monthRows.gridEnds.at(-1)).toBe(augustEnd)
    expect(augustEnd! > "2026-08-01").toBe(true)
  })
})

const medicalNavigation=vi.hoisted(()=>({push:vi.fn()}))
vi.mock("next/navigation",()=>({useRouter:()=>medicalNavigation}))

it("opens linked medical events with their frozen child scope",()=>{
 render(<CalendarView {...base} initialEvents={[ev({id:"medical-synthetic",title:"synthetic medical visit",child_id:"synthetic-child",medical_record_id:"medical-synthetic"})]}/> )
 fireEvent.click(dayCell("2026-07-15"));fireEvent.click(screen.getByText("synthetic medical visit"))
 expect(medicalNavigation.push).toHaveBeenCalledWith("/baby/medical?child=synthetic-child")
 expect(screen.queryByLabelText("タイトル")).not.toBeInTheDocument()
})
