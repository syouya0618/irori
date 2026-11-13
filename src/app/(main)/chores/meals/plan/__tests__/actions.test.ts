/**
 * 献立の Server Action の契約。
 *
 * - X-05: 認証と世帯は getAuthContext から。余分な項目（世帯 ID の注入）を持つ要求は拒む
 * - C-81 / C-89: AI 未設定・無料枠終了でも、規則ベースの解釈と自動献立がそのまま動く
 * - C-86 / C-87: AI へ渡すのは除外を適用済みの候補と対象日だけ。返った ID は検証し直す
 * - C-38: 希望を解釈した後に除外・献立の版が変わっていたら、古い希望を採用しない
 * - C-33: 固定枠は、作り直し・1 日差替え・1 品差替え・移動・確定のどれでも残る
 * - C-37: 「作った」で在庫を自動では減らさない
 * - X-09: 同じ操作 ID の再送は、もう一度作り直さない
 *
 * DB は `fake-dinner-db.ts` の代役（RPC の性質のうち Action が頼る部分だけを写したもの）。
 * カタログは実物を使う。暦の前提: 2026-11-11 は水曜、2026-11-13 は金曜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath, createAdminClient, adminRpc } = vi.hoisted(() => {
  const adminRpc = vi.fn()
  return {
    getAuthContext: vi.fn(),
    revalidatePath: vi.fn(),
    adminRpc,
    createAdminClient: vi.fn(() => ({ rpc: adminRpc })),
  }
})
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }))

import {
  addDinnerRecipe,
  applyCookedPantryUpdates,
  applyServingsToUpcomingDinners,
  confirmDinnerPlan,
  deleteDinnerEntry,
  generateDinnerPlan,
  interpretDinnerWish,
  markDinnerCooked,
  markDinnerSkipped,
  moveDinnerEntry,
  replaceDinnerDay,
  replaceDinnerDish,
  restoreDinnerEntry,
  saveCustomDish,
  saveDinnerRequest,
  saveDishFeedback,
  setDinnerEntryServings,
  setDinnerPin,
} from "../actions"
import { setGroceryPurchase, syncGroceryList } from "../../shopping/actions"
import { getMealLookup } from "@/lib/meals/server/context"
import { toShoppingItemView } from "@/lib/meals/server/plan-views"
import { groceryItemFromRow } from "@/lib/meals/server/rows"
import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  pantryRow,
  type FakeDinnerDb,
  type Row,
} from "@/lib/meals/server/__tests__/fake-dinner-db"
import { GROCERY_SYNC_FAILED_MESSAGE, type DinnerSaveSuccess } from "@/lib/meals/server/plan-requests"
import type { WishConstraints } from "@/lib/meals/types"

const USER = "f1000000-0000-4000-8000-000000000001"
const HOUSE = "f1000000-0000-4000-8000-0000000000a1"
const OTHER_HOUSE = "f1000000-0000-4000-8000-0000000000b2"
const OP1 = "f2000000-0000-4000-8000-000000000001"
const OP2 = "f2000000-0000-4000-8000-000000000002"
const NEW_ID = "f3000000-0000-4000-8000-000000000001"
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"
const SATURDAY = "2026-11-14"

const EMPTY_WISH: WishConstraints = { pins: [], preferTags: [], avoidTags: [], maxMinutes: null, preferRecipeIds: [] }

let db: FakeDinnerDb
let fetchMock: ReturnType<typeof vi.fn>

function signIn(target: FakeDinnerDb = db) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: target.supabase, userId: target.userId, householdId: target.householdId },
  })
}

function enableAi() {
  vi.stubEnv("MEAL_AI_ENABLED", "true")
  vi.stubEnv("MEAL_AI_ACCOUNT_ID", "0123456789abcdef0123456789abcdef")
  vi.stubEnv("MEAL_AI_API_TOKEN", "test-token")
}

const aiReply = (payload: unknown) =>
  new Response(JSON.stringify({ success: true, result: { response: payload } }), { status: 200 })

function success(result: unknown): DinnerSaveSuccess {
  expect(result).not.toHaveProperty("error")
  return result as DinnerSaveSuccess
}

const generateRequest = (over: Record<string, unknown> = {}) => ({
  operationId: OP1,
  expectedRevision: 0,
  startDate: TODAY,
  days: 7,
  constraints: null,
  mode: "auto" as const,
  ...over,
})

function entryById(id: unknown): Row {
  const row = db.entries().find((entry) => entry.id === id)
  if (!row) throw new Error("entry not found")
  return row
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  // AI は既定で未設定（env を読むので、開発機の値に左右されないよう空にする）
  vi.stubEnv("MEAL_AI_ENABLED", "")
  fetchMock = vi.fn(async () => {
    throw new Error("unexpected fetch")
  })
  vi.stubGlobal("fetch", fetchMock)
  adminRpc.mockResolvedValue({ data: { status: "saved" }, error: null })
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  signIn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  getAuthContext.mockReset()
  revalidatePath.mockReset()
  createAdminClient.mockClear()
  adminRpc.mockReset()
})

describe("X-05 認証と世帯の境界", () => {
  it("未認証なら、どの Action も RPC・AI を呼ばずに拒否する", async () => {
    enableAi()
    getAuthContext.mockResolvedValue({ error: "ログインが必要です", reason: "unauthenticated", context: null })
    const ref = { entryId: NEW_ID, version: "v" }
    const results = await Promise.all([
      generateDinnerPlan(generateRequest()),
      replaceDinnerDay({ operationId: OP1, expectedRevision: 0, date: TODAY }),
      replaceDinnerDish(ref),
      moveDinnerEntry({ ...ref, toDate: FRIDAY }),
      setDinnerPin({ ...ref, pinned: true }),
      saveCustomDish({ id: NEW_ID, version: null, date: TODAY, role: "main", title: "おでん", ingredients: null }),
      addDinnerRecipe({
        id: NEW_ID,
        expectedRevision: 0,
        date: FRIDAY,
        recipeId: "nikujaga",
        role: "main",
        position: 0,
        servings: 2,
        status: "proposed",
      }),
      confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 }),
      markDinnerCooked(ref),
      markDinnerSkipped(ref),
      restoreDinnerEntry(ref),
      deleteDinnerEntry(ref),
      applyCookedPantryUpdates({ updates: [{ id: NEW_ID, version: "v", status: "out" }] }),
      saveDishFeedback({
        id: NEW_ID,
        version: null,
        recipeId: "nikujaga",
        dishTitle: "肉じゃが",
        eatenOn: TODAY,
        taste: 3,
        effort: 2,
        again: true,
        excludeFromLearning: false,
      }),
    ])
    for (const result of results) expect(result).toEqual({ error: "ログインが必要です", failure: "rejected" })
    expect(await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })).toEqual({
      ok: false,
      error: "ログインが必要です",
    })
    expect(db.calls.rpc).toEqual([])
    expect(db.calls.from).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it("世帯 ID を紛れ込ませた要求は、無視ではなく拒否する（対照: 同じ要求から外せば通る）", async () => {
    const injected = { ...generateRequest(), householdId: OTHER_HOUSE }
    expect(await generateDinnerPlan(injected as never)).toEqual({
      error: "入力内容を確認してください。",
      failure: "rejected",
    })
    expect(await saveDinnerRequest({ op: "generate", ...injected } as never)).toMatchObject({ failure: "rejected" })
    expect(db.calls.rpc).toEqual([])

    expect(success(await generateDinnerPlan(generateRequest())).status).toBe("saved")
  })

  it("別世帯の枠の ID を送っても、見つからない扱いで何も書かない", async () => {
    const foreign = entryRow(OTHER_HOUSE, { plan_date: FRIDAY })
    db.tables.dinner_plan_entries.push(foreign)
    const result = success(await setDinnerPin({ entryId: foreign.id as string, version: foreign.updated_at as string, pinned: true }))
    expect(result).toMatchObject({ status: "conflict", detail: "gone" })
    expect(db.rpcNames()).toEqual([])
    expect(foreign.pinned).toBe(false)
  })
})

describe("希望の解釈（interpretDinnerWish）", () => {
  it("AI 未設定なら fetch も claim も無く、規則の結果が返る（献立は変えない）", async () => {
    const result = await interpretDinnerWish({ wish: "金曜はカレー、あとはおまかせで", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({
      ok: true,
      via: "rules",
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }] },
      unparsed: ["あとはおまかせで"],
      revision: 0,
      ai: { state: "not_configured" },
    })
    if (!result.ok) throw new Error("unreachable")
    expect(result.summary).toContainEqual(expect.objectContaining({ kind: "pin", title: "カレーライス" }))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.calls.rpc).toEqual([])
    expect(db.entries()).toEqual([])
  })

  it("AI が有効でも、規則だけで読めた希望では AI を呼ばない（回数を使わない）", async () => {
    enableAi()
    const result = await interpretDinnerWish({ wish: "金曜はカレー", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, via: "rules", unparsed: [], ai: { state: "available" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.rpcNames()).toEqual([])
  })

  it("AI へ渡すのは希望文・対象日・除外を適用済みの候補だけ。氏名や生年月日は送らない", async () => {
    enableAi()
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    db.tables.children.push({ id: "child-1", household_id: HOUSE, name: "いろりたろう", birth_date: "2025-01-23" })
    db.tables.profiles.push({ id: USER, household_id: HOUSE, display_name: "いろりはなこ", is_approved: true, role: "owner" })
    fetchMock.mockResolvedValue(
      aiReply({ pins: [{ date: FRIDAY, recipeId: "nikujaga" }], preferRecipeIds: [], preferTags: ["fish"], avoidTags: [] }),
    )

    const result = await interpretDinnerWish({ wish: "金曜は肉じゃが。週末はさっぱり食べたい", startDate: TODAY, days: 3 })
    expect(result).toMatchObject({
      ok: true,
      via: "ai",
      constraints: { pins: [{ date: FRIDAY, recipeId: "nikujaga" }], preferTags: ["fish"] },
      unparsed: [],
      ai: { state: "available" },
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[] }
    const sent = JSON.parse(body.messages[1].content) as {
      wish: string
      dates: { date: string }[]
      candidates: { id: string; title: string; tags: string[] }[]
    }
    expect(Object.keys(sent).sort()).toEqual(["candidates", "dates", "wish"])
    expect(sent.dates.map((date) => date.date)).toEqual([TODAY, "2026-11-12", FRIDAY])
    for (const candidate of sent.candidates) expect(Object.keys(candidate).sort()).toEqual(["id", "tags", "title"])
    const ids = sent.candidates.map((candidate) => candidate.id)
    // 卵の除外に当たる料理・原材料の確認が要る料理（ルウ）は候補に入らない。対照: 当たらない料理は入る
    expect(ids).not.toContain("oyakodon")
    expect(ids).not.toContain("tamagoyaki")
    expect(ids).not.toContain("curry_rice")
    expect(ids).toContain("nikujaga")
    expect(init.body).not.toContain("いろりたろう")
    expect(init.body).not.toContain("いろりはなこ")
    expect(init.body).not.toContain("2025-01-23")
    expect(init.body).not.toContain(HOUSE)
    expect(init.body).not.toContain("egg\"")

    // 回数は世帯の RPC で計上する（上限 10）。献立は変えない。admin client は使わない
    expect(db.calls.rpc).toEqual([["claim_dinner_ai_call", { p_limit: 10 }]])
    expect(db.entries()).toEqual([])
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it("AI が候補に無い料理を返したら採用せず、規則の結果で続行する（retry も 1 回として計上）", async () => {
    enableAi()
    fetchMock.mockImplementation(async () =>
      aiReply({ pins: [{ date: FRIDAY, recipeId: "fugu_sashimi" }], preferRecipeIds: [], preferTags: [], avoidTags: [] }),
    )
    const result = await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({
      ok: true,
      via: "rules",
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }] },
      ai: { state: "temporary_failure" },
    })
    expect(JSON.stringify(result)).not.toContain("fugu_sashimi")
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(db.rpcNames()).toEqual(["claim_dinner_ai_call", "claim_dinner_ai_call"])
  })

  it("R30: AI の結果は規則で読めた希望へ足す。AI が固定を返さなくても、規則で読めた固定は消えない", async () => {
    enableAi()
    // AI は「さっぱり」だけを読み、金曜のカレー（規則が読めている固定）は返さない
    fetchMock.mockResolvedValue(aiReply({ pins: [], preferRecipeIds: [], preferTags: ["fish"], avoidTags: [], maxMinutes: null }))
    const result = await interpretDinnerWish({ wish: "金曜はカレー、あとはさっぱりしたもの", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({
      ok: true,
      via: "ai",
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: ["fish"] },
      unparsed: [],
    })
    if (!result.ok) throw new Error("unreachable")
    // 要約にも固定が残る（AI 補助 OFF のときと同じ固定が、ON でも付く）
    expect(result.summary).toContainEqual(expect.objectContaining({ kind: "pin", title: "カレーライス" }))
  })

  it("R30: AI が同じ日・同じ区分へ別の料理を固定しても、規則の固定を残す。別の日の固定は足す", async () => {
    enableAi()
    fetchMock.mockResolvedValue(
      aiReply({
        pins: [
          { date: FRIDAY, recipeId: "nikujaga" },
          { date: SATURDAY, recipeId: "nikujaga" },
        ],
        preferRecipeIds: [],
        preferTags: [],
        avoidTags: [],
        maxMinutes: 0,
      }),
    )
    const result = await interpretDinnerWish({ wish: "金曜はカレー、土曜はいつもの煮物がいい", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, via: "ai" })
    if (!result.ok) throw new Error("unreachable")
    expect(result.constraints.pins).toEqual([
      { date: FRIDAY, recipeId: "curry_rice" },
      { date: SATURDAY, recipeId: "nikujaga" },
    ])
    // R31: null を出せないモデルが 0 で埋めた時間は「指定なし」。応答全体を捨てない（fetch は 1 回）
    expect(result.constraints.maxMinutes).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // 足し合わせた希望で、そのまま作成できる（同じ日・同じ区分の二重の固定にならない）
    const made = success(
      await generateDinnerPlan(generateRequest({ constraints: result.constraints, mode: "ai_assisted", expectedRevision: result.revision })),
    )
    expect(made.status).toBe("saved")
    expect(db.entries().filter((entry) => entry.pinned === true).map((entry) => [entry.plan_date, entry.recipe_id])).toEqual(
      expect.arrayContaining([
        [FRIDAY, "curry_rice"],
        [SATURDAY, "nikujaga"],
      ]),
    )
  })

  it("R30: AI が規則と同じ内容しか返さなければ、「AI 補助で読み取った」と名乗らず、読めなかった部分を残す", async () => {
    enableAi()
    fetchMock.mockResolvedValue(
      aiReply({ pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferRecipeIds: [], preferTags: [], avoidTags: [], maxMinutes: null }),
    )
    const result = await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, via: "rules", ai: { state: "available" } })
    if (!result.ok) throw new Error("unreachable")
    expect(result.unparsed.length).toBeGreaterThan(0)
  })

  it("R29: 同じ日・同じ区分の 2 つ目の固定は、固定にせず料理名つきで知らせる。これだけのために AI は呼ばない", async () => {
    enableAi()
    const result = await interpretDinnerWish({ wish: "金曜はカレー、金曜は親子丼", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({
      ok: true,
      via: "rules",
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }] },
      // 画面が unparsed だけを見ていても、固定されなかった希望が黙って消えない
      unparsed: ["金曜は親子丼"],
      ai: { state: "available" },
    })
    if (!result.ok) throw new Error("unreachable")
    expect(result.pinConflicts).toEqual([
      {
        text: "金曜は親子丼",
        date: FRIDAY,
        dateLabel: "11/13（金）",
        recipeId: "oyakodon",
        title: "親子丼",
        keptRecipeId: "curry_rice",
        keptTitle: "カレーライス",
        message: expect.stringContaining("「カレーライス」を固定したため、「親子丼」は固定していません"),
      },
    ])
    // 読めなかった部分は無い（規則が読んだうえで固定にしなかっただけ）。AI も回数も使わない
    expect(fetchMock).not.toHaveBeenCalled()
    expect(db.rpcNames()).toEqual([])
    // 解釈の結果をそのまま渡した作成が拒まれない（「希望の内容を確認できませんでした」にならない）
    const made = success(await generateDinnerPlan(generateRequest({ constraints: result.constraints, expectedRevision: result.revision })))
    expect(made.status).toBe("saved")
    expect(db.entries().filter((entry) => entry.pinned === true).map((entry) => [entry.plan_date, entry.recipe_id])).toEqual([
      [FRIDAY, "curry_rice"],
    ])
  })

  it("R29: 読めなかった部分が別に在れば AI を呼ぶ。AI が残りを読んでも、固定にしなかった希望は unparsed と pinConflicts に残る", async () => {
    enableAi()
    // AI は「さっぱり」を読み、さらに金曜へ親子丼を固定しようとする（規則の固定と同じ枠）
    fetchMock.mockResolvedValue(
      aiReply({ pins: [{ date: FRIDAY, recipeId: "oyakodon" }], preferRecipeIds: [], preferTags: ["fish"], avoidTags: [], maxMinutes: null }),
    )
    const result = await interpretDinnerWish({
      wish: "金曜はカレー、金曜は親子丼、あとはさっぱりしたもの",
      startDate: TODAY,
      days: 7,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      ok: true,
      via: "ai",
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: ["fish"] },
      unparsed: ["金曜は親子丼"],
    })
    if (!result.ok) throw new Error("unreachable")
    expect(result.pinConflicts?.map((conflict) => [conflict.title, conflict.keptTitle])).toEqual([["親子丼", "カレーライス"]])
  })

  it("対照: 固定がぶつからない希望では pinConflicts は空", async () => {
    const result = await interpretDinnerWish({ wish: "金曜はカレー、土曜は親子丼", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, pinConflicts: [], unparsed: [] })
    if (!result.ok) throw new Error("unreachable")
    expect(result.constraints.pins).toHaveLength(2)
  })

  it("世帯の上限に達していれば fetch せず、規則の結果で続行する", async () => {
    enableAi()
    db.intercept("claim_dinner_ai_call", () => ({ data: { status: "household_limit", used: 10, limit: 10 }, error: null }))
    const result = await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, via: "rules", ai: { state: "household_limit" } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("無料枠の枯渇（3036）は admin client 経由でだけ記録し、再開時刻を返す。その後の作成も成功する", async () => {
    enableAi()
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ success: false, errors: [{ code: 3036, message: "daily free allocation" }] }), {
        status: 429,
      }),
    )
    const interpreted = await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })
    expect(interpreted).toMatchObject({
      ok: true,
      via: "rules",
      ai: { state: "provider_exhausted", resetsAt: "2026-11-12T00:00:00.000Z", resetsAtLabel: "11月12日 9:00" },
    })
    if (!interpreted.ok) throw new Error("unreachable")
    // 3036 は retry しない。停止の印は service role の RPC 1 本だけ
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(createAdminClient).toHaveBeenCalledTimes(1)
    expect(adminRpc.mock.calls).toEqual([["mark_dinner_ai_exhausted", { p_until: "2026-11-12T00:00:00.000Z" }]])
    // 利用者の権限のクライアントからは呼ばない
    expect(db.rpcNames()).not.toContain("mark_dinner_ai_exhausted")

    // AI が止まっていても、自動献立は同じ希望で作れる
    const generated = success(
      await generateDinnerPlan(generateRequest({ constraints: interpreted.constraints, expectedRevision: interpreted.revision })),
    )
    expect(generated).toMatchObject({ status: "saved", via: "auto" })
    const curry = db.entries().find((entry) => entry.plan_date === FRIDAY && entry.recipe_id === "curry_rice")
    expect(curry).toMatchObject({ pinned: true, status: "proposed", origin: "auto" })
  })

  it("停止中（claim が provider_exhausted）は fetch も admin も呼ばない", async () => {
    enableAi()
    db.intercept("claim_dinner_ai_call", () => ({
      data: { status: "provider_exhausted", resets_at: "2026-11-12T00:00:00+00:00" },
      error: null,
    }))
    const result = await interpretDinnerWish({ wish: "金曜はカレーで、のんびり作りたい", startDate: TODAY, days: 7 })
    expect(result).toMatchObject({ ok: true, via: "rules", ai: { state: "provider_exhausted" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it("除外の読み込みに失敗したら、空の除外で解釈せずに失敗を返す", async () => {
    db.failTable("food_exclusions")
    const result = await interpretDinnerWish({ wish: "金曜はカレー", startDate: TODAY, days: 7 })
    expect(result).toEqual({ ok: false, error: "使わない食材の設定を読み込めませんでした。" })
  })
})

describe("献立の作成（generateDinnerPlan）", () => {
  it("初回の世帯で 1 日分・7 日分を作れる（提案として保存。主菜と副菜、期間内で重複なし）", async () => {
    const one = success(await generateDinnerPlan(generateRequest({ days: 1 })))
    expect(one).toMatchObject({ status: "saved", revision: 1, via: "auto", gaps: [], grocery: { ok: true } })
    expect(db.entries().map((entry) => entry.role).sort()).toEqual(["main", "side"])

    const week = success(await generateDinnerPlan(generateRequest({ operationId: OP2, expectedRevision: 1 })))
    expect(week).toMatchObject({ status: "saved", revision: 2, gaps: [] })
    const entries = db.entries()
    expect(entries).toHaveLength(14)
    expect(new Set(entries.map((entry) => entry.plan_date)).size).toBe(7)
    expect(new Set(entries.map((entry) => entry.recipe_id)).size).toBe(14)
    for (const entry of entries) {
      expect(entry).toMatchObject({ status: "proposed", origin: "auto", pinned: false, servings: 2 })
    }
    // 提案だけでは買い物の自動項目は増えない（確定した料理だけが対象）
    expect(db.grocery()).toEqual([])
  })

  it("カタログに無い料理・範囲外の日・未知のタグを含む希望は拒否し、何も書かない", async () => {
    const cases: WishConstraints[] = [
      { ...EMPTY_WISH, pins: [{ date: FRIDAY, recipeId: "no_such_dish" }] },
      { ...EMPTY_WISH, preferRecipeIds: ["no_such_dish"] },
      { ...EMPTY_WISH, pins: [{ date: "2026-12-25", recipeId: "nikujaga" }] },
      { ...EMPTY_WISH, preferTags: ["no_such_tag"] },
      { ...EMPTY_WISH, pins: [{ date: FRIDAY, recipeId: "nikujaga" }, { date: FRIDAY, recipeId: "curry_rice" }] },
    ]
    for (const constraints of cases) {
      const result = await generateDinnerPlan(generateRequest({ constraints }))
      expect(result).toMatchObject({ failure: "rejected" })
    }
    expect(db.rpcNames()).not.toContain("apply_dinner_plan")
    expect(db.entries()).toEqual([])

    // 対照: 同じ形で、カタログに在る料理なら採用される
    const ok = success(
      await generateDinnerPlan(generateRequest({ constraints: { ...EMPTY_WISH, pins: [{ date: FRIDAY, recipeId: "nikujaga" }] } })),
    )
    expect(ok.status).toBe("saved")
    expect(db.entries().find((entry) => entry.plan_date === FRIDAY && entry.role === "main")).toMatchObject({
      recipe_id: "nikujaga",
      pinned: true,
    })
  })

  it("C-38: 希望を解釈した後に献立の版が進んでいたら、採用せず最新の版を返す", async () => {
    const interpreted = await interpretDinnerWish({ wish: "金曜は肉じゃが", startDate: TODAY, days: 7 })
    if (!interpreted.ok) throw new Error("unreachable")
    // 待っている間に、別の端末が献立を作った
    success(await generateDinnerPlan(generateRequest({ operationId: OP2 })))
    const before = JSON.stringify(db.entries())

    const result = success(
      await generateDinnerPlan(generateRequest({ constraints: interpreted.constraints, expectedRevision: interpreted.revision })),
    )
    expect(result).toMatchObject({ status: "conflict", detail: "stale_plan", revision: 1, grocery: null })
    expect(JSON.stringify(db.entries())).toBe(before)
    expect(db.rpcNames().filter((name) => name === "apply_dinner_plan")).toHaveLength(1)
  })

  it("C-38: 希望を解釈した後に除外が増えていたら、固定を採用せず何も書かない", async () => {
    const interpreted = await interpretDinnerWish({ wish: "金曜は親子丼", startDate: TODAY, days: 7 })
    if (!interpreted.ok) throw new Error("unreachable")
    expect(interpreted.constraints.pins).toEqual([{ date: FRIDAY, recipeId: "oyakodon" }])
    // 待っている間に、家族が卵のアレルギーを登録した（献立の版は進まない）
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))

    const result = success(
      await generateDinnerPlan(generateRequest({ constraints: interpreted.constraints, expectedRevision: interpreted.revision })),
    )
    expect(result).toMatchObject({ status: "conflict", detail: "constraints_changed" })
    expect(db.rpcNames()).not.toContain("apply_dinner_plan")
    expect(db.entries()).toEqual([])

    // 希望を外せば、除外を守った献立が作れる（卵を使う料理は 1 品も入らない）
    success(await generateDinnerPlan(generateRequest({ operationId: OP2 })))
    const lookup = getMealLookup()
    for (const entry of db.entries()) {
      const recipe = lookup.recipeById.get(entry.recipe_id as string)
      expect(recipe?.ingredients.map((ingredient) => ingredient.ingredientId)).not.toContain("egg")
    }
    expect(db.entries().length).toBeGreaterThan(0)
  })

  it("X-09: 同じ操作 ID の再送は、もう一度作り直さない（replayed）", async () => {
    const first = success(await generateDinnerPlan(generateRequest()))
    expect(first.status).toBe("saved")
    const before = JSON.stringify(db.entries())
    // 応答を失った再送の間に在庫が変わっても、計算し直さない
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "salmon", name: "鮭", quantity: 4, unit: "slice", use_soon: true }))

    const again = success(await generateDinnerPlan(generateRequest()))
    expect(again).toMatchObject({ status: "replayed", revision: 1 })
    expect(JSON.stringify(db.entries())).toBe(before)
    expect(db.rpcNames().filter((name) => name === "apply_dinner_plan")).toHaveLength(1)
  })

  it("買い物の同期に失敗しても、献立の保存は成功のまま別に知らせる", async () => {
    db.intercept("sync_grocery_auto_items", () => ({ data: null, error: { code: "57014", message: "timeout" } }))
    const result = success(await generateDinnerPlan(generateRequest()))
    expect(result).toMatchObject({ status: "saved", grocery: { ok: false, message: GROCERY_SYNC_FAILED_MESSAGE } })
    expect(db.entries()).toHaveLength(14)
  })

  it("AI 補助が有効でない環境では、mode を ai_assisted と送っても「AI 補助」と名乗らない", async () => {
    const constraints = { ...EMPTY_WISH, pins: [{ date: FRIDAY, recipeId: "nikujaga" }], preferTags: ["fish"] }
    const result = success(await generateDinnerPlan(generateRequest({ constraints, mode: "ai_assisted" })))
    expect(result.via).toBe("auto")
    expect(db.entries().filter((entry) => entry.origin !== "auto")).toEqual([])

    // 対照: 有効な環境なら、希望の固定と選び直した枠が「AI 補助」になる
    // （前の作成で固定済みの金曜の主菜は保持されるので、土曜へ別の料理を固定して確かめる）
    enableAi()
    const assisted = success(
      await generateDinnerPlan(
        generateRequest({
          operationId: OP2,
          expectedRevision: 1,
          constraints: { ...constraints, pins: [{ date: SATURDAY, recipeId: "ginger_pork" }] },
          mode: "ai_assisted",
        }),
      ),
    )
    expect(assisted.via).toBe("ai_assisted")
    const kept = db.entries().filter((entry) => entry.origin !== "ai_assisted")
    expect(kept).toEqual([expect.objectContaining({ plan_date: FRIDAY, recipe_id: "nikujaga", pinned: true, origin: "auto" })])
    expect(db.entries().find((entry) => entry.plan_date === SATURDAY && entry.role === "main")).toMatchObject({
      recipe_id: "ginger_pork",
      pinned: true,
      origin: "ai_assisted",
    })
    expect(db.entries()).toHaveLength(14)
    // 作成は AI を呼ばない（AI が関わるのは希望の解釈だけ）
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("C-74: 保存済みの食後評価が次の献立に反映される。好みに反映しない記録は反映しない", async () => {
    const mainsOf = (target: FakeDinnerDb) =>
      target
        .entries()
        .filter((entry) => entry.role === "main")
        .map((entry) => entry.recipe_id as string)
        .sort()
    success(await generateDinnerPlan(generateRequest()))
    const baseline = mainsOf(db)
    expect(baseline).toHaveLength(7)

    const withFeedback = async (excludeFromLearning: boolean) => {
      const next = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
      baseline.forEach((recipeId, index) => {
        next.tables.dish_feedback.push({
          id: `f5000000-0000-4000-8000-0000000000${String(index).padStart(2, "0")}`,
          household_id: HOUSE,
          profile_id: USER,
          recipe_id: recipeId,
          dish_title: recipeId,
          eaten_on: "2026-10-20",
          taste: 1,
          effort: 1,
          again: false,
          exclude_from_learning: excludeFromLearning,
          updated_at: "2026-10-20T12:00:00.000000+00:00",
        })
      })
      signIn(next)
      success(await generateDinnerPlan(generateRequest()))
      return mainsOf(next)
    }
    // 同じ操作 ID（= 同じ種）でも、苦手・また食べたくないと評価した料理は選ばれにくくなる
    expect(await withFeedback(false)).not.toEqual(baseline)
    // 対照: 「好みに反映しない」記録は、献立を変えない
    expect(await withFeedback(true)).toEqual(baseline)
  })

  it("1 つの入口（saveDinnerRequest）からも同じ検証を通って保存できる", async () => {
    const result = success(
      await saveDinnerRequest({
        op: "custom_dish",
        id: NEW_ID,
        version: null,
        date: FRIDAY,
        role: "main",
        title: "外で食べる",
        ingredients: null,
      }),
    )
    expect(result.status).toBe("saved")
    expect(entryById(NEW_ID)).toMatchObject({ custom_title: "外で食べる", origin: "manual" })
    expect(await saveDinnerRequest({ op: "custom_dish", id: NEW_ID } as never)).toMatchObject({ failure: "rejected" })
  })

  it("過ぎた日・先すぎる日からは作らない", async () => {
    expect(await generateDinnerPlan(generateRequest({ startDate: "2026-11-10" }))).toMatchObject({ failure: "rejected" })
    expect(await generateDinnerPlan(generateRequest({ startDate: "2026-12-20" }))).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames()).toEqual([])
  })
})

describe("C-33 固定枠は全操作で残る", () => {
  let pinned: Row
  let cooked: Row

  beforeEach(() => {
    pinned = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", pinned: true, status: "confirmed", origin: "manual" })
    cooked = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "ginger_pork", status: "cooked" })
    db.tables.dinner_plan_entries.push(pinned, cooked)
  })

  const snapshot = (row: Row) => JSON.stringify(row)

  it("全体の作り直し: 固定枠と作った枠は送らず、行もそのまま", async () => {
    const before = [snapshot(pinned), snapshot(cooked)]
    const result = success(await generateDinnerPlan(generateRequest()))
    expect(result.status).toBe("saved")
    const sent = (db.calls.rpc.find(([name]) => name === "apply_dinner_plan")?.[1].p_entries ?? []) as Row[]
    expect(sent.some((entry) => entry.id === pinned.id || entry.id === cooked.id)).toBe(false)
    expect(sent.some((entry) => entry.plan_date === FRIDAY && entry.role === "main")).toBe(false)
    expect(sent.some((entry) => entry.plan_date === TODAY && entry.role === "main")).toBe(false)
    expect([snapshot(entryById(pinned.id)), snapshot(entryById(cooked.id))]).toEqual(before)
    // 丼・カレーの日でも副菜は足す。期間内で固定のカレーを別の日に重ねない
    expect(db.entries().filter((entry) => entry.recipe_id === "curry_rice")).toHaveLength(1)
    expect(db.entries().filter((entry) => entry.plan_date === FRIDAY).map((entry) => entry.role).sort()).toEqual(["main", "side"])
  })

  it("希望の固定が固定済みの枠に当たったら、枠を保持して知らせる", async () => {
    const constraints = { ...EMPTY_WISH, pins: [{ date: FRIDAY, recipeId: "nikujaga" }] }
    const result = success(await generateDinnerPlan(generateRequest({ constraints })))
    expect(result.status).toBe("saved")
    expect(result.rejectedPins).toEqual([expect.objectContaining({ date: FRIDAY, recipeId: "nikujaga", reason: "slot_taken" })])
    expect(entryById(pinned.id)).toMatchObject({ recipe_id: "curry_rice", pinned: true })
  })

  it("1 日の差替え: その日の固定枠は残り、ほかの料理だけが替わる。固定だけの日は拒否", async () => {
    success(await generateDinnerPlan(generateRequest()))
    const sideBefore = db.entries().find((entry) => entry.plan_date === FRIDAY && entry.role === "side")
    const othersBefore = JSON.stringify(db.entries().filter((entry) => entry.plan_date !== FRIDAY))
    const pinnedBefore = snapshot(entryById(pinned.id))

    const result = success(await replaceDinnerDay({ operationId: OP2, expectedRevision: 1, date: FRIDAY }))
    expect(result.status).toBe("saved")
    expect(snapshot(entryById(pinned.id))).toBe(pinnedBefore)
    const sideAfter = db.entries().find((entry) => entry.plan_date === FRIDAY && entry.role === "side")
    expect(sideAfter?.recipe_id).not.toBe(sideBefore?.recipe_id)
    // 他の日は一切変えない
    expect(JSON.stringify(db.entries().filter((entry) => entry.plan_date !== FRIDAY))).toBe(othersBefore)

    // 作った料理だけの日は、差し替えるものが無い
    db.tables.dinner_plan_entries = db.tables.dinner_plan_entries.filter(
      (entry) => entry.plan_date !== TODAY || entry.id === cooked.id,
    )
    const none = await replaceDinnerDay({ operationId: NEW_ID, expectedRevision: db.revision(), date: TODAY })
    expect(none).toMatchObject({ failure: "rejected" })
    expect(entryById(cooked.id)).toMatchObject({ recipe_id: "ginger_pork", status: "cooked" })
  })

  it("1 品の差替え: 固定した料理・作った料理は拒否する（対照: 固定していない料理は替わる）", async () => {
    success(await generateDinnerPlan(generateRequest()))
    expect(await replaceDinnerDish({ entryId: pinned.id as string, version: pinned.updated_at as string })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("固定"),
    })
    expect(await replaceDinnerDish({ entryId: cooked.id as string, version: cooked.updated_at as string })).toMatchObject({
      failure: "rejected",
    })
    expect(entryById(pinned.id)).toMatchObject({ recipe_id: "curry_rice", pinned: true })

    const free = db.entries().find((entry) => entry.plan_date === SATURDAY && entry.role === "main") as Row
    const oldRecipe = free.recipe_id
    const oldVersion = free.updated_at as string
    const replaced = success(await replaceDinnerDish({ entryId: free.id as string, version: oldVersion }))
    expect(replaced.status).toBe("saved")
    const after = entryById(free.id)
    expect(after.recipe_id).not.toBe(oldRecipe)
    expect(after).toMatchObject({ plan_date: SATURDAY, role: "main", status: "proposed", pinned: false })
    // 期間内のほかの料理と重ならない
    expect(db.entries().filter((entry) => entry.recipe_id === after.recipe_id)).toHaveLength(1)

    // 応答を失った再送（古い版のまま）は、もう一度別の料理へ替えない
    const recipeAfter = after.recipe_id
    const retry = success(await replaceDinnerDish({ entryId: free.id as string, version: oldVersion }))
    expect(retry).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(entryById(free.id).recipe_id).toBe(recipeAfter)

    // 直前に見送った料理を渡すと、そこへは戻らない（今の料理も候補から外れる）
    const third = success(
      await replaceDinnerDish({
        entryId: free.id as string,
        version: entryById(free.id).updated_at as string,
        avoidRecipeIds: [oldRecipe as string, "no_such_dish"],
      }),
    )
    expect(third.status).toBe("saved")
    expect([oldRecipe, recipeAfter]).not.toContain(entryById(free.id).recipe_id)
    expect(getMealLookup().recipeById.has(entryById(free.id).recipe_id as string)).toBe(true)
  })

  it("移動: 固定は料理に付いて行き、移動先の固定した料理は押しのけない", async () => {
    const mover = entryRow(HOUSE, { plan_date: SATURDAY, recipe_id: "nikujaga", pinned: true })
    db.tables.dinner_plan_entries.push(mover)
    const result = success(
      await moveDinnerEntry({ entryId: mover.id as string, version: mover.updated_at as string, toDate: FRIDAY }),
    )
    expect(result.status).toBe("saved")
    expect(result.notices.join("")).toContain("2 品")
    expect(entryById(mover.id)).toMatchObject({ plan_date: FRIDAY, pinned: true, recipe_id: "nikujaga", position: 1 })
    expect(entryById(pinned.id)).toMatchObject({ plan_date: FRIDAY, pinned: true, recipe_id: "curry_rice", position: 0 })

    // 作った料理は動かさない・過ぎた日へは動かさない
    expect(
      await moveDinnerEntry({ entryId: cooked.id as string, version: cooked.updated_at as string, toDate: FRIDAY }),
    ).toMatchObject({ failure: "rejected" })
    expect(
      await moveDinnerEntry({ entryId: mover.id as string, version: mover.updated_at as string, toDate: "2026-11-10" }),
    ).toMatchObject({ failure: "rejected" })
    expect(entryById(cooked.id).plan_date).toBe(TODAY)
  })

  it("確定しても固定は外れず、解除は明示の操作だけ", async () => {
    const proposedPin = entryRow(HOUSE, { plan_date: SATURDAY, recipe_id: "nikujaga", pinned: true })
    db.tables.dinner_plan_entries.push(proposedPin)
    const confirmed = success(await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 }))
    expect(confirmed.status).toBe("saved")
    expect(entryById(proposedPin.id)).toMatchObject({ status: "confirmed", pinned: true, recipe_id: "nikujaga" })
    expect(entryById(pinned.id)).toMatchObject({ status: "confirmed", pinned: true })

    const current = entryById(proposedPin.id)
    const unpinned = success(
      await setDinnerPin({ entryId: current.id as string, version: current.updated_at as string, pinned: false }),
    )
    expect(unpinned.status).toBe("saved")
    expect(entryById(proposedPin.id).pinned).toBe(false)
  })
})

describe("R21 / R28 1 日の差替えで外した主食を、料理名つきで知らせる", () => {
  it("主食を含む主菜へ替わった日だけ主食を外し、droppedEntries と notices で知らせる（対照: 替わらなければ主食は残り、知らせも無い）", async () => {
    const lookup = getMealLookup()
    let droppedRuns = 0
    let keptRuns = 0
    for (let i = 0; i < 24; i += 1) {
      db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
      signIn()
      const staple = entryRow(HOUSE, { plan_date: FRIDAY, role: "staple", position: 2, recipe_id: "steamed_rice", status: "confirmed" })
      db.tables.dinner_plan_entries.push(
        entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "ginger_pork" }),
        entryRow(HOUSE, { plan_date: FRIDAY, role: "side", position: 1, recipe_id: "spinach_ohitashi" }),
        staple,
      )
      // 操作 ID の先頭が、同点付近の候補を入れ替える種になる
      const operationId = `f2${i.toString(16).padStart(2, "0")}0000-0000-4000-8000-000000000001`
      const result = success(await replaceDinnerDay({ operationId, expectedRevision: db.revision(), date: FRIDAY }))
      const onDay = db.entries().filter((entry) => entry.plan_date === FRIDAY)
      const main = onDay.find((entry) => entry.role === "main")
      const stapleRows = onDay.filter((entry) => entry.role === "staple")
      if (lookup.recipeById.get(main?.recipe_id as string)?.includesStaple === true) {
        // 丼・カレー・麺へ替わった: ごはんの枠は消え、消したことを料理名つきで返す
        expect(stapleRows, operationId).toEqual([])
        expect(result.droppedEntries, operationId).toEqual([
          {
            entryId: staple.id,
            date: FRIDAY,
            role: "staple",
            title: "ごはん",
            reason: "main_includes_staple",
            message: "11/13（金）: 主食を含む料理（丼・カレー・麺など）に替わったため、主食の「ごはん」を献立から外しました。",
          },
        ])
        expect(result.notices, operationId).toContain(result.droppedEntries?.[0].message)
        droppedRuns += 1
      } else {
        expect(stapleRows.map((entry) => entry.recipe_id), operationId).toEqual(["steamed_rice"])
        expect(result.droppedEntries, operationId).toEqual([])
        expect(result.notices.join(""), operationId).not.toContain("献立から外しました")
        keptRuns += 1
      }
    }
    // 両方の分岐を実際に通っている（検査が片側だけになっていない）
    expect(droppedRuns).toBeGreaterThan(0)
    expect(keptRuns).toBeGreaterThan(0)
  })
})

describe("R01 判定できないアレルギーの除外で料理を決められないときは、その理由を返す", () => {
  const unknownAllergy = () =>
    exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" })

  it("作成: どの料理も自動では選ばず、空き枠の理由として除外の名前つきの文を返す（notices の先頭と autoConfirmHold）", async () => {
    db.tables.food_exclusions.push(unknownAllergy())
    const result = success(await generateDinnerPlan(generateRequest({ days: 2 })))
    expect(db.entries()).toEqual([])
    expect(result.gaps?.every((gap) => gap.reason === "needs_label_check")).toBe(true)
    expect(result.autoConfirmHold).toContain("「ぞぞぞ成分」")
    expect(result.autoConfirmHold).toContain("献立を確定できません")
    expect(result.notices[0]).toBe(result.autoConfirmHold)
  })

  it("1 日の差替え・1 品の差替え: 替えずに、同じ理由を伝える", async () => {
    const dish = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "salmon_shioyaki" })
    db.tables.dinner_plan_entries.push(dish)
    db.tables.food_exclusions.push(unknownAllergy())
    const day = await replaceDinnerDay({ operationId: OP1, expectedRevision: db.revision(), date: FRIDAY })
    expect(day).toMatchObject({ failure: "rejected", error: expect.stringContaining("「ぞぞぞ成分」") })
    const one = await replaceDinnerDish({ entryId: dish.id as string, version: dish.updated_at as string })
    expect(one).toMatchObject({ failure: "rejected", error: expect.stringContaining("「ぞぞぞ成分」") })
    expect(entryById(dish.id)).toMatchObject({ recipe_id: "salmon_shioyaki" })
  })

  it("対照: 判定できない苦手・判定できるアレルギーでは、保留の文を出さずに献立を作る", async () => {
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "dislike", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ風味" }),
      exclusionRow(HOUSE),
    )
    const result = success(await generateDinnerPlan(generateRequest({ days: 2 })))
    expect(result).not.toHaveProperty("autoConfirmHold")
    expect(result.notices.join("")).not.toContain("献立を確定できません")
    expect(db.entries().length).toBeGreaterThan(0)
  })
})

describe("固定・確定と必須除外（C-55）", () => {
  it("除外に当たる料理は固定できず、確定もしない（置換もしない）", async () => {
    const egg = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "oyakodon" })
    const fine = entryRow(HOUSE, { plan_date: FRIDAY, role: "side", position: 1, recipe_id: "spinach_ohitashi" })
    db.tables.dinner_plan_entries.push(egg, fine)
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))

    expect(await setDinnerPin({ entryId: egg.id as string, version: egg.updated_at as string, pinned: true })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("使わない食材"),
    })
    const confirm = await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 })
    expect(confirm).toMatchObject({ failure: "rejected", error: expect.stringContaining("親子丼") })
    expect(db.rpcNames()).toEqual([])
    expect(entryById(egg.id)).toMatchObject({ recipe_id: "oyakodon", status: "proposed", pinned: false })
    expect(entryById(fine.id).status).toBe("proposed")

    // 対照: 除外に当たらない料理は固定できる
    expect(
      success(await setDinnerPin({ entryId: fine.id as string, version: fine.updated_at as string, pinned: true })).status,
    ).toBe("saved")
  })

  it("確定: 画面が見ていた版と違えば確定しない。全部が確定済みの再送は replayed", async () => {
    success(await generateDinnerPlan(generateRequest({ days: 2 })))
    const stale = success(await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 2 }))
    expect(stale).toMatchObject({ status: "conflict", detail: "stale_plan", revision: 1 })
    expect(db.entries().every((entry) => entry.status === "proposed")).toBe(true)

    const done = success(await confirmDinnerPlan({ expectedRevision: 1, startDate: TODAY, days: 2 }))
    expect(done).toMatchObject({ status: "saved", grocery: { ok: true } })
    expect(db.entries().every((entry) => entry.status === "confirmed")).toBe(true)
    // 確定した料理の材料が買い物へ入る（在庫が空なので買うものがある）
    expect(db.grocery().length).toBeGreaterThan(0)

    const rowsBefore = db.grocery().length
    const again = success(await confirmDinnerPlan({ expectedRevision: 1, startDate: TODAY, days: 2 }))
    expect(again.status).toBe("replayed")
    expect(db.grocery()).toHaveLength(rowsBefore)

    expect(await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: "2026-11-20", days: 2 })).toMatchObject({
      failure: "rejected",
    })
  })

  it("判定できないアレルギーの間は、献立を変えても買い物の自動の更新を止めたまま、その名前を理由に返す（「献立から更新を押して」とは言わない。リストは消さない）", async () => {
    success(await generateDinnerPlan(generateRequest({ days: 2 })))
    success(await confirmDinnerPlan({ expectedRevision: 1, startDate: TODAY, days: 2 }))
    const shape = () =>
      JSON.stringify(
        db.grocery().map((row) => [row.id, row.item_key, row.still_needed, row.required_quantity, row.purchased_quantity, row.sources]),
      )
    const listBefore = shape()
    expect(db.grocery().filter((row) => row.still_needed === true).length).toBeGreaterThan(0)

    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" }),
    )
    const tomorrow = db.entries().find((entry) => entry.plan_date !== TODAY)
    if (!tomorrow) throw new Error("tomorrow's entry not found")
    const result = success(await deleteDinnerEntry({ entryId: tomorrow.id as string, version: tomorrow.updated_at as string }))
    // 献立の変更そのものは成立する。買い物は止めた理由を返す
    expect(result).toMatchObject({ status: "saved", grocery: { ok: false, message: expect.stringContaining("「ぞぞぞ成分」") } })
    expect(result.grocery).not.toEqual({ ok: false, message: GROCERY_SYNC_FAILED_MESSAGE })
    // 修正前: 全料理が保留になって必要量 0 で同期し、未購入の自動行を消した
    expect(shape()).toBe(listBefore)
  })

  it("止めている間に「作った」にしても、残りは膨らまない（必要 200g・あと 200g）。「必要量まで購入」も 500g で、800g と記録しない", async () => {
    const tonight = entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", status: "confirmed", servings: 4 })
    db.tables.dinner_plan_entries.push(tonight, entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", status: "confirmed" }))
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({ status: "saved" })
    const pork = () => {
      const row = db.grocery().find((item) => item.item_key === "pork_komagire|mass")
      if (!row) throw new Error("pork row not found")
      return row
    }
    const view = () => {
      const parsed = groceryItemFromRow(pork())
      if (!parsed.ok) throw new Error("pork row is unreadable")
      return toShoppingItemView(parsed.value)
    }
    // 豚こま 500g（今夜の肉じゃが 300g + 金曜のカレー 200g）のうち 300g を買った
    expect(
      await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "amount", amount: 300 } }),
    ).toMatchObject({ status: "saved" })
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" }),
    )

    // 止めている間に今夜の肉じゃがを作った: 充当（300g）は RPC が記録するが、同期は走らず必要量は 500g のまま
    const cooked = success(await markDinnerCooked({ entryId: tonight.id as string, version: tonight.updated_at as string }))
    expect(cooked.grocery).toMatchObject({ ok: false, message: expect.stringContaining("「ぞぞぞ成分」") })
    expect(pork()).toMatchObject({ required_quantity: 500, purchased_quantity: 300, consumed_quantity: 300 })
    // 修正前: 必要 500 −（購入 300 − 使った 300）= あと 500g と出た（実際に要るのは金曜の 200g）
    expect(view()).toMatchObject({ requiredAmount: 200, purchasedAmount: 300, consumedAmount: 300, remainingAmount: 200, state: "to_buy" })

    // 「必要量まで購入」は、使った 300g の上に今の必要 200g を足した合計 500g（修正前は 500 + 300 = 800g）
    expect(
      await setGroceryPurchase({ id: pork().id as string, version: pork().updated_at as string, purchase: { kind: "full" } }),
    ).toMatchObject({ status: "saved" })
    expect(pork()).toMatchObject({ purchased_quantity: 500, purchased: true })
    expect(view()).toMatchObject({ remainingAmount: 0, state: "purchased" })

    // 選び直した後の同期でも、同じ数のまま（必要 200g・購入 500g・使った 300g）。二重に引かない
    db.tables.food_exclusions = []
    expect(await syncGroceryList({ operationId: OP2 })).toMatchObject({ status: "saved" })
    expect(pork()).toMatchObject({ required_quantity: 200, purchased_quantity: 500, consumed_quantity: 300 })
    expect(view()).toMatchObject({ requiredAmount: 200, remainingAmount: 0, state: "purchased" })
  })

  it("R43: 確定は全部か無しか。通信が途中で切れても一部だけ確定した状態を残さず、同じ操作のやり直しで確定できる", async () => {
    success(await generateDinnerPlan(generateRequest({ days: 3 })))
    expect(db.entries().length).toBeGreaterThanOrEqual(3)
    const request = { expectedRevision: 1, startDate: TODAY, days: 3 }
    const lost = { data: null, error: { code: "", message: "fetch failed" } }
    // 1 品ずつ書く実装なら 2 品目で、まとめて書く実装ならその 1 回で、通信が切れる
    let single = 0
    let batch = 0
    db.intercept("save_dinner_entry", () => ((single += 1) === 2 ? lost : undefined))
    db.intercept("confirm_dinner_entries", () => ((batch += 1) === 1 ? lost : undefined))

    expect(await confirmDinnerPlan(request)).toMatchObject({ failure: "unknown" })
    // 修正前: 1 品目だけ確定して版が進み、やり直しが「別の端末が先に更新」の conflict になった
    expect(db.entries().map((entry) => entry.status)).toEqual(db.entries().map(() => "proposed"))
    expect(db.revision()).toBe(1)
    expect(db.grocery()).toEqual([])

    const retried = success(await confirmDinnerPlan(request))
    expect(retried).toMatchObject({ status: "saved", revision: 2, grocery: { ok: true } })
    expect(db.entries().every((entry) => entry.status === "confirmed")).toBe(true)
    expect(db.grocery().length).toBeGreaterThan(0)
    // 版は 1 回だけ進む（1 品ごとには進まない）
    expect(db.revision()).toBe(2)
  })

  it("R43: 読んだ後に別の端末が 1 品でも変えていたら、1 品も確定しない（対照: 変わっていなければ全部確定する）", async () => {
    success(await generateDinnerPlan(generateRequest({ days: 2 })))
    const [first] = db.entries()
    // 読み込みの後・書込の前に、別の端末が 1 品を固定した（版が進む）
    db.intercept("confirm_dinner_entries", () => {
      first.updated_at = "2026-11-11T02:00:00.000001+00:00"
      return undefined
    })
    const result = success(await confirmDinnerPlan({ expectedRevision: 1, startDate: TODAY, days: 2 }))
    expect(result).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(db.entries().every((entry) => entry.status === "proposed")).toBe(true)

    db.intercept("confirm_dinner_entries", () => undefined)
    expect(success(await confirmDinnerPlan({ expectedRevision: 1, startDate: TODAY, days: 2 })).status).toBe("saved")
  })
})

describe("④ 一覧の料理 1 品を、既存の日の献立へ足す（addDinnerRecipe）", () => {
  const SIDE_ID = "f3000000-0000-4000-8000-0000000000a4"
  const addSide = (over: Record<string, unknown> = {}) => ({
    id: SIDE_ID,
    // 押した時点の献立の版（この describe では、押す直前に読んだ版）
    expectedRevision: db.revision(),
    date: FRIDAY,
    recipeId: "spinach_ohitashi",
    role: "side" as const,
    position: 1,
    servings: 2,
    status: "confirmed" as const,
    ...over,
  })
  /** 品目ごとの必要量と、その出所の枠。 */
  const groceryNeeds = () =>
    new Map(
      db.grocery().map((row) => [
        row.item_key as string,
        {
          required: row.required_quantity,
          entryIds: ((row.sources as Row[]) ?? []).map((source) => source.entryId),
        },
      ]),
    )

  /** 金曜に固定・確定したカレー（買い物の同期まで済ませた状態）。 */
  async function fridayCurry(status: "proposed" | "confirmed" = "confirmed") {
    const curry = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "curry_rice", pinned: true, status, origin: "manual" })
    db.tables.dinner_plan_entries.push(curry)
    if (status === "confirmed") success(await syncGroceryList({ operationId: OP2 }))
    return curry
  }

  it("受け入れ: 金曜の固定したカレーを残したまま副菜を足す。買い物には副菜の材料の差分だけが入り、再送で 2 品にならない", async () => {
    const curry = await fridayCurry()
    const curryBefore = { ...curry }
    const before = groceryNeeds()
    expect(before.size).toBeGreaterThan(0)

    const result = success(await addDinnerRecipe(addSide()))
    expect(result).toMatchObject({ status: "saved", grocery: { ok: true } })
    // カレーとその固定・状態・版は、そのまま（作り直し・差し替えをしていない）
    expect(entryById(curry.id)).toEqual(curryBefore)
    expect(entryById(SIDE_ID)).toMatchObject({
      plan_date: FRIDAY,
      role: "side",
      position: 1,
      recipe_id: "spinach_ohitashi",
      pinned: true,
      // 確定済みの日へ足した料理は確定（買い物に入る）
      status: "confirmed",
      origin: "manual",
    })
    // 献立の作り直し（apply_dinner_plan）は使っていない
    expect(db.rpcNames()).not.toContain("apply_dinner_plan")

    // 買い物: カレーの分の必要量は変わらず、増えたのは副菜の材料だけ
    const after = groceryNeeds()
    for (const [key, need] of before) {
      if (need.entryIds.every((id) => id === curry.id)) expect(after.get(key)?.required, key).toEqual(need.required)
    }
    const added = [...after.keys()].filter((key) => !before.has(key))
    expect(added.length).toBeGreaterThan(0)
    for (const key of added) expect(after.get(key)?.entryIds, key).toEqual([SIDE_ID])

    // 応答を失った再送（同じ ID・同じ内容）は replayed。副菜は 1 品のまま、買い物も変わらない
    const groceryPrint = JSON.stringify(db.grocery())
    const again = success(await addDinnerRecipe(addSide()))
    expect(again.status).toBe("replayed")
    expect(db.entries().filter((entry) => entry.recipe_id === "spinach_ohitashi")).toHaveLength(1)
    expect(JSON.stringify(db.grocery().map((row) => [row.item_key, row.required_quantity]))).toBe(
      JSON.stringify(JSON.parse(groceryPrint).map((row: Row) => [row.item_key, row.required_quantity])),
    )
    // 献立の画面の入口（saveDinnerRequest）からも同じ操作として受ける
    expect(success(await saveDinnerRequest({ op: "add_recipe", ...addSide() })).status).toBe("replayed")
  })

  it("提案の日へ足した料理は提案のまま（確定するまで買い物に入らない）。空の日にも足せる", async () => {
    await fridayCurry("proposed")
    success(await addDinnerRecipe(addSide({ status: "proposed" })))
    expect(entryById(SIDE_ID)).toMatchObject({ status: "proposed", pinned: true })
    expect(db.grocery()).toEqual([])

    const EMPTY_DAY_ID = "f3000000-0000-4000-8000-0000000000a5"
    success(
      await addDinnerRecipe({
        id: EMPTY_DAY_ID,
        expectedRevision: db.revision(),
        date: SATURDAY,
        recipeId: "salmon_shioyaki",
        role: "main",
        position: 0,
        servings: 3,
        status: "proposed",
      }),
    )
    expect(entryById(EMPTY_DAY_ID)).toMatchObject({ plan_date: SATURDAY, servings: 3, status: "proposed", pinned: true })
    expect(db.entries().filter((entry) => entry.plan_date === SATURDAY)).toHaveLength(1)
  })

  it("押した後に別の端末がその日を変えていたら、上書きも二重の追加もしない（枠が埋まった・状態が変わった・同じ料理が入った）", async () => {
    const curry = await fridayCurry()
    // 同じ枠（金曜・副菜・位置 1）に、別の端末が先に入れた
    const other = entryRow(HOUSE, { plan_date: FRIDAY, role: "side", position: 1, recipe_id: "tamagoyaki", status: "confirmed" })
    db.tables.dinner_plan_entries.push(other)
    const otherBefore = { ...other }
    const taken = success(await addDinnerRecipe(addSide()))
    expect(taken).toMatchObject({ status: "conflict", detail: "day_changed" })
    expect(taken.notices.join("")).toContain("上書きはしていません")
    expect(entryById(other.id)).toEqual(otherBefore)
    expect(db.entries().some((entry) => entry.id === SIDE_ID)).toBe(false)
    expect(db.rpcNames()).not.toContain("save_dinner_entry")

    // 状態が変わった（画面は「提案の日」と見て押したが、今は確定済み）
    const stale = success(await addDinnerRecipe(addSide({ position: 2, status: "proposed" })))
    expect(stale).toMatchObject({ status: "conflict", detail: "day_changed" })

    // 同じ料理が既に入った
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: FRIDAY, role: "side", position: 3, recipe_id: "spinach_ohitashi", status: "confirmed" }),
    )
    const already = success(await addDinnerRecipe(addSide({ position: 2 })))
    expect(already).toMatchObject({ status: "conflict", detail: "day_changed" })
    expect(already.notices.join("")).toContain("すでにこの日の献立に入っています")
    expect(db.entries().filter((entry) => entry.recipe_id === "spinach_ohitashi")).toHaveLength(1)
    expect(entryById(curry.id)).toMatchObject({ pinned: true, status: "confirmed", recipe_id: "curry_rice" })
  })

  it("読んだ後・書く前に枠が埋まった（DB の 23505）ときも上書きせず、読み直させる", async () => {
    await fridayCurry()
    db.intercept("save_dinner_entry", () => {
      db.tables.dinner_plan_entries.push(
        entryRow(HOUSE, { plan_date: FRIDAY, role: "side", position: 1, recipe_id: "tamagoyaki", status: "confirmed" }),
      )
      return undefined
    })
    const result = success(await addDinnerRecipe(addSide()))
    expect(result).toMatchObject({ status: "conflict", detail: "day_changed" })
    expect(db.entries().some((entry) => entry.id === SIDE_ID)).toBe(false)
    expect(revalidatePath).toHaveBeenCalled()
  })

  it("再送は今の日と照らさずに送る: 先の追加が成立していれば、その後に日が変わっていても replayed（「入らなかった」と言わない）", async () => {
    const curry = await fridayCurry()
    success(await addDinnerRecipe(addSide()))
    // 先の追加の後に、別の端末がカレーを外した（その日の状態・空きが変わった）
    db.tables.dinner_plan_entries = db.tables.dinner_plan_entries.filter((entry) => entry.id !== curry.id)
    const again = success(await addDinnerRecipe(addSide()))
    expect(again.status).toBe("replayed")
    expect(db.entries().filter((entry) => entry.id === SIDE_ID)).toHaveLength(1)
    // 対照: 足した料理そのものを別の端末が変えていたら、上書きせず conflict
    entryById(SIDE_ID).servings = 4
    entryById(SIDE_ID).updated_at = "2026-11-11T05:00:00.000001+00:00"
    expect(success(await addDinnerRecipe(addSide()))).toMatchObject({ status: "conflict" })
    expect(entryById(SIDE_ID).servings).toBe(4)
  })

  it("使わない食材に当たる料理・原材料を確かめられない料理は足さない（足す料理も除外で判定する）", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    await fridayCurry("proposed")
    expect(
      await addDinnerRecipe(addSide({ recipeId: "tamagoyaki", status: "proposed" })),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("使わない食材") })
    // カレールウ（商品で原材料が変わる）を使う料理は、アレルギーの世帯では未確認
    expect(
      await addDinnerRecipe(addSide({ recipeId: "curry_rice", role: "main", position: 2, status: "proposed", date: SATURDAY })),
    ).toMatchObject({ failure: "rejected", error: expect.stringContaining("原材料") })
    expect(db.rpcNames()).not.toContain("save_dinner_entry")
    // 対照: 当たらない料理は足せる
    expect(success(await addDinnerRecipe(addSide({ status: "proposed" }))).status).toBe("saved")
  })

  it("過ぎた日・区分の食い違い・世帯 ID の紛れ込みは拒む", async () => {
    expect(await addDinnerRecipe(addSide({ date: "2026-11-10" }))).toMatchObject({ failure: "rejected" })
    expect(await addDinnerRecipe(addSide({ role: "main" }))).toMatchObject({ failure: "rejected" })
    expect(await addDinnerRecipe({ ...addSide(), householdId: OTHER_HOUSE } as never)).toMatchObject({ failure: "rejected" })
    expect(await addDinnerRecipe(addSide({ position: 10 }))).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames()).toEqual([])
  })
})

