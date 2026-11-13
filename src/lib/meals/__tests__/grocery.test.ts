import { describe, expect, it } from "vitest"

import { storeSectionLabel, storeSectionOrder } from "../catalog/sections"
import {
  buildGroceryNeeds,
  type ExistingGroceryItem,
  type GroceryInput,
  type GroceryMergeResult,
  groceryItemKey,
  mergeWithExisting,
  normalizeSection,
  planRestock,
  remainingToBuy,
  restockableAmount,
} from "../grocery"
import type { PantryItem, PlanEntry } from "../types"
import { CATALOG, ing, planEntry, q, STAPLES, stock } from "./fixtures"

const FROM = "2026-11-11"
const TO = "2026-11-17"

function input(entries: PlanEntry[], pantry: PantryItem[] = [], overrides: Partial<GroceryInput> = {}): GroceryInput {
  return { entries, from: FROM, to: TO, pantry, today: FROM, stapleIngredientIds: STAPLES, catalog: CATALOG, ...overrides }
}

const GINGER = planEntry({ id: "e1", date: "2026-11-11", recipeId: "pork_ginger" })
const CURRY = planEntry({ id: "e2", date: "2026-11-13", recipeId: "pork_curry" })

function need(result: ReturnType<typeof buildGroceryNeeds>, itemKey: string) {
  const found = result.needs.find((n) => n.itemKey === itemKey)
  if (!found) throw new Error(`need not found: ${itemKey} in ${result.needs.map((n) => n.itemKey).join(",")}`)
  return found
}

