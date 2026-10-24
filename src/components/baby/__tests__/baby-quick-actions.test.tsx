import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"

import { BabyQuickActions } from "../baby-quick-actions"
import {
  recordFeeding,
  recordDiaper,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"
import type { FeedingType } from "@/lib/types/database"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedToast = vi.mocked(toast)

/** 作成に成功した時にサーバが返す行の版（DB の updated_at。取り消しはこの版でしか消せぬ） */
const CREATED_VERSION = "2026-10-21T03:00:00.123456+00:00"

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks は mockResolvedValueOnce の待ち行列を消さぬ。先に落ちたテストの残りが
  // 次のテストへ漏れて無関係に赤くならぬよう、Once を積む mock は個別に reset する
  mockedRecordFeeding.mockReset()
  mockedRecordDiaper.mockReset()
  mockedDeleteLog.mockReset()
})
afterEach(cleanup)

/**
 * 押し直しは、ボタンが押せるようになってから行う。React 19 の async transition では、
 * await の後の setState（toast を出す catch 等）が isPending=false より先にコミットされうる。
 * disabled のままのボタンへの click は無言で捨てられ、遅い CI でだけ「呼ばれた回数」が
 * 足りずに赤くなる（記録済みの CI 限定 flake と同じ機序）。
 */
async function clickWhenEnabled(name: string) {
  const button = screen.getByRole("button", { name })
  await waitFor(() => expect(button).not.toBeDisabled())
  fireEvent.click(button)
}

function lastSuccessOptions() {
  const call = mockedToast.success.mock.calls.at(-1)
  return call?.[1] as
    | { action?: { label: string; onClick: () => void } }
    | undefined
}

// B-07: startTransition 内で Server Action が reject（通信断）すると、
// unhandled reject が error boundary へ bubble し全画面エラー化 + 記録無言喪失する
// (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)。
// 各ハンドラが try/catch で握って圏外トーストへ倒すことを固定する。
// toast.error(OFFLINE_MESSAGE) が呼ばれること自体が「catch が発火した=reject が
// 未処理で漏れていない」ことの証跡になる（catch 内でしか呼ばれない文言）。
const OFFLINE_MESSAGE =
  "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("BabyQuickActions の通信断 reject 握り（B-07）", () => {
  it("授乳（ミルク）記録が reject → 圏外トースト", async () => {
    mockedRecordFeeding.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("おむつ記録が reject → 圏外トースト", async () => {
    mockedRecordDiaper.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(mockedToast.success).not.toHaveBeenCalled()
  })

  it("記録取り消し（undoLog）の deleteLog が reject → 圏外トースト", async () => {
    // まず記録成功で「取り消す」アクション付きトーストを得る
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-9", updatedAt: CREATED_VERSION })
    mockedDeleteLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())

    const undoOpts = mockedToast.success.mock.calls.at(-1)?.[1] as
      | { action?: { onClick: () => void } }
      | undefined
    undoOpts?.action?.onClick()
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
  })
})

describe("BabyQuickActions の押し間違い取り消し", () => {
  it("授乳記録後のトーストの「取り消す」が、作成時にサーバが返した版で deleteLog を呼ぶ", async () => {
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-1", updatedAt: CREATED_VERSION })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalled())
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())

    const opts = lastSuccessOptions()
    expect(opts?.action?.label).toBe("取り消す")
    opts?.action?.onClick()
    // 版はローカルの時計（new Date()）から作らず、サーバが返した表記のまま送る
    await waitFor(() =>
      expect(mockedDeleteLog).toHaveBeenCalledWith("log-1", CREATED_VERSION),
    )
  })

  it("おむつ記録後も id と版付きで「取り消す」を提示する", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-2", updatedAt: CREATED_VERSION })
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(lastSuccessOptions()?.action?.label).toBe("取り消す")
  })

  it("id が無い場合は取り消しアクションを付けない", async () => {
    // 実アクションは成功時に必ず string id を返すため { error: null, id: null }
    // は到達不能。だが successWithUndo は id 欠落を防御ガードしており、その分岐を
    // 固定するため二段キャストで意図的に到達不能な状態を注入する。
    mockedRecordFeeding.mockResolvedValue({
      error: null,
      id: null,
    } as unknown as Awaited<ReturnType<typeof recordFeeding>>)
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(lastSuccessOptions()?.action).toBeUndefined()
  })

  it("作成の応答に版が無い時は「取り消す」を出さず、一覧から消せると伝える（版を手元で作らぬ）", async () => {
    // 版なしの取り消しは無条件の削除と同じ（家族が直した後でも消える）ゆえ出さぬ。
    // 記録自体は成功しておるゆえ成功トーストは出し、行も楽観 append する
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-no-version" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    const opts = lastSuccessOptions() as
      | { action?: unknown; description?: string }
      | undefined
    expect(opts?.action).toBeUndefined()
    expect(opts?.description).toMatch(/一覧/)
    expect(onLogRecorded).toHaveBeenCalledTimes(1)
    expect(mockedDeleteLog).not.toHaveBeenCalled()
  })
})

