/**
 * 今夜・献立・買い物の page（Server Component）: 世帯のデータを読んで画面へ渡すこと、
 * 読めなかったものを「献立なし」「買うものなし」と偽らないこと。
 *
 * DB はメモリ上の代役（`fake-dinner-db`）、カタログは実物。暦の前提: 2026-11-11 は水曜。
 */
import { act, cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  groceryRow,
  pantryRow,
  type FakeDinnerDb,
} from "@/lib/meals/server/__tests__/fake-dinner-db"

const { getAuthContext } = vi.hoisted(() => ({ getAuthContext: vi.fn() }))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest: vi.fn(), interpretDinnerWish: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  addPantryItems: vi.fn(),
  savePantryItem: vi.fn(),
  deletePantryItem: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: vi.fn(),
  saveFoodExclusion: vi.fn(),
  deleteFoodExclusion: vi.fn(),
  saveFoodPreference: vi.fn(),
  deleteFoodPreference: vi.fn(),
  deleteDishFeedback: vi.fn(),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/chores/meals",
}))

import MealsTonightPage from "../page"
import MealPlanPage, { maxDuration } from "../plan/page"
import MealShoppingPage from "../shopping/page"

const USER = "f4000000-0000-4000-8000-000000000001"
const HOUSE = "f4000000-0000-4000-8000-0000000000a1"
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"

let db: FakeDinnerDb

function signIn() {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.supabase, userId: USER, householdId: HOUSE },
  })
}

