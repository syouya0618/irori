/**
 * ごみの画面（/chores/garbage）の本体の契約（A-03 / A-06 / A-07 / A-10、X-03）。
 *
 * - 未登録: 予定の作成（/calendar）への導線と手順の一文
 * - 次の収集日: 名称・日付・通知の有無（読めなんだ時は「なし」と言わぬ）
 * - 分類の変更・解除は、範囲と通知の扱いを明示したフォームから
 * - 予定が見つからぬ分類だけ手動で整理できる。確かめられなんだ分類は「見つからぬ」と言わぬ
 * - 読めなんだ時は「ありません」と言わず、失敗と再読込を出す
 * - 通知の状態は読むだけ（権限を求めぬ）
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }))
vi.mock("@/app/(main)/chores/garbage/actions", () => ({ submitGarbageRequest: vi.fn() }))

import { submitGarbageRequest } from "@/app/(main)/chores/garbage/actions"
import {
  buildGarbageOverview,
  purposeLookupKey,
  type EventPurposeRow,
  type GarbageEventRow,
} from "@/lib/domain/garbage"
import type { GarbagePageData } from "@/lib/supabase/garbage-overview-query"
import { GarbageView } from "../garbage-view"

const submit = vi.mocked(submitGarbageRequest)

const OWNER = { userId: "a9000000-0000-4000-8000-000000000001", householdId: "a9000000-0000-4000-8000-0000000000aa" }
const TODAY = "2026-11-11"
const SERIES = "b9000000-0000-4000-8000-0000000000f0"
const E1 = "b9000000-0000-4000-8000-000000000001"
const E2 = "b9000000-0000-4000-8000-000000000002"
const SINGLE = "b9000000-0000-4000-8000-000000000003"
const P_SERIES = "d9000000-0000-4000-8000-000000000001"
const P_ORPHAN = "d9000000-0000-4000-8000-000000000002"
const P_UNCHECKED = "d9000000-0000-4000-8000-000000000003"

function row(o: Partial<EventPurposeRow> & { id: string; scope: "event" | "series"; targetKey: string }): EventPurposeRow {
  return {
    purpose: "garbage",
    garbageKind: "燃えるごみ",
    remindDefault: o.scope === "series" ? "prev_day_20" : null,
    reminderOptOut: false,
    updatedAt: null,
    ...o,
  }
}
function event(id: string, o: Partial<GarbageEventRow> = {}): GarbageEventRow {
  return {
    id,
    title: "収集",
    is_all_day: true,
    start_date: "2026-11-12",
    end_date: o.start_date ?? "2026-11-12",
    start_at: null,
    source: "native",
    series_id: null,
    event_uid: id,
    ...o,
  }
}

function pageData(o: {
  rows?: EventPurposeRow[]
  windowEvents?: GarbageEventRow[]
  unchecked?: string[]
  patch?: Partial<GarbagePageData>
}): GarbagePageData {
  return {
    today: TODAY,
    windowDays: 62,
    purposes: "ok",
    events: "ok",
    overview: buildGarbageOverview({
      rows: o.rows ?? [],
      windowEvents: o.windowEvents ?? [],
      anchorEvents: [],
      unchecked: new Set(o.unchecked ?? []),
      today: TODAY,
      collectionLimit: 20,
    }),
    reminders: { status: "ok", byEventKey: {} },
    ...o.patch,
  }
}

/** シリーズ既定の行の版（保存の要求に、画面が見ておった版としてそのまま載る） */
const SERIES_VERSION = "2026-11-10T00:00:00.123456+00:00"
const seriesRows = [
  row({ id: P_SERIES, scope: "series", targetKey: SERIES, garbageKind: "プラスチック", updatedAt: SERIES_VERSION }),
]
const seriesEvents = [
  event(E1, { series_id: SERIES, start_date: "2026-11-12", title: "プラごみ" }),
  event(E2, { series_id: SERIES, start_date: "2026-11-19", title: "プラごみ" }),
]

