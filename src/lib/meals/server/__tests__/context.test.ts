import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { buildExclusionSet, evaluateRecipe } from "../../exclusions"
import {
  MEAL_CONTEXT_PARTS,
  MealContextError,
  type MealSupabase,
  describeMealLoadFailures,
  getMealLookup,
  loadMealContext,
  requireMealContext,
  toMealChildren,
  totalUnreadable,
} from "../context"

const VERSION = "2026-11-11T01:02:03.123456+00:00"
const HOUSEHOLD = "household-a"
const TODAY = "2026-11-11"

type Response = { data: unknown; error: unknown } | (() => never)

interface Call {
  table: string
  columns: string
  filters: [string, string, unknown][]
  single: boolean
  signal: AbortSignal | null
}

/** 表ごとに応答を決められる Supabase の代役。呼ばれた表・列・条件を記録する。 */
function fakeSupabase(responses: Record<string, Response>) {
  const calls: Call[] = []
  const client = {
    from(table: string) {
      const call: Call = { table, columns: "", filters: [], single: false, signal: null }
      calls.push(call)
      const settle = () => {
        const response = responses[table]
        if (response === undefined) throw new Error(`unexpected table: ${table}`)
        if (typeof response === "function") return response()
        // maybeSingle は 0 行を null、1 行をその行として返す
        if (call.single && Array.isArray(response.data)) {
          return { data: response.data[0] ?? null, error: response.error }
        }
        return response
      }
      const builder = {
        select(columns: string) {
          call.columns = columns
          return builder
        },
        eq(column: string, value: unknown) {
          call.filters.push(["eq", column, value])
          return builder
        },
        neq(column: string, value: unknown) {
          call.filters.push(["neq", column, value])
          return builder
        },
        gte(column: string, value: unknown) {
          call.filters.push(["gte", column, value])
          return builder
        },
        lte(column: string, value: unknown) {
          call.filters.push(["lte", column, value])
          return builder
        },
        order() {
          return builder
        },
        abortSignal(signal: AbortSignal) {
          call.signal = signal
          return builder
        },
        maybeSingle() {
          call.single = true
          return builder
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          try {
            return Promise.resolve(settle()).then(resolve, reject)
          } catch (err) {
            return Promise.reject(err).then(resolve, reject)
          }
        },
      }
      return builder
    },
  }
  return { supabase: client as unknown as MealSupabase, calls }
}

const rows = (data: unknown[]): Response => ({ data, error: null })
const failed = (code = "42501"): Response => ({ data: null, error: { message: "denied", code, details: "", hint: "" } })

const pantryRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  ingredient_id: "onion",
  name: "玉ねぎ",
  quantity: 2,
  unit: "piece",
  status: "have",
  use_soon: false,
  storage: null,
  expires_on: null,
  confirmed_on: "2026-11-10",
  updated_at: VERSION,
  ...overrides,
})

const exclusionRow = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  subject_kind: "household",
  subject_profile_id: null,
  subject_child_id: null,
  reason: "allergy",
  target_kind: "allergen",
  target_id: "egg",
  custom_label: null,
  updated_at: VERSION,
  ...overrides,
})

const entryRow = (id: string, date: string) => ({
  id,
  plan_date: date,
  role: "main",
  position: 0,
  recipe_id: "nikujaga",
  recipe_version: 1,
  custom_title: null,
  custom_ingredients: null,
  servings: 2,
  pinned: false,
  status: "confirmed",
  origin: "auto",
  updated_at: VERSION,
})

