import { describe, it, expect } from "vitest"
import { extractVisionText } from "../vision-response"

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
