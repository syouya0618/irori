import { describe, it, expect } from "vitest"
import { sanitizeReceiptItems, type ReceiptDraftItem } from "../receipt"

function draft(overrides: Partial<ReceiptDraftItem> = {}): ReceiptDraftItem {
  return { name: "トマト", category: "vegetable", quantity: 1, ...overrides }
}

describe("sanitizeReceiptItems", () => {
  it("空配列 → 空配列", () => {
    expect(sanitizeReceiptItems([])).toEqual([])
  })

  it("名前を trim し、空・空白のみの行は除外する", () => {
    const result = sanitizeReceiptItems([
      draft({ name: "  牛乳  " }),
      draft({ name: "   " }),
      draft({ name: "" }),
    ])
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("牛乳")
  })

  it("数量が不正(NaN/負)なら 1 に、0 は許容する", () => {
    const result = sanitizeReceiptItems([
      draft({ name: "A", quantity: Number.NaN }),
      draft({ name: "B", quantity: -3 }),
      draft({ name: "C", quantity: 0 }),
      draft({ name: "D", quantity: 2 }),
    ])
    expect(result.map((r) => r.quantity)).toEqual([1, 1, 0, 2])
  })

  it("不正なカテゴリは other_food にフォールバック", () => {
    const result = sanitizeReceiptItems([
      draft({ name: "謎", category: "not_a_category" as never }),
    ])
    expect(result[0].category).toBe("other_food")
  })

  it("名前が長すぎる場合は 100 文字に切り詰める", () => {
    const long = "あ".repeat(150)
    const result = sanitizeReceiptItems([draft({ name: long })])
    expect(result[0].name).toHaveLength(100)
  })
})