function allEmpty(): Record<string, Response> {
  return {
    dinner_settings: rows([]),
    pantry_items: rows([]),
    food_exclusions: rows([]),
    food_preferences: rows([]),
    dish_feedback: rows([]),
    dinner_plan_state: rows([]),
    dinner_plan_entries: rows([]),
    grocery_items: rows([]),
    children: rows([]),
    profiles: rows([]),
  }
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("loadMealContext: 必要な部分だけを世帯で絞って読む", () => {
  it("include に挙げた表だけを読む", async () => {
    const { supabase, calls } = fakeSupabase(allEmpty())
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry", "exclusions"], today: TODAY })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.table).sort()).toEqual(["food_exclusions", "pantry_items"])
  })

  it("全ての部分を読むとき、全クエリが household_id で絞られ、`*` を select しない", async () => {
    const { supabase, calls } = fakeSupabase(allEmpty())
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: MEAL_CONTEXT_PARTS, today: TODAY })
    expect(result.ok).toBe(true)
    expect(calls.map((call) => call.table).sort()).toEqual(
      [
        "children",
        "dinner_plan_entries",
        "dinner_plan_state",
        "dinner_settings",
        "dish_feedback",
        "food_exclusions",
        "food_preferences",
        "grocery_items",
        "pantry_items",
        "profiles",
      ].sort(),
    )
    for (const call of calls) {
      expect(call.filters, call.table).toContainEqual(["eq", "household_id", HOUSEHOLD])
      expect(call.columns, call.table).not.toContain("*")
      expect(call.columns, call.table).not.toBe("")
      expect(call.signal, call.table).toBeInstanceOf(AbortSignal)
    }
  })

  it("食後評価は直近 180 日、献立は指定した範囲だけを読む", async () => {
    const { supabase, calls } = fakeSupabase(allEmpty())
    await loadMealContext(supabase, HOUSEHOLD, {
      include: ["feedback", "plan"],
      today: TODAY,
      planRange: { from: "2026-10-28", to: "2026-11-17" },
    })
    const feedback = calls.find((call) => call.table === "dish_feedback")
    expect(feedback?.filters).toContainEqual(["gte", "eaten_on", "2026-05-15"])
    const entries = calls.find((call) => call.table === "dinner_plan_entries")
    expect(entries?.filters).toContainEqual(["gte", "plan_date", "2026-10-28"])
    expect(entries?.filters).toContainEqual(["lte", "plan_date", "2026-11-17"])
  })

  it("献立の範囲を渡さなければ、今日から 7 日ぶん", async () => {
    const { supabase, calls } = fakeSupabase(allEmpty())
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["plan"], today: TODAY })
    const entries = calls.find((call) => call.table === "dinner_plan_entries")
    expect(entries?.filters).toContainEqual(["gte", "plan_date", "2026-11-11"])
    expect(entries?.filters).toContainEqual(["lte", "plan_date", "2026-11-17"])
    expect(requireMealContext(result).plan).toMatchObject({ from: "2026-11-11", to: "2026-11-17" })
  })

  it("家族の一覧は承認済みで、閲覧だけの役割を名指しで除く", async () => {
    const { supabase, calls } = fakeSupabase({
      ...allEmpty(),
      profiles: rows([
        { id: "u-1", display_name: "たろう" },
        { id: "u-2", display_name: null },
      ]),
    })
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, { include: ["members"], today: TODAY }),
    )
    const call = calls.find((c) => c.table === "profiles")
    expect(call?.filters).toContainEqual(["eq", "is_approved", true])
    expect(call?.filters).toContainEqual(["neq", "role", "viewer"])
    expect(context.members).toEqual([
      { id: "u-1", displayName: "たろう" },
      { id: "u-2", displayName: "" },
    ])
  })
})

describe("loadMealContext: 設定が無い世帯と、設定を読めなかった世帯を分ける", () => {
  it("行が無い → 既定値（標準の人数）と settingsMissing: true", async () => {
    const { supabase } = fakeSupabase(allEmpty())
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, { include: ["settings"], today: TODAY }),
    )
    expect(context.settingsMissing).toBe(true)
    expect(context.settings).toEqual({
      servings: 2,
      includeSoup: false,
      maxCookMinutes: null,
      stapleIngredientIds: [],
      childStages: {},
      version: null,
    })
  })

  it("行が在る → その値と settingsMissing: false", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      dinner_settings: rows([
        {
          household_id: HOUSEHOLD,
          servings: 4,
          include_soup: true,
          max_cook_minutes: 30,
          staples: ["salt"],
          child_stages: { "c-1": "toddler" },
          updated_at: VERSION,
        },
      ]),
    })
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, { include: ["settings"], today: TODAY }),
    )
    expect(context.settingsMissing).toBe(false)
    expect(context.settings).toMatchObject({ servings: 4, stapleIngredientIds: ["salt"], version: VERSION })
  })

  it("取得に失敗 → 既定値を返さず、設定の失敗として返す", async () => {
    const { supabase } = fakeSupabase({ ...allEmpty(), dinner_settings: failed() })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["settings"], today: TODAY })
    expect(result).toEqual({ ok: false, failures: [{ part: "settings", kind: "query" }] })
  })

  it("行は在るが読めない → 未設定と言い換えず、失敗として返す", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      dinner_settings: rows([{ household_id: HOUSEHOLD, servings: 4 }]),
    })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["settings"], today: TODAY })
    expect(result).toEqual({ ok: false, failures: [{ part: "settings", kind: "unreadable" }] })
  })
})

