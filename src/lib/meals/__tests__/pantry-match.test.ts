import { describe, expect, it } from "vitest"

import { shiftYmd } from "@/lib/utils/date-jst"

import {
  expiryStateOn,
  isStale,
  matchDishToPantry,
  type MatchOptions,
  reserveConsumption,
  STALE_AFTER_DAYS,
} from "../pantry-match"
import type { PantryItem } from "../types"
import { CATALOG, ing, q, recipeById, STAPLES, stock, TODAY } from "./fixtures"

const OPTIONS: MatchOptions = { eatOn: TODAY, today: TODAY, stapleIngredientIds: STAPLES, index: CATALOG.index }

function match(recipeId: string, pantry: PantryItem[], options: Partial<MatchOptions> = {}, servings = 2) {
  return matchDishToPantry(recipeById(recipeId), servings, pantry, { ...OPTIONS, ...options })
}

function lineOf(result: ReturnType<typeof match>, ingredientId: string) {
  const line = result.lines.find((l) => l.ingredientId === ingredientId)
  if (!line) throw new Error(`line not found: ${ingredientId}`)
  return line
}

describe("期限の判定（旧欠陥 (a) の回帰: 判定は 1 関数だけ）", () => {
  it.each([
    ["2026-11-09", "expired"],
    ["2026-11-10", "expired"],
    ["2026-11-11", "soon"],
    ["2026-11-14", "soon"],
    ["2026-11-15", "fresh"],
    [null, "none"],
    ["2026-02-30", "expired"],
  ] as const)("期限 %s を 2026-11-11 に食べる → %s", (expiresOn, expected) => {
    expect(expiryStateOn(expiresOn, TODAY)).toBe(expected)
  })
})

describe("最終確認の古さ（保管場所別のしきい値）", () => {
  it.each([
    ["fridge", STALE_AFTER_DAYS.fridge],
    ["freezer", STALE_AFTER_DAYS.freezer],
    ["pantry", STALE_AFTER_DAYS.pantry],
  ] as const)("%s: しきい値ちょうどは古くない、1 日超えたら古い", (storage, days) => {
    const confirmedAt = (offset: number) => stock("pork", { storage, confirmedOn: shift(-offset) })
    expect(isStale(confirmedAt(days), TODAY)).toBe(false)
    expect(isStale(confirmedAt(days + 1), TODAY)).toBe(true)
  })

  it("保管場所が未設定なら、いちばん短いしきい値で判定する", () => {
    expect(isStale(stock("pork", { storage: null, confirmedOn: shift(-8) }), TODAY)).toBe(true)
    expect(isStale(stock("pork", { storage: null, confirmedOn: shift(-7) }), TODAY)).toBe(false)
  })

  it("確認日が不正なら古い側へ倒す。未来の確認日は古くない", () => {
    expect(isStale(stock("pork", { confirmedOn: "not-a-date" }), TODAY)).toBe(true)
    expect(isStale(stock("pork", { confirmedOn: shift(1) }), TODAY)).toBe(false)
  })
})

function shift(days: number): string {
  return shiftYmd(TODAY, days)
}