const noQuery = Promise.resolve({})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  // 2026-11-11 12:00 JST
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  signIn()
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("/chores/meals（今夜）", () => {
  it("今日の献立が無ければ「まだ決まっていません」と出し、主な 2 つの操作を大きく出す", async () => {
    render(await MealsTonightPage())
    expect(screen.getByTestId("tonight-state")).toHaveTextContent("今日の夕食は、まだ決まっていません。")
    const actions = within(screen.getByRole("navigation", { name: "ごはんの主な操作" })).getAllByRole("link")
    expect(actions.map((link) => link.getAttribute("href"))).toEqual(["/chores/meals/now", "/chores/meals/plan"])
    expect(actions[0]).toHaveTextContent("今あるもので作る")
    expect(actions[1]).toHaveTextContent("1 週間の献立を作る")
    for (const link of actions) expect(link.className).toMatch(/\bmin-h-20\b/)
    expect(screen.getByTestId("tonight-to-buy")).toHaveTextContent("まだ買うものはありません。")
    // h1 は layout が持つ（page は区画から）
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull()
  })

  it("提案中: まだ確定していないと言い、料理を区分つきで出す", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY }),
      entryRow(HOUSE, { plan_date: TODAY, role: "side", position: 1, recipe_id: "spinach_ohitashi" }),
    )
    render(await MealsTonightPage())
    expect(screen.getByTestId("tonight-state")).toHaveTextContent("提案中です。まだ確定していません")
    const dinner = within(screen.getByRole("region", { name: "今日の夕食" }))
    expect(dinner.getByText("肉じゃが")).toBeInTheDocument()
    expect(dinner.getByText("主菜")).toBeInTheDocument()
    expect(dinner.getByText("ほうれん草のおひたし")).toBeInTheDocument()
    expect(dinner.getByRole("link", { name: "献立を見て確定する" })).toHaveAttribute("href", "/chores/meals/plan")
  })

  it("確定済み・未購入の件数: 確定と言い、まだ買うものの件数を出す（購入済みは数えない）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY, status: "confirmed" }))
    db.tables.grocery_items.push(
      groceryRow(HOUSE, { name: "豚こま切れ肉", required_quantity: 500, unit: "g", purchased_quantity: 300 }),
      groceryRow(HOUSE, { name: "玉ねぎ", item_key: "onion|count", ingredient_id: "onion", required_quantity: 2, unit: "piece" }),
      groceryRow(HOUSE, { name: "牛乳", item_key: "milk|volume", ingredient_id: "milk", required_quantity: 500, unit: "ml", purchased_quantity: 500, purchased: true }),
    )
    render(await MealsTonightPage())
    expect(screen.getByTestId("tonight-state")).toHaveTextContent("確定済みです。")
    // 300g 買って 200g 残っている豚肉は、まだ買うものに数える
    expect(screen.getByTestId("tonight-to-buy")).toHaveTextContent("まだ買うものが 2 件あります。")
    expect(screen.getByRole("link", { name: "買い物リストを見る" })).toHaveAttribute("href", "/chores/meals/shopping")
  })

  it("C-55: 使わない食材の設定に当たる料理が今日以降に在れば、警告を出して献立（その日）へ送る", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "oyakodon", pinned: true, status: "confirmed" }),
    )
    render(await MealsTonightPage())
    const warning = within(screen.getByRole("region", { name: "使わない食材の設定と、献立が重なっています" }))
    expect(warning.getByText(/1 品あります/)).toBeInTheDocument()
    expect(warning.getByText(/勝手には置き換えていません/)).toBeInTheDocument()
    expect(warning.getByText(/11\/13（金） 親子丼（固定）/)).toBeInTheDocument()
    expect(warning.getByRole("link", { name: "献立で選び直す" })).toHaveAttribute("href", `/chores/meals/plan?start=${FRIDAY}`)
  })

  it("対照: 除外に当たらない献立では、警告を出さない", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "salmon_shioyaki" }))
    render(await MealsTonightPage())
    expect(screen.queryByRole("region", { name: "使わない食材の設定と、献立が重なっています" })).toBeNull()
  })

  it("読めなかったときは「読み込めませんでした」と出し（献立なし・0 件と偽らない）、主な操作は使える", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    db.failTable("dinner_plan_entries")
    render(await MealsTonightPage())
    const alerts = screen.getAllByRole("alert")
    expect(alerts).toHaveLength(2)
    expect(alerts[0]).toHaveTextContent("今日の献立を読み込めませんでした。今日の献立がないとは限りません。")
    expect(alerts[1]).toHaveTextContent("買い物リストを読み込めませんでした。買い物リストがないとは限りません。")
    expect(screen.queryByTestId("tonight-state")).toBeNull()
    expect(screen.queryByTestId("tonight-to-buy")).toBeNull()
    expect(screen.getByRole("link", { name: /今あるもので作る/ })).toHaveAttribute("href", "/chores/meals/now")
    expect(screen.getByRole("link", { name: /1 週間の献立を作る/ })).toHaveAttribute("href", "/chores/meals/plan")
  })

  it("認証の文脈が無ければ何も描かない（遷移は (main)/layout が受ける）", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await MealsTonightPage()).toBeNull()
  })

  const BABY = "f4000000-0000-4000-8000-0000000000c1"
  const VERSION = "2026-11-11T01:02:03.123456+00:00"
  const honeyTonight = () =>
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, role: "side", recipe_id: "sweet_potato_honey_lemon" }),
      entryRow(HOUSE, { plan_date: TODAY, position: 1, recipe_id: "salmon_shioyaki" }),
    )

  it("R46: 今日の料理に 1 歳未満の子へ与えない食材（はちみつ）が在れば、子どもの名前つきで注意を出す", async () => {
    // 2026-03-01 生まれ = 8 か月
    db.tables.children.push({ id: BABY, household_id: HOUSE, name: "あかり", birth_date: "2026-03-01", created_at: VERSION })
    honeyTonight()
    render(await MealsTonightPage())
    const dinner = within(screen.getByRole("region", { name: "今日の夕食" }))
    const warnings = dinner.getAllByTestId("tonight-age-warning")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toHaveTextContent("はちみつを使います")
    expect(warnings[0]).toHaveTextContent("あかり")
    expect(warnings[0]).toHaveTextContent("1歳未満のため、与えません")
    expect(dinner.queryByTestId("tonight-age-unchecked")).toBeNull()
  })

  it("R46 対照: 1 歳を過ぎた子だけの世帯・子どものいない世帯には、注意を出さない", async () => {
    db.tables.children.push({ id: BABY, household_id: HOUSE, name: "はると", birth_date: "2024-05-01", created_at: VERSION })
    honeyTonight()
    render(await MealsTonightPage())
    expect(screen.queryByTestId("tonight-age-warning")).toBeNull()
    expect(screen.queryByTestId("tonight-age-unchecked")).toBeNull()
  })

  it("R46 危険側: 子どもを読めなかったときは今日の献立を倒さず、年齢の注意は「確認できていません」と出す", async () => {
    honeyTonight()
    db.failTable("children")
    render(await MealsTonightPage())
    const dinner = within(screen.getByRole("region", { name: "今日の夕食" }))
    expect(dinner.getByText("さつまいものはちみつレモン煮")).toBeInTheDocument()
    expect(dinner.queryByTestId("tonight-age-warning")).toBeNull()
    expect(dinner.getByTestId("tonight-age-unchecked")).toHaveTextContent("確認できていません")
  })

  it("R01: 判定できないアレルギーの登録が在れば、献立を確定できない理由を出す（対照: 無ければ出さない）", async () => {
    const plain = render(await MealsTonightPage())
    expect(screen.queryByTestId("exclusion-hold")).toBeNull()
    await act(async () => {})
    plain.unmount()

    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_kind: "custom", target_id: null, custom_label: "マンゴー" }))
    render(await MealsTonightPage())
    const hold = screen.getByTestId("exclusion-hold")
    expect(hold).toHaveTextContent("献立を確定できません。")
    expect(hold).toHaveTextContent("「マンゴー」")
    expect(within(hold).getByRole("link", { name: "使わない食材の設定を開く" })).toHaveAttribute("href", "/chores/meals/settings")
  })
})