describe("⑤ 手動料理と使わない食材（問題なし / 当たる / 未確認）", () => {
  const potatoSalad = (over: Record<string, unknown> = {}) => ({
    id: NEW_ID,
    version: null,
    date: FRIDAY,
    role: "side" as const,
    title: "ポテトサラダ",
    ingredients: [
      { name: "じゃがいも", amount: 2, unit: "piece" as const },
      { name: "マヨネーズ", amount: 2, unit: "tbsp" as const },
    ],
    ...over,
  })

  it("材料にマヨネーズ（卵を含む）を入れると、料理名に「卵」が無くても警告する。下書きは残し、確定には混ぜない", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const fine = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "spinach_ohitashi", position: 1, role: "side" })
    db.tables.dinner_plan_entries.push(fine)

    const saved = success(await saveCustomDish(potatoSalad()))
    expect(saved.status).toBe("saved")
    expect(saved.exclusionWarning).toMatchObject({ verdict: "blocked", message: expect.stringContaining("マヨネーズ") })
    const text = saved.notices.join("")
    expect(text).toContain("使わない食材の設定に当たります")
    expect(text).toContain("マヨネーズ")
    expect(text).toContain("確定できません")
    expect(entryById(NEW_ID)).toMatchObject({ status: "proposed", custom_title: "ポテトサラダ", pinned: true })

    const confirm = await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 })
    expect(confirm).toMatchObject({ failure: "rejected", error: expect.stringContaining("ポテトサラダ") })
    expect(db.rpcNames()).not.toContain("confirm_dinner_entries")
    expect(entryById(NEW_ID).status).toBe("proposed")
    expect(entryById(fine.id).status).toBe("proposed")
  })

  it("材料が未登録の手動料理は「未確認」: 保存はできるが確定は止める（苦手だけの世帯でも）。材料を登録すれば確定できる", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { reason: "dislike", target_kind: "ingredient", target_id: "pork" }))
    const saved = success(
      await saveCustomDish({ id: NEW_ID, version: null, date: FRIDAY, role: "main", title: "おでん", ingredients: null }),
    )
    expect(saved.status).toBe("saved")
    expect(saved.exclusionWarning).toMatchObject({ verdict: "label_check" })
    expect(saved.notices.join("")).toContain("確かめられません")

    const confirm = await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 })
    expect(confirm).toMatchObject({ failure: "rejected", error: expect.stringContaining("おでん") })
    expect(confirm).toMatchObject({ error: expect.stringContaining("原材料を確かめられない") })
    expect(entryById(NEW_ID).status).toBe("proposed")
    expect(db.rpcNames()).not.toContain("confirm_dinner_entries")

    // 材料を登録すれば確かめられる（当たらない材料）→ 警告は消え、確定できる
    const current = entryById(NEW_ID)
    const edited = success(
      await saveCustomDish({
        id: NEW_ID,
        version: current.updated_at as string,
        date: FRIDAY,
        role: "main",
        title: "おでん",
        ingredients: [{ name: "だいこん", amount: 1, unit: "piece" }],
      }),
    )
    expect(edited).toMatchObject({ status: "saved", notices: [] })
    expect(edited.exclusionWarning).toBeUndefined()
    const done = success(await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 }))
    expect(done.status).toBe("saved")
    expect(entryById(NEW_ID).status).toBe("confirmed")
  })

  it("対照: 除外が 1 件も無ければ、材料なしの手動料理も確定できる（確かめる除外が無い）", async () => {
    success(await saveCustomDish({ id: NEW_ID, version: null, date: FRIDAY, role: "main", title: "おでん", ingredients: null }))
    const done = success(await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 }))
    expect(done.status).toBe("saved")
    expect(entryById(NEW_ID).status).toBe("confirmed")
  })

  it("固定した料理も、除外を足した後の確定で検証し直す（固定でも確定に混ぜない）", async () => {
    const pinned = entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "oyakodon", pinned: true })
    db.tables.dinner_plan_entries.push(pinned)
    // 除外を足す前は確定できる状態（対照）: 確定の手前の検査だけを見るため、除外を足してから確定する
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const confirm = await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 })
    expect(confirm).toMatchObject({ failure: "rejected", error: expect.stringContaining("親子丼") })
    expect(entryById(pinned.id)).toMatchObject({ status: "proposed", pinned: true, recipe_id: "oyakodon" })
  })
})

