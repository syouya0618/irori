import { describe, expect, it } from "vitest"

import { buildGroceryNeeds, groceryItemKey, mergeWithExisting, outstandingRequired, remainingToBuy } from "../../grocery"
import { DEFAULT_DINNER_SERVINGS } from "../../planner"
import type { GroceryNeed, PlanEntry } from "../../types"
import { getMealLookup } from "../context"
import {
  DINNER_SERVINGS_DEFAULT,
  defaultDinnerSettings,
  dinnerPlanStateFromRow,
  dinnerSettingsFromRow,
  dinnerSettingsToRpcArgs,
  dishFeedbackFromRow,
  dishFeedbackToRpcArgs,
  foodExclusionFromRow,
  foodExclusionToRpcArgs,
  foodPreferenceFromRow,
  foodPreferenceToRpcArgs,
  groceryDbKeyOfLogicKey,
  groceryItemFromRow,
  groceryLogicKeyOfDbKey,
  groceryNeedToRpc,
  groceryNeedsToRpc,
  isDeletedEntity,
  mapRows,
  pantryItemFromRow,
  pantryItemToRpc,
  planEntryFromRow,
  planEntryToRpc,
  planEntryToRpcWithId,
  recipeIngredientsFromJson,
  toFiniteNumber,
  toUnitId,
} from "../rows"

/** PostgREST / `to_jsonb` が返す timestamptz の表記（マイクロ秒つき）。 */
const VERSION = "2026-11-11T01:02:03.123456+00:00"

function pantryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p-1",
    household_id: "h-1",
    ingredient_id: "onion",
    name: "玉ねぎ",
    quantity: 2,
    unit: "piece",
    status: "have",
    use_soon: false,
    storage: "pantry",
    expires_on: null,
    confirmed_on: "2026-11-10",
    created_by: "u-1",
    updated_at: VERSION,
    created_at: VERSION,
    ...overrides,
  }
}

function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e-1",
    plan_date: "2026-11-12",
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
    ...overrides,
  }
}

function groceryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "g-1",
    origin: "auto",
    item_key: "pork_komagire|mass",
    ingredient_id: "pork_komagire",
    name: "豚こま切れ肉",
    section: null,
    required_quantity: 500,
    unit: "g",
    required_note: null,
    needs_stock_check: false,
    sources: [{ date: "2026-11-12", recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 200, unit: "g" } }],
    purchased_quantity: 300,
    purchased: false,
    purchased_at: VERSION,
    restocked_quantity: 0,
    restock_ids: [],
    note: null,
    plan_revision: 3,
    still_needed: true,
    updated_at: VERSION,
    ...overrides,
  }
}

function ok<T>(result: { ok: true; value: T; degraded: string[] } | { ok: false; id: string | null; field: string }) {
  if (!result.ok) throw new Error(`expected a readable row, got unreadable at ${result.field}`)
  return result
}

describe("toFiniteNumber（numeric / bigint は文字列で届きうる）", () => {
  it("数値と、数値の文字列だけを数値にする", () => {
    expect(toFiniteNumber(300)).toBe(300)
    expect(toFiniteNumber("300.000")).toBe(300)
    expect(toFiniteNumber("0.5")).toBe(0.5)
    expect(toFiniteNumber("-2")).toBe(-2)
  })

  it("対照: 数値でないものを 0 や NaN にしない", () => {
    for (const value of [null, undefined, "", " ", "abc", "1e3", "1,000", "12px", NaN, Infinity, true, {}, []]) {
      expect(toFiniteNumber(value)).toBeNull()
    }
  })
})

describe("toUnitId", () => {
  it("知っている単位だけを通す", () => {
    expect(toUnitId("g")).toBe("g")
    expect(toUnitId("tbsp")).toBe("tbsp")
  })

  it("対照: 未知の単位・継承プロパティ名・文字列以外は null", () => {
    expect(toUnitId("gram")).toBeNull()
    expect(toUnitId("constructor")).toBeNull()
    expect(toUnitId("toString")).toBeNull()
    expect(toUnitId(null)).toBeNull()
    expect(toUnitId(1)).toBeNull()
  })
})

describe("isDeletedEntity（RPC の「行が既に無い」印）", () => {
  it("{ id, deleted: true } を見分ける", () => {
    expect(isDeletedEntity({ id: "p-1", deleted: true })).toBe(true)
  })

  it("対照: 通常の行・deleted が true でない値は印として扱わない", () => {
    expect(isDeletedEntity(pantryRow())).toBe(false)
    expect(isDeletedEntity({ id: "p-1", deleted: "true" })).toBe(false)
    expect(isDeletedEntity({ deleted: true })).toBe(false)
    expect(isDeletedEntity(null)).toBe(false)
  })

  it("印を行の写像へ渡すと「読めない行」になる（既定値で埋めた行にならない）", () => {
    expect(pantryItemFromRow({ id: "p-1", deleted: true })).toEqual({ ok: false, id: "p-1", field: "updated_at" })
  })
})

describe("pantryItemFromRow", () => {
  it("行を PantryItem + 版へ写す。版は文字列のまま", () => {
    const result = ok(pantryItemFromRow(pantryRow({ expires_on: "2026-11-20", use_soon: true })))
    expect(result.value).toEqual({
      id: "p-1",
      ingredientId: "onion",
      name: "玉ねぎ",
      quantity: { amount: 2, unit: "piece" },
      status: "have",
      useSoon: true,
      storage: "pantry",
      expiresOn: "2026-11-20",
      confirmedOn: "2026-11-10",
      version: VERSION,
    })
    expect(result.degraded).toEqual([])
  })

  it("numeric が文字列で届いても数量として読む", () => {
    const result = ok(pantryItemFromRow(pantryRow({ quantity: "250.50", unit: "g" })))
    expect(result.value.quantity).toEqual({ amount: 250.5, unit: "g" })
  })

  it("数量・食材 ID・保管場所・期限が null の行は、そのまま null（数量不明・未解決）", () => {
    const result = ok(
      pantryItemFromRow(pantryRow({ quantity: null, unit: null, ingredient_id: null, storage: null })),
    )
    expect(result.value.quantity).toBeNull()
    expect(result.value.ingredientId).toBeNull()
    expect(result.value.storage).toBeNull()
    expect(result.value.expiresOn).toBeNull()
    expect(result.degraded).toEqual([])
  })

  it("未知の単位は数量不明へ退化し、行は残る（量を捏造しない）", () => {
    const result = ok(pantryItemFromRow(pantryRow({ quantity: 3, unit: "bottle" })))
    expect(result.value.quantity).toBeNull()
    expect(result.degraded).toEqual(["unit"])
  })

  it("未知の保管場所は null へ退化する", () => {
    const result = ok(pantryItemFromRow(pantryRow({ storage: "cellar" })))
    expect(result.value.storage).toBeNull()
    expect(result.degraded).toEqual(["storage"])
  })

  it("未知の状態は「ある」へ言い換えず、読めない行にする", () => {
    expect(pantryItemFromRow(pantryRow({ status: "reserved" }))).toEqual({ ok: false, id: "p-1", field: "status" })
    expect(pantryItemFromRow(pantryRow({ status: null }))).toEqual({ ok: false, id: "p-1", field: "status" })
  })

  it("期限が入っているのに読めない行を「期限なし」にしない", () => {
    expect(pantryItemFromRow(pantryRow({ expires_on: "2026-02-30" }))).toEqual({
      ok: false,
      id: "p-1",
      field: "expires_on",
    })
  })

  it("行でない入力・版の無い行は読めない行", () => {
    expect(pantryItemFromRow(null)).toEqual({ ok: false, id: null, field: "row" })
    expect(pantryItemFromRow("row")).toEqual({ ok: false, id: null, field: "row" })
    expect(pantryItemFromRow(pantryRow({ updated_at: null }))).toEqual({ ok: false, id: "p-1", field: "updated_at" })
  })
})

