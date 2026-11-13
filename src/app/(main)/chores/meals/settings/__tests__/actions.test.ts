/**
 * ごはんの設定・使わない食材（必須除外）・好み・食後評価の Server Action の契約。
 *
 * - X-05: 認証と世帯は getAuthContext から。未認証・閲覧だけの招待では RPC を呼ばない。
 *   世帯 ID・持ち主を紛れ込ませた要求は拒否し、RPC の引数にもその項目は無い
 * - C-55: 除外を変えた後、今日以降の献立（固定を含む）との重なりを返す。**献立は書き換えない**
 * - C-73 / C-76: 個人の好みの持ち主は常に呼び手。他人の profile_id を指定できない
 * - C-61: 食事の段階はロジックの語彙だけを保存する
 * - X-09 / X-10: saved / replayed / conflict / 結果不明を分ける。版は文字列のまま DB へ渡す
 *
 * カタログ（食材辞書・レシピ・アレルゲン）は実物を使う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  revalidatePath: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))

import type {
  SaveDinnerSettingsRequest,
  SaveFoodExclusionRequest,
  SaveFoodPreferenceRequest,
} from "@/lib/meals/server/settings-requests"

import {
  deleteDishFeedback,
  deleteFoodExclusion,
  deleteFoodPreference,
  saveDinnerSettings,
  saveFoodExclusion,
  saveFoodPreference,
} from "../actions"

const USER = "e1000000-0000-4000-8000-000000000001"
const SPOUSE = "e1000000-0000-4000-8000-000000000002"
const HOUSE = "e1000000-0000-4000-8000-0000000000a1"
const OTHER_HOUSE = "e1000000-0000-4000-8000-0000000000b1"
const CHILD = "e4000000-0000-4000-8000-000000000001"
const ROW = "e2000000-0000-4000-8000-000000000001"
const OTHER_ROW = "e2000000-0000-4000-8000-000000000002"
const ENTRY_PINNED = "e3000000-0000-4000-8000-000000000001"
const ENTRY_SAFE = "e3000000-0000-4000-8000-000000000002"
const ENTRY_COOKED = "e3000000-0000-4000-8000-000000000003"
const ENTRY_CURRY = "e3000000-0000-4000-8000-000000000004"
const V1 = "2026-11-10T00:00:00.123456+00:00"
const V2 = "2026-11-11T02:00:00.654321+00:00"
const TODAY = "2026-11-11"
const TOMORROW = "2026-11-12"

type Reply = { data: unknown; error: { code?: string; message?: string } | null }
type RpcHandler = (name: string, args: Record<string, unknown>) => Reply
type TableReply = Reply | (() => never)

interface TableCall {
  table: string
  filters: [string, string, unknown][]
}

/** RPC と、表ごとに応答を決められる読み取りの代役。呼ばれた RPC・表・条件を記録する。 */
function signIn(rpc: RpcHandler, tables: Record<string, TableReply> = {}) {
  const rpcCalls: [string, Record<string, unknown>][] = []
  const tableCalls: TableCall[] = []
  const supabase = {
    from(table: string) {
      const call: TableCall = { table, filters: [] }
      let single = false
      tableCalls.push(call)
      const settle = () => {
        const reply = tables[table]
        if (reply === undefined) throw new Error(`unexpected table: ${table}`)
        if (typeof reply === "function") return reply()
        if (single && Array.isArray(reply.data)) return { data: reply.data[0] ?? null, error: reply.error }
        return reply
      }
      const filter = (op: string) => (column: string, value: unknown) => {
        call.filters.push([op, column, value])
        return builder
      }
      const builder = {
        select: () => builder,
        eq: filter("eq"),
        neq: filter("neq"),
        gte: filter("gte"),
        lte: filter("lte"),
        order: () => builder,
        abortSignal: () => builder,
        maybeSingle() {
          single = true
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
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push([name, args])
      return rpc(name, args)
    },
  }
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: USER, householdId: HOUSE },
  })
  return { rpcCalls, tableCalls }
}

const settingsRequest = (over: Partial<SaveDinnerSettingsRequest> = {}): SaveDinnerSettingsRequest => ({
  version: V1,
  servings: 3,
  includeSoup: true,
  maxCookMinutes: 30,
  stapleIngredientIds: ["soy_sauce", "salt"],
  childStages: { [CHILD]: "toddler" },
  ...over,
})

function settingsRow(over: Record<string, unknown> = {}) {
  return {
    household_id: HOUSE,
    servings: 3,
    include_soup: true,
    max_cook_minutes: 30,
    staples: ["salt", "soy_sauce"],
    child_stages: { [CHILD]: "toddler" },
    updated_by: USER,
    updated_at: V2,
    created_at: V1,
    ...over,
  }
}

const exclusionRequest = (over: Partial<SaveFoodExclusionRequest> = {}): SaveFoodExclusionRequest => ({
  id: ROW,
  reason: "allergy",
  target: { kind: "allergen", allergenId: "egg" },
  subject: { kind: "household" },
  ...over,
})

function exclusionRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    household_id: HOUSE,
    subject_kind: "household",
    subject_profile_id: null,
    subject_child_id: null,
    reason: "allergy",
    target_kind: "allergen",
    target_id: "egg",
    custom_label: null,
    created_by: USER,
    updated_at: V2,
    created_at: V2,
    ...over,
  }
}

