import { describe, it, expect } from "vitest"
import { matchStockToTemplate } from "../matching"
import { mkStock, mkTemplate } from "./helpers"

describe("matchStockToTemplate", () => {
  it("全食材がマッチ → matchRate === 1.0", () => {
    const template = mkTemplate("t1", [
      { name: "トマト" },
      { name: "玉ねぎ" },
    ])
    const stock = [mkStock("トマト"), mkStock("玉ねぎ")]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matchRate).toBe(1.0)
    expect(result.matched).toHaveLength(2)
    expect(result.missing).toHaveLength(0)
  })

  it("半分マッチ → matchRate === 0.5", () => {
    const template = mkTemplate("t1", [
      { name: "トマト" },
      { name: "玉ねぎ" },
    ])
    const stock = [mkStock("トマト")]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matchRate).toBe(0.5)
    expect(result.matched).toHaveLength(1)
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0].name).toBe("玉ねぎ")
  })

  it("在庫0件 → matchRate === 0, 全食材が不足", () => {
    const template = mkTemplate("t1", [
      { name: "トマト" },
      { name: "玉ねぎ" },
    ])

    const result = matchStockToTemplate(template, [], 2)

    expect(result.matchRate).toBe(0)
    expect(result.matched).toHaveLength(0)
    expect(result.missing).toHaveLength(2)
  })

  it("テンプレート食材0件 → matchRate === 0（0割ガード）", () => {
    const template = mkTemplate("t1", [])
    const stock = [mkStock("トマト")]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matchRate).toBe(0)
    expect(result.matched).toHaveLength(0)
    expect(result.missing).toHaveLength(0)
  })

  it("部分一致が機能する（トマト缶 in stock で トマト template にマッチ）", () => {
    const template = mkTemplate("t1", [{ name: "トマト" }])
    const stock = [mkStock("トマト缶")]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matchRate).toBe(1.0)
    expect(result.matched).toHaveLength(1)
  })

  it("1文字食材は部分一致せず誤マッチを防ぐ", () => {
    const template = mkTemplate("t1", [{ name: "肉" }])
    const stock = [mkStock("鶏肉")]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matchRate).toBe(0)
  })

  it("同じ在庫アイテムが複数食材にマッチしない（重複使用防止）", () => {
    // テンプレートに「玉ねぎ」が2回登場するが、在庫の玉ねぎは1つしかない
    const template = mkTemplate("t1", [{ name: "玉ねぎ" }, { name: "玉ねぎ" }])
    const stock = [mkStock("玉ねぎ")]

    const result = matchStockToTemplate(template, stock, 2)

    // 1つしかマッチしない（重複使用禁止）
    expect(result.matched).toHaveLength(1)
    expect(result.missing).toHaveLength(1)
    expect(result.matchRate).toBe(0.5)
  })

  it("別IDの同名在庫が2つあれば両方の食材にマッチ", () => {
    const template = mkTemplate("t1", [{ name: "玉ねぎ" }, { name: "玉ねぎ" }])
    const stock = [
      mkStock("玉ねぎ", { id: "s-1" }),
      mkStock("玉ねぎ", { id: "s-2" }),
    ]

    const result = matchStockToTemplate(template, stock, 2)

    expect(result.matched).toHaveLength(2)
    expect(result.missing).toHaveLength(0)
  })
})