describe("mapRows（読めない行を黙って捨てない）", () => {
  it("読めた行と、読めなかった行の件数・ID・原因の列を返す", () => {
    const mapped = mapRows(
      "pantry_items",
      [pantryRow(), pantryRow({ id: "p-2", status: "reserved" }), pantryRow({ id: "p-3", storage: "cellar" })],
      pantryItemFromRow,
    )
    expect(mapped?.rows.map((row) => row.id)).toEqual(["p-1", "p-3"])
    expect(mapped?.unreadable).toBe(1)
    expect(mapped?.issues).toEqual([
      { table: "pantry_items", id: "p-2", kind: "unreadable", field: "status" },
      { table: "pantry_items", id: "p-3", kind: "degraded", field: "storage" },
    ])
  })

  it("対照: 全て読める行なら unreadable は 0", () => {
    expect(mapRows("pantry_items", [pantryRow()], pantryItemFromRow)).toEqual({
      rows: [expect.objectContaining({ id: "p-1" })],
      unreadable: 0,
      issues: [],
    })
  })

  it("配列でない入力は「0 件」ではなく null（取得の失敗として扱わせる）", () => {
    expect(mapRows("pantry_items", null, pantryItemFromRow)).toBeNull()
    expect(mapRows("pantry_items", { id: "p-1" }, pantryItemFromRow)).toBeNull()
    expect(mapRows("pantry_items", [], pantryItemFromRow)).toEqual({ rows: [], unreadable: 0, issues: [] })
  })
})

describe("foodExclusionFromRow（必須除外は厳しい側へだけ退化させる）", () => {
  const base = {
    id: "x-1",
    subject_kind: "member",
    subject_profile_id: "u-1",
    subject_child_id: null,
    reason: "dislike",
    target_kind: "ingredient",
    target_id: "green_pepper",
    custom_label: null,
    updated_at: VERSION,
  }

  it("対象の 3 種類と対象者の 3 種類を写す", () => {
    expect(ok(foodExclusionFromRow(base)).value).toEqual({
      id: "x-1",
      reason: "dislike",
      target: { kind: "ingredient", ingredientId: "green_pepper" },
      subject: { kind: "member", profileId: "u-1" },
      version: VERSION,
    })
    expect(
      ok(foodExclusionFromRow({ ...base, target_kind: "allergen", target_id: "egg", reason: "allergy" })).value.target,
    ).toEqual({ kind: "allergen", allergenId: "egg" })
    expect(
      ok(foodExclusionFromRow({ ...base, target_kind: "custom", target_id: null, custom_label: "パクチー" })).value
        .target,
    ).toEqual({ kind: "custom", label: "パクチー" })
    expect(
      ok(
        foodExclusionFromRow({ ...base, subject_kind: "child", subject_profile_id: null, subject_child_id: "c-1" }),
      ).value.subject,
    ).toEqual({ kind: "child", childId: "c-1" })
    expect(
      ok(foodExclusionFromRow({ ...base, subject_kind: "household", subject_profile_id: null })).value.subject,
    ).toEqual({ kind: "household" })
  })

  it("未知の対象の種類は読めない行（除外を落としたことを呼び出し側が知れる）", () => {
    expect(foodExclusionFromRow({ ...base, target_kind: "brand" })).toEqual({
      ok: false,
      id: "x-1",
      field: "target_kind",
    })
    expect(foodExclusionFromRow({ ...base, target_id: null })).toEqual({ ok: false, id: "x-1", field: "target_kind" })
  })

  it("未知の理由は、原材料の確認が要る側（アレルギー）へ倒す", () => {
    const result = ok(foodExclusionFromRow({ ...base, reason: "religion" }))
    expect(result.value.reason).toBe("allergy")
    expect(result.degraded).toEqual(["reason"])
  })

  it("対照: 既知の理由「苦手」をアレルギーへ言い換えない", () => {
    const result = ok(foodExclusionFromRow(base))
    expect(result.value.reason).toBe("dislike")
    expect(result.degraded).toEqual([])
  })

  it("未知の対象者は世帯全体へ退化する（除外そのものは残る）", () => {
    const result = ok(foodExclusionFromRow({ ...base, subject_kind: "guest" }))
    expect(result.value.subject).toEqual({ kind: "household" })
    expect(result.value.target).toEqual({ kind: "ingredient", ingredientId: "green_pepper" })
    expect(result.degraded).toEqual(["subject_kind"])
  })
})

describe("foodPreferenceFromRow", () => {
  const base = {
    id: "f-1",
    scope: "personal",
    profile_id: "u-1",
    target_kind: "recipe",
    target_id: "nikujaga",
    sentiment: "like",
    updated_at: VERSION,
  }

  it("個人の好みと家族共通の好みを写す", () => {
    expect(ok(foodPreferenceFromRow(base)).value).toEqual({
      id: "f-1",
      scope: "personal",
      profileId: "u-1",
      target: { kind: "recipe", id: "nikujaga" },
      sentiment: "like",
      version: VERSION,
    })
    expect(ok(foodPreferenceFromRow({ ...base, scope: "household", profile_id: null })).value.profileId).toBeNull()
  })

  it("未知の範囲・対象の種類・評価は読めない行（好きとも苦手とも言い換えない）", () => {
    expect(foodPreferenceFromRow({ ...base, scope: "team" })).toMatchObject({ ok: false, field: "scope" })
    expect(foodPreferenceFromRow({ ...base, target_kind: "cuisine" })).toMatchObject({ ok: false, field: "target_kind" })
    expect(foodPreferenceFromRow({ ...base, sentiment: "love" })).toMatchObject({ ok: false, field: "sentiment" })
  })

  it("持ち主の無い個人の好みを、家族共通へ言い換えない", () => {
    expect(foodPreferenceFromRow({ ...base, profile_id: null })).toMatchObject({ ok: false, field: "profile_id" })
  })
})

