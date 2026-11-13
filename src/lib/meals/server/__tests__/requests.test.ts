/**
 * 食材・設定の Server Action の要求の検査（中立モジュール）と、モジュールの境界。
 *
 * - 要求の型ガードは端末の控えを読むときにも使う（`useChoreSave` の `isPayload`）。時計に依らない
 * - 中立モジュールはカタログ（食材辞書・レシピ）を import しない（Client の bundle を重くしない）
 * - `"use server"` のファイルは async 関数だけを export する（定数・型を出すとビルドが壊れる）
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MEAL_ID_CONFLICT_MESSAGE,
  MEAL_RESULT_UNKNOWN_MESSAGE,
  hasOnlyKeys,
  isCatalogIdText,
  isMealLabel,
  isMealUuid,
  mealFailureOf,
  settleMealAction,
} from "../meal-input"
import {
  PANTRY_INPUT_MESSAGES,
  addPantryItemsIssue,
  isAddPantryItemsRequest,
  isDeletePantryItemRequest,
  isSavePantryItemRequest,
} from "../pantry-requests"
import {
  SETTINGS_INPUT_MESSAGES,
  isIdOnlyRequest,
  isSaveDinnerSettingsRequest,
  isSaveFoodExclusionRequest,
  isSaveFoodPreferenceRequest,
} from "../settings-requests"

const ID = "b1000000-0000-4000-8000-000000000001"
const VERSION = "2026-11-11T01:02:03.123456+00:00"

const fields = {
  ingredientId: null,
  name: "玉ねぎ",
  quantity: null,
  status: "have",
  useSoon: false,
  storage: null,
  expiresOn: null,
  confirmedOn: "2026-11-11",
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("入力の部品", () => {
  it("UUID は DB と同じ形（小文字の 16 進）だけ", () => {
    expect(isMealUuid(ID)).toBe(true)
    expect(isMealUuid(ID.toUpperCase())).toBe(false)
    expect(isMealUuid(`${ID} `)).toBe(false)
    expect(isMealUuid(null)).toBe(false)
  })

  it("カタログ ID は区切り文字を含められない", () => {
    expect(isCatalogIdText("soy_sauce")).toBe(true)
    expect(isCatalogIdText("a".repeat(64))).toBe(true)
    expect(isCatalogIdText("a".repeat(65))).toBe(false)
    expect(isCatalogIdText("onion|count:piece")).toBe(false)
    expect(isCatalogIdText("salt,sugar")).toBe(false)
    expect(isCatalogIdText("")).toBe(false)
  })

  it("表示用の文字列は前後の空白を除いた長さ（コードポイント）で数える", () => {
    expect(isMealLabel(" 卵 ", 1)).toBe(true)
    expect(isMealLabel("𩸽の開き", 4)).toBe(true)
    expect(isMealLabel("𩸽の開き", 3)).toBe(false)
    expect(isMealLabel("　", 5)).toBe(false)
    expect(isMealLabel("卵\t牛乳", 10)).toBe(false)
    expect(isMealLabel(12, 10)).toBe(false)
  })

  it("余分な項目を見つける（対照: 過不足の無い object は通す）", () => {
    expect(hasOnlyKeys({ id: ID }, ["id", "version"])).toBe(true)
    expect(hasOnlyKeys({ id: ID, householdId: "x" }, ["id", "version"])).toBe(false)
  })
})

describe("失敗の分類", () => {
  it.each([
    ["23505", "conflict", MEAL_ID_CONFLICT_MESSAGE],
    ["42501", "rejected", null],
    ["22023", "rejected", null],
    ["23514", "rejected", null],
    ["PGRST301", "rejected", null],
    ["57014", "unknown", null],
    ["", "unknown", null],
    [undefined, "unknown", null],
  ] as const)("code %s → %s", (code, failure, message) => {
    const result = mealFailureOf({ code, message: "secret detail from the database" })
    expect(result.failure).toBe(failure)
    expect(result.error).not.toContain("secret detail")
    if (message !== null) expect(result.error).toBe(message)
  })

  it("権限の拒否には、呼び出し側の文言を使える", () => {
    expect(mealFailureOf({ code: "42501" }, { forbidden: "ほかの家族の設定です。" })).toEqual({
      error: "ほかの家族の設定です。",
      failure: "rejected",
    })
    // 対照: ほかの code には効かない
    expect(mealFailureOf({ code: "22023" }, { forbidden: "ほかの家族の設定です。" }).error).not.toBe("ほかの家族の設定です。")
  })

  it("例外は結果不明として返す（拒否と言い換えない）。戻り値はそのまま通す", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const thrown = await settleMealAction("save", "user-1", async () => {
      throw new TypeError("fetch failed")
    })
    expect(thrown).toEqual({ error: MEAL_RESULT_UNKNOWN_MESSAGE, failure: "unknown" })
    expect(await settleMealAction("save", "user-1", async () => ({ status: "saved" as const }))).toEqual({ status: "saved" })
    const rejected = { error: "入力内容を確認してください。", failure: "rejected" as const }
    expect(await settleMealAction("save", "user-1", async () => rejected)).toBe(rejected)
  })
})

describe("端末の控えを読むときの型ガード", () => {
  it("食材の要求: 正しい形だけを通す", () => {
    expect(isAddPantryItemsRequest({ items: [{ id: ID, ...fields }] })).toBe(true)
    expect(isAddPantryItemsRequest({ items: [{ id: ID, ...fields, householdId: "x" }] })).toBe(false)
    expect(isAddPantryItemsRequest({ items: [] })).toBe(false)
    expect(isSavePantryItemRequest({ id: ID, version: VERSION, item: fields })).toBe(true)
    expect(isSavePantryItemRequest({ id: ID, version: null, item: fields })).toBe(true)
    expect(isSavePantryItemRequest({ id: ID, version: VERSION, item: { ...fields, status: "plenty" } })).toBe(false)
    expect(isDeletePantryItemRequest({ id: ID, version: VERSION })).toBe(true)
    expect(isDeletePantryItemRequest({ id: ID, version: null })).toBe(false)
  })

  it("時計に依らない: 未来の最終確認日も「読める控え」（今日以前かは Server Action と DB が見る）", () => {
    expect(isAddPantryItemsRequest({ items: [{ id: ID, ...fields, confirmedOn: "2099-01-01" }] })).toBe(true)
    // 対照: 実在しない日付は形の誤り
    expect(addPantryItemsIssue({ items: [{ id: ID, ...fields, confirmedOn: "2099-02-30" }] })).toBe("confirmed_on")
  })

  it("設定・除外・好みの要求: 正しい形だけを通す", () => {
    const settings = { version: null, servings: 2, includeSoup: false, maxCookMinutes: null, stapleIngredientIds: [], childStages: {} }
    expect(isSaveDinnerSettingsRequest(settings)).toBe(true)
    expect(isSaveDinnerSettingsRequest({ ...settings, servings: 0 })).toBe(false)
    expect(isSaveDinnerSettingsRequest({ ...settings, updatedBy: ID })).toBe(false)

    const exclusion = { id: ID, reason: "allergy", target: { kind: "allergen", allergenId: "egg" }, subject: { kind: "household" } }
    expect(isSaveFoodExclusionRequest(exclusion)).toBe(true)
    expect(isSaveFoodExclusionRequest({ ...exclusion, subject: { kind: "member" } })).toBe(false)

    const preference = { id: ID, version: null, scope: "personal", target: { kind: "tag", id: "fish" }, sentiment: "like" }
    expect(isSaveFoodPreferenceRequest(preference)).toBe(true)
    expect(isSaveFoodPreferenceRequest({ ...preference, profileId: ID })).toBe(false)

    expect(isIdOnlyRequest({ id: ID })).toBe(true)
    expect(isIdOnlyRequest({ id: ID, version: VERSION })).toBe(false)
  })

  it("拒否の文言は、どの理由にも用意してある", () => {
    for (const message of [...Object.values(PANTRY_INPUT_MESSAGES), ...Object.values(SETTINGS_INPUT_MESSAGES)]) {
      expect(message).toMatch(/。$/)
    }
  })
})

describe("モジュールの境界", () => {
  const root = path.resolve(__dirname, "../../../../..")
  const read = (file: string) => readFileSync(path.join(root, file), "utf8")
  /** コメントを除いた実コード（文書中の語を実コードと混同しないため）。 */
  const codeOnly = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const importsOf = (text: string) => [...codeOnly(text).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
  /** `export` で始まる宣言の頭（`export async function` など）。 */
  const exportHeads = (text: string) =>
    [...codeOnly(text).matchAll(/^export\s+(?:default\s+)?(async\s+function|function|const|let|type|interface|class|\{|\*)/gm)].map(
      (match) => match[1],
    )

  const NEUTRAL = [
    "src/lib/meals/server/meal-input.ts",
    "src/lib/meals/server/pantry-requests.ts",
    "src/lib/meals/server/settings-requests.ts",
  ]
  const ACTIONS = [
    "src/app/(main)/chores/meals/pantry/actions.ts",
    "src/app/(main)/chores/meals/settings/actions.ts",
  ]

  it("検査そのものの対照: 定数の export と、コメントの外の import を拾う", () => {
    const sample = `"use server"\n// export const HIDDEN = 1\nexport const LIMIT = 3\nexport async function run() {}\nimport { a } from "../catalog/recipes"\n`
    expect(exportHeads(sample)).toEqual(["const", "async function"])
    expect(importsOf(sample)).toEqual(["../catalog/recipes"])
  })

  it.each(NEUTRAL)("%s は境界指令を持たず、カタログのデータ・サーバー専用モジュールを import しない", (file) => {
    const source = read(file)
    expect(codeOnly(source)).not.toMatch(/^\s*["']use (client|server)["']/m)
    const forbidden = importsOf(source).filter(
      (target) =>
        /catalog\/(ingredients|recipes|allergens|index)$/.test(target) ||
        target.endsWith("/catalog") ||
        /\.\/(context|views)$/.test(target) ||
        target.startsWith("@/lib/supabase") ||
        target.startsWith("next/"),
    )
    expect(forbidden).toEqual([])
  })

  it.each(ACTIONS)("%s は \"use server\" で始まり、async 関数だけを export する", (file) => {
    const source = read(file)
    expect(source.startsWith('"use server"\n')).toBe(true)
    const heads = exportHeads(source)
    expect(heads.length).toBeGreaterThan(0)
    expect(heads.filter((head) => head !== "async function")).toEqual([])
  })

  it.each(ACTIONS)("%s のどの Server Action も、最初に getAuthContext() を呼ぶ", (file) => {
    const code = codeOnly(read(file))
    const bodies = code.split(/^export async function /m).slice(1)
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      const name = body.slice(0, body.indexOf("("))
      const start = body.indexOf("{\n")
      const firstStatement = body.slice(start + 2).trimStart().split("\n")[0]
      expect(`${name}: ${firstStatement}`).toBe(`${name}: const auth = await getAuthContext()`)
    }
  })
})
