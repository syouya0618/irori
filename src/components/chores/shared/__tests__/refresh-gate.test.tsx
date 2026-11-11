/**
 * 家事の再取得の門（R04）。`router.refresh()` は取得に失敗するとハードナビゲーションへ倒れ、
 * `/chores/*` では画面と未保存の入力が /offline に置き換わる。ゆえに:
 *
 * - 圏外では呼ばぬ（復帰・focus・定期・押下のどれでも）
 * - サーバーへ届くことを直近に確かめておらねば、軽い GET で先に確かめ、届かねば呼ばぬ
 * - 自動の再取得は、シートが開いている・入力の途中・保存の送信中は見送る（押下は見送らぬ）
 *
 * どの述語にも、偽になる対照（届く・入力なし・押下）を置く。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const refresh = vi.fn()
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import {
  REACHABLE_FRESH_MS,
  REFRESH_PROBE_TIMEOUT_MS,
  REFRESH_PROBE_URL,
  automaticRefreshHold,
  isServerReachabilityFresh,
  noteServerReachable,
  probeServer,
  resetRefreshGateForTest,
  setChoreSaveBusy,
} from "../refresh-gate"
import { RefreshOnVisible } from "../refresh-on-visible"
import { SectionError } from "../section-error"
import { CHORES_REFRESH_MESSAGES } from "../use-chores-refresh"

const fetchMock = vi.fn<typeof fetch>()
const ok = () => new Response("{}", { status: 200 })

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
}
function setOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online)
}
/** 「サーバーへ届いた証拠が古い」状態にする（mount が残した証拠を消す）。 */
function staleEvidence() {
  resetRefreshGateForTest()
}
async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  resetRefreshGateForTest()
  vi.stubGlobal("fetch", fetchMock)
  setVisibility("visible")
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ""
})

describe("圏外（navigator.onLine === false）", () => {
  it("復帰・focus・定期・押下のどれでも router.refresh を呼ばず、理由を出す", async () => {
    vi.useFakeTimers()
    render(<RefreshOnVisible pollMs={30_000} />)
    setOnline(false)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    expect(refresh).not.toHaveBeenCalled()
    // 圏外では確かめの要求も出さぬ
    expect(fetchMock).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.offline)
  })

  it("対照: 回線が戻れば（online）確かめてから取り直し、理由を消す", async () => {
    render(<RefreshOnVisible />)
    staleEvidence()
    setOnline(false)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.offline)

    setOnline(true)
    fetchMock.mockResolvedValueOnce(ok())
    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("区画の「もう一度読み込む」も圏外では呼ばず、理由を出す（対照: 届く時は呼ぶ）", () => {
    render(<SectionError what="買い物リスト" />)
    setOnline(false)
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent(CHORES_REFRESH_MESSAGES.offline)
    setOnline(true)
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe("onLine=true のまま要求だけ落ちる回線", () => {
  it("確かめの GET が reject したら router.refresh を呼ばず、理由を出す", async () => {
    render(<RefreshOnVisible />)
    staleEvidence()
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe(REFRESH_PROBE_URL)
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store", redirect: "manual" })
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.unreachable)
  })

  it("5xx でも呼ばぬ（Next は 5xx の RSC もハードナビゲーションへ倒す）", async () => {
    render(<RefreshOnVisible />)
    staleEvidence()
    fetchMock.mockResolvedValueOnce(new Response("", { status: 503 }))
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    await flush()
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.unreachable)
  })

  it("対照: 確かめが通れば 1 回だけ呼ぶ。確かめ中に重ねた合図は並べぬ", async () => {
    let resolveProbe!: (res: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveProbe = resolve)))
    render(<RefreshOnVisible />)
    staleEvidence()
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
    await act(async () => {
      resolveProbe(ok())
    })
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("直近にサーバーへ届いておれば確かめ直さぬ（mount の直後・保存の直後）。鮮度を過ぎれば確かめる", async () => {
    vi.useFakeTimers()
    render(<RefreshOnVisible />)
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalled()

    await act(() => vi.advanceTimersByTimeAsync(REACHABLE_FRESH_MS))
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("画面を離れた後に通った確かめでは呼ばぬ", async () => {
    let resolveProbe!: (res: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveProbe = resolve)))
    const view = render(<RefreshOnVisible />)
    staleEvidence()
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    view.unmount()
    await act(async () => {
      resolveProbe(ok())
    })
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("probeServer", () => {
  it("throw せず、届かぬ・5xx・期限切れ・中断は false、200 と未ログインの redirect は true", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(probeServer()).resolves.toBe(false)
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }))
    await expect(probeServer()).resolves.toBe(false)
    fetchMock.mockResolvedValueOnce(ok())
    await expect(probeServer()).resolves.toBe(true)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 0, type: "opaqueredirect" } as Response)
    await expect(probeServer()).resolves.toBe(true)

    const aborted = new AbortController()
    aborted.abort()
    await expect(probeServer(aborted.signal)).resolves.toBe(false)

    vi.useFakeTimers()
    fetchMock.mockImplementationOnce(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        }),
    )
    const hanging = probeServer()
    await vi.advanceTimersByTimeAsync(REFRESH_PROBE_TIMEOUT_MS)
    await expect(hanging).resolves.toBe(false)
  })
})

