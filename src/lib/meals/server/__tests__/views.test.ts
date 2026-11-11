/**
 * ごはんの読み取りの組み立て（今あるもので・レシピ詳細・設定・献立との重なり）。
 *
 * 同梱カタログ（実データ）で確かめる。
 * - C-23 / C-24 / C-25 / C-27: 揃う・分量要確認・買い足しを混ぜない。0 件を黙って埋めない。
 *   未登録の調味料を在庫ありと数えない
 * - C-53 / C-54: 世帯の除外の和集合。原材料を確かめられない料理は別枠
 * - C-61 / C-64 / C-65: 子どもの情報は表示にだけ使い、外へ送らない。取り分けは対応レシピ・対象の子だけ
 * - C-74 / C-75: 好み・評価は順位に効き、入力から消えれば影響も理由も消える
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { ALLERGENS, ALLERGEN_LIST_META } from "../../catalog/allergens"
import { CHILD_SERVING_UNSUPPORTED_TEXT } from "../../catalog/child-guidance"
import type { PlanEntry } from "../../types"
import { getMealLookup } from "../context"
import type {
  StoredDishFeedback,
  StoredFoodExclusion,
  StoredFoodPreference,
  StoredPantryItem,
  StoredPlanEntry,
} from "../rows"
import { defaultDinnerSettings } from "../rows"
import {
  type NowCandidateView,
  type NowView,
  type NowViewContext,
  type RecipeDetailContext,
  type SettingsViewContext,
  STAPLE_RULE_NOTE,
  buildNowView,
  buildPlanConflictReport,
  buildPlanConflictViews,
  buildRecipeDetailView,
  buildSettingsView,
  formatChildAge,
} from "../views"

const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const ME = "a1000000-0000-4000-8000-000000000001"
const SPOUSE = "a1000000-0000-4000-8000-000000000002"
const GONE = "a1000000-0000-4000-8000-000000000009"
const CHILD_A = "a2000000-0000-4000-8000-000000000001"
const CHILD_B = "a2000000-0000-4000-8000-000000000002"

/** しょうゆ・塩・砂糖・油を常備品にした世帯（未登録の調味料で全部が買い足しにならないように）。 */
const STAPLES = ["salt", "rice_oil", "sugar", "soy_sauce", "salad_oil"]

let seq = 0
function stock(ingredientId: string | null, over: Partial<StoredPantryItem> = {}): StoredPantryItem {
  seq += 1
  return {
    id: `pantry-${seq}`,
    ingredientId,
    name: ingredientId === null ? "名前のままの食材" : (getMealLookup().index.byId.get(ingredientId)?.name ?? ingredientId),
    quantity: null,
    status: "have",
    useSoon: false,
    storage: "fridge",
    expiresOn: null,
    confirmedOn: TODAY,
    version: VERSION,
    ...over,
  }
}

function exclusion(
  id: string,
  reason: StoredFoodExclusion["reason"],
  target: StoredFoodExclusion["target"],
  subject: StoredFoodExclusion["subject"] = { kind: "household" },
): StoredFoodExclusion {
  return { id, reason, target, subject, version: VERSION }
}

function preference(id: string, over: Partial<StoredFoodPreference>): StoredFoodPreference {
  return {
    id,
    scope: "household",
    profileId: null,
    target: { kind: "recipe", id: "tamagoyaki" },
    sentiment: "like",
    version: VERSION,
    ...over,
  }
}

function feedback(id: string, over: Partial<StoredDishFeedback>): StoredDishFeedback {
  return {
    id,
    profileId: ME,
    recipeId: "tamagoyaki",
    eatenOn: "2026-11-05",
    taste: 3,
    effort: null,
    again: true,
    excludeFromLearning: false,
    dishTitle: "卵焼き",
    version: VERSION,
    ...over,
  }
}

function entry(id: string, recipeId: string, over: Partial<StoredPlanEntry> = {}): StoredPlanEntry {
  return {
    id,
    date: "2026-11-12",
    role: "main",
    position: 0,
    recipeId,
    recipeVersion: 1,
    customTitle: null,
    customIngredients: null,
    servings: 2,
    pinned: false,
    status: "confirmed",
    origin: "auto",
    version: VERSION,
    ...over,
  }
}

const base = { householdId: "household-a", today: TODAY, lookup: getMealLookup(), unreadable: {}, issues: [] }

function nowContext(over: Partial<NowViewContext> = {}): NowViewContext {
  return {
    ...base,
    settings: { ...defaultDinnerSettings(), stapleIngredientIds: [...STAPLES], version: VERSION },
    settingsMissing: false,
    pantry: [],
    exclusions: [],
    preferences: [],
    feedback: [],
    feedbackSince: "2026-05-15",
    children: [],
    members: [
      { id: ME, displayName: "たろう" },
      { id: SPOUSE, displayName: "はなこ" },
    ],
    ...over,
  }
}

/** 鮭の塩焼きと卵焼きが「揃う」在庫。 */
function readyPantry(): StoredPantryItem[] {
  return [stock("salmon", { quantity: { amount: 2, unit: "slice" } }), stock("egg", { quantity: { amount: 6, unit: "piece" } })]
}

const ALL = { limit: 200 }
const everyCandidate = (view: NowView): NowCandidateView[] => [...view.ready, ...view.check, ...view.buy]
const find = (candidates: readonly NowCandidateView[], recipeId: string) =>
  candidates.find((candidate) => candidate.recipeId === recipeId)

describe("buildNowView: 揃う・分量要確認・買い足しを別の枠で返す（C-23）", () => {
  it("必要な食材と量が揃う料理だけが ready に入り、不足や要確認の内訳は空", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry() }), ALL)
    expect(view.readyTotal).toBeGreaterThanOrEqual(2)
    expect(find(view.ready, "salmon_shioyaki")).toBeDefined()
    expect(find(view.ready, "tamagoyaki")).toBeDefined()
    for (const candidate of view.ready) {
      expect(candidate.level).toBe("ready")
      expect(candidate.missing).toEqual([])
      expect(candidate.toCheck).toEqual([])
    }
    // 枠をまたいで混ぜない: 買い足しの枠は必ず不足の内訳を持ち、要確認の枠は不足を持たない
    expect(view.buy.length).toBeGreaterThan(0)
    for (const candidate of view.buy) {
      expect(candidate.level).toBe("buy")
      expect(candidate.missing.length).toBeGreaterThan(0)
    }
    for (const candidate of view.check) {
      expect(candidate.level).toBe("check")
      expect(candidate.missing).toEqual([])
    }
    const ids = everyCandidate(view).map((candidate) => candidate.recipeId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("既定では各枠 3 案まで。全件数は別に返す", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry() }))
    expect(view.ready.length).toBeLessThanOrEqual(3)
    expect(view.buy).toHaveLength(3)
    expect(view.buyTotal).toBeGreaterThan(3)
  })

  it("任意の材料が無くても「揃う」を妨げず、内訳には不足として出す", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry() }), ALL)
    const salmon = find(view.ready, "salmon_shioyaki")
    const daikon = salmon?.lines.find((line) => line.ingredientId === "daikon")
    expect(daikon).toMatchObject({ optional: true, state: "missing", stateLabel: "不足" })
    expect(salmon?.lines.find((line) => line.ingredientId === "salmon")).toMatchObject({
      optional: false,
      state: "enough",
      required: "2切れ",
    })
  })

  it("数量が未登録の食材は「揃う」と断定せず、分量要確認に理由つきで出す（C-27）", () => {
    const view = buildNowView(nowContext({ pantry: [stock("salmon")] }), ALL)
    expect(find(view.ready, "salmon_shioyaki")).toBeUndefined()
    const salmon = find(view.check, "salmon_shioyaki")
    expect(salmon?.toCheck).toEqual([
      expect.objectContaining({
        ingredientId: "salmon",
        state: "uncertain",
        reasons: [{ code: "quantity_unknown", label: "数量が登録されていません" }],
        shortBy: "2切れ",
      }),
    ])
  })

  it("量が足りないときは買い足しに、足りない量を出す（対照: 足りる量なら揃う）", () => {
    const short = buildNowView(nowContext({ pantry: [stock("salmon", { quantity: { amount: 1, unit: "slice" } })] }), ALL)
    expect(find(short.buy, "salmon_shioyaki")?.missing).toEqual([
      expect.objectContaining({ ingredientId: "salmon", shortBy: "1切れ", reasons: [{ code: "short", label: "量が足りません" }] }),
    ])
    const enough = buildNowView(nowContext({ pantry: [stock("salmon", { quantity: { amount: 2, unit: "slice" } })] }), ALL)
    expect(find(enough.ready, "salmon_shioyaki")).toBeDefined()
  })

  it("人数の設定で必要量が変わる（4 人分では鮭 2 切れは足りない）", () => {
    const ctx = nowContext({ pantry: readyPantry() })
    const four = buildNowView({ ...ctx, settings: { ...ctx.settings, servings: 4 } }, ALL)
    expect(four.servings).toBe(4)
    expect(find(four.ready, "salmon_shioyaki")).toBeUndefined()
    expect(find(four.buy, "salmon_shioyaki")?.missing[0]).toMatchObject({ required: "4切れ", shortBy: "2切れ" })
  })

  it("期限を過ぎた食材・使い切った食材は材料に数えない（C-26）", () => {
    const expired = buildNowView(
      nowContext({ pantry: [stock("salmon", { quantity: { amount: 2, unit: "slice" }, expiresOn: "2026-11-10" })] }),
      ALL,
    )
    expect(find(expired.ready, "salmon_shioyaki")).toBeUndefined()
    expect(find(expired.buy, "salmon_shioyaki")?.missing[0].reasons).toEqual([
      { code: "expired", label: "期限が過ぎています" },
    ])
    expect(expired.hints.map((hint) => hint.code)).toContain("expired_items")

    const usedUp = buildNowView(
      nowContext({ pantry: [stock("salmon", { quantity: { amount: 2, unit: "slice" }, status: "out" })] }),
      ALL,
    )
    expect(find(usedUp.buy, "salmon_shioyaki")?.missing[0].reasons).toEqual([
      { code: "used_up", label: "使い切っています" },
    ])
  })
})