/**
 * 取り消しの版ガード（PR #235 敵対レビュー P1）。記録の直後に家族（または自分の別端末・
 * 自分の編集シート）がその記録を直していたら、「取り消す」は直された記録を消さぬ。
 */
describe("BabyQuickActions の取り消しの版ガード", () => {
  const UPDATED_ELSEWHERE: BabyLogData = {
    id: "diaper-55",
    log_type: "diaper",
    logged_at: "2026-10-21T03:00:00+00:00",
    logged_by: "u1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: "pee",
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: "家族が足したメモ",
    created_at: "2026-10-21T03:00:00+00:00",
    updated_at: "2026-10-21T03:01:00.654321+00:00",
  }

  it("⭐ 取り消しの前に他端末で更新されていたら、消さず・画面から外さず、最新版に揃えて理由を伝える", async () => {
    mockedRecordDiaper.mockResolvedValue({
      error: null,
      id: "diaper-55",
      updatedAt: CREATED_VERSION,
    })
    mockedDeleteLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていたため、削除しませんでした（家族またはご自身）。",
      conflict: { current: UPDATED_ELSEWHERE },
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onLogUpdated = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRemoved={onLogRemoved}
        onLogUpdated={onLogUpdated}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    lastSuccessOptions()?.action?.onClick()

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        expect.stringContaining("取り消しませんでした"),
      ),
    )
    expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-55", CREATED_VERSION)
    // 他端末の記録はローカル state からも取り除かぬ
    expect(onLogRemoved).not.toHaveBeenCalled()
    expect(onLogUpdated).toHaveBeenCalledWith(UPDATED_ELSEWHERE)
    // 「取り消しました」と偽らぬ
    expect(mockedToast.success).toHaveBeenCalledTimes(1)
  })

  it("読み直しに失敗（衝突とも削除済みとも言えぬ）→ 行を外さず、理由だけ伝える", async () => {
    mockedRecordDiaper.mockResolvedValue({
      error: null,
      id: "diaper-56",
      updatedAt: CREATED_VERSION,
    })
    mockedDeleteLog.mockResolvedValue({
      error: "記録を削除できませんでした（最新の状態を確かめられませんでした）。画面を更新して記録を確かめてください。",
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRemoved={onLogRemoved}
      />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    lastSuccessOptions()?.action?.onClick()
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        expect.stringContaining("確かめられませんでした"),
      ),
    )
    expect(onLogRemoved).not.toHaveBeenCalled()
  })
})

describe("BabyQuickActions の楽観 append (B-03)", () => {
  it("おむつ記録成功で onLogRecorded に返却 id 付きの diaper 行（量つき）を渡す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-33" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )

    // うんちは 2 段目で量を選ぶ（1 段目だけでは記録しない）
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    expect(mockedRecordDiaper).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "大量" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    const log = onLogRecorded.mock.calls[0][0]
    expect(log.id).toBe("diaper-33")
    expect(log.log_type).toBe("diaper")
    expect(log.diaper_type).toBe("poop")
    expect(log.poop_amount).toBe("large")
    expect(log.logged_by).toBe("u1")
  })

  it("Undo 成功で onLogRemoved(id) を渡す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-77", updatedAt: CREATED_VERSION })
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRemoved={onLogRemoved}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    lastSuccessOptions()?.action?.onClick()
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-77"))
  })

  it("取り消し対象が他端末で既に削除済み（alreadyDeleted）でも onLogRemoved で画面から外す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-88", updatedAt: CREATED_VERSION })
    mockedDeleteLog.mockResolvedValue({
      error: "既に削除されています。",
      alreadyDeleted: true,
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRemoved={onLogRemoved}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    lastSuccessOptions()?.action?.onClick()
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-88"))
    expect(mockedToast.error).toHaveBeenCalledWith("既に削除されています。")
  })
})

