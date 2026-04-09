import { describe, it, expect } from "vitest"
import { normalizeIngredientName, ingredientsMatch } from "../normalize"

describe("normalizeIngredientName", () => {
  it("前後の空白を除去する", () => {
    expect(normalizeIngredientName("  トマト  ")).toBe("トマト")
  })

  it("全角スペースを半角に変換する", () => {
    expect(normalizeIngredientName("トマト\u3000缶")).toBe("トマト 缶")
  })

  it("大文字を小文字に変換する", () => {
    expect(normalizeIngredientName("TOMATO")).toBe("tomato")
  })

  it("空文字はそのまま空文字を返す", () => {
    expect(normalizeIngredientName("")).toBe("")
  })
})

describe("ingredientsMatch", () => {
  const minLen = 2

  it("完全一致でマッチする", () => {
    expect(ingredientsMatch("トマト", "トマト", minLen)).toBe(true)
  })

  it("前後空白を無視してマッチする", () => {
    expect(ingredientsMatch("  トマト  ", "トマト", minLen)).toBe(true)
  })

  it("大文字小文字を無視してマッチする", () => {
    expect(ingredientsMatch("Tomato", "TOMATO", minLen)).toBe(true)
  })

  it("部分一致（片方が他方を含む）でマッチする", () => {
    // 在庫が「トマト缶」でテンプレートが「トマト」のケース
    expect(ingredientsMatch("トマト缶", "トマト", minLen)).toBe(true)
    expect(ingredientsMatch("トマト", "トマト缶", minLen)).toBe(true)
    // 「鶏もも肉」と「鶏もも」も同様にマッチ
    expect(ingredientsMatch("鶏もも肉", "鶏もも", minLen)).toBe(true)
  })

  it("無関係な食材はマッチしない", () => {
    expect(ingredientsMatch("トマト", "豚肉", minLen)).toBe(false)
  })

  it("1文字の名前は完全一致のみ（誤マッチ防止）", () => {
    // "肉"と"鶏肉"は部分一致だが、"肉"は1文字なので完全一致のみ対象
    expect(ingredientsMatch("肉", "鶏肉", minLen)).toBe(false)
    expect(ingredientsMatch("肉", "肉", minLen)).toBe(true)
  })

  it("空文字はマッチしない", () => {
    expect(ingredientsMatch("", "トマト", minLen)).toBe(false)
    expect(ingredientsMatch("トマト", "", minLen)).toBe(false)
  })
})