describe("buildNowView: 未登録の油・調味料を在庫ありと数えない（C-25）", () => {
  it("常備品が未設定なら、塩と油が無い鮭の塩焼きは揃わない。不足に調味料が出る", () => {
    const ctx = nowContext({ pantry: readyPantry() })
    const view = buildNowView({ ...ctx, settings: { ...ctx.settings, stapleIngredientIds: [] } }, ALL)
    expect(view.stapleCount).toBe(0)
    expect(view.readyTotal).toBe(0)
    const salmon = find(view.buy, "salmon_shioyaki")
    expect(salmon?.missing.map((line) => line.ingredientId).sort()).toEqual(["rice_oil", "salt"])
    expect(salmon?.missing[0].reasons).toEqual([{ code: "not_in_pantry", label: "食材に登録がありません" }])
    expect(STAPLE_RULE_NOTE).toContain("常備品")
  })

  it("対照: 世帯が常備品に設定した調味料は「常備品」として充足に数える", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry() }), ALL)
    expect(view.stapleCount).toBe(STAPLES.length)
    const salmon = find(view.ready, "salmon_shioyaki")
    expect(salmon?.lines.find((line) => line.ingredientId === "salt")).toMatchObject({ state: "staple", stateLabel: "常備品" })
  })

  it("対照: 常備品でなくても、食材に登録してあれば数える（換算できない単位は「分量要確認」に留める）", () => {
    const oil = stock("rice_oil", { quantity: { amount: 500, unit: "ml" }, storage: "pantry" })
    const noStaples = (pantry: StoredPantryItem[]) => {
      const ctx = nowContext({ pantry: [...readyPantry(), oil, ...pantry] })
      return buildNowView({ ...ctx, settings: { ...ctx.settings, stapleIngredientIds: [] } }, ALL)
    }
    // 塩を「大さじ」で登録 → レシピの「小さじ」と換算でき、揃う
    const spoon = noStaples([stock("salt", { quantity: { amount: 10, unit: "tbsp" }, storage: "pantry" })])
    expect(find(spoon.ready, "salmon_shioyaki")?.lines.find((line) => line.ingredientId === "salt")).toMatchObject({
      state: "enough",
    })
    // 塩を「g」で登録 → 小さじと g は換算しない。買い足しにはせず、足りるとも断定しない
    const grams = noStaples([stock("salt", { quantity: { amount: 500, unit: "g" }, storage: "pantry" })])
    expect(find(grams.ready, "salmon_shioyaki")).toBeUndefined()
    expect(find(grams.buy, "salmon_shioyaki")).toBeUndefined()
    expect(find(grams.check, "salmon_shioyaki")?.toCheck).toEqual([
      expect.objectContaining({
        ingredientId: "salt",
        reasons: [{ code: "unit_mismatch", label: "登録した単位とレシピの単位を換算できません" }],
      }),
    ])
  })
})

describe("buildNowView: 揃う候補が 0 件のとき（C-24）", () => {
  it("在庫が空なら ready は 0 件のまま。買い足し案は別枠で、見直しのヒントを返す", () => {
    const view = buildNowView(nowContext())
    expect(view.ready).toEqual([])
    expect(view.readyTotal).toBe(0)
    expect(view.check).toEqual([])
    expect(view.buy.length).toBeGreaterThan(0)
    expect(view.hints).toEqual([{ code: "pantry_empty", text: expect.stringContaining("食材を登録") }])
    expect(view.pantry).toEqual({ total: 0, unresolved: [] })
  })

  it("食材の一覧に解決できていない食材は材料に数えず、名前を返す", () => {
    const unresolved = stock(null, { name: "おばあちゃんの漬物" })
    const view = buildNowView(nowContext({ pantry: [unresolved] }), ALL)
    expect(view.readyTotal).toBe(0)
    expect(view.pantry).toEqual({ total: 1, unresolved: [{ id: unresolved.id, name: "おばあちゃんの漬物" }] })
    expect(view.hints.map((hint) => hint.code)).toContain("unresolved_items")
  })

  it("対照: 揃う候補があるときはヒントを出さない", () => {
    expect(buildNowView(nowContext({ pantry: readyPantry() })).hints).toEqual([])
  })

  it("人数が未設定の世帯は、標準の人数で計算していることを返す", () => {
    const view = buildNowView(nowContext({ settings: defaultDinnerSettings(), settingsMissing: true }))
    expect(view).toMatchObject({ servings: 2, usingDefaultServings: true, stapleCount: 0 })
    expect(buildNowView(nowContext()).usingDefaultServings).toBe(false)
  })
})