describe("BabyQuickActions の冪等 id（P2-08: 通信断の再タップで二重記録を作らない）", () => {
  function renderActions() {
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
      />,
    )
  }

  function clientIdOf(call: unknown[] | undefined): string | undefined {
    return (call?.[0] as { clientId?: string } | undefined)?.clientId
  }

  it("通信断で reject した直後の同じ操作は同じ id を送り、応答が届いた後は新しい id になる", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "log-1" })
      .mockResolvedValueOnce({ error: null, id: "log-2" })
    renderActions()

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    const first = clientIdOf(mockedRecordFeeding.mock.calls[0])
    const retry = clientIdOf(mockedRecordFeeding.mock.calls[1])
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    expect(retry).toBe(first)

    // 成功の応答が届いた後の 3 回目は別の意図ゆえ新しい id
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(3))
    expect(clientIdOf(mockedRecordFeeding.mock.calls[2])).not.toBe(first)
  })

  it("通信断の後でも別の操作（種別が違う）なら新しい id を使う", async () => {
    mockedRecordFeeding
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ error: null, id: "log-3" })
    renderActions()

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    await clickWhenEnabled("離乳食")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(clientIdOf(mockedRecordFeeding.mock.calls[1])).not.toBe(
      clientIdOf(mockedRecordFeeding.mock.calls[0]),
    )
  })

  it("サーバが拒んだ（検証エラー）後の再タップは新しい id（意図が変わりうる）", async () => {
    mockedRecordFeeding
      .mockResolvedValueOnce({ error: "だめ", id: null })
      .mockResolvedValueOnce({ error: null, id: "log-4" })
    renderActions()

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith("だめ"))
    await clickWhenEnabled("ミルク")
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
    expect(clientIdOf(mockedRecordFeeding.mock.calls[1])).not.toBe(
      clientIdOf(mockedRecordFeeding.mock.calls[0]),
    )
  })

  it("通信断の後でも期限（2 分）を過ぎた同じ種別のタップは新しい記録とみなし、新しい id を送る", async () => {
    // 期限が無いと、数時間後の本物の「次のおしっこ」が過去の保存に吸収され、成功と出るのに
    // 行が増えぬ（レビュー P2-2）。期限内の再タップは上の test が同じ id を固定しておる
    vi.useFakeTimers({ now: new Date("2026-10-19T03:00:00Z"), toFake: ["Date"] })
    try {
      mockedRecordFeeding
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ error: null, id: "log-5" })
      renderActions()

      fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
      await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
      vi.setSystemTime(new Date("2026-10-19T03:02:01Z"))
      await clickWhenEnabled("ミルク")
      await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(2))
      expect(clientIdOf(mockedRecordFeeding.mock.calls[1])).not.toBe(
        clientIdOf(mockedRecordFeeding.mock.calls[0]),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("対照: 期限内（1 分後）の同じ種別のタップは同じ id", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-19T03:00:00Z"), toFake: ["Date"] })
    try {
      mockedRecordDiaper
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce({ error: null, id: "log-6" })
      renderActions()

      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
      vi.setSystemTime(new Date("2026-10-19T03:01:00Z"))
      await clickWhenEnabled("おしっこ")
      await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(2))
      expect(clientIdOf(mockedRecordDiaper.mock.calls[1])).toBe(
        clientIdOf(mockedRecordDiaper.mock.calls[0]),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("再試行が「既に記録済み」（replayed）で受理された時は、取り消しを出さず楽観 append もせぬ", async () => {
    // 「取り消す」を出すと前回の本物の行を消す導線になる。行は resync / Realtime で揃う
    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: "log-7", replayed: true })
    const onLogRecorded = vi.fn()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "ミルク" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(mockedToast.success).toHaveBeenCalledWith(
      expect.stringContaining("既に記録されています"),
    )
    expect(lastSuccessOptions()?.action).toBeUndefined()
    expect(onLogRecorded).not.toHaveBeenCalled()
  })
})

