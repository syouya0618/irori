import { NextResponse } from "next/server"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { extractVisionText, extractVisionError } from "@/lib/ocr/vision-response"
import { parseReceiptText } from "@/lib/domain/receipt-ocr-parse"

// 画像アップロード + 外部 API 呼び出しを含むため十分な時間を確保する
export const maxDuration = 30

// Vercel の request body 上限 4.5MB と整合。base64 は元バイナリの約 4/3 ゆえ約 6MB を上限とする。
const MAX_IMAGE_BASE64_LENGTH = 6 * 1024 * 1024

/**
 * Google Cloud Vision（TEXT_DETECTION）でレシート画像を OCR し、商品名候補を返す。
 * 画像はサーバ経由で Google へ送信される（クラウド provider）。
 * API キー未設定時は 400 を返し、クライアントは端末内 OCR / 手入力にフォールバックする。
 */
export async function POST(request: Request) {
  const auth = await getAuthContext()
  if (auth.error !== null) {
    return NextResponse.json({ error: auth.error }, { status: 401 })
  }

  const apiKey = process.env.GOOGLE_VISION_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json(
      { error: "Google Vision APIキーが未設定です" },
      { status: 400 },
    )
  }

  let image: unknown
  try {
    const body = (await request.json()) as { image?: unknown }
    image = body?.image
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 })
  }
  if (typeof image !== "string" || image.length === 0) {
    return NextResponse.json({ error: "画像がありません" }, { status: 400 })
  }
  if (image.length > MAX_IMAGE_BASE64_LENGTH) {
    console.error("[receipt-ocr] payload too large", {
      length: image.length,
      limit: MAX_IMAGE_BASE64_LENGTH,
    })
    return NextResponse.json(
      { error: "画像サイズが大きすぎます。もう少し小さい画像でお試しください" },
      { status: 413 },
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)
  try {
    const res = await fetch(
      `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: image },
              features: [{ type: "TEXT_DETECTION" }],
              imageContext: { languageHints: ["ja"] },
            },
          ],
        }),
        signal: controller.signal,
      },
    )
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      console.error("[receipt-ocr] Vision API error", {
        status: res.status,
        body: JSON.stringify(data)?.slice(0, 500),
      })
      return NextResponse.json(
        { error: "OCRに失敗しました（Vision APIエラー）" },
        { status: 502 },
      )
    }
    // HTTP 200 でも responses[0].error（破損画像・権限等）を返す場合がある
    const visionError = extractVisionError(data)
    if (visionError !== null) {
      console.error("[receipt-ocr] Vision per-image error", {
        code: visionError.code,
        message: visionError.message,
      })
      return NextResponse.json(
        { error: "レシート画像を解析できませんでした。別の写真でお試しください" },
        { status: 502 },
      )
    }
    const items = parseReceiptText(extractVisionText(data))
    return NextResponse.json({ items })
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError"
    console.error("[receipt-ocr] request failed", {
      aborted,
      message: err instanceof Error ? err.message : String(err),
    })
    return NextResponse.json(
      { error: aborted ? "OCRがタイムアウトしました" : "OCRに失敗しました" },
      { status: aborted ? 504 : 500 },
    )
  } finally {
    clearTimeout(timeout)
  }
}