describe("buildNowView: 必須除外（C-52 / C-53 / C-54）", () => {
  it("家族 2 人の異なる除外の和集合を守る（アレルギーも苦手も候補から外す）", () => {
    const pantry = readyPantry()
    const baseline = buildNowView(nowContext({ pantry }), ALL)
    const view = buildNowView(
      nowContext({
        pantry,
        exclusions: [
          exclusion("ex-egg", "allergy", { kind: "allergen", allergenId: "egg" }, { kind: "member", profileId: ME }),
          exclusion("ex-salmon", "dislike", { kind: "ingredient", ingredientId: "salmon" }, { kind: "member", profileId: SPOUSE }),
        ],
      }),
      ALL,
    )
    const ids = everyCandidate(view).map((candidate) => candidate.recipeId)
    expect(ids).not.toContain("tamagoyaki")
    expect(ids).not.toContain("salmon_shioyaki")
    // 卵・鮭を材料に持つ候補が 1 件も残っていない
    for (const candidate of everyCandidate(view)) {
      expect(candidate.lines.map((line) => line.ingredientId)).not.toContain("egg")
      expect(candidate.lines.map((line) => line.ingredientId)).not.toContain("salmon")
    }
    expect(view.excludedCount).toBeGreaterThan(0)
    expect(view.exclusions).toMatchObject({ hasAny: true, hasAllergy: true })
    // 対照: 除外が無ければ両方とも候補に在る
    expect(everyCandidate(baseline).map((candidate) => candidate.recipeId)).toEqual(
      expect.arrayContaining(["tamagoyaki", "salmon_shioyaki"]),
    )
    expect(baseline.excludedCount).toBe(0)
  })

  it("アレルギーの除外があるとき、商品により原材料が異なる料理は候補にせず「確認が必要」の別枠へ", () => {
    const view = buildNowView(
      nowContext({ exclusions: [exclusion("ex-shrimp", "allergy", { kind: "allergen", allergenId: "shrimp" })] }),
      ALL,
    )
    expect(everyCandidate(view).map((candidate) => candidate.recipeId)).not.toContain("curry_rice")
    const curry = view.labelCheck.find((item) => item.recipeId === "curry_rice")
    expect(curry?.reasons).toEqual([
      { code: "varies_ingredient", ingredientName: "カレールウ", text: "「カレールウ」は商品によって原材料が異なります" },
    ])
    // 対照: 苦手だけ（アレルギーなし）なら別枠へ回さない
    const dislikeOnly = buildNowView(
      nowContext({ exclusions: [exclusion("ex-eggplant", "dislike", { kind: "ingredient", ingredientId: "eggplant" })] }),
      ALL,
    )
    expect(dislikeOnly.labelCheck).toEqual([])
    expect(everyCandidate(dislikeOnly).map((candidate) => candidate.recipeId)).toContain("curry_rice")
  })

  it("食材の一覧へ解決できない自由入力は、判定に限界がある除外として返す", () => {
    const view = buildNowView(
      nowContext({ exclusions: [exclusion("ex-custom", "dislike", { kind: "custom", label: "パクチー" })] }),
    )
    expect(view.exclusions.limited).toEqual([{ exclusionId: "ex-custom", label: "パクチー" }])
  })
})

describe("buildNowView: 好み・評価の反映と削除（C-74 / C-75）", () => {
  const pantry = readyPantry()
  const baseline = () => buildNowView(nowContext({ pantry }), ALL)
  const order = (view: NowView) => view.ready.map((candidate) => candidate.recipeId)

  /** 基準の順位で最下位の「揃う」候補（好みで先頭へ上げる対象）。 */
  function lastReady(): string {
    const ids = order(baseline())
    expect(ids.length).toBeGreaterThanOrEqual(2)
    return ids[ids.length - 1]
  }

  it("保存済みの評価で順位が変わり、理由は実在する記録（誰が・いつ）から作る", () => {
    const target = lastReady()
    const records = [
      feedback("fb-me", { recipeId: target, profileId: ME, eatenOn: "2026-11-05" }),
      feedback("fb-spouse", { recipeId: target, profileId: SPOUSE, eatenOn: "2026-11-06" }),
    ]
    const view = buildNowView(nowContext({ pantry, feedback: records }), ALL)
    expect(order(view)[0]).toBe(target)
    expect(order(baseline())[0]).not.toBe(target)
    const reasons = find(view.ready, target)?.reasons.filter((reason) => reason.kind === "preference") ?? []
    expect(reasons).toEqual(
      expect.arrayContaining([
        { kind: "preference", tone: "plus", text: "たろうさんが前回「おいしい」（11/5（木））", recordId: "fb-me" },
        { kind: "preference", tone: "plus", text: "はなこさんが前回「また食べたい」（11/6（金））", recordId: "fb-spouse" },
      ]),
    )
    // 理由はすべて入力の記録に結び付く
    for (const reason of reasons) expect(["fb-me", "fb-spouse"]).toContain(reason.recordId)
  })

  it("削除した評価（入力から消えた記録）は、次の順位にも理由にも影響しない", () => {
    const target = lastReady()
    const records = [
      feedback("fb-me", { recipeId: target, profileId: ME }),
      feedback("fb-spouse", { recipeId: target, profileId: SPOUSE }),
    ]
    const withFeedback = buildNowView(nowContext({ pantry, feedback: records }), ALL)
    expect(order(withFeedback)[0]).toBe(target)

    // 2 件とも削除 → 基準と完全に同じ結果へ戻る（前の呼び出しの記録がどこにも残らない）
    const afterDelete = buildNowView(nowContext({ pantry, feedback: [] }), ALL)
    expect(afterDelete).toEqual(baseline())
    expect(JSON.stringify(afterDelete)).not.toContain("fb-me")

    // 1 件だけ削除 → 残した記録の理由だけが残る
    const afterOne = buildNowView(nowContext({ pantry, feedback: [records[1]] }), ALL)
    const recordIds = everyCandidate(afterOne).flatMap((candidate) => candidate.reasons.map((reason) => reason.recordId))
    expect(recordIds).toContain("fb-spouse")
    expect(recordIds).not.toContain("fb-me")
  })

  it("明示の好み（家族共通・個人）で順位が変わり、削除すれば影響が消える", () => {
    const target = lastReady()
    const preferences = [
      preference("pref-house", { target: { kind: "recipe", id: target } }),
      preference("pref-me", { scope: "personal", profileId: ME, target: { kind: "recipe", id: target } }),
    ]
    const view = buildNowView(nowContext({ pantry, preferences }), ALL)
    expect(order(view)[0]).toBe(target)
    const title = getMealLookup().recipeById.get(target)?.title
    expect(find(view.ready, target)?.reasons).toEqual(
      expect.arrayContaining([
        { kind: "preference", tone: "plus", text: `家族共通の設定で「好き」（${title}）`, recordId: "pref-house" },
        { kind: "preference", tone: "plus", text: `たろうさんの設定で「好き」（${title}）`, recordId: "pref-me" },
      ]),
    )
    expect(buildNowView(nowContext({ pantry, preferences: [] }), ALL)).toEqual(baseline())
  })

  it("「苦手」の評価は順位を下げ、下げた理由として出す（必須除外にはしない）", () => {
    const top = order(baseline())[0]
    const view = buildNowView(
      nowContext({ pantry, feedback: [feedback("fb-bad", { recipeId: top, taste: 1, again: false })] }),
      ALL,
    )
    expect(order(view)[0]).not.toBe(top)
    // 候補からは外さない（採点だけ。必須除外は「使わない食材」の設定が担う）
    const candidate = find(view.ready, top)
    expect(candidate).toBeDefined()
    expect(candidate?.reasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "preference", tone: "minus", recordId: "fb-bad" })]),
    )
    expect(view.excludedCount).toBe(0)
  })

  it("その日の気分の記録（好みへ反映しない印つき）は、長期の評価として数えない", () => {
    const target = lastReady()
    const moody = [
      feedback("fb-mood-1", { recipeId: target, profileId: ME, excludeFromLearning: true }),
      feedback("fb-mood-2", { recipeId: target, profileId: SPOUSE, taste: 1, again: false, excludeFromLearning: true }),
    ]
    expect(buildNowView(nowContext({ pantry, feedback: moody }), ALL)).toEqual(baseline())
  })

  it("「ふつう」の評価は順位に効かず、理由にも挙げない（好評と言い換えない）", () => {
    const target = lastReady()
    const neutral = [feedback("fb-neutral", { recipeId: target, taste: 2, effort: 2, again: null })]
    const view = buildNowView(nowContext({ pantry, feedback: neutral }), ALL)
    expect(view).toEqual(baseline())
    expect(find(view.ready, target)?.reasons).toEqual([])
  })

  it("世帯にいない人の評価は、名前を捏造せず「家族」と表記する", () => {
    const target = lastReady()
    const view = buildNowView(
      nowContext({ pantry, feedback: [feedback("fb-gone", { recipeId: target, profileId: GONE })] }),
      ALL,
    )
    expect(find(view.ready, target)?.reasons.map((reason) => reason.text)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^家族が前回「おいしい」/)]),
    )
  })

  it("早く使いたい食材・期限が近い食材を使う料理は、理由に食材名を出す", () => {
    const view = buildNowView(
      nowContext({
        pantry: [
          stock("salmon", { quantity: { amount: 2, unit: "slice" }, useSoon: true, expiresOn: "2026-11-12" }),
          stock("egg", { quantity: { amount: 6, unit: "piece" } }),
        ],
      }),
      ALL,
    )
    expect(order(view)[0]).toBe("salmon_shioyaki")
    expect(view.ready[0].reasons).toEqual([
      { kind: "use_soon", tone: "plus", text: "早く使いたい「鮭」を使います", recordId: null },
      { kind: "expiring", tone: "plus", text: "期限が近い「鮭」を使います", recordId: null },
    ])
    // 対照: 印も期限も無い在庫では、在庫由来の理由は出ない
    expect(find(baseline().ready, "salmon_shioyaki")?.reasons).toEqual([])
  })

  it("調理時間の上限を超える料理は、下げた理由として出す", () => {
    const ctx = nowContext({ pantry })
    const view = buildNowView({ ...ctx, settings: { ...ctx.settings, maxCookMinutes: 15 } }, ALL)
    expect(find(view.ready, "salmon_shioyaki")?.reasons).toEqual([
      { kind: "time", tone: "minus", text: "調理時間の目安（約20分）が、設定した上限（15分）を超えます", recordId: null },
    ])
    expect(find(view.ready, "tamagoyaki")?.reasons).toEqual([])
  })
})