describe("V-C3 必要材料の展開（C-41 / C-44）", () => {
  it("確定した枠の材料を展開し、どの日のどの料理に必要かを持つ", () => {
    const result = buildGroceryNeeds(input([GINGER, CURRY]))
    const pork = need(result, "pork:mass")
    expect(pork).toMatchObject({ ingredientId: "pork", name: "豚肉", section: "meat", required: q(400, "g"), needsStockCheck: false })
    expect(pork.sources).toEqual([
      { date: "2026-11-11", recipeId: "pork_ginger", title: "豚の生姜焼き風", quantity: q(200, "g") },
      { date: "2026-11-13", recipeId: "pork_curry", title: "ポークカレー", quantity: q(200, "g") },
    ])
  })

  it("対象は確定した枠だけ（提案・作り終えた・作らなかった枠は含めない）", () => {
    const entries = [
      GINGER,
      planEntry({ id: "p", date: "2026-11-12", recipeId: "salmon_grill", status: "proposed" }),
      planEntry({ id: "c", date: "2026-11-12", recipeId: "tofu_steak", status: "cooked" }),
      planEntry({ id: "s", date: "2026-11-12", recipeId: "shrimp_egg", status: "skipped" }),
    ]
    const result = buildGroceryNeeds(input(entries))
    expect(result.needs.map((n) => n.ingredientId)).toEqual(["onion", "pork"])
  })

  it("日付の範囲の外にある枠は含めない（両端は含む）", () => {
    const entries = [
      planEntry({ id: "before", date: "2026-11-10", recipeId: "salmon_grill" }),
      planEntry({ id: "first", date: FROM, recipeId: "tofu_steak" }),
      planEntry({ id: "last", date: TO, recipeId: "shrimp_egg" }),
      planEntry({ id: "after", date: "2026-11-18", recipeId: "pork_ginger" }),
    ]
    const result = buildGroceryNeeds(input(entries))
    expect(result.needs.map((n) => n.ingredientId).sort()).toEqual(["egg", "shrimp", "tofu"])
  })

  it("人数を反映する: 2 人分のレシピを 4 人分・3 人分で確定すると、元の量から一度だけ計算する", () => {
    const four = buildGroceryNeeds(input([{ ...GINGER, servings: 4 }]))
    expect(need(four, "pork:mass").required).toEqual(q(400, "g"))
    expect(need(four, "onion:count:piece").required).toEqual(q(1, "piece"))
    const three = buildGroceryNeeds(input([{ ...GINGER, servings: 3 }]))
    expect(need(three, "pork:mass").required).toEqual(q(300, "g"))
    expect(need(three, "onion:count:piece").required).toEqual(q(0.75, "piece"))
  })

  it("売場ごとに、売場を回る順で返す。辞書に無い材料は「その他」に残す", () => {
    const manual = planEntry({
      id: "m",
      date: "2026-11-12",
      customTitle: "手作りスープ",
      customIngredients: [ing("mystery_spice", 1, "bag"), ing("tofu", 1, "block")],
    })
    const result = buildGroceryNeeds(input([GINGER, manual]))
    expect(result.bySection.map((g) => [g.section, g.label, g.items.map((i) => i.ingredientId)])).toEqual([
      ["vegetable", storeSectionLabel("vegetable"), ["onion"]],
      ["meat", storeSectionLabel("meat"), ["pork"]],
      ["soy", storeSectionLabel("soy"), ["tofu"]],
      ["other", storeSectionLabel("other"), ["mystery_spice"]],
    ])
    // 並びは売場の定義の順（野菜 → 肉 → … → その他）
    const order = result.bySection.map((g) => storeSectionOrder(g.section))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(need(result, "mystery_spice:count:bag")).toMatchObject({ name: "mystery_spice", section: "other" })
  })

  it("未知の売場の値は「その他」へ寄せる", () => {
    expect(normalizeSection("bakery")).toBe("other")
    expect(normalizeSection(null)).toBe("other")
    expect(normalizeSection("fish")).toBe("fish")
  })

  it("常備品（世帯の設定）は買い物に出さず、そう扱ったことを返す", () => {
    const result = buildGroceryNeeds(input([GINGER]))
    expect(result.needs.some((n) => n.ingredientId === "soy_sauce" || n.ingredientId === "oil")).toBe(false)
    expect(result.stapleAssumed).toEqual([
      { ingredientId: "oil", name: "サラダ油" },
      { ingredientId: "soy_sauce", name: "しょうゆ" },
    ])
  })

  it("対照: 常備品の設定が無ければ、調味料も買い物に出す（在庫ありと見なさない）", () => {
    const result = buildGroceryNeeds(input([GINGER], [], { stapleIngredientIds: [] }))
    expect(need(result, "soy_sauce:volume").required).toEqual(q(15, "ml"))
    expect(need(result, "oil:volume").required).toEqual(q(5, "ml"))
    expect(result.stapleAssumed).toEqual([])
  })

  it("任意材料は自動の買い物に入れない", () => {
    const hiyayakko = planEntry({ id: "h", date: "2026-11-12", recipeId: "hiyayakko", role: "side" })
    const result = buildGroceryNeeds(input([hiyayakko]))
    expect(result.needs.map((n) => n.ingredientId)).toEqual(["tofu"])
  })

  it("確定した枠が無ければ空（落ちない）", () => {
    expect(buildGroceryNeeds(input([]))).toEqual({
      needs: [],
      held: [],
      covered: [],
      bySection: [],
      uncomputed: [],
      stapleAssumed: [],
      versionMismatches: [],
    })
  })

  it("使わない食材の設定で外した確定の枠（heldEntryIds）は材料を入れず held に返す。範囲外・提案は返さない", () => {
    const held = planEntry({ id: "e-held", date: "2026-11-12", recipeId: "pork_ginger", servings: 2 })
    const kept = planEntry({ id: "e-kept", date: "2026-11-13", recipeId: "pork_curry", servings: 2 })
    const result = buildGroceryNeeds({ ...input([held, kept]), heldEntryIds: new Set(["e-held", "e-out-of-range"]) })
    expect(result.held).toEqual([{ entryId: "e-held", date: "2026-11-12", title: expect.any(String) }])
    expect(result.needs.flatMap((need) => need.sources.map((source) => source.date))).not.toContain("2026-11-12")
    // 対照: 外さなければ、その日の料理の材料が入る
    const all = buildGroceryNeeds(input([held, kept]))
    expect(all.held).toEqual([])
    expect(all.needs.flatMap((need) => need.sources.map((source) => source.date))).toContain("2026-11-12")
  })
})