describe("loadMealContext: 取得の失敗を「空」として返さない", () => {
  it("対照: 0 行は成功（空の一覧）", async () => {
    const { supabase } = fakeSupabase(allEmpty())
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry", "grocery", "plan"], today: TODAY }),
    )
    expect(context.pantry).toEqual([])
    expect(context.grocery).toEqual([])
    expect(context.plan).toEqual({
      revision: 0,
      groceryRevision: null,
      from: "2026-11-11",
      to: "2026-11-17",
      entries: [],
    })
    expect(context.unreadable).toEqual({})
  })

  it("1 つの表が error を返せば、他が読めていても全体は失敗（読めた分だけの文脈を渡さない）", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      pantry_items: rows([pantryRow("p-1")]),
      food_exclusions: failed(),
    })
    const result = await loadMealContext(supabase, HOUSEHOLD, {
      include: ["pantry", "exclusions", "settings"],
      today: TODAY,
    })
    expect(result).toEqual({ ok: false, failures: [{ part: "exclusions", kind: "query" }] })
    expect(result).not.toHaveProperty("context")
  })

  it("複数の表が失敗すれば、全ての部分を挙げる", async () => {
    const { supabase } = fakeSupabase({ ...allEmpty(), pantry_items: failed(), grocery_items: failed("PGRST301") })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry", "grocery"], today: TODAY })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures.map((failure) => failure.part).sort()).toEqual(["grocery", "pantry"])
  })

  it("クエリが例外を投げても reject せず、その部分の失敗として返す", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      pantry_items: () => {
        throw new TypeError("fetch failed")
      },
    })
    await expect(
      loadMealContext(supabase, HOUSEHOLD, { include: ["pantry", "settings"], today: TODAY }),
    ).resolves.toEqual({ ok: false, failures: [{ part: "pantry", kind: "query" }] })
  })

  it("error が無いのに配列でない応答は「0 件」ではなく失敗", async () => {
    const { supabase } = fakeSupabase({ ...allEmpty(), pantry_items: { data: null, error: null } })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry"], today: TODAY })
    expect(result).toEqual({ ok: false, failures: [{ part: "pantry", kind: "unreadable" }] })
  })

  it("献立の版だけ読めなくても、版を 0 と言い換えない", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      dinner_plan_state: failed(),
      dinner_plan_entries: rows([entryRow("e-1", "2026-11-12")]),
    })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["plan"], today: TODAY })
    expect(result).toEqual({ ok: false, failures: [{ part: "plan", kind: "query" }] })

    const broken = fakeSupabase({ ...allEmpty(), dinner_plan_state: rows([{ household_id: HOUSEHOLD, revision: null }]) })
    await expect(loadMealContext(broken.supabase, HOUSEHOLD, { include: ["plan"], today: TODAY })).resolves.toEqual({
      ok: false,
      failures: [{ part: "plan", kind: "unreadable" }],
    })
  })

  it("世帯 ID が空・日付が不正な呼び出しは、DB を読まずに失敗", async () => {
    const { supabase, calls } = fakeSupabase(allEmpty())
    await expect(loadMealContext(supabase, "", { include: ["pantry"], today: TODAY })).resolves.toEqual({
      ok: false,
      failures: [{ part: "pantry", kind: "query" }],
    })
    await expect(
      loadMealContext(supabase, HOUSEHOLD, {
        include: ["pantry", "plan"],
        today: TODAY,
        planRange: { from: "2026-11-20", to: "2026-11-11" },
      }),
    ).resolves.toEqual({ ok: false, failures: [{ part: "plan", kind: "query" }] })
    expect(calls).toEqual([])
  })

  it("失敗の記録に、行の中身や DB の details を出さない", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      pantry_items: { data: null, error: { message: "boom", code: "23514", details: "Failing row contains (秘密の食材)", hint: "" } },
    })
    await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry"], today: TODAY })
    expect(consoleError).toHaveBeenCalled()
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("秘密の食材")
  })
})