describe("V-C1 充足の 3 段", () => {
  it("ready: 必須材料が全てあり、数量も足りる", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(300, "g") }),
      stock("onion", { quantity: q(2, "piece") }),
    ])
    expect(result.level).toBe("ready")
    expect(result.missing).toEqual([])
    expect(result.toCheck).toEqual([])
    expect(lineOf(result, "soy_sauce").state).toBe("staple")
  })

  it("同量ちょうどは足りる", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(200, "g") }),
      stock("onion", { quantity: q(0.5, "piece") }),
    ])
    expect(result.level).toBe("ready")
  })

  it("単位違いでも同じ族なら換算して比べる（kg の在庫で g の必要量）", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(0.2, "kg") }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.level).toBe("ready")
  })

  it("check: 食材はあるが数量が未登録（十分あると断定しない）", () => {
    const result = match("pork_ginger", [stock("pork"), stock("onion", { quantity: q(1, "piece") })])
    expect(result.level).toBe("check")
    expect(lineOf(result, "pork")).toMatchObject({
      state: "uncertain",
      reasons: ["quantity_unknown"],
      shortBy: q(200, "g"),
    })
  })

  it("check: 残り少ない（数量も未登録）", () => {
    const result = match("pork_ginger", [stock("pork", { status: "low" }), stock("onion", { quantity: q(1, "piece") })])
    expect(lineOf(result, "pork").reasons).toEqual(["quantity_unknown", "low"])
    expect(result.level).toBe("check")
  })

  it("残り少ないの印があっても、登録された数量が足りていれば ready（数量を優先する）", () => {
    const result = match("pork_ginger", [
      stock("pork", { status: "low", quantity: q(200, "g") }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.level).toBe("ready")
  })

  it("check: 単位を換算できない（在庫は個、必要量は g）。推測で換算しない", () => {
    const result = match("pork_ginger", [stock("pork", { quantity: q(1, "pack") }), stock("onion", { quantity: q(1, "piece") })])
    expect(lineOf(result, "pork")).toMatchObject({ state: "uncertain", reasons: ["unit_mismatch"] })
    expect(result.level).toBe("check")
    expect(result.consumption.some((c) => c.ingredientId === "pork")).toBe(false)
  })

  it("check: 最終確認が古い在庫は、数量が足りていても確認へ回す", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(300, "g"), confirmedOn: shift(-30) }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(lineOf(result, "pork")).toMatchObject({ state: "uncertain", reasons: ["stale"], stockCertain: 0, stockUncertain: 200 })
    expect(result.level).toBe("check")
  })

  it("対照: 冷凍なら同じ 30 日前の確認でも古くない", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(300, "g"), confirmedOn: shift(-30), storage: "freezer" }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.level).toBe("ready")
  })

  it("buy: 必須材料が在庫に無い。不足の量を返す", () => {
    const result = match("pork_ginger", [stock("onion", { quantity: q(1, "piece") })])
    expect(result.level).toBe("buy")
    expect(result.missing).toHaveLength(1)
    expect(result.missing[0]).toMatchObject({
      ingredientId: "pork",
      name: "豚肉",
      reasons: ["not_in_pantry"],
      shortBy: q(200, "g"),
    })
  })

  it("buy: 量が足りない。足りない分だけを返す", () => {
    const result = match("pork_ginger", [
      stock("pork", { id: "p1", quantity: q(120, "g") }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.level).toBe("buy")
    expect(lineOf(result, "pork")).toMatchObject({ state: "missing", reasons: ["short"], shortBy: q(80, "g"), stockCertain: 120 })
  })

  it("複数の在庫行は合算する（100g + 100g で 200g を満たす）", () => {
    const result = match("pork_ginger", [
      stock("pork", { id: "a", quantity: q(100, "g") }),
      stock("pork", { id: "b", quantity: q(100, "g") }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.level).toBe("ready")
    expect(result.consumption.filter((c) => c.ingredientId === "pork").map((c) => c.quantity.amount)).toEqual([100, 100])
  })

  it("在庫が空なら、常備品以外は全て不足", () => {
    const result = match("pork_ginger", [])
    expect(result.level).toBe("buy")
    expect(result.missing.map((m) => m.ingredientId)).toEqual(["pork", "onion"])
  })
})

describe("C-26 期限超過・使い切った食材を材料に数えない", () => {
  const onion = stock("onion", { quantity: q(1, "piece") })

  it("期限超過は欠品扱い（旧欠陥 (a) の回帰: 加点どころか材料にもしない）", () => {
    const result = match("pork_ginger", [stock("pork", { quantity: q(300, "g"), expiresOn: "2026-11-10" }), onion])
    expect(result.level).toBe("buy")
    expect(lineOf(result, "pork")).toMatchObject({ state: "missing", reasons: ["expired"] })
    expect(result.expiringSoonCount).toBe(0)
    expect(result.consumption.some((c) => c.ingredientId === "pork")).toBe(false)
  })

  it("対照: 期限が当日なら使える（期限が近い在庫として数える）", () => {
    const result = match("pork_ginger", [stock("pork", { quantity: q(300, "g"), expiresOn: TODAY }), onion])
    expect(result.level).toBe("ready")
    expect(result.expiringSoonCount).toBe(1)
  })

  it("食べる予定日で判定する: 今日は期限内でも、3 日後に食べるなら期限超過", () => {
    const pantry = [stock("pork", { quantity: q(300, "g"), expiresOn: "2026-11-12" }), onion]
    expect(match("pork_ginger", pantry, { eatOn: "2026-11-12" }).level).toBe("ready")
    expect(match("pork_ginger", pantry, { eatOn: "2026-11-14" }).level).toBe("buy")
  })

  it("「使い切った」は欠品扱い", () => {
    const result = match("pork_ginger", [stock("pork", { status: "out", quantity: q(300, "g") }), onion])
    expect(lineOf(result, "pork")).toMatchObject({ state: "missing", reasons: ["used_up"] })
  })

  it("数量 0 は欠品扱い", () => {
    const result = match("pork_ginger", [stock("pork", { quantity: q(0, "g") }), onion])
    expect(lineOf(result, "pork")).toMatchObject({ state: "missing", reasons: ["used_up"] })
  })

  it("期限超過の行と使える行が両方あれば、使える行だけを数える", () => {
    const result = match("pork_ginger", [
      stock("pork", { id: "old", quantity: q(300, "g"), expiresOn: "2026-11-01" }),
      stock("pork", { id: "new", quantity: q(200, "g"), expiresOn: "2026-11-20" }),
      onion,
    ])
    expect(result.level).toBe("ready")
    expect(result.consumption.filter((c) => c.ingredientId === "pork").map((c) => c.pantryItemId)).toEqual(["new"])
  })
})

describe("C-25 未登録の油・調味料を在庫ありと数えない", () => {
  const pantry = () => [stock("pork", { quantity: q(300, "g") }), stock("onion", { quantity: q(1, "piece") })]

  it("常備品の設定が無ければ、しょうゆ・油は不足（初期登録を捏造しない）", () => {
    const result = match("pork_ginger", pantry(), { stapleIngredientIds: [] })
    expect(result.level).toBe("buy")
    expect(result.missing.map((m) => m.ingredientId)).toEqual(["soy_sauce", "oil"])
  })

  it("世帯が常備品に設定した調味料は充足扱い", () => {
    const result = match("pork_ginger", pantry(), { stapleIngredientIds: ["soy_sauce", "oil"] })
    expect(result.level).toBe("ready")
  })

  it("常備品でも、在庫に「使い切った」と登録されていればその記録を優先する", () => {
    const result = match("pork_ginger", [...pantry(), stock("soy_sauce", { status: "out" })])
    expect(lineOf(result, "soy_sauce")).toMatchObject({ state: "missing", reasons: ["used_up"] })
    expect(result.level).toBe("buy")
  })

  it("「適量」「少々」の材料は、在庫にあれば足りる（量は比べない）", () => {
    const result = match("salmon_grill", [stock("salmon", { quantity: q(2, "slice") }), stock("salt")], {
      stapleIngredientIds: [],
    })
    expect(result.level).toBe("ready")
  })

  it("「少々」の材料でも、残り少ないなら確認へ回す", () => {
    const result = match("salmon_grill", [stock("salmon", { quantity: q(2, "slice") }), stock("salt", { status: "low" })], {
      stapleIngredientIds: [],
    })
    expect(lineOf(result, "salt")).toMatchObject({ state: "uncertain", reasons: ["low"] })
  })

  it("辞書に解決できていない在庫（ingredientId が null）は材料に数えない", () => {
    const result = match("pork_ginger", [stock(null, { name: "豚肉っぽいもの", quantity: q(500, "g") }), stock("onion", { quantity: q(1, "piece") })])
    expect(lineOf(result, "pork").reasons).toEqual(["not_in_pantry"])
  })
})

describe("人数・任意材料・引当", () => {
  it("人数を増やすと必要量も増える（元レシピ量から一度だけ計算）", () => {
    const pantry = [stock("pork", { quantity: q(300, "g") }), stock("onion", { quantity: q(1, "piece") })]
    expect(match("pork_ginger", pantry, {}, 2).level).toBe("ready")
    const forFour = match("pork_ginger", pantry, {}, 4)
    expect(lineOf(forFour, "pork")).toMatchObject({ required: q(400, "g"), shortBy: q(100, "g"), state: "missing" })
    expect(lineOf(forFour, "onion").state).toBe("enough")
  })

  it("任意材料が無くても「作れる」判定を妨げない", () => {
    const result = match("hiyayakko", [stock("tofu", { quantity: q(1, "block") })])
    expect(result.level).toBe("ready")
    expect(lineOf(result, "negi")).toMatchObject({ optional: true, state: "missing" })
    expect(result.missing).toEqual([])
  })

  it("同じ料理の中で同じ在庫を二重に数えない（同じ材料が 2 行あるレシピ）", () => {
    const dish = { ingredients: [ing("pork", 150, "g"), ing("pork", 150, "g")], servings: 2 }
    const result = matchDishToPantry(dish, 2, [stock("pork", { id: "p", quantity: q(200, "g") })], OPTIONS)
    expect(result.lines.map((l) => l.state)).toEqual(["enough", "missing"])
    expect(result.lines[1].shortBy).toEqual(q(100, "g"))
  })

  it("他の日へ割り当て済みの量は使えない（在庫そのものは変えない）", () => {
    const pork = stock("pork", { id: "p", quantity: q(300, "g") })
    const pantry = [pork, stock("onion", { quantity: q(2, "piece") })]
    const reserved = new Map<string, number>()
    const first = match("pork_ginger", pantry, { reserved })
    expect(first.level).toBe("ready")
    reserveConsumption(reserved, first.consumption)
    const second = match("pork_ginger", pantry, { reserved })
    expect(lineOf(second, "pork")).toMatchObject({ state: "missing", shortBy: q(100, "g"), stockCertain: 100 })
    expect(pork.quantity).toEqual(q(300, "g"))
  })

  it("全量を割り当て済みなら「割当済み」として欠品扱い", () => {
    const pantry = [stock("pork", { id: "p", quantity: q(200, "g") }), stock("onion", { quantity: q(2, "piece") })]
    const result = match("pork_ginger", pantry, { reserved: new Map([["p", 200]]) })
    expect(lineOf(result, "pork")).toMatchObject({ state: "missing", reasons: ["allocated"] })
  })

  it("期限の近い在庫から先に使う", () => {
    const pantry = [
      stock("pork", { id: "later", quantity: q(200, "g"), expiresOn: "2026-11-20" }),
      stock("pork", { id: "sooner", quantity: q(200, "g"), expiresOn: "2026-11-12" }),
      stock("onion", { quantity: q(1, "piece") }),
    ]
    const result = match("pork_ginger", pantry)
    expect(result.consumption.find((c) => c.ingredientId === "pork")?.pantryItemId).toBe("sooner")
  })

  it("「早く使いたい」在庫を使う料理は件数を返す（採点用）", () => {
    const result = match("pork_ginger", [
      stock("pork", { quantity: q(200, "g"), useSoon: true }),
      stock("onion", { quantity: q(1, "piece") }),
    ])
    expect(result.useSoonCount).toBe(1)
  })

  it("必須材料が 1 つも無い料理を「揃っている」と言わない", () => {
    const result = matchDishToPantry({ ingredients: [], servings: 2 }, 2, [], OPTIONS)
    expect(result.level).toBe("check")
  })
})
