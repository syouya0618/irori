import { describe, it, expect } from "vitest"
import { rankSuggestions } from "../ranking"
import { mkStock, mkTemplate } from "./helpers"

const TODAY = new Date("2026-04-09T00:00:00")

describe("rankSuggestions", () => {
  it("マッチ率0のテンプレートは結果に含まれない", () => {
    const templates = [mkTemplate("t1", ["存在しない食材"])]
    const stock = [mkStock("トマト")]

    const result = rankSuggestions(templates, stock, {}, TODAY)

    expect(result).toHaveLength(0)
  })

  it("マッチ率順にソートされる", () => {
    const templates = [
      mkTemplate("low", ["トマト", "玉ねぎ", "キャベツ"]), // 1/3
      mkTemplate("high", ["トマト", "玉ねぎ"]), // 2/2
    ]
    const stock = [mkStock("トマト"), mkStock("玉ねぎ")]

    const result = rankSuggestions(templates, stock, {}, TODAY)

    expect(result).toHaveLength(2)
    expect(result[0].templateId).toBe("high")
    expect(result[1].templateId).toBe("low")
  })

  it("期限切れ間近のボーナスが加算される", () => {
    const templates = [
      mkTemplate("noExpiry", ["トマト"]),
      mkTemplate("withExpiry", ["玉ねぎ"]),
    ]
    const stock = [
      mkStock("トマト"),
      mkStock("玉ねぎ", { expires_at: "2026-04-10" }), // 明日期限切れ
    ]

    const result = rankSuggestions(templates, stock, {}, TODAY)

    expect(result[0].templateId).toBe("withExpiry")
    expect(result[0].hasExpiringStock).toBe(true)
    expect(result[0].scoreBreakdown.expiryBonus).toBeGreaterThan(0)
  })

  it("goodリアクションで順位が上がる", () => {
    const templates = [
      mkTemplate("badTemplate", ["トマト"], ["bad", "bad"]),
      mkTemplate("goodTemplate", ["トマト"], ["good", "good"]),
    ]
    const stock = [mkStock("トマト")]

    const result = rankSuggestions(templates, stock, {}, TODAY)

    expect(result[0].templateId).toBe("goodTemplate")
  })

  it("topN でリストが切り詰められる", () => {
    const templates = Array.from({ length: 15 }, (_, i) =>
      mkTemplate(`t${i}`, ["トマト"]),
    )
    const stock = [mkStock("トマト")]

    const result = rankSuggestions(templates, stock, { topN: 5 }, TODAY)

    expect(result).toHaveLength(5)
  })

  it("空のテンプレートリストは空配列を返す", () => {
    const result = rankSuggestions([], [mkStock("トマト")], {}, TODAY)
    expect(result).toEqual([])
  })

  it("空の在庫リストでも全テンプレートをスキップする", () => {
    const templates = [mkTemplate("t1", ["トマト"])]
    const result = rankSuggestions(templates, [], {}, TODAY)
    expect(result).toHaveLength(0)
  })

  it("結果には matchedIngredients と missingIngredients が含まれる", () => {
    const templates = [mkTemplate("t1", ["トマト", "玉ねぎ"])]
    const stock = [mkStock("トマト")]

    const result = rankSuggestions(templates, stock, {}, TODAY)

    expect(result[0].matchedIngredients).toHaveLength(1)
    expect(result[0].matchedIngredients[0].name).toBe("トマト")
    expect(result[0].missingIngredients).toHaveLength(1)
    expect(result[0].missingIngredients[0].name).toBe("玉ねぎ")
  })
})
