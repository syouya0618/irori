import { describe, expect, it } from "vitest"

import {
  childAgeMonths,
  findAgeRuleWarnings,
  type MealChild,
  resolveChildServing,
  summarizeChildServing,
} from "../child-serving"
import { CATALOG, ing, recipeById, RECIPES, TODDLER_GUIDE } from "./fixtures"

const ON = "2026-11-11"
const INDEX = CATALOG.index

function child(birthDate: string | null, mealStage: string | null = null, id = "kid"): MealChild {
  return { id, birthDate, mealStage }
}

describe("月齢の計算（既存 ageMonthsAt を再利用）", () => {
  it("誕生日の前日は 11 か月台、当日でちょうど 12 か月", () => {
    expect(childAgeMonths("2025-11-12", ON)).toBeLessThan(12)
    expect(childAgeMonths("2025-11-11", ON)).toBe(12)
  })

  it("生年月日が無い・不正・基準日より後なら null", () => {
    expect(childAgeMonths(null, ON)).toBeNull()
    expect(childAgeMonths("2026-02-30", ON)).toBeNull()
    expect(childAgeMonths("2026-12-01", ON)).toBeNull()
  })
})

describe("C-62 / C-64 取り分け案内は、対応根拠のあるレシピにだけ出す", () => {
  const supported = recipeById("chicken_teriyaki")
  const unsupported = recipeById("pork_ginger")

  it("肯定側: 保護者が「幼児食」と設定した 3 歳には、対応レシピの案内を出す", () => {
    const result = resolveChildServing(supported, child("2023-10-01", "toddler"), ON, INDEX)
    expect(result).toEqual({ show: TODDLER_GUIDE, basis: "guardian_stage", label: "幼児食" })
  })

  it("案内を持たないレシピは、どの子に対しても「未対応」（一般ガイドの存在だけで対応扱いにしない）", () => {
    for (const kid of [child("2023-10-01", "toddler"), child("2020-01-01"), child(null)]) {
      expect(resolveChildServing(unsupported, kid, ON, INDEX)).toEqual({ show: null, reason: "未対応" })
    }
  })

  it("fixture の全レシピのうち、案内が出るのは childServing を持つものだけ", () => {
    const kid = child("2023-10-01", "toddler")
    const shown = RECIPES.filter((r) => resolveChildServing(r, kid, ON, INDEX).show !== null).map((r) => r.id)
    expect(shown.sort()).toEqual(["chicken_teriyaki", "honey_chicken"])
  })

  it("R27 / C-61 / C-64: 食事の段階が未設定なら、2 歳以上でも月齢だけからは案内を出さない（「未設定」）", () => {
    for (const birthDate of ["2024-11-11", "2024-10-01", "2022-01-01"]) {
      expect(resolveChildServing(supported, child(birthDate), ON, INDEX), birthDate).toEqual({ show: null, reason: "未設定" })
    }
    // 対照: 同じ子に保護者が「幼児食」と設定すれば出る
    expect(resolveChildServing(supported, child("2024-11-11", "toddler"), ON, INDEX)).toEqual({
      show: TODDLER_GUIDE,
      basis: "guardian_stage",
      label: "幼児食",
    })
    // まとめでも同じ
    const summary = summarizeChildServing(supported, [child("2024-10-01")], ON, INDEX)
    expect(summary.perChild).toEqual([{ childId: "kid", result: { show: null, reason: "未設定" } }])
  })

  it("境界: 2 歳の誕生日の前日は対象月齢外、当日から案内を出す（保護者が「幼児食」と設定した子）", () => {
    expect(resolveChildServing(supported, child("2024-11-12", "toddler"), ON, INDEX)).toEqual({ show: null, reason: "対象月齢外" })
    expect(resolveChildServing(supported, child("2024-11-11", "toddler"), ON, INDEX).show).not.toBeNull()
    // 段階が未設定の子は、2 歳未満なら月齢で対象外、2 歳以上なら未設定（どちらも出さない）
    expect(resolveChildServing(supported, child("2024-11-12"), ON, INDEX)).toEqual({ show: null, reason: "対象月齢外" })
    expect(resolveChildServing(supported, child("2024-11-11"), ON, INDEX)).toEqual({ show: null, reason: "未設定" })
  })

  it("保護者が「離乳開始前」と設定していれば、月齢にかかわらず出さない", () => {
    expect(resolveChildServing(supported, child("2023-01-01", "not_started"), ON, INDEX)).toEqual({
      show: null,
      reason: "離乳開始前",
    })
  })

  it.each(["weaning_early", "weaning_mid", "weaning_late", "weaning_complete"])(
    "保護者の設定が離乳期（%s）なら、2 歳を過ぎていても幼児向けの案内を出さない（設定を月齢より優先）",
    (stage) => {
      expect(resolveChildServing(supported, child("2023-01-01", stage), ON, INDEX)).toEqual({
        show: null,
        reason: "対象月齢外",
      })
    },
  )

  it("保護者が「幼児食」と設定していても、案内の対象月齢（2 歳）未満なら出さない", () => {
    expect(resolveChildServing(supported, child("2025-05-01", "toddler"), ON, INDEX)).toEqual({
      show: null,
      reason: "対象月齢外",
    })
  })

  it("生年月日が無ければ「未設定」（段階の設定だけでは月齢を確かめられない）", () => {
    expect(resolveChildServing(supported, child(null), ON, INDEX)).toEqual({ show: null, reason: "未設定" })
    expect(resolveChildServing(supported, child(null, "toddler"), ON, INDEX)).toEqual({ show: null, reason: "未設定" })
  })

  it("読めない段階の値（先に増えた値）は、推定で出さず「未設定」にする", () => {
    expect(resolveChildServing(supported, child("2020-01-01", "some_future_stage"), ON, INDEX)).toEqual({
      show: null,
      reason: "未設定",
    })
  })

  it("月齢だけで離乳の段階を決めつけない: 設定の無い 3 か月児・8 か月児は「離乳開始前」等と断定せず、対象月齢外とだけ返す", () => {
    expect(resolveChildServing(supported, child("2026-08-11"), ON, INDEX)).toEqual({ show: null, reason: "対象月齢外" })
    expect(resolveChildServing(supported, child("2026-03-11"), ON, INDEX)).toEqual({ show: null, reason: "対象月齢外" })
  })
})