describe("作った・作らなかった・料理後の食材（C-37）", () => {
  it("未来の日は「作った」にできない。今日の料理は作ったにでき、在庫は自動では減らない", async () => {
    const future = entryRow(HOUSE, { plan_date: FRIDAY, status: "confirmed" })
    const tonight = entryRow(HOUSE, { plan_date: TODAY, status: "confirmed", recipe_id: "ginger_pork" })
    const pork = pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 300, unit: "g" })
    db.tables.dinner_plan_entries.push(future, tonight)
    db.tables.pantry_items.push(pork)
    const pantryBefore = JSON.stringify(db.tables.pantry_items)

    expect(await markDinnerCooked({ entryId: future.id as string, version: future.updated_at as string })).toMatchObject({
      failure: "rejected",
      error: expect.stringContaining("未来"),
    })
    expect(entryById(future.id).status).toBe("confirmed")

    const done = success(await markDinnerCooked({ entryId: tonight.id as string, version: tonight.updated_at as string }))
    expect(done.status).toBe("saved")
    expect(entryById(tonight.id).status).toBe("cooked")
    expect(JSON.stringify(db.tables.pantry_items)).toBe(pantryBefore)
    expect(db.rpcNames()).not.toContain("save_pantry_item")

    // 取り消して確定へ戻せる
    const current = entryById(tonight.id)
    success(await restoreDinnerEntry({ entryId: current.id as string, version: current.updated_at as string }))
    expect(entryById(tonight.id).status).toBe("confirmed")
  })

  it("料理後の食材は、利用者が選んだものだけを更新する（再送で二重にならない）", async () => {
    const pork = pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 300, unit: "g", use_soon: true })
    const onion = pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ", quantity: 3, unit: "piece" })
    db.tables.pantry_items.push(pork, onion)
    const onionBefore = JSON.stringify(onion)
    const request = { updates: [{ id: pork.id as string, version: pork.updated_at as string, status: "out" as const }] }

    const result = success(await applyCookedPantryUpdates(request))
    expect(result.status).toBe("saved")
    expect(pork).toMatchObject({ status: "out", use_soon: false, confirmed_on: TODAY, quantity: 300 })
    expect(JSON.stringify(onion)).toBe(onionBefore)

    const versionAfter = pork.updated_at
    expect(success(await applyCookedPantryUpdates(request)).status).toBe("replayed")
    expect(pork.updated_at).toBe(versionAfter)

    // 別の端末が消した食材は、作り直さずに知らせる
    const gone = success(
      await applyCookedPantryUpdates({ updates: [{ id: NEW_ID, version: "2026-11-10T00:00:00+00:00", status: "low" }] }),
    )
    expect(gone).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(db.tables.pantry_items).toHaveLength(2)
  })

  it("「作らなかった」は記録だけ（食後評価を作らない）", async () => {
    const entry = entryRow(HOUSE, { plan_date: TODAY, status: "confirmed" })
    db.tables.dinner_plan_entries.push(entry)
    success(await markDinnerSkipped({ entryId: entry.id as string, version: entry.updated_at as string }))
    expect(entryById(entry.id).status).toBe("skipped")
    expect(db.tables.dish_feedback).toEqual([])
  })
})

