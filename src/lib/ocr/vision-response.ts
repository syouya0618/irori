/**
 * Google Cloud Vision `images:annotate`（TEXT_DETECTION）レスポンスから
 * テキスト全文を取り出す純関数。fullTextAnnotation.text を優先し、
 * 無ければ textAnnotations[0].description、いずれも無ければ空文字。
 * サーバ route から切り出してユニットテスト可能にする。
 */

interface VisionResponse {
  responses?: Array<{
    fullTextAnnotation?: { text?: string }
    textAnnotations?: Array<{ description?: string }>
    error?: { code?: number; message?: string }
  }>
}

export function extractVisionText(raw: unknown): string {
  const data = raw as VisionResponse | null
  const first = data?.responses?.[0]
  if (!first) return ""
  if (first.error) return ""
  if (typeof first.fullTextAnnotation?.text === "string") {
    return first.fullTextAnnotation.text
  }
  const desc = first.textAnnotations?.[0]?.description
  return typeof desc === "string" ? desc : ""
}

/** Vision レスポンス内の error（PERMISSION_DENIED 等）を取り出す。無ければ null。 */
export function extractVisionError(
  raw: unknown,
): { code?: number; message?: string } | null {
  const data = raw as VisionResponse | null
  return data?.responses?.[0]?.error ?? null
}
