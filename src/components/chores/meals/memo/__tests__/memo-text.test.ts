import { describe, expect, it } from "vitest"
import { FREE_MEMO_TEXT_MAX, displayFreeMemo, encodeFreeMemo } from "../memo-text"
import { isSaveGroceryManualItemRequest } from "@/lib/meals/server/plan-requests"

function roundTrip(input: string) {
  const result = encodeFreeMemo(input)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error("invalid memo")
  const request = {
    id: "f4000000-0000-4000-8000-000000000001",
    version: null,
    ...result.fields,
    quantity: null,
    unit: null,
    section: "other",
  }
  expect(isSaveGroceryManualItemRequest(request)).toBe(true)
  expect(displayFreeMemo(result.fields).text).toBe(input.trim())
  return result.fields
}

describe("共有メモの後方互換な表示と保存", () => {
  it("短い買い物は旧形式（noteなし）で保存する", () => {
    expect(roundTrip("牛乳")).toEqual({ name: "牛乳", note: null })
  })

  it("40文字を超えるメモは同一の操作IDで1行として保存できる", () => {
    const input = "週末の鍋用に白菜と豆腐を買う。".repeat(7)
    const stored = roundTrip(input)
    expect(stored.name.length).toBeLessThanOrEqual(40)
    expect(stored.note).toBeTruthy()
    expect([...stored.note!].length).toBeLessThanOrEqual(200)
  })

  it("改行とバックスラッシュの入力を保存・復元する", () => {
    const input = "牛乳\n鍋に入れる豆腐\nパスは C:\\house\\memo"
    const fields = roundTrip(input)
    expect(fields.note).not.toContain("\n")
    expect(fields.name + (fields.note ?? "")).toContain("\\n")
  })

  it("全角文字の長さを数え、上限超過でも入力データを削除しない", () => {
    roundTrip("あ".repeat(FREE_MEMO_TEXT_MAX))
    const over = encodeFreeMemo("あ".repeat(FREE_MEMO_TEXT_MAX + 1))
    expect(over).toMatchObject({ ok: false })
    expect(encodeFreeMemo("   ")).toMatchObject({ ok: false })
  })

  it("区切り直前の空白も欠けずに復元する", () => {
    const input = "文字".repeat(19) + "  " + "内容".repeat(8)
    expect(roundTrip(input).note).toBeTruthy()
  })

  it("既存の買い物詳細メモを勝手に本文へ結合しない", () => {
    expect(displayFreeMemo({ name: "牛乳", note: "低脂肪のもの" })).toEqual({
      text: "牛乳",
      legacyNote: "低脂肪のもの",
    })
  })
})