describe("/chores/meals/plan（献立）", () => {
  it("AI 補助の待ち時間ぶん、Server Action の期限を延ばしている", () => {
    expect(maxDuration).toBe(30)
  })

  it("今日から 7 日ぶんを読み、設定が無ければ標準の人数と明示し、AI 未設定でも作成できる", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    render(await MealPlanPage({ searchParams: noQuery }))
    expect(screen.getByRole("heading", { level: 2, name: "献立を作る" })).toBeInTheDocument()
    expect(screen.getAllByTestId("plan-day")).toHaveLength(7)
    expect(screen.getAllByTestId("plan-day")[0]).toHaveAttribute("data-date", TODAY)
    expect(screen.getByText("肉じゃが")).toBeInTheDocument()
    expect(screen.getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    expect(screen.getByTestId("meal-ai-status")).toHaveTextContent("AI 補助は設定されていません。自動献立はそのまま使えます。")
    expect(screen.getByRole("button", { name: "7日分の献立を作る" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull()
  })

  it("query の開始日からの 7 日を表示する。壊れた・範囲外の開始日は今日へ倒す", async () => {
    render(await MealPlanPage({ searchParams: Promise.resolve({ start: FRIDAY }) }))
    expect(screen.getAllByTestId("plan-day")[0]).toHaveAttribute("data-date", FRIDAY)
    cleanup()
    for (const start of ["2026-13-40", "2020-01-01", "2027-06-01", ""]) {
      render(await MealPlanPage({ searchParams: Promise.resolve({ start }) }))
      expect(screen.getAllByTestId("plan-day")[0], start).toHaveAttribute("data-date", TODAY)
      await act(async () => {})
      cleanup()
    }
  })

  it("C-55: 使わない食材に当たる固定の料理を、置き換えずに衝突として出す", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE))
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: "oyakodon", pinned: true }))
    render(await MealPlanPage({ searchParams: noQuery }))
    expect(screen.getByText("親子丼")).toBeInTheDocument()
    expect(screen.getByTestId("plan-conflict")).toHaveTextContent("使わない食材の設定に当たります")
    expect(screen.getByTestId("plan-conflict-summary")).toHaveTextContent("1 品あります")
  })

  it("料理のある日の足りない区分を、不足として理由つきで出す", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    render(await MealPlanPage({ searchParams: noQuery }))
    expect(screen.getByTestId("plan-gap")).toHaveTextContent("副菜が不足: 副菜がまだ決まっていません。")
  })

  it("献立を読めなかったときは throw する（「献立はまだありません」と描かない）", async () => {
    db.failTable("dinner_plan_entries")
    // R34: page 自身は throw せず、失敗を KeepLastGood へ渡す。直前に読めた内容が無い初回の表示では
    // KeepLastGood が同じ文言で throw して error boundary へ渡す = 描画が失敗する
    const tree = await MealPlanPage({ searchParams: noQuery })
    expect(() => render(tree)).toThrow("献立を読み込めませんでした")
    expect(screen.queryByText(/献立はまだありません/)).toBeNull()
  })

  it("表示済みの献立の取り直しが失敗しても画面を倒さず、直前の内容を保つ。別の週の失敗では前の週を出さない（R34）", async () => {
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: TODAY }))
    const view = render(await MealPlanPage({ searchParams: noQuery }))
    const gap = screen.getByTestId("plan-gap")
    db.failTable("dinner_plan_entries")
    view.rerender(await MealPlanPage({ searchParams: noQuery }))
    expect(screen.getByTestId("plan-gap")).toBe(gap)
    expect(screen.getByTestId("stale-content-notice")).toHaveTextContent(
      "最新の内容に更新できませんでした（献立を読み込めませんでした）",
    )
    // 対照: 表示する週が替わった失敗は、初回の失敗と同じ扱い（前の週を今の週として出さない）
    const otherWeek = await MealPlanPage({ searchParams: Promise.resolve({ start: FRIDAY }) })
    expect(() => view.rerender(otherWeek)).toThrow("献立を読み込めませんでした")
  })

  it("認証の文脈が無ければ何も描かない", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await MealPlanPage({ searchParams: noQuery })).toBeNull()
  })
})

