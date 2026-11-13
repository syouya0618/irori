/**
 * 献立・買い物の画面が使う中立モジュール（期間の query・操作の呼び名・保存操作の合併型）の契約。
 */
import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it, vi } from "vitest"

vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({
  saveDinnerRequest: vi.fn(async () => ({ status: "saved", revision: 1, notices: [], grocery: null })),
}))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({
  saveGroceryRequest: vi.fn(async () => ({ status: "saved", notices: [] })),
}))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  addPantryItems: vi.fn(),
  savePantryItem: vi.fn(),
  deletePantryItem: vi.fn(async () => ({ status: "saved", id: "x" })),
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: vi.fn(),
  saveFoodExclusion: vi.fn(),
  deleteFoodExclusion: vi.fn(),
  saveFoodPreference: vi.fn(),
  deleteFoodPreference: vi.fn(),
  deleteDishFeedback: vi.fn(),
}))

import { saveDinnerRequest } from "@/app/(main)/chores/meals/plan/actions"
import { saveGroceryRequest } from "@/app/(main)/chores/meals/shopping/actions"
import type { DinnerRequest, GroceryRequest } from "@/lib/meals/server/plan-requests"

import { isMealRequest, mealRequestArea, runMealRequest } from "../meal-request"
import { conflictTextOfDinner, labelOfDinnerRequest, successTextOfDinnerRequest } from "../plan-labels"
import { planHref, planStartBounds, planStartOptions, resolvePlanStart } from "../plan-query"

const TODAY = "2026-11-11"
const ID = "e1000000-0000-4000-8000-000000000001"
const OP = "91000000-0000-4000-8000-000000000001"
const V = "2026-11-10T00:00:00.123456+00:00"

describe("献立の期間（query）", () => {
  it("開始日が無い・不正・範囲外なら今日（壊れた URL で画面を倒さない）", () => {
    expect(resolvePlanStart(undefined, TODAY)).toBe(TODAY)
    expect(resolvePlanStart("", TODAY)).toBe(TODAY)
    expect(resolvePlanStart("2026-02-30", TODAY)).toBe(TODAY)
    expect(resolvePlanStart("11/13", TODAY)).toBe(TODAY)
    // 範囲: 過ぎた 7 日（記録のため）〜 21 日先（作成の開始の上限）
    expect(planStartBounds(TODAY)).toEqual({ min: "2026-11-04", max: "2026-12-02" })
    expect(resolvePlanStart("2026-11-03", TODAY)).toBe(TODAY)
    expect(resolvePlanStart("2026-12-03", TODAY)).toBe(TODAY)
  })

  it("対照: 範囲内の日はそのまま使う（両端を含む）。配列は最初の値だけを見る", () => {
    expect(resolvePlanStart("2026-11-13", TODAY)).toBe("2026-11-13")
    expect(resolvePlanStart("2026-11-04", TODAY)).toBe("2026-11-04")
    expect(resolvePlanStart("2026-12-02", TODAY)).toBe("2026-12-02")
    expect(resolvePlanStart(["2026-11-14", "2026-11-20"], TODAY)).toBe("2026-11-14")
  })

  it("href は、今日（既定）なら query を付けない", () => {
    expect(planHref(null)).toBe("/chores/meals/plan")
    expect(planHref(TODAY, TODAY)).toBe("/chores/meals/plan")
    expect(planHref("2026-11-13", TODAY)).toBe("/chores/meals/plan?start=2026-11-13")
    expect(planHref("broken", TODAY)).toBe("/chores/meals/plan")
  })

  it("作成の開始日に選べるのは、今日から 21 日先まで（過ぎた日からは作れない）", () => {
    const options = planStartOptions(TODAY)
    expect(options[0]).toBe(TODAY)
    expect(options[options.length - 1]).toBe("2026-12-02")
    expect(options).toHaveLength(22)
    // 月をまたいでも暦どおり（30 日の次は 12/1）
    expect(options).toContain("2026-11-30")
    expect(options[options.indexOf("2026-11-30") + 1]).toBe("2026-12-01")
  })
})

