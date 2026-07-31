/**
 * useVisibilityRefetch の発火条件とリスナ後始末を固定する。
 *
 * このフックは「Realtime が届かぬ回（issue #92）と、フィルタ付き購読で構造的に
 * 配信されない DELETE」を復帰時 refetch で回収する経路の入口じゃ。ゆえに
 * - visibilitychange / focus の **両方**で発火すること
 * - hidden の時は発火しないこと（バックグラウンドで無駄に叩かない）
 * - unmount でリスナが外れること（アンマウント後の setState を作らない）
 * の 3 点を固定する。
 *
 * jsdom の `document.visibilityState` は getter のみのため、
 * `Object.defineProperty` で差し替えてから event を dispatch する。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"
import { act } from "react"
import { useVisibilityRefetch } from "../use-visibility-refetch"

/** jsdom の visibilityState を上書きする（既定は "visible"）。 */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
}

function Probe({ cb }: { cb: () => void }) {
  useVisibilityRefetch(cb)
  return null
}

beforeEach(() => {
  cleanup()
  setVisibility("visible")
})

afterEach(() => {
  setVisibility("visible")
})

describe("useVisibilityRefetch", () => {
  it("visibilitychange（visible）で cb が発火する", () => {
    const cb = vi.fn()
    render(<Probe cb={cb} />)

    expect(cb).not.toHaveBeenCalled()

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("focus でも cb が発火する（visibilitychange だけでは復帰を取り逃す端末がある）", () => {
    const cb = vi.fn()
    render(<Probe cb={cb} />)

    act(() => {
      window.dispatchEvent(new Event("focus"))
    })

    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("visibilityState が visible でなければ発火しない（visibilitychange / focus の双方）", () => {
    const cb = vi.fn()
    render(<Probe cb={cb} />)

    setVisibility("hidden")
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })

    expect(cb).not.toHaveBeenCalled()

    // 可視へ戻れば発火する（ガードが恒久的に殺していないことの確認）
    setVisibility("visible")
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it("unmount でリスナが外れる（visibilitychange / focus とも発火しない）", () => {
    const cb = vi.fn()
    const { unmount } = render(<Probe cb={cb} />)

    unmount()

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
      window.dispatchEvent(new Event("focus"))
    })

    expect(cb).not.toHaveBeenCalled()
  })

  it("cb の同一性が変わっても再購読せず、常に最新の cb を呼ぶ", () => {
    const first = vi.fn()
    const second = vi.fn()
    const addSpy = vi.spyOn(document, "addEventListener")

    const { rerender } = render(<Probe cb={first} />)
    const addCallsAfterMount = addSpy.mock.calls.filter(
      ([type]) => type === "visibilitychange",
    ).length

    // 毎レンダー新しい関数を渡す（呼び出し側が useCallback を付け忘れた状況）
    rerender(<Probe cb={second} />)

    expect(
      addSpy.mock.calls.filter(([type]) => type === "visibilitychange").length,
    ).toBe(addCallsAfterMount)

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"))
    })

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)

    addSpy.mockRestore()
  })
})