/** 端末の控えを読み終える（保存を受けられる）まで待つ。 */
async function settle() {
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  submit.mockResolvedValue({ status: "saved" })
})
afterEach(() => cleanup())

describe("GarbageView: 未登録・読めなんだ時", () => {
  it("未登録: 手順の一文と、予定の作成（/calendar）への導線を出す", async () => {
    render(<GarbageView owner={OWNER} data={pageData({})} />)
    await settle()
    expect(screen.getByText("ごみの日はまだ登録されていません")).toBeInTheDocument()
    expect(screen.getByText(/その予定を開いて「ごみの日にする」を押すと/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "カレンダーで予定を作る" })).toHaveAttribute("href", "/calendar")
    // 分類の一覧・整理の区画は出さぬ
    expect(screen.queryByRole("heading", { name: "分類した予定" })).toBeNull()
    expect(screen.queryByRole("heading", { name: "予定が見つからない分類" })).toBeNull()
  })

  it("分類を読めなんだ時は「登録されていません」と言わず、失敗と再読込を出す", async () => {
    render(<GarbageView owner={OWNER} data={pageData({ patch: { purposes: "failed" } })} />)
    await settle()
    expect(screen.queryByText("ごみの日はまだ登録されていません")).toBeNull()
    expect(screen.getByRole("alert")).toHaveTextContent("ごみの分類を読み込めませんでした。ごみの分類がないとは限りません。")
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).toHaveBeenCalled()
  })

  it("今後の予定を読めなんだ時は収集日を「ありません」と言わぬが、分類の一覧は出す", async () => {
    const data = pageData({ rows: seriesRows, patch: { events: "failed" } })
    // 予定を読めておらぬ = 期間内の回は 0 件。鍵で引いて見つかった体にする
    data.overview = buildGarbageOverview({
      rows: seriesRows,
      windowEvents: [],
      anchorEvents: [seriesEvents[1]],
      unchecked: new Set(),
      today: TODAY,
      collectionLimit: 20,
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    expect(screen.getByRole("alert")).toHaveTextContent("今後の予定を読み込めませんでした")
    expect(screen.queryByText(/収集日はありません/)).toBeNull()
    const entries = screen.getByTestId("garbage-entries")
    expect(within(entries).getByText("プラスチック")).toBeInTheDocument()
    // 読めておらぬ期間について「この分類の回はありません」とも言わぬ
    expect(within(entries).queryByText(/この分類の回はありません/)).toBeNull()
  })
})