describe("手動料理（saveCustomDish）と削除", () => {
  it("材料なしで足せる。固定・手動として保存し、買い物の自動計算に入らないと知らせる", async () => {
    const result = success(
      await saveCustomDish({ id: NEW_ID, version: null, date: FRIDAY, role: "main", title: " おでん ", ingredients: null }),
    )
    expect(result.status).toBe("saved")
    expect(result.notices.join("")).toContain("買い物の自動計算に入りません")
    expect(entryById(NEW_ID)).toMatchObject({
      custom_title: "おでん",
      custom_ingredients: null,
      recipe_id: null,
      pinned: true,
      status: "proposed",
      origin: "manual",
      servings: 2,
    })

    // 手で入れた料理は、作り直しで消えない
    success(await generateDinnerPlan(generateRequest({ expectedRevision: db.revision() })))
    expect(entryById(NEW_ID)).toMatchObject({ custom_title: "おでん", pinned: true })

    // 同じ内容の再送は replayed（2 品にならない）
    const again = success(
      await saveCustomDish({ id: NEW_ID, version: null, date: FRIDAY, role: "main", title: "おでん", ingredients: null }),
    )
    expect(again.status).toBe("replayed")
    expect(db.entries().filter((entry) => entry.custom_title === "おでん")).toHaveLength(1)
  })

  it("材料は辞書へ解決して保存する。解決できない名前は黙って捨てずに拒否する", async () => {
    const rejected = await saveCustomDish({
      id: NEW_ID,
      version: null,
      date: FRIDAY,
      role: "main",
      title: "おでん",
      ingredients: [
        { name: "じゃがいも", amount: 2, unit: "piece" },
        { name: "なぞの練り物", amount: 1, unit: "pack" },
      ],
    })
    expect(rejected).toMatchObject({ failure: "rejected", error: expect.stringContaining("なぞの練り物") })
    expect(db.entries()).toEqual([])

    const saved = success(
      await saveCustomDish({
        id: NEW_ID,
        version: null,
        date: FRIDAY,
        role: "main",
        title: "おでん",
        ingredients: [
          { name: "じゃがいも", amount: 2, unit: "piece" },
          { ingredientId: "soy_sauce", amount: null, unit: "to_taste" },
        ],
      }),
    )
    expect(saved).toMatchObject({ status: "saved", notices: [] })
    expect(entryById(NEW_ID).custom_ingredients).toEqual([
      { ingredientId: "potato", quantity: { amount: 2, unit: "piece" } },
      { ingredientId: "soy_sauce", quantity: { amount: null, unit: "to_taste" } },
    ])
  })

  it("削除は版つき。古い版では消さない", async () => {
    const entry = entryRow(HOUSE, { plan_date: FRIDAY })
    db.tables.dinner_plan_entries.push(entry)
    const stale = success(await deleteDinnerEntry({ entryId: entry.id as string, version: "2026-11-01T00:00:00+00:00" }))
    expect(stale).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(db.entries()).toHaveLength(1)
    expect(success(await deleteDinnerEntry({ entryId: entry.id as string, version: entry.updated_at as string })).status).toBe(
      "saved",
    )
    expect(db.entries()).toEqual([])
  })
})

