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

/** Blob を base64（data: プレフィックスなし）に変換する。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== "string") {
        reject(new Error("画像の読み込みに失敗しました"))
        return
      }
      // "data:image/jpeg;base64,XXXX" → "XXXX"
      resolve(result.slice(result.indexOf(",") + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error("画像の読み込みに失敗しました"))
    reader.readAsDataURL(blob)
  })
}

/**
 * Google Cloud Vision（サーバ route 経由）でレシート画像を OCR する。
 * 画像はサーバを経由して Google へ送信される。API キーはサーバ側 env で管理。
 */
export async function scanReceiptWithVision(
  image: Blob,
): Promise<ScannedReceiptItem[]> {
  const base64 = await blobToBase64(image)
  const res = await fetch("/api/receipt-ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: base64 }),
  })
  const data = (await res.json().catch(() => null)) as
    | { items?: ScannedReceiptItem[]; error?: string }
    | null
  if (!res.ok) {
    throw new Error(data?.error ?? "OCRに失敗しました")
  }
  return data?.items ?? []
}

/** 選択された provider でレシート画像を OCR する。 */
export async function scanReceipt(
  image: Blob,
  provider: OcrProvider,
  onProgress?: (p: OcrProgress) => void,
): Promise<ScannedReceiptItem[]> {
  return provider === "google-vision"
    ? scanReceiptWithVision(image)
    : scanReceiptWithTesseract(image, onProgress)
}
