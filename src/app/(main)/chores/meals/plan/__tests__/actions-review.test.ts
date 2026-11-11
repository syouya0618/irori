/**
 * 独立レビューの指摘（献立の側）の回帰テスト（2026-11-11）。
 *
 * - [重 1] ⑤ 確定済みの手動料理を、使わない食材に当たる内容へ編集・取り消しで戻しても、確定のまま
 *   買い物へ入り続けない（確定は「問題なし」の料理だけ）
 * - [中 5] ④ 結果不明の「献立に入れる」を同じ操作で確かめ直しても、その間に他の端末が消した料理を蘇らせない
 *
 * DB は `fake-dinner-db.ts` の代役。カタログは実物。暦の前提: 2026-11-11 は水曜、2026-11-13 は金曜。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { getAuthContext, revalidatePath } = vi.hoisted(() => ({ getAuthContext: vi.fn(), revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("next/cache", () => ({ revalidatePath }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }))

import {
  addDinnerRecipe,
  confirmDinnerPlan,
  deleteDinnerEntry,
  markDinnerSkipped,
  restoreDinnerEntry,
  saveCustomDish,
} from "../actions"
import { syncGroceryList } from "../../shopping/actions"
import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  type FakeDinnerDb,
  type Row,
} from "@/lib/meals/server/__tests__/fake-dinner-db"
import type { DinnerSaveSuccess } from "@/lib/meals/server/plan-requests"

const USER = "f1000000-0000-4000-8000-000000000001"
const HOUSE = "f1000000-0000-4000-8000-0000000000a1"
const OP = "f2000000-0000-4000-8000-0000000000c1"
const SALAD = "f3000000-0000-4000-8000-0000000000c2"
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"

let db: FakeDinnerDb

function success(result: unknown): DinnerSaveSuccess {
  expect(result).not.toHaveProperty("error")
  return result as DinnerSaveSuccess
}

function entryById(id: unknown): Row {
  const row = db.entries().find((entry) => entry.id === id)
  if (!row) throw new Error("entry not found")
  return row
}

function groceryNames(): string[] {
  return db
    .grocery()
    .filter((row) => row.still_needed === true)
    .map((row) => row.name as string)
    .sort()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.stubEnv("MEAL_AI_ENABLED", "")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("unexpected fetch")
    }),
  )
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.supabase, userId: db.userId, householdId: db.householdId },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  getAuthContext.mockReset()
  revalidatePath.mockReset()
})

// ── [重 1] ─────────────────────────────────────────────────────────

describe("[重 1] 確定済みの手動料理を、使わない食材に当たる・確かめられない内容にしたら、確定のままにしない", () => {
  /** 卵アレルギーの世帯で、確定済みの手動料理「サラダ」（材料はレタス）。買い物まで同期済み。 */
  async function confirmedSalad() {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const salad = entryRow(HOUSE, {
      id: SALAD,
      plan_date: FRIDAY,
      role: "side",
      recipe_id: null,
      recipe_version: null,
      custom_title: "サラダ",
      custom_ingredients: [{ ingredientId: "lettuce", quantity: { amount: 1, unit: "piece" } }],
      pinned: true,
      status: "confirmed",
      origin: "manual",
    })
    db.tables.dinner_plan_entries.push(salad)
    success(await syncGroceryList({ operationId: OP }))
    expect(groceryNames()).toEqual(["レタス"])
    return salad
  }
  const edit = (over: Record<string, unknown>) => ({
    id: SALAD,
    version: entryById(SALAD).updated_at as string,
    date: FRIDAY,
    role: "side" as const,
    title: "サラダ",
    ingredients: [{ name: "レタス", amount: 1, unit: "piece" as const }],
    ...over,
  })

  it("材料にマヨネーズ（卵を含む）を足すと、提案へ戻して保存し、そう知らせる。買い物からも外れる", async () => {
    await confirmedSalad()
    const result = success(
      await saveCustomDish(
        edit({
          ingredients: [
            { name: "レタス", amount: 1, unit: "piece" },
            { name: "マヨネーズ", amount: 30, unit: "g" },
          ],
        }),
      ),
    )
    expect(result.status).toBe("saved")
    expect(entryById(SALAD)).toMatchObject({ status: "proposed", pinned: true })
    expect(result.exclusionWarning).toMatchObject({ verdict: "blocked" })
    expect(result.exclusionWarning?.message).toContain("確定を外し")
    expect(result.exclusionWarning?.message).toContain("マヨネーズ")
    // 確定の料理だけが買い物に入る。提案へ戻したので、マヨネーズもレタスも買い物に無い
    expect(groceryNames()).toEqual([])
  })

  it("判定できないアレルギーで止めている間に直して提案へ戻したときは「買い物から外れる」と言わない（材料はリストに残る）", async () => {
    await confirmedSalad()
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { reason: "allergy", target_kind: "custom", target_id: null, custom_label: "ぞぞぞ成分" }),
    )
    const result = success(await saveCustomDish(edit({ title: "サラダ（大盛り）" })))
    expect(entryById(SALAD)).toMatchObject({ status: "proposed" })
    const message = result.exclusionWarning?.message ?? ""
    expect(message).toContain("確定を外し、提案へ戻しました")
    // 修正前: 同じ文の中で「今のリストはそのまま」と「買い物リストからも外れます」が食い違った
    expect(message).not.toContain("買い物リストからも外れます")
    expect(message).toContain("材料はリストに残ります")
    expect(groceryNames()).toEqual(["レタス"])
    expect(result.grocery).toMatchObject({ ok: false, message: expect.stringContaining("要再確認") })
  })

  it("料理名を、除外の品目を含む名前（たまごサラダ）にしても、提案へ戻す", async () => {
    await confirmedSalad()
    const result = success(await saveCustomDish(edit({ title: "たまごサラダ" })))
    expect(entryById(SALAD)).toMatchObject({ status: "proposed", custom_title: "たまごサラダ" })
    expect(result.exclusionWarning).toMatchObject({ verdict: "blocked" })
  })

  it("材料を全部消す（確かめられない）と、提案へ戻す", async () => {
    await confirmedSalad()
    const result = success(await saveCustomDish(edit({ ingredients: [] })))
    expect(entryById(SALAD)).toMatchObject({ status: "proposed", custom_ingredients: null })
    expect(result.exclusionWarning).toMatchObject({ verdict: "label_check" })
    expect(result.exclusionWarning?.message).toContain("確定を外し")
  })

  it("対照: 問題なしのまま直す（材料にきゅうりを足す）なら、確定のまま。応答を失った再送は replayed", async () => {
    await confirmedSalad()
    const request = edit({
      ingredients: [
        { name: "レタス", amount: 1, unit: "piece" },
        { name: "きゅうり", amount: 1, unit: "piece" },
      ],
    })
    const result = success(await saveCustomDish(request))
    expect(result.exclusionWarning).toBeUndefined()
    expect(entryById(SALAD).status).toBe("confirmed")
    expect(groceryNames()).toEqual(["きゅうり", "レタス"])
    expect(success(await saveCustomDish(request)).status).toBe("replayed")
  })

  it("提案へ戻した編集の再送（同じ内容）は replayed（もう一度書かない）", async () => {
    await confirmedSalad()
    const request = edit({ title: "たまごサラダ" })
    success(await saveCustomDish(request))
    const versionAfter = entryById(SALAD).updated_at
    expect(success(await saveCustomDish(request)).status).toBe("replayed")
    expect(entryById(SALAD)).toMatchObject({ status: "proposed", updated_at: versionAfter })
  })

  it("取り消しで確定へ戻すときも判定する: 確定 → 作らなかった → 除外を追加 → 取り消し は、提案へ戻す", async () => {
    const mayoSalad = entryRow(HOUSE, {
      id: SALAD,
      plan_date: TODAY,
      role: "side",
      recipe_id: null,
      recipe_version: null,
      custom_title: "ポテトサラダ",
      custom_ingredients: [
        { ingredientId: "potato", quantity: { amount: 2, unit: "piece" } },
        { ingredientId: "mayonnaise", quantity: { amount: 30, unit: "g" } },
      ],
      pinned: true,
      status: "confirmed",
      origin: "manual",
    })
    db.tables.dinner_plan_entries.push(mayoSalad)
    success(await markDinnerSkipped({ entryId: SALAD, version: entryById(SALAD).updated_at as string }))
    expect(entryById(SALAD)).toMatchObject({ status: "skipped", prior_status: "confirmed" })
    // 作らなかった後に、家族が卵アレルギーを登録した
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const restored = success(await restoreDinnerEntry({ entryId: SALAD, version: entryById(SALAD).updated_at as string }))
    expect(restored.status).toBe("saved")
    expect(entryById(SALAD).status).toBe("proposed")
    expect(restored.exclusionWarning).toMatchObject({ verdict: "blocked" })
    expect(groceryNames()).toEqual([])
    // 確定しようとしても止まる
    expect(await confirmDinnerPlan({ expectedRevision: db.revision(), startDate: TODAY, days: 7 })).toMatchObject({
      failure: "rejected",
    })
  })

  it("対照: 除外に当たらなければ、取り消しは元の確定へ戻す", async () => {
    const salad = entryRow(HOUSE, {
      id: SALAD,
      plan_date: TODAY,
      role: "side",
      recipe_id: null,
      recipe_version: null,
      custom_title: "サラダ",
      custom_ingredients: [{ ingredientId: "lettuce", quantity: { amount: 1, unit: "piece" } }],
      pinned: true,
      status: "skipped",
      prior_status: "confirmed",
      origin: "manual",
    })
    db.tables.dinner_plan_entries.push(salad)
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const restored = success(await restoreDinnerEntry({ entryId: SALAD, version: salad.updated_at as string }))
    expect(restored.exclusionWarning).toBeUndefined()
    expect(entryById(SALAD).status).toBe("confirmed")
  })
})

