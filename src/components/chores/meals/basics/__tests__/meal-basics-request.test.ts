/**
 * 食材・設定の保存操作の合併型（X-05 / X-09 / X-11）。
 * - 型ガードは各 Action の検査と同じ関数で中身を見る（余分な項目・世帯 ID の混入を通さない）
 * - 振り分けは `op` を外した要求だけを Action へ渡す
 * - 献立・買い物の操作（別の合併型）を、この合併型の操作として読まない
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

import { CHORE_PENDING_LABEL_MAX } from "@/lib/domain/chore-pending"

const actions = vi.hoisted(() => ({
  addPantryItems: vi.fn(),
  savePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
  saveDinnerSettings: vi.fn(),
  saveFoodExclusion: vi.fn(),
  deleteFoodExclusion: vi.fn(),
  saveFoodPreference: vi.fn(),
  deleteFoodPreference: vi.fn(),
  deleteDishFeedback: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  addPantryItems: actions.addPantryItems,
  savePantryItem: actions.savePantryItem,
  deletePantryItem: actions.deletePantryItem,
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: actions.saveDinnerSettings,
  saveFoodExclusion: actions.saveFoodExclusion,
  deleteFoodExclusion: actions.deleteFoodExclusion,
  saveFoodPreference: actions.saveFoodPreference,
  deleteFoodPreference: actions.deleteFoodPreference,
  deleteDishFeedback: actions.deleteDishFeedback,
}))

import {
  clipLabel,
  isMealBasicsRequest,
  labelOfMealBasicsRequest,
  runMealBasicsRequest,
  type MealBasicsRequest,
} from "../meal-basics-request"

const ID = "e1000000-0000-4000-8000-000000000001"
const OTHER = "e1000000-0000-4000-8000-000000000002"
const VERSION = "2026-11-11T01:02:03.123456+00:00"

const FIELDS = {
  ingredientId: null,
  name: "玉ねぎ",
  quantity: { amount: 2, unit: "piece" },
  status: "have",
  useSoon: false,
  storage: null,
  expiresOn: null,
  confirmedOn: "2026-11-11",
} as const

const REQUESTS: MealBasicsRequest[] = [
  { op: "pantry_add", items: [{ id: ID, ...FIELDS }] },
  { op: "pantry_save", id: ID, version: VERSION, item: { ...FIELDS } },
  { op: "pantry_delete", id: ID, version: VERSION },
  {
    op: "settings_save",
    version: null,
    servings: 2,
    includeSoup: false,
    maxCookMinutes: null,
    stapleIngredientIds: ["salt"],
    childStages: { [OTHER]: "toddler" },
  },
  { op: "exclusion_save", id: ID, reason: "allergy", target: { kind: "allergen", allergenId: "egg" }, subject: { kind: "household" } },
  { op: "exclusion_delete", id: ID },
  { op: "preference_save", id: ID, version: null, scope: "personal", target: { kind: "tag", id: "fish" }, sentiment: "like" },
  { op: "preference_delete", id: ID },
  { op: "feedback_delete", id: ID },
]

const ACTION_OF: Record<MealBasicsRequest["op"], keyof typeof actions> = {
  pantry_add: "addPantryItems",
  pantry_save: "savePantryItem",
  pantry_delete: "deletePantryItem",
  settings_save: "saveDinnerSettings",
  exclusion_save: "saveFoodExclusion",
  exclusion_delete: "deleteFoodExclusion",
  preference_save: "saveFoodPreference",
  preference_delete: "deleteFoodPreference",
  feedback_delete: "deleteDishFeedback",
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe("isMealBasicsRequest", () => {
  it.each(REQUESTS)("正しい形の $op を受ける", (request) => {
    expect(isMealBasicsRequest(request)).toBe(true)
    // 端末の控えから読んだ値（JSON を往復した値）でも同じ
    expect(isMealBasicsRequest(JSON.parse(JSON.stringify(request)))).toBe(true)
  })

  it.each(REQUESTS)("$op に世帯 ID・持ち主を紛れ込ませた要求は受けない", (request) => {
    expect(isMealBasicsRequest({ ...request, householdId: OTHER })).toBe(false)
    expect(isMealBasicsRequest({ ...request, profileId: OTHER })).toBe(false)
  })

  it("op が無い・知らない op・献立や買い物の op は受けない", () => {
    const { op: _op, ...withoutOp } = REQUESTS[2]
    void _op
    expect(isMealBasicsRequest(withoutOp)).toBe(false)
    expect(isMealBasicsRequest({ op: "delete", id: ID })).toBe(false)
    expect(isMealBasicsRequest({ op: "purchase", id: ID, version: VERSION })).toBe(false)
    expect(isMealBasicsRequest({ op: "constructor", id: ID })).toBe(false)
    expect(isMealBasicsRequest(null)).toBe(false)
    expect(isMealBasicsRequest("pantry_delete")).toBe(false)
  })

  it("op と中身の組が合わない要求は受けない（食材の削除に版が無い・ID が UUID でない）", () => {
    expect(isMealBasicsRequest({ op: "pantry_delete", id: ID })).toBe(false)
    expect(isMealBasicsRequest({ op: "exclusion_delete", id: "not-a-uuid" })).toBe(false)
    expect(isMealBasicsRequest({ op: "pantry_save", id: ID, version: VERSION, item: { ...FIELDS, status: "plenty" } })).toBe(false)
    // 中身は「使わない食材の登録」なのに、op だけ設定の保存を名乗る
    expect(isMealBasicsRequest({ ...REQUESTS[4], op: "settings_save" })).toBe(false)
  })
})

describe("runMealBasicsRequest", () => {
  it.each(REQUESTS)("$op を対応する Action へ、op を外して渡し、成功応答に op を付けて返す", async (request) => {
    const action = actions[ACTION_OF[request.op]]
    action.mockResolvedValue({ status: "saved", id: ID })
    const result = await runMealBasicsRequest(request)

    expect(action).toHaveBeenCalledTimes(1)
    const { op: _op, ...withoutOp } = request
    void _op
    expect(action.mock.calls[0][0]).toEqual(withoutOp)
    expect(action.mock.calls[0][0]).not.toHaveProperty("op")
    expect(result).toEqual({ status: "saved", id: ID, op: request.op })
    // ほかの Action は呼ばない
    for (const [name, mock] of Object.entries(actions)) {
      if (name !== ACTION_OF[request.op]) expect(mock).not.toHaveBeenCalled()
    }
  })

  it("失敗応答・形の読めない応答には手を加えない（成功と偽らない）", async () => {
    const failure = { error: "保存できませんでした。", failure: "unknown" }
    actions.savePantryItem.mockResolvedValueOnce(failure)
    expect(await runMealBasicsRequest(REQUESTS[1])).toEqual(failure)

    actions.savePantryItem.mockResolvedValueOnce(undefined)
    expect(await runMealBasicsRequest(REQUESTS[1])).toBeUndefined()

    actions.savePantryItem.mockResolvedValueOnce({ status: "done" })
    expect(await runMealBasicsRequest(REQUESTS[1])).toEqual({ status: "done" })
  })

  it("Action の例外はそのまま投げる（useChoreSave が結果不明として扱う）", async () => {
    actions.deletePantryItem.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(runMealBasicsRequest(REQUESTS[2])).rejects.toThrow("Failed to fetch")
  })
})

describe("labelOfMealBasicsRequest（端末の控えの説明）", () => {
  it("操作ごとに、何をしたかが分かる短い文になる", () => {
    expect(labelOfMealBasicsRequest(REQUESTS[0])).toBe("食材「玉ねぎ」を登録")
    expect(
      labelOfMealBasicsRequest({ op: "pantry_add", items: [{ id: ID, ...FIELDS }, { id: OTHER, ...FIELDS, name: "卵" }] }),
    ).toBe("食材 2 件を登録（「玉ねぎ」ほか）")
    expect(labelOfMealBasicsRequest(REQUESTS[1])).toBe("食材「玉ねぎ」を更新")
    expect(labelOfMealBasicsRequest(REQUESTS[2], "牛乳")).toBe("食材「牛乳」を削除")
    expect(labelOfMealBasicsRequest(REQUESTS[2])).toBe("食材を削除")
    expect(labelOfMealBasicsRequest(REQUESTS[3])).toBe("ごはんの設定を保存")
    expect(labelOfMealBasicsRequest(REQUESTS[4], "卵")).toBe("使わない食材「卵」を登録")
    expect(labelOfMealBasicsRequest(REQUESTS[8], "肉じゃが")).toBe("食後の評価「肉じゃが」を削除")
  })

  it("長い名前でも控えの上限に収まる（収まらない控えは端末に残せず、送信もできない）", () => {
    const long = "あ".repeat(200)
    for (const request of REQUESTS) {
      const label = labelOfMealBasicsRequest(request, long)
      expect(label.length).toBeGreaterThan(0)
      expect(label.length).toBeLessThanOrEqual(CHORE_PENDING_LABEL_MAX)
    }
    const longItem = labelOfMealBasicsRequest({ op: "pantry_save", id: ID, version: null, item: { ...FIELDS, name: long } })
    expect(longItem.length).toBeLessThanOrEqual(CHORE_PENDING_LABEL_MAX)
    expect(longItem).toContain("…")
  })

  it("clipLabel は上限以内の文を変えず、超える文だけを「…」で切る（絵文字などの組を割らない）", () => {
    expect(clipLabel("  短い文  ")).toBe("短い文")
    expect(clipLabel("あ".repeat(80))).toBe("あ".repeat(80))
    const clipped = clipLabel("😀".repeat(60), 10)
    expect(clipped.length).toBeLessThanOrEqual(10)
    expect(clipped.endsWith("…")).toBe(true)
    // 対（サロゲートペア）の片割れで終わらない
    expect(clipped.slice(0, -1)).toBe("😀".repeat(4))
  })
})