describe("V-C3 互換単位だけ集計（C-42）", () => {
  it("同じ食材でも単位の族が違えば別の項目にする（個と g を足さない）", () => {
    const grams = planEntry({
      id: "g",
      date: "2026-11-12",
      customTitle: "キャベツ炒め",
      customIngredients: [ing("cabbage", 0.5, "piece"), ing("onion", 100, "g")],
    })
    const result = buildGroceryNeeds(input([planEntry({ id: "s", date: "2026-11-11", recipeId: "cabbage_salad", role: "side" }), GINGER, grams]))
    expect(need(result, "cabbage:mass").required).toEqual(q(200, "g"))
    expect(need(result, "cabbage:count:piece").required).toEqual(q(0.5, "piece"))
    expect(need(result, "onion:count:piece").required).toEqual(q(0.5, "piece"))
    expect(need(result, "onion:mass").required).toEqual(q(100, "g"))
  })

  it("g と kg、ml と大さじ・小さじは換算して合算する", () => {
    const a = planEntry({ id: "a", date: "2026-11-11", customTitle: "A", customIngredients: [ing("pork", 0.3, "kg"), ing("milk", 1, "cup")] })
    const b = planEntry({ id: "b", date: "2026-11-12", customTitle: "B", customIngredients: [ing("pork", 150, "g"), ing("milk", 2, "tbsp"), ing("milk", 1, "tsp")] })
    const result = buildGroceryNeeds(input([a, b]))
    expect(need(result, "pork:mass").required).toEqual(q(450, "g"))
    expect(need(result, "milk:volume").required).toEqual(q(235, "ml"))
  })

  it("適量・少々は数値化しない。同じ食材に数値の項目があればそこへ添える", () => {
    const dish = planEntry({
      id: "d",
      date: "2026-11-11",
      customTitle: "塩もみ",
      customIngredients: [ing("salt", null, "pinch"), ing("milk", null, "to_taste"), ing("milk", 100, "ml")],
    })
    const result = buildGroceryNeeds(input([dish], [], { stapleIngredientIds: [] }))
    expect(need(result, "salt:none")).toMatchObject({ required: null, nonNumeric: ["少々"] })
    expect(need(result, "milk:volume")).toMatchObject({ required: q(100, "ml"), nonNumeric: ["適量"] })
    expect(result.needs.some((n) => n.itemKey === "milk:none")).toBe(false)
  })

  it("鍵は食材 ID と単位の族で決まる", () => {
    expect(groceryItemKey("pork", "kg")).toBe("pork:mass")
    expect(groceryItemKey("pork", "g")).toBe("pork:mass")
    expect(groceryItemKey("egg", "piece")).toBe("egg:count:piece")
    expect(groceryItemKey("egg", "pack")).toBe("egg:count:pack")
  })
})

