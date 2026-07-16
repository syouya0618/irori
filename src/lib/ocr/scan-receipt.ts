import {
  parseReceiptText,
  type ScannedReceiptItem,
} from "@/lib/domain/receipt-ocr-parse"

/** OCR プロバイダ。設定で切り替える。 */
export type OcrProvider = "tesseract" | "google-vision"

export interface OcrProgress {
  /** 0..1 */
  progress: number
  status: string
}

/**
 * 端末内 OCR（Tesseract.js / WASM）でレシート画像から商品名候補を抽出する。
 * 画像は端末外に一切送信しない。日本語辞書は初回にダウンロードされ IndexedDB にキャッシュ。
 * tesseract.js は重いため dynamic import で必要時のみロードする。
 */
export async function scanReceiptWithTesseract(
  image: Blob,
  onProgress?: (p: OcrProgress) => void,
): Promise<ScannedReceiptItem[]> {
  const { createWorker } = await import("tesseract.js")
  const worker = await createWorker("jpn", 1, {
    logger: onProgress
      ? (m: { status: string; progress: number }) =>
          onProgress({ status: m.status, progress: m.progress })
      : undefined,
  })
  try {
    const result = await worker.recognize(image)
    return parseReceiptText(result.data.text)
  } finally {
    await worker.terminate()
  }
}