describe("食後評価（saveDishFeedback）", () => {
  const feedback = (over: Record<string, unknown> = {}) => ({
    id: NEW_ID,
    version: null,
    recipeId: "nikujaga",
    dishTitle: "肉じゃが",
    eatenOn: TODAY,
    taste: 3 as const,
    effort: 1 as const,
    again: true,
    excludeFromLearning: false,
    ...over,
  })

  it("本人・料理・日付で記録し、味と手間を分けて保存する", async () => {
    const result = success(await saveDishFeedback(feedback()))
    expect(result.status).toBe("saved")
    expect(db.tables.dish_feedback).toEqual([
      expect.objectContaining({
        profile_id: USER,
        recipe_id: "nikujaga",
        eaten_on: TODAY,
        taste: 3,
        effort: 1,
        again: true,
        exclude_from_learning: false,
      }),
    ])
    // 本人の ID は送らない（DB が呼び手に固定する）
    const args = db.calls.rpc.find(([name]) => name === "save_dish_feedback")?.[1] ?? {}
    expect(Object.keys(args).some((key) => key.includes("profile"))).toBe(false)
  })

  it("これから食べる日・カタログに無い料理 ID は拒否する", async () => {
    expect(await saveDishFeedback(feedback({ eatenOn: "2026-11-12" }))).toMatchObject({ failure: "rejected" })
    expect(await saveDishFeedback(feedback({ recipeId: "no_such_dish" }))).toMatchObject({ failure: "rejected" })
    expect(db.rpcNames()).toEqual([])
  })

  it("同じ料理・同じ日の評価が別の ID で既に在れば、2 件にせず知らせる", async () => {
    success(await saveDishFeedback(feedback()))
    const twin = success(await saveDishFeedback(feedback({ id: OP2, taste: 1 })))
    expect(twin).toMatchObject({ status: "conflict" })
    expect(twin.notices.join("")).toContain("既に記録されています")
    expect(db.tables.dish_feedback).toHaveLength(1)
    expect(db.tables.dish_feedback[0].taste).toBe(3)
  })
})