describe("GarbageView: 次の収集日", () => {
  it("近い順に、名称・日付・通知の有無を出す", async () => {
    const data = pageData({
      rows: seriesRows,
      windowEvents: seriesEvents,
      patch: {
        reminders: {
          status: "ok",
          byEventKey: { [E1]: { remind_kind: "prev_day_20", remind_minutes_before: null, passed: false } },
        },
      },
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    const items = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent("プラスチック")
    expect(items[0]).toHaveTextContent("11月12日（木）（明日）")
    expect(items[0]).toHaveTextContent("前日 20:00 に通知")
    expect(items[1]).toHaveTextContent("11月19日（木）（8日後）")
    // 2 件目は通知設定の行が無い = 通知なし（対照）
    expect(items[1]).toHaveTextContent("通知なし")
    expect(items[1]).not.toHaveTextContent("前日 20:00 に通知")
  })

  it("通知の時刻がもう過ぎた回には「通知」と言わず、これからは届かぬことを言う（R09）", async () => {
    const data = pageData({
      rows: seriesRows,
      windowEvents: seriesEvents,
      patch: {
        reminders: {
          status: "ok",
          byEventKey: {
            // 明日の回を前日 20:00 より後に分類した（設定の行は在るが、時刻は過ぎておる）
            [E1]: { remind_kind: "prev_day_20", remind_minutes_before: null, passed: true },
            [E2]: { remind_kind: "prev_day_20", remind_minutes_before: null, passed: false },
          },
        },
      },
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    const items = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("前日 20:00 は過ぎています（この回の通知は、これからは届きません）")
    expect(items[0]).not.toHaveTextContent("前日 20:00 に通知")
    // 対照: 次の回は届く
    expect(items[1]).toHaveTextContent("前日 20:00 に通知")
    expect(items[1]).not.toHaveTextContent("過ぎています")
  })

  it("時刻を変えた通知（N 分前）が過ぎた回も同じく言う", async () => {
    const data = pageData({
      rows: seriesRows,
      windowEvents: seriesEvents,
      patch: {
        reminders: { status: "ok", byEventKey: { [E1]: { remind_kind: "minutes", remind_minutes_before: 30, passed: true } } },
      },
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    const first = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")[0]
    expect(first).toHaveTextContent("通知の時刻は過ぎています（この回の通知は、これからは届きません）")
    expect(first).not.toHaveTextContent("30分前に通知")
  })

  it("通知設定を読めなんだ時は「通知なし」と言わぬ", async () => {
    const data = pageData({ rows: seriesRows, windowEvents: seriesEvents, patch: { reminders: { status: "failed" } } })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    const first = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")[0]
    expect(first).toHaveTextContent("通知の設定を確認できませんでした")
    expect(first).not.toHaveTextContent("通知なし")
  })

  it("個別に止めた回・時刻を変えた回を言い分ける", async () => {
    const rows = [
      ...seriesRows,
      row({ id: "d9000000-0000-4000-8000-000000000009", scope: "event", targetKey: E1, purpose: null, garbageKind: null, reminderOptOut: true }),
    ]
    const data = pageData({
      rows,
      windowEvents: seriesEvents,
      patch: {
        reminders: { status: "ok", byEventKey: { [E2]: { remind_kind: "minutes", remind_minutes_before: 30, passed: false } } },
      },
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()
    const items = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")
    expect(items[0]).toHaveTextContent("通知なし（この回は止めています）")
    expect(items[1]).toHaveTextContent("30分前に通知")
  })

  it("登録は在るが期間内に収集日が無い時は、その旨とカレンダーへの導線を出す", async () => {
    render(<GarbageView owner={OWNER} data={pageData({ rows: seriesRows })} />)
    await settle()
    expect(screen.getByText("今日から62日のあいだに、収集日はありません。")).toBeInTheDocument()
    expect(screen.queryByText("ごみの日はまだ登録されていません")).toBeNull()
  })

  it("収集日の「変更」から、範囲と通知を明示したフォームを開いて保存できる", async () => {
    render(<GarbageView owner={OWNER} data={pageData({ rows: seriesRows, windowEvents: seriesEvents })} />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "11月12日（木）のプラスチックを変更" }))
    const form = await screen.findByTestId("garbage-purpose-form")
    // 繰り返しの回ゆえ範囲を選べる。今効いておる範囲（シリーズ全体）から始まる
    expect(within(form).getByRole("button", { name: "シリーズ全体", pressed: true })).toBeInTheDocument()
    fireEvent.click(within(form).getByRole("button", { name: "この回だけ" }))
    fireEvent.click(within(form).getByRole("button", { name: "この回だけ通常の予定に戻す" }))
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "通常の予定に戻す" }))
    })
    expect(submit).toHaveBeenCalledWith({
      op: "save",
      eventId: E1,
      scope: "event",
      action: "normal",
      garbageKind: null,
      reminder: "off",
      // 画面が見ておった版（シリーズ既定の行。この回だけの行は無い）
      seen: { series: SERIES_VERSION, event: null },
    })
    // 確定したらシートを閉じ、Server の内容を取り直す
    await waitFor(() => expect(screen.queryByTestId("garbage-purpose-form")).toBeNull())
    expect(refresh).toHaveBeenCalled()
  })

  it("保存が conflict（別の端末が先に変えた = 何も書いておらぬ）なら、その旨を出して読み直す（R38）", async () => {
    submit.mockResolvedValue({ status: "conflict" })
    render(<GarbageView owner={OWNER} data={pageData({ rows: seriesRows, windowEvents: seriesEvents })} />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "11月12日（木）のプラスチックを変更" }))
    const form = await screen.findByTestId("garbage-purpose-form")
    fireEvent.click(within(form).getByRole("button", { name: "資源" }))
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "分類を保存" }))
    })
    expect(submit.mock.calls[0][0]).toMatchObject({ scope: "series", garbageKind: "資源", seen: { series: SERIES_VERSION, event: null } })
    await waitFor(() => expect(screen.getAllByRole("alert")[0]).toHaveTextContent("上書きはしていません"))
    expect(screen.queryByText("保存しました。")).toBeNull()
    expect(refresh).toHaveBeenCalled()
  })

  it("直近の回だけ通常へ戻してある時、シリーズ行の「次の収集日」は収集の在る次の回を言う（R08）", async () => {
    const rows = [
      ...seriesRows,
      row({ id: "d9000000-0000-4000-8000-000000000008", scope: "event", targetKey: E1, purpose: "normal", garbageKind: null }),
    ]
    render(<GarbageView owner={OWNER} data={pageData({ rows, windowEvents: seriesEvents })} />)
    await settle()
    // 上段: 次の収集日は 11/19 の 1 件だけ
    const items = within(screen.getByTestId("garbage-collections")).getAllByRole("listitem")
    expect(items).toHaveLength(1)
    expect(items[0]).toHaveTextContent("11月19日（木）（8日後）")
    // 下段のシリーズ行も同じ日を言う（収集の無い 11/12 を「次の収集日」と告げぬ）
    const seriesEntry = screen
      .getByTestId("garbage-entries")
      .querySelector("li[data-purpose-scope='series']") as HTMLElement
    expect(seriesEntry).toHaveTextContent("次の収集日: 11月19日（木）（8日後）")
    expect(seriesEntry).not.toHaveTextContent("11月12日")
    // 例外の行は自分の日を言う（対照）
    const exceptionEntry = screen
      .getByTestId("garbage-entries")
      .querySelector("li[data-purpose-scope='event']") as HTMLElement
    expect(exceptionEntry).toHaveTextContent("対象の日: 11月12日（木）（明日）")
  })
})

