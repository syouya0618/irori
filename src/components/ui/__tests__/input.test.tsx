import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { Input } from "../input"

// Chrome for Android 154 で、fine ポインタも報告する端末（S Pen 機等）の
// date/time 入力は「欄を叩いてもサブフィールドにフォーカスするだけ」になった。
// Input はその隙間（primary が coarse かつ fine も在る）でだけ showPicker() を呼ぶ。
// jsdom は showPicker も matchMedia も持たぬゆえ両方を stub する。

const GAP_QUERY = "(pointer: coarse) and (any-pointer: fine)"

function stubMatchMedia(matchingQueries: string[]) {
  const impl = vi.fn((query: string) => ({
    matches: matchingQueries.includes(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: impl,
  })
  return impl
}

const originalShowPicker = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "showPicker",
)

function stubShowPicker(impl: () => void = () => {}) {
  const fn = vi.fn(impl)
  Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
    configurable: true,
    writable: true,
    value: fn,
  })
  return fn
}

describe("Input — date/time のタップでネイティブピッカーを開く", () => {
  beforeEach(() => {
    stubMatchMedia([GAP_QUERY])
  })

  afterEach(() => {
    if (originalShowPicker) {
      Object.defineProperty(
        HTMLInputElement.prototype,
        "showPicker",
        originalShowPicker,
      )
    } else {
      delete (HTMLInputElement.prototype as { showPicker?: unknown }).showPicker
    }
    Reflect.deleteProperty(window, "matchMedia")
    vi.restoreAllMocks()
  })

  it.each(["time", "date", "datetime-local", "month", "week"])(
    "type=%s を叩くと showPicker を 1 回呼ぶ",
    (type) => {
      const showPicker = stubShowPicker()
      render(<Input type={type} aria-label="欄" defaultValue="" />)
      fireEvent.click(screen.getByLabelText("欄"))
      expect(showPicker).toHaveBeenCalledTimes(1)
    },
  )

  it.each(["text", "number"])("type=%s では呼ばぬ（対照）", (type) => {
    const showPicker = stubShowPicker()
    render(<Input type={type} aria-label="欄" />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(showPicker).not.toHaveBeenCalled()
  })

  it("純タッチ端末（fine ポインタ無し）では呼ばぬ — Chromium が自前で開く", () => {
    stubMatchMedia(["(pointer: coarse)"])
    const showPicker = stubShowPicker()
    render(<Input type="time" aria-label="欄" />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(showPicker).not.toHaveBeenCalled()
  })

  it("primary が fine のデスクトップでは呼ばぬ — サブフィールドの直接入力を残す", () => {
    stubMatchMedia(["(any-pointer: fine)", "(any-pointer: coarse)"])
    const showPicker = stubShowPicker()
    render(<Input type="time" aria-label="欄" />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(showPicker).not.toHaveBeenCalled()
  })

  it("readOnly では呼ばぬ（showPicker は InvalidStateError を投げる）", () => {
    const showPicker = stubShowPicker()
    render(<Input type="time" aria-label="欄" readOnly />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(showPicker).not.toHaveBeenCalled()
  })

  it("呼び出し側の onClick は先に呼ばれ、preventDefault すれば showPicker を呼ばぬ", () => {
    const showPicker = stubShowPicker()
    const onClick = vi.fn((e: React.MouseEvent) => e.preventDefault())
    render(<Input type="time" aria-label="欄" onClick={onClick} />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(showPicker).not.toHaveBeenCalled()
  })

  it("呼び出し側の onClick を潰さず、showPicker も呼ぶ", () => {
    const showPicker = stubShowPicker()
    const onClick = vi.fn()
    render(<Input type="time" aria-label="欄" onClick={onClick} />)
    fireEvent.click(screen.getByLabelText("欄"))
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(showPicker).toHaveBeenCalledTimes(1)
  })

  it("showPicker が throw しても例外を漏らさず、構造化して warn に残す", () => {
    stubShowPicker(() => {
      throw new DOMException("no activation", "NotAllowedError")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    render(<Input type="time" aria-label="欄" />)
    expect(() => fireEvent.click(screen.getByLabelText("欄"))).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      "[native-picker] showPicker failed",
      expect.objectContaining({ type: "time", name: "NotAllowedError" }),
    )
  })

  it("showPicker 未実装のブラウザでも落ちぬ", () => {
    delete (HTMLInputElement.prototype as { showPicker?: unknown }).showPicker
    render(<Input type="time" aria-label="欄" />)
    expect(() => fireEvent.click(screen.getByLabelText("欄"))).not.toThrow()
  })

  it("matchMedia 未実装の環境でも落ちず、呼ばぬ", () => {
    Reflect.deleteProperty(window, "matchMedia")
    const showPicker = stubShowPicker()
    render(<Input type="time" aria-label="欄" />)
    expect(() => fireEvent.click(screen.getByLabelText("欄"))).not.toThrow()
    expect(showPicker).not.toHaveBeenCalled()
  })
})