function entryRow(id: string, recipeId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    plan_date: TOMORROW,
    role: "main",
    position: 0,
    recipe_id: recipeId,
    recipe_version: 1,
    custom_title: null,
    custom_ingredients: null,
    servings: 2,
    pinned: false,
    status: "confirmed",
    origin: "auto",
    updated_at: V1,
    ...over,
  }
}

/** 卵焼き（固定・確定）、鮭の塩焼き（確定）、作り終えた卵焼き、カレー（提案）の献立。 */
function planTables(exclusions: unknown[]): Record<string, TableReply> {
  return {
    food_exclusions: { data: exclusions, error: null },
    dinner_plan_state: { data: [], error: null },
    dinner_plan_entries: {
      data: [
        entryRow(ENTRY_COOKED, "tamagoyaki", { plan_date: TODAY, role: "side", status: "cooked" }),
        entryRow(ENTRY_PINNED, "tamagoyaki", { role: "side", pinned: true }),
        entryRow(ENTRY_SAFE, "salmon_shioyaki"),
        entryRow(ENTRY_CURRY, "curry_rice", { plan_date: "2026-11-13", status: "proposed" }),
      ],
      error: null,
    },
  }
}

const preferenceRequest = (over: Partial<SaveFoodPreferenceRequest> = {}): SaveFoodPreferenceRequest => ({
  id: ROW,
  version: null,
  scope: "personal",
  target: { kind: "recipe", id: "nikujaga" },
  sentiment: "like",
  ...over,
})

function preferenceRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    household_id: HOUSE,
    scope: "personal",
    profile_id: USER,
    target_kind: "recipe",
    target_id: "nikujaga",
    sentiment: "like",
    updated_at: V2,
    created_at: V2,
    ...over,
  }
}

const savedDelete: RpcHandler = (_name, args) => ({ data: { status: "saved", id: args.p_id }, error: null })

