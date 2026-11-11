/**
 * 家事の保存の共通手順（useChoreSave + PendingChoreNotice）の契約。
 *
 * - 結果不明 → 画面を開き直しても、同じ操作 ID・同じ payload で確かめ直せる（新しい ID で作り直さぬ）
 * - 初回の拒否だけ控えを消す。再送の拒否では残す
 * - 自動では再送せぬ。控えが在る間は新しい操作を受けぬ
 * - unmount 後・持ち主の交代後に届いた応答は、今の画面へ適用せぬ
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CHORE_PENDING_PREFIX, listChorePending, putChorePending, type ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure, ChoreSaveSuccess } from "@/lib/domain/rpc-outcome"
import { PendingChoreNotice } from "../pending-chore-notice"
import { hasUnsavedInput, resetRefreshGateForTest, watchUnsavedInput } from "../refresh-gate"
import {
  CHORE_SAVE_MESSAGES,
  CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW,
  createChoreEditSessions,
  resetChoreSaveForTest,
  useChoreSave,
  type ChoreEditSessions,
  type ChoreSaveOutcome,
} from "../use-chore-save"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

const A: ChoreOwner = { userId: "d1000000-0000-4000-8000-00000000000a", householdId: "d1000000-0000-4000-8000-0000000000a1" }
const B: ChoreOwner = { userId: "d1000000-0000-4000-8000-00000000000b", householdId: "d1000000-0000-4000-8000-0000000000a1" }
const ROW = "d3000000-0000-4000-8000-000000000001"

type Payload = { id: string; name: string }
const isPayload = (value: unknown): value is Payload =>
  typeof value === "object" && value !== null && typeof (value as Payload).id === "string" && typeof (value as Payload).name === "string"

type Run = (payload: Payload) => Promise<ChoreSaveSuccess | ChoreSaveFailure>
const run = vi.fn<Run>()
const onOutcome = vi.fn<(outcome: ChoreSaveOutcome<Payload, ChoreSaveSuccess>) => void>()

function Harness({ owner, label = "浴室の掃除を完了" }: { owner: ChoreOwner; label?: string }) {
  const save = useChoreSave<Payload>({ owner, kind: "cleaning", run, isPayload, onOutcome })
  return (
    <div>
      <button type="button" disabled={save.blocked} onClick={() => save.send({ id: ROW, name: "浴室" }, label)}>
        完了にする
      </button>
      <span data-testid="ready">{String(save.ready)}</span>
      <PendingChoreNotice save={save} />
    </div>
  )
}

const choreKeys = () => Object.keys(localStorage).filter((k) => k.startsWith(CHORE_PENDING_PREFIX))
const sendButton = () => screen.getByRole("button", { name: "完了にする" })
async function ready() {
  await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"))
}
async function clickSend() {
  await act(async () => {
    fireEvent.click(sendButton())
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
  resetChoreSaveForTest()
  resetRefreshGateForTest()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("useChoreSave: 編集セッション（R35。応答は送ったシートにだけ効く）", () => {
  function SessionHarness({ sessions }: { sessions: ChoreEditSessions }) {
    const save = useChoreSave<Payload>({ owner: A, kind: "cleaning", run, isPayload, onOutcome, sessions })
    return (
      <div>
        <button
          type="button"
          disabled={save.blocked}
          onClick={() => save.send({ id: ROW, name: "浴室" }, "浴室の掃除を完了", sessions.current())}
        >
          完了にする
        </button>
        <span data-testid="ready">{String(save.ready)}</span>
        <span data-testid="message">{save.message}</span>
        <input aria-label="打ちかけの入力" defaultValue="" />
        <PendingChoreNotice save={save} showMessage={false} />
      </div>
    )
  }

  it("送った後に別のシートを開いた応答: 宛先は「今のシートではない」。文言を出さず、触れた入力欄の記憶も捨てぬ。控えの確定と取り直しは行う", async () => {
    const stopWatching = watchUnsavedInput()
    const sessions = createChoreEditSessions()
    const sent = sessions.begin()
    const pending = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(pending.promise)
    render(<SessionHarness sessions={sessions} />)
    await ready()
    await clickSend()
    // 応答の前に、送ったシートを閉じて別のシートを開き、打ち始める
    sessions.close()
    const reopened = sessions.begin()
    fireEvent.input(screen.getByLabelText("打ちかけの入力"), { target: { value: "打ちかけ" } })
    expect(hasUnsavedInput()).toBe(true)

    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1))
    expect(onOutcome.mock.calls[0][0].origin).toEqual({
      session: sent,
      place: sent,
      current: false,
      inPlace: false,
      label: "浴室の掃除を完了",
    })
    expect(reopened).not.toBe(sent)
    expect(hasUnsavedInput()).toBe(true)
    expect(screen.getByTestId("message")).toHaveTextContent("")
    // DB で確定した事実は扱う: 控えは消え、Server の内容を取り直す
    expect(choreKeys()).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    stopWatching()
  })

  it("対照: 送ったシートが開いたままの応答は、今のシートのもの。文言を出し、触れた入力欄の記憶を捨てる", async () => {
    const stopWatching = watchUnsavedInput()
    const sessions = createChoreEditSessions()
    const sent = sessions.begin()
    run.mockResolvedValueOnce({ status: "saved" })
    render(<SessionHarness sessions={sessions} />)
    await ready()
    fireEvent.input(screen.getByLabelText("打ちかけの入力"), { target: { value: "打ちかけ" } })
    await clickSend()
    await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved))
    expect(onOutcome.mock.calls[0][0].origin).toMatchObject({ session: sent, current: true, inPlace: true })
    expect(hasUnsavedInput()).toBe(false)
    stopWatching()
  })

  it("同じ操作で確認（再送）は、どのシートの送信でもない（送ったシートが開いたままでも閉じる宛先にせぬ）。文言は押した場所に出す", async () => {
    const sessions = createChoreEditSessions()
    const sent = sessions.begin()
    run.mockRejectedValueOnce(new Error("synthetic lost response"))
    render(<SessionHarness sessions={sessions} />)
    await ready()
    await clickSend()
    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(onOutcome.mock.calls[0][0]).toMatchObject({ kind: "unknown", origin: { session: sent, current: true } })

    run.mockResolvedValueOnce({ status: "replayed" })
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(2))
    expect(onOutcome.mock.calls[1][0].origin).toEqual({
      session: undefined,
      place: sent,
      current: false,
      inPlace: true,
      label: "浴室の掃除を完了",
    })
    expect(screen.getByTestId("message")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved)
  })

  it("対照: 番号札を渡さぬ画面（献立など）は、全ての応答を今の画面のものとして扱い、宛先を載せぬ", async () => {
    run.mockResolvedValueOnce({ status: "saved" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await waitFor(() => expect(onOutcome).toHaveBeenCalledTimes(1))
    expect(onOutcome.mock.calls[0][0].origin).toBeUndefined()
    expect(screen.getByRole("status")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved)
  })
})

describe("useChoreSave: 結果不明と再送", () => {
  it("応答を失っても、開き直した画面から同じ操作 ID・同じ payload で確かめ直せる", async () => {
    run.mockRejectedValueOnce(new Error("synthetic lost response"))
    const first = render(<Harness owner={A} />)
    await ready()
    await clickSend()

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CHORE_SAVE_MESSAGES.unknown))
    const frozen = run.mock.calls[0][0]
    expect(frozen).toEqual({ id: ROW, name: "浴室" })
    const keysAfterFirst = choreKeys()
    expect(keysAfterFirst).toHaveLength(1)
    expect(listChorePending(A, "cleaning").items[0]).toMatchObject({ phase: "unknown", label: "浴室の掃除を完了", payload: frozen })
    expect(onOutcome).toHaveBeenLastCalledWith({ kind: "unknown", payload: frozen })
    // 結果不明の間は新しい操作を受けぬ
    expect(sendButton()).toBeDisabled()
    first.unmount()

    render(<Harness owner={A} />)
    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(screen.getByText("浴室の掃除を完了")).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    // 自動では再送せぬ（開き直しただけでは Action を呼ばぬ）
    expect(run).toHaveBeenCalledTimes(1)

    run.mockResolvedValueOnce({ status: "replayed" })
    await act(async () => {
      fireEvent.click(confirm)
    })

    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    expect(run.mock.calls[1][0]).toEqual(frozen)
    await waitFor(() => expect(choreKeys()).toEqual([]))
    // 操作 ID（控えの鍵）は再送の間も同じじゃった = 新しい ID で作り直しておらぬ
    expect(keysAfterFirst[0]).toContain(`:cleaning:`)
    expect(screen.queryByRole("button", { name: "同じ操作で確認" })).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(onOutcome).toHaveBeenLastCalledWith({
      kind: "settled",
      status: "replayed",
      result: { status: "replayed" },
      payload: frozen,
    })
  })

  it("再送の間、端末の控えの鍵（操作 ID）は変わらぬ", async () => {
    run.mockRejectedValueOnce(new Error("lost")).mockRejectedValueOnce(new Error("lost again"))
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    const before = choreKeys()
    await act(async () => {
      fireEvent.click(confirm)
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2))
    await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(choreKeys()).toEqual(before)
    expect(run.mock.calls[1][0]).toEqual(run.mock.calls[0][0])
  })

  it("初回の拒否は保存されておらぬと確定するゆえ控えを消し、理由を出す", async () => {
    run.mockResolvedValueOnce({ error: "名前を入力してください。", failure: "rejected" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("名前を入力してください。"))
    expect(choreKeys()).toEqual([])
    expect(sendButton()).toBeEnabled()
    expect(refresh).not.toHaveBeenCalled()
    expect(onOutcome).toHaveBeenLastCalledWith({ kind: "rejected", error: "名前を入力してください。", payload: { id: ROW, name: "浴室" } })
  })

  it("再送の拒否では控えを残す（先の送信が成立しておるかもしれぬ）。破棄は 2 段の明示操作だけ", async () => {
    run.mockRejectedValueOnce(new Error("lost")).mockResolvedValueOnce({ error: "認証されていません。", failure: "rejected" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    const confirm = await screen.findByRole("button", { name: "同じ操作で確認" })
    // 対照: 再送が拒否される前は破棄の釦を出さぬ
    expect(screen.queryByRole("button", { name: "控えを破棄" })).not.toBeInTheDocument()
    await act(async () => {
      fireEvent.click(confirm)
    })

    const discard = await screen.findByRole("button", { name: "控えを破棄" })
    expect(choreKeys()).toHaveLength(1)
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/認証されていません。.*保存されている場合があります/)).toBeInTheDocument()

    fireEvent.click(discard)
    // 1 段目では消えぬ
    expect(choreKeys()).toHaveLength(1)
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    await waitFor(() => expect(choreKeys()).toEqual([]))
    expect(sendButton()).toBeEnabled()
  })

  it("conflict は確定した応答（上書きしておらぬ）。控えを消し、読み直しを促す", async () => {
    run.mockResolvedValueOnce({ status: "conflict" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CHORE_SAVE_MESSAGES.conflict))
    expect(choreKeys()).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("形の読めぬ応答は成功とも拒否とも扱わず、結果不明として控えを残す", async () => {
    run.mockResolvedValueOnce({ ok: true } as unknown as ChoreSaveSuccess)
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await screen.findByRole("button", { name: "同じ操作で確認" })
    expect(choreKeys()).toHaveLength(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it("保存できた時は控えを残さず、Server の内容を取り直す", async () => {
    run.mockResolvedValueOnce({ status: "saved" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved))
    expect(choreKeys()).toEqual([])
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("button", { name: "同じ操作で確認" })).not.toBeInTheDocument()
  })

  it("端末へ控えを残せなくても送信は続け、警告を出す", async () => {
    const pending = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(pending.promise)
    render(<Harness owner={A} />)
    await ready()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    await clickSend()
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CHORE_SAVE_MESSAGES.storageFailed))
    expect(run).toHaveBeenCalledTimes(1)
    await act(async () => {
      pending.resolve({ status: "saved" })
    })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved))
  })
})

describe("useChoreSave: 持ち主と遅れて届いた応答", () => {
  it("持ち主が替わった後に届いた古い応答は、今の持ち主の画面へ適用せぬ", async () => {
    const late = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(late.promise)
    const view = render(<Harness owner={A} />)
    await ready()
    await clickSend()
    expect(run).toHaveBeenCalledTimes(1)

    view.rerender(<Harness owner={B} />)
    await ready()
    // B の画面は A の控えを出さぬ
    expect(screen.queryByText("浴室の掃除を完了")).not.toBeInTheDocument()

    await act(async () => {
      late.resolve({ status: "saved" })
    })

    expect(onOutcome).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.queryByText(CHORE_SAVE_MESSAGES.saved)).not.toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(listChorePending(B).items).toEqual([])
    await waitFor(() => expect(sendButton()).toBeEnabled())
  })

  it("対照: 持ち主が替わらねば、同じ遅い応答は画面へ適用される", async () => {
    const late = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(late.promise)
    const view = render(<Harness owner={A} />)
    await ready()
    await clickSend()
    view.rerender(<Harness owner={{ ...A }} />)
    await act(async () => {
      late.resolve({ status: "saved" })
    })
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(CHORE_SAVE_MESSAGES.saved))
    expect(onOutcome).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("別の持ち主の控えは表示も再送もせぬ（今の持ち主は塞がれぬ）", async () => {
    putChorePending({
      schema: 1,
      id: "d2000000-0000-4000-8000-000000000009",
      owner: B,
      kind: "cleaning",
      label: "B の操作",
      payload: { id: ROW, name: "B の部屋" },
      phase: "unknown",
      firstAttemptAt: "2026-11-11T00:00:00.000Z",
    })
    render(<Harness owner={A} />)
    await ready()
    expect(screen.queryByText("B の操作")).not.toBeInTheDocument()
    expect(sendButton()).toBeEnabled()
    // 対照: B 自身には出る
    cleanup()
    render(<Harness owner={B} />)
    expect(await screen.findByText("B の操作")).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })

  it("画面を離れた後に届いた応答では、通知も再描画もせぬ。確定の成功だけ、その操作の控えを片付ける", async () => {
    const late = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(late.promise)
    const view = render(<Harness owner={A} />)
    await ready()
    await clickSend()
    expect(choreKeys()).toHaveLength(1)
    view.unmount()
    await act(async () => {
      late.resolve({ status: "saved" })
    })
    expect(onOutcome).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(choreKeys()).toEqual([])
  })

  it("対照: 画面を離れた後に届いた失敗・衝突では控えを残す（戻った時に確かめ直せる）", async () => {
    for (const settle of [
      (d: ReturnType<typeof deferred<ChoreSaveSuccess | ChoreSaveFailure>>) => d.reject(new Error("lost")),
      (d: ReturnType<typeof deferred<ChoreSaveSuccess | ChoreSaveFailure>>) => d.resolve({ error: "x", failure: "rejected" }),
      (d: ReturnType<typeof deferred<ChoreSaveSuccess | ChoreSaveFailure>>) => d.resolve({ status: "conflict" }),
    ]) {
      localStorage.clear()
      const late = deferred<ChoreSaveSuccess | ChoreSaveFailure>()
      run.mockReturnValueOnce(late.promise)
      const view = render(<Harness owner={A} />)
      await ready()
      await clickSend()
      view.unmount()
      await act(async () => {
        settle(late)
      })
      expect(choreKeys()).toHaveLength(1)
      expect(onOutcome).not.toHaveBeenCalled()
    }
  })
})

describe("useChoreSave: 送信中に画面を移った操作（R39）", () => {
  const CONFIRM = { name: "同じ操作で確認" }
  const HEADING = "保存できたか確認できていない操作"

  it("この文書で送信中の操作は、移った先の画面に「確認できていない」と出さぬ。確定したら塞ぎを解く", async () => {
    const late = deferred<ChoreSaveSuccess>()
    run.mockReturnValueOnce(late.promise)
    const first = render(<Harness owner={A} />)
    await ready()
    await clickSend()
    first.unmount()

    // 移った先（同じ持ち主・同じ種類の別の実体）
    render(<Harness owner={A} />)
    await ready()
    expect(screen.queryByText(HEADING)).not.toBeInTheDocument()
    expect(screen.queryByRole("button", CONFIRM)).not.toBeInTheDocument()
    // 送信中の間は新しい操作を受けぬ（順序を守る）
    expect(sendButton()).toBeDisabled()

    await act(async () => {
      late.resolve({ status: "saved" })
    })
    await waitFor(() => expect(sendButton()).toBeEnabled())
    expect(choreKeys()).toEqual([])
    expect(screen.queryByText(HEADING)).not.toBeInTheDocument()
    // 自動では再送しておらぬ。確定した内容は取り直す
    expect(run).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    // 前の画面の通知は呼ばぬ
    expect(onOutcome).not.toHaveBeenCalled()
  })

  it("対照: 送信が結果不明・拒否で終われば、移った先の画面に確認待ちとして出す（塞いだまま）", async () => {
    for (const settle of [
      (d: ReturnType<typeof deferred<ChoreSaveSuccess | ChoreSaveFailure>>) => d.reject(new Error("lost")),
      (d: ReturnType<typeof deferred<ChoreSaveSuccess | ChoreSaveFailure>>) => d.resolve({ error: "x", failure: "rejected" }),
    ]) {
      cleanup()
      localStorage.clear()
      const late = deferred<ChoreSaveSuccess | ChoreSaveFailure>()
      run.mockReturnValueOnce(late.promise)
      const first = render(<Harness owner={A} />)
      await ready()
      await clickSend()
      first.unmount()
      render(<Harness owner={A} />)
      await ready()
      expect(screen.queryByRole("button", CONFIRM)).not.toBeInTheDocument()
      await act(async () => {
        settle(late)
      })
      expect(await screen.findByRole("button", CONFIRM)).toBeInTheDocument()
      expect(choreKeys()).toHaveLength(1)
      expect(sendButton()).toBeDisabled()
    }
  })

  it("対照: 前の文書が送信中のまま終わった控え（今は誰も送っておらぬ）は、開いた時から確認待ちとして出す", async () => {
    putChorePending({
      schema: 1,
      id: "d2000000-0000-4000-8000-000000000011",
      owner: A,
      kind: "cleaning",
      label: "浴室の掃除を完了",
      payload: { id: ROW, name: "浴室" },
      phase: "sending",
      firstAttemptAt: new Date().toISOString(),
    })
    render(<Harness owner={A} />)
    expect(await screen.findByRole("button", CONFIRM)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })

  it("別のタブが確定して端末から消した控えは、storage の合図で外す（対照: 残っておる控えは外さぬ）", async () => {
    run.mockRejectedValueOnce(new Error("lost"))
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await screen.findByRole("button", CONFIRM)
    const key = choreKeys()[0]

    // 対照: 控えが端末に残っておる間の合図では外さぬ
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key }))
    })
    expect(screen.getByRole("button", CONFIRM)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    // 対照: 家事の控えではない鍵の合図では読み直さぬ
    localStorage.removeItem(key)
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "irori:other" }))
    })
    expect(screen.getByRole("button", CONFIRM)).toBeInTheDocument()

    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key }))
    })
    await waitFor(() => expect(screen.queryByRole("button", CONFIRM)).not.toBeInTheDocument())
    expect(sendButton()).toBeEnabled()
    // 読み直しは送らぬ
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("端末に残せておらぬ控え（この画面にしか無い）は、読み直しで外さぬ", async () => {
    run.mockRejectedValueOnce(new Error("lost"))
    render(<Harness owner={A} />)
    await ready()
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    await clickSend()
    await screen.findByRole("button", CONFIRM)
    setItem.mockRestore()
    expect(choreKeys()).toEqual([])
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: null }))
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(screen.getByRole("button", CONFIRM)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
  })
})

describe("useChoreSave: 説明の長さ（R40）", () => {
  it("絵文字の多い長い説明でも保存を拒まず、控えには上限内へ切り詰めた説明を残す", async () => {
    run.mockRejectedValueOnce(new Error("lost"))
    // 符号位置では 46 字、UTF-16 では 86（切り詰める前は控えの上限 80 を超える）
    const label = `${"🧹".repeat(40)}の掃除を完了`
    expect([...label]).toHaveLength(46)
    expect(label.length).toBeGreaterThan(80)
    render(<Harness owner={A} label={label} />)
    await ready()
    await clickSend()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toEqual({ id: ROW, name: "浴室" })
    await screen.findByRole("button", { name: "同じ操作で確認" })
    const stored = listChorePending(A, "cleaning").items[0]
    expect(stored.label.length).toBeLessThanOrEqual(80)
    expect(stored.label.startsWith("🧹🧹🧹")).toBe(true)
    expect(stored.label.endsWith("…")).toBe(true)
    // 代理対の途中で切っておらぬ
    expect(stored.label.isWellFormed()).toBe(true)
    expect(screen.queryByText(CHORE_SAVE_MESSAGES.invalid)).not.toBeInTheDocument()
  })

  it("対照: 空白だけの説明は不正として送らぬ", async () => {
    render(<Harness owner={A} label="   " />)
    await ready()
    await clickSend()
    expect(run).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(CHORE_SAVE_MESSAGES.invalid)
    expect(choreKeys()).toEqual([])
  })
})

describe("useChoreSave: 結果不明が続く控えの出口（R41）", () => {
  const CONFIRM = { name: "同じ操作で確認" }
  const WITHDRAW = { name: "確認をやめる" }

  async function retryOnce() {
    const before = run.mock.calls.length
    await act(async () => {
      fireEvent.click(screen.getByRole("button", CONFIRM))
    })
    await waitFor(() => expect(run).toHaveBeenCalledTimes(before + 1))
    await screen.findByRole("button", CONFIRM)
  }

  it("通信できる状態での確認が続けて結果不明に終わった後にだけ、警告つき 2 段の取り下げを出す", async () => {
    run.mockRejectedValue(new Error("lost"))
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await screen.findByRole("button", CONFIRM)
    // 対照: 最初の結果不明・確認が足りぬ間は出さぬ
    expect(screen.queryByRole("button", WITHDRAW)).not.toBeInTheDocument()
    for (let i = 1; i < CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW; i++) {
      await retryOnce()
      expect(screen.queryByRole("button", WITHDRAW)).not.toBeInTheDocument()
    }
    await retryOnce()
    const keys = choreKeys()
    expect(keys).toHaveLength(1)

    fireEvent.click(await screen.findByRole("button", WITHDRAW))
    // 1 段目では消さず、操作は取り消されぬこと・二重になりうることを伝える
    expect(choreKeys()).toEqual(keys)
    const warning = screen.getByText(/確認をやめると、この端末の控えだけを消します/)
    expect(warning).toHaveTextContent("操作そのものは取り消されません")
    expect(warning).toHaveTextContent("同じ操作をやり直す前に、必ず画面の内容で保存済みかを確かめてください")
    expect(warning).toHaveTextContent("二重に記録されることがあります")
    // やめれば控えは残る
    fireEvent.click(screen.getByRole("button", { name: "やめる" }))
    expect(choreKeys()).toEqual(keys)
    expect(sendButton()).toBeDisabled()

    fireEvent.click(screen.getByRole("button", WITHDRAW))
    refresh.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "控えを消して確認をやめる" }))
    await waitFor(() => expect(choreKeys()).toEqual([]))
    expect(sendButton()).toBeEnabled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORE_SAVE_MESSAGES.discarded)
    // 取り下げは送らぬ（同じ操作を新しい ID で送り直したりせぬ）
    expect(run).toHaveBeenCalledTimes(1 + CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW)
    for (const call of run.mock.calls) expect(call[0]).toEqual(run.mock.calls[0][0])
  })

  it("取り下げた後は Server の内容を取り直す（保存済みかを画面で確かめられるように）", async () => {
    run
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce({ error: "認証されていません。", failure: "rejected" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await retryOnce()
    refresh.mockClear()
    fireEvent.click(await screen.findByRole("button", { name: "控えを破棄" }))
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    await waitFor(() => expect(choreKeys()).toEqual([]))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("対照: 圏外での確認は数えぬ（通信できる場所で確かめる余地が在る間は、取り下げへ誘導せぬ）", async () => {
    run.mockRejectedValue(new Error("lost"))
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await screen.findByRole("button", CONFIRM)
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    for (let i = 0; i < CHORE_UNKNOWN_RETRIES_BEFORE_WITHDRAW + 1; i++) await retryOnce()
    expect(screen.queryByRole("button", WITHDRAW)).not.toBeInTheDocument()
    expect(choreKeys()).toHaveLength(1)
  })

  it("対照: 再送が拒否された控えには、従来どおり「控えを破棄」を出す（「確認をやめる」は出さぬ）", async () => {
    run
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"))
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce({ error: "認証されていません。", failure: "rejected" })
    render(<Harness owner={A} />)
    await ready()
    await clickSend()
    await retryOnce()
    await retryOnce()
    expect(screen.getByRole("button", WITHDRAW)).toBeInTheDocument()
    await retryOnce()
    expect(screen.getByRole("button", { name: "控えを破棄" })).toBeInTheDocument()
    expect(screen.queryByRole("button", WITHDRAW)).not.toBeInTheDocument()
  })
})

describe("useChoreSave: 読めぬ控え", () => {
  it("型ガードに落ちる控え・壊れた控えが在る間は新しい操作を止め、明示の破棄で解ける", async () => {
    putChorePending({
      schema: 1,
      id: "d2000000-0000-4000-8000-000000000008",
      owner: A,
      kind: "cleaning",
      label: "古い形の操作",
      payload: { legacy: true },
      phase: "unknown",
      firstAttemptAt: "2026-11-11T00:00:00.000Z",
    })
    localStorage.setItem(`${CHORE_PENDING_PREFIX}${A.userId}:${A.householdId}:cleaning:d2000000-0000-4000-8000-000000000007`, "{not json")
    render(<Harness owner={A} />)
    await ready()
    expect(screen.getByText(/読み取れない保存の控えが 2 件/)).toBeInTheDocument()
    expect(sendButton()).toBeDisabled()
    // 読めぬ控えは再送の対象に出さぬ
    expect(screen.queryByRole("button", { name: "同じ操作で確認" })).not.toBeInTheDocument()
    expect(run).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "読み取れない控えを破棄" }))
    expect(choreKeys()).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: "破棄する" }))
    await waitFor(() => expect(choreKeys()).toEqual([]))
    expect(sendButton()).toBeEnabled()
  })

  it("別の種類（ごはん）の壊れた控えは、掃除の操作を塞がぬ", async () => {
    localStorage.setItem(`${CHORE_PENDING_PREFIX}${A.userId}:${A.householdId}:meal:d2000000-0000-4000-8000-000000000007`, "{not json")
    render(<Harness owner={A} />)
    await ready()
    expect(sendButton()).toBeEnabled()
  })
})