describe("dishFeedbackFromRow", () => {
  const base = {
    id: "d-1",
    profile_id: "u-2",
    recipe_id: "nikujaga",
    dish_title: "肉じゃが",
    eaten_on: "2026-11-10",
    taste: 3,
    effort: 1,
    again: true,
    exclude_from_learning: false,
    updated_at: VERSION,
  }

  it("評価した本人・料理・日付と、味・手間・また食べたいを分けて写す", () => {
    expect(ok(dishFeedbackFromRow(base)).value).toEqual({
      id: "d-1",
      profileId: "u-2",
      recipeId: "nikujaga",
      eatenOn: "2026-11-10",
      taste: 3,
      effort: 1,
      again: true,
      excludeFromLearning: false,
      dishTitle: "肉じゃが",
      version: VERSION,
    })
  })

  it("null の評価は未回答のまま。範囲外の評価も未回答へ（低評価・高評価へ言い換えない）", () => {
    const blank = ok(dishFeedbackFromRow({ ...base, taste: null, effort: null, again: null, recipe_id: null }))
    expect(blank.value).toMatchObject({ taste: null, effort: null, again: null, recipeId: null })
    expect(blank.degraded).toEqual([])

    const odd = ok(dishFeedbackFromRow({ ...base, taste: 5, effort: "2" }))
    expect(odd.value.taste).toBeNull()
    expect(odd.value.effort).toBe(2)
    expect(odd.degraded).toEqual(["taste"])
  })

  it("学習から除く印が読めない評価は、好みへ反映しない側へ倒す", () => {
    const result = ok(dishFeedbackFromRow({ ...base, exclude_from_learning: null }))
    expect(result.value.excludeFromLearning).toBe(true)
    expect(result.degraded).toEqual(["exclude_from_learning"])
  })

  it("評価者・日付が読めない行は読めない行", () => {
    expect(dishFeedbackFromRow({ ...base, profile_id: null })).toMatchObject({ ok: false, field: "profile_id" })
    expect(dishFeedbackFromRow({ ...base, eaten_on: "2026-13-01" })).toMatchObject({ ok: false, field: "eaten_on" })
  })
})