beforeEach(() => {
  vi.useFakeTimers()
  // 2026-11-11 12:00 JST
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  revalidatePath.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("X-05 認証と世帯", () => {
  it.each([
    ["未認証", { error: "認証されていません", reason: "unauthenticated", context: null }],
    ["子どもだけの閲覧招待（viewer）", { error: "共有画面から閲覧してください", reason: "shared-only", context: null }],
  ])("%s では、どの操作も DB へ届く前に拒否する", async (_name, denied) => {
    getAuthContext.mockResolvedValue(denied)
    const rejected = { error: denied.error, failure: "rejected" }
    expect(await saveDinnerSettings(settingsRequest())).toEqual(rejected)
    expect(await saveFoodExclusion(exclusionRequest())).toEqual(rejected)
    expect(await deleteFoodExclusion({ id: ROW })).toEqual(rejected)
    expect(await saveFoodPreference(preferenceRequest())).toEqual(rejected)
    expect(await deleteFoodPreference({ id: ROW })).toEqual(rejected)
    expect(await deleteDishFeedback({ id: ROW })).toEqual(rejected)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("世帯 ID を紛れ込ませた要求は拒否し、RPC を呼ばない", async () => {
    const { rpcCalls, tableCalls } = signIn(savedDelete)
    const inject = <T extends object>(request: T) => ({ ...request, householdId: OTHER_HOUSE }) as T
    expect(await saveDinnerSettings(inject(settingsRequest()))).toMatchObject({ failure: "rejected" })
    expect(await saveFoodExclusion(inject(exclusionRequest()))).toMatchObject({ failure: "rejected" })
    expect(await deleteFoodExclusion(inject({ id: ROW }))).toMatchObject({ failure: "rejected" })
    expect(await saveFoodPreference(inject(preferenceRequest()))).toMatchObject({ failure: "rejected" })
    expect(await deleteFoodPreference(inject({ id: ROW }))).toMatchObject({ failure: "rejected" })
    expect(await deleteDishFeedback(inject({ id: ROW }))).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
    expect(tableCalls).toEqual([])
  })

  it("RPC の引数に世帯の項目は無く、読み取りは認証で得た世帯だけに絞る", async () => {
    const { rpcCalls, tableCalls } = signIn(
      (name, args) => {
        if (name === "save_dinner_settings") return { data: { status: "saved", settings: settingsRow() }, error: null }
        if (name === "save_food_exclusion") return { data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }
        if (name === "save_food_preference") return { data: { status: "saved", preference: preferenceRow(ROW) }, error: null }
        return savedDelete(name, args)
      },
      planTables([exclusionRow(ROW)]),
    )
    await saveDinnerSettings(settingsRequest())
    await saveFoodExclusion(exclusionRequest())
    await deleteFoodExclusion({ id: ROW })
    await saveFoodPreference(preferenceRequest())
    await deleteFoodPreference({ id: ROW })
    await deleteDishFeedback({ id: ROW })
    expect(rpcCalls).toHaveLength(6)
    for (const [, args] of rpcCalls) {
      const text = JSON.stringify(args)
      expect(text).not.toMatch(/household_id|householdId/)
      expect(text).not.toContain(HOUSE)
    }
    expect(tableCalls.length).toBeGreaterThan(0)
    for (const call of tableCalls) {
      expect(call.filters).toContainEqual(["eq", "household_id", HOUSE])
    }
  })
})

describe("設定（save_dinner_settings）", () => {
  it("人数・汁物・時間上限・常備品・子どもの食事段階を、開いた時点の版つきで送る", async () => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", settings: settingsRow() }, error: null }))
    const result = await saveDinnerSettings(
      settingsRequest({ stapleIngredientIds: ["soy_sauce", "salt", "soy_sauce"] }),
    )
    expect(rpcCalls).toEqual([
      [
        "save_dinner_settings",
        {
          // 版は文字列のまま（new Date を通さない）
          p_version: V1,
          p_servings: 3,
          p_include_soup: true,
          p_max_cook_minutes: 30,
          // 重複を除き、DB が保存する並び
          p_staples: ["salt", "soy_sauce"],
          p_child_stages: { [CHILD]: "toddler" },
        },
      ],
    ])
    expect(result).toEqual({
      status: "saved",
      deleted: false,
      settings: {
        servings: 3,
        includeSoup: true,
        maxCookMinutes: 30,
        stapleIngredientIds: ["salt", "soy_sauce"],
        childStages: { [CHILD]: "toddler" },
        version: V2,
      },
      // 献立を読めなかった（この代役は献立の表を持たない）。「0 件」と言い換えない
      planServingsMismatch: null,
    })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
    expect(revalidatePath).toHaveBeenCalledWith("/chores")
  })

  it("R45: 人数を変えても献立は書き換えず、人数の違うこれからの未調理の枠の数だけを返す", async () => {
    // 献立: 作り終えた卵焼き（今日）、固定の卵焼き・鮭（明日・確定）、カレー（提案）。どれも 2 人分
    const { rpcCalls } = signIn(
      () => ({ data: { status: "saved", settings: settingsRow({ servings: 4 }) }, error: null }),
      planTables([]),
    )
    const changed = await saveDinnerSettings(settingsRequest({ servings: 4 }))
    // 作り終えた枠は数えない。固定した枠は数える（固定を外さずに人数だけ直せる）
    expect(changed).toMatchObject({ status: "saved", planServingsMismatch: 3 })
    // 設定の保存は、献立の RPC を呼ばない
    expect(rpcCalls.map(([name]) => name)).toEqual(["save_dinner_settings"])

    // 対照: 献立と同じ人数なら 0 件
    signIn(() => ({ data: { status: "saved", settings: settingsRow({ servings: 2 }) }, error: null }), planTables([]))
    expect(await saveDinnerSettings(settingsRequest({ servings: 2 }))).toMatchObject({ planServingsMismatch: 0 })
  })

  it("R45: 家族が先に変えていた（conflict）ときは数えない。献立に読めない行が在れば「確かめられなかった」", async () => {
    signIn(() => ({ data: { status: "conflict", settings: settingsRow({ servings: 5 }) }, error: null }), planTables([]))
    expect(await saveDinnerSettings(settingsRequest({ servings: 4 }))).toMatchObject({
      status: "conflict",
      planServingsMismatch: null,
    })

    const tables = planTables([])
    const entries = (tables.dinner_plan_entries as Reply).data as Record<string, unknown>[]
    signIn(() => ({ data: { status: "saved", settings: settingsRow({ servings: 4 }) }, error: null }), {
      ...tables,
      dinner_plan_entries: { data: [...entries, entryRow(OTHER_ROW, "nikujaga", { status: "simmering" })], error: null },
    })
    expect(await saveDinnerSettings(settingsRequest({ servings: 4 }))).toMatchObject({
      status: "saved",
      planServingsMismatch: null,
    })
  })

  it("常備品を空にして保存できる（初期値を足さない）", async () => {
    const { rpcCalls } = signIn(() => ({
      data: { status: "saved", settings: settingsRow({ staples: [], child_stages: {} }) },
      error: null,
    }))
    await saveDinnerSettings(settingsRequest({ version: null, stapleIngredientIds: [], childStages: {} }))
    expect(rpcCalls[0][1]).toMatchObject({ p_version: null, p_staples: [], p_child_stages: {} })
  })

  it.each<[string, Partial<SaveDinnerSettingsRequest>]>([
    ["人数 0", { servings: 0 }],
    ["人数 13", { servings: 13 }],
    ["小数の人数", { servings: 2.5 }],
    ["文字列の人数", { servings: "3" as never }],
    ["時間上限 4 分", { maxCookMinutes: 4 }],
    ["時間上限 181 分", { maxCookMinutes: 181 }],
    ["汁物が真偽値でない", { includeSoup: "yes" as never }],
    ["食材の一覧に無い常備品", { stapleIngredientIds: ["salt", "unicorn_dust"] }],
    ["ID の形でない常備品", { stapleIngredientIds: ["Salt, Sugar"] }],
    ["201 件の常備品", { stapleIngredientIds: Array.from({ length: 201 }, () => "salt") }],
    ["配列でない常備品", { stapleIngredientIds: "salt" as never }],
    ["ロジックに無い食事段階", { childStages: { [CHILD]: "adult" as never } }],
    ["月齢を書いた食事段階", { childStages: { [CHILD]: "8か月" as never } }],
    ["UUID でない子ども ID", { childStages: { "child-1": "toddler" } }],
    ["形の合わない版", { version: "latest" }],
  ])("%s は拒否し、RPC を呼ばない", async (_name, over) => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", settings: settingsRow() }, error: null }))
    expect(await saveDinnerSettings(settingsRequest(over))).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("対照: 境界の内側の値と、すべての食事段階は RPC へ届く", async () => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", settings: settingsRow() }, error: null }))
    const stages = ["not_started", "weaning_early", "weaning_mid", "weaning_late", "weaning_complete", "toddler"] as const
    for (const stage of stages) {
      const request = settingsRequest({ servings: 12, maxCookMinutes: 180, childStages: { [CHILD]: stage } })
      expect(await saveDinnerSettings(request)).toMatchObject({ status: "saved" })
    }
    expect(await saveDinnerSettings(settingsRequest({ servings: 1, maxCookMinutes: null }))).toMatchObject({ status: "saved" })
    expect(rpcCalls).toHaveLength(stages.length + 1)
  })

  it("家族が先に変えていれば conflict。上書きせず、DB の最新を返す", async () => {
    signIn(() => ({ data: { status: "conflict", settings: settingsRow({ servings: 5 }) }, error: null }))
    expect(await saveDinnerSettings(settingsRequest())).toMatchObject({
      status: "conflict",
      deleted: false,
      settings: { servings: 5, version: V2 },
    })
  })

  it("同じ内容の再送は replayed", async () => {
    signIn(() => ({ data: { status: "replayed", settings: settingsRow() }, error: null }))
    expect(await saveDinnerSettings(settingsRequest())).toMatchObject({ status: "replayed" })
  })

  it("世帯にいない子ども（42501）は拒否", async () => {
    signIn(() => ({ data: null, error: { code: "42501", message: "child unavailable" } }))
    const result = await saveDinnerSettings(settingsRequest())
    expect(result).toMatchObject({ failure: "rejected" })
    expect(JSON.stringify(result)).not.toContain("child unavailable")
  })

  it.each([
    ["通信の失敗（code なし）", { data: null, error: { message: "fetch failed" } }],
    ["戻り値が読めない", { data: { status: "saved" }, error: null }],
    ["行が読めない", { data: { status: "saved", settings: { servings: 3 } }, error: null }],
  ])("%s は結果不明", async (_name, reply) => {
    signIn(() => reply)
    expect(await saveDinnerSettings(settingsRequest())).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("C-55 使わない食材の登録と、献立との重なり", () => {
  it("登録の後、今日以降の献立（固定を含む）との重なりを返す。献立は書き換えない", async () => {
    const { rpcCalls, tableCalls } = signIn(
      () => ({ data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }),
      planTables([exclusionRow(ROW)]),
    )
    const result = await saveFoodExclusion(exclusionRequest())
    if ("failure" in result) throw new Error(`unexpected failure: ${result.error}`)

    expect(result.status).toBe("saved")
    expect(result.exclusion).toMatchObject({
      id: ROW,
      reason: "allergy",
      target: { kind: "allergen", allergenId: "egg" },
      subject: { kind: "household" },
    })
    expect(result.planConflicts).not.toBeNull()
    const conflicts = result.planConflicts?.conflicts ?? []
    // 固定した枠も、新しい除外を無視せず挙げる
    expect(conflicts.find((conflict) => conflict.entryId === ENTRY_PINNED)).toMatchObject({
      date: TOMORROW,
      title: "卵焼き",
      pinned: true,
      status: "confirmed",
      verdict: "blocked",
      ingredientNames: ["卵"],
      exclusionIds: [ROW],
      causedByThisChange: true,
    })
    // 対照: 卵を使わない枠は挙げない。作り終えた枠は対象外
    expect(conflicts.map((conflict) => conflict.entryId)).not.toContain(ENTRY_SAFE)
    expect(conflicts.map((conflict) => conflict.entryId)).not.toContain(ENTRY_COOKED)
    // 原材料を確かめられない料理（商品により異なるルウ）は「確認が必要」として挙げる
    expect(conflicts.find((conflict) => conflict.entryId === ENTRY_CURRY)).toMatchObject({
      verdict: "label_check",
      unverifiable: ["varies_ingredient"],
    })

    // 置換はしない: 呼んだ RPC は除外の登録だけ（献立を書く RPC を呼ばない）
    expect(rpcCalls.map(([name]) => name)).toEqual(["save_food_exclusion"])
    // 献立は今日から、DB が受ける日付の上限まで読む
    const entries = tableCalls.find((call) => call.table === "dinner_plan_entries")
    expect(entries?.filters).toContainEqual(["gte", "plan_date", TODAY])
    expect(entries?.filters).toContainEqual(["lte", "plan_date", "2027-12-16"])
    expect(result.planConflicts).toMatchObject({ from: TODAY, to: "2027-12-16", unreadableEntries: 0 })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
  })

  it("対照: 献立に当たらない除外なら、重なりは 0 件（確認できた上での 0 件）", async () => {
    signIn(
      () => ({ data: { status: "saved", exclusion: exclusionRow(ROW, { reason: "dislike", target_kind: "ingredient", target_id: "eggplant" }) }, error: null }),
      planTables([exclusionRow(ROW, { reason: "dislike", target_kind: "ingredient", target_id: "eggplant" })]),
    )
    const result = await saveFoodExclusion(
      exclusionRequest({ reason: "dislike", target: { kind: "ingredient", ingredientId: "eggplant" } }),
    )
    expect(result).toMatchObject({ status: "saved", planConflicts: { conflicts: [], unreadableEntries: 0 } })
  })

  it("苦手として登録したものも、献立との重なりとして挙がる（必須除外）", async () => {
    const dislike = exclusionRow(ROW, {
      reason: "dislike",
      target_kind: "ingredient",
      target_id: "salmon",
      subject_kind: "member",
      subject_profile_id: SPOUSE,
    })
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", exclusion: dislike }, error: null }), planTables([dislike]))
    const result = await saveFoodExclusion(
      exclusionRequest({
        reason: "dislike",
        target: { kind: "ingredient", ingredientId: "salmon" },
        subject: { kind: "member", profileId: SPOUSE },
      }),
    )
    expect(rpcCalls[0][1]).toEqual({
      p_id: ROW,
      p_subject_kind: "member",
      p_subject_profile_id: SPOUSE,
      p_subject_child_id: null,
      p_reason: "dislike",
      p_target_kind: "ingredient",
      p_target_id: "salmon",
      p_custom_label: null,
    })
    if ("failure" in result) throw new Error("unreachable")
    expect(result.planConflicts?.conflicts.map((conflict) => conflict.entryId)).toEqual([ENTRY_SAFE])
    expect(result.planConflicts?.conflicts[0]).toMatchObject({ verdict: "blocked", ingredientNames: ["鮭"] })
  })

  it("自由入力・子どもが対象の除外も登録できる", async () => {
    const custom = exclusionRow(ROW, {
      target_kind: "custom",
      target_id: null,
      custom_label: "パクチー",
      subject_kind: "child",
      subject_child_id: CHILD,
    })
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", exclusion: custom }, error: null }), planTables([custom]))
    const result = await saveFoodExclusion(
      exclusionRequest({ target: { kind: "custom", label: " パクチー " }, subject: { kind: "child", childId: CHILD } }),
    )
    expect(rpcCalls[0][1]).toMatchObject({
      p_subject_kind: "child",
      p_subject_child_id: CHILD,
      p_subject_profile_id: null,
      p_target_kind: "custom",
      p_target_id: null,
      p_custom_label: "パクチー",
    })
    expect(result).toMatchObject({ status: "saved", exclusion: { target: { kind: "custom", label: "パクチー" } } })
  })

  describe("R01 登録した除外が何に解決したかを返す（判定できない入力を「外れる」と見せない）", () => {
    const customRow = (label: string, reason: "allergy" | "dislike") =>
      exclusionRow(ROW, { reason, target_kind: "custom", target_id: null, custom_label: label })
    async function saveCustom(label: string, reason: "allergy" | "dislike") {
      const row = customRow(label, reason)
      signIn(() => ({ data: { status: "saved", exclusion: row }, error: null }), planTables([row]))
      const result = await saveFoodExclusion(exclusionRequest({ reason, target: { kind: "custom", label } }))
      if ("failure" in result) throw new Error("unreachable")
      return result
    }

    it("どこにも当たらないアレルギーは holds_auto_confirm。献立の全ての枠が「確認が必要」になり、理由の文を返す", async () => {
      const result = await saveCustom("ぞぞぞ成分", "allergy")
      expect(result.resolution).toEqual({
        status: "undetermined",
        effect: "holds_auto_confirm",
        targetNames: [],
        message: expect.stringContaining("献立を確定できなくなります"),
      })
      expect(result.resolution?.message).toContain("「ぞぞぞ成分」")
      // 卵を使わない枠（対照の枠）まで「確認が必要」になる。作り終えた枠は対象外のまま
      const byEntry = new Map(result.planConflicts?.conflicts.map((conflict) => [conflict.entryId, conflict]))
      expect(byEntry.get(ENTRY_SAFE)).toMatchObject({ verdict: "label_check", unverifiable: [], exclusionIds: [] })
      expect(byEntry.get(ENTRY_PINNED)).toMatchObject({ verdict: "label_check" })
      expect(byEntry.has(ENTRY_COOKED)).toBe(false)
      expect(result.planConflicts?.holdMessage).toContain("「ぞぞぞ成分」")
    })

    it("どこにも当たらない苦手は no_effect（何も除外されない）。献立は止めず、保留の文も出さない", async () => {
      const result = await saveCustom("ぞぞぞ成分", "dislike")
      expect(result.resolution).toMatchObject({ status: "undetermined", effect: "no_effect", targetNames: [] })
      expect(result.resolution?.message).toContain("何も除外されません")
      expect(result.planConflicts?.holdMessage).toBeNull()
      expect(result.planConflicts?.conflicts.map((conflict) => conflict.entryId)).not.toContain(ENTRY_SAFE)
    })

    it("対照: 総称（乳製品）は一覧の品目へ解決し、excludes。一覧から選んだ品目も excludes", async () => {
      const dairy = await saveCustom("乳製品", "allergy")
      expect(dairy.resolution).toMatchObject({ status: "resolved", effect: "excludes" })
      expect(dairy.resolution?.targetNames).toContain("乳")
      expect(dairy.planConflicts?.holdMessage).toBeNull()

      signIn(() => ({ data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }), planTables([exclusionRow(ROW)]))
      const listed = await saveFoodExclusion(exclusionRequest())
      expect(listed).toMatchObject({ resolution: { status: "resolved", effect: "excludes", targetNames: ["卵"] } })
    })

    it("conflict（同じ内容が登録済み）でも、登録済みの行について返す。失敗の応答には載せない", async () => {
      const row = { ...customRow("ぞぞぞ成分", "allergy"), id: OTHER_ROW }
      signIn(() => ({ data: { status: "conflict", exclusion: row }, error: null }), planTables([row]))
      const result = await saveFoodExclusion(exclusionRequest({ target: { kind: "custom", label: "ぞぞぞ成分" } }))
      expect(result).toMatchObject({ status: "conflict", resolution: { effect: "holds_auto_confirm" } })

      signIn(() => ({ data: null, error: { code: "22023", message: "invalid target" } }))
      const failed = await saveFoodExclusion(exclusionRequest({ target: { kind: "custom", label: "ぞぞぞ成分" } }))
      expect(failed).not.toHaveProperty("resolution")
    })
  })

  it("献立を読めなかったときは planConflicts を null にする（保存を失敗と言い換えず、重なり無しとも言わない）", async () => {
    signIn(() => ({ data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }), {
      food_exclusions: { data: [exclusionRow(ROW)], error: null },
      dinner_plan_state: { data: [], error: null },
      dinner_plan_entries: { data: null, error: { code: "57014", message: "timeout" } },
    })
    const result = await saveFoodExclusion(exclusionRequest())
    expect(result).toMatchObject({ status: "saved", planConflicts: null })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
  })

  it("読み取りが例外を投げても、保存の成功は成功のまま返す", async () => {
    signIn(() => ({ data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }), {
      food_exclusions: () => {
        throw new TypeError("fetch failed")
      },
      dinner_plan_state: { data: [], error: null },
      dinner_plan_entries: { data: [], error: null },
    })
    expect(await saveFoodExclusion(exclusionRequest())).toMatchObject({ status: "saved", planConflicts: null })
  })

  it("同じ内容の除外が別の ID で登録済みなら conflict（その行を返し、重なりもその行で数える）", async () => {
    signIn(
      () => ({ data: { status: "conflict", exclusion: exclusionRow(OTHER_ROW) }, error: null }),
      planTables([exclusionRow(OTHER_ROW)]),
    )
    const result = await saveFoodExclusion(exclusionRequest())
    if ("failure" in result) throw new Error("unreachable")
    expect(result.status).toBe("conflict")
    expect(result.exclusion.id).toBe(OTHER_ROW)
    expect(result.planConflicts?.conflicts.find((conflict) => conflict.entryId === ENTRY_PINNED)).toMatchObject({
      causedByThisChange: true,
    })
  })

  it.each<[string, Partial<SaveFoodExclusionRequest>]>([
    ["一覧に無いアレルゲン", { target: { kind: "allergen", allergenId: "unobtainium" } }],
    ["一覧に無い食材", { target: { kind: "ingredient", ingredientId: "dragon_fruit_xyz" } }],
    ["空の自由入力", { target: { kind: "custom", label: "  " } }],
    ["31 文字の自由入力", { target: { kind: "custom", label: "あ".repeat(31) } }],
    ["未知の対象の種類", { target: { kind: "brand", id: "x" } as never }],
    ["対象に余分な項目", { target: { kind: "allergen", allergenId: "egg", label: "卵" } as never }],
    ["未知の理由", { reason: "religion" as never }],
    ["profileId の無いメンバー指定", { subject: { kind: "member" } as never }],
    ["UUID でない子ども", { subject: { kind: "child", childId: "first-child" } }],
    ["家族全体に余分な項目", { subject: { kind: "household", profileId: SPOUSE } as never }],
    ["UUID でない ID", { id: "new" }],
  ])("%s は拒否し、RPC を呼ばない", async (_name, over) => {
    const { rpcCalls, tableCalls } = signIn(() => ({ data: { status: "saved", exclusion: exclusionRow(ROW) }, error: null }))
    expect(await saveFoodExclusion(exclusionRequest(over))).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
    expect(tableCalls).toEqual([])
  })

  it.each([
    ["同じ ID に別の内容（23505）", { code: "23505", message: "request id conflict" }, "conflict"],
    ["世帯にいない対象者（42501）", { code: "42501", message: "subject unavailable" }, "rejected"],
    ["DB の検証（22023）", { code: "22023", message: "invalid target" }, "rejected"],
    ["通信の失敗（code なし）", { message: "fetch failed" }, "unknown"],
  ] as const)("%s は %s。献立との重なりは読みに行かない", async (_name, error, failure) => {
    const { tableCalls } = signIn(() => ({ data: null, error }))
    const result = await saveFoodExclusion(exclusionRequest())
    expect(result).toMatchObject({ failure })
    expect(JSON.stringify(result)).not.toContain(error.message)
    expect(tableCalls).toEqual([])
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    ["saved なのに別の行", { status: "saved", exclusion: exclusionRow(OTHER_ROW) }],
    ["対象が読めない行", { status: "saved", exclusion: exclusionRow(ROW, { target_kind: "brand" }) }],
    ["行が無い", { status: "saved" }],
  ])("戻り値を読めない（%s）なら結果不明", async (_name, data) => {
    signIn(() => ({ data, error: null }))
    expect(await saveFoodExclusion(exclusionRequest())).toMatchObject({ failure: "unknown" })
  })
})

describe("使わない食材の削除", () => {
  it("削除の後、残っている除外との重なりを返す（解消した枠は挙がらない）", async () => {
    const { rpcCalls } = signIn(savedDelete, planTables([]))
    const result = await deleteFoodExclusion({ id: ROW })
    expect(rpcCalls).toEqual([["delete_food_exclusion", { p_id: ROW }]])
    expect(result).toEqual({
      status: "saved",
      id: ROW,
      planConflicts: { from: TODAY, to: "2027-12-16", conflicts: [], unreadableEntries: 0, holdMessage: null },
    })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
  })

  it("対照: ほかの除外が残っていれば、その重なりは残る", async () => {
    signIn(savedDelete, planTables([exclusionRow(OTHER_ROW)]))
    const result = await deleteFoodExclusion({ id: ROW })
    if ("failure" in result) throw new Error("unreachable")
    expect(result.planConflicts?.conflicts.map((conflict) => conflict.entryId)).toContain(ENTRY_PINNED)
    expect(result.planConflicts?.conflicts.every((conflict) => !conflict.causedByThisChange)).toBe(true)
  })

  it("既に無い除外の削除は replayed", async () => {
    signIn(() => ({ data: { status: "replayed", id: ROW }, error: null }), planTables([]))
    expect(await deleteFoodExclusion({ id: ROW })).toMatchObject({ status: "replayed", id: ROW })
  })

  it("別世帯の行（42501）は拒否", async () => {
    const { tableCalls } = signIn(() => ({ data: null, error: { code: "42501", message: "not allowed" } }))
    expect(await deleteFoodExclusion({ id: ROW })).toMatchObject({ failure: "rejected" })
    expect(tableCalls).toEqual([])
  })
})

describe("C-73 / C-76 好み", () => {
  it("個人の好みに他人の profile_id を指定できない（持ち主の項目を持つ要求は拒否）", async () => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", preference: preferenceRow(ROW) }, error: null }))
    const withProfileId = { ...preferenceRequest(), profileId: SPOUSE } as unknown as SaveFoodPreferenceRequest
    const withSnakeCase = { ...preferenceRequest(), profile_id: SPOUSE } as unknown as SaveFoodPreferenceRequest
    const inTarget = preferenceRequest({ target: { kind: "recipe", id: "nikujaga", profileId: SPOUSE } as never })
    expect(await saveFoodPreference(withProfileId)).toMatchObject({ failure: "rejected" })
    expect(await saveFoodPreference(withSnakeCase)).toMatchObject({ failure: "rejected" })
    expect(await saveFoodPreference(inTarget)).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
  })

  it("個人の好みの RPC に持ち主の引数は無い（DB が呼び手に固定する）", async () => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", preference: preferenceRow(ROW) }, error: null }))
    const result = await saveFoodPreference(preferenceRequest())
    expect(rpcCalls).toEqual([
      [
        "save_food_preference",
        {
          p_id: ROW,
          p_version: null,
          p_scope: "personal",
          p_target_kind: "recipe",
          p_target_id: "nikujaga",
          p_sentiment: "like",
        },
      ],
    ])
    expect(JSON.stringify(rpcCalls)).not.toMatch(/profile/i)
    expect(result).toEqual({
      status: "saved",
      deleted: false,
      preference: {
        id: ROW,
        scope: "personal",
        profileId: USER,
        target: { kind: "recipe", id: "nikujaga" },
        sentiment: "like",
        version: V2,
      },
    })
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
  })

  it("ほかの家族の個人の好みの ID で変更しようとすると、DB の拒否（42501）を拒否として返す", async () => {
    signIn(() => ({ data: null, error: { code: "42501", message: "not allowed" } }))
    const result = await saveFoodPreference(preferenceRequest({ id: OTHER_ROW, version: V1, sentiment: "dislike" }))
    expect(result).toEqual({ error: "ほかの家族の個人の好みは変更できません。", failure: "rejected" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("家族共通の好みは版つきで変更できる", async () => {
    const shared = preferenceRow(ROW, { scope: "household", profile_id: null, target_kind: "tag", target_id: "fish", sentiment: "dislike" })
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", preference: shared }, error: null }))
    const result = await saveFoodPreference(
      preferenceRequest({ version: V1, scope: "household", target: { kind: "tag", id: "fish" }, sentiment: "dislike" }),
    )
    expect(rpcCalls[0][1]).toMatchObject({ p_version: V1, p_scope: "household", p_target_kind: "tag", p_target_id: "fish" })
    expect(result).toMatchObject({ status: "saved", preference: { scope: "household", profileId: null } })
  })

  it.each<[string, Partial<SaveFoodPreferenceRequest>]>([
    ["一覧に無い料理", { target: { kind: "recipe", id: "ghost_recipe" } }],
    ["一覧に無い食材", { target: { kind: "ingredient", id: "dragon_fruit_xyz" } }],
    ["一覧に無いタグ", { target: { kind: "tag", id: "spicy_level_9" } }],
    ["未知の対象の種類", { target: { kind: "allergen", id: "egg" } as never }],
    ["未知の範囲", { scope: "everyone" as never }],
    ["未知の好み", { sentiment: "love" as never }],
    ["形の合わない版", { version: "v1" }],
  ])("%s は拒否し、RPC を呼ばない", async (_name, over) => {
    const { rpcCalls } = signIn(() => ({ data: { status: "saved", preference: preferenceRow(ROW) }, error: null }))
    expect(await saveFoodPreference(preferenceRequest(over))).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
  })

  it("対照: 食材・タグの好みは RPC へ届く", async () => {
    const { rpcCalls } = signIn((_name, args) => ({
      data: { status: "saved", preference: preferenceRow(ROW, { target_kind: args.p_target_kind, target_id: args.p_target_id }) },
      error: null,
    }))
    expect(await saveFoodPreference(preferenceRequest({ target: { kind: "ingredient", id: "eggplant" } }))).toMatchObject({ status: "saved" })
    expect(await saveFoodPreference(preferenceRequest({ target: { kind: "tag", id: "curry" } }))).toMatchObject({ status: "saved" })
    expect(rpcCalls).toHaveLength(2)
  })

  it("同じ対象の好みが別の ID で在れば conflict（その行を返す）", async () => {
    signIn(() => ({ data: { status: "conflict", preference: preferenceRow(OTHER_ROW, { sentiment: "dislike" }) }, error: null }))
    expect(await saveFoodPreference(preferenceRequest())).toMatchObject({
      status: "conflict",
      deleted: false,
      preference: { id: OTHER_ROW, sentiment: "dislike" },
    })
  })

  it("変更しようとした好みが既に削除されていれば conflict + deleted", async () => {
    signIn(() => ({ data: { status: "conflict", preference: { id: ROW, deleted: true } }, error: null }))
    expect(await saveFoodPreference(preferenceRequest({ version: V1 }))).toEqual({
      status: "conflict",
      preference: null,
      deleted: true,
    })
  })

  it.each([
    ["通信の失敗（code なし）", { data: null, error: { message: "fetch failed" } }],
    ["saved なのに別の行", { data: { status: "saved", preference: preferenceRow(OTHER_ROW) }, error: null }],
    ["持ち主の無い個人の好み", { data: { status: "saved", preference: preferenceRow(ROW, { profile_id: null }) }, error: null }],
  ])("%s は結果不明", async (_name, reply) => {
    signIn(() => reply)
    expect(await saveFoodPreference(preferenceRequest())).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe("C-75 好み・覚えた好み（食後評価）の削除", () => {
  const cases = [
    ["好み", deleteFoodPreference, "delete_food_preference"],
    ["食後評価", deleteDishFeedback, "delete_dish_feedback"],
  ] as const

  it.each(cases)("%s: ID だけを送り、消えたら saved。画面を読み直させる", async (_name, action, rpcName) => {
    const { rpcCalls } = signIn(savedDelete)
    expect(await action({ id: ROW })).toEqual({ status: "saved", id: ROW })
    expect(rpcCalls).toEqual([[rpcName, { p_id: ROW }]])
    // 次の提案・献立は DB の行から計算し直す（削除した記録を画面のキャッシュに残さない）
    expect(revalidatePath).toHaveBeenCalledWith("/chores/meals", "layout")
    expect(revalidatePath).toHaveBeenCalledWith("/chores")
  })

  it.each(cases)("%s: 既に無ければ replayed", async (_name, action) => {
    signIn(() => ({ data: { status: "replayed", id: ROW }, error: null }))
    expect(await action({ id: ROW })).toEqual({ status: "replayed", id: ROW })
  })

  it.each(cases)("%s: ほかの家族のもの（42501）は拒否", async (_name, action) => {
    signIn(() => ({ data: null, error: { code: "42501", message: "not allowed" } }))
    expect(await action({ id: OTHER_ROW })).toMatchObject({ failure: "rejected" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each(cases)("%s: 例外・読めない戻り値は結果不明", async (_name, action) => {
    signIn(() => {
      throw new TypeError("fetch failed")
    })
    expect(await action({ id: ROW })).toMatchObject({ failure: "unknown" })
    signIn(() => ({ data: { status: "saved", id: OTHER_ROW }, error: null }))
    expect(await action({ id: ROW })).toMatchObject({ failure: "unknown" })
    signIn(() => ({ data: { status: "conflict", id: ROW }, error: null }))
    expect(await action({ id: ROW })).toMatchObject({ failure: "unknown" })
  })

  it.each(cases)("%s: ID の形でない要求・余分な項目は拒否", async (_name, action) => {
    const { rpcCalls } = signIn(savedDelete)
    expect(await action({ id: "1" })).toMatchObject({ failure: "rejected" })
    expect(await action({ id: ROW, profileId: SPOUSE } as never)).toMatchObject({ failure: "rejected" })
    expect(await action(null as never)).toMatchObject({ failure: "rejected" })
    expect(rpcCalls).toEqual([])
  })
})