describe("結果不明の扱い", () => {
  it("RPC の戻り値を読めないときは、成功とも失敗とも言わない（unknown）", async () => {
    db.intercept("apply_dinner_plan", () => ({ data: { ok: true }, error: null }))
    expect(await generateDinnerPlan(generateRequest())).toMatchObject({ failure: "unknown" })
  })

  it("通信の失敗（code なし）は unknown、DB の拒否（SQLSTATE）は rejected", async () => {
    db.intercept("apply_dinner_plan", () => ({ data: null, error: { code: "", message: "fetch failed" } }))
    expect(await generateDinnerPlan(generateRequest())).toMatchObject({ failure: "unknown" })
    db.intercept("apply_dinner_plan", () => ({ data: null, error: { code: "42501", message: "not allowed" } }))
    expect(await generateDinnerPlan(generateRequest())).toMatchObject({ failure: "rejected" })
    db.intercept("apply_dinner_plan", () => ({ data: null, error: { code: "23505", message: "operation id conflict" } }))
    expect(await generateDinnerPlan(generateRequest())).toMatchObject({ failure: "conflict" })
  })

  it("例外は結果不明として返す（拒否と言い換えない）", async () => {
    db.intercept("apply_dinner_plan", () => {
      throw new Error("socket hang up")
    })
    expect(await generateDinnerPlan(generateRequest())).toMatchObject({ failure: "unknown" })
  })
})