describe("planEntryFromRow", () => {
  it("カタログのレシピの枠を写す", () => {
    expect(ok(planEntryFromRow(entryRow())).value).toEqual({
      id: "e-1",
      date: "2026-11-12",
      role: "main",
      position: 0,
      recipeId: "nikujaga",
      recipeVersion: 1,
      customTitle: null,
      customIngredients: null,
      servings: 2,
      pinned: false,
      status: "confirmed",
      origin: "auto",
      version: VERSION,
    })
  })

  it("手動料理の材料（jsonb）を RecipeIngredient[] へ写す", () => {
    const result = ok(
      planEntryFromRow(
        entryRow({
          recipe_id: null,
          recipe_version: null,
          custom_title: "おでん",
          origin: "manual",
          custom_ingredients: [
            { ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" }, note: "厚めの輪切り" },
            { ingredientId: "salt", quantity: { amount: null, unit: "pinch" }, optional: true },
          ],
        }),
      ),
    )
    expect(result.value.customTitle).toBe("おでん")
    expect(result.value.customIngredients).toEqual([
      { ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" }, note: "厚めの輪切り" },
      { ingredientId: "salt", quantity: { amount: null, unit: "pinch" }, optional: true },
    ])
    expect(result.degraded).toEqual([])
  })

  it("材料が未登録（null）の手動料理は null のまま（買い物の自動計算の対象外）", () => {
    const result = ok(planEntryFromRow(entryRow({ recipe_id: null, recipe_version: null, custom_title: "外食" })))
    expect(result.value.customIngredients).toBeNull()
    expect(result.degraded).toEqual([])
  })

  it("材料の 1 件でも読めなければ、一部だけ数えず材料なしへ倒して記録する", () => {
    const result = ok(
      planEntryFromRow(
        entryRow({
          recipe_id: null,
          recipe_version: null,
          custom_title: "鍋",
          custom_ingredients: [
            { ingredientId: "hakusai", quantity: { amount: 0.25, unit: "piece" } },
            { ingredientId: "pork_komagire", quantity: { amount: 200, unit: "gram" } },
          ],
        }),
      ),
    )
    expect(result.value.customIngredients).toBeNull()
    expect(result.degraded).toEqual(["custom_ingredients"])
  })

  it("未知の区分・状態は読めない行（既知の値へ言い換えない）", () => {
    expect(planEntryFromRow(entryRow({ role: "dessert" }))).toEqual({ ok: false, id: "e-1", field: "role" })
    expect(planEntryFromRow(entryRow({ status: "ordered" }))).toEqual({ ok: false, id: "e-1", field: "status" })
  })

  it("未知の出所は「自動」「AI 補助」と名乗らせない", () => {
    const result = ok(planEntryFromRow(entryRow({ origin: "ai_v2" })))
    expect(result.value.origin).toBe("manual")
    expect(result.degraded).toEqual(["origin"])
  })

  it("固定の印が読めない枠は、上書きされない側（固定）へ倒す", () => {
    const result = ok(planEntryFromRow(entryRow({ pinned: null })))
    expect(result.value.pinned).toBe(true)
    expect(result.degraded).toEqual(["pinned"])
  })

  it("対照: 固定でない枠を固定へ言い換えない", () => {
    expect(ok(planEntryFromRow(entryRow({ pinned: false }))).value.pinned).toBe(false)
  })

  it("取り消しで戻す先（prior_status）を読む。読めない値は記録なし（確定へ戻す）へ倒す", () => {
    expect(ok(planEntryFromRow(entryRow({ status: "cooked", prior_status: "proposed" }))).value.priorStatus).toBe(
      "proposed",
    )
    const unknown = ok(planEntryFromRow(entryRow({ status: "cooked", prior_status: "eaten" })))
    expect(unknown.value.priorStatus).toBeUndefined()
    expect(unknown.degraded).toEqual(["prior_status"])
    // 対照: 記録の無い行は劣化扱いにしない
    const none = ok(planEntryFromRow(entryRow({ status: "cooked", prior_status: null })))
    expect(none.value.priorStatus).toBeUndefined()
    expect(none.degraded).toEqual([])
  })

  it("料理名もレシピも無い行・不正な日付は読めない行", () => {
    expect(planEntryFromRow(entryRow({ recipe_id: null, recipe_version: null }))).toMatchObject({
      ok: false,
      field: "recipe_id",
    })
    expect(planEntryFromRow(entryRow({ plan_date: "2026-11-31" }))).toMatchObject({ ok: false, field: "plan_date" })
  })
})

describe("recipeIngredientsFromJson", () => {
  it("配列でない・要素が壊れているものは null", () => {
    expect(recipeIngredientsFromJson(null)).toBeNull()
    expect(recipeIngredientsFromJson({})).toBeNull()
    expect(recipeIngredientsFromJson([{ ingredientId: "", quantity: { amount: 1, unit: "g" } }])).toBeNull()
    expect(recipeIngredientsFromJson([{ ingredientId: "x", quantity: { amount: 0, unit: "g" } }])).toBeNull()
  })

  it("対照: 空の配列は「材料 0 件」として読める", () => {
    expect(recipeIngredientsFromJson([])).toEqual([])
  })
})

describe("groceryItemFromRow", () => {
  it("自動項目を写す。鍵はロジックの形へ、購入量は項目の単位で読む", () => {
    const result = ok(groceryItemFromRow(groceryRow(), () => "meat"))
    expect(result.value).toEqual({
      id: "g-1",
      itemKey: "pork_komagire:mass",
      name: "豚こま切れ肉",
      section: "meat",
      sectionOverridden: false,
      required: { amount: 500, unit: "g" },
      purchased: { amount: 300, unit: "g" },
      restocked: null,
      consumed: null,
      // 台帳に充当を記録した枠の出所は無い（同期の後の形）
      settledRequired: null,
      checked: false,
      note: null,
      version: VERSION,
      origin: "auto",
      ingredientId: "pork_komagire",
      unit: "g",
      requiredNote: null,
      needsStockCheck: false,
      sources: [
        { date: "2026-11-12", recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 200, unit: "g" } },
      ],
      stillNeeded: true,
      purchasedAt: VERSION,
      restockCount: 0,
      planRevision: 3,
    })
    expect(result.degraded).toEqual([])
  })

  it("V-C3: 300g 購入後に必要量が 500g の行は、残り 200g と読める（numeric が文字列でも）", () => {
    const result = ok(
      groceryItemFromRow(groceryRow({ required_quantity: "500.000", purchased_quantity: "300.000" })),
    )
    expect(remainingToBuy(result.value)).toEqual({ amount: 200, unit: "g" })
  })

  it("作った料理に使った量は購入の事実と分けて読み、残りから外す。使い終えた印は画面の印にしない", () => {
    const used = ok(
      groceryItemFromRow(
        groceryRow({ purchased_quantity: "300.000", purchased: true, consumed_quantity: "300.000", purchase_consumed: true }),
      ),
    ).value
    // 購入の事実は 300g のまま。使った 300g は今の必要（500g）に充てない
    expect(used).toMatchObject({ purchased: { amount: 300, unit: "g" }, consumed: { amount: 300, unit: "g" }, checked: false })
    expect(remainingToBuy(used)).toEqual({ amount: 500, unit: "g" })
    // 対照: 使い終えていなければ、印も量もそのまま効く
    const fresh = ok(groceryItemFromRow(groceryRow({ purchased: true, purchase_consumed: false }))).value
    expect(fresh).toMatchObject({ consumed: null, checked: true })
    expect(remainingToBuy(fresh)).toEqual({ amount: 200, unit: "g" })
  })

  it("同期の前に台帳へ充当を記録した枠の出所は、今の必要量に数えない（数えておる記録だけ。読めない要素・眠りは引かない）", () => {
    const TONIGHT = "e1000000-0000-4000-8000-000000000001"
    const FRIDAY_ENTRY = "e1000000-0000-4000-8000-000000000002"
    const sources = [
      { date: "2026-11-11", recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 300, unit: "g" }, entryId: TONIGHT, buy: 300 },
      { date: "2026-11-13", recipeId: "curry_rice", title: "カレーライス", quantity: { amount: 200, unit: "g" }, entryId: FRIDAY_ENTRY, buy: 200 },
    ]
    const row = (consumptions: unknown) =>
      ok(
        groceryItemFromRow(
          groceryRow({ required_quantity: 500, purchased_quantity: 300, consumed_quantity: 300, sources, consumptions }),
        ),
      ).value
    const cooked = row([{ k: TONIGHT, q: 300, m: false, on: true }])
    expect(cooked.settledRequired).toEqual({ amount: 300, unit: "g" })
    expect(outstandingRequired(cooked)).toEqual({ amount: 200, unit: "g" })
    // 修正前は 500 −（300 − 300）= 500 と読めた
    expect(remainingToBuy(cooked)).toEqual({ amount: 200, unit: "g" })

    // 対照: 眠った記録（取り消し・作らなかった）・まとめの記録・壊れた要素・台帳を選んでいない読みは引かない
    expect(row([{ k: TONIGHT, q: 300, m: false, on: false }]).settledRequired).toBeNull()
    expect(row([{ k: "settled", q: 300, m: false, on: true }]).settledRequired).toBeNull()
    expect(row([{ k: 1, q: 300, on: true }, "broken"]).settledRequired).toBeNull()
    expect(row(undefined).settledRequired).toBeNull()
    // 手動の項目は出所を持たないので、引かない
    expect(
      ok(groceryItemFromRow(groceryRow({ origin: "manual", item_key: null, required_quantity: 500, sources, consumptions: [{ k: TONIGHT, q: 300, on: true }] })))
        .value.settledRequired,
    ).toBeNull()
    // 単位の食い違い・必要量を超える値は、0 未満にも別の単位にもしない
    expect(outstandingRequired({ required: { amount: 500, unit: "g" }, settledRequired: { amount: 1, unit: "kg" } })).toEqual({
      amount: 500,
      unit: "g",
    })
    expect(outstandingRequired({ required: { amount: 200, unit: "g" }, settledRequired: { amount: 300, unit: "g" } })).toEqual({
      amount: 0,
      unit: "g",
    })
  })

  it("充当量・使い終えた印が読めない行は、0・未使用と言い換えずに読めない行にする", () => {
    expect(groceryItemFromRow(groceryRow({ consumed_quantity: "abc" }))).toMatchObject({ ok: false, field: "consumed_quantity" })
    expect(groceryItemFromRow(groceryRow({ consumed_quantity: -1 }))).toMatchObject({ ok: false, field: "consumed_quantity" })
    expect(groceryItemFromRow(groceryRow({ purchase_consumed: "yes" }))).toMatchObject({
      ok: false,
      field: "purchase_consumed",
    })
  })

  it("鍵はロジックの `groceryItemKey` と往復で一致する（再計算で同じ項目へ突き合わさる）", () => {
    const logicKey = groceryItemKey("egg", "piece")
    const dbKey = groceryDbKeyOfLogicKey(logicKey, "egg")
    expect(dbKey).toBe("egg|count:piece")
    expect(groceryLogicKeyOfDbKey(dbKey as string)).toBe(logicKey)

    const existing = ok(
      groceryItemFromRow(
        groceryRow({ item_key: dbKey, ingredient_id: "egg", unit: "piece", required_quantity: 4, purchased_quantity: 0 }),
      ),
    ).value
    const need: GroceryNeed = {
      itemKey: logicKey,
      ingredientId: "egg",
      name: "卵",
      section: "egg_dairy",
      required: { amount: 6, unit: "piece" },
      nonNumeric: [],
      needsStockCheck: false,
      sources: [],
    }
    const merged = mergeWithExisting([need], [existing])
    expect(merged.upserts).toHaveLength(1)
    expect(merged.upserts[0].id).toBe("g-1")
    expect(merged.removals).toEqual([])
  })

  it("手動項目は鍵を持たない（自動の再計算の対象外）", () => {
    const result = ok(
      groceryItemFromRow(
        groceryRow({
          origin: "manual",
          item_key: "manual|g-1",
          ingredient_id: null,
          name: "ラップ",
          required_quantity: null,
          unit: null,
          purchased_quantity: 0,
          purchased: true,
          sources: [],
        }),
      ),
    )
    expect(result.value.itemKey).toBeNull()
    expect(result.value.origin).toBe("manual")
    expect(result.value.checked).toBe(true)
    expect(result.value.purchased).toBeNull()
    expect(result.value.section).toBe("other")
  })

  it("売場: 上書きがあればそれ、無ければ辞書の既定、未知の値は「その他」", () => {
    expect(ok(groceryItemFromRow(groceryRow({ section: "fish" }), () => "meat")).value).toMatchObject({
      section: "fish",
      sectionOverridden: true,
    })
    expect(ok(groceryItemFromRow(groceryRow({ section: "frozen" }), () => "meat")).value).toMatchObject({
      section: "other",
      sectionOverridden: true,
    })
    expect(ok(groceryItemFromRow(groceryRow(), () => undefined)).value.section).toBe("other")
    expect(ok(groceryItemFromRow(groceryRow())).value.section).toBe("other")
  })

  it("未知の出所（自動/手動）は読めない行（消してよい項目かを取り違えない）", () => {
    expect(groceryItemFromRow(groceryRow({ origin: "imported" }))).toEqual({ ok: false, id: "g-1", field: "origin" })
  })

  it("購入量が読めない行を「未購入」へ言い換えない", () => {
    expect(groceryItemFromRow(groceryRow({ purchased_quantity: "many" }))).toEqual({
      ok: false,
      id: "g-1",
      field: "purchased_quantity",
    })
    expect(groceryItemFromRow(groceryRow({ purchased: null }))).toEqual({ ok: false, id: "g-1", field: "purchased" })
  })

  it("未知の単位は量を持たない項目へ退化する（数値を別の単位として読まない）", () => {
    const result = ok(groceryItemFromRow(groceryRow({ unit: "crate" })))
    expect(result.value.unit).toBeNull()
    expect(result.value.required).toBeNull()
    expect(result.value.purchased).toBeNull()
    expect(result.degraded).toEqual(["unit"])
  })

  it("読めない出所は落として記録する。必要かどうかの印が読めなければ「必要」へ倒す", () => {
    const result = ok(
      groceryItemFromRow(
        groceryRow({ sources: [{ date: "2026-11-12", title: "肉じゃが" }, "x"], still_needed: null }),
      ),
    )
    expect(result.value.sources).toEqual([])
    expect(result.value.stillNeeded).toBe(true)
    expect(result.degraded).toEqual(["sources", "still_needed"])
  })
})