describe("R01 判定できない除外を、理由と名前つきで画面へ渡す", () => {
  const unknownAllergy = exclusion("ex-unknown", "allergy", { kind: "custom", label: "ぞぞぞ成分" })
  const unknownDislike = exclusion("ex-dislike", "dislike", { kind: "custom", label: "ぞぞぞ風味" })

  it("今あるもので: 判定できないアレルギーがあると全料理が「確認が必要」へ回り、その理由と除外の名前を返す", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry(), exclusions: [unknownAllergy] }), ALL)
    // 揃う在庫があっても、どの料理も自動の候補にしない
    expect([view.readyTotal, view.checkTotal, view.buyTotal]).toEqual([0, 0, 0])
    expect(view.labelCheck.length).toBeGreaterThan(0)
    expect(view.exclusions).toMatchObject({
      holdsAutoConfirm: true,
      undetermined: [
        { exclusionId: "ex-unknown", label: "ぞぞぞ成分", reason: "allergy", reasonLabel: "アレルギー", effect: "holds_auto_confirm" },
      ],
    })
    expect(view.exclusions.holdMessage).toContain("「ぞぞぞ成分」")
    expect(view.exclusions.holdMessage).toContain("献立を確定できません")
    // 料理そのものに確認の要る材料が無いものは、保留だけが理由（「商品により原材料が異なる」とは言わない）
    const salmon = view.labelCheck.find((item) => item.recipeId === "salmon_shioyaki")
    expect(salmon).toMatchObject({ reasons: [], undeterminedHold: true })
    // 対照: 料理そのものに確認の要る材料があるものは、その理由を返す
    const curry = view.labelCheck.find((item) => item.recipeId === "curry_rice")
    expect(curry?.undeterminedHold).toBe(false)
    expect(curry?.reasons.map((reason) => reason.code)).toContain("varies_ingredient")
  })

  it("対照: 判定できない苦手は献立を止めない（候補は残る）。「何も除外されていない」ことは返す", () => {
    const view = buildNowView(nowContext({ pantry: readyPantry(), exclusions: [unknownDislike] }), ALL)
    expect(view.readyTotal).toBeGreaterThanOrEqual(2)
    expect(view.exclusions).toMatchObject({
      holdsAutoConfirm: false,
      holdMessage: null,
      undetermined: [{ exclusionId: "ex-dislike", label: "ぞぞぞ風味", reason: "dislike", effect: "no_effect" }],
    })
  })

  it("対照: 判定できる除外（卵アレルギー）だけなら、保留しない・判定できない除外も無い", () => {
    const egg = exclusion("ex-egg", "allergy", { kind: "allergen", allergenId: "egg" })
    const view = buildNowView(nowContext({ pantry: readyPantry(), exclusions: [egg] }), ALL)
    expect(view.exclusions).toMatchObject({ holdsAutoConfirm: false, undetermined: [], holdMessage: null })
    expect(find(view.ready, "salmon_shioyaki")).toBeDefined()
    expect(view.labelCheck.every((item) => item.undeterminedHold === false)).toBe(true)
  })

  it("レシピ詳細・設定・献立との重なりにも同じ理由が載る", () => {
    const detail = buildRecipeDetailView(
      { ...nowContext({ exclusions: [unknownAllergy] }) },
      "salmon_shioyaki",
    )
    expect(detail?.exclusion).toMatchObject({ verdict: "label_check", hits: [], unverifiable: [] })
    expect(detail?.exclusion.notice).toMatchObject({ holdsAutoConfirm: true, undetermined: [{ label: "ぞぞぞ成分" }] })

    const settings = buildSettingsView(
      { ...nowContext({ exclusions: [unknownAllergy, unknownDislike, exclusion("ex-egg", "allergy", { kind: "allergen", allergenId: "egg" })] }) },
      ME,
    )
    expect(settings.exclusions.map((item) => [item.id, item.effect])).toEqual([
      ["ex-unknown", "holds_auto_confirm"],
      ["ex-dislike", "no_effect"],
      ["ex-egg", "excludes"],
    ])
    expect(settings.exclusionNotice.holdsAutoConfirm).toBe(true)

    const report = buildPlanConflictReport({
      ...base,
      exclusions: [unknownAllergy],
      plan: { revision: 1, groceryRevision: null, from: TODAY, to: "2026-11-17", entries: [entry("e-salmon", "salmon_shioyaki")] },
    })
    expect(report.holdMessage).toContain("「ぞぞぞ成分」")
    expect(report.conflicts).toEqual([expect.objectContaining({ entryId: "e-salmon", verdict: "label_check", unverifiable: [] })])
    // 対照: 判定できない苦手だけなら、保留の文は無く、重なりも無い
    const calm = buildPlanConflictReport({
      ...base,
      exclusions: [unknownDislike],
      plan: { revision: 1, groceryRevision: null, from: TODAY, to: "2026-11-17", entries: [entry("e-salmon", "salmon_shioyaki")] },
    })
    expect(calm).toMatchObject({ holdMessage: null, conflicts: [] })
  })
})

describe("R24 総称で登録した食材（豚肉 など）を、同一視せずに画面へ渡す", () => {
  it("「豚肉」の在庫は部位に数えない: 材料は「要確認」になり、どの登録のことかを行と一覧の両方で返す", () => {
    const pork = stock("pork", { name: "豚肉", quantity: { amount: 300, unit: "g" } })
    const view = buildNowView(nowContext({ pantry: [pork] }), ALL)
    expect(view.genericItems).toEqual([
      { pantryItemId: pork.id, name: "豚肉", ingredientName: "豚肉", text: expect.stringContaining("具体的な名前") },
    ])
    const nikujaga = find(everyCandidate(view), "nikujaga")
    const line = nikujaga?.lines.find((item) => item.ingredientId === "pork_komagire")
    expect(line).toMatchObject({
      state: "uncertain",
      reasons: [],
      genericStock: { pantryItemIds: [pork.id], names: ["豚肉"] },
    })
    expect(line?.genericStock?.text).toBe("「豚肉」で登録されています。豚こま切れ肉に当たるか（部位・種類）を確認してください。")
    // 「揃う」には数えない
    expect(find(view.ready, "nikujaga")).toBeUndefined()
    // 対照: 総称に由来しない材料の行には付かない
    expect(nikujaga?.lines.find((item) => item.ingredientId === "potato")?.genericStock).toBeNull()
  })

  it("対照: 部位で登録した在庫には付かず、一覧も空", () => {
    const view = buildNowView(nowContext({ pantry: [stock("pork_komagire", { quantity: { amount: 300, unit: "g" } })] }), ALL)
    expect(view.genericItems).toEqual([])
    const line = find(everyCandidate(view), "nikujaga")?.lines.find((item) => item.ingredientId === "pork_komagire")
    expect(line).toMatchObject({ state: "enough", genericStock: null })
  })
})