describe("BabyQuickActions のうんちの量（2 段目）", () => {
  function renderActions(onLogRecorded?: (log: BabyLogData) => void) {
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        onLogRecorded={onLogRecorded}
      />,
    )
  }

  it("おしっこは従来どおり 1 タップで記録し、量は送らない（null）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "pee-1" })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    expect(mockedRecordDiaper).toHaveBeenCalledWith({
      diaperType: "pee",
      poopAmount: null,
      clientId: expect.any(String),
    })
    // 2 段目は出ていない
    expect(screen.queryByRole("button", { name: "少量" })).toBeNull()
  })

  it("うんちをタップすると同じ行が 少量 / 大量 / 指定なし に入れ替わり、種別行は隠れる", () => {
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    expect(screen.getByRole("button", { name: "少量" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "大量" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "指定なし" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "おしっこ" })).toBeNull()
    expect(screen.getByText("うんち・うんちの量")).toBeInTheDocument()
    expect(mockedRecordDiaper).not.toHaveBeenCalled()
  })

  it("少量 を選ぶと poop + small で記録し、トーストに量が出る", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "poop-1" })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    fireEvent.click(screen.getByRole("button", { name: "少量" }))
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    expect(mockedRecordDiaper).toHaveBeenCalledWith({
      diaperType: "poop",
      poopAmount: "small",
      clientId: expect.any(String),
    })
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    expect(mockedToast.success.mock.calls.at(-1)?.[0]).toBe(
      "おむつ交換を記録しました（うんち（少量））",
    )
    // 記録後は 1 段目へ戻る
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "うんち" })).toBeInTheDocument(),
    )
  })

  it("両方 も 2 段目を通り、大量 で both + large を記録する", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "both-1" })
    const onLogRecorded = vi.fn<(log: BabyLogData) => void>()
    renderActions(onLogRecorded)
    fireEvent.click(screen.getByRole("button", { name: "両方" }))
    expect(screen.getByText("両方・うんちの量")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "大量" }))
    await waitFor(() => expect(onLogRecorded).toHaveBeenCalledTimes(1))
    expect(mockedRecordDiaper).toHaveBeenCalledWith({
      diaperType: "both",
      poopAmount: "large",
      clientId: expect.any(String),
    })
    expect(onLogRecorded.mock.calls[0][0]).toMatchObject({
      diaper_type: "both",
      poop_amount: "large",
    })
  })

  it("指定なし は量 null（従来と同じ形）で記録する", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "poop-2" })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    fireEvent.click(screen.getByRole("button", { name: "指定なし" }))
    await waitFor(() => expect(mockedRecordDiaper).toHaveBeenCalledTimes(1))
    expect(mockedRecordDiaper).toHaveBeenCalledWith({
      diaperType: "poop",
      poopAmount: null,
      clientId: expect.any(String),
    })
    expect(mockedToast.success.mock.calls.at(-1)?.[0]).toBe(
      "おむつ交換を記録しました（うんち）",
    )
  })

  it("戻るボタンで 1 段目へ戻り、何も記録しない", () => {
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    fireEvent.click(screen.getByRole("button", { name: "おむつの種類に戻る" }))
    expect(screen.getByRole("button", { name: "おしっこ" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "少量" })).toBeNull()
    expect(mockedRecordDiaper).not.toHaveBeenCalled()
  })

  it("記録が失敗しても 2 段目に張り付かず 1 段目へ戻る", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: "boom", id: null })
    renderActions()
    fireEvent.click(screen.getByRole("button", { name: "うんち" }))
    fireEvent.click(screen.getByRole("button", { name: "大量" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith("boom"))
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "うんち" })).toBeInTheDocument(),
    )
  })
})

describe("BabyQuickActions の搾乳導線", () => {
  it("搾乳ボタンは量入力の create シートを開く（即時記録しない）", () => {
    const onCreateFeeding = vi.fn<(type: FeedingType) => void>()
    render(
      <BabyQuickActions
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={onCreateFeeding}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "搾乳" }))
    // 母乳のタイマーやミルクの即時記録とは別経路: create シートへ pumped を渡す
    expect(onCreateFeeding).toHaveBeenCalledWith("pumped")
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })
})
