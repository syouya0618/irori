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
    // preserve_interword_spaces: jpn は字間に偽スペースが混入しやすく、公式 tessdata_fast も
    //   同設定で対策する。user_defined_dpi: "Invalid resolution 0 dpi" 警告の解消。値は文字列。
    // PSM は既定 6 のまま（変更は実機 A/B 未実施のため見送る）。
    await worker.setParameters({
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    })
    const prepared = await prepareImageForTesseract(image)
    const result = await worker.recognize(prepared)
    // 空結果の切り分け用に生テキスト先頭のみ端末内ログ（外部送信なし）
    console.debug("[scan-receipt] raw", result.data.text.slice(0, 200))
    return parseReceiptText(result.data.text)
  } finally {
    await worker.terminate()
  }
}

const TESSERACT_MAX_LONG_EDGE = 2500
const TESSERACT_JPEG_QUALITY = 0.9

/**
 * Tesseract 認識前の縮小サイズを返す純関数。長辺が上限を超える時だけ縮小し、拡大はしない。
 * canvas 実行部（ブラウザ専用 I/O）と分離して単体テスト可能にする。
 * クラウド送信用の fitWithinPixelBudget とは目的（総画素 vs 長辺）が異なるため共有しない。
 */
export function fitTesseractSize(
  width: number,
  height: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (!Number.isFinite(longEdge) || longEdge <= TESSERACT_MAX_LONG_EDGE) {
    return { width, height }
  }
  const scale = TESSERACT_MAX_LONG_EDGE / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * Tesseract 認識前に画像を整える（この経路は client 限定・ブラウザ専用 I/O を含む）。
 * - imageOrientation:"from-image" で canvas 再描画し EXIF 回転を焼き込む。tesseract.js@7
 *   内蔵の EXIF 補正は little-endian EXIF（Android に多い）で不発なため、確実に正立させる。
 * - 長辺 2500px 超のみ縮小し WASM の処理時間とメモリを抑える（拡大はしない）。
 * createImageBitmap / canvas はブラウザ専用。非ブラウザ・生成失敗時は元 blob で続行する。
 * クラウド送信用の compressImageForUpload とは前処理方針が異なるため共有しない（自己完結）。
 */
async function prepareImageForTesseract(blob: Blob): Promise<Blob> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof document === "undefined"
  ) {
    // 本番はブラウザ実行のため通常ここは通らない。通ったら整形せず認識へ回す
    console.warn("[scan-receipt] 前処理不可（ブラウザ外）。元画像で認識します")
    return blob
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" })
  } catch (err) {
    // 前処理失敗は致命的ではないが、原因追跡のため必ず記録して元画像で続行する
    console.warn("[scan-receipt] 前処理に失敗。元画像で認識します", err)
    return blob
  }
  try {
    const { width, height } = fitTesseractSize(bitmap.width, bitmap.height)
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) return blob
    ctx.drawImage(bitmap, 0, 0, width, height)
    const prepared = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", TESSERACT_JPEG_QUALITY),
    )
    return prepared ?? blob
  } finally {
    bitmap.close()
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
 * ただし 10MP 級の極端な長尺では総画素上限の分だけ幅も物理的に狭くなるが、それは許容とする
 * （それでも旧長辺キャップの 267px よりは広く保たれる）。
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
 * 縮小結果は Math.round の丸めにより最大 0.5% 程度この上限を超過しうるため、上限値は余裕を持って設定する
 * （6MB invariant に対し base64 でも 2 倍以上の余裕があり実害はない）。
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