/**
 * PostgREST の `max_rows`（`supabase/config.toml` は 1000）を写した代役。1 回の応答は `maxRows` 行までに
 * 切られる（error にはならない）。`select(列, { count: "exact" })` には、条件に合う全行数を `count` で返す。
 * `lose` = 2 ページ目以降で落とす行数（読んでいる最中に別の端末が消した、を写す）。
 */
function cappedSupabase(tables: Record<string, unknown[]>, maxRows: number, options: { lose?: number; noCount?: boolean } = {}) {
  const requests: { table: string; from: number; to: number | null; counted: boolean }[] = []
  const client = {
    from(table: string) {
      let from = 0
      let to: number | null = null
      let counted = false
      let single = false
      const builder = {
        select(_columns: string, selectOptions?: { count?: string }) {
          counted = selectOptions?.count === "exact"
          return builder
        },
        eq: () => builder,
        neq: () => builder,
        gte: () => builder,
        lte: () => builder,
        order: () => builder,
        abortSignal: () => builder,
        maybeSingle() {
          single = true
          return builder
        },
        range(start: number, end: number) {
          from = start
          to = end
          return builder
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          const all = tables[table] ?? []
          requests.push({ table, from, to, counted })
          const source = from > 0 && options.lose ? all.slice(0, all.length - options.lose) : all
          const wanted = to === null ? source.slice(from) : source.slice(from, to + 1)
          const data = wanted.slice(0, maxRows)
          const reply = single
            ? { data: data[0] ?? null, error: null }
            : { data, error: null, count: counted && !options.noCount ? all.length : null }
          return Promise.resolve(reply).then(resolve, reject)
        },
      }
      return builder
    },
  }
  return { supabase: client as unknown as MealSupabase, requests }
}

describe("R32 loadMealContext: PostgREST の行数上限で切られた応答を「全件」と扱わない", () => {
  const feedbackRow = (index: number) => ({
    id: `feedback-${String(index).padStart(4, "0")}`,
    profile_id: "profile-a",
    recipe_id: "nikujaga",
    dish_title: "肉じゃが",
    eaten_on: "2026-11-10",
    taste: 3,
    effort: 2,
    again: true,
    exclude_from_learning: false,
    updated_at: VERSION,
  })
  const feedback = Array.from({ length: 8 }, (_, index) => feedbackRow(index))

  it("上限（ここでは 3 行）で切られても、続きを読んで全件を返す", async () => {
    const { supabase, requests } = cappedSupabase({ dish_feedback: feedback }, 3)
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["feedback"], today: TODAY })
    if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.failures)}`)
    // 修正前: 先頭の 3 件だけが返り、欠けたことがどこにも現れなかった
    expect(result.context.feedback.map((row) => row.id)).toEqual(feedback.map((row) => row.id))
    expect(requests.every((request) => request.counted)).toBe(true)
    expect(requests.map((request) => request.from)).toEqual([0, 3, 6])
  })

  it("対照: 上限に届かない読み込みは 1 回で終わる", async () => {
    const { supabase, requests } = cappedSupabase({ dish_feedback: feedback.slice(0, 2) }, 3)
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["feedback"], today: TODAY })
    expect(result.ok && result.context.feedback).toHaveLength(2)
    expect(requests).toHaveLength(1)
  })

  it("続きを読んでも全件に届かなければ、欠けた一覧を返さずに失敗として返す", async () => {
    const { supabase } = cappedSupabase({ dish_feedback: feedback }, 3, { lose: 2 })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["feedback"], today: TODAY })
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.failures).toEqual([{ part: "feedback", kind: "query" }])
    expect(consoleError).toHaveBeenCalled()
  })

  it.each([
    ["pantry", "pantry_items", (index: number) => pantryRow(`pantry-${index}`)],
    ["exclusions", "food_exclusions", (index: number) => exclusionRow(`exclusion-${index}`, { target_id: `allergen_${index}` })],
    ["plan", "dinner_plan_entries", (index: number) => ({ ...entryRow(`entry-${index}`, TODAY), position: index })],
  ] as const)("%s も同じく、切られた分を読み足す（必須除外・在庫・献立を欠けたまま渡さない）", async (part, table, make) => {
    const all = Array.from({ length: 7 }, (_, index) => make(index))
    const { supabase } = cappedSupabase({ [table]: all, dinner_plan_state: [] }, 3)
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: [part], today: TODAY })
    if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.failures)}`)
    const context = result.context as unknown as Record<string, unknown>
    const loaded = part === "plan" ? (context.plan as { entries: unknown[] }).entries : (context[part] as unknown[])
    expect(loaded).toHaveLength(7)
  })

  it("件数を返さない応答（代役・古い経路）では、読めた行をそのまま返す（従来どおり）", async () => {
    const { supabase, requests } = cappedSupabase({ dish_feedback: feedback }, 100, { noCount: true })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["feedback"], today: TODAY })
    expect(result.ok && result.context.feedback).toHaveLength(8)
    expect(requests).toHaveLength(1)
  })
})