describe("buildNowView: 子ども（C-61 / C-64 / C-65）", () => {
  const baby = { id: CHILD_A, name: "ひなた", birthDate: "2026-03-01" }
  const toddler = { id: CHILD_B, name: "そうた", birthDate: "2024-04-01" }

  it("1 歳未満の子がいると、はちみつを使う料理に注意を出す（料理は候補から外さない）", () => {
    const view = buildNowView(nowContext({ children: [baby] }), ALL)
    const honey = find(everyCandidate(view), "sweet_potato_honey_lemon")
    expect(honey?.ageWarnings).toEqual([
      {
        childId: CHILD_A,
        childName: "ひなた",
        ingredientName: "はちみつ",
        ageUnknown: false,
        text: "はちみつを使います。ひなた（8か月）は1歳未満のため、与えません。",
      },
    ])
    // 対照: はちみつを使わない料理には出さない
    expect(find(everyCandidate(view), "salmon_shioyaki")?.ageWarnings).toEqual([])
  })

  it("対照: 1 歳以上の子には注意を出さない。生年月日が未登録なら確認を促す", () => {
    const older = buildNowView(nowContext({ children: [toddler] }), ALL)
    expect(find(everyCandidate(older), "sweet_potato_honey_lemon")?.ageWarnings).toEqual([])
    const unknown = buildNowView(nowContext({ children: [{ id: CHILD_A, name: "", birthDate: null }] }), ALL)
    expect(find(everyCandidate(unknown), "sweet_potato_honey_lemon")?.ageWarnings).toEqual([
      expect.objectContaining({ childName: "名前未設定のお子さん", ageUnknown: true, text: expect.stringContaining("年齢を確認してください") }),
    ])
  })

  it("取り分け案内を出せる子は、対応レシピ × 2 歳以降の子だけ", () => {
    const both = nowContext({ children: [baby, toddler] })
    // 2 歳の子の食事の段階は、保護者が「幼児食」と設定している
    const view = buildNowView({ ...both, settings: { ...both.settings, childStages: { [CHILD_B]: "toddler" } } }, ALL)
    expect(find(everyCandidate(view), "nikujaga")?.servingChildren).toEqual([{ childId: CHILD_B, childName: "そうた" }])
    // 対応していない料理は、子がいても空
    expect(find(everyCandidate(view), "salmon_shioyaki")?.servingChildren).toEqual([])
    // 食事の段階が未設定の子には、2 歳以上でも出さない（月齢だけから決めつけない。C-61 / C-64）
    expect(find(everyCandidate(buildNowView(both, ALL)), "nikujaga")?.servingChildren).toEqual([])
    // 保護者が「離乳開始前」と設定した子には出さない（月齢より設定を優先する）
    const ctx = nowContext({ children: [toddler] })
    const notStarted = buildNowView(
      { ...ctx, settings: { ...ctx.settings, childStages: { [CHILD_B]: "not_started" } } },
      ALL,
    )
    expect(find(everyCandidate(notStarted), "nikujaga")?.servingChildren).toEqual([])
  })
})