describe("GarbageView: 分類の一覧と整理", () => {
  it("シリーズ既定は、今後の回への通知の既定を文で言い、解除は範囲を固定したフォームから", async () => {
    render(<GarbageView owner={OWNER} data={pageData({ rows: seriesRows, windowEvents: seriesEvents })} />)
    await settle()
    const entry = within(screen.getByTestId("garbage-entries")).getByRole("listitem")
    expect(entry).toHaveTextContent("繰り返しのすべての回")
    expect(entry).toHaveTextContent("次の収集日: 11月12日（木）（明日）")
    expect(entry).toHaveTextContent("これから追加される回にも、前日 20:00 の通知を付けます")
    fireEvent.click(within(entry).getByRole("button", { name: "プラスチック（繰り返し）を解除" }))
    const form = await screen.findByTestId("garbage-purpose-form")
    expect(within(form).getByRole("button", { name: "分類を解除する", pressed: true })).toBeInTheDocument()
    // 範囲は固定（選ばせぬ）。通知は「変えない」が初期選択
    expect(within(form).queryByRole("group", { name: "変更する範囲" })).toBeNull()
    expect(within(form).getByRole("button", { name: "通知設定は変えない", pressed: true })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "解除する" }))
    })
    expect(submit).toHaveBeenCalledWith({
      op: "save",
      eventId: E1,
      scope: "series",
      action: "clear",
      garbageKind: null,
      reminder: "keep",
      seen: { series: SERIES_VERSION, event: null },
    })
  })

  it("通知の既定が「付けない」のシリーズはそう言う（対照）", async () => {
    const rows = [row({ id: P_SERIES, scope: "series", targetKey: SERIES, remindDefault: "none" })]
    render(<GarbageView owner={OWNER} data={pageData({ rows, windowEvents: seriesEvents })} />)
    await settle()
    expect(screen.getByTestId("garbage-entries")).toHaveTextContent("これから追加される回には、通知を自動で付けません")
  })

  it("予定が見つからぬ分類だけ整理でき、確かめられなんだ分類は「見つからぬ」と言わぬ", async () => {
    const rows = [
      ...seriesRows,
      row({ id: P_ORPHAN, scope: "event", targetKey: SINGLE, garbageKind: "古紙" }),
      row({ id: P_UNCHECKED, scope: "series", targetKey: "cal@example.invalid|rec", garbageKind: "資源" }),
    ]
    const data = pageData({
      rows,
      windowEvents: seriesEvents,
      unchecked: [purposeLookupKey("series", "cal@example.invalid|rec")],
    })
    render(<GarbageView owner={OWNER} data={data} />)
    await settle()

    const orphans = screen.getByTestId("garbage-orphans")
    expect(within(orphans).getAllByRole("listitem")).toHaveLength(1)
    expect(orphans).toHaveTextContent("古紙")
    expect(orphans).not.toHaveTextContent("資源")
    expect(screen.getByText(/同期中は、予定が一時的に見えなくなることがあります/)).toBeInTheDocument()

    // 確かめられなんだ分類は一覧の側に、変更・解除・整理の釦なしで出す
    const entries = screen.getByTestId("garbage-entries")
    const unchecked = within(entries).getByText("資源").closest("li")!
    expect(unchecked).toHaveTextContent("予定を確認できませんでした（予定が無い、とは限りません）")
    expect(within(unchecked).queryByRole("button")).toBeNull()

    // 整理は 2 段の確認の後に、分類の行 id だけを送る
    fireEvent.click(within(orphans).getByRole("button", { name: "予定が見つからない分類「古紙」を整理" }))
    expect(submit).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(within(orphans).getByRole("button", { name: "削除する" }))
    })
    expect(submit).toHaveBeenCalledWith({ op: "delete-orphan", purposeId: P_ORPHAN })
  })

  it("整理が conflict（予定が見つかった = 消しておらぬ）なら、その旨を出す", async () => {
    submit.mockResolvedValue({ status: "conflict" })
    const rows = [row({ id: P_ORPHAN, scope: "event", targetKey: SINGLE, garbageKind: "古紙" })]
    render(<GarbageView owner={OWNER} data={pageData({ rows })} />)
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "予定が見つからない分類「古紙」を整理" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "削除する" }))
    })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("上書きはしていません"))
  })
})