describe("loadMealContext: 読めない行", () => {
  it("読めない在庫の行は件数に数え、読めた行は返す（黙って捨てない）", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      pantry_items: rows([pantryRow("p-1"), pantryRow("p-2", { status: "reserved" })]),
    })
    const context = requireMealContext(await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry"], today: TODAY }))
    expect(context.pantry.map((item) => item.id)).toEqual(["p-1"])
    expect(context.unreadable).toEqual({ pantry: 1 })
    expect(totalUnreadable(context)).toBe(1)
    expect(context.issues).toEqual([{ table: "pantry_items", id: "p-2", kind: "unreadable", field: "status" }])
  })

  it("読めない必須除外が 1 件でも在れば、除外の読み込みは失敗（欠けた和集合で提案させない）", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      food_exclusions: rows([exclusionRow("x-1"), exclusionRow("x-2", { target_kind: "brand" })]),
    })
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["exclusions", "pantry"], today: TODAY })
    expect(result).toEqual({ ok: false, failures: [{ part: "exclusions", kind: "unreadable" }] })
  })

  it("対照: 全ての除外が読めれば成功する", async () => {
    const { supabase } = fakeSupabase({ ...allEmpty(), food_exclusions: rows([exclusionRow("x-1")]) })
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, { include: ["exclusions"], today: TODAY }),
    )
    expect(context.exclusions).toHaveLength(1)
    expect(context.unreadable).toEqual({})
  })

  it("設定画面だけ、読めない除外を件数つきで受けられる（一覧と削除のため）", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      food_exclusions: rows([exclusionRow("x-1"), exclusionRow("x-2", { target_kind: "brand" })]),
    })
    const context = requireMealContext(
      await loadMealContext(supabase, HOUSEHOLD, {
        include: ["exclusions"],
        today: TODAY,
        tolerateUnreadableExclusions: true,
      }),
    )
    expect(context.exclusions.map((exclusion) => exclusion.id)).toEqual(["x-1"])
    expect(context.unreadable).toEqual({ exclusions: 1 })
    expect(context.issues).toContainEqual({ table: "food_exclusions", id: "x-2", kind: "unreadable", field: "target_kind" })
  })
})

