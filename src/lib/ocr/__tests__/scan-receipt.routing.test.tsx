import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { scanReceipt } from "@/lib/ocr/scan-receipt"

// tesseract.js は WASM/辞書DL を伴うブラウザ専用ライブラリ。ここでは「端末内経路が
// ネットワークへ一切出ない」プライバシー配線だけを検証したいので createWorker を差し替える。
// OCR 出力の正しさは検証しない（＝動くふりの fake-success テストにしない。scan-receipt.ts は
// client 専用経路であり、ネットワーク境界と browser lib を差し替えて分岐選択のみ確認する）。
vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { text: "" } })),
    terminate: vi.fn(async () => {}),
  })),
}))

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function jpegBlob() {
  return new Blob(["dummy"], { type: "image/jpeg" })
}

describe("scanReceipt の provider 配線（プライバシー）", () => {
  it("google-vision はクラウド route /api/receipt-ocr へ送信する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] }),
    })
    await scanReceipt(jpegBlob(), "google-vision")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe("/api/receipt-ocr")
  })

  it("tesseract（端末内）は一切ネットワークへ出ない", async () => {
    await scanReceipt(jpegBlob(), "tesseract")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