// ── [中 5] ─────────────────────────────────────────────────────────

describe("[中 5] 結果不明の「献立に入れる」を確かめ直しても、他の端末が消した料理を蘇らせない", () => {
  const ADDED = "f3000000-0000-4000-8000-0000000000c3"
  /** 押した時点に固定した要求（確かめ直しは、この同じ値を送る）。 */
  const pressed = () => ({
    id: ADDED,
    expectedRevision: db.revision(),
    date: FRIDAY,
    recipeId: "spinach_ohitashi",
    role: "side" as const,
    position: 0,
    servings: 2,
    status: "proposed" as const,
  })

  it("先の追加が成立し、その後に他の端末が消していたら、確かめ直しで足し直さない", async () => {
    const request = pressed()
    // X が送った追加は成立したが、応答は X へ届かなかった（結果不明）
    success(await addDinnerRecipe(request))
    // Y がその料理を献立から消した
    const row = entryById(ADDED)
    success(await deleteDinnerEntry({ entryId: ADDED, version: row.updated_at as string }))
    expect(db.entries()).toEqual([])
    // X が「同じ操作で確認」（同じ ID・同じ内容）
    const retried = success(await addDinnerRecipe(request))
    expect(retried).toMatchObject({ status: "conflict", detail: "day_changed" })
    expect(retried.notices.join("")).toContain("足し直してはいません")
    expect(db.entries()).toEqual([])
    expect(db.rpcNames().filter((name) => name === "save_dinner_entry")).toHaveLength(1)
  })

  it("対照: 先の送信が届いていなければ（押した後に献立が変わっていなければ）、確かめ直しで足す", async () => {
    const request = pressed()
    let lost = true
    db.intercept("save_dinner_entry", () => {
      if (!lost) return undefined
      lost = false
      return { data: null, error: { code: "", message: "fetch failed" } }
    })
    expect(await addDinnerRecipe(request)).toMatchObject({ failure: "unknown" })
    expect(db.entries()).toEqual([])
    const retried = success(await addDinnerRecipe(request))
    expect(retried.status).toBe("saved")
    expect(entryById(ADDED)).toMatchObject({ recipe_id: "spinach_ohitashi", plan_date: FRIDAY })
  })

  it("対照: 先の追加が成立していれば（行が在れば）、その後に献立の版が進んでいても replayed", async () => {
    const request = pressed()
    success(await addDinnerRecipe(request))
    // 別の端末が別の日の料理を足した（献立の版が進む）
    success(
      await addDinnerRecipe({ ...pressed(), id: "f3000000-0000-4000-8000-0000000000c4", date: TODAY, recipeId: "nikujaga", role: "main" }),
    )
    expect(success(await addDinnerRecipe(request)).status).toBe("replayed")
    expect(db.entries().filter((entry) => entry.id === ADDED)).toHaveLength(1)
  })
})
