import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react"

import { BabyQuickActions, INLINE_UNDO_MS } from "../baby-quick-actions"
import {
  recordFeeding,
  recordDiaper,
  deleteLog,
} from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import type { BabyLogData } from "@/lib/types/baby"
import type { FeedingType } from "@/lib/types/database"
import type { BottleDefaultController } from "@/lib/hooks/use-bottle-default"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  deleteLog: vi.fn(),
  updateBottleDefault: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() },
}))

const mockedRecordFeeding = vi.mocked(recordFeeding)
const mockedRecordDiaper = vi.mocked(recordDiaper)
const mockedDeleteLog = vi.mocked(deleteLog)
const mockedToast = vi.mocked(toast)

/**
 * いつものミルク量が決まっている世帯（120ml）。既存の「ミルクは 1 タップで記録」の前提を
 * 保つ既定。未設定・取得失敗・変更の筋は bottle-default 系の群が個別に組む。
 */
function bottleSet(amountMl = 120): BottleDefaultController {
  return {
    state: { status: "set", amountMl },
    refetch: vi.fn(async () => null),
    apply: vi.fn(),
  }
}

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
async function clickWhenEnabled(name: string | RegExp) {
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
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-9", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockRejectedValue(new Error("network down"))
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
    mockedRecordFeeding.mockResolvedValue({ error: null, id: "log-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "log-2", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
      loggedAt: new Date().toISOString(),
    })
    mockedDeleteLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていたため、削除しませんでした（家族またはご自身）。",
      conflict: { current: UPDATED_ELSEWHERE },
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onLogUpdated = vi.fn<(log: BabyLogData) => void>()
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
      loggedAt: new Date().toISOString(),
    })
    mockedDeleteLog.mockResolvedValue({
      error: "記録を削除できませんでした（最新の状態を確かめられませんでした）。画面を更新して記録を確かめてください。",
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-77", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-88", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockResolvedValue({
      error: "既に削除されています。",
      alreadyDeleted: true,
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(
      <BabyQuickActions
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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
        bottleDefault={bottleSet()}
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

describe("BabyQuickActions の直前の記録（トーストが出ておる間は帯を伏せる）", () => {
  it("トーストが見えておる間は帯を出さず、自動で閉じた（onAutoClose）後に帯が引き継ぐ", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-hand", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    render(
      <BabyQuickActions userId="u1" onCreateLog={() => {}} onStartTimer={() => {}} onCreateFeeding={() => {}} bottleDefault={bottleSet()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    // トーストが出ておる間: 下端のトーストと重なる帯は出さぬ
    expect(screen.queryByRole("button", { name: /^直前の記録/ })).toBeNull()
    const opts = mockedToast.success.mock.calls.at(-1)?.[1] as {
      onAutoClose?: () => void
      onDismiss?: () => void
    }
    expect(opts.onAutoClose).toBeTypeOf("function")
    act(() => opts.onAutoClose?.())
    expect(screen.getByRole("button", { name: /^直前の記録/ })).toBeInTheDocument()
  })

  it("閉じられた（onDismiss・スワイプ等）後も帯が引き継ぐ。古い記録のトーストが後から閉じても新しい方の伏せは解かぬ", async () => {
    mockedRecordDiaper
      .mockResolvedValueOnce({ error: null, id: "diaper-old", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      .mockResolvedValueOnce({ error: null, id: "diaper-new", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    render(
      <BabyQuickActions userId="u1" onCreateLog={() => {}} onStartTimer={() => {}} onCreateFeeding={() => {}} bottleDefault={bottleSet()} />,
    )
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalledTimes(1))
    const oldOpts = mockedToast.success.mock.calls[0][1] as { onDismiss?: () => void }
    await clickWhenEnabled("おしっこ")
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalledTimes(2))
    const newOpts = mockedToast.success.mock.calls[1][1] as { onDismiss?: () => void }
    // 古いトーストが閉じても、新しい記録のトーストはまだ出ておる → 帯は伏せたまま
    act(() => oldOpts.onDismiss?.())
    expect(screen.queryByRole("button", { name: /^直前の記録/ })).toBeNull()
    act(() => newOpts.onDismiss?.())
    expect(screen.getByRole("button", { name: /^直前の記録/ })).toBeInTheDocument()
  })
})

describe("BabyQuickActions の直前の記録（インラインの取り消し）", () => {
  // この群はトーストが閉じた後の帯を検証する。実物の sonner と同じく、出したトーストは
  // 自動で閉じて onAutoClose を呼ぶ（帯への引き継ぎは上の群が固定する）
  beforeEach(() => {
    mockedToast.success.mockImplementation(((
      _message: unknown,
      opts?: { onAutoClose?: () => void },
    ) => {
      setTimeout(() => act(() => opts?.onAutoClose?.()), 0)
      return 1
    }) as never)
  })
  afterEach(() => {
    mockedToast.success.mockReset()
  })

  /** 名前は「直前の記録（HH:MM）を取り消す」— 記録の中身は入れぬ（タイムライン行と奪い合わぬ） */
  const INLINE_UNDO = /^直前の記録（\d\d:\d\d）を取り消す$/

  const RECORDED: BabyLogData = {
    id: "diaper-in-1",
    log_type: "diaper",
    logged_at: "2026-10-24T13:30:00.000Z",
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
    memo: null,
    created_at: "2026-10-24T13:30:00.000Z",
  }

  function actions(props: Partial<Parameters<typeof BabyQuickActions>[0]> = {}) {
    return (
      <BabyQuickActions
        bottleDefault={bottleSet()}
        userId="u1"
        onCreateLog={() => {}}
        onStartTimer={() => {}}
        onCreateFeeding={() => {}}
        {...props}
      />
    )
  }

  it("記録に成功すると、釦群の下に「直前の記録」と取り消しが残る（トーストが消えた後の口）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    render(actions())
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    expect(screen.getByTestId("inline-undo")).toHaveTextContent("おしっこを記録しました")
    // トーストにも同じ 1 件の取り消しが付く（id で同じトーストを閉じられるように）
    const call = mockedToast.success.mock.calls.at(-1)
    expect((call?.[1] as { id?: string } | undefined)?.id).toBe("baby-undo:diaper-in-1")
  })

  it("インラインで取り消すと deleteLog は 1 回だけ。トーストを閉じ、後からトーストの取り消しを押しても二度は送らぬ", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockResolvedValue({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(actions({ onLogRemoved }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    const toastAction = lastSuccessOptions()?.action
    await clickWhenEnabled(INLINE_UNDO)

    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-in-1"))
    expect(mockedToast.dismiss).toHaveBeenCalledWith("baby-undo:diaper-in-1")
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()

    toastAction?.onClick()
    await waitFor(() => expect(mockedDeleteLog).toHaveBeenCalledTimes(1))
    expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-in-1", CREATED_VERSION)
  })

  it("トーストから取り消してもインラインの帯は消える（同じ 1 件を指す）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog.mockResolvedValue({ error: null })
    render(actions())
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    lastSuccessOptions()?.action?.onClick()
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull(),
    )
    expect(mockedDeleteLog).toHaveBeenCalledTimes(1)
  })

  it("対象の行が画面から消えたら（編集シートで削除・再取得）帯を畳む。対照: 行が在る間は出す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    const view = render(actions({ visibleLogs: [] }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
    // 行が無い（親の logs に居らぬ）間は出さぬ
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
    view.rerender(actions({ visibleLogs: [RECORDED] }))
    expect(screen.getByRole("button", { name: INLINE_UNDO })).toBeInTheDocument()
    view.rerender(actions({ visibleLogs: [] }))
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("期限（5 分）を過ぎた親の時計では帯を畳む。対照: 期限内は出す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    const view = render(actions({ now: new Date() }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    view.rerender(actions({ now: new Date(Date.now() + INLINE_UNDO_MS - 60_000) }))
    expect(screen.getByRole("button", { name: INLINE_UNDO })).toBeInTheDocument()
    view.rerender(actions({ now: new Date(Date.now() + INLINE_UNDO_MS + 1_000) }))
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("後からタイマー・記録シートで記録が付いたら（親の通し番号が進む）帯を畳む。対照: 進まぬ間は出す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    const view = render(actions({ externalRecordSeq: 3 }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    view.rerender(actions({ externalRecordSeq: 3 }))
    expect(screen.getByRole("button", { name: INLINE_UNDO })).toBeInTheDocument()
    view.rerender(actions({ externalRecordSeq: 4 }))
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("クイック記録の通信中にタイマー等で記録が付いても（番号が進む）、後から届いたクイック記録の帯は出す", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof recordDiaper>>) => void
    mockedRecordDiaper.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const view = render(actions({ externalRecordSeq: 3 }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    // 通信中にタイマーの記録が付いた
    view.rerender(actions({ externalRecordSeq: 4 }))
    resolve({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    // クイック記録の方が後に確定した = こちらが「直前」
    expect(await screen.findByRole("button", { name: INLINE_UNDO })).toBeInTheDocument()
  })

  it("応答を失った再試行が「既に記録済み」で返ったら、前の記録の帯は畳む（取り消しの誤指し防止）", async () => {
    mockedRecordDiaper
      .mockResolvedValueOnce({ error: null, id: "diaper-a", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      .mockResolvedValueOnce({ error: null, id: "diaper-b", replayed: true })
    render(actions())
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled("おしっこ")
    await waitFor(() =>
      expect(mockedToast.success).toHaveBeenCalledWith(
        expect.stringContaining("既に記録されています"),
      ),
    )
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("帯の「取り消す」を連打しても deleteLog は 1 回だけ（同じ描画のうちに 2 回押されても）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    let resolveDelete!: (v: Awaited<ReturnType<typeof deleteLog>>) => void
    mockedDeleteLog.mockReturnValue(
      new Promise((r) => {
        resolveDelete = r
      }),
    )
    render(actions())
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    const undo = await screen.findByRole("button", { name: INLINE_UNDO })
    await waitFor(() => expect(undo).not.toBeDisabled())
    // 再描画を挟まず同じ要素へ 2 回（指の二度押し）
    fireEvent.click(undo)
    fireEvent.click(undo)
    // 通信が遅い間に、残っておったトーストの取り消しも押す
    lastSuccessOptions()?.action?.onClick()
    resolveDelete({ error: null })
    await waitFor(() => expect(mockedDeleteLog).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(mockedDeleteLog).toHaveBeenCalledTimes(1)
  })

  it("帯から取り消す前に家族が直していたら（版の衝突）、消さず・帯も戻さず・最新版へ揃える", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    const current: BabyLogData = {
      ...RECORDED,
      memo: "家族が足したメモ",
      updated_at: "2026-10-24T13:31:00.654321+00:00",
    }
    mockedDeleteLog.mockResolvedValue({
      error: "この記録は別の端末で先に更新されていたため、削除しませんでした（家族またはご自身）。",
      conflict: { current },
    })
    const onLogRemoved = vi.fn<(id: string) => void>()
    const onLogUpdated = vi.fn<(log: BabyLogData) => void>()
    render(actions({ onLogRemoved, onLogUpdated }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled(INLINE_UNDO)
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("取り消しませんでした")),
    )
    expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-in-1", CREATED_VERSION)
    expect(onLogRemoved).not.toHaveBeenCalled()
    expect(onLogUpdated).toHaveBeenCalledWith(current)
    // 押し直しても同じ衝突になるゆえ帯は戻さぬ
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("サーバの一時エラー（衝突でも削除済みでもない）は帯を戻して押し直せる。削除済みは戻さず画面から外す", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog
      .mockResolvedValueOnce({ error: "削除に失敗しました" })
      .mockResolvedValueOnce({ error: "既に削除されています。", alreadyDeleted: true })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(actions({ onLogRemoved }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled(INLINE_UNDO)
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith("削除に失敗しました"))
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled(INLINE_UNDO)
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-in-1"))
    expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
  })

  it("通信断で取り消せなかった時は帯を戻し、押し直せる（二度目も送る）", async () => {
    mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    mockedDeleteLog
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ error: null })
    const onLogRemoved = vi.fn<(id: string) => void>()
    render(actions({ onLogRemoved }))
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled(INLINE_UNDO)
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
    expect(onLogRemoved).not.toHaveBeenCalled()
    await screen.findByRole("button", { name: INLINE_UNDO })
    await clickWhenEnabled(INLINE_UNDO)
    await waitFor(() => expect(onLogRemoved).toHaveBeenCalledWith("diaper-in-1"))
    expect(mockedDeleteLog).toHaveBeenCalledTimes(2)
  })

  describe("時計の扱い", () => {
    // JST 2026-10-24 12:00
    const T0 = new Date("2026-10-24T03:00:00.000Z")
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: T0 })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it("通信断で戻した帯は記録した時刻（12:00）のまま。失敗した時刻（12:03）で作り直さぬ", async () => {
      mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      mockedDeleteLog.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      render(actions())
      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await screen.findByRole("button", { name: INLINE_UNDO })
      vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000))
      await clickWhenEnabled(INLINE_UNDO)
      await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
      const restored = await screen.findByRole("button", { name: INLINE_UNDO })
      expect(restored).toHaveAccessibleName("直前の記録（12:00）を取り消す")
      expect(screen.getByTestId("inline-undo")).toHaveTextContent("12:00 おしっこを記録しました")
    })

    it("戻した帯の期限も記録した時刻（12:00）から測る。失敗した時刻（12:03）から 5 分へ延ばさぬ", async () => {
      mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      mockedDeleteLog.mockRejectedValueOnce(new TypeError("Failed to fetch"))
      // 親の時計（now）は記録の時刻で止めておく（期限の判定を押した瞬間の実時計だけに絞る）
      render(actions({ now: new Date(T0) }))
      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await screen.findByRole("button", { name: INLINE_UNDO })
      vi.setSystemTime(new Date(T0.getTime() + 3 * 60_000))
      await clickWhenEnabled(INLINE_UNDO)
      await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))
      await screen.findByRole("button", { name: INLINE_UNDO })

      // 記録から 5 分 1 秒（失敗からは 2 分 1 秒）。記録の時刻で測れば期限切れ
      vi.setSystemTime(new Date(T0.getTime() + INLINE_UNDO_MS + 1_000))
      await clickWhenEnabled(INLINE_UNDO)
      expect(mockedDeleteLog).toHaveBeenCalledTimes(1)
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("期限（5分）を過ぎました"))
    })

    it("親の時計が止まっていても（端末の休止）、押した瞬間に期限切れなら取り消さず畳む。対照: 期限内は送る", async () => {
      mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      mockedDeleteLog.mockResolvedValue({ error: null })
      // 親の時計（now）は記録の時刻で止まったまま
      render(actions({ now: new Date(T0) }))
      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await screen.findByRole("button", { name: INLINE_UNDO })

      vi.setSystemTime(new Date(T0.getTime() + INLINE_UNDO_MS + 60_000))
      await clickWhenEnabled(INLINE_UNDO)
      expect(mockedDeleteLog).not.toHaveBeenCalled()
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("期限（5分）を過ぎました"))
      expect(screen.queryByRole("button", { name: INLINE_UNDO })).toBeNull()
    })

    it("端末の休止で止まっていたトーストの「取り消す」も、5 分を過ぎていれば送らぬ（帯と同じ期限）", async () => {
      mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      mockedDeleteLog.mockResolvedValue({ error: null })
      render(actions())
      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await waitFor(() => expect(mockedToast.success).toHaveBeenCalled())
      const action = (mockedToast.success.mock.calls.at(-1)?.[1] as {
        action?: { onClick: () => void }
      }).action
      vi.setSystemTime(new Date(T0.getTime() + INLINE_UNDO_MS + 60_000))
      act(() => action?.onClick())
      expect(mockedDeleteLog).not.toHaveBeenCalled()
      expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining("期限（5分）を過ぎました"))
    })

    it("対照: 期限内（4 分後）に押せば deleteLog を送る", async () => {
      mockedRecordDiaper.mockResolvedValue({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
      mockedDeleteLog.mockResolvedValue({ error: null })
      render(actions({ now: new Date(T0) }))
      fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
      await screen.findByRole("button", { name: INLINE_UNDO })
      vi.setSystemTime(new Date(T0.getTime() + 4 * 60_000))
      await clickWhenEnabled(INLINE_UNDO)
      await waitFor(() => expect(mockedDeleteLog).toHaveBeenCalledWith("diaper-in-1", CREATED_VERSION))
    })
  })

  it("記録中は押した釦にだけスピナーを出し、全釦は押せぬ（二重記録の防止）。名前は変えぬ", async () => {
    let resolve!: (v: Awaited<ReturnType<typeof recordDiaper>>) => void
    mockedRecordDiaper.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    render(actions())
    fireEvent.click(screen.getByRole("button", { name: "おしっこ" }))
    const pee = screen.getByRole("button", { name: "おしっこ" })
    await waitFor(() => expect(pee).toBeDisabled())
    expect(pee.querySelector(".animate-spin")).not.toBeNull()
    const milk = screen.getByRole("button", { name: "ミルク" })
    expect(milk).toBeDisabled()
    expect(milk.querySelector(".animate-spin")).toBeNull()
    resolve({ error: null, id: "diaper-in-1", updatedAt: CREATED_VERSION, loggedAt: new Date().toISOString() })
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "おしっこ" })).not.toBeDisabled(),
    )
  })
})