describe("R35: 保存の応答は、その操作を送った編集セッション（シートを開くたびに変わる）だけを閉じる", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }
  type Response = Awaited<ReturnType<typeof submitGarbageRequest>>
  const view = () => render(<GarbageView owner={OWNER} data={pageData({ rows: seriesRows, windowEvents: seriesEvents })} />)
  async function saveResourceOn(date: string) {
    fireEvent.click(screen.getByRole("button", { name: `${date}のプラスチックを変更` }))
    const form = await screen.findByTestId("garbage-purpose-form")
    fireEvent.click(within(form).getByRole("button", { name: "資源" }))
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: "分類を保存" }))
    })
    expect(submit).toHaveBeenCalledTimes(1)
  }
  async function closeSheet() {
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "閉じる" }))
    })
    await waitFor(() => expect(screen.queryByTestId("garbage-purpose-form")).toBeNull())
  }

  it("危険側: 先の保存の応答は、送信中に開いた別の回のシートを閉じず、選んだ内容を消さない", async () => {
    const pending = deferred<Response>()
    submit.mockReturnValueOnce(pending.promise)
    view()
    await settle()
    await saveResourceOn("11月12日（木）")
    // 応答を待つ間にシートを閉じ、別の回（11/19）の変更を開いて選び始める
    await closeSheet()
    fireEvent.click(screen.getByRole("button", { name: "11月19日（木）のプラスチックを変更" }))
    const second = await screen.findByTestId("garbage-purpose-form")
    fireEvent.click(within(second).getByRole("button", { name: "古紙" }))
    expect(within(second).getByRole("button", { name: "分類を保存" })).toBeDisabled()

    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    // 先の操作の確定は画面へ取り込む（取り直し）。開いておるシートは閉じず、選択も残る
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    await waitFor(() => expect(within(second).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    expect(screen.getByTestId("garbage-purpose-form")).toBe(second)
    expect(within(second).getByRole("button", { name: "古紙", pressed: true })).toBeInTheDocument()
    // 先の操作の結果は、このシートの中には出さぬ
    expect(within(screen.getByRole("dialog")).queryByText(/保存しました/)).toBeNull()
  })

  it("危険側: 閉じて同じ回を開き直したシートも、別の編集セッションとして扱う（古い応答で閉じぬ）", async () => {
    const pending = deferred<Response>()
    submit.mockReturnValueOnce(pending.promise)
    view()
    await settle()
    await saveResourceOn("11月12日（木）")
    await closeSheet()
    fireEvent.click(screen.getByRole("button", { name: "11月12日（木）のプラスチックを変更" }))
    const reopened = await screen.findByTestId("garbage-purpose-form")
    fireEvent.click(within(reopened).getByRole("button", { name: "古紙" }))

    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await waitFor(() => expect(within(reopened).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    expect(screen.getByTestId("garbage-purpose-form")).toBe(reopened)
    expect(within(reopened).getByRole("button", { name: "古紙", pressed: true })).toBeInTheDocument()
  })

  it("危険側: 先の保存が拒否されても、後から開いたシートに理由を出さぬ。理由は閉じた画面に、どの操作かを添えて出す", async () => {
    const pending = deferred<Response>()
    submit.mockReturnValueOnce(pending.promise)
    view()
    await settle()
    await saveResourceOn("11月12日（木）")
    await closeSheet()
    fireEvent.click(screen.getByRole("button", { name: "11月19日（木）のプラスチックを変更" }))
    const second = await screen.findByTestId("garbage-purpose-form")

    await act(async () => {
      pending.resolve({ error: "この予定は見つかりません。", failure: "rejected" })
    })
    await waitFor(() => expect(within(second).getByRole("button", { name: "分類を保存" })).toBeEnabled())
    expect(screen.getByTestId("garbage-purpose-form")).toBe(second)
    expect(within(screen.getByRole("dialog")).queryByText(/見つかりません/)).toBeNull()

    await closeSheet()
    expect(screen.getByRole("alert")).toHaveTextContent(
      "先に送った操作（「プラごみ」をごみの日（資源）にする（シリーズ全体））は保存できませんでした。この予定は見つかりません。",
    )
  })

  it("正常側: そのシートから送った保存の応答では、そのシートを閉じる（開き直しておらねば）", async () => {
    const pending = deferred<Response>()
    submit.mockReturnValueOnce(pending.promise)
    view()
    await settle()
    await saveResourceOn("11月12日（木）")
    expect(screen.getByTestId("garbage-purpose-form")).toBeInTheDocument()
    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await waitFor(() => expect(screen.queryByTestId("garbage-purpose-form")).toBeNull())
    expect(screen.getByText("保存しました。")).toBeInTheDocument()
  })
})

describe("GarbageView: 通知の状態（読むだけ）", () => {
  it("通知に未対応の環境ではそう言い、設定画面へ案内する。権限は求めぬ", async () => {
    // jsdom には serviceWorker / PushManager が無い = 未対応。VAPID を置いて「未対応」まで進める
    vi.stubEnv("NEXT_PUBLIC_VAPID_PUBLIC_KEY", "synthetic-public-key")
    const requestPermission = vi.fn()
    vi.stubGlobal("Notification", { permission: "default", requestPermission })
    render(<GarbageView owner={OWNER} data={pageData({})} />)
    await settle()
    const status = screen.getByTestId("garbage-notification-status")
    await waitFor(() => expect(status).toHaveAttribute("data-state", "unsupported"))
    expect(status).toHaveTextContent("この開き方では通知を受け取れません")
    expect(within(status).getByRole("link", { name: /設定の「通知」を開く/ })).toHaveAttribute("href", "/settings")
    expect(requestPermission).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})
