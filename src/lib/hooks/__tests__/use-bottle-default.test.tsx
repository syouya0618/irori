/**
 * useBottleDefault（いつものミルク量の取り直し）。
 *
 * 守る契約:
 * - 初期値はサーバの値で一度だけ seed し、マウント・画面復帰で取り直す（夫婦の別端末の変更が届く）
 * - session が無い・失敗・行が見えぬ時は表示を変えぬ（決めてある量を「取得失敗」「未設定」に化けさせぬ）
 * - 保存の反映（apply）より前に始まった取り直しの結果は捨てる（保存の後に古い量へ戻らぬ）
 * - 別の端末で量が変わっていたら知らせる（1 タップで記録される量が黙って変わらぬ）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor, cleanup } from "@testing-library/react"

type QueryResult = { data: unknown; error: unknown }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const getSession = vi.fn()
const maybeSingle = vi.fn()
const signals: AbortSignal[] = []
const eqCalls: unknown[][] = []

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { getSession: () => getSession() },
    from: (table: string) => {
      if (table !== "households") throw new Error(`unexpected table ${table}`)
      const chain = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          eqCalls.push([col, value])
          return chain
        },
        abortSignal: (signal: AbortSignal) => {
          signals.push(signal)
          return chain
        },
        maybeSingle: () => maybeSingle(),
      }
      return chain
    },
  }),
}))
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

import { BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS, useBottleDefault } from "../use-bottle-default"
import { toast } from "sonner"
import type { BottleDefaultState } from "@/lib/domain/bottle-default"

const mockedToast = vi.mocked(toast)
const SESSION = { data: { session: { access_token: "t" } }, error: null }

beforeEach(() => {
  getSession.mockReset()
  maybeSingle.mockReset()
  mockedToast.info.mockReset()
  signals.length = 0
  eqCalls.length = 0
  getSession.mockResolvedValue(SESSION)
})
afterEach(cleanup)

function render(initial: BottleDefaultState) {
  return renderHook(({ init }) => useBottleDefault("house-1", init), {
    initialProps: { init: initial },
  })
}

describe("useBottleDefault の取り直し", () => {
  it("サーバの値で seed し、マウント時に自世帯の行を取り直す", async () => {
    maybeSingle.mockResolvedValue({ data: { bottle_default_ml: 120 }, error: null })
    const { result } = render({ status: "set", amountMl: 120 })
    expect(result.current.state).toEqual({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))
    expect(eqCalls).toContainEqual(["id", "house-1"])
    // 同じ量なら知らせぬ
    expect(mockedToast.info).not.toHaveBeenCalled()
  })

  it("夫婦の別端末で 160 へ変えていたら、取り直しで 160 になり知らせる", async () => {
    maybeSingle.mockResolvedValue({ data: { bottle_default_ml: 160 }, error: null })
    const { result } = render({ status: "set", amountMl: 120 })
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "set", amountMl: 160 }),
    )
    expect(mockedToast.info).toHaveBeenCalledWith(
      "いつものミルク量が別の端末で160mlに変更されました",
    )
  })

  it("画面復帰（visibilitychange）で取り直し、別端末の変更が届く", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: null }, error: null })
    const { result } = render({ status: "unset" })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))
    expect(result.current.state).toEqual({ status: "unset" })

    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: 140 }, error: null })
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "set", amountMl: 140 }),
    )
    expect(mockedToast.info).toHaveBeenCalledTimes(1)
  })

  it("読めていなかった（error）状態からの回復は知らせずに量を出す", async () => {
    maybeSingle.mockResolvedValue({ data: { bottle_default_ml: 120 }, error: null })
    const { result } = render({ status: "error" })
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "set", amountMl: 120 }),
    )
    expect(mockedToast.info).not.toHaveBeenCalled()
  })
})

describe("useBottleDefault は失敗で決めてある量を消さぬ", () => {
  it("session が無い（anon の 0 行の手前）なら問い合わせず、表示も変えぬ", async () => {
    getSession.mockResolvedValue({ data: { session: null }, error: null })
    const { result } = render({ status: "set", amountMl: 120 })
    await act(async () => {
      expect(await result.current.refetch()).toBeNull()
    })
    expect(maybeSingle).not.toHaveBeenCalled()
    expect(result.current.state).toEqual({ status: "set", amountMl: 120 })
  })

  it("問い合わせの失敗・行が見えぬ応答は null を返し、今の量を保つ（未設定に化けさせぬ）", async () => {
    const outcomes: QueryResult[] = [
      { data: null, error: { message: "boom", code: "XX000" } },
      { data: null, error: null },
    ]
    for (const outcome of outcomes) {
      maybeSingle.mockReset()
      maybeSingle.mockResolvedValue(outcome)
      const { result, unmount } = render({ status: "set", amountMl: 120 })
      await act(async () => {
        expect(await result.current.refetch()).toBeNull()
      })
      expect(result.current.state).toEqual({ status: "set", amountMl: 120 })
      unmount()
    }
  })

  it("呼び出し側の取り直しは反映した状態を返す（読めなかった状態から押し直した時）", async () => {
    maybeSingle.mockResolvedValue({ data: { bottle_default_ml: null }, error: null })
    const { result } = render({ status: "error" })
    let returned: BottleDefaultState | null = null
    await act(async () => {
      returned = await result.current.refetch()
    })
    expect(returned).toEqual({ status: "unset" })
  })
})

describe("useBottleDefault の競合（保存と取り直し）", () => {
  it("保存より前に始まった取り直しが保存の後に古い 120 を返しても、160 のまま（次のタップを 120 にせぬ）", async () => {
    const late = deferred<QueryResult>()
    maybeSingle.mockReturnValueOnce(late.promise)
    const { result } = render({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))

    // 量のシートで 160 を保存できた
    act(() => result.current.apply({ status: "set", amountMl: 160 }))
    expect(result.current.state).toEqual({ status: "set", amountMl: 160 })
    // 保存の前の取り直しは捨てられ、要求も abort される
    expect(signals[0]?.aborted).toBe(true)

    await act(async () => {
      late.resolve({ data: { bottle_default_ml: 120 }, error: null })
      await late.promise
    })
    expect(result.current.state).toEqual({ status: "set", amountMl: 160 })
    expect(mockedToast.info).not.toHaveBeenCalled()
  })

  it("対照: apply の後に始めた取り直しの結果は反映する", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: 120 }, error: null })
    const { result } = render({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))
    act(() => result.current.apply({ status: "set", amountMl: 160 }))

    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: 180 }, error: null })
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.state).toEqual({ status: "set", amountMl: 180 })
  })

  it("新しい取り直しは古い取り直しを捨てる（遅れて着いた古い応答で戻らぬ）", async () => {
    const first = deferred<QueryResult>()
    maybeSingle.mockReturnValueOnce(first.promise)
    const { result } = render({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))

    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: 160 }, error: null })
    await act(async () => {
      await result.current.refetch()
    })
    expect(result.current.state).toEqual({ status: "set", amountMl: 160 })

    await act(async () => {
      first.resolve({ data: { bottle_default_ml: 100 }, error: null })
      await first.promise
    })
    expect(result.current.state).toEqual({ status: "set", amountMl: 160 })
  })

  it("追い越された取り直しは「読めなかった」(null) ではなく、新しい取り直しの結果を返す", async () => {
    const first = deferred<QueryResult>()
    maybeSingle.mockReturnValueOnce(first.promise)
    const { result } = render({ status: "error" })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))

    let firstAnswer: Promise<BottleDefaultState | null> | undefined
    act(() => {
      // 取得失敗のままミルクを押した取り直し（1 本目）……の直後に focus の取り直しが追い越す
      firstAnswer = result.current.refetch()
    })
    maybeSingle.mockResolvedValueOnce({ data: { bottle_default_ml: 140 }, error: null })
    await act(async () => {
      await result.current.refetch()
    })
    await act(async () => {
      expect(await firstAnswer).toEqual({ status: "set", amountMl: 140 })
    })
  })

  it("保存の反映（apply）に追い越された取り直しは、反映した状態を返す", async () => {
    const pending = deferred<QueryResult>()
    maybeSingle.mockReturnValueOnce(pending.promise)
    const { result } = render({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))
    let answer: Promise<BottleDefaultState | null> | undefined
    maybeSingle.mockReturnValueOnce(pending.promise)
    act(() => {
      answer = result.current.refetch()
    })
    act(() => result.current.apply({ status: "set", amountMl: 160 }))
    await act(async () => {
      expect(await answer).toEqual({ status: "set", amountMl: 160 })
    })
  })

  it("時間切れ（lie-fi で getSession すら返らぬ）は打ち切って null。表示は変えぬ", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      getSession.mockReturnValue(new Promise(() => {}))
      const { result } = render({ status: "set", amountMl: 120 })
      let answer: Promise<BottleDefaultState | null> | undefined
      act(() => {
        answer = result.current.refetch()
      })
      await act(async () => {
        vi.advanceTimersByTime(BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS)
      })
      await act(async () => {
        expect(await answer).toBeNull()
      })
      expect(maybeSingle).not.toHaveBeenCalled()
      expect(result.current.state).toEqual({ status: "set", amountMl: 120 })
    } finally {
      vi.useRealTimers()
    }
  })

  it("対照: 時間切れの前に返れば打ち切らぬ", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const session = deferred<typeof SESSION>()
      getSession.mockReturnValue(session.promise)
      maybeSingle.mockResolvedValue({ data: { bottle_default_ml: 160 }, error: null })
      const { result } = render({ status: "set", amountMl: 120 })
      let answer: Promise<BottleDefaultState | null> | undefined
      act(() => {
        answer = result.current.refetch()
      })
      await act(async () => {
        vi.advanceTimersByTime(BOTTLE_DEFAULT_REFETCH_TIMEOUT_MS - 1)
        session.resolve(SESSION)
      })
      await act(async () => {
        expect(await answer).toEqual({ status: "set", amountMl: 160 })
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("unmount で in-flight の取り直しを abort する（離脱後に setState を走らせぬ）", async () => {
    const pending = deferred<QueryResult>()
    maybeSingle.mockReturnValueOnce(pending.promise)
    const { unmount } = render({ status: "set", amountMl: 120 })
    await waitFor(() => expect(maybeSingle).toHaveBeenCalledTimes(1))
    unmount()
    expect(signals[0]?.aborted).toBe(true)
  })

  it("初期値は一度だけ seed する（親の props が変わっても取り直し・保存の値を上書きせぬ）", async () => {
    maybeSingle.mockResolvedValue({ data: { bottle_default_ml: 160 }, error: null })
    const { result, rerender } = render({ status: "set", amountMl: 120 })
    await waitFor(() =>
      expect(result.current.state).toEqual({ status: "set", amountMl: 160 }),
    )
    rerender({ init: { status: "set", amountMl: 120 } })
    expect(result.current.state).toEqual({ status: "set", amountMl: 160 })
  })
})
