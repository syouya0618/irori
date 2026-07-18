import { describe, it, expect } from "vitest"
import { extractVisionText, extractVisionError } from "../vision-response"

describe("extractVisionText", () => {
  it("fullTextAnnotation.text を優先して返す", () => {
    const res = {
      responses: [
        {
          fullTextAnnotation: { text: "牛乳\n食パン\n合計 446" },
          textAnnotations: [{ description: "無視される" }],
        },
      ],
    }
    expect(extractVisionText(res)).toBe("牛乳\n食パン\n合計 446")
  })

  it("fullTextAnnotation が無ければ textAnnotations[0].description にフォールバック", () => {
    const res = {
      responses: [{ textAnnotations: [{ description: "トマト\nたまご" }] }],
    }
    expect(extractVisionText(res)).toBe("トマト\nたまご")
  })

  it("テキストが無ければ空文字", () => {
    expect(extractVisionText({ responses: [{}] })).toBe("")
    expect(extractVisionText({ responses: [] })).toBe("")
    expect(extractVisionText({})).toBe("")
    expect(extractVisionText(null)).toBe("")
  })

  it("Vision の error レスポンスを検出できる", () => {
    const res = {
      responses: [{ error: { code: 7, message: "PERMISSION_DENIED" } }],
    }
    expect(extractVisionText(res)).toBe("")
  })
})

describe("extractVisionError", () => {
  it("HTTP 200 でも responses[0].error があれば取り出す", () => {
    const res = {
      responses: [{ error: { code: 3, message: "Bad image data" } }],
    }
    expect(extractVisionError(res)).toEqual({ code: 3, message: "Bad image data" })
  })

  it("error が無ければ null", () => {
    expect(extractVisionError({ responses: [{ fullTextAnnotation: { text: "牛乳" } }] })).toBeNull()
    expect(extractVisionError({ responses: [] })).toBeNull()
    expect(extractVisionError({})).toBeNull()
    expect(extractVisionError(null)).toBeNull()
  })
})
