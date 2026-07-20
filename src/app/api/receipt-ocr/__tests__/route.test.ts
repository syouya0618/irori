/**
 * /api/receipt-ocr の分岐テスト（認証・入力検証・エラーマッピング）。
 * getAuthContext と global fetch をモックする（外部依存の注入。ブラウザ専用 I/O の隠蔽ではない）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { POST } from "../route"

const authed = {
  error: null,
  reason: null,
  context: { supabase: {}, userId: "u", householdId: "h" },
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/receipt-ocr", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

// route.ts の MAX_IMAGE_BASE64_LENGTH と一致させること
const MAX_IMAGE_BASE64_LENGTH = 6 * 1024 * 1024

function visionOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

let originalKey: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  originalKey = process.env.GOOGLE_VISION_API_KEY
  process.env.GOOGLE_VISION_API_KEY = "test-key"
  getAuthContext.mockResolvedValue(authed)
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalKey === undefined) delete process.env.GOOGLE_VISION_API_KEY
  else process.env.GOOGLE_VISION_API_KEY = originalKey
})

describe("POST /api/receipt-ocr", () => {
  it("未認証なら 401 で、Vision を呼ばない", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })

    const res = await POST(post({ image: "abc" }))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: "認証されていません" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("API キー未設定なら 400 で、Vision を呼ばない", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    delete process.env.GOOGLE_VISION_API_KEY

    const res = await POST(post({ image: "abc" }))

    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Google Vision APIキーが未設定です")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("payload が上限超過なら 413 で、Vision を呼ばない", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await POST(post({ image: "a".repeat(MAX_IMAGE_BASE64_LENGTH + 1) }))

    expect(res.status).toBe(413)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("Vision が HTTP エラーなら 502", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: "server error" } }),
      }),
    )

    const res = await POST(post({ image: "abc" }))

    expect(res.status).toBe(502)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it("Vision が HTTP 200 + per-image error なら 502 で構造化ログを出す（修正 A の回帰固定）", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        visionOk({
          responses: [{ error: { code: 7, message: "PERMISSION_DENIED" } }],
        }),
      ),
    )

    const res = await POST(post({ image: "abc" }))

    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain("レシート画像を解析できませんでした")
    expect(errorSpy).toHaveBeenCalledWith(
      "[receipt-ocr] Vision per-image error",
      expect.objectContaining({ code: 7, message: "PERMISSION_DENIED" }),
    )
    errorSpy.mockRestore()
  })

  it("正常系: Vision テキストを items 配列へマッピングして返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        visionOk({
          responses: [{ fullTextAnnotation: { text: "牛乳\n食パン\n合計 446" } }],
        }),
      ),
    )

    const res = await POST(post({ image: "abc" }))

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string; quantity: number | null }[] }
    expect(body.items.map((i) => i.name)).toEqual(["牛乳", "食パン"])
  })

  it("Vision へのリクエストは密集テキスト向け DOCUMENT_TEXT_DETECTION を指定する", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      visionOk({
        responses: [{ fullTextAnnotation: { text: "牛乳" } }],
      }),
    )
    vi.stubGlobal("fetch", fetchSpy)

    await POST(post({ image: "abc" }))

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const requestInit = fetchSpy.mock.calls[0][1] as RequestInit
    const requestBody = JSON.parse(requestInit.body as string) as {
      requests: { features: { type: string }[] }[]
    }
    expect(requestBody.requests[0].features).toEqual([{ type: "DOCUMENT_TEXT_DETECTION" }])
  })

  it("正常系: 切り分けログを textLength/itemCount のみで出力し、本文を含まない", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const text = "牛乳\n食パン\n合計 446"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(visionOk({ responses: [{ fullTextAnnotation: { text } }] })),
    )

    const res = await POST(post({ image: "abc" }))
    await res.json()

    expect(logSpy).toHaveBeenCalledWith("[receipt-ocr] parsed", {
      textLength: text.length,
      itemCount: 2,
    })
    const loggedPayload = JSON.stringify(logSpy.mock.calls)
    expect(loggedPayload).not.toContain("牛乳")
    expect(loggedPayload).not.toContain("食パン")
    logSpy.mockRestore()
  })

  it("OCR は成功したがパーサが全行を捨てた場合、warn で明示する", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    const text = "税込\n税込"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(visionOk({ responses: [{ fullTextAnnotation: { text } }] })),
    )

    const res = await POST(post({ image: "abc" }))
    const body = (await res.json()) as { items: unknown[] }

    expect(body.items).toEqual([])
    expect(warnSpy).toHaveBeenCalledWith("[receipt-ocr] OCR成功・パーサ全滅", {
      textLength: text.length,
      itemCount: 0,
    })
    const loggedPayload = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls])
    expect(loggedPayload).not.toContain("税込")
    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