/**
 * R45: 人数は枠の作成時に写してある。設定の人数を変えても既存の枠は変わらないので、
 * 枠ごとに直す操作（`servings`）と、これからの未調理の枠へまとめて反映する操作（`servings_upcoming`）を持つ。
 * 肉じゃが（2 人分）は豚こま切れ肉 150g。
 */
describe("R45 人数の変更を既存の献立へ反映する", () => {
  const porkRequired = () => db.grocery().find((item) => item.item_key === "pork_komagire|mass")?.required_quantity

  it("1 枠の人数を変えると、固定・料理・状態はそのままで、買い物の必要量が新しい人数になる", async () => {
    const pinned = entryRow(HOUSE, { plan_date: FRIDAY, status: "confirmed", pinned: true })
    db.tables.dinner_plan_entries.push(pinned)
    success(await setDinnerEntryServings({ entryId: pinned.id as string, version: pinned.updated_at as string, servings: 2 }))
    expect(porkRequired()).toBe(150)

    const result = success(
      await setDinnerEntryServings({ entryId: pinned.id as string, version: entryById(pinned.id).updated_at as string, servings: 4 }),
    )
    expect(result).toMatchObject({ status: "saved", grocery: { ok: true }, notices: [] })
    expect(entryById(pinned.id)).toMatchObject({ servings: 4, pinned: true, status: "confirmed", recipe_id: "nikujaga" })
    // 元のレシピ量から一度だけ計算する（150g × 4/2）
    expect(porkRequired()).toBe(300)

    // 1 つの入口からも送れる。古い版では書かない
    const stale = success(
      await saveDinnerRequest({ op: "servings", entryId: pinned.id as string, version: "2026-11-10T00:00:00.123456+00:00", servings: 6 }),
    )
    expect(stale).toMatchObject({ status: "conflict", detail: "row_changed" })
    expect(entryById(pinned.id).servings).toBe(4)
  })

  it("作った料理の人数は変えない。範囲外の人数・余分な項目は拒否する", async () => {
    const cooked = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    db.tables.dinner_plan_entries.push(cooked)
    const ref = { entryId: cooked.id as string, version: cooked.updated_at as string }
    expect(await setDinnerEntryServings({ ...ref, servings: 4 })).toMatchObject({ failure: "rejected" })
    expect(entryById(cooked.id).servings).toBe(2)
    for (const servings of [0, 13, 2.5, "4"]) {
      expect(await setDinnerEntryServings({ ...ref, servings: servings as never })).toMatchObject({ failure: "rejected" })
    }
    expect(await setDinnerEntryServings({ ...ref, servings: 4, householdId: OTHER_HOUSE } as never)).toMatchObject({
      failure: "rejected",
    })
    expect(await applyServingsToUpcomingDinners({ servings: 4, householdId: OTHER_HOUSE } as never)).toMatchObject({
      failure: "rejected",
    })
    expect(db.rpcNames()).toEqual([])
  })

  it("手動料理は人数を変えても材料の量を書き換えず、その旨を知らせる", async () => {
    const custom = entryRow(HOUSE, {
      plan_date: FRIDAY,
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      custom_ingredients: [{ ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" } }],
      origin: "manual",
      status: "confirmed",
    })
    db.tables.dinner_plan_entries.push(custom)
    const result = success(
      await setDinnerEntryServings({ entryId: custom.id as string, version: custom.updated_at as string, servings: 4 }),
    )
    expect(result.notices.join("")).toContain("材料の量は、人数を変えても変わりません")
    expect(entryById(custom.id)).toMatchObject({
      servings: 4,
      custom_ingredients: [{ ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" } }],
    })
  })

  it("まとめて反映: これからの未調理の枠だけを変える（作った・作らなかった・過ぎた日・同じ人数の枠には触れない）", async () => {
    const pinned = entryRow(HOUSE, { plan_date: FRIDAY, status: "confirmed", pinned: true })
    const proposed = entryRow(HOUSE, { plan_date: SATURDAY })
    const already = entryRow(HOUSE, { plan_date: SATURDAY, role: "side", position: 1, recipe_id: "spinach_ohitashi", servings: 4 })
    const cooked = entryRow(HOUSE, { plan_date: TODAY, status: "cooked" })
    const skipped = entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "spinach_ohitashi", status: "skipped" })
    const past = entryRow(HOUSE, { plan_date: "2026-11-10", status: "confirmed" })
    db.tables.dinner_plan_entries.push(pinned, proposed, already, cooked, skipped, past)
    const untouched = JSON.stringify([already, cooked, skipped, past])

    const result = success(await applyServingsToUpcomingDinners({ servings: 4 }))
    expect(result).toMatchObject({ status: "saved", changedEntries: 2, grocery: { ok: true } })
    expect(result.notices[0]).toBe("これからの献立2品を4人分にしました。")
    expect(entryById(pinned.id)).toMatchObject({ servings: 4, pinned: true, status: "confirmed" })
    expect(entryById(proposed.id)).toMatchObject({ servings: 4, status: "proposed" })
    expect(JSON.stringify([already, cooked, skipped, past])).toBe(untouched)
    // 確定した枠（固定の肉じゃが）の買い物が 4 人分になる
    expect(porkRequired()).toBe(300)

    // 送り直しても、もう書かない（replayed）
    const names = db.rpcNames().length
    const again = success(await saveDinnerRequest({ op: "servings_upcoming", servings: 4 }))
    expect(again).toMatchObject({ status: "replayed", changedEntries: 0, grocery: null })
    expect(db.rpcNames()).toHaveLength(names)
  })

  it("まとめて反映が途中で止まっても、変えた分の買い物は同期し、送り直すと残りだけが続きから変わる", async () => {
    const first = entryRow(HOUSE, { plan_date: FRIDAY, status: "confirmed" })
    const second = entryRow(HOUSE, { plan_date: SATURDAY, status: "confirmed" })
    db.tables.dinner_plan_entries.push(first, second)
    let writes = 0
    db.intercept("save_dinner_entry", () =>
      (writes += 1) === 2 ? { data: null, error: { code: "", message: "fetch failed" } } : undefined,
    )
    const stopped = await applyServingsToUpcomingDinners({ servings: 4 })
    expect(stopped).toMatchObject({ failure: "unknown" })
    expect((stopped as { error: string }).error).toContain("1品は4人分に変更済みです")
    expect([entryById(first.id).servings, entryById(second.id).servings]).toEqual([4, 2])
    // 変えた 1 品ぶんは買い物へ反映済み（300g + 150g）
    expect(porkRequired()).toBe(450)

    const resumed = success(await applyServingsToUpcomingDinners({ servings: 4 }))
    expect(resumed).toMatchObject({ status: "saved", changedEntries: 1 })
    expect([entryById(first.id).servings, entryById(second.id).servings]).toEqual([4, 4])
    expect(porkRequired()).toBe(600)
  })

  it("まとめて反映: 別の端末が先に変えた料理は上書きせず、そこで止めて知らせる", async () => {
    const first = entryRow(HOUSE, { plan_date: FRIDAY, status: "confirmed" })
    const second = entryRow(HOUSE, { plan_date: SATURDAY, status: "confirmed" })
    db.tables.dinner_plan_entries.push(first, second)
    let writes = 0
    db.intercept("save_dinner_entry", () => {
      // 2 品目を書く直前に、別の端末がその料理を替えた
      if ((writes += 1) === 2) Object.assign(second, { recipe_id: "curry_rice", updated_at: "2026-11-11T02:00:00.000009+00:00" })
      return undefined
    })
    const result = success(await applyServingsToUpcomingDinners({ servings: 4 }))
    expect(result).toMatchObject({ status: "conflict", detail: "row_changed", changedEntries: 1, grocery: { ok: true } })
    expect(entryById(second.id)).toMatchObject({ recipe_id: "curry_rice", servings: 2 })
  })
})

/**
 * R03: 購入の記録は「これから作る料理の必要量」に対するもの。作った後・日が過ぎた後・翌週の必要量を
 * 相殺し続けない（C-41）。献立の変更では購入の記録を消さず（C-45）、同じ週の増量は差だけが残る（C-46）。
 * 肉じゃが（2 人分）は豚こま切れ肉 150g。
 */
describe("R03 購入の記録と、作った・日が過ぎた料理", () => {
  const PORK = "pork_komagire|mass"
  const NEXT_WEDNESDAY = "2026-11-18"
  const NEXT_FRIDAY = "2026-11-20"

  function pork() {
    const row = db.grocery().find((item) => item.item_key === PORK)
    if (!row) return null
    const mapped = groceryItemFromRow(row)
    if (!mapped.ok) throw new Error("grocery row could not be read")
    return { row, view: toShoppingItemView(mapped.value) }
  }
  function porkOrThrow() {
    const found = pork()
    if (!found) throw new Error("pork is not on the list")
    return found
  }
  async function buyPork(purchase: { kind: "full" } | { kind: "amount"; amount: number }) {
    const { row } = porkOrThrow()
    const result = await setGroceryPurchase({ id: row.id as string, version: row.updated_at as string, purchase })
    expect(result).toMatchObject({ status: "saved" })
  }
  const ref = (id: unknown) => {
    const row = entryById(id)
    return { entryId: row.id as string, version: row.updated_at as string }
  }
  /** 今日と金曜に肉じゃがを確定する（豚 150g + 150g）。 */
  async function confirmTwoDishes() {
    const tonight = entryRow(HOUSE, { plan_date: TODAY })
    const friday = entryRow(HOUSE, { plan_date: FRIDAY })
    db.tables.dinner_plan_entries.push(tonight, friday)
    success(await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 }))
    expect(porkOrThrow().view).toMatchObject({ requiredAmount: 300, remainingAmount: 300, state: "to_buy" })
    return { tonight, friday }
  }

  it("今日ぶんだけ買って作った → 金曜ぶんの 150g は未購入のまま出る（作る前は残り 150g）", async () => {
    const { tonight } = await confirmTwoDishes()
    await buyPork({ kind: "amount", amount: 150 })
    // C-46 と同じ式: 300g 必要・150g 購入 → 残り 150g
    expect(porkOrThrow().view).toMatchObject({ purchasedAmount: 150, remainingAmount: 150, state: "to_buy" })

    success(await markDinnerCooked(ref(tonight.id)))
    // 修正前: 必要量 150g − 購入 150g = 0 で「購入済み」へ回り、金曜ぶんが買い物リストから消えた
    // 購入の事実（150g）は書き換えず、今日の料理に使った分として数える
    expect(porkOrThrow().view).toMatchObject({
      requiredAmount: 150,
      purchasedAmount: 150,
      consumedAmount: 150,
      remainingAmount: 150,
      state: "to_buy",
    })
  })

  it("全量を買って今日ぶんを作った → 金曜ぶんの購入は残る。同期を何度流しても変わらない", async () => {
    const { tonight } = await confirmTwoDishes()
    await buyPork({ kind: "full" })
    success(await markDinnerCooked(ref(tonight.id)))
    expect(porkOrThrow().view).toMatchObject({
      requiredAmount: 150,
      purchasedAmount: 300,
      consumedAmount: 150,
      remainingAmount: 0,
      state: "purchased",
    })

    const before = JSON.stringify(db.grocery())
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({ status: "saved" })
    expect(await syncGroceryList({ operationId: OP2 })).toMatchObject({ status: "saved" })
    expect(await syncGroceryList({ operationId: OP2 })).toMatchObject({ status: "replayed" })
    expect(JSON.stringify(db.grocery())).toBe(before)
  })

  it("今週ぶんを買って作った → 翌週また 150g 必要 → 未購入 150g と出る", async () => {
    const { tonight, friday } = await confirmTwoDishes()
    await buyPork({ kind: "full" })
    success(await markDinnerCooked(ref(tonight.id)))
    // 金曜の料理は「作った」を押さないまま、日が過ぎる
    vi.setSystemTime(new Date("2026-11-18T03:00:00.000Z"))
    db.setToday(NEXT_WEDNESDAY)
    expect(entryById(friday.id).status).toBe("confirmed")

    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: NEXT_FRIDAY }))
    success(await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: NEXT_WEDNESDAY, days: 7 }))
    // 今週の購入 300g は事実として残り、今週の 2 品に使った分として数える（翌週ぶんには充てない）
    expect(porkOrThrow().view).toMatchObject({
      requiredAmount: 150,
      purchasedAmount: 300,
      consumedAmount: 300,
      remainingAmount: 150,
      state: "to_buy",
    })
    expect(porkOrThrow().view.sources.map((source) => source.date)).toEqual([NEXT_FRIDAY])
  })

  it("対照（C-45）: 「作らなかった」・削除で外れた料理は購入を使わない。戻せば購入は生きている", async () => {
    const { tonight, friday } = await confirmTwoDishes()
    await buyPork({ kind: "full" })

    success(await markDinnerSkipped(ref(friday.id)))
    expect(porkOrThrow().view).toMatchObject({ requiredAmount: 150, purchasedAmount: 300, state: "purchased" })
    success(await deleteDinnerEntry(ref(tonight.id)))
    // 献立からは不要になったが、購入の記録は残る
    expect(porkOrThrow().view).toMatchObject({ purchasedAmount: 300, state: "not_needed", sources: [] })

    success(await restoreDinnerEntry(ref(friday.id)))
    expect(porkOrThrow().view).toMatchObject({ requiredAmount: 150, purchasedAmount: 300, remainingAmount: 0, state: "purchased" })
  })

  it("対照: 在庫でまかなった料理を作っても、購入の記録は減らない", async () => {
    // 今日ぶん（150g）は在庫でまかなえる。買うのは金曜ぶんの 150g だけ
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "pork_komagire", name: "豚こま", quantity: 150, unit: "g" }))
    const tonight = entryRow(HOUSE, { plan_date: TODAY })
    db.tables.dinner_plan_entries.push(tonight, entryRow(HOUSE, { plan_date: FRIDAY }))
    success(await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 }))
    expect(porkOrThrow().view).toMatchObject({ requiredAmount: 150, remainingAmount: 150 })
    await buyPork({ kind: "full" })

    success(await markDinnerCooked(ref(tonight.id)))
    // 在庫は自動では減らない（C-37）ので、必要量は金曜ぶんを在庫が覆う形に変わる。購入の 150g は使われていない
    expect(porkOrThrow().row).toMatchObject({ purchased_quantity: 150 })
  })
})

