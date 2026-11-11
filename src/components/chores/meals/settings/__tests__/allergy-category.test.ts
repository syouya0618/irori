/**
 * アレルギーとして食材（豆乳・鶏もも肉）を登録するときの、対象品目（大豆・鶏肉）の候補（2026-11-11 製品判断）。
 *
 * - 候補は出すだけ。既存の登録を黙って広げない（判定は登録した内容のまま）。
 * - 苦手には出さない（個別の除外のまま）。
 * - 根拠は辞書の値（原材料が定まった食材だけ）。候補が言う「外す範囲」は、品目として登録したときの判定と一致する。
 *
 * カタログは実物（`getMealLookup`）。
 */
import { describe, expect, it } from "vitest"

import { buildExclusionSet, evaluateDish } from "@/lib/meals/exclusions"
import { getMealLookup } from "@/lib/meals/server/context"
import type { FoodExclusion } from "@/lib/meals/types"

import { allergyCategoryCandidates, buildExclusionLexicon } from "../exclusion-lexicon"

const lookup = getMealLookup()
const lexicon = buildExclusionLexicon(lookup)
// props は直列化されて画面へ届く。直列化した後の語彙で確かめる
const wired = JSON.parse(JSON.stringify(lexicon)) as typeof lexicon

const nameOf = (id: string) => lookup.index.byId.get(id)?.name ?? id
const candidatesOf = (ingredientIds: string[], reason: "allergy" | "dislike" = "allergy", registered: string[] = []) =>
  allergyCategoryCandidates({ reason, ingredientIds }, wired, registered)

function exclusion(target: FoodExclusion["target"], reason: FoodExclusion["reason"] = "allergy"): FoodExclusion {
  return { id: `x-${JSON.stringify(target)}`, reason, target, subject: { kind: "household" } }
}

/** 食材 1 つだけの料理の判定。 */
function verdictOf(ingredientId: string, exclusions: FoodExclusion[]) {
  return evaluateDish(
    {
      title: "確かめ用の料理",
      ingredients: [{ ingredientId, quantity: { amount: 100, unit: "g" } }],
      allergenStatus: "from_ingredients",
    },
    buildExclusionSet(exclusions, lookup),
  ).verdict
}

describe("対象品目の候補（allergyCategoryCandidates）", () => {
  it("豆乳 → 大豆、鶏もも肉 → 鶏肉。根拠の食材と、品目として登録したときに外す食材の名前を返す", () => {
    expect(candidatesOf(["soy_milk"])).toEqual([
      expect.objectContaining({
        allergenId: "soybean",
        allergenName: "大豆",
        tier: "recommended",
        sourceNames: ["豆乳"],
        registered: false,
      }),
    ])
    const [soy] = candidatesOf(["soy_milk"])
    expect(soy.scopeNames).toEqual(expect.arrayContaining(["大豆", "豆乳", "納豆"]))
    expect(soy.scopeNames).toEqual(lexicon.allergenScopes.soybean.map(nameOf))

    expect(candidatesOf(["chicken_thigh"])).toEqual([
      expect.objectContaining({ allergenId: "chicken", allergenName: "鶏肉", sourceNames: ["鶏もも肉"] }),
    ])
    // 同じ品目を含む食材を 2 つ選べば、候補は 1 つで根拠を並べる
    expect(candidatesOf(["soy_milk", "chicken_thigh", "soy_milk"]).map((candidate) => candidate.allergenId)).toEqual([
      "soybean",
      "chicken",
    ])
  })

  it("苦手には出さない（個別の除外のまま。品目へ広げると苦手でない食材まで外れる）", () => {
    expect(candidatesOf(["soy_milk"], "dislike")).toEqual([])
    expect(candidatesOf(["chicken_thigh"], "dislike")).toEqual([])
  })

  it("対照: 登録すると既に広がる品目（素の食材の大豆・鶏肉）と、入力そのものが指す品目は候補にしない", () => {
    expect(candidatesOf(["soybean"])).toEqual([])
    expect(candidatesOf(["chicken"])).toEqual([])
    expect(
      allergyCategoryCandidates({ reason: "allergy", ingredientIds: ["soy_milk"], directAllergenIds: ["soybean"] }, wired),
    ).toEqual([])
  })

  it("対照: 商品で原材料が変わる加工品（納豆）は、辞書の値を根拠にしない（同じ大豆由来でも、豆乳には出す）", () => {
    expect(lookup.index.byId.get("natto")?.allergenInfo).toBe("varies")
    expect(candidatesOf(["natto"])).toEqual([])
    expect(candidatesOf(["soy_milk"])).toHaveLength(1)
  })

  it("品目として登録済みなら、候補に「登録済み」と付ける（もう一度登録させない）", () => {
    expect(candidatesOf(["soy_milk"], "allergy", ["soybean"])).toEqual([
      expect.objectContaining({ allergenId: "soybean", registered: true }),
    ])
  })
})

describe("候補が言う範囲は、判定と一致する", () => {
  it("品目（大豆）として登録すると、外す範囲の食材はどれも当たる。範囲の外の食材は当たらない", () => {
    const soybean = exclusion({ kind: "allergen", allergenId: "soybean" })
    const scope = lexicon.allergenScopes.soybean
    expect(scope.length).toBeGreaterThan(5)
    for (const id of scope) expect(verdictOf(id, [soybean]), id).toBe("blocked")
    // 対照: 大豆を含まない、原材料の定まった食材は当たらない
    expect(verdictOf("onion", [soybean])).toBe("ok")
  })

  it("このまま（豆乳だけ）登録すると、豆乳は当たるが、大豆を含むほかの食材（大豆・木綿豆腐）は外さない", () => {
    const soyMilk = exclusion({ kind: "ingredient", ingredientId: "soy_milk" })
    expect(verdictOf("soy_milk", [soyMilk])).toBe("blocked")
    expect(verdictOf("soybean", [soyMilk])).toBe("ok")
    const tofu = lexicon.allergenScopes.soybean.find((id) => nameOf(id).includes("豆腐"))
    expect(tofu).toBeDefined()
    expect(verdictOf(tofu as string, [soyMilk])).toBe("ok")
  })

  it("鶏もも肉だけの登録は鶏肉のほかの部位を外さない。品目（鶏肉）なら外す", () => {
    const thigh = exclusion({ kind: "ingredient", ingredientId: "chicken_thigh" })
    const otherCut = lexicon.allergenScopes.chicken.find((id) => id !== "chicken_thigh" && id !== "chicken" && lookup.index.byId.get(id)?.allergenInfo === "known")
    expect(otherCut).toBeDefined()
    expect(verdictOf(otherCut as string, [thigh])).toBe("ok")
    expect(verdictOf(otherCut as string, [exclusion({ kind: "allergen", allergenId: "chicken" })])).toBe("blocked")
  })
})