describe("/chores/meals/shopping（買い物）", () => {
  it("売場ごとのまだ買うもの・購入済み・不要になった項目を出す（300g 購入後の残り 200g を含む）", async () => {
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "salt", name: "塩" }))
    db.tables.grocery_items.push(
      groceryRow(HOUSE, { name: "豚こま切れ肉", required_quantity: 500, unit: "g", purchased_quantity: 300 }),
      groceryRow(HOUSE, { name: "玉ねぎ", item_key: "onion|count", ingredient_id: "onion", required_quantity: 2, unit: "piece" }),
      groceryRow(HOUSE, { name: "牛乳", item_key: "milk|volume", ingredient_id: "milk", required_quantity: 500, unit: "ml", purchased_quantity: 500, purchased: true }),
      groceryRow(HOUSE, { name: "鶏もも肉", item_key: "chicken_thigh|mass", ingredient_id: "chicken_thigh", required_quantity: 300, unit: "g", purchased_quantity: 300, purchased: true, still_needed: false }),
      groceryRow(HOUSE, { name: "ラップ", origin: "manual", item_key: null, ingredient_id: null }),
    )
    render(await MealShoppingPage())
    expect(screen.getByRole("heading", { level: 2, name: "まだ買うもの（3件）" })).toBeInTheDocument()
    const sections = screen.getAllByTestId("shopping-section")
    // 売場は食材の一覧の既定から引く（未知・手動は「その他」）
    expect(sections.map((section) => within(section).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "野菜・きのこ・果物",
      "肉・肉加工品",
      "乾物・缶詰・その他",
    ])
    expect(within(sections[1]).getByTestId("shopping-progress")).toHaveTextContent("購入済み 300g・あと 200g")
    expect(within(sections[2]).getByText("ラップ")).toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "購入済み（1件）" })).getByText("牛乳")).toBeInTheDocument()
    expect(within(screen.getByRole("region", { name: "献立からは不要になった項目（1件）" })).getByText("鶏もも肉")).toBeInTheDocument()
  })

  it("項目が無ければ、献立へ誘導する", async () => {
    render(await MealShoppingPage())
    expect(screen.getByText("買い物リストはまだありません")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "献立を作る" })).toHaveAttribute("href", "/chores/meals/plan")
  })

  it("材料が未登録の確定した手動料理を、自動計算に入っていない料理として出す", async () => {
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: FRIDAY, recipe_id: null, recipe_version: null, custom_title: "おでん", origin: "manual", pinned: true, status: "confirmed" }),
    )
    render(await MealShoppingPage())
    const region = within(screen.getByRole("region", { name: "自動計算に入っていない料理" }))
    expect(region.getByText("11/13（金） おでん")).toBeInTheDocument()
    expect(region.getByRole("link", { name: /おでんの材料を献立の画面で追加/ })).toHaveAttribute(
      "href",
      `/chores/meals/plan?start=${FRIDAY}`,
    )
  })

  it("買い物リストを読めなかったときは throw する（「まだありません」と描かない）", async () => {
    db.failTable("grocery_items")
    // R34: 初回の表示の失敗は、KeepLastGood が同じ文言で throw して error boundary へ渡す
    const tree = await MealShoppingPage()
    expect(() => render(tree)).toThrow("買い物リストを読み込めませんでした")
    expect(screen.queryByText("買い物リストはまだありません")).toBeNull()
  })

  it("表示済みのリストの取り直しが失敗しても画面を倒さず、直前のリストを保って理由を出す（R34）", async () => {
    db.tables.grocery_items.push(groceryRow(HOUSE, { name: "ラップ", origin: "manual", item_key: null, ingredient_id: null }))
    const view = render(await MealShoppingPage())
    const section = screen.getByTestId("shopping-section")
    // 店内の不安定な回線で、定期の再取得の読み取りが一時的に失敗した
    db.failTable("grocery_items")
    view.rerender(await MealShoppingPage())
    expect(screen.getByTestId("shopping-section")).toBe(section)
    expect(within(section).getByText("ラップ")).toBeInTheDocument()
    expect(screen.queryByText("買い物リストはまだありません")).toBeNull()
    expect(screen.getByTestId("stale-content-notice")).toHaveTextContent(
      "最新の内容に更新できませんでした（買い物リストを読み込めませんでした）",
    )
  })

  it("認証の文脈が無ければ何も描かない", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await MealShoppingPage()).toBeNull()
  })
})