describe("サーバーへ届いた証拠の鮮度", () => {
  it("記録が無い・古い・時計が巻き戻った時は鮮度なし", () => {
    expect(isServerReachabilityFresh(1_000)).toBe(false)
    noteServerReachable(1_000)
    expect(isServerReachabilityFresh(1_000 + REACHABLE_FRESH_MS - 1)).toBe(true)
    expect(isServerReachabilityFresh(1_000 + REACHABLE_FRESH_MS)).toBe(false)
    expect(isServerReachabilityFresh(999)).toBe(false)
  })
})

describe("自動の再取得の見送り（未保存の入力を守る）", () => {
  it("シートが開いている間は自動では呼ばず、理由を出す。押下は見送らぬ", () => {
    render(
      <>
        <div role="dialog" aria-label="食材を編集" />
        <RefreshOnVisible />
      </>,
    )
    expect(automaticRefreshHold()).toBe("editing")
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.held)
    expect(screen.getByRole("status")).toHaveTextContent("「今すぐ更新」で読み直せます。")
    fireEvent.click(screen.getByRole("button", { name: "今すぐ更新" }))
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("入力の途中（触れて値が残っている欄）は見送り、空に戻す・欄が閉じれば再開する", () => {
    function Form({ open }: { open: boolean }) {
      return (
        <>
          {open && <textarea aria-label="まとめ入力" defaultValue="" />}
          <RefreshOnVisible />
        </>
      )
    }
    const view = render(<Form open />)
    const visible = () =>
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"))
      })
    // 対照: 触れておらぬ欄は入力の途中に数えぬ
    visible()
    expect(refresh).toHaveBeenCalledTimes(1)

    const box = screen.getByLabelText("まとめ入力")
    fireEvent.input(box, { target: { value: "玉ねぎ 2個" } })
    expect(automaticRefreshHold()).toBe("editing")
    visible()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.held)

    fireEvent.input(box, { target: { value: "" } })
    expect(automaticRefreshHold()).toBeNull()
    visible()
    expect(refresh).toHaveBeenCalledTimes(2)

    fireEvent.input(box, { target: { value: "卵" } })
    expect(automaticRefreshHold()).toBe("editing")
    view.rerender(<Form open={false} />)
    expect(automaticRefreshHold()).toBeNull()
  })

  it("保存の送信中・端末に残せておらぬ控えが在る間（useChoreSave の旗）は見送る", () => {
    const token = {}
    render(<RefreshOnVisible />)
    setChoreSaveBusy(token, true)
    expect(automaticRefreshHold()).toBe("saving")
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).not.toHaveBeenCalled()
    setChoreSaveBusy(token, false)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("paused を渡した画面は自動では呼ばぬ（対照: 渡さねば呼ぶ）", () => {
    const view = render(<RefreshOnVisible paused />)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).not.toHaveBeenCalled()
    view.rerender(<RefreshOnVisible />)
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("確かめておる間に入力が始まれば、通った後でも自動では呼ばぬ", async () => {
    let resolveProbe!: (res: Response) => void
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (resolveProbe = resolve)))
    render(
      <>
        <input aria-label="メモ" defaultValue="" />
        <RefreshOnVisible />
      </>,
    )
    staleEvidence()
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    fireEvent.input(screen.getByLabelText("メモ"), { target: { value: "牛乳は低脂肪" } })
    await act(async () => {
      resolveProbe(ok())
    })
    await flush()
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByRole("status")).toHaveTextContent(CHORES_REFRESH_MESSAGES.held)
  })
})