describe("操作の呼び名と結果の文", () => {
  const titleOf = (id: string) => (id === ID ? "肉じゃが" : "")

  it("控えの名前は、何をどの日・どの料理にしたかが分かる", () => {
    expect(
      labelOfDinnerRequest(
        { op: "generate", operationId: OP, expectedRevision: 1, startDate: TODAY, days: 3, constraints: null, mode: "auto" },
        titleOf,
      ),
    ).toBe("11/11（水）から3日分の献立を作成")
    expect(labelOfDinnerRequest({ op: "pin", entryId: ID, version: V, pinned: false }, titleOf)).toBe("「肉じゃが」の固定を解除")
    expect(labelOfDinnerRequest({ op: "move", entryId: ID, version: V, toDate: "2026-11-14" }, titleOf)).toBe(
      "「肉じゃが」を11/14（土）へ移動",
    )
    // 料理が見つからなくても、空の「」にしない
    expect(labelOfDinnerRequest({ op: "cooked", entryId: OP, version: V }, titleOf)).toBe("「料理」を「作った」に変更")
  })

  it("作成の結果は、実際に通った経路だけを名乗る", () => {
    const request: DinnerRequest = {
      op: "generate",
      operationId: OP,
      expectedRevision: 1,
      startDate: TODAY,
      days: 7,
      constraints: null,
      mode: "ai_assisted",
    }
    // 要求が AI 補助でも、サーバーが自動で作ったと答えたら「自動」
    expect(successTextOfDinnerRequest(request, { via: "auto" }, titleOf)).toBe("7日分の献立を作りました（自動）。")
    expect(successTextOfDinnerRequest(request, {}, titleOf)).toBe("7日分の献立を作りました（自動）。")
    expect(successTextOfDinnerRequest(request, { via: "ai_assisted" }, titleOf)).toMatch(/AI 補助で読み取った希望を使いました/)
  })

  it("「作らなかった」は好みの評価に使わないと言い、「作った」は食材を減らしていないと言う", () => {
    expect(successTextOfDinnerRequest({ op: "skipped", entryId: ID, version: V }, {}, titleOf)).toMatch(/好みの評価には使いません/)
    expect(successTextOfDinnerRequest({ op: "cooked", entryId: ID, version: V }, {}, titleOf)).toMatch(/自動では減らしていません/)
  })

  it("衝突の文は、内訳ごとに「上書きしていない」ことと次の行動を言う", () => {
    expect(conflictTextOfDinner({ detail: "stale_plan" })).toMatch(/他の端末で献立が変更されました。上書きはしていません/)
    expect(conflictTextOfDinner({ detail: "constraints_changed" })).toMatch(/読み取った希望は適用していません/)
    expect(conflictTextOfDinner({ detail: "gone" })).toMatch(/既に変更・削除されています/)
    // 内訳が無い・未知の内訳は、献立の版の衝突として扱う
    expect(conflictTextOfDinner({})).toBe(conflictTextOfDinner({ detail: "stale_plan" }))
    expect(conflictTextOfDinner({ detail: "unknown" as never })).toBe(conflictTextOfDinner({ detail: "stale_plan" }))
  })
})

describe("ごはんの保存操作の合併型（どの画面からでも確かめ直せる）", () => {
  const dinnerDelete: DinnerRequest = { op: "delete", entryId: ID, version: V }
  const groceryDelete: GroceryRequest = { op: "delete", id: ID, version: V }

  it("献立と買い物はどちらも op: delete を持つが、1 つの値が両方に読まれることは無い", () => {
    expect(mealRequestArea(dinnerDelete)).toBe("dinner")
    expect(mealRequestArea(groceryDelete)).toBe("grocery")
    // 両方の項目を持つ値は、どちらにも読まない（余分な項目を拒む）
    expect(mealRequestArea({ op: "delete", id: ID, entryId: ID, version: V })).toBeNull()
  })

  it("食材・設定の操作も受ける。どれにも読めない値は受けない", () => {
    expect(mealRequestArea({ op: "pantry_delete", id: ID, version: V })).toBe("basics")
    expect(isMealRequest({ op: "purchase", id: ID, version: V, purchase: { kind: "full" } })).toBe(true)
    expect(isMealRequest({ op: "purchase", id: "not-a-uuid", version: V, purchase: { kind: "full" } })).toBe(false)
    expect(isMealRequest({ op: "generate" })).toBe(false)
    expect(isMealRequest(null)).toBe(false)
    // 世帯 ID を紛れ込ませた要求は読まない
    expect(isMealRequest({ ...dinnerDelete, householdId: ID })).toBe(false)
  })

  it("要求を、その画面の Server Action へだけ送る", async () => {
    await runMealRequest(dinnerDelete)
    expect(saveDinnerRequest).toHaveBeenCalledWith(dinnerDelete)
    expect(saveGroceryRequest).not.toHaveBeenCalled()
    await runMealRequest(groceryDelete)
    expect(saveGroceryRequest).toHaveBeenCalledWith(groceryDelete)
    expect(saveDinnerRequest).toHaveBeenCalledTimes(1)
  })

  it("どれにも読めない値は、どの Action も呼ばずに拒否として返す", async () => {
    vi.mocked(saveDinnerRequest).mockClear()
    vi.mocked(saveGroceryRequest).mockClear()
    const result = await runMealRequest({ op: "delete" } as never)
    expect(result).toEqual({ error: "入力内容を確認してください。", failure: "rejected" })
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    expect(saveGroceryRequest).not.toHaveBeenCalled()
  })
})

