import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { scanReceiptWithTesseract } from "@/lib/ocr/scan-receipt"

// scanReceiptWithTesseract は client 専用経路（WASM/canvas はブラウザ専用 I/O）。ここでは
// browser lib を差し替え、canvas 実行部には踏み込まず「日本語向けパラメータ設定」と
// 「前処理の呼び出し・非ブラウザ時の元画像フォールバック」だけを固定する。
// node 環境（この .test.ts）では createImageBitmap が未定義のため、前処理は元 blob を返す。
const setParameters = vi.fn<(params: Record<string, string>) => Promise<void>>()
const recognize = vi.fn(async () => ({ data: { text: "牛乳 198\n食パン 248" } }))
const terminate = vi.fn(async () => {})

vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({ setParameters, recognize, terminate })),
}))

beforeEach(() => {
  setParameters.mockClear()
  recognize.mockClear()
  terminate.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function jpegBlob() {
  return new Blob(["dummy"], { type: "image/jpeg" })
}

describe("scanReceiptWithTesseract（日本語向けパラメータと前処理）", () => {
  it("認識前に日本語向けパラメータを設定する（PSM は未設定）", async () => {
    await scanReceiptWithTesseract(jpegBlob())
    expect(setParameters).toHaveBeenCalledTimes(1)
    const params = setParameters.mock.calls[0][0]
    expect(params).toEqual({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    })
    // PSM（tessedit_pageseg_mode）は既定 6 のまま。明示設定しない
    expect(params).not.toHaveProperty("tessedit_pageseg_mode")
  })

  it("前処理を通してから認識する（非ブラウザでは元画像で続行し警告する）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const blob = jpegBlob()
    await scanReceiptWithTesseract(blob)
    // node（非ブラウザ）では前処理をスキップし元 blob をそのまま認識に渡す
    expect(recognize).toHaveBeenCalledWith(blob)
    expect(warn).toHaveBeenCalled()
  })

  it("認識後にワーカーを必ず終了する", async () => {
    await scanReceiptWithTesseract(jpegBlob())
    expect(terminate).toHaveBeenCalledTimes(1)
  })
})