describe("V-C3 在庫を一度だけ差し引く（C-41 / C-43）", () => {
  it("数量の分かる在庫を差し引く。足りる材料は買い物に出さない", () => {
    const pantry = [stock("pork", { quantity: q(150, "g") }), stock("onion", { quantity: q(3, "piece") })]
    const result = buildGroceryNeeds(input([GINGER], pantry))
    expect(need(result, "pork:mass")).toMatchObject({ required: q(50, "g"), gross: q(200, "g"), fromStock: q(150, "g") })
    expect(result.needs.some((n) => n.ingredientId === "onion")).toBe(false)
    expect(result.covered.map((n) => n.ingredientId)).toEqual(["onion"])
  })

  it("同じ在庫を 2 つの料理から二重に引かない: 250g の在庫で 200g + 200g なら 150g を買う", () => {
    const pantry = [stock("pork", { quantity: q(250, "g") })]
    const result = buildGroceryNeeds(input([GINGER, CURRY], pantry))
    expect(need(result, "pork:mass")).toMatchObject({ gross: q(400, "g"), fromStock: q(250, "g"), required: q(150, "g") })
  })

  it("数量不明の在庫は差し引かず、「在庫量を確認」を立てる（全量あると見なさない）", () => {
    const result = buildGroceryNeeds(input([GINGER], [stock("pork"), stock("onion", { quantity: q(1, "piece") })]))
    expect(need(result, "pork:mass")).toMatchObject({ required: q(200, "g"), fromStock: q(0, "g"), needsStockCheck: true })
  })

  it("対照: 在庫が無い材料は「在庫量を確認」を立てない", () => {
    const result = buildGroceryNeeds(input([GINGER], []))
    expect(need(result, "pork:mass")).toMatchObject({ required: q(200, "g"), needsStockCheck: false })
  })

  it("単位を換算できない在庫（パック）は差し引かず、確認を立てる", () => {
    const result = buildGroceryNeeds(input([GINGER], [stock("pork", { quantity: q(1, "pack") })]))
    expect(need(result, "pork:mass")).toMatchObject({ required: q(200, "g"), needsStockCheck: true })
  })

  it("最終確認が古い在庫は差し引かず、確認を立てる", () => {
    const result = buildGroceryNeeds(input([GINGER], [stock("pork", { quantity: q(300, "g"), confirmedOn: "2026-10-01" })]))
    expect(need(result, "pork:mass")).toMatchObject({ required: q(200, "g"), fromStock: q(0, "g"), needsStockCheck: true })
  })

  it("期限超過（食べる日時点）・使い切った在庫は差し引かない", () => {
    const pantry = [
      stock("pork", { id: "old", quantity: q(300, "g"), expiresOn: "2026-11-12" }),
      stock("onion", { status: "out", quantity: q(5, "piece") }),
    ]
    const result = buildGroceryNeeds(input([GINGER, CURRY], pantry))
    // 11/11 の生姜焼きには使えるが、11/13 のカレーには期限切れ
    expect(need(result, "pork:mass")).toMatchObject({ gross: q(400, "g"), fromStock: q(200, "g"), required: q(200, "g") })
    expect(need(result, "onion:count:piece").required).toEqual(q(1.5, "piece"))
  })

  it("在庫そのものは変更しない", () => {
    const pantry = [stock("pork", { quantity: q(250, "g") })]
    const snapshot = JSON.parse(JSON.stringify(pantry))
    buildGroceryNeeds(input([GINGER, CURRY], pantry))
    expect(pantry).toEqual(snapshot)
  })
})

describe("C-37 手動料理・版", () => {
  it("材料が未登録の手動料理は「自動計算の対象外」として一覧で返す", () => {
    const manual = planEntry({ id: "m1", date: "2026-11-12", customTitle: "実家のおでん" })
    const empty = planEntry({ id: "m2", date: "2026-11-13", customTitle: "残り物", customIngredients: [] })
    const result = buildGroceryNeeds(input([GINGER, manual, empty]))
    expect(result.uncomputed).toEqual([
      { entryId: "m1", date: "2026-11-12", title: "実家のおでん", reason: "no_ingredients" },
      { entryId: "m2", date: "2026-11-13", title: "残り物", reason: "no_ingredients" },
    ])
    // 対照: 材料のある料理は計算する
    expect(result.needs.map((n) => n.ingredientId)).toEqual(["onion", "pork"])
  })

  it("材料を登録した手動料理は計算に入る（その枠の人数ぶんとして扱う）", () => {
    const manual = planEntry({ id: "m", date: "2026-11-12", servings: 4, customTitle: "鍋", customIngredients: [ing("tofu", 2, "block")] })
    const result = buildGroceryNeeds(input([manual]))
    expect(need(result, "tofu:count:block").required).toEqual(q(2, "block"))
    expect(result.uncomputed).toEqual([])
  })

  it("カタログに無いレシピの枠は対象外として返し、予定の版と今の版が違えば知らせる", () => {
    const orphan = planEntry({ id: "o", date: "2026-11-12", recipeId: "removed_recipe" })
    const oldVersion = planEntry({ id: "v", date: "2026-11-13", recipeId: "pork_ginger", recipeVersion: 0 })
    const result = buildGroceryNeeds(input([orphan, oldVersion]))
    expect(result.uncomputed).toEqual([{ entryId: "o", date: "2026-11-12", title: "removed_recipe", reason: "unknown_recipe" }])
    expect(result.versionMismatches).toEqual([{ entryId: "v", recipeId: "pork_ginger", plannedVersion: 0, currentVersion: 1 }])
  })
})

function existing(overrides: Partial<ExistingGroceryItem> & Pick<ExistingGroceryItem, "id">): ExistingGroceryItem {
  return {
    itemKey: null,
    name: "",
    section: "other",
    sectionOverridden: false,
    required: null,
    purchased: null,
    restocked: null,
    checked: false,
    note: null,
    ...overrides,
  }
}

