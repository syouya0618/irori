/**
 * 掃除の画面（CleaningView）の契約（要件台帳 B-01 / B-03 / B-04 / B-08、X-02 / X-03 / X-09）。
 *
 * 暦の前提: 2026-11-11 は水曜。2026-11-07 / 11-14 は土曜、11-15 は日曜。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ChoreOwner } from "@/lib/domain/chore-pending"
import type {
  CleaningHistoryRequest,
  CleaningHistoryResult,
  CleaningRequest,
  CleaningSaveSuccess,
} from "@/lib/domain/cleaning"
import type { CleaningLog, CleaningMarks, CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"

const { saveCleaning, loadCleaningHistory, refresh } = vi.hoisted(() => ({
  saveCleaning: vi.fn<(request: CleaningRequest) => Promise<CleaningSaveSuccess | ChoreSaveFailure>>(),
  loadCleaningHistory: vi.fn<(request: CleaningHistoryRequest) => Promise<CleaningHistoryResult>>(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/cleaning/actions", () => ({ saveCleaning, loadCleaningHistory }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import { CleaningView, type CleaningViewProps } from "../cleaning-view"

const OWNER: ChoreOwner = { userId: "c1000000-0000-4000-8000-000000000001", householdId: "c1000000-0000-4000-8000-0000000000a1" }
const DRAIN = "c2000000-0000-4000-8000-000000000001"
const YEARLY = "c2000000-0000-4000-8000-000000000002"
const LATER_YEARLY = "c2000000-0000-4000-8000-000000000003"
const MONTHLY = "c2000000-0000-4000-8000-000000000004"
const V1 = "2026-11-01T00:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.654321+00:00"
const WED = "2026-11-11"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function routine(over: Partial<CleaningRoutine> = {}): CleaningRoutine {
  return {
    id: DRAIN,
    name: "浴室の排水口",
    location: "浴室",
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-07",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    archived: false,
    updated_at: V1,
    created_at: V1,
    ...over,
  }
}
function log(over: Partial<CleaningLog> = {}): CleaningLog {
  return {
    id: "c3000000-0000-4000-8000-000000000001",
    routine_id: DRAIN,
    kind: "done",
    done_on: "2026-11-01",
    occurrence: null,
    note: null,
    voided_at: null,
    created_by: OWNER.userId,
    updated_at: V1,
    created_at: V1,
    ...over,
  }
}
const marksOf = (lastDoneOn: string | null, maxOccurrence: string | null = null): CleaningMarks => ({
  lastDoneOn,
  maxOccurrence,
  maxSkipOccurrence: null,
})

function propsOf(over: Partial<CleaningViewProps> = {}): CleaningViewProps {
  return {
    owner: OWNER,
    today: WED,
    routines: [routine()],
    marks: {},
    logs: [],
    unreadableRoutines: 0,
    routinesTruncated: false,
    historyFailed: false,
    historyTruncated: false,
    ...over,
  }
}
function view(over: Partial<CleaningViewProps> = {}) {
  return render(<CleaningView {...propsOf(over)} />)
}

const dueSection = () => screen.getByRole("region", { name: "今日・今週やること" })
const restSection = () => screen.getByRole("region", { name: "このあとの項目" })
const completeBox = (name: string) => screen.getByRole("checkbox", { name: `${name}を完了にする` })
async function ready(name = "浴室の排水口") {
  await waitFor(() => expect(completeBox(name)).toBeEnabled())
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  // 端末の日付を、画面の今日（サーバー由来の WED）と同じ 2026-11-11 12:00 JST にする。
  // タイマーは実物のまま、Date だけを固定する（完了の実施日の固定は端末の日付との一致を見る）
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
})
afterEach(async () => {
  // 端末の控えの読み込み（マウント後の非同期の state 更新）を流し切ってから片付ける
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("B-01 最初に「今日・今週やること」", () => {
  const routines = [
    routine({ id: MONTHLY, name: "冷蔵庫の拭き掃除", location: null, cadence_unit: "month", anchor_date: "2026-11-30" }),
    // 年 1 回・今週の金曜が期限
    routine({ id: YEARLY, name: "年に一度の換気扇", cadence_unit: "year", anchor_date: "2025-11-13", resume_floor: "2026-01-01" }),
    // 対照: 年 1 回・来月が期限
    routine({ id: LATER_YEARLY, name: "年末の大掃除", cadence_unit: "year", anchor_date: "2025-12-28", resume_floor: "2026-01-01" }),
    routine(),
  ]

  it("最初の区画が「今日・今週やること」で、期限超過を含めて期限の近い順に並ぶ", () => {
    const { container } = view({ routines })
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent)
    expect(headings[0]).toBe("今日・今週やること")
    const due = within(dueSection()).getAllByTestId("cleaning-item")
    expect(due.map((item) => item.querySelector("p")?.textContent)).toEqual(["浴室の排水口", "年に一度の換気扇"])
    // 期限超過は日数を文で言う（色だけにせぬ）
    expect(within(due[0]).getByText("期限を4日過ぎています")).toBeInTheDocument()
    expect(within(due[1]).getByText("今週")).toBeInTheDocument()
  })

  it("年 1 回の項目でも、今週が期限なら「今日・今週やること」に出る（周期の絞り込みに依らぬ）", async () => {
    view({ routines })
    await ready()
    for (const filter of ["すべて", "週ごと", "月ごと", "年ごと"]) {
      await click(screen.getByRole("button", { name: filter }))
      expect(within(dueSection()).getByText("年に一度の換気扇")).toBeInTheDocument()
      expect(within(dueSection()).getByText("浴室の排水口")).toBeInTheDocument()
    }
  })

  it("対照: 来月が期限の年次項目は今週に出ず、絞り込みは下の区画だけに効く", async () => {
    view({ routines })
    await ready()
    expect(within(dueSection()).queryByText("年末の大掃除")).not.toBeInTheDocument()
    expect(within(restSection()).getByText("年末の大掃除")).toBeInTheDocument()
    expect(within(restSection()).getByText("冷蔵庫の拭き掃除")).toBeInTheDocument()

    await click(screen.getByRole("button", { name: "月ごと" }))
    expect(screen.getByRole("button", { name: "月ごと" })).toHaveAttribute("aria-pressed", "true")
    expect(within(restSection()).queryByText("年末の大掃除")).not.toBeInTheDocument()
    expect(within(restSection()).getByText("冷蔵庫の拭き掃除")).toBeInTheDocument()

    await click(screen.getByRole("button", { name: "週ごと" }))
    expect(within(restSection()).getByText("週ごとの項目は、このあとの予定にはありません。")).toBeInTheDocument()
  })
})

describe("B-03 前回・日数・次回・期限超過", () => {
  it("履歴が無い項目は「未記録」（基準日・作成日を実施日として出さぬ）", () => {
    view()
    const item = within(dueSection()).getByTestId("cleaning-item")
    expect(within(item).getByText("未記録")).toBeInTheDocument()
    expect(item.textContent).not.toContain("11月7日（土）（")
  })

  it("対照: 履歴が在れば前回実施日と暦日数、次回予定を出す", () => {
    // 11/1 に 10/31 の回を実施 → 今の回は 11/7（4 日超過）
    view({
      routines: [routine({ anchor_date: "2026-10-31" })],
      marks: { [DRAIN]: marksOf("2026-11-01", "2026-10-31") },
    })
    const item = within(dueSection()).getByTestId("cleaning-item")
    expect(within(item).getByText("11月1日（日）（10日前）")).toBeInTheDocument()
    expect(within(item).queryByText("未記録")).not.toBeInTheDocument()
    expect(within(item).getByText("期限を4日過ぎています")).toBeInTheDocument()
    expect(item.querySelectorAll("p")[1]).toHaveTextContent("浴室・毎週土曜")
  })

  it("期限前の項目は次回予定と残り日数を出し、延期・休止は印で示す", () => {
    view({
      routines: [
        routine({ postponed_occurrence: "2026-11-07", postponed_until: "2026-11-13" }),
        routine({ id: MONTHLY, name: "窓", paused_at: V1 }),
      ],
    })
    const postponed = within(dueSection()).getByTestId("cleaning-item")
    expect(within(postponed).getByText("11月13日（金）（2日後）")).toBeInTheDocument()
    expect(within(postponed).getByText("延期中")).toBeInTheDocument()
    expect(within(postponed).queryByText(/期限を/)).not.toBeInTheDocument()
    const paused = within(restSection()).getByTestId("cleaning-item")
    expect(within(paused).getByText("休止中")).toBeInTheDocument()
    // 休止中は 1 タップ完了を受けぬ
    expect(completeBox("窓")).toBeDisabled()
  })
})

describe("B-04 1 タップ完了と直後の取り消し", () => {
  it("完了 → 取り消し: 回の鍵は「見ていた回」として送り、取り消しはサーバーが返した行の版で送る", async () => {
    saveCleaning.mockImplementation(async (request) => {
      if (request.op === "close") {
        return { status: "saved", log: log({ id: request.id, done_on: WED, occurrence: "2026-11-07", updated_at: V2 }) }
      }
      return { status: "saved" }
    })
    view()
    await ready()
    expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument()

    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("「浴室の排水口」を完了にしました。"))
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    const sent = saveCleaning.mock.calls[0][0]
    expect(sent).toEqual({
      op: "close",
      id: expect.stringMatching(UUID),
      routineId: DRAIN,
      routineVersion: V1,
      kind: "done",
      seenOccurrence: "2026-11-07",
      // 実施日は最初の押下で固定する（画面の今日 = 端末の日付）
      pressedOn: WED,
    })
    expect(refresh).toHaveBeenCalledTimes(1)

    // 取り消しの帯は一覧の下に出る（上に出すと項目が押し下がる）
    const undo = screen.getByTestId("cleaning-inline-undo")
    const list = within(dueSection()).getByRole("list")
    expect(list.compareDocumentPosition(undo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await click(within(undo).getByRole("button", { name: "直前の記録を取り消す" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toEqual({ op: "log_void", id: sent.id, version: V2 })
    await waitFor(() => expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument())
    expect(screen.getByRole("status")).toHaveTextContent("記録を取り消しました。")
  })

  it("家族が先に同じ回を記録しておれば、1 件のままと伝え、他人の記録の取り消しは出さぬ", async () => {
    saveCleaning.mockResolvedValue({ status: "replayed", detail: "already_closed", log: log({ created_by: "someone" }) })
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("先に記録されていました"))
    expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument()
  })

  it("画面が古く回が変わっておった時は、記録していないと伝える", async () => {
    saveCleaning.mockResolvedValue({ status: "conflict", detail: "occurrence_moved" })
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("記録はしていません"))
    expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument()
  })

  it("拒否された時は理由を出し、完了したとは表示せぬ", async () => {
    saveCleaning.mockResolvedValue({ error: "休止中の項目です。再開してから操作してください。", failure: "rejected" })
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("休止中の項目です。"))
    expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    expect(completeBox("浴室の排水口")).toBeEnabled()
  })
})

describe("X-09 結果不明", () => {
  it("応答を失ったら新しい操作を止め、同じ操作 ID・同じ内容で確かめ直す", async () => {
    saveCleaning.mockRejectedValueOnce(new Error("synthetic lost response"))
    view({ routines: [routine(), routine({ id: MONTHLY, name: "窓", anchor_date: "2026-11-21" })] })
    await ready()
    await click(completeBox("浴室の排水口"))

    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(screen.getByText("「浴室の排水口」を完了")).toBeInTheDocument()
    // 完了したとは表示せぬ・他の項目の操作も止める
    expect(screen.queryByTestId("cleaning-inline-undo")).not.toBeInTheDocument()
    expect(completeBox("窓")).toBeDisabled()
    expect(saveCleaning).toHaveBeenCalledTimes(1)

    saveCleaning.mockImplementationOnce(async (request) => ({
      status: "replayed",
      log: log({ id: request.op === "close" ? request.id : "", done_on: WED, occurrence: "2026-11-07", updated_at: V2 }),
    }))
    await click(confirm)
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toEqual(saveCleaning.mock.calls[0][0])
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("完了にしました"))
    expect(completeBox("窓")).toBeEnabled()
  })
})

describe("X-02 / V-UI 表示の規約", () => {
  it("長い日本語の名前・場所は折り返す（横へはみ出す指定を持たぬ）", () => {
    const long = "浴室の排水口と洗い場の床と壁と天井と換気扇のカバーと鏡のうろこ取りをまとめて行う大掃除の項目です"
    view({ routines: [routine({ name: long, location: "二階の奥のいちばん広い浴室" })] })
    const name = screen.getByText(long)
    expect(name.className).toMatch(/\bbreak-words\b/)
    expect(name.className).not.toMatch(/\b(truncate|whitespace-nowrap)\b/)
    expect(name.parentElement?.className).toMatch(/\bmin-w-0\b/)
    const place = screen.getByText(/二階の奥のいちばん広い浴室/)
    expect(place.closest("p")?.className).toMatch(/\bbreak-words\b/)
  })

  it("押せる要素は 44px 以上の指定を持ち、transition-all・絵文字を使わぬ", async () => {
    const { container } = view({
      routines: [routine(), routine({ id: MONTHLY, name: "窓", anchor_date: "2026-12-05" }), routine({ id: YEARLY, name: "古い項目", archived: true })],
    })
    await ready()
    await click(screen.getByRole("button", { name: /アーカイブ済み/ }))
    const pressables = [...container.querySelectorAll<HTMLElement>("button, a[href]")]
    expect(pressables.length).toBeGreaterThan(8)
    for (const element of pressables) {
      expect(element.className, element.textContent ?? "").toMatch(/\b(min-h-11|size-11|touch-target|min-h-12)\b/)
      expect(element.className).not.toContain("transition-all")
    }
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
    for (const icon of container.querySelectorAll("svg")) expect(icon).toHaveAttribute("aria-hidden", "true")
  })

  it("対照: 44px の検査は、指定を持たぬ釦を実際に見つけられる", () => {
    const probe = document.createElement("button")
    probe.className = "h-8 px-2"
    expect(probe.className).not.toMatch(/\b(min-h-11|size-11|touch-target|min-h-12)\b/)
  })
})

describe("X-03 空・読めぬ項目・アーカイブ", () => {
  it("項目が無ければ空の案内と追加の釦を出す", () => {
    view({ routines: [] })
    expect(screen.getByText("掃除の項目がまだありません")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "最初の項目を追加" })).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "このあとの項目" })).not.toBeInTheDocument()
  })

  it("対照: 読めぬ項目が在る時は「まだありません」と言わず、件数を伝える", () => {
    view({ routines: [], unreadableRoutines: 2 })
    expect(screen.queryByText("掃除の項目がまだありません")).not.toBeInTheDocument()
    expect(screen.getByText("表示できる項目がありません")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("表示できない項目が 2 件あります")
  })

  it("期限の近い項目が無ければ、その旨を出す（空の一覧にせぬ）", () => {
    view({ routines: [routine({ anchor_date: "2026-12-05" })] })
    expect(within(dueSection()).getByText("今日・今週が期限の掃除はありません。")).toBeInTheDocument()
    expect(within(restSection()).getByText("浴室の排水口")).toBeInTheDocument()
  })

  it("アーカイブ済みは一覧から外し、畳んだ区画から元に戻せる", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const archived = routine({ id: YEARLY, name: "古い項目", archived: true, updated_at: V2 })
    view({ routines: [routine(), archived] })
    await ready()
    expect(screen.queryByText("古い項目")).not.toBeInTheDocument()
    await click(screen.getByRole("button", { name: "アーカイブ済み（1件）" }))
    await click(screen.getByRole("button", { name: "古い項目を元に戻す" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "routine", id: YEARLY, version: V2, archived: false })
  })

  it("他端末の変更が反映されるタイミングを文で示す", () => {
    view()
    expect(screen.getByText(/ほかの端末での変更は、この画面に戻ったときと、開いている間は約60秒ごとに反映されます。/)).toBeInTheDocument()
  })
})

describe("B-02 / B-08 作成フォームとテンプレート", () => {
  async function openCreate() {
    view({ routines: [] })
    await waitFor(() => expect(screen.getByRole("button", { name: "最初の項目を追加" })).toBeEnabled())
    await click(screen.getByRole("button", { name: "最初の項目を追加" }))
    return screen.findByRole("dialog")
  }

  it("テンプレートは入力欄を埋めるだけで、保存も実施の記録もしない", async () => {
    const dialog = await openCreate()
    await click(within(dialog).getByRole("button", { name: "エアコンのフィルター" }))
    expect(within(dialog).getByLabelText("名前")).toHaveValue("エアコンのフィルター")
    expect(within(dialog).getByLabelText("場所（任意）")).toHaveValue("リビング")
    expect(within(dialog).getByRole("button", { name: "月" })).toHaveAttribute("aria-pressed", "true")
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("実施した日から1ヶ月後")
    expect(saveCleaning).not.toHaveBeenCalled()
    expect(within(dialog).getByText(/保存するまで登録されず、実施の記録も作りません/)).toBeInTheDocument()
  })

  it("方式・単位・間隔・基準日を言葉で選び、読み下しを確かめてから追加する", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openCreate()
    // 初期値: 決まった曜日・毎週・今日（水曜）
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("毎週水曜")

    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "  レンジフード  " } })
    await click(within(dialog).getByRole("button", { name: "月" }))
    fireEvent.change(within(dialog).getByLabelText("基準にする日"), { target: { value: "2026-01-31" } })
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("毎月31日（無い月は月末）")
    // 今日より前の予定日は数えぬ: 最初の予定日は 11/30
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("最初の予定日: 11月30日（月）")
    fireEvent.change(within(dialog).getByLabelText("間隔"), { target: { value: "3" } })
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("3ヶ月ごとの31日（無い月は月末）")

    await click(within(dialog).getByRole("button", { name: /実施してから一定期間後/ }))
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("実施した日から3ヶ月後")
    expect(within(dialog).getByLabelText("最初の予定日")).toHaveValue("2026-01-31")

    await click(within(dialog).getByRole("button", { name: "この内容で追加" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({
      op: "routine",
      id: expect.stringMatching(UUID),
      version: null,
      name: "レンジフード",
      location: null,
      cadenceUnit: "month",
      cadenceInterval: 3,
      scheduleMode: "after_done",
      anchorDate: "2026-01-31",
      archived: false,
    })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("「レンジフード」を追加しました。"))
  })

  it("名前が空なら送らず、理由を出す", async () => {
    const dialog = await openCreate()
    await click(within(dialog).getByRole("button", { name: "この内容で追加" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("名前を入力してください。")
    expect(saveCleaning).not.toHaveBeenCalled()
  })

  it("単位を変えた時、上限を越える間隔は持ち越さぬ", async () => {
    const dialog = await openCreate()
    fireEvent.change(within(dialog).getByLabelText("間隔"), { target: { value: "30" } })
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("30週間ごとの水曜")
    await click(within(dialog).getByRole("button", { name: "年" }))
    expect(within(dialog).getByLabelText("間隔")).toHaveValue("1")
    expect(within(dialog).getByTestId("cadence-reading")).toHaveTextContent("毎年11月11日")
  })
})

describe("B-04 項目の詳細（スキップ・延期・過去日の記録・履歴・休止）", () => {
  const history = [
    log({ id: "c3000000-0000-4000-8000-000000000011", done_on: "2026-11-01", occurrence: "2026-10-31", note: "念入りに", updated_at: V2 }),
    log({ id: "c3000000-0000-4000-8000-000000000012", done_on: "2026-10-20", occurrence: null }),
    log({ id: "c3000000-0000-4000-8000-000000000013", routine_id: MONTHLY, done_on: "2026-11-05" }),
  ]
  async function openDetail(over: Partial<CleaningViewProps> = {}) {
    view({
      routines: [routine({ anchor_date: "2026-10-31" })],
      marks: { [DRAIN]: marksOf("2026-11-01", "2026-10-31") },
      logs: history,
      ...over,
    })
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    return screen.findByRole("dialog")
  }

  it("スキップは実施の記録と分けて送る（次回の予定日を先に示す）", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail()
    expect(within(dialog).getByText(/スキップすると、実施の記録は付けずに次回（11月14日（土））へ進みます。/)).toBeInTheDocument()
    await click(within(dialog).getByRole("button", { name: "今回はスキップ" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "close", kind: "skip", routineId: DRAIN, seenOccurrence: "2026-11-07" })
    expect(saveCleaning.mock.calls[0][0]).not.toHaveProperty("doneOn")
  })

  it("延期は現在の回の期限だけ。選べる日付は明日から次の予定日の前日まで", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail()
    const date = within(dialog).getByLabelText(/今回の期限だけを動かします/)
    expect(date).toHaveAttribute("min", "2026-11-12")
    expect(date).toHaveAttribute("max", "2026-11-13")
    expect(within(dialog).getByRole("button", { name: "この日まで延期" })).toBeDisabled()
    fireEvent.change(date, { target: { value: "2026-11-13" } })
    await click(within(dialog).getByRole("button", { name: "この日まで延期" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({
      op: "postpone",
      id: DRAIN,
      version: V1,
      seenOccurrence: "2026-11-07",
      until: "2026-11-13",
    })
  })

  it("過去日の記録: 未来日は送らずに理由を出し、過去日は回の鍵なしで送る", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail()
    const date = within(dialog).getByLabelText("実施した日")
    expect(date).toHaveAttribute("max", WED)
    expect(date).toHaveValue("2026-11-10")
    expect(within(dialog).getByText(/今回の分は完了になりません/)).toBeInTheDocument()
    fireEvent.change(date, { target: { value: "2026-11-12" } })
    await click(within(dialog).getByRole("button", { name: "この日の実施を記録" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("未来の日付は実施日として記録できません")
    expect(saveCleaning).not.toHaveBeenCalled()

    fireEvent.change(date, { target: { value: "2026-11-09" } })
    await click(within(dialog).getByRole("button", { name: "この日の実施を記録" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({
      op: "backfill",
      id: expect.stringMatching(UUID),
      routineId: DRAIN,
      routineVersion: V1,
      doneOn: "2026-11-09",
      note: null,
    })
  })

  it("履歴はこの項目の分だけを新しい順に並べ、訂正と取り消し（2 段）を版つきで送る", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail()
    const rows = within(dialog).getAllByTestId("cleaning-log")
    expect(rows.map((row) => row.querySelector("p")?.textContent)).toEqual([
      "11月1日（日） に実施",
      "10月20日（火） に実施（あとから記録）",
    ])
    expect(within(rows[0]).getByText("念入りに")).toBeInTheDocument()

    await click(within(rows[0]).getByRole("button", { name: "11月1日（日） に実施を取り消す" }))
    // 1 段目では送らぬ
    expect(saveCleaning).not.toHaveBeenCalled()
    await click(within(dialog).getByRole("button", { name: "この記録を取り消す" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({ op: "log_void", id: history[0].id, version: V2 })
  })

  it("履歴の訂正は実施日とメモを送り、未来日は送らぬ", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail()
    const row = within(dialog).getAllByTestId("cleaning-log")[0]
    await click(within(row).getByRole("button", { name: "11月1日（日） に実施を訂正" }))
    const date = within(row).getByLabelText("実施した日")
    fireEvent.change(date, { target: { value: "2026-11-20" } })
    await click(within(row).getByRole("button", { name: "訂正を保存" }))
    expect(saveCleaning).not.toHaveBeenCalled()
    fireEvent.change(date, { target: { value: "2026-11-02" } })
    fireEvent.change(within(row).getByLabelText("メモ（任意）"), { target: { value: "" } })
    await click(within(row).getByRole("button", { name: "訂正を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({
      op: "log_update",
      id: history[0].id,
      version: V2,
      doneOn: "2026-11-02",
      note: null,
    })
  })

  it("履歴を読めなんだ時は「まだ記録がありません」と言わぬ", async () => {
    const dialog = await openDetail({ logs: [], historyFailed: true })
    expect(within(dialog).getByRole("alert")).toHaveTextContent("履歴を読み込めませんでした。履歴がないとは限りません。")
    expect(within(dialog).queryByText("まだ記録がありません。")).not.toBeInTheDocument()
  })

  it("休止・アーカイブ（2 段）・編集を送れる", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    let dialog = await openDetail()
    await click(within(dialog).getByRole("button", { name: "休止する" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({ op: "state", id: DRAIN, version: V1, action: "pause" })
    cleanup()
    localStorage.clear()

    dialog = await openDetail()
    await click(within(dialog).getByRole("button", { name: "アーカイブ" }))
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    await click(within(dialog).getByRole("button", { name: "アーカイブする" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toMatchObject({ op: "routine", id: DRAIN, version: V1, archived: true, name: "浴室の排水口" })
    cleanup()
    localStorage.clear()

    dialog = await openDetail()
    await click(within(dialog).getByRole("button", { name: "編集" }))
    expect(within(dialog).getByLabelText("名前")).toHaveValue("浴室の排水口")
    // 編集ではテンプレートを出さぬ
    expect(within(dialog).queryByText("テンプレートから入力する")).not.toBeInTheDocument()
    fireEvent.change(within(dialog).getByLabelText("間隔"), { target: { value: "2" } })
    expect(within(dialog).getByText(/周期を変えると延期は取り消され/)).toBeInTheDocument()
    await click(within(dialog).getByRole("button", { name: "変更を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(3))
    expect(saveCleaning.mock.calls[2][0]).toMatchObject({ op: "routine", id: DRAIN, version: V1, cadenceInterval: 2, archived: false })
  })
})

const V3 = "2026-11-11T05:30:00.111222+00:00"

describe("R33 / R37 開いたままの編集は、背景で版が進んでも「開いた時点の入力 + 最新の版」を送らぬ", () => {
  it("項目の編集: 家族が周期を変えた後は保存を止め、最新を読み込み直してから保存する", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const { rerender } = view()
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "編集" }))
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "排水口（改）" } })
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()

    // 定期再取得: 家族が「2 週間ごと」へ変えた行（新しい版）へ props が差し替わる
    rerender(<CleaningView {...propsOf({ routines: [routine({ cadence_interval: 2, updated_at: V2 })] })} />)

    // 入力は開いた時のまま（毎週）。版だけが進んだことを告げ、保存させぬ
    expect(within(dialog).getByLabelText("間隔")).toHaveValue("1")
    expect(within(dialog).getByLabelText("名前")).toHaveValue("排水口（改）")
    expect(within(dialog).getByRole("alert")).toHaveTextContent("他の端末でこの項目が変更されました")
    const submit = within(dialog).getByRole("button", { name: "変更を保存" })
    expect(submit).toBeDisabled()
    await click(submit)
    // Enter での送信も止める
    const form = submit.closest("form")
    expect(form).not.toBeNull()
    await act(async () => {
      fireEvent.submit(form as HTMLFormElement)
    })
    expect(saveCleaning).not.toHaveBeenCalled()

    // 最新を読み込むと、入力は家族の変更後の値になり、版も最新になる
    await click(within(dialog).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    expect(within(dialog).getByLabelText("間隔")).toHaveValue("2")
    expect(within(dialog).getByLabelText("名前")).toHaveValue("浴室の排水口")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "排水口（改）" } })
    await click(within(dialog).getByRole("button", { name: "変更を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    // 家族の周期（2 週間ごと）を保ったまま、名前だけが変わる
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({
      op: "routine",
      id: DRAIN,
      version: V2,
      name: "排水口（改）",
      cadenceInterval: 2,
    })
  })

  it("対照: 背景で同じ版の行が届いただけ（内容も版も同じ）なら、入力を保ったまま保存できる", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const { rerender } = view()
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "編集" }))
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "排水口（改）" } })
    rerender(<CleaningView {...propsOf({ routines: [routine()] })} />)
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
    await click(within(dialog).getByRole("button", { name: "変更を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "routine", version: V1, name: "排水口（改）", cadenceInterval: 1 })
  })

  it("履歴の訂正: 家族が同じ記録を直した後は保存を止め、最新の内容で開き直してから保存する", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    const entry = log({ id: "c3000000-0000-4000-8000-000000000011", done_on: "2026-11-01", occurrence: "2026-10-31", updated_at: V2 })
    const base = { routines: [routine({ anchor_date: "2026-10-31" })], marks: { [DRAIN]: marksOf("2026-11-01", "2026-10-31") } }
    const { rerender } = view({ ...base, logs: [entry] })
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    const row = () => within(dialog).getByTestId("cleaning-log")
    await click(within(row()).getByRole("button", { name: "11月1日（日） に実施を訂正" }))
    fireEvent.change(within(row()).getByLabelText("メモ（任意）"), { target: { value: "念入りに" } })

    // 定期再取得: 家族が実施日を 11/02 へ直した行（新しい版）へ差し替わる
    rerender(<CleaningView {...propsOf({ ...base, logs: [{ ...entry, done_on: "2026-11-02", updated_at: V3 }] })} />)

    expect(within(row()).getByText("11月2日（月） に実施")).toBeInTheDocument()
    expect(within(row()).getByRole("alert")).toHaveTextContent("他の端末でこの記録が変更されました")
    // 入力は開いた時のまま（11/01）。保存させぬ
    expect(within(row()).getByLabelText("実施した日")).toHaveValue("2026-11-01")
    const save = within(row()).getByRole("button", { name: "訂正を保存" })
    expect(save).toBeDisabled()
    await click(save)
    expect(saveCleaning).not.toHaveBeenCalled()

    await click(within(row()).getByRole("button", { name: "最新の内容で訂正し直す" }))
    expect(within(row()).queryByRole("alert")).not.toBeInTheDocument()
    expect(within(row()).getByLabelText("実施した日")).toHaveValue("2026-11-02")
    fireEvent.change(within(row()).getByLabelText("メモ（任意）"), { target: { value: "念入りに" } })
    await click(within(row()).getByRole("button", { name: "訂正を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    // 家族が直した実施日（11/02）を保ち、開き直した時点の版で送る
    expect(saveCleaning.mock.calls[0][0]).toEqual({
      op: "log_update",
      id: entry.id,
      version: V3,
      doneOn: "2026-11-02",
      note: "念入りに",
    })
  })
})

describe("R19 完了の実施日は最初の押下で固定する", () => {
  it("応答を失った完了を後日確かめ直しても、最初に押した日を固定した同じ内容を送る", async () => {
    saveCleaning.mockRejectedValueOnce(new Error("synthetic lost response"))
    const { rerender } = view()
    await ready()
    await click(completeBox("浴室の排水口"))
    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "close", kind: "done", pressedOn: WED })

    // 翌朝に開き直した（端末の日付も、画面の今日も 11/12）
    vi.setSystemTime(new Date("2026-11-12T00:00:00.000Z"))
    rerender(<CleaningView {...propsOf({ today: "2026-11-12" })} />)
    saveCleaning.mockImplementationOnce(async (request) => ({
      status: "saved",
      log: log({ id: request.op === "close" ? request.id : "", done_on: WED, occurrence: "2026-11-07", updated_at: V2 }),
    }))
    await click(confirm)
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toEqual(saveCleaning.mock.calls[0][0])
    expect(saveCleaning.mock.calls[1][0]).toMatchObject({ pressedOn: WED })
    // 記録した実施日が今日と違うことを告げる（黙って別の日で残さぬ）
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "「浴室の排水口」を完了にしました。実施日は11月11日（水）で記録しました。違う時は、項目の詳細の履歴から直せます。",
      ),
    )
  })

  it("対照: 記録した実施日が画面の今日と同じなら、日付の注記は出さぬ", async () => {
    saveCleaning.mockImplementation(async (request) => ({
      status: "saved",
      log: log({ id: request.op === "close" ? request.id : "", done_on: WED, occurrence: "2026-11-07", updated_at: V2 }),
    }))
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("「浴室の排水口」を完了にしました。"))
    expect(screen.getByRole("status")).not.toHaveTextContent("実施日は")
  })

  it("画面の今日が端末の日付と食い違う時（日付をまたいで開いたままの画面）は固定せず、サーバーに決めさせる", async () => {
    saveCleaning.mockImplementation(async (request) => ({
      status: "saved",
      log: log({ id: request.op === "close" ? request.id : "", done_on: "2026-11-12", occurrence: "2026-11-07", updated_at: V2 }),
    }))
    // 画面は 11/11 に描いたまま。端末は 11/12 の朝
    vi.setSystemTime(new Date("2026-11-11T23:30:00.000Z"))
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "close", kind: "done", pressedOn: null })
    // サーバーが記録した日（11/12）を告げる
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("実施日は11月12日（木）で記録しました。"))
  })

  it("詳細からの完了も実施日を固定し、スキップは実施日を持たぬ", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    let dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "今日やったことにする" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toMatchObject({ op: "close", kind: "done", pressedOn: WED })
    cleanup()
    localStorage.clear()

    view()
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "今回はスキップ" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toMatchObject({ op: "close", kind: "skip", pressedOn: null })
  })
})

describe("R18 先の回を続けて閉じた後は、押せぬ理由を出す（DB の拒否を待たぬ）", () => {
  // 実施基準・週 1。今日完了し、11/18・11/25 の回をスキップ済み → 今の回の鍵は 12/02（上限は 11/25）
  const limited = {
    routines: [routine({ schedule_mode: "after_done", anchor_date: WED })],
    marks: { [DRAIN]: { lastDoneOn: WED, maxOccurrence: "2026-11-25", maxSkipOccurrence: "2026-11-25" } },
  }

  it("1 タップ完了を無効にし、一覧と詳細に理由と代わりの手段を出す", async () => {
    view({ ...limited, routines: [...limited.routines, routine({ id: MONTHLY, name: "窓", anchor_date: "2026-11-21" })] })
    await ready("窓")
    expect(completeBox("浴室の排水口")).toBeDisabled()
    const item = within(restSection()).getAllByTestId("cleaning-item")[1]
    expect(within(item).getByText("先の回まで記録済みです。次の予定日が近づくと、また完了にできます。")).toBeInTheDocument()

    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByTestId("cleaning-close-limit")).toHaveTextContent("次の予定日が近づくまで今回の分は記録できません")
    expect(within(dialog).getByTestId("cleaning-close-limit")).toHaveTextContent("過去にやった日を記録")
    expect(within(dialog).queryByRole("button", { name: "今日やったことにする" })).not.toBeInTheDocument()
    expect(within(dialog).queryByRole("button", { name: "今回はスキップ" })).not.toBeInTheDocument()
    // 今日の実施は、回を閉じぬ記録として残せる
    expect(within(dialog).getByRole("button", { name: "この日の実施を記録" })).toBeEnabled()
    expect(saveCleaning).not.toHaveBeenCalled()
  })

  it("対照: 上限の内側（先の回を 1 回だけスキップ）なら、完了もスキップもできる", async () => {
    view({
      routines: limited.routines,
      marks: { [DRAIN]: { lastDoneOn: WED, maxOccurrence: "2026-11-18", maxSkipOccurrence: "2026-11-18" } },
    })
    await ready()
    expect(completeBox("浴室の排水口")).toBeEnabled()
    expect(screen.queryByText(/先の回まで記録済みです/)).not.toBeInTheDocument()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).queryByTestId("cleaning-close-limit")).not.toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "今日やったことにする" })).toBeEnabled()
  })
})

describe("R15 / R47 一覧（世帯全体の直近）から外れた記録も、項目ごとに読み足して訂正・取り消しできる", () => {
  const OLD = "c3000000-0000-4000-8000-000000000091"
  const oldLog = log({
    id: OLD,
    done_on: "2026-01-10",
    occurrence: null,
    note: "年始に",
    created_at: "2026-01-10T01:00:00.000001+00:00",
    updated_at: V2,
  })
  const base = {
    routines: [routine({ anchor_date: "2026-10-31" })],
    marks: { [DRAIN]: marksOf("2026-01-10", null) },
  }
  async function openDetail(over: Partial<CleaningViewProps> = {}) {
    view({ ...base, ...over })
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    return screen.findByRole("dialog")
  }

  it("一覧に無い前回の記録を読み足し、取り消しを版つきで送れる（項目名も言う）", async () => {
    loadCleaningHistory.mockResolvedValue({ logs: [oldLog], next: null })
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail({ historyTruncated: true })
    // 前回実施日は要約から出ておる（1/10）が、一覧には記録が無い
    expect(within(dialog).getByText(/古い記録は下の釦で読み込めます/)).toBeInTheDocument()
    expect(within(dialog).queryByTestId("cleaning-log")).not.toBeInTheDocument()

    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    const row = await within(dialog).findByTestId("cleaning-log")
    expect(loadCleaningHistory).toHaveBeenCalledTimes(1)
    expect(loadCleaningHistory).toHaveBeenCalledWith({ routineId: DRAIN, before: null })
    expect(within(row).getByText("1月10日（土） に実施（あとから記録）")).toBeInTheDocument()
    expect(within(row).getByText("年始に")).toBeInTheDocument()
    // これより古い記録は無い → 釦を畳み、全てと告げる
    expect(within(dialog).queryByRole("button", { name: "古い記録をさらに表示" })).not.toBeInTheDocument()
    expect(within(dialog).getByText("この項目の記録は、これで全てです。")).toBeInTheDocument()

    await click(within(row).getByRole("button", { name: "1月10日（土） に実施（あとから記録）を取り消す" }))
    await click(within(dialog).getByRole("button", { name: "この記録を取り消す" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({ op: "log_void", id: OLD, version: V2 })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("「浴室の排水口」の記録を取り消しました。"))
  })

  it("読み足した記録の訂正も、その行の版で送れる", async () => {
    loadCleaningHistory.mockResolvedValue({ logs: [oldLog], next: null })
    saveCleaning.mockResolvedValue({ status: "saved" })
    const dialog = await openDetail({ historyTruncated: true })
    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    const row = await within(dialog).findByTestId("cleaning-log")
    await click(within(row).getByRole("button", { name: "1月10日（土） に実施（あとから記録）を訂正" }))
    fireEvent.change(within(row).getByLabelText("実施した日"), { target: { value: "2026-01-11" } })
    await click(within(row).getByRole("button", { name: "訂正を保存" }))
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(1))
    expect(saveCleaning.mock.calls[0][0]).toEqual({ op: "log_update", id: OLD, version: V2, doneOn: "2026-01-11", note: "年始に" })
  })

  it("続きは、読み込み済みの最も古い記録の位置から読み、サーバーが返した位置で読み進める", async () => {
    const listed = log({ id: "c3000000-0000-4000-8000-000000000092", done_on: "2026-11-01", created_at: "2026-11-01T02:00:00.500000+00:00" })
    const middle = log({ id: "c3000000-0000-4000-8000-000000000093", done_on: "2026-06-01", created_at: "2026-06-01T02:00:00.000000+00:00" })
    const next = { createdAt: "2026-06-01T02:00:00.000000+00:00", id: middle.id }
    loadCleaningHistory.mockResolvedValueOnce({ logs: [middle], next }).mockResolvedValueOnce({ logs: [oldLog], next: null })
    const dialog = await openDetail({ historyTruncated: true, logs: [listed] })
    expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(1)

    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    await waitFor(() => expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(2))
    expect(loadCleaningHistory).toHaveBeenLastCalledWith({
      routineId: DRAIN,
      before: { createdAt: "2026-11-01T02:00:00.500000+00:00", id: listed.id },
    })

    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    await waitFor(() => expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(3))
    expect(loadCleaningHistory).toHaveBeenLastCalledWith({ routineId: DRAIN, before: next })
    expect(within(dialog).getAllByTestId("cleaning-log").map((row) => row.querySelector("p")?.textContent)).toEqual([
      "11月1日（日） に実施（あとから記録）",
      "6月1日（月） に実施（あとから記録）",
      "1月10日（土） に実施（あとから記録）",
    ])
  })

  it("一覧に 21 件以上在る項目は、サーバーを読まずに続きを表示できる（21 件目より古い記録にも釦が出る）", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      log({
        id: `c3000000-0000-4000-8000-${String(200 + i).padStart(12, "0")}`,
        done_on: `2026-10-${String(30 - i).padStart(2, "0")}`,
        created_at: `2026-10-${String(30 - i).padStart(2, "0")}T03:00:00.000000+00:00`,
      }),
    )
    const dialog = await openDetail({ logs: many })
    expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(20)
    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    const rows = within(dialog).getAllByTestId("cleaning-log")
    expect(rows).toHaveLength(25)
    expect(within(rows[24]).getByRole("button", { name: /を取り消す$/ })).toBeInTheDocument()
    expect(loadCleaningHistory).not.toHaveBeenCalled()
    // 一覧は打ち切られておらぬ → これ以上は無い
    expect(within(dialog).queryByRole("button", { name: "古い記録をさらに表示" })).not.toBeInTheDocument()
  })

  it("対照: 一覧が打ち切られておらず 20 件以内なら、読み足しの釦を出さぬ", async () => {
    const dialog = await openDetail({ logs: [oldLog] })
    expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(1)
    expect(within(dialog).queryByRole("button", { name: /古い記録|履歴を読み込む/ })).not.toBeInTheDocument()
  })

  it("読み足しに失敗したら理由を出し、「記録が無い」とは言わぬ。もう一度押せる", async () => {
    loadCleaningHistory.mockResolvedValueOnce({ error: "履歴を読み込めませんでした。通信状況を確認して、もう一度お試しください。" })
    loadCleaningHistory.mockRejectedValueOnce(new Error("synthetic network failure"))
    loadCleaningHistory.mockResolvedValueOnce({ logs: [oldLog], next: null })
    vi.spyOn(console, "error").mockImplementation(() => {})
    const dialog = await openDetail({ historyTruncated: true })
    const more = () => within(dialog).getByRole("button", { name: "古い記録をさらに表示" })

    await click(more())
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("履歴を読み込めませんでした"))
    expect(within(dialog).queryByText("この項目の記録は見つかりませんでした。")).not.toBeInTheDocument()
    // 例外（応答が届かぬ）も同じく失敗として出す
    await click(more())
    await waitFor(() => expect(loadCleaningHistory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(more()).toBeEnabled())
    expect(within(dialog).getByRole("alert")).toHaveTextContent("履歴を読み込めませんでした")

    await click(more())
    expect(await within(dialog).findByTestId("cleaning-log")).toBeInTheDocument()
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("一覧そのものを読めなんだ時も、この項目の履歴は読み込める", async () => {
    loadCleaningHistory.mockResolvedValue({ logs: [oldLog], next: null })
    const dialog = await openDetail({ historyFailed: true })
    expect(within(dialog).getByRole("alert")).toHaveTextContent("履歴を読み込めませんでした。履歴がないとは限りません。")
    await click(within(dialog).getByRole("button", { name: "この項目の履歴を読み込む" }))
    expect(await within(dialog).findByTestId("cleaning-log")).toBeInTheDocument()
    expect(loadCleaningHistory).toHaveBeenCalledWith({ routineId: DRAIN, before: null })
    // 読めた後は「読み込めませんでした」を出し続けぬ
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("別の項目の行・取り消し済みの行が応答に混ざっても、この項目の履歴に出さぬ", async () => {
    loadCleaningHistory.mockResolvedValue({
      logs: [oldLog, { ...oldLog, id: "c3000000-0000-4000-8000-000000000094", routine_id: MONTHLY }, { ...oldLog, id: "c3000000-0000-4000-8000-000000000095", voided_at: V2 }],
      next: null,
    })
    const dialog = await openDetail({ historyTruncated: true })
    await click(within(dialog).getByRole("button", { name: "古い記録をさらに表示" }))
    await within(dialog).findByTestId("cleaning-log")
    expect(within(dialog).getAllByTestId("cleaning-log")).toHaveLength(1)
  })
})

describe("R35 保存の応答は、その操作を送った編集セッション（シートを開くたびに変わる）だけを閉じる", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => {
      resolve = res
      reject = rej
    })
    return { promise, resolve, reject }
  }
  type Response = CleaningSaveSuccess | ChoreSaveFailure
  const closedLog = (request: CleaningRequest, kind: "done" | "skip" = "done") =>
    log({
      id: request.op === "close" ? request.id : "",
      kind,
      done_on: kind === "done" ? WED : null,
      occurrence: "2026-11-07",
      updated_at: V2,
    })
  const closeButton = (dialog: HTMLElement) => within(dialog).getByRole("button", { name: "閉じる" })

  it("危険側: 一覧の 1 タップ完了の応答は、送信中に開いた「項目を追加」のシートを閉じず、入力も保存中の表示も変えない", async () => {
    const pending = deferred<Response>()
    saveCleaning.mockReturnValueOnce(pending.promise)
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    const sent = saveCleaning.mock.calls[0][0]

    // 応答を待つ間に「項目を追加」を開いて名前を打ち始める
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("名前")
    fireEvent.change(name, { target: { value: "窓ふき" } })
    // 先の操作の送信中でも、このシートは「保存中」にならぬ（このシートから送ったのではない）
    expect(within(dialog).getByRole("button", { name: "この内容で追加" })).toBeDisabled()

    await act(async () => {
      pending.resolve({ status: "saved", log: closedLog(sent) })
    })
    // 先の操作の確定は一覧へ反映する（取り直し・直後の取り消しの帯）
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId("cleaning-inline-undo")).toBeInTheDocument()
    // シートは同じまま開いておる。入力も残り、保存の釦は保存中にならず押せる
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("名前")).toBe(name)
    expect(name).toHaveValue("窓ふき")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "この内容で追加" })).toBeEnabled())
    // 先の操作の結果は、このシートの中には出さぬ（閉じた一覧に出る）
    expect(within(dialog).queryByText(/を完了にしました/)).not.toBeInTheDocument()
    await click(closeButton(dialog))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("status")).toHaveTextContent("「浴室の排水口」を完了にしました。")
  })

  it("危険側: シートから送った操作の応答は、閉じて同じ項目を開き直したシートを閉じない（別の編集セッション）", async () => {
    const pending = deferred<Response>()
    saveCleaning.mockReturnValueOnce(pending.promise)
    view()
    await ready()
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const first = await screen.findByRole("dialog")
    await click(within(first).getByRole("button", { name: "今回はスキップ" }))
    expect(saveCleaning).toHaveBeenCalledTimes(1)
    const sent = saveCleaning.mock.calls[0][0]

    // 応答の前に閉じて、同じ項目を開き直し、過去日の記録のメモを打ち始める
    await click(closeButton(first))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const second = await screen.findByRole("dialog")
    const note = within(second).getByLabelText("メモ（任意）")
    fireEvent.change(note, { target: { value: "打ちかけのメモ" } })

    await act(async () => {
      pending.resolve({ status: "saved", log: closedLog(sent, "skip") })
    })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("dialog")).toBe(second)
    expect(within(second).getByLabelText("メモ（任意）")).toBe(note)
    expect(note).toHaveValue("打ちかけのメモ")
    expect(within(second).queryByText(/をスキップしました/)).not.toBeInTheDocument()
  })

  it("危険側: 先の操作が拒否されても、後から開いたシートに理由を出さず閉じもしない。理由は一覧に、どの操作かを添えて残る", async () => {
    const pending = deferred<Response>()
    saveCleaning.mockReturnValueOnce(pending.promise)
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    await click(screen.getByRole("button", { name: "浴室の排水口の詳細を開く" }))
    const dialog = await screen.findByRole("dialog")
    const date = within(dialog).getByLabelText("実施した日")
    fireEvent.change(date, { target: { value: "2026-11-09" } })

    await act(async () => {
      pending.resolve({ error: "休止中の項目です。再開してから操作してください。", failure: "rejected" })
    })
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "この日の実施を記録" })).toBeEnabled())
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(date).toHaveValue("2026-11-09")
    expect(within(dialog).queryByText(/休止中の項目です/)).not.toBeInTheDocument()

    await click(closeButton(dialog))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("alert")).toHaveTextContent(
      "先に送った操作（「浴室の排水口」を完了）は保存できませんでした。休止中の項目です。再開してから操作してください。",
    )
  })

  it("先の操作が結果不明でも後から開いたシートは閉じず、そのシートの中から同じ操作で確かめても閉じない", async () => {
    const pending = deferred<Response>()
    saveCleaning.mockReturnValueOnce(pending.promise)
    view()
    await ready()
    await click(completeBox("浴室の排水口"))
    const sent = saveCleaning.mock.calls[0][0]
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "窓ふき" } })

    await act(async () => {
      pending.reject(new Error("synthetic lost response"))
    })
    // シートの中でも、新しい保存を止めておる理由（確かめておらぬ操作）が分かる
    const confirm = await within(dialog).findByRole("button", { name: "同じ操作で確認" })
    expect(within(dialog).getByText("「浴室の排水口」を完了")).toBeInTheDocument()
    expect(within(dialog).getByRole("button", { name: "この内容で追加" })).toBeDisabled()
    expect(screen.getByRole("dialog")).toBe(dialog)

    // 確かめ直しはどのシートの送信でもない（応答でこのシートを閉じぬ）。結果は押した場所に出す
    saveCleaning.mockResolvedValueOnce({ status: "replayed", log: closedLog(sent) })
    await click(confirm)
    await waitFor(() => expect(saveCleaning).toHaveBeenCalledTimes(2))
    expect(saveCleaning.mock.calls[1][0]).toEqual(sent)
    await waitFor(() => expect(within(dialog).getByRole("status")).toHaveTextContent("「浴室の排水口」を完了にしました。"))
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("名前")).toHaveValue("窓ふき")
    expect(within(dialog).getByRole("button", { name: "この内容で追加" })).toBeEnabled()
  })

  it("正常側: シートの中から送った操作の応答では、そのシートを閉じて結果を一覧に出す", async () => {
    saveCleaning.mockResolvedValue({ status: "saved" })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "窓ふき" } })
    await click(within(dialog).getByRole("button", { name: "この内容で追加" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(screen.getByRole("status")).toHaveTextContent("「窓ふき」を追加しました。")
  })

  it("正常側: シートから送った操作の送信中は、そのシートだけが保存中になり、拒否されたら理由をシートの中に出して入力を残す", async () => {
    const pending = deferred<Response>()
    saveCleaning.mockReturnValueOnce(pending.promise)
    view()
    await ready()
    await click(screen.getByRole("button", { name: "項目を追加" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "窓ふき" } })
    await click(within(dialog).getByRole("button", { name: "この内容で追加" }))
    expect(within(dialog).getByRole("button", { name: "保存中..." })).toBeDisabled()
    await act(async () => {
      pending.resolve({ error: "掃除の項目が上限に達しています。使っていない項目をアーカイブしてください。", failure: "rejected" })
    })
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("掃除の項目が上限に達しています。"))
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("名前")).toHaveValue("窓ふき")
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "この内容で追加" })).toBeEnabled())
  })
})