describe("loadMealContext: 読めた値", () => {
  it("買い物の売場は、上書きが無ければ同梱の食材辞書の既定を使う", async () => {
    const ingredient = getMealLookup().index.byId.values().next().value
    if (!ingredient) throw new Error("catalog is empty")
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      grocery_items: rows([
        {
          id: "g-1",
          origin: "auto",
          item_key: `${ingredient.id}|mass`,
          ingredient_id: ingredient.id,
          name: ingredient.name,
          section: null,
          required_quantity: 100,
          unit: "g",
          required_note: null,
          needs_stock_check: false,
          sources: [],
          purchased_quantity: 0,
          purchased: false,
          purchased_at: null,
          restocked_quantity: 0,
          restock_ids: [],
          note: null,
          plan_revision: 1,
          still_needed: true,
          updated_at: VERSION,
        },
      ]),
    })
    const context = requireMealContext(await loadMealContext(supabase, HOUSEHOLD, { include: ["grocery"], today: TODAY }))
    expect(context.grocery[0]).toMatchObject({ section: ingredient.section, sectionOverridden: false })
  })

  it("子どもは ID・表示名・生年月日。読めない生年月日は未登録として扱う", async () => {
    const { supabase, calls } = fakeSupabase({
      ...allEmpty(),
      children: rows([
        { id: "c-1", name: "はな", birth_date: "2024-05-01" },
        { id: "c-2", name: "", birth_date: null },
        { id: "c-3", name: "そら", birth_date: "2024-02-30" },
      ]),
    })
    const context = requireMealContext(await loadMealContext(supabase, HOUSEHOLD, { include: ["children"], today: TODAY }))
    expect(context.children).toEqual([
      { id: "c-1", name: "はな", birthDate: "2024-05-01" },
      { id: "c-2", name: "", birthDate: null },
      { id: "c-3", name: "そら", birthDate: null },
    ])
    expect(calls[0].columns).toBe("id, name, birth_date")
  })

  it("献立は版・買い物を同期した版・範囲内の枠を返す", async () => {
    const { supabase } = fakeSupabase({
      ...allEmpty(),
      dinner_plan_state: rows([{ household_id: HOUSEHOLD, revision: "7", grocery_revision: 6 }]),
      dinner_plan_entries: rows([entryRow("e-1", "2026-11-12")]),
    })
    const context = requireMealContext(await loadMealContext(supabase, HOUSEHOLD, { include: ["plan"], today: TODAY }))
    expect(context.plan.revision).toBe(7)
    expect(context.plan.groceryRevision).toBe(6)
    expect(context.plan.entries).toEqual([expect.objectContaining({ id: "e-1", date: "2026-11-12", version: VERSION })])
  })

  it("文脈は世帯 ID・今日・カタログの索引を持つ", async () => {
    const { supabase } = fakeSupabase(allEmpty())
    const context = requireMealContext(await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry"], today: TODAY }))
    expect(context.householdId).toBe(HOUSEHOLD)
    expect(context.today).toBe(TODAY)
    expect(context.lookup).toBe(getMealLookup())
  })
})

describe("getMealLookup（同梱カタログの索引）", () => {
  it("レシピと食材辞書とアレルゲン一覧を持ち、ロジックへそのまま渡せる", () => {
    const lookup = getMealLookup()
    expect(lookup.kind).toBe("catalog-view")
    expect(lookup.recipes.length).toBeGreaterThan(0)
    expect(lookup.allergens.length).toBeGreaterThanOrEqual(25)
    const recipe = lookup.recipes[0]
    expect(lookup.recipeById.get(recipe.id)).toBe(recipe)
    // 純粋ロジックが catalog として受け取れること（除外なしなら全レシピが許可される）
    expect(evaluateRecipe(recipe, buildExclusionSet([], lookup)).allowed).toBe(true)
  })

  it("同じ索引を返す（呼ぶたびに作り直さない）", () => {
    expect(getMealLookup()).toBe(getMealLookup())
  })
})

describe("requireMealContext / describeMealLoadFailures", () => {
  it("失敗は、読めなかった部分の名前を持つ例外になる", () => {
    const failures = [
      { part: "pantry", kind: "query" },
      { part: "plan", kind: "unreadable" },
    ] as const
    expect(describeMealLoadFailures(failures)).toBe("食材・献立")
    let thrown: unknown
    try {
      requireMealContext({ ok: false, failures: [...failures] })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MealContextError)
    expect((thrown as MealContextError).message).toBe("食材・献立を読み込めませんでした")
    expect((thrown as MealContextError).failures).toEqual(failures)
  })

  it("対照: 成功した結果は文脈をそのまま返す", async () => {
    const { supabase } = fakeSupabase(allEmpty())
    const result = await loadMealContext(supabase, HOUSEHOLD, { include: ["pantry"], today: TODAY })
    expect(() => requireMealContext(result)).not.toThrow()
  })
})

describe("toMealChildren（取り分けの判定へ渡す形）", () => {
  it("食事段階は保護者の設定から引き、名前は載せない", () => {
    const children = toMealChildren(
      [
        { id: "c-1", name: "はな", birthDate: "2024-05-01" },
        { id: "c-2", name: "そら", birthDate: null },
      ],
      { childStages: { "c-1": "toddler", constructor: "toddler" } },
    )
    expect(children).toEqual([
      { id: "c-1", birthDate: "2024-05-01", mealStage: "toddler" },
      { id: "c-2", birthDate: null, mealStage: null },
    ])
    expect(JSON.stringify(children)).not.toContain("はな")
  })

  it("設定に無い子の段階を、継承プロパティから拾わない", () => {
    expect(toMealChildren([{ id: "constructor", name: "", birthDate: null }], { childStages: {} })[0].mealStage).toBeNull()
  })
})
