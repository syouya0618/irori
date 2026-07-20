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
 * OCR 進捗の status（tesseract）を、認識前フェーズの日本語ラベルに変換する。
 * 認識中（"recognizing text"）は呼び出し側で進捗% を表示するため、ここでは扱わない。
 */
export function describeScanPhase(status: string): string {
  // 初回は言語辞書(traineddata)+WASM のダウンロードが最も長い待ち。まとめて案内する。
  if (status.includes("traineddata") || status.includes("language")) {
    return "辞書を読み込み中…"
  }
  return "準備中…"
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
  let tesseract: typeof import("tesseract.js")
  try {
    tesseract = await import("tesseract.js")
  } catch (err) {
    // オフライン等での chunk ロード失敗。英語の内部メッセージがトーストに出ないよう日本語へ正規化
    console.error("[scan-receipt] tesseract.js の読み込みに失敗", err)
    throw new Error("端末内OCRの読み込みに失敗しました。通信環境を確認してお試しください")
  }
  const worker = await tesseract.createWorker("jpn", 1, {
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
 * 総画素が maxPixels を超える時だけ縮小した (width, height) を返す純関数。
 * 長辺キャップだと長尺レシート(例 800×4800)が幅 267px まで潰れて Vision でも読めなくなるため、
 * 総画素基準にしてアスペクト比を保ったまま情報量(≒精細さ)を最大化する。
 * canvas 実行部（ブラウザ専用 I/O）と分離して単体テスト可能にする。拡大はしない。
 */
export function fitWithinPixelBudget(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const pixels = width * height
  if (!Number.isFinite(pixels) || pixels <= maxPixels) {
    return { width, height }
  }
  const scale = Math.sqrt(maxPixels / pixels)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 総画素の上限(4MP)。413 防御の実体はこの硬い上限。
 * 4MP × JPEG q0.8 の写真は base64 でも Vercel 4.5MB body / route.ts の
 * MAX_IMAGE_BASE64_LENGTH(6MB) を大幅に下回る（4MP JPEG q0.8 ≒ 1〜2MB、base64 は約 4/3 倍でも ≦ 2.7MB）。
 */
const UPLOAD_MAX_PIXELS = 4_000_000
const UPLOAD_JPEG_QUALITY = 0.8

/**
 * クラウド送信前に画像を総画素基準で縮小・JPEG 圧縮する。
 * Vercel の 4.5MB リクエスト body 上限で、典型的なレシート写真(3-8MB)を無圧縮 base64 で
 * 送ると 413 になり機能が壊れるため必須。総画素キャップ(UPLOAD_MAX_PIXELS)で body 上限を守る。
 * 既存の compressImage(meal 用) は width 制約かつ EXIF 未考慮ゆえ、レシートで OCR 精度を
 * 保つべく総画素基準 + imageOrientation:"from-image"（縦横回転補正）で別実装する。
 * createImageBitmap / canvas はブラウザ専用（この経路は client 限定）。
 */
async function compressImageForUpload(blob: Blob): Promise<Blob> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    return blob
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" })
  } catch (err) {
    // 縮小失敗は致命的ではないが、非圧縮のまま送ると 413 を再発しうるので必ず記録する
    console.warn("[scan-receipt] 画像の圧縮に失敗。元画像で続行します", err)
    return blob
  }
  try {
    const { width, height } = fitWithinPixelBudget(
      bitmap.width,
      bitmap.height,
      UPLOAD_MAX_PIXELS,
    )
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return blob
    ctx.drawImage(bitmap, 0, 0, width, height)
    const compressed = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", UPLOAD_JPEG_QUALITY),
    )
    return compressed ?? blob
  } finally {
    bitmap.close()
  }
}

/**
 * クライアント側 fetch のタイムアウト。サーバ route.ts の maxDuration=30s
 * （内部 Vision fetch は 20s で abort し 504 を返す）より長く取り、サーバ側の具体的な
 * 日本語エラーを受け取れるようにしつつ、通信断で「読み取り中…」が固着するのを防ぐ。
 */
const VISION_CLIENT_TIMEOUT_MS = 35_000

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  )
}

/**
 * Google Cloud Vision（サーバ route 経由）でレシート画像を OCR する。
 * 画像はサーバを経由して Google へ送信される。API キーはサーバ側 env で管理。
 */
export async function scanReceiptWithVision(
  image: Blob,
): Promise<ScannedReceiptItem[]> {
  const compressed = await compressImageForUpload(image)
  const base64 = await blobToBase64(compressed)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), VISION_CLIENT_TIMEOUT_MS)
  try {
    const res = await fetch("/api/receipt-ocr", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: base64 }),
      signal: controller.signal,
    })
    const data = (await res.json().catch(() => null)) as
      | { items?: ScannedReceiptItem[]; error?: string }
      | null
    if (!res.ok) {
      // サーバは具体的な日本語メッセージを返す（APIキー未設定・タイムアウト等）
      throw new Error(data?.error ?? "OCRに失敗しました")
    }
    return data?.items ?? []
  } catch (err) {
    // タイムアウト・通信断はサーバ側の文言と揃えた日本語に正規化して投げ直す
    if (isAbortError(err)) {
      throw new Error("OCRがタイムアウトしました")
    }
    if (err instanceof TypeError) {
      throw new Error("通信に失敗しました。電波状況を確認して、もう一度お試しください")
    }
    throw err
  } finally {
    clearTimeout(timeout)
  }
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
