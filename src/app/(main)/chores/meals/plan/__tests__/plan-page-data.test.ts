/**
 * 献立の画面が 1 回で読むデータ（表示と、料理の後の操作に要る補助の値）。
 *
 * - C-37: 料理の後に更新できる食材は「候補」だけ（在庫は何も変えない）
 * - C-73 / C-76: 食後評価は本人のものだけを画面へ渡す（家族の評価を自分の編集対象にしない）
 *
 * DB はメモリ上の代役、カタログは実物。暦の前提: 2026-11-11 は水曜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createFakeDinnerDb, entryRow, pantryRow, type FakeDinnerDb } from "@/lib/meals/server/__tests__/fake-dinner-db"

import { loadPlanPageData } from "../plan-page-data"

const USER = "f5000000-0000-4000-8000-000000000001"
const FAMILY = "f5000000-0000-4000-8000-000000000002"
const HOUSE = "f5000000-0000-4000-8000-0000000000a1"
const TODAY = "2026-11-11"
const YESTERDAY = "2026-11-10"
const TOMORROW = "2026-11-12"
const V = "2026-11-10T00:00:00.123456+00:00"

let db: FakeDinnerDb

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function load(startDate = TODAY) {
  const data = await loadPlanPageData(db.supabase, HOUSE, USER, { startDate, today: TODAY })
  if (!data.ok) throw new Error(`plan page data failed: ${JSON.stringify(data.failures)}`)
  return data
}

function feedbackRow(over: Record<string, unknown>) {
  return {
    id: "f6000000-0000-4000-8000-000000000001",
    household_id: HOUSE,
    profile_id: USER,
    recipe_id: "nikujaga",
    dish_title: "肉じゃが",
    eaten_on: TODAY,
    taste: 3,
    effort: 2,
    again: true,
    exclude_from_learning: false,
    updated_at: V,
    ...over,
  }
}

describe("表示する期間", () => {
  it("開始日から 7 日ぶんの表示と、献立の版を返す", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    const { view } = await load()
    expect(view.days.map((day) => day.date)).toEqual([
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
      "2026-11-16",
      "2026-11-17",
    ])
    expect(view.days[0].entries.map((entry) => entry.title)).toEqual(["肉じゃが"])
    expect(view.revision).toBe(db.revision())
  })

  it("過ぎた日から始まる期間も読める（記録のため）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: YESTERDAY, status: "confirmed" }))
    const { view } = await load("2026-11-04")
    expect(view.from).toBe("2026-11-04")
    expect(view.to).toBe(YESTERDAY)
    expect(view.days.every((day) => day.isPast)).toBe(true)
    expect(view.days[6].entries).toHaveLength(1)
  })

  it("開始日が不正なら、空の献立ではなく取得の失敗として返す", async () => {
    const data = await loadPlanPageData(db.supabase, HOUSE, USER, { startDate: "2026-02-30", today: TODAY })
    expect(data).toEqual({ ok: false, failures: [{ part: "plan", kind: "query" }] })
  })

  it("どれか 1 つでも読めなければ失敗として返す（読めた分だけで「献立なし」と描かせない）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    db.failTable("pantry_items")
    const data = await loadPlanPageData(db.supabase, HOUSE, USER, { startDate: TODAY, today: TODAY })
    expect(data.ok).toBe(false)
    if (!data.ok) expect(data.failures.map((failure) => failure.part)).toEqual(["pantry"])
  })
})

describe("R46 年齢の制約の注意（子どもを読んで、献立の料理に載せる）", () => {
  const BABY = "f5000000-0000-4000-8000-0000000000c1"
  const honey = () =>
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, role: "side", recipe_id: "sweet_potato_honey_lemon" }),
      entryRow(HOUSE, { plan_date: TODAY, position: 1, recipe_id: "salmon_shioyaki" }),
    )
  const entriesOf = (view: Awaited<ReturnType<typeof load>>["view"]) => view.days[0].entries

  it("1 歳未満の子がいれば、はちみつを使う料理に注意が載る（対照: 使わない料理・1 歳を過ぎた子には載らない）", async () => {
    // 2026-03-01 生まれ = 8 か月
    db.tables.children.push({ id: BABY, household_id: HOUSE, name: "あかり", birth_date: "2026-03-01", created_at: V })
    honey()
    const { view } = await load()
    expect(view.ageRulesChecked).toBe(true)
    const [honeyDish, salmon] = entriesOf(view)
    expect(honeyDish.title).toBe("さつまいものはちみつレモン煮")
    expect(honeyDish.ageWarnings).toHaveLength(1)
    expect(honeyDish.ageWarnings?.[0]).toMatchObject({ childId: BABY, childName: "あかり", ingredientName: "はちみつ", ageUnknown: false })
    expect(salmon.ageWarnings).toEqual([])

    db.tables.children.length = 0
    db.tables.children.push({ id: BABY, household_id: HOUSE, name: "はると", birth_date: "2024-05-01", created_at: V })
    const older = await load()
    expect(older.view.ageRulesChecked).toBe(true)
    expect(entriesOf(older.view).flatMap((entry) => entry.ageWarnings ?? [])).toEqual([])
  })

  it("危険側: 子どもだけを読めなかったときは献立を倒さず、年齢の注意は「確かめていない」として返す（注意なしと偽らない）", async () => {
    db.tables.children.push({ id: BABY, household_id: HOUSE, name: "あかり", birth_date: "2026-03-01", created_at: V })
    honey()
    db.failTable("children")
    const { view } = await load()
    expect(entriesOf(view).map((entry) => entry.title)).toEqual(["さつまいものはちみつレモン煮", "鮭の塩焼き"])
    expect(view.ageRulesChecked).toBe(false)
  })

  it("対照: 子どもと別の部分も読めなければ、読み直さずに失敗として返す", async () => {
    db.failTable("children")
    db.failTable("pantry_items")
    const data = await loadPlanPageData(db.supabase, HOUSE, USER, { startDate: TODAY, today: TODAY })
    expect(data.ok).toBe(false)
  })
})

describe("C-37 料理の後に更新できる食材（候補を出すだけ）", () => {
  it("その料理の材料に当たる、登録済みの食材だけを候補にする（使い切った食材・無関係な食材は出さない）", async () => {
    const entry = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    db.tables.dinner_plan_entries.push(entry)
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 300, unit: "g" }),
      pantryRow(HOUSE, { ingredient_id: "potato", name: "じゃがいも", status: "low" }),
      // 肉じゃがの材料だが、使い切っている
      pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ", status: "out" }),
      // 肉じゃがの材料ではない
      pantryRow(HOUSE, { ingredient_id: "milk", name: "牛乳" }),
      // 食材の一覧へ解決できていない
      pantryRow(HOUSE, { ingredient_id: null, name: "なぞの肉" }),
    )
    const before = JSON.stringify(db.tables.pantry_items)
    const { extras } = await load()
    const options = extras.pantryByEntry[entry.id as string]
    expect(options.map((option) => option.name)).toEqual(["じゃがいも", "豚こま"])
    expect(options.find((option) => option.name === "豚こま")).toMatchObject({
      quantityText: "300g",
      status: "have",
      statusLabel: "ある",
      version: V,
    })
    // 数量を登録していない食材は「数量不明」（0 や十分とは言わない）
    expect(options.find((option) => option.name === "じゃがいも")).toMatchObject({
      quantityText: "数量不明",
      statusLabel: "残り少ない",
    })
    // 読むだけ。在庫は変えない・書込の RPC を呼ばない
    expect(JSON.stringify(db.tables.pantry_items)).toBe(before)
    expect(db.rpcNames()).toEqual([])
  })

  it("まだ来ていない日の料理・作らなかった料理には、候補を出さない", async () => {
    const future = entryRow(HOUSE, { plan_date: TOMORROW, status: "confirmed" })
    const skipped = entryRow(HOUSE, { plan_date: TODAY, status: "skipped", position: 1 })
    const today = entryRow(HOUSE, { plan_date: TODAY, status: "confirmed", position: 2 })
    db.tables.dinner_plan_entries.push(future, skipped, today)
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま" }))
    const { extras } = await load()
    expect(Object.keys(extras.pantryByEntry)).toEqual([today.id])
  })
})

describe("C-73 / C-76 食後評価は本人のものだけ", () => {
  it("同じ料理・同じ日の評価が家族にも在っても、自分の評価だけを渡す", async () => {
    const entry = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    db.tables.dinner_plan_entries.push(entry)
    db.tables.dish_feedback.push(
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000002", profile_id: FAMILY, taste: 1 }),
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000001", taste: 3, exclude_from_learning: true }),
    )
    const { extras } = await load()
    expect(extras.feedbackByEntry[entry.id as string]).toEqual({
      id: "f6000000-0000-4000-8000-000000000001",
      version: V,
      taste: 3,
      effort: 2,
      again: true,
      excludeFromLearning: true,
    })
  })

  it("対照: 家族の評価しか無ければ、自分の評価は未記録（家族の評価を編集対象にしない）", async () => {
    const entry = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    db.tables.dinner_plan_entries.push(entry)
    db.tables.dish_feedback.push(feedbackRow({ profile_id: FAMILY }))
    const { extras } = await load()
    expect(extras.feedbackByEntry).toEqual({})
  })

  it("別の日・別の料理の自分の評価は、この枠の評価にしない", async () => {
    const entry = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    db.tables.dinner_plan_entries.push(entry)
    db.tables.dish_feedback.push(
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000003", eaten_on: YESTERDAY }),
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000004", recipe_id: "curry_rice", dish_title: "カレーライス" }),
    )
    const { extras } = await load()
    expect(extras.feedbackByEntry).toEqual({})
  })

  it("手動料理の評価は、料理名と日付で結び付ける", async () => {
    const entry = entryRow(HOUSE, {
      plan_date: TODAY,
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      origin: "manual",
      status: "cooked",
    })
    db.tables.dinner_plan_entries.push(entry)
    db.tables.dish_feedback.push(
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000005", recipe_id: null, dish_title: "おでん" }),
      feedbackRow({ id: "f6000000-0000-4000-8000-000000000006", recipe_id: null, dish_title: "すき焼き" }),
    )
    const { extras } = await load()
    expect(extras.feedbackByEntry[entry.id as string]?.id).toBe("f6000000-0000-4000-8000-000000000005")
  })
})

describe("手動料理の材料（編集フォームの初期値）", () => {
  it("材料を食材の表示名へ直して渡す。材料が未登録なら空の配列（自動計算の対象外）", async () => {
    const withIngredients = entryRow(HOUSE, {
      plan_date: TOMORROW,
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      custom_ingredients: [
        { ingredientId: "daikon", quantity: { amount: 300, unit: "g" } },
        { ingredientId: "salt", quantity: { amount: null, unit: "pinch" }, optional: true },
      ],
      origin: "manual",
      pinned: true,
    })
    const bare = entryRow(HOUSE, {
      plan_date: TOMORROW,
      position: 1,
      recipe_id: null,
      recipe_version: null,
      custom_title: "手巻き寿司",
      origin: "manual",
      pinned: true,
    })
    const catalog = entryRow(HOUSE, { plan_date: TOMORROW, position: 2, role: "side", recipe_id: "spinach_ohitashi" })
    db.tables.dinner_plan_entries.push(withIngredients, bare, catalog)
    const { extras, view } = await load()
    expect(extras.customByEntry[withIngredients.id as string]).toEqual([
      { name: "大根", amount: 300, unit: "g", optional: false },
      { name: "塩", amount: null, unit: "pinch", optional: true },
    ])
    expect(extras.customByEntry[bare.id as string]).toEqual([])
    // 一覧の料理は手動料理の材料を持たない
    expect(Object.keys(extras.customByEntry)).not.toContain(catalog.id)
    // 表示の側でも、材料の無い手動料理だけが「買い物の自動計算の対象外」
    const entries = view.days.flatMap((day) => day.entries)
    expect(entries.find((entry) => entry.id === bare.id)?.groceryUncomputed).toBe(true)
    expect(entries.find((entry) => entry.id === withIngredients.id)?.groceryUncomputed).toBe(false)
  })
})