describe("モジュールの境界", () => {
  const DIR = path.resolve(__dirname, "..")
  const codeOf = (file: string) =>
    readFileSync(path.join(DIR, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const SHOPPING = path.resolve(DIR, "../shopping")
  const TONIGHT = path.resolve(DIR, "../tonight")
  const sources: [string, string][] = [
    ...["link-styles.ts", "meal-request.ts", "plan-create-card.tsx", "plan-custom-dish-form.tsx", "plan-day-card.tsx", "plan-entry-panel.tsx", "plan-labels.ts", "plan-query.ts", "plan-types.ts", "plan-view.tsx"].map(
      (file): [string, string] => [file, codeOf(file)],
    ),
    ...["shopping-item-panel.tsx", "shopping-item-row.tsx", "shopping-labels.ts", "shopping-manual-form.tsx", "shopping-view.tsx"].map(
      (file): [string, string] => [file, codeOf(path.join("../shopping", file))],
    ),
    ["tonight-view.tsx", codeOf(path.join("../tonight", "tonight-view.tsx"))],
  ]

  it("検査の対象が在る", () => {
    expect(SHOPPING).toMatch(/shopping$/)
    expect(TONIGHT).toMatch(/tonight$/)
    expect(sources).toHaveLength(16)
    for (const [file, code] of sources) expect(code.length, file).toBeGreaterThan(100)
  })

  /** 値の import の相手（`import type { … } from` は build で消えるので数えない）。 */
  const valueImports = (code: string) =>
    [...code.replace(/import type\s+\{[^}]*\}\s+from\s+"[^"]+"/g, "").matchAll(/from\s+"([^"]+)"/g)].map(
      (match) => match[1],
    )
  const HEAVY =
    /meals\/catalog\/(ingredients|recipes|index|allergens|child-guidance)$|meals\/catalog$|meals\/server\/(context|views|plan-views|grocery-sync)$|lib\/supabase/

  it.each(sources)("%s: カタログの重いデータ・ごはんの読み込み・Supabase を値 import しない", (_file, code) => {
    expect(valueImports(code).filter((target) => HEAVY.test(target))).toEqual([])
  })

  it("対照: 上の検査は、型だけの import を数えず、値の import を捕まえる", () => {
    const typeOnly = `import type {\n  DinnerPlanView,\n} from "@/lib/meals/server/plan-views"\n`
    const value = `import { loadDinnerPlanView } from "@/lib/meals/server/plan-views"\nimport { RECIPES } from "@/lib/meals/catalog/recipes"\n`
    const mixed = `import { loadShoppingView, type ShoppingView } from "@/lib/meals/server/plan-views"\n`
    expect(valueImports(typeOnly).filter((target) => HEAVY.test(target))).toEqual([])
    expect(valueImports(value).filter((target) => HEAVY.test(target))).toHaveLength(2)
    expect(valueImports(mixed).filter((target) => HEAVY.test(target))).toHaveLength(1)
  })

  it.each(sources)("%s: transition-all・薄めた focus の輪郭・絵文字を使わない", (_file, code) => {
    expect(code).not.toMatch(/transition-all/)
    expect(code).not.toMatch(/focus(?:-visible|-within)?:(?:ring|outline)-[a-z]+(?:-[a-z]+)*\/\d/)
    expect(code).not.toMatch(/\p{Extended_Pictographic}/u)
    // 保証や監修を装う文言を持たない
    expect(code).not.toMatch(/栄養バランス|管理栄養士|監修済み|アレルゲン不使用|安全です/)
  })

  it("中立モジュールは境界指令を持たない（Server Component から値 import できる）", () => {
    for (const file of ["link-styles.ts", "meal-request.ts", "plan-labels.ts", "plan-query.ts", "plan-types.ts"]) {
      expect(codeOf(file), file).not.toMatch(/^\s*["']use (client|server)["']/m)
    }
    expect(codeOf(path.join("../shopping", "shopping-labels.ts"))).not.toMatch(/^\s*["']use (client|server)["']/m)
    expect(codeOf(path.join("../tonight", "tonight-view.tsx"))).not.toMatch(/^\s*["']use (client|server)["']/m)
    // 対照: 画面の部品は Client Component
    expect(codeOf("plan-view.tsx")).toMatch(/^\s*["']use client["']/m)
  })
})
