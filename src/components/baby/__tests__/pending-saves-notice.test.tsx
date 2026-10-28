/**
 * 「保存を確認中の記録」（2026-10-27 A2 / AC06・AC21）。
 * - 自動で行うのは照合の読み（GET）だけ。送り直しは利用者の操作だけ（送信キューではない）
 * - 別の利用者・世帯の記録は出さぬ
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react"

vi.mock("@/app/(main)/baby/actions", () => ({
  recordFeeding: vi.fn(),
  recordDiaper: vi.fn(),
  recordTemperature: vi.fn(),
  recordGrowth: vi.fn(),
  recordMemo: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

import { PendingSavesNotice } from "../pending-saves-notice"
import { recordFeeding } from "@/app/(main)/baby/actions"
import { toast } from "sonner"
import {
  listPendingSaves,
  putPendingSave,
  PENDING_SAVE_SCHEMA_VERSION,
  PAGE_LIFE_ID,
  OTHER_TAB_SENDING_GRACE_MS,
  pendingSaveKey,
} from "@/lib/domain/pending-saves-storage"

const mockedRecordFeeding = vi.mocked(recordFeeding)
const OWNER = { userId: "u1", householdId: "h1" }
const ID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"
const OTHER_ID = "7f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

function seed(owner = OWNER, clientId = ID) {
  putPendingSave({
    schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
    clientId,
    owner,
    action: "recordFeeding",
    payload: { feedingType: "bottle", amountMl: 160, clientId },
    summary: "ミルク 160ml",
    firstAttemptAt: new Date().toISOString(),
    phase: "unknown",
  })
}

const STORED = {
  id: ID,
  log_type: "feeding",
  logged_at: "2026-10-27T03:00:00+00:00",
  logged_by: "u1",
  feeding_type: "bottle",
  amount_ml: 160,
  updated_at: "2026-10-27T03:00:00.123456+00:00",
}

let fetchCalls: string[]
function stubLookup(logs: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    fetchCalls.push(String(url))
    return new Response(JSON.stringify({ logs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mockedRecordFeeding.mockReset()
  localStorage.clear()
  fetchCalls = []
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PendingSavesNotice", () => {
  it("別タブが作成ID別の鍵へ残した控えもstorageイベントで拾い、その鍵の削除も反映する", async () => {
    seed()
    const key = pendingSaveKey(OWNER, ID)
    const raw = localStorage.getItem(key)!
    localStorage.removeItem(key)
    stubLookup([])
    render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(screen.queryByText(/ミルク 160ml/)).toBeNull()
    localStorage.setItem(key, raw)
    act(() => window.dispatchEvent(new StorageEvent("storage", { key })))
    expect(await screen.findByText(/ミルク 160ml/)).toBeInTheDocument()
    localStorage.removeItem(key)
    act(() => window.dispatchEvent(new StorageEvent("storage", { key })))
    await waitFor(() => expect(screen.queryByText(/ミルク 160ml/)).toBeNull())
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })

  it("無ければ何も出さず、照合の取得もせぬ", () => {
    stubLookup([])
    const { container } = render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(fetchCalls).toHaveLength(0)
  })

  it("開いた時に読みで照合し、見つかれば確定行を渡して畳む（送り直しはせぬ）", async () => {
    seed()
    stubLookup([STORED])
    const onConfirmed = vi.fn()
    render(<PendingSavesNotice owner={OWNER} onConfirmed={onConfirmed} />)
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(STORED))
    expect(fetchCalls[0]).toContain(`id=${ID}`)
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
    expect(listPendingSaves(OWNER)).toHaveLength(0)
  })

  it("見つからねば一覧に残り、押した時だけ同じ内容（同じ id）で送り直す", async () => {
    seed()
    stubLookup([])
    mockedRecordFeeding.mockResolvedValueOnce({ error: null, id: ID, log: STORED as never })
    const onConfirmed = vi.fn()
    render(<PendingSavesNotice owner={OWNER} onConfirmed={onConfirmed} />)
    expect(await screen.findByText(/ミルク 160ml/)).toBeInTheDocument()
    await waitFor(() => expect(fetchCalls).toHaveLength(1))
    expect(mockedRecordFeeding).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "同じ内容でもう一度送る" }))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledWith(STORED))
    expect(mockedRecordFeeding).toHaveBeenCalledWith({ feedingType: "bottle", amountMl: 160, clientId: ID })
    expect(screen.queryByText(/ミルク 160ml/)).toBeNull()
  })

  it("別の利用者・別の世帯の記録は出さぬ・照合もせぬ", async () => {
    seed({ userId: "u2", householdId: "h1" }, ID)
    seed({ userId: "u1", householdId: "h2" }, OTHER_ID)
    stubLookup([])
    const { container } = render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    expect(fetchCalls).toHaveLength(0)
  })

  it("画面に同じ id の行が入ったら（再取得・Realtime）記録済みとして畳む", async () => {
    seed()
    stubLookup([])
    const { rerender } = render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(await screen.findByText(/ミルク 160ml/)).toBeInTheDocument()
    rerender(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} knownLogIds={new Set([ID])} />)
    await waitFor(() => expect(screen.queryByText(/ミルク 160ml/)).toBeNull())
    expect(listPendingSaves(OWNER)).toHaveLength(0)
  })

  it("送り直しが拒まれても（ログイン切れ等）控えは消さず、理由と確かめ方を伝える（独立レビュー指摘）", async () => {
    seed()
    stubLookup([])
    mockedRecordFeeding.mockResolvedValueOnce({ error: "認証されていません", id: null, failure: "rejected" })
    render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "同じ内容でもう一度送る" }))
    await waitFor(() => expect(mockedRecordFeeding).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
        expect.stringContaining("認証されていません（前の送信が保存されたかは"),
      ),
    )
    expect(listPendingSaves(OWNER)).toHaveLength(1)
    expect(screen.getByText(/ミルク 160ml/)).toBeInTheDocument()
  })

  it("同じタブで後から残された記録も即座に一覧へ出る（storage イベントは書いたタブに届かぬ）", async () => {
    stubLookup([])
    render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(screen.queryByText(/ミルク 160ml/)).toBeNull()
    act(() => seed())
    expect(await screen.findByText(/ミルク 160ml/)).toBeInTheDocument()
  })

  it("同じページで送信中の記録は一覧に出さぬ（再読込の後の送信中の名残は結果不明として出す）", async () => {
    stubLookup([])
    putPendingSave({
      schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
      clientId: ID,
      owner: OWNER,
      action: "recordFeeding",
      payload: { feedingType: "bottle", amountMl: 160, clientId: ID },
      summary: "ミルク 160ml",
      firstAttemptAt: new Date().toISOString(),
      phase: "sending",
      pageId: PAGE_LIFE_ID,
    })
    const { container } = render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
    cleanup()
    localStorage.clear()
    putPendingSave({
      schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
      clientId: ID,
      owner: OWNER,
      action: "recordFeeding",
      payload: { feedingType: "bottle", amountMl: 160, clientId: ID },
      summary: "ミルク 160ml",
      firstAttemptAt: new Date().toISOString(),
      phase: "sending",
      pageId: "previous-page",
      // 本番の形: 送信中の控えは必ず sentAt を持つ（持たぬ形は NaN の分岐で出てしまい、
      // `filter(isAwaitingConfirmation)` の添字の取り違えを隠した。独立レビュー 3 周目 F1）
      sentAt: new Date(Date.now() - 70_000).toISOString(),
    })
    render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    expect(await screen.findByText(/ミルク 160ml/)).toBeInTheDocument()
    // 一覧に出すだけでなく、照合の読みもする
    await waitFor(() => expect(fetchCalls.some((u) => u.includes(ID))).toBe(true))
  })

  it("別のページで直近に送信中の控えは伏せ、猶予が切れたら出来事が無くても出して照合する（独立レビュー 3 周目 G3）", async () => {
    stubLookup([])
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const now = new Date("2026-10-28T03:00:00.000Z").getTime()
      vi.setSystemTime(now)
      putPendingSave({
        schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
        clientId: ID,
        owner: OWNER,
        action: "recordFeeding",
        payload: { feedingType: "bottle", amountMl: 160, clientId: ID },
        summary: "ミルク 160ml",
        firstAttemptAt: new Date(now - 10_000).toISOString(),
        phase: "sending",
        pageId: "previous-page",
        sentAt: new Date(now - 10_000).toISOString(),
      })
      render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
      // 送信の最中かもしれぬ間は伏せる（誤警告を出さぬ）
      expect(screen.queryByText(/ミルク 160ml/)).toBeNull()
      expect(fetchCalls).toHaveLength(0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(OTHER_TAB_SENDING_GRACE_MS)
      })
      expect(screen.getByText(/ミルク 160ml/)).toBeInTheDocument()
      expect(fetchCalls.some((u) => u.includes(ID))).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("「確認をやめる」は端末の記録だけを消す（送らぬ）", async () => {
    seed()
    stubLookup([])
    render(<PendingSavesNotice owner={OWNER} onConfirmed={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "確認をやめる" }))
    expect(listPendingSaves(OWNER)).toHaveLength(0)
    expect(mockedRecordFeeding).not.toHaveBeenCalled()
  })
})