describe("dinnerSettingsFromRow / defaultDinnerSettings", () => {
  const base = {
    household_id: "h-1",
    servings: 4,
    include_soup: true,
    max_cook_minutes: 30,
    staples: ["salt", "soy_sauce"],
    child_stages: { "c-1": "toddler" },
    updated_at: VERSION,
  }

  it("行を設定へ写す", () => {
    expect(ok(dinnerSettingsFromRow(base)).value).toEqual({
      servings: 4,
      includeSoup: true,
      maxCookMinutes: 30,
      stapleIngredientIds: ["salt", "soy_sauce"],
      childStages: { "c-1": "toddler" },
      version: VERSION,
    })
  })

  it("範囲外の人数は標準の人数へ退化し、記録する", () => {
    const result = ok(dinnerSettingsFromRow({ ...base, servings: 0 }))
    expect(result.value.servings).toBe(DINNER_SERVINGS_DEFAULT)
    expect(result.degraded).toEqual(["servings"])
  })

  it("壊れた常備品・食事段階の要素は落とす（常備品を捏造しない）", () => {
    const result = ok(dinnerSettingsFromRow({ ...base, staples: ["salt", 1, null], child_stages: { "c-1": 3 } }))
    expect(result.value.stapleIngredientIds).toEqual(["salt"])
    expect(result.value.childStages).toEqual({})
    expect(result.degraded).toEqual(["staples", "child_stages"])
  })

  it("版の無い行は読めない（既定値へ言い換えない）", () => {
    expect(dinnerSettingsFromRow({ ...base, updated_at: undefined })).toEqual({
      ok: false,
      id: null,
      field: "updated_at",
    })
    expect(dinnerSettingsFromRow(null)).toEqual({ ok: false, id: null, field: "row" })
  })

  it("既定値は呼ぶたびに別の値（世帯間で配列を共有しない）で、常備品は空・版は null", () => {
    const first = defaultDinnerSettings()
    first.stapleIngredientIds.push("salt")
    const second = defaultDinnerSettings()
    expect(second).toEqual({
      servings: DINNER_SERVINGS_DEFAULT,
      includeSoup: false,
      maxCookMinutes: null,
      stapleIngredientIds: [],
      childStages: {},
      version: null,
    })
  })

  it("標準の人数は献立の計算の既定と同じ", () => {
    expect(DINNER_SERVINGS_DEFAULT).toBe(DEFAULT_DINNER_SERVINGS)
  })
})

describe("dinnerPlanStateFromRow", () => {
  it("版を数値で読む（bigint が文字列で届いても）", () => {
    expect(ok(dinnerPlanStateFromRow({ revision: "12", grocery_revision: 11 })).value).toEqual({
      revision: 12,
      groceryRevision: 11,
    })
    expect(ok(dinnerPlanStateFromRow({ revision: 0, grocery_revision: null })).value).toEqual({
      revision: 0,
      groceryRevision: null,
    })
  })

  it("版が読めない行を 0 へ言い換えない", () => {
    expect(dinnerPlanStateFromRow({ revision: null })).toEqual({ ok: false, id: null, field: "revision" })
    expect(dinnerPlanStateFromRow({ revision: "x" })).toEqual({ ok: false, id: null, field: "revision" })
    expect(dinnerPlanStateFromRow({ revision: -1 })).toEqual({ ok: false, id: null, field: "revision" })
  })
})