describe("C-65 年齢制約（1 歳未満のはちみつ）", () => {
  const honeyChicken = recipeById("honey_chicken")

  it("1 歳未満の子がいる世帯では、はちみつを含む料理に警告を返す", () => {
    const warnings = findAgeRuleWarnings(honeyChicken.ingredients, [child("2026-01-15")], ON, INDEX)
    expect(warnings).toEqual([
      {
        childId: "kid",
        ingredientId: "honey",
        ingredientName: "はちみつ",
        ruleIngredientId: "honey",
        minAgeMonths: 12,
        sourceId: "mhlw-honey",
        ageUnknown: false,
      },
    ])
  })

  it("境界: 1 歳の誕生日の前日は警告あり、当日からは警告なし", () => {
    expect(findAgeRuleWarnings(honeyChicken.ingredients, [child("2025-11-12")], ON, INDEX)).toHaveLength(1)
    expect(findAgeRuleWarnings(honeyChicken.ingredients, [child("2025-11-11")], ON, INDEX)).toEqual([])
  })

  it("対照: はちみつを含まない料理には、0 歳児がいても警告しない", () => {
    expect(findAgeRuleWarnings(recipeById("salmon_grill").ingredients, [child("2026-08-01")], ON, INDEX)).toEqual([])
  })

  it("子どもがいない世帯には警告しない", () => {
    expect(findAgeRuleWarnings(honeyChicken.ingredients, [], ON, INDEX)).toEqual([])
  })

  it("該当する子だけを返す（0 歳と 3 歳のきょうだい）", () => {
    const warnings = findAgeRuleWarnings(
      honeyChicken.ingredients,
      [child("2026-06-01", null, "baby"), child("2023-06-01", null, "older")],
      ON,
      INDEX,
    )
    expect(warnings.map((w) => w.childId)).toEqual(["baby"])
  })

  it("はちみつ入りの加工品（派生食材）と任意材料も対象にする", () => {
    const viaDerived = findAgeRuleWarnings([ing("honey_mustard", 1, "tbsp")], [child("2026-06-01")], ON, INDEX)
    expect(viaDerived).toMatchObject([{ ingredientId: "honey_mustard", ruleIngredientId: "honey" }])
    const viaOptional = findAgeRuleWarnings([ing("honey", 1, "tsp", true)], [child("2026-06-01")], ON, INDEX)
    expect(viaOptional).toHaveLength(1)
  })

  it("生年月日が無い子は判定できないため、確認を促す印を付けて返す（安全と見なさない）", () => {
    const warnings = findAgeRuleWarnings(honeyChicken.ingredients, [child(null)], ON, INDEX)
    expect(warnings).toMatchObject([{ childId: "kid", ageUnknown: true }])
  })

  it("まとめ: 0 歳児には案内を出さず警告を返し、3 歳児には案内を出して警告しない", () => {
    const summary = summarizeChildServing(
      honeyChicken,
      [child("2026-06-01", null, "baby"), child("2023-06-01", "toddler", "older")],
      ON,
      INDEX,
    )
    expect(summary.perChild).toEqual([
      { childId: "baby", result: { show: null, reason: "対象月齢外" } },
      { childId: "older", result: { show: TODDLER_GUIDE, basis: "guardian_stage", label: "幼児食" } },
    ])
    expect(summary.warnings.map((w) => w.childId)).toEqual(["baby"])
  })
})