describe("buildRecipeDetailView", () => {
  function detailContext(over: Partial<RecipeDetailContext> = {}): RecipeDetailContext {
    return {
      ...base,
      settings: { ...defaultDinnerSettings(), version: VERSION },
      settingsMissing: false,
      exclusions: [],
      children: [],
      members: [
        { id: ME, displayName: "たろう" },
        { id: SPOUSE, displayName: "はなこ" },
      ],
      ...over,
    }
  }

  it("カタログに無い ID は null（対照: 在る ID は詳細を返す）", () => {
    expect(buildRecipeDetailView(detailContext(), "ghost_recipe")).toBeNull()
    expect(buildRecipeDetailView(detailContext(), "__proto__")).toBeNull()
    expect(buildRecipeDetailView(detailContext(), "nikujaga")).toMatchObject({ recipeId: "nikujaga", title: "肉じゃが" })
  })

  it("材料を人数でスケールする（元のレシピの量から一度だけ）", () => {
    const two = buildRecipeDetailView(detailContext(), "nikujaga")
    const four = buildRecipeDetailView(detailContext(), "nikujaga", { servings: 4 })
    const text = (view: typeof two, id: string) => view?.ingredients.find((item) => item.ingredientId === id)?.quantityText
    expect(two).toMatchObject({ baseServings: 2, servings: 2 })
    expect(text(two, "pork_komagire")).toBe("150g")
    expect(text(two, "soy_sauce")).toBe("大さじ2と1/2")
    expect(four).toMatchObject({ baseServings: 2, servings: 4 })
    expect(text(four, "pork_komagire")).toBe("300g")
    expect(text(four, "potato")).toBe("6個")
    expect(text(four, "soy_sauce")).toBe("大さじ5")
    // 3 人分は 2 人分の 1.5 倍（4 人分の結果を再スケールした値ではない）
    expect(text(buildRecipeDetailView(detailContext(), "nikujaga", { servings: 3 }), "pork_komagire")).toBe("225g")
  })

  it("世帯の設定の人数を初期値にし、不正な人数の指定は設定へ戻す", () => {
    const ctx = detailContext({ settings: { ...defaultDinnerSettings(), servings: 5, version: VERSION } })
    expect(buildRecipeDetailView(ctx, "nikujaga")?.servings).toBe(5)
    for (const bad of [0, 13, 2.5, Number.NaN, -1]) {
      expect(buildRecipeDetailView(ctx, "nikujaga", { servings: bad })?.servings).toBe(5)
    }
    const missing = detailContext({ settings: defaultDinnerSettings(), settingsMissing: true })
    expect(buildRecipeDetailView(missing, "nikujaga")).toMatchObject({ servings: 2, usingDefaultServings: true })
    expect(buildRecipeDetailView(missing, "nikujaga", { servings: 4 })?.usingDefaultServings).toBe(false)
  })

  it("アレルゲンは食材辞書から導く（調味料・派生食材を含む。公式の記載順）", () => {
    const view = buildRecipeDetailView(detailContext(), "nikujaga")
    const byId = new Map(view?.allergens.map((allergen) => [allergen.id, allergen]))
    expect(byId.get("wheat")).toMatchObject({ name: "小麦", tier: "mandatory", tierLabel: "特定原材料", ingredientNames: ["しょうゆ"] })
    expect(byId.get("soybean")?.ingredientNames).toEqual(expect.arrayContaining(["しょうゆ", "サラダ油"]))
    expect(byId.get("pork")?.ingredientNames).toEqual(["豚こま切れ肉"])
    // 対照: 材料に無いアレルゲンは一覧に出ない
    expect(byId.has("egg")).toBe(false)
    const official = ALLERGENS.map((allergen) => allergen.id)
    const positions = view?.allergens.map((allergen) => official.indexOf(allergen.id)) ?? []
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(view?.ingredients.find((item) => item.ingredientId === "soy_sauce")?.allergens).toEqual(
      expect.arrayContaining([{ id: "wheat", name: "小麦" }, { id: "soybean", name: "大豆" }]),
    )
  })

  it("商品により原材料が異なる材料に「原材料の確認が必要」の印を付ける（対照: 無い料理には付けない）", () => {
    const curry = buildRecipeDetailView(detailContext(), "curry_rice")
    expect(curry).toMatchObject({ needsLabelCheck: true, labelCheckIngredientNames: ["カレールウ"] })
    expect(curry?.ingredients.find((item) => item.ingredientId === "curry_roux")?.labelCheck).toBe("varies")
    expect(curry?.ingredients.find((item) => item.ingredientId === "onion")?.labelCheck).toBeNull()
    const salmon = buildRecipeDetailView(detailContext(), "salmon_shioyaki")
    expect(salmon).toMatchObject({ needsLabelCheck: false, labelCheckIngredientNames: [] })
  })

  it("世帯の除外に触れる料理は、誰の・何の除外に・どの材料が当たるかを返す", () => {
    const ctx = detailContext({
      exclusions: [exclusion("ex-wheat", "allergy", { kind: "allergen", allergenId: "wheat" }, { kind: "member", profileId: SPOUSE })],
    })
    const view = buildRecipeDetailView(ctx, "nikujaga")
    expect(view?.exclusion.verdict).toBe("blocked")
    expect(view?.exclusion.hits).toEqual([
      {
        exclusionId: "ex-wheat",
        reason: "allergy",
        reasonLabel: "アレルギー",
        targetLabel: "小麦",
        subjectLabel: "はなこ",
        ingredientNames: ["しょうゆ"],
        via: ["allergen"],
      },
    ])
    expect(view?.ingredients.find((item) => item.ingredientId === "soy_sauce")?.excluded).toBe(true)
    expect(view?.ingredients.find((item) => item.ingredientId === "potato")?.excluded).toBe(false)
    // 対照: 小麦を使わない料理は当たらない
    const salmon = buildRecipeDetailView(ctx, "salmon_shioyaki")
    expect(salmon?.exclusion).toMatchObject({ verdict: "ok", hits: [], unverifiable: [] })
    expect(salmon?.exclusion.notice).toMatchObject({ hasAny: true, hasAllergy: true })
  })

  it("アレルギーの除外があり成分を確かめられない料理は label_check（除外に当たるとも、問題なしとも言わない）", () => {
    const ctx = detailContext({ exclusions: [exclusion("ex-shrimp", "allergy", { kind: "allergen", allergenId: "shrimp" })] })
    expect(buildRecipeDetailView(ctx, "curry_rice")?.exclusion).toMatchObject({
      verdict: "label_check",
      hits: [],
      unverifiable: [{ code: "varies_ingredient", ingredientName: "カレールウ" }],
    })
  })

  it("子どもごとに、取り分け案内か未対応の理由を返す（C-62 / C-64）", () => {
    const ctx = detailContext({
      settings: {
        ...defaultDinnerSettings(),
        childStages: { [CHILD_A]: "toddler", [CHILD_B]: "not_started" },
        version: VERSION,
      },
      children: [
        { id: CHILD_A, name: "そうた", birthDate: "2024-04-01" },
        { id: CHILD_B, name: "ひなた", birthDate: "2026-07-01" },
        { id: "a2000000-0000-4000-8000-000000000003", name: "", birthDate: null },
      ],
    })
    const view = buildRecipeDetailView(ctx, "nikujaga")
    expect(view?.childServing).toEqual({ available: true, stageLabel: "2歳以降の幼児", minAgeMonths: 24 })
    const [toddler, baby, unknown] = view?.children ?? []
    expect(toddler).toMatchObject({ name: "そうた", ageLabel: "2歳7か月", stageLabel: "幼児食" })
    expect(toddler.serving).toMatchObject({ supported: true, basis: "guardian_stage", separateBeforeStep: 3 })
    if (!toddler.serving.supported) throw new Error("unreachable")
    expect(toddler.serving.instructions.length).toBeGreaterThan(0)
    expect(toddler.serving.cautions.length).toBeGreaterThan(0)
    // 案内には出典が付く
    expect(toddler.serving.sources.length).toBeGreaterThan(0)
    for (const source of toddler.serving.sources) expect(source.url).toMatch(/^https:\/\//)

    expect(baby).toMatchObject({ name: "ひなた", ageLabel: "4か月", stageLabel: "離乳開始前" })
    expect(baby.serving).toEqual({ supported: false, reason: "離乳開始前", text: expect.stringContaining("対象外") })
    expect(unknown).toMatchObject({ name: "名前未設定のお子さん", ageLabel: null, stageLabel: null })
    expect(unknown.serving).toMatchObject({ supported: false, reason: "未設定" })
  })

  it("取り分けに対応していない料理は、2 歳以降の子にも「未対応」と出す", () => {
    const ctx = detailContext({ children: [{ id: CHILD_A, name: "そうた", birthDate: "2024-04-01" }] })
    const view = buildRecipeDetailView(ctx, "salmon_shioyaki")
    expect(view?.childServing).toEqual({ available: false, stageLabel: null, minAgeMonths: null })
    expect(view?.children[0].serving).toEqual({ supported: false, reason: "未対応", text: CHILD_SERVING_UNSUPPORTED_TEXT })
    // 段階が未設定の子には、対応レシピでも 2 歳以上でも案内を出さない（月齢だけから決めつけない。C-61 / C-64）
    expect(buildRecipeDetailView(ctx, "nikujaga")?.children[0].serving).toEqual({
      supported: false,
      reason: "未設定",
      text: expect.stringContaining("取り分け案内を表示していません"),
    })
    // 対照: 保護者が「幼児食」と設定すれば、同じ子・同じ料理で案内が出る
    const staged = { ...ctx, settings: { ...ctx.settings, childStages: { [CHILD_A]: "toddler" } } }
    expect(buildRecipeDetailView(staged, "nikujaga")?.children[0].serving).toMatchObject({
      supported: true,
      basis: "guardian_stage",
    })
  })

  it("1 歳未満の子には、はちみつの年齢制約を出典つきで警告する（C-65。対照: 1 歳以上には出さない）", () => {
    const ctx = detailContext({
      children: [
        { id: CHILD_A, name: "ひなた", birthDate: "2026-03-01" },
        { id: CHILD_B, name: "そうた", birthDate: "2025-10-01" },
      ],
    })
    const view = buildRecipeDetailView(ctx, "sweet_potato_honey_lemon")
    const [baby, older] = view?.children ?? []
    expect(baby.ageWarnings).toEqual([
      expect.objectContaining({
        ingredientName: "はちみつ",
        minAgeMonths: 12,
        ageUnknown: false,
        title: "はちみつは1歳を過ぎてから",
        body: expect.stringContaining("加熱"),
      }),
    ])
    expect(baby.ageWarnings[0].sources.map((source) => source.id)).toContain("mhlw_honey_leaflet")
    expect(older.ageLabel).toBe("1歳1か月")
    expect(older.ageWarnings).toEqual([])
    // 子どもの登録に依らない一般の注意としても挙げる
    expect(buildRecipeDetailView(detailContext(), "sweet_potato_honey_lemon")?.ageRules).toEqual([
      expect.objectContaining({ ingredientName: "はちみつ", minAgeMonths: 12 }),
    ])
    expect(buildRecipeDetailView(detailContext(), "nikujaga")?.ageRules).toEqual([])
  })
})

describe("buildSettingsView", () => {
  function settingsContext(over: Partial<SettingsViewContext> = {}): SettingsViewContext {
    return {
      ...base,
      settings: { ...defaultDinnerSettings(), version: VERSION },
      settingsMissing: false,
      exclusions: [],
      preferences: [],
      feedback: [],
      feedbackSince: "2026-05-15",
      children: [],
      members: [
        { id: ME, displayName: "たろう" },
        { id: SPOUSE, displayName: "" },
      ],
      ...over,
    }
  }

  it("アレルゲンの選択肢は実データの件数どおりで、出典・版・確認日を返す（C-51）", () => {
    const view = buildSettingsView(settingsContext(), ME)
    expect(view.allergens.items).toHaveLength(ALLERGENS.length)
    expect(view.allergens.items.length).toBeGreaterThanOrEqual(25)
    expect(view.allergens.items.map((item) => item.id)).toEqual(ALLERGENS.map((allergen) => allergen.id))
    expect(view.allergens.items[0]).toMatchObject({ tierLabel: "特定原材料" })
    expect(view.allergens.meta).toEqual(ALLERGEN_LIST_META)
    expect(view.allergens.meta.sourceUrl).toMatch(/^https:\/\/www\.caa\.go\.jp\//)
    expect(view.allergens.versionNote).not.toBe("")
  })

  it("登録済みの除外を、理由・対象・対象者の表記つきで返す。カタログに無い ID も落とさない", () => {
    const view = buildSettingsView(
      settingsContext({
        children: [{ id: CHILD_A, name: "ひなた", birthDate: "2026-03-01" }],
        exclusions: [
          exclusion("ex-1", "allergy", { kind: "allergen", allergenId: "egg" }, { kind: "child", childId: CHILD_A }),
          exclusion("ex-2", "dislike", { kind: "ingredient", ingredientId: "eggplant" }, { kind: "member", profileId: ME }),
          exclusion("ex-3", "dislike", { kind: "custom", label: "パクチー" }),
          exclusion("ex-4", "allergy", { kind: "allergen", allergenId: "legacy_item" }, { kind: "member", profileId: GONE }),
        ],
        unreadable: { exclusions: 2 },
      }),
      ME,
    )
    expect(view.exclusions.map(({ id, reasonLabel, targetLabel, targetKnown, subjectLabel, limited }) => ({
      id, reasonLabel, targetLabel, targetKnown, subjectLabel, limited,
    }))).toEqual([
      { id: "ex-1", reasonLabel: "アレルギー", targetLabel: "卵", targetKnown: true, subjectLabel: "ひなた", limited: false },
      { id: "ex-2", reasonLabel: "苦手", targetLabel: "なす", targetKnown: true, subjectLabel: "たろう", limited: false },
      { id: "ex-3", reasonLabel: "苦手", targetLabel: "パクチー", targetKnown: true, subjectLabel: "家族全体", limited: true },
      { id: "ex-4", reasonLabel: "アレルギー", targetLabel: "legacy_item", targetKnown: false, subjectLabel: "世帯にいない人", limited: false },
    ])
    expect(view.unreadableExclusions).toBe(2)
    expect(view.exclusionNotice).toMatchObject({ hasAny: true, hasAllergy: true, limited: [{ exclusionId: "ex-3", label: "パクチー" }] })
    expect(buildSettingsView(settingsContext(), ME)).toMatchObject({
      exclusions: [],
      unreadableExclusions: 0,
      exclusionNotice: { hasAny: false, hasAllergy: false, limited: [] },
    })
  })

  it("好みは家族共通と個人を分け、変更できるのは家族共通と本人の個人の好みだけ（C-73 / C-76）", () => {
    const view = buildSettingsView(
      settingsContext({
        preferences: [
          preference("pref-house", { target: { kind: "tag", id: "fish" }, sentiment: "dislike" }),
          preference("pref-mine", { scope: "personal", profileId: ME, target: { kind: "ingredient", id: "eggplant" } }),
          preference("pref-spouse", { scope: "personal", profileId: SPOUSE, target: { kind: "recipe", id: "nikujaga" } }),
          preference("pref-stale", { target: { kind: "recipe", id: "removed_recipe" } }),
        ],
      }),
      ME,
    )
    expect(view.preferences.map(({ id, scope, ownerLabel, editable, targetLabel, targetKnown, sentiment }) => ({
      id, scope, ownerLabel, editable, targetLabel, targetKnown, sentiment,
    }))).toEqual([
      { id: "pref-house", scope: "household", ownerLabel: "家族共通", editable: true, targetLabel: "魚", targetKnown: true, sentiment: "dislike" },
      { id: "pref-mine", scope: "personal", ownerLabel: "たろう", editable: true, targetLabel: "なす", targetKnown: true, sentiment: "like" },
      { id: "pref-spouse", scope: "personal", ownerLabel: "家族（名前未設定）", editable: false, targetLabel: "肉じゃが", targetKnown: true, sentiment: "like" },
      { id: "pref-stale", scope: "household", ownerLabel: "家族共通", editable: true, targetLabel: "removed_recipe", targetKnown: false, sentiment: "like" },
    ])
    expect(view.preferences[0].version).toBe(VERSION)
    // 見る人が替われば、変更できる個人の好みも替わる
    const asSpouse = buildSettingsView(settingsContext({ preferences: [preference("pref-mine", { scope: "personal", profileId: ME })] }), SPOUSE)
    expect(asSpouse.preferences[0].editable).toBe(false)
  })

  it("覚えた好み（食後評価）を、誰が・いつ・何を、の一覧で返す（新しい順。削除できるのは本人だけ）", () => {
    const view = buildSettingsView(
      settingsContext({
        feedback: [
          feedback("fb-old", { eatenOn: "2026-10-01", taste: 1, effort: 3, again: false }),
          feedback("fb-new", { profileId: SPOUSE, recipeId: "nikujaga", dishTitle: "古い料理名", eatenOn: "2026-11-09", taste: null, again: null }),
          feedback("fb-manual", { recipeId: null, dishTitle: "お好み焼き", eatenOn: "2026-11-01", excludeFromLearning: true }),
        ],
      }),
      ME,
    )
    expect(view.feedback).toEqual([
      {
        id: "fb-new", profileId: SPOUSE, who: "家族（名前未設定）", mine: false, eatenOn: "2026-11-09",
        // カタログの料理は今の料理名で出す
        dishTitle: "肉じゃが", recipeId: "nikujaga",
        taste: null, tasteLabel: null, effort: null, effortLabel: null, again: null, excludeFromLearning: false,
      },
      {
        id: "fb-manual", profileId: ME, who: "たろう", mine: true, eatenOn: "2026-11-01",
        dishTitle: "お好み焼き", recipeId: null,
        taste: 3, tasteLabel: "おいしい", effort: null, effortLabel: null, again: true, excludeFromLearning: true,
      },
      {
        id: "fb-old", profileId: ME, who: "たろう", mine: true, eatenOn: "2026-10-01",
        dishTitle: "卵焼き", recipeId: "tamagoyaki",
        taste: 1, tasteLabel: "苦手", effort: 3, effortLabel: "楽", again: false, excludeFromLearning: false,
      },
    ])
    expect(view.feedbackSince).toBe("2026-05-15")
  })

  it("常備品は候補を提示するだけで、未設定の世帯では 1 件も選ばれていない（C-25）", () => {
    const view = buildSettingsView(settingsContext({ settings: defaultDinnerSettings(), settingsMissing: true }), ME)
    expect(view.settingsMissing).toBe(true)
    expect(view.staples.length).toBeGreaterThan(0)
    expect(view.staples.every((staple) => !staple.selected && staple.known)).toBe(true)
    expect(view.staples.map((staple) => staple.id)).toEqual(expect.arrayContaining(["salt", "soy_sauce", "salad_oil"]))
    // 候補でない食材は、選ばれていなければ出さない
    expect(view.staples.map((staple) => staple.id)).not.toContain("onion")
  })

  it("選んだ常備品は選択済みで返す（候補でない食材・カタログに無い ID も落とさない）", () => {
    const view = buildSettingsView(
      settingsContext({ settings: { ...defaultDinnerSettings(), stapleIngredientIds: ["salt", "onion", "legacy_spice"], version: VERSION } }),
      ME,
    )
    const selected = view.staples.filter((staple) => staple.selected)
    expect(selected.map(({ id, name, known }) => ({ id, name, known }))).toEqual(
      expect.arrayContaining([
        { id: "salt", name: "塩", known: true },
        { id: "onion", name: "玉ねぎ", known: true },
        { id: "legacy_spice", name: "legacy_spice", known: false },
      ]),
    )
    expect(selected).toHaveLength(3)
  })

  it("子どもの食事の段階は保護者の設定をそのまま返す（月齢から決めつけない。未知の値は表示名なし）", () => {
    const view = buildSettingsView(
      settingsContext({
        settings: { ...defaultDinnerSettings(), childStages: { [CHILD_A]: "weaning_mid", [CHILD_B]: "future_stage" }, version: VERSION },
        children: [
          { id: CHILD_A, name: "ひなた", birthDate: "2026-03-01" },
          { id: CHILD_B, name: "そうた", birthDate: "2024-04-01" },
          { id: "a2000000-0000-4000-8000-000000000003", name: "", birthDate: null },
        ],
      }),
      ME,
    )
    expect(view.children).toEqual([
      { childId: CHILD_A, name: "ひなた", ageLabel: "8か月", stage: "weaning_mid", stageLabel: "離乳中期" },
      { childId: CHILD_B, name: "そうた", ageLabel: "2歳7か月", stage: "future_stage", stageLabel: null },
      // 2 歳でも、設定が無ければ段階は未設定のまま
      { childId: "a2000000-0000-4000-8000-000000000003", name: "名前未設定のお子さん", ageLabel: null, stage: null, stageLabel: null },
    ])
    expect(view.stageOptions.map((option) => option.value)).toEqual([
      "not_started", "weaning_early", "weaning_mid", "weaning_late", "weaning_complete", "toddler",
    ])
  })

  it("家族と、好み・除外の対象の選択肢を返す", () => {
    const view = buildSettingsView(settingsContext(), SPOUSE)
    expect(view.viewerId).toBe(SPOUSE)
    expect(view.members).toEqual([
      { id: ME, displayName: "たろう", isViewer: false },
      { id: SPOUSE, displayName: "家族（名前未設定）", isViewer: true },
    ])
    expect(view.preferenceOptions.recipes).toHaveLength(getMealLookup().recipes.length)
    expect(view.preferenceOptions.tags.find((tag) => tag.id === "curry")).toEqual({ id: "curry", label: "カレー" })
    expect(view.ingredientOptions.find((item) => item.id === "eggplant")).toMatchObject({ name: "なす" })
  })
})

describe("献立との重なり（C-55）", () => {
  const entries: StoredPlanEntry[] = [
    entry("en-1", "tamagoyaki", { role: "side", pinned: true }),
    entry("en-2", "salmon_shioyaki"),
    entry("en-3", "tamagoyaki", { date: TODAY, role: "side", status: "cooked" }),
    entry("en-4", "tamagoyaki", { date: "2026-11-13", role: "side", status: "skipped" }),
    entry("en-5", "curry_rice", { date: "2026-11-14", status: "proposed" }),
  ]
  const egg = exclusion("ex-egg", "allergy", { kind: "allergen", allergenId: "egg" })

  it("除外を足すと、固定した枠を含む提案・確定の枠の重なりが返る。献立は変えない", () => {
    const before = structuredClone(entries)
    const conflicts = buildPlanConflictViews(entries, [egg], getMealLookup(), ["ex-egg"])
    expect(conflicts).toEqual([
      {
        entryId: "en-1", date: "2026-11-12", role: "side", title: "卵焼き", pinned: true, status: "confirmed",
        verdict: "blocked", ingredientNames: ["卵"], exclusionIds: ["ex-egg"], unverifiable: [], causedByThisChange: true,
      },
      {
        entryId: "en-5", date: "2026-11-14", role: "main", title: "カレーライス", pinned: false, status: "proposed",
        verdict: "label_check", ingredientNames: [], exclusionIds: [], unverifiable: ["varies_ingredient"], causedByThisChange: false,
      },
    ])
    // 置換はしない（入力の献立はそのまま）
    expect(entries).toEqual(before)
  })

  it("対照: 除外が無ければ重なりは無い。別の除外なら別の枠が挙がる", () => {
    expect(buildPlanConflictViews(entries, [], getMealLookup())).toEqual([])
    const salmon = exclusion("ex-salmon", "dislike", { kind: "ingredient", ingredientId: "salmon" })
    const conflicts = buildPlanConflictViews(entries, [salmon], getMealLookup(), ["ex-other"])
    expect(conflicts.map((conflict) => conflict.entryId)).toEqual(["en-2"])
    expect(conflicts[0].causedByThisChange).toBe(false)
  })

  it("材料の無い手動料理・カタログに無いレシピは、除外があれば確かめられない枠として挙げる", () => {
    const manual: PlanEntry[] = [
      entry("en-m1", "ghost_recipe"),
      { ...entry("en-m2", "x"), recipeId: null, recipeVersion: null, customTitle: "卵かけごはん" },
      { ...entry("en-m3", "x"), recipeId: null, recipeVersion: null, customTitle: "外食" },
    ]
    const conflicts = buildPlanConflictViews(manual, [egg], getMealLookup())
    expect(conflicts.map(({ entryId, verdict }) => ({ entryId, verdict }))).toEqual([
      { entryId: "en-m1", verdict: "label_check" },
      // 料理名に除外の対象が含まれる手動料理
      { entryId: "en-m2", verdict: "blocked" },
      { entryId: "en-m3", verdict: "label_check" },
    ])
    expect(buildPlanConflictViews(manual, [], getMealLookup())).toEqual([])
  })

  it("報告には確かめた範囲と、読めなかった枠の数を含める", () => {
    const report = buildPlanConflictReport(
      {
        ...base,
        unreadable: { plan: 1 },
        exclusions: [egg],
        plan: { revision: 3, groceryRevision: null, from: TODAY, to: "2026-11-17", entries },
      },
      ["ex-egg"],
    )
    expect(report).toMatchObject({ from: TODAY, to: "2026-11-17", unreadableEntries: 1 })
    expect(report.conflicts).toHaveLength(2)
  })
})

describe("formatChildAge", () => {
  it.each([
    [0, "0か月"],
    [8.4, "8か月"],
    [12, "1歳"],
    [31.9, "2歳7か月"],
  ])("%s か月 → %s", (months, label) => {
    expect(formatChildAge(months)).toBe(label)
  })

  it("分からない月齢は null（0 か月と言い換えない）", () => {
    expect(formatChildAge(null)).toBeNull()
    expect(formatChildAge(Number.NaN)).toBeNull()
    expect(formatChildAge(-1)).toBeNull()
  })
})

describe("境界: 外部へ何も送らない・世帯の値を持ち越さない（C-61 / C-75）", () => {
  const source = readFileSync(path.resolve(__dirname, "../views.ts"), "utf8")
  /** コメントを除いた実コード（文書中の語を実コードと混同しないため）。 */
  const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const code = codeOnly(source)
  const imports = [...code.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])

  it("検査そのものの対照: 実コードの import と呼び出しを拾い、コメント中の語は拾わない", () => {
    const sample = codeOnly(`// fetch("https://example.com")\n/* from "../ai" */\nimport { a } from "../ai"\nawait fetch(url)\n`)
    expect([...sample.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])).toEqual(["../ai"])
    expect(sample).toMatch(/\bfetch\s*\(/)
  })

  it("生成 AI・通信・Supabase・Next の API を import せず、呼ばない", () => {
    expect(imports.filter((target) => /(^|\/)ai$/.test(target))).toEqual([])
    expect(imports.filter((target) => target.startsWith("@/lib/supabase") || target.startsWith("next"))).toEqual([])
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/process\.env/)
  })

  it("時計を読まず、モジュールに書き換えられる状態を持たない（結果は入力だけで決まる）", () => {
    expect(code).not.toMatch(/new Date\s*\(|Date\.now\s*\(|Math\.random\s*\(/)
    expect(code).not.toMatch(/^(let|var)\s/m)
    const ctx = nowContext({ pantry: readyPantry(), feedback: [feedback("fb-1", {})] })
    // カタログの索引（不変・巨大）を除いた、世帯の入力の写し
    const snapshot = structuredClone({ ...ctx, lookup: null })
    const first = buildNowView(ctx, ALL)
    expect(buildNowView(ctx, ALL)).toEqual(first)
    // 入力を書き換えない
    expect({ ...ctx, lookup: null }).toEqual(snapshot)
  })

  it("保証や監修を装う文言を持たない", () => {
    expect(source).not.toMatch(/栄養バランス|管理栄養士|監修済み|アレルゲン不使用|安全です/)
  })
})
