import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, cleanup } from "@testing-library/react"
import { useOcrProvider } from "@/lib/hooks/use-ocr-provider"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe("useOcrProvider", () => {
  it("localStorage 読取が SecurityError を投げても既定(tesseract)へフォールバックし render クラッシュしない", () => {
    // Cookie 全ブロック等で getItem が SecurityError を投げる環境を再現
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError")
    })
    const { result } = renderHook(() => useOcrProvider())
    expect(result.current[0]).toBe("tesseract")
  })

  it("保存済みの有効値を返す", () => {
    localStorage.setItem("irori:ocr-provider", "google-vision")
    const { result } = renderHook(() => useOcrProvider())
    expect(result.current[0]).toBe("google-vision")
  })
})