/** 突き合わせの結果を保存した後の既存リスト（新しい項目へ ID を振る）。 */
function applyMerge(result: GroceryMergeResult, before: ExistingGroceryItem[]): ExistingGroceryItem[] {
  const retainedIds = new Set(result.retained.map((r) => r.id))
  return [
    ...result.manual,
    ...before.filter((item) => retainedIds.has(item.id)),
    ...result.upserts.map((u) =>
      existing({
        id: u.id ?? `new-${u.itemKey}`,
        itemKey: u.itemKey,
        name: u.name,
        section: u.section,
        sectionOverridden: before.find((b) => b.id === u.id)?.sectionOverridden ?? false,
        required: u.required,
        purchased: u.purchased,
        restocked: u.restocked,
        checked: u.checked,
        note: u.note,
      }),
    ),
  ]
}

describe("V-C3 300g → 500g で追加 200g（C-46）", () => {
  it("300g 購入した後に必要量が 500g へ増えたら、残りは 200g", () => {
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(300, "g"), restocked: null })).toEqual(q(200, "g"))
  })

  it("購入量が必要量以上なら残りは 0（負にしない）。ちょうどでも 0", () => {
    expect(remainingToBuy({ required: q(300, "g"), purchased: q(300, "g"), restocked: null })).toEqual(q(0, "g"))
    expect(remainingToBuy({ required: q(300, "g"), purchased: q(1, "kg"), restocked: null })).toEqual(q(0, "g"))
  })

  it("何も買っていなければ、残りは必要量そのもの", () => {
    expect(remainingToBuy({ required: q(0.5, "kg"), purchased: null, restocked: null })).toEqual(q(500, "g"))
  })

  it("単位の族が違う購入量は差し引かない（2 パック買っても 500g の残りは 500g のまま）", () => {
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(2, "pack"), restocked: null })).toEqual(q(500, "g"))
  })

  it("数値化できない項目（適量）は残りを数値で言わない", () => {
    expect(remainingToBuy({ required: null, purchased: null, restocked: null })).toBeNull()
  })

  it("再計算で必要量が増えると、購入済みだった項目が「未購入の残りあり」へ戻る", () => {
    const before = [existing({ id: "g1", itemKey: "pork:mass", name: "豚肉", section: "meat", required: q(300, "g"), purchased: q(300, "g"), checked: true })]
    const needs = buildGroceryNeeds(input([GINGER, CURRY, planEntry({ id: "e3", date: "2026-11-14", recipeId: "pork_ginger", servings: 1 })])).needs
    const pork = mergeWithExisting(needs, before).upserts.find((u) => u.itemKey === "pork:mass")
    expect(pork).toMatchObject({ id: "g1", required: q(500, "g"), purchased: q(300, "g"), remaining: q(200, "g"), checked: false })
  })
})