describe("pantryItemToRpc", () => {
  const item = {
    ingredientId: "onion",
    name: " 玉ねぎ ",
    quantity: { amount: 1.005, unit: "kg" as const },
    status: "have" as const,
    useSoon: false,
    storage: null,
    expiresOn: null,
    confirmedOn: "2026-11-11",
  }

  it("RPC が受ける鍵だけを、DB の桁（小数 2 桁）で組み立てる", () => {
    expect(pantryItemToRpc(item)).toEqual({
      ingredient_id: "onion",
      name: "玉ねぎ",
      quantity: 1.01,
      unit: "kg",
      status: "have",
      use_soon: false,
      storage: null,
      expires_on: null,
      confirmed_on: "2026-11-11",
    })
    expect(Object.keys(pantryItemToRpc(item)).sort()).toEqual(
      ["confirmed_on", "expires_on", "ingredient_id", "name", "quantity", "status", "storage", "unit", "use_soon"].sort(),
    )
  })

  it("数量なし・適量・丸めて 0 になる量は「数量不明」として送る（単位だけを残さない）", () => {
    expect(pantryItemToRpc({ ...item, quantity: null })).toMatchObject({ quantity: null, unit: null })
    expect(pantryItemToRpc({ ...item, quantity: { amount: null, unit: "to_taste" } })).toMatchObject({
      quantity: null,
      unit: null,
    })
    expect(pantryItemToRpc({ ...item, quantity: { amount: 0.001, unit: "g" } })).toMatchObject({
      quantity: null,
      unit: null,
    })
  })

  it("写した行をもう一度 RPC の形へ戻すと同じ値になる（再送が同内容として照合される）", () => {
    const stored = ok(pantryItemFromRow(pantryRow({ quantity: "250.50", unit: "g", expires_on: "2026-11-20" }))).value
    expect(pantryItemToRpc(stored)).toEqual({
      ingredient_id: "onion",
      name: "玉ねぎ",
      quantity: 250.5,
      unit: "g",
      status: "have",
      use_soon: false,
      storage: "pantry",
      expires_on: "2026-11-20",
      confirmed_on: "2026-11-10",
    })
  })
})