/**
 * 購入の事実と、作った料理への充当（作った → 取り消し）。
 * 「作った」で購入の事実（`purchased_quantity` / `purchased` / 時刻）を書き換えない。取り消しは、その料理が
 * 使った分だけを戻す（後から家族が足した購入を、過去の断面で消さない）。在庫は変えない。
 * 手動料理「豚の炒め物」（2 人分）= 豚こま切れ肉 500g・塩 少々。
 */
describe("作った → 取り消しと買い物の数量（購入の事実は書き換えない）", () => {
  const PORK = "pork_komagire|mass"
  const SALT = "salt|none"
  const FACTS = ["purchased_quantity", "purchased", "purchased_at", "required_quantity", "still_needed"] as const

  function groceryRowOf(key: string): Row {
    const row = db.grocery().find((item) => item.item_key === key)
    if (!row) throw new Error(`${key} is not on the list`)
    return row
  }
  function viewOf(key: string) {
    const mapped = groceryItemFromRow(groceryRowOf(key))
    if (!mapped.ok) throw new Error("grocery row could not be read")
    return toShoppingItemView(mapped.value)
  }
  const factsOf = (key: string) => {
    const row = groceryRowOf(key)
    return Object.fromEntries(FACTS.map((column) => [column, row[column]]))
  }
  const ref = (id: unknown) => {
    const row = entryById(id)
    return { entryId: row.id as string, version: row.updated_at as string }
  }
  async function buy(key: string, purchase: { kind: "amount"; amount: number } | { kind: "check"; checked: boolean }) {
    const row = groceryRowOf(key)
    const result = await setGroceryPurchase({ id: row.id as string, version: row.updated_at as string, purchase })
    expect(result).toMatchObject({ status: "saved" })
  }
  /** 今日の「豚の炒め物」を確定する（買い物: 豚 500g・塩 少々）。 */
  async function confirmStirFry() {
    const dish = entryRow(HOUSE, {
      plan_date: TODAY,
      recipe_id: null,
      recipe_version: null,
      custom_title: "豚の炒め物",
      custom_ingredients: [
        { ingredientId: "pork_komagire", quantity: { amount: 500, unit: "g" } },
        { ingredientId: "salt", quantity: { amount: null, unit: "pinch" } },
      ],
      pinned: true,
      origin: "manual",
    })
    db.tables.dinner_plan_entries.push(dish)
    success(await confirmDinnerPlan({ expectedRevision: 0, startDate: TODAY, days: 7 }))
    expect(viewOf(PORK)).toMatchObject({ requiredAmount: 500, remainingAmount: 500, state: "to_buy" })
    return dish
  }

  it("提案のまま「作った」にした料理は、取り消すと提案へ戻り、買い物へ入らない。二重の取り消しは replayed", async () => {
    const proposed = entryRow(HOUSE, { plan_date: TODAY, status: "proposed" })
    db.tables.dinner_plan_entries.push(proposed)
    success(await markDinnerCooked(ref(proposed.id)))
    expect(entryById(proposed.id).status).toBe("cooked")

    const undo = ref(proposed.id)
    success(await restoreDinnerEntry(undo))
    // 修正前: 常に「確定」へ戻し、提案だった料理が買い物へ入った
    expect(entryById(proposed.id).status).toBe("proposed")
    expect(db.grocery()).toEqual([])

    // 応答を失った取り消しの再送（同じ版）は、もう一度変えない
    const settled = JSON.stringify(db.tables.dinner_plan_entries)
    expect(success(await restoreDinnerEntry(undo)).status).toBe("replayed")
    expect(JSON.stringify(db.tables.dinner_plan_entries)).toBe(settled)
    expect(db.grocery()).toEqual([])
  })

  it("受け入れ 1: 一部を買ってから作った → 取り消すと、購入の事実・不足・状態が元どおり（在庫は変えない）", async () => {
    const dish = await confirmStirFry()
    await buy(PORK, { kind: "amount", amount: 300 })
    expect(viewOf(PORK)).toMatchObject({ purchasedAmount: 300, remainingAmount: 200, state: "to_buy" })
    const before = { facts: factsOf(PORK), view: viewOf(PORK) }
    const pantryBefore = JSON.stringify(db.tables.pantry_items)

    success(await markDinnerCooked(ref(dish.id)))
    // 購入の事実は「作った」でも書き換えない（修正前: 300 → 0 に減らし、行ごと消していた）
    expect(groceryRowOf(PORK)).toMatchObject({ purchased_quantity: 300 })

    success(await restoreDinnerEntry(ref(dish.id)))
    expect(entryById(dish.id).status).toBe("confirmed")
    expect(factsOf(PORK)).toEqual(before.facts)
    expect(viewOf(PORK)).toMatchObject({
      purchasedAmount: before.view.purchasedAmount,
      remainingAmount: before.view.remainingAmount,
      state: before.view.state,
    })
    expect(JSON.stringify(db.tables.pantry_items)).toBe(pantryBefore)
  })

  it("受け入れ 2: 作った後に別の端末が 100g を買い足しても、取り消しで消えず、500g に対する不足は 100g", async () => {
    const dish = await confirmStirFry()
    await buy(PORK, { kind: "amount", amount: 300 })
    expect(viewOf(PORK)).toMatchObject({ remainingAmount: 200 })

    success(await markDinnerCooked(ref(dish.id)))
    // 別の端末: 作った後に読んだ版で、買い足した 100g を「購入の合計」として送る
    const seen = groceryRowOf(PORK)
    const added = await setGroceryPurchase({
      id: seen.id as string,
      version: seen.updated_at as string,
      purchase: { kind: "amount", amount: Number(seen.purchased_quantity) + 100 },
    })
    expect(added).toMatchObject({ status: "saved" })
    expect(groceryRowOf(PORK)).toMatchObject({ purchased_quantity: 400 })

    success(await restoreDinnerEntry(ref(dish.id)))
    expect(groceryRowOf(PORK)).toMatchObject({ purchased_quantity: 400 })
    expect(viewOf(PORK)).toMatchObject({ requiredAmount: 500, purchasedAmount: 400, remainingAmount: 100, state: "to_buy" })

    // 受け入れ 3: 取り消しの再送・同期の再送で、数量は増えも減りもしない
    const settled = JSON.stringify(db.grocery())
    expect(success(await restoreDinnerEntry(ref(dish.id))).status).toBe("replayed")
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({ status: "saved" })
    expect(await syncGroceryList({ operationId: OP1 })).toMatchObject({ status: "replayed" })
    expect(JSON.stringify(db.grocery())).toBe(settled)
    expect(viewOf(PORK)).toMatchObject({ purchasedAmount: 400, remainingAmount: 100 })
  })

  it("量を追わない項目（塩 少々）の購入の印も、作った → 取り消しで戻る", async () => {
    const dish = await confirmStirFry()
    await buy(SALT, { kind: "check", checked: true })
    expect(viewOf(SALT)).toMatchObject({ checked: true, state: "purchased" })

    success(await markDinnerCooked(ref(dish.id)))
    // 印（購入の事実）は残す。使い終えたかは別に持つ
    expect(groceryRowOf(SALT)).toMatchObject({ purchased: true })

    success(await restoreDinnerEntry(ref(dish.id)))
    expect(groceryRowOf(SALT)).toMatchObject({ purchased: true, still_needed: true })
    expect(viewOf(SALT)).toMatchObject({ checked: true, state: "purchased" })
  })

  it("使い終えた印を付け直すと新しい購入として記録する（同じ内容の再送とみなさない）。古い印の再送は上書きしない", async () => {
    const dish = await confirmStirFry()
    const seen = groceryRowOf(SALT)
    const firstTick = {
      id: seen.id as string,
      version: seen.updated_at as string,
      purchase: { kind: "check" as const, checked: true },
    }
    expect(await setGroceryPurchase(firstTick)).toMatchObject({ status: "saved" })
    success(await markDinnerCooked(ref(dish.id)))
    expect(viewOf(SALT)).toMatchObject({ checked: false })

    // 作る前に送った印の再送（古い版）は、新しい購入にしない
    expect(await setGroceryPurchase(firstTick)).toMatchObject({ status: "conflict" })
    expect(viewOf(SALT)).toMatchObject({ checked: false })

    // 家族がもう一度買った: 事実の印は true のままでも、replayed に吸わずに書く
    const used = groceryRowOf(SALT)
    const retick = { id: used.id as string, version: used.updated_at as string, purchase: { kind: "check" as const, checked: true } }
    expect(await setGroceryPurchase(retick)).toMatchObject({ status: "saved" })
    expect(viewOf(SALT)).toMatchObject({ checked: true })
    expect(await setGroceryPurchase(retick)).toMatchObject({ status: "replayed" })
  })
})