describe("C-47 購入済みと在庫補充は別の事実", () => {
  const bought = { purchased: q(300, "g"), restocked: null }

  it("購入しただけでは在庫へ入らない。反映できる量は購入量まで", () => {
    expect(restockableAmount(bought)).toEqual(q(300, "g"))
    expect(restockableAmount({ purchased: null, restocked: null })).toBeNull()
  })

  it("確認した量だけを反映する（200g を確認 → 200g だけ）", () => {
    expect(planRestock(bought, q(200, "g"))).toEqual({ added: q(200, "g"), restocked: q(200, "g") })
  })

  it("同じ操作が 2 回届いても、二重に反映しない", () => {
    const first = planRestock(bought, q(300, "g"))
    expect(first).toEqual({ added: q(300, "g"), restocked: q(300, "g") })
    const second = planRestock({ purchased: bought.purchased, restocked: first?.restocked ?? null }, q(300, "g"))
    expect(second).toEqual({ added: q(0, "g"), restocked: q(300, "g") })
  })

  it("購入量を超えては反映しない。単位の族が違う量は反映しない", () => {
    expect(planRestock(bought, q(1, "kg"))).toEqual({ added: q(300, "g"), restocked: q(300, "g") })
    expect(planRestock(bought, q(1, "pack"))).toBeNull()
  })

  it("在庫へ反映した後に再計算しても、二重に差し引かない: 必要 500g・購入 300g を在庫へ入れても残りは 200g", () => {
    const entries = [GINGER, CURRY, planEntry({ id: "e3", date: "2026-11-14", recipeId: "pork_ginger", servings: 1 })]
    // 反映前: 在庫 0、購入 300g → 残り 200g
    const beforeRestock = mergeWithExisting(buildGroceryNeeds(input(entries)).needs, [
      existing({ id: "g1", itemKey: "pork:mass", purchased: q(300, "g") }),
    ]).upserts.find((u) => u.itemKey === "pork:mass")
    expect(beforeRestock?.remaining).toEqual(q(200, "g"))
    // 反映後: 在庫に 300g、購入 300g（うち 300g を在庫へ反映済み）→ 必要量は 200g、残りも 200g
    const afterRestock = mergeWithExisting(buildGroceryNeeds(input(entries, [stock("pork", { quantity: q(300, "g") })])).needs, [
      existing({ id: "g1", itemKey: "pork:mass", purchased: q(300, "g"), restocked: q(300, "g") }),
    ]).upserts.find((u) => u.itemKey === "pork:mass")
    expect(afterRestock).toMatchObject({ required: q(200, "g"), remaining: q(200, "g") })
  })
})

describe("作った料理への充当は、購入・補充と別の事実（残り・在庫へ足せる量から外す）", () => {
  it("必要 500g・購入 300g → 残り 200g。300g を作った料理に使えば、次の 500g は丸ごと残る", () => {
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(300, "g"), restocked: null, consumed: null })).toEqual(q(200, "g"))
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(300, "g"), restocked: null, consumed: q(300, "g") })).toEqual(
      q(500, "g"),
    )
    // 作った後に 100g を買い足した（購入の事実 400g）→ 充てられるのは 100g、残り 400g
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(400, "g"), restocked: null, consumed: q(300, "g") })).toEqual(
      q(400, "g"),
    )
    // 単位の族が同じなら換算して引く（0.3kg 使用）
    expect(remainingToBuy({ required: q(500, "g"), purchased: q(400, "g"), restocked: null, consumed: q(0.3, "kg") })).toEqual(
      q(400, "g"),
    )
  })

  it("在庫へ足せるのは 購入 − 補充 − 使った量 まで。使った量・補充が購入を超えて記録されていても 0 未満にしない", () => {
    expect(restockableAmount({ purchased: q(500, "g"), restocked: q(100, "g"), consumed: q(300, "g") })).toEqual(q(100, "g"))
    expect(planRestock({ purchased: q(500, "g"), restocked: q(100, "g"), consumed: q(300, "g") }, q(1, "kg"))).toEqual({
      added: q(100, "g"),
      restocked: q(200, "g"),
    })
    // 使った量が「購入 − 補充」を超えた記録（購入の事実を後から下げた等）は、超えた分を数えない
    expect(restockableAmount({ purchased: q(300, "g"), restocked: q(100, "g"), consumed: q(500, "g") })).toEqual(q(0, "g"))
    expect(remainingToBuy({ required: q(200, "g"), purchased: q(300, "g"), restocked: q(100, "g"), consumed: q(500, "g") })).toEqual(
      q(200, "g"),
    )
    // 対照: 使った量が無ければ従来どおり（購入 − 補充）
    expect(restockableAmount({ purchased: q(500, "g"), restocked: q(100, "g") })).toEqual(q(400, "g"))
  })
})