describe("planEntryToRpc", () => {
  const entry: PlanEntry = {
    id: "e-1",
    date: "2026-11-12",
    role: "main",
    position: 0,
    recipeId: "nikujaga",
    recipeVersion: 2,
    customTitle: null,
    customIngredients: null,
    servings: 3,
    pinned: true,
    status: "confirmed",
    origin: "ai_assisted",
  }

  it("枠の列だけを写す（採点・在庫の突き合わせなど余分なプロパティは送らない）", () => {
    const planned = { ...entry, key: "new:x", title: "肉じゃが", kept: false, stock: null, score: null }
    const rpc = planEntryToRpc(planned)
    expect(rpc).toEqual({
      plan_date: "2026-11-12",
      role: "main",
      position: 0,
      recipe_id: "nikujaga",
      recipe_version: 2,
      custom_title: null,
      custom_ingredients: null,
      servings: 3,
      pinned: true,
      status: "confirmed",
      origin: "ai_assisted",
    })
    expect(planEntryToRpcWithId("e-9", planned)).toEqual({ id: "e-9", ...rpc })
  })

  it("カタログのレシピの枠は custom_* を必ず null にする（DB の排他と同じ）", () => {
    const rpc = planEntryToRpc({
      ...entry,
      customTitle: "残っていた名前",
      customIngredients: [{ ingredientId: "x", quantity: { amount: 1, unit: "g" } }],
    })
    expect(rpc.custom_title).toBeNull()
    expect(rpc.custom_ingredients).toBeNull()
  })

  it("手動料理は版を送らず、材料を RPC が受ける鍵だけで送る", () => {
    const rpc = planEntryToRpc({
      ...entry,
      recipeId: null,
      recipeVersion: 5,
      customTitle: " おでん ",
      origin: "manual",
      customIngredients: [
        { ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" }, optional: false, note: "" },
        { ingredientId: "salt", quantity: { amount: null, unit: "pinch" }, optional: true, note: "仕上げ" },
      ],
    })
    expect(rpc.recipe_version).toBeNull()
    expect(rpc.custom_title).toBe("おでん")
    expect(rpc.custom_ingredients).toEqual([
      { ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" } },
      { ingredientId: "salt", quantity: { amount: null, unit: "pinch" }, optional: true, note: "仕上げ" },
    ])
  })

  it("写した行を RPC の形へ戻すと、行と同じ値になる", () => {
    const row = entryRow({
      recipe_id: null,
      recipe_version: null,
      custom_title: "おでん",
      origin: "manual",
      custom_ingredients: [{ ingredientId: "daikon", quantity: { amount: 0.5, unit: "piece" } }],
    })
    const rpc = planEntryToRpc(ok(planEntryFromRow(row)).value)
    for (const key of Object.keys(rpc) as (keyof typeof rpc)[]) expect(rpc[key]).toEqual(row[key])
  })
})

describe("groceryNeedToRpc / groceryNeedsToRpc", () => {
  const need: GroceryNeed = {
    itemKey: "pork_komagire:mass",
    ingredientId: "pork_komagire",
    name: "豚こま切れ肉",
    section: "meat",
    required: { amount: 199.99996, unit: "g" },
    nonNumeric: [],
    needsStockCheck: false,
    sources: [{ date: "2026-11-12", recipeId: "nikujaga", title: "肉じゃが", quantity: { amount: 200, unit: "g" } }],
  }

  it("DB の鍵（食材ID|単位族）と桁（小数 3 桁）で組み立てる。売場・購入系は送らない", () => {
    const result = groceryNeedToRpc(need)
    expect(result).toEqual({
      ok: true,
      item: {
        item_key: "pork_komagire|mass",
        ingredient_id: "pork_komagire",
        name: "豚こま切れ肉",
        required_quantity: 200,
        unit: "g",
        required_note: null,
        needs_stock_check: false,
        sources: [
          {
            date: "2026-11-12",
            recipeId: "nikujaga",
            title: "肉じゃが",
            quantity: { amount: 200, unit: "g" },
            // 献立を渡さなければ枠は特定しない。正味量は必要量（丸めた後）に一致する
            entryId: null,
            buy: 200,
          },
        ],
      },
    })
  })

  describe("R03 出所の枠 ID と正味量（購入の消化の手がかり）", () => {
    type Source = { date: string; entryId: string | null; buy: number | null }
    const E1 = "e1000000-0000-4000-8000-000000000001"
    const E2 = "e1000000-0000-4000-8000-000000000002"
    const E3 = "e1000000-0000-4000-8000-000000000003"
    const entry = (id: string, date: string, over: Record<string, unknown> = {}) => ({
      id,
      date,
      recipeId: "nikujaga" as string | null,
      customTitle: null as string | null,
      position: 0,
      status: "confirmed" as const,
      ...over,
    })
    const source = (date: string, amount: number | null, over: Record<string, unknown> = {}) => ({
      date,
      recipeId: "nikujaga" as string | null,
      title: "肉じゃが",
      quantity: amount === null ? { amount: null, unit: "pinch" as const } : { amount, unit: "g" as const },
      ...over,
    })
    const sourcesOf = (result: ReturnType<typeof groceryNeedToRpc>): Source[] => {
      if (!result.ok) throw new Error("expected ok")
      return result.item.sources as unknown as Source[]
    }

    it("在庫でまかなう量は早い枠から充て、正味量の合計は必要量に一致する", () => {
      // 300 + 300 + 0.1kg のうち 250g は在庫（必要量 450g）
      const result = groceryNeedToRpc(
        {
          ...need,
          required: { amount: 450, unit: "g" },
          sources: [
            source("2026-11-12", 300),
            source("2026-11-14", 300),
            source("2026-11-15", 0.1, { quantity: { amount: 0.1, unit: "kg" } }),
          ],
        },
        [entry(E1, "2026-11-12"), entry(E2, "2026-11-14"), entry(E3, "2026-11-15")],
      )
      const sources = sourcesOf(result)
      expect(sources.map((item) => [item.entryId, item.buy])).toEqual([
        [E1, 50],
        [E2, 300],
        [E3, 100],
      ])
      expect(sources.reduce((sum, item) => sum + (item.buy ?? 0), 0)).toBe(450)
    })

    it("在庫で全部まかなえる項目（必要量 0）は、どの枠の正味量も 0", () => {
      const result = groceryNeedToRpc(
        { ...need, required: { amount: 0, unit: "g" }, needsStockCheck: true, sources: [source("2026-11-12", 300)] },
        [entry(E1, "2026-11-12")],
      )
      expect(sourcesOf(result)).toMatchObject([{ entryId: E1, buy: 0 }])
    })

    it("数値化しない分（適量・少々）の正味量は null。丸めの端数は最後の数値の出所へ寄せる", () => {
      const result = groceryNeedToRpc(
        {
          ...need,
          required: { amount: 100, unit: "g" },
          sources: [source("2026-11-12", 33.3334), source("2026-11-13", 33.3334), source("2026-11-14", 33.3334), source("2026-11-12", null)],
        },
        [entry(E1, "2026-11-12"), entry(E2, "2026-11-13"), entry(E3, "2026-11-14")],
      )
      const buys = sourcesOf(result).map((item) => item.buy)
      expect(buys).toEqual([33.333, 33.333, 33.334, null])
      expect(sourcesOf(groceryNeedToRpc({ ...need, required: null, nonNumeric: ["少々"], sources: [source("2026-11-12", null)] }))).toMatchObject([
        { buy: null },
      ])
    })

    it("枠は確定した枠だけから、日付と料理（手動料理は料理名）で特定する", () => {
      const manual = source("2026-11-12", 200, { recipeId: null, title: "おでん" })
      const result = groceryNeedToRpc(
        { ...need, required: { amount: 400, unit: "g" }, sources: [source("2026-11-12", 200), manual] },
        [
          entry(E1, "2026-11-12"),
          entry(E2, "2026-11-12", { recipeId: null, customTitle: "おでん", position: 1 }),
          // 対照: 同じ日・同じ料理でも、作った枠・別の日の枠は候補にしない
          entry(E3, "2026-11-12", { status: "cooked", position: 2 }),
          entry("e1000000-0000-4000-8000-000000000004", "2026-11-13"),
        ],
      )
      expect(sourcesOf(result).map((item) => item.entryId)).toEqual([E1, E2])
    })

    it("同じ日に同じ料理の枠が 2 つあるときは枠の順に等分し、割り切れなければ決めつけない（null）", () => {
      const twins = [entry(E2, "2026-11-12", { position: 1 }), entry(E1, "2026-11-12", { position: 0 })]
      const four = groceryNeedToRpc(
        { ...need, required: { amount: 400, unit: "g" }, sources: [1, 2, 3, 4].map(() => source("2026-11-12", 100)) },
        twins,
      )
      expect(sourcesOf(four).map((item) => item.entryId)).toEqual([E1, E1, E2, E2])
      const three = groceryNeedToRpc(
        { ...need, required: { amount: 300, unit: "g" }, sources: [1, 2, 3].map(() => source("2026-11-12", 100)) },
        twins,
      )
      expect(sourcesOf(three).map((item) => item.entryId)).toEqual([null, null, null])
    })

    it("実カタログの献立から作った必要量でも、出所は枠に結び付き、正味量の合計が必要量になる", () => {
      const entries = [
        { ...entry(E1, "2026-11-12"), role: "main" as const, recipeVersion: 1, customIngredients: null, servings: 2, pinned: false, origin: "auto" as const },
        { ...entry(E2, "2026-11-14"), role: "main" as const, recipeVersion: 1, customIngredients: null, servings: 4, pinned: false, origin: "auto" as const },
      ]
      const lookup = getMealLookup()
      const recipe = lookup.recipeById.get("nikujaga")
      if (!recipe) throw new Error("fixture recipe missing")
      const first = recipe.ingredients.find((ingredient) => !ingredient.optional && ingredient.quantity.amount !== null)
      if (!first || first.quantity.amount === null) throw new Error("fixture ingredient missing")
      // 1 品目ぶん（2 人分）の半分だけ在庫に置く → 早い枠が在庫を使い、遅い枠は全量を買う
      const pantry = [
        {
          id: "b1000000-0000-4000-8000-000000000001",
          ingredientId: first.ingredientId,
          name: "在庫",
          quantity: { amount: (first.quantity.amount * 2) / recipe.servings / 2, unit: first.quantity.unit },
          status: "have" as const,
          useSoon: false,
          storage: null,
          expiresOn: null,
          confirmedOn: "2026-11-11",
        },
      ]
      const built = buildGroceryNeeds({ entries, from: "2026-11-11", to: "2026-12-08", pantry, today: "2026-11-11", catalog: lookup })
      const { items, rejected } = groceryNeedsToRpc(built.needs, entries)
      expect(rejected).toEqual([])
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        const sources = item.sources as unknown as Source[]
        expect(sources.every((one) => one.entryId === E1 || one.entryId === E2)).toBe(true)
        if (item.required_quantity !== null) {
          const total = sources.reduce((sum, one) => sum + Math.round((one.buy ?? 0) * 1000), 0)
          expect(total).toBe(Math.round(item.required_quantity * 1000))
        }
      }
      const stocked = items.find((item) => item.ingredient_id === first.ingredientId && item.required_quantity !== null)
      const stockedSources = (stocked?.sources ?? []) as unknown as Source[]
      const early = stockedSources.filter((one) => one.entryId === E1).reduce((sum, one) => sum + (one.buy ?? 0), 0)
      const late = stockedSources.filter((one) => one.entryId === E2).reduce((sum, one) => sum + (one.buy ?? 0), 0)
      // 遅い枠（4 人分）は在庫を使えず全量。早い枠（2 人分）は在庫ぶん少ない
      expect(late).toBeGreaterThan(early * 2)
    })
  })

  it("必要量 0（在庫でまかなえるが確認が要る）と数値化しない分は、量を null で送る", () => {
    const check = groceryNeedToRpc({ ...need, required: { amount: 0, unit: "g" }, needsStockCheck: true })
    expect(check).toMatchObject({ ok: true, item: { required_quantity: null, unit: "g", needs_stock_check: true } })

    const toTaste = groceryNeedToRpc({
      ...need,
      itemKey: "salt:none",
      ingredientId: "salt",
      name: "塩",
      required: null,
      nonNumeric: ["少々", "適量"],
    })
    expect(toTaste).toMatchObject({
      ok: true,
      item: { item_key: "salt|none", required_quantity: null, unit: null, required_note: "少々、適量" },
    })
  })

  it("食材 ID で始まらない鍵・長すぎる名前・大きすぎる量は、切り捨てずに拒む", () => {
    expect(groceryNeedToRpc({ ...need, itemKey: "beef:mass" })).toEqual({ ok: false, reason: "item_key" })
    expect(groceryNeedToRpc({ ...need, itemKey: "manual|x" })).toEqual({ ok: false, reason: "item_key" })
    expect(groceryNeedToRpc({ ...need, name: "あ".repeat(41) })).toEqual({ ok: false, reason: "name" })
    expect(groceryNeedToRpc({ ...need, required: { amount: 10_000_000, unit: "g" } })).toEqual({
      ok: false,
      reason: "quantity_too_large",
    })
  })

  it("一覧は鍵の順に並び、同じ入力からは同じ payload になる（再送の照合が成り立つ）", () => {
    const egg: GroceryNeed = { ...need, itemKey: "egg:count:piece", ingredientId: "egg", name: "卵" }
    const first = groceryNeedsToRpc([need, egg])
    const second = groceryNeedsToRpc([egg, need])
    expect(first.rejected).toEqual([])
    expect(first.items.map((item) => item.item_key)).toEqual(["egg|count:piece", "pork_komagire|mass"])
    expect(JSON.stringify(first.items)).toBe(JSON.stringify(second.items))
  })

  it("送れない項目・重複した鍵は rejected に入り、黙って落とさない", () => {
    const result = groceryNeedsToRpc([need, { ...need }, { ...need, itemKey: "x:mass" }])
    expect(result.items).toHaveLength(1)
    expect(result.rejected).toEqual([
      { itemKey: "pork_komagire:mass", reason: "item_key" },
      { itemKey: "x:mass", reason: "item_key" },
    ])
  })

  it("出所は 40 件まで。料理名は 60 字まで（必要量は変えない）", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      date: "2026-11-12",
      recipeId: null,
      title: index === 0 ? "あ".repeat(70) : `料理${index}`,
      quantity: { amount: 10, unit: "g" as const },
    }))
    const result = groceryNeedToRpc({ ...need, sources: many })
    if (!result.ok) throw new Error("expected ok")
    const sources = result.item.sources as { title: string }[]
    expect(sources).toHaveLength(40)
    expect(sources[0].title).toHaveLength(60)
    expect(result.item.required_quantity).toBe(200)
  })
})

