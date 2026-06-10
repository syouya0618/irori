/**
 * parseStockFormData の回帰テスト。
 *
 * R4 (stock actions 分割) で actions.ts から移設した際の挙動を固定する。
 * ここでの期待値は「現挙動の仕様化」であり、変更する場合は
 * stock-form-sheet.tsx 側の入力契約とあわせて見直すこと。
 */

import { describe, it, expect } from "vitest"
import { parseStockFormData } from "../stock-form"

/** テスト用 FormData ファクトリ */
function mkForm(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    fd.set(key, value)
  }
  return fd
}

// ─── 正常系 ──────────────────────────────────────────────

describe("parseStockFormData: 正常系", () => {
  it("全フィールド指定 → そのままパースされる", () => {
    const result = parseStockFormData(
      mkForm({
        name: "トマト",
        category: "vegetable",
        quantity: "3",
        unit: "個",
        expires_at: "2026-06-15",
      }),
    )
    expect(result).toEqual({
      name: "トマト",
      category: "vegetable",
      quantity: 3,
      unit: "個",
      expires_at: "2026-06-15",
    })
  })

  it("name の前後空白は trim される", () => {
    const result = parseStockFormData(mkForm({ name: "  牛乳  " }))
    expect(result).toMatchObject({ name: "牛乳" })
  })

  it("category 欠落 → other_food にフォールバック", () => {
    const result = parseStockFormData(mkForm({ name: "卵" }))
    expect(result).toMatchObject({ category: "other_food" })
  })

  it("category 空文字 → other_food にフォールバック", () => {
    const result = parseStockFormData(mkForm({ name: "卵", category: "" }))
    expect(result).toMatchObject({ category: "other_food" })
  })

  it("unit 欠落・空文字 → null", () => {
    expect(parseStockFormData(mkForm({ name: "卵" }))).toMatchObject({
      unit: null,
    })
    expect(parseStockFormData(mkForm({ name: "卵", unit: "" }))).toMatchObject({
      unit: null,
    })
  })

  it("unit は trim されずそのまま保持される（現挙動の固定）", () => {
    const result = parseStockFormData(mkForm({ name: "卵", unit: " パック " }))
    expect(result).toMatchObject({ unit: " パック " })
  })
})

// ─── name 欠落 ───────────────────────────────────────────

describe("parseStockFormData: name 欠落", () => {
  it("name キー自体がない → エラー", () => {
    expect(parseStockFormData(mkForm({}))).toEqual({
      error: "アイテム名を入力してください",
    })
  })

  it("name 空文字 → エラー", () => {
    expect(parseStockFormData(mkForm({ name: "" }))).toEqual({
      error: "アイテム名を入力してください",
    })
  })

  it("name 空白のみ → エラー", () => {
    expect(parseStockFormData(mkForm({ name: "   " }))).toEqual({
      error: "アイテム名を入力してください",
    })
  })

  it("name が文字列以外 (File) → エラー", () => {
    const fd = new FormData()
    fd.set("name", new Blob(["x"]), "name.txt")
    expect(parseStockFormData(fd)).toEqual({
      error: "アイテム名を入力してください",
    })
  })
})

// ─── quantity 境界 ───────────────────────────────────────

describe("parseStockFormData: quantity 境界", () => {
  it.each([
    ["欠落", undefined, 1],
    ["空文字", "", 1],
    ['"0" (falsy 衝突)', "0", 1],
    ["数値文字列", "3", 3],
    ["小数", "2.5", 2.5],
    ["負数", "-2", -2],
    ["非数値 (NaN)", "abc", 1],
  ] as const)("quantity %s → %s", (_label, input, expected) => {
    const fields: Record<string, string> = { name: "卵" }
    if (input !== undefined) fields.quantity = input
    expect(parseStockFormData(mkForm(fields))).toMatchObject({
      quantity: expected,
    })
  })
})

// ─── expires_at 形式 ─────────────────────────────────────

describe("parseStockFormData: expires_at 形式", () => {
  it("YYYY-MM-DD 文字列はそのまま保持される", () => {
    const result = parseStockFormData(
      mkForm({ name: "卵", expires_at: "2026-12-31" }),
    )
    expect(result).toMatchObject({ expires_at: "2026-12-31" })
  })

  it("欠落・空文字 → null", () => {
    expect(parseStockFormData(mkForm({ name: "卵" }))).toMatchObject({
      expires_at: null,
    })
    expect(
      parseStockFormData(mkForm({ name: "卵", expires_at: "" })),
    ).toMatchObject({ expires_at: null })
  })

  it("日付形式のバリデーションは行わない（現挙動の固定: 非日付文字列も素通し）", () => {
    const result = parseStockFormData(
      mkForm({ name: "卵", expires_at: "not-a-date" }),
    )
    expect(result).toMatchObject({ expires_at: "not-a-date" })
  })
})