describe("V-C3 再生成の冪等性と手動項目の維持（C-45）", () => {
  const needs = () => buildGroceryNeeds(input([GINGER, CURRY], [], { stapleIngredientIds: [] })).needs

  it("同じ入力で何度計算しても同じ必要量", () => {
    expect(needs()).toEqual(needs())
  })

  it("既存が空なら全て新規。鍵は重複しない", () => {
    const result = mergeWithExisting(needs(), [])
    expect(result.upserts.every((u) => u.id === null)).toBe(true)
    expect(new Set(result.upserts.map((u) => u.itemKey)).size).toBe(result.upserts.length)
    expect(result).toMatchObject({ retained: [], removals: [], manual: [] })
  })

  it("結果を保存してもう一度突き合わせても、項目は増えず内容も同じ", () => {
    const first = mergeWithExisting(needs(), [])
    const stored = applyMerge(first, [])
    const second = mergeWithExisting(needs(), stored)
    expect(second.upserts).toHaveLength(first.upserts.length)
    expect(second.upserts.every((u) => u.id !== null)).toBe(true)
    expect(second.removals).toEqual([])
    expect(second.retained).toEqual([])
    const third = mergeWithExisting(needs(), applyMerge(second, stored))
    expect(third).toEqual(second)
  })

  it("手動で足した項目は、再計算で消さず変えない", () => {
    const manual = existing({ id: "m1", name: "牛乳", section: "egg_dairy", note: "低脂肪", checked: true })
    const result = mergeWithExisting(needs(), [manual])
    expect(result.manual).toEqual([manual])
    expect(result.removals).toEqual([])
    expect(result.upserts.some((u) => u.id === "m1")).toBe(false)
  })

  it("自動項目の購入量・メモ・売場の変更を保持する", () => {
    const before = [
      existing({
        id: "g1",
        itemKey: "pork:mass",
        name: "豚肉",
        section: "other",
        sectionOverridden: true,
        required: q(400, "g"),
        purchased: q(100, "g"),
        note: "国産",
      }),
    ]
    const pork = mergeWithExisting(needs(), before).upserts.find((u) => u.itemKey === "pork:mass")
    expect(pork).toMatchObject({ id: "g1", section: "other", purchased: q(100, "g"), note: "国産", remaining: q(300, "g") })
    // 対照: 売場を変えていない項目は辞書の売場に従う
    const fresh = mergeWithExisting(needs(), [existing({ id: "g1", itemKey: "pork:mass", section: "other" })]).upserts.find(
      (u) => u.itemKey === "pork:mass",
    )
    expect(fresh?.section).toBe("meat")
  })

  it("献立から外れて不要になった自動項目: 入力が無ければ消し、購入履歴・メモがあれば残す", () => {
    const before = [
      existing({ id: "plain", itemKey: "salmon:count:slice", name: "鮭", required: q(2, "slice") }),
      existing({ id: "bought", itemKey: "tofu:count:block", name: "豆腐", required: q(1, "block"), purchased: q(1, "block"), checked: true }),
      existing({ id: "noted", itemKey: "shrimp:mass", name: "えび", required: q(150, "g"), note: "冷凍でも可" }),
    ]
    const result = mergeWithExisting(needs(), before)
    expect(result.removals).toEqual(["plain"])
    expect(result.retained).toEqual([
      { id: "bought", itemKey: "tofu:count:block", reasons: ["purchased", "checked"] },
      { id: "noted", itemKey: "shrimp:mass", reasons: ["note"] },
    ])
  })

  it("同じ鍵の項目が既に重複していても、増やさず 1 つへ寄せる", () => {
    const before = [
      existing({ id: "a", itemKey: "pork:mass", required: q(400, "g") }),
      existing({ id: "b", itemKey: "pork:mass", required: q(400, "g") }),
      existing({ id: "c", itemKey: "pork:mass", required: q(400, "g"), note: "メモあり" }),
    ]
    const result = mergeWithExisting(needs(), before)
    expect(result.upserts.filter((u) => u.itemKey === "pork:mass").map((u) => u.id)).toEqual(["a"])
    expect(result.removals).toEqual(["b"])
    expect(result.retained).toEqual([{ id: "c", itemKey: "pork:mass", reasons: ["note"] }])
  })

  it("量の無いチェック（適量の項目など）は、再計算でチェックを保つ", () => {
    const saltNeed = buildGroceryNeeds(
      input([planEntry({ id: "s", date: "2026-11-11", recipeId: "salmon_grill" })], [], { stapleIngredientIds: [] }),
    ).needs
    const before = [existing({ id: "salt", itemKey: "salt:none", checked: true })]
    const salt = mergeWithExisting(saltNeed, before).upserts.find((u) => u.itemKey === "salt:none")
    expect(salt).toMatchObject({ id: "salt", checked: true, remaining: null })
  })
})