describe("設定・除外・好み・評価の RPC 引数", () => {
  it("設定: 常備品は重複を除いて昇順（DB が保存する形）。世帯 ID は含めない", () => {
    const args = dinnerSettingsToRpcArgs(
      {
        servings: 4,
        includeSoup: true,
        maxCookMinutes: null,
        stapleIngredientIds: ["soy_sauce", "salt", "salt"],
        childStages: { "c-1": "toddler" },
      },
      VERSION,
    )
    expect(args).toEqual({
      p_version: VERSION,
      p_servings: 4,
      p_include_soup: true,
      p_max_cook_minutes: null,
      p_staples: ["salt", "soy_sauce"],
      p_child_stages: { "c-1": "toddler" },
    })
    expect(JSON.stringify(args)).not.toMatch(/household/)
  })

  it("除外: 対象者と対象の種類ごとに、使わない引数を null にする", () => {
    expect(
      foodExclusionToRpcArgs("x-1", {
        reason: "allergy",
        target: { kind: "allergen", allergenId: "egg" },
        subject: { kind: "child", childId: "c-1" },
      }),
    ).toEqual({
      p_id: "x-1",
      p_subject_kind: "child",
      p_subject_profile_id: null,
      p_subject_child_id: "c-1",
      p_reason: "allergy",
      p_target_kind: "allergen",
      p_target_id: "egg",
      p_custom_label: null,
    })
    expect(
      foodExclusionToRpcArgs("x-2", {
        reason: "dislike",
        target: { kind: "custom", label: " パクチー " },
        subject: { kind: "household" },
      }),
    ).toMatchObject({
      p_subject_kind: "household",
      p_subject_profile_id: null,
      p_subject_child_id: null,
      p_target_kind: "custom",
      p_target_id: null,
      p_custom_label: "パクチー",
    })
  })

  it("好み・評価: 持ち主（本人）を引数に含めない（DB が呼び手に固定する）", () => {
    const preference = foodPreferenceToRpcArgs("f-1", null, {
      scope: "personal",
      target: { kind: "tag", id: "fish" },
      sentiment: "dislike",
    })
    expect(preference).toEqual({
      p_id: "f-1",
      p_version: null,
      p_scope: "personal",
      p_target_kind: "tag",
      p_target_id: "fish",
      p_sentiment: "dislike",
    })
    const feedback = dishFeedbackToRpcArgs("d-1", VERSION, {
      recipeId: null,
      dishTitle: " おでん ",
      eatenOn: "2026-11-10",
      taste: 3,
      effort: null,
      again: null,
      excludeFromLearning: true,
    })
    expect(feedback).toEqual({
      p_id: "d-1",
      p_version: VERSION,
      p_recipe_id: null,
      p_dish_title: "おでん",
      p_eaten_on: "2026-11-10",
      p_taste: 3,
      p_effort: null,
      p_again: null,
      p_exclude_from_learning: true,
    })
    expect(Object.keys({ ...preference, ...feedback }).some((key) => /profile/.test(key))).toBe(false)
  })
})
