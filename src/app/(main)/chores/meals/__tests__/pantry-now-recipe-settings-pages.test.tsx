/**
 * 食材・今あるもので・レシピ詳細・設定の page（Server Component）: 世帯のデータを読んで画面へ渡すこと、
 * 読めなかったものを「食材なし」「候補なし」「重なりなし」と偽らないこと、存在しないレシピは notFound。
 *
 * DB はメモリ上の代役（`fake-dinner-db`）、カタログは実物。暦の前提: 2026-11-11 は水曜。
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ALLERGENS } from "@/lib/meals/catalog/allergens"
import {
  createFakeDinnerDb,
  entryRow,
  exclusionRow,
  pantryRow,
  type FakeDinnerDb,
} from "@/lib/meals/server/__tests__/fake-dinner-db"

const { getAuthContext, notFound } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404")
  }),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest: vi.fn(), interpretDinnerWish: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest: vi.fn() }))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  previewPantryText: vi.fn(),
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
  notFound,
}))

import MealsNowPage from "../now/page"
import PantryPage from "../pantry/page"
import MealRecipePage from "../recipes/[id]/page"
import MealSettingsPage from "../settings/page"

const USER = "f5000000-0000-4000-8000-000000000001"
const SPOUSE = "f5000000-0000-4000-8000-000000000002"
const HOUSE = "f5000000-0000-4000-8000-0000000000a1"
const OTHER_HOUSE = "f5000000-0000-4000-8000-0000000000b1"
const CHILD = "f5000000-0000-4000-8000-0000000000c1"
const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"

let db: FakeDinnerDb

function settingsRow(over: Record<string, unknown> = {}) {
  return {
    household_id: HOUSE,
    servings: 2,
    include_soup: false,
    max_cook_minutes: null,
    staples: ["salt", "rice_oil", "sugar", "soy_sauce", "salad_oil"],
    child_stages: {},
    updated_at: VERSION,
    ...over,
  }
}
const recipeProps = (id: string, query: Record<string, string | string[]> = {}) => ({
  params: Promise.resolve({ id }),
  searchParams: Promise.resolve(query),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  // 2026-11-11 12:00 JST
  vi.setSystemTime(new Date("2026-11-11T03:00:00.000Z"))
  getAuthContext.mockReset()
  notFound.mockClear()
  localStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  db = createFakeDinnerDb({ householdId: HOUSE, userId: USER, today: TODAY })
  db.tables.profiles.push(
    { id: USER, household_id: HOUSE, display_name: "たろう", is_approved: true, role: "owner", created_at: VERSION },
    { id: SPOUSE, household_id: HOUSE, display_name: "はなこ", is_approved: true, role: "member", created_at: VERSION },
  )
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.supabase, userId: USER, householdId: HOUSE },
  })
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("/chores/meals/pantry（食材）", () => {
  it("世帯の食材だけを読み、期限・確認の古さをサーバーの今日で判定して出す", async () => {
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ", quantity: 2, unit: "piece", expires_on: "2026-11-08" }),
      pantryRow(HOUSE, { ingredient_id: null, name: "謎の葉", confirmed_on: "2026-10-01" }),
      pantryRow(OTHER_HOUSE, { ingredient_id: "milk", name: "よその牛乳" }),
    )
    render(await PantryPage())
    const rows = screen.getAllByTestId("pantry-item")
    expect(rows).toHaveLength(2)
    expect(screen.queryByText("よその牛乳")).toBeNull()
    const onion = rows.find((row) => within(row).queryByText("玉ねぎ") !== null) as HTMLElement
    expect(within(onion).getByText(/期限切れ（3日超過）/)).toBeInTheDocument()
    expect(within(onion).getByText(/2個/)).toBeInTheDocument()
    const herb = rows.find((row) => within(row).queryByText("謎の葉") !== null) as HTMLElement
    expect(within(herb).getByText("確認から日が経っています")).toBeInTheDocument()
    expect(within(herb).getByText("一覧にない名前（提案の材料に数えません）")).toBeInTheDocument()
    expect(within(herb).getByText(/数量不明/)).toBeInTheDocument()
    // h1 は layout が持つ（page は区画から）
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull()
    expect(screen.getByRole("heading", { level: 2, name: "登録した食材（2件）" })).toBeInTheDocument()
  })

  it("食材が無ければ入力へ誘導する（未登録の表示）", async () => {
    render(await PantryPage())
    expect(screen.getByText("食材がまだ登録されていません")).toBeInTheDocument()
    expect(screen.getByLabelText("家にある食材")).toBeInTheDocument()
  })

  it("解釈できない行が在れば件数を出す（消えたと見せない）", async () => {
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ" }),
      pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ", status: "from_a_newer_version" }),
    )
    render(await PantryPage())
    expect(screen.getAllByTestId("pantry-item")).toHaveLength(1)
    expect(screen.getByRole("alert")).toHaveTextContent("表示できない食材が 1 件あります")
  })

  it("読めなければ throw する（「食材なし」と言い換えない）", async () => {
    db.failTable("pantry_items")
    // R34: page 自身は throw せず、失敗を KeepLastGood へ渡す。直前に読めた内容が無い初回の表示では
    // KeepLastGood が同じ文言で throw して error boundary へ渡す = 描画が失敗する
    const tree = await PantryPage()
    expect(() => render(tree)).toThrow("食材を読み込めませんでした")
    expect(screen.queryByText("食材がまだ登録されていません")).toBeNull()
  })

  it("表示済みの画面の取り直しが失敗しても、書きかけのまとめ入力を消さず、直前の内容を保つ（R34）", async () => {
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "onion", name: "玉ねぎ" }))
    const view = render(await PantryPage())
    const bulk = screen.getByLabelText("家にある食材")
    fireEvent.change(bulk, { target: { value: "卵 1パック\n牛乳 1本" } })
    // 定期の再取得（router.refresh）で page が再実行され、読み取りが一時的に失敗した
    db.failTable("pantry_items")
    view.rerender(await PantryPage())
    expect(screen.getByLabelText("家にある食材")).toBe(bulk)
    expect(bulk).toHaveValue("卵 1パック\n牛乳 1本")
    expect(screen.getAllByTestId("pantry-item")).toHaveLength(1)
    expect(screen.queryByText("食材がまだ登録されていません")).toBeNull()
    expect(screen.getByTestId("stale-content-notice")).toHaveTextContent(
      "最新の内容に更新できませんでした（食材を読み込めませんでした）",
    )
  })

  it("認証の文脈が無ければ何も描かない（遷移は layout が受ける）", async () => {
    getAuthContext.mockResolvedValue({ error: "ログインが必要です", reason: "unauthenticated", context: null })
    expect(await PantryPage()).toBeNull()
    expect(db.calls.from).toEqual([])
  })
})

describe("/chores/meals/now（今あるもので）", () => {
  it("在庫と常備品から揃う料理を出し、買い足しの料理は別の区画に出す", async () => {
    db.tables.dinner_settings.push(settingsRow())
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "salmon", name: "鮭", quantity: 2, unit: "slice" }),
      pantryRow(HOUSE, { ingredient_id: "egg", name: "卵", quantity: 6, unit: "piece" }),
    )
    render(await MealsNowPage())
    const ready = within(screen.getByRole("region", { name: "食材と量が揃う料理" }))
    expect(ready.getAllByTestId("now-candidate").length).toBeGreaterThanOrEqual(2)
    expect(ready.getByRole("link", { name: "鮭の塩焼き" })).toHaveAttribute("href", "/chores/meals/recipes/salmon_shioyaki")
    const buy = within(screen.getByRole("region", { name: "買い足せば作れる" }))
    expect(buy.getAllByTestId("now-candidate")).toHaveLength(3)
    expect(buy.queryByRole("link", { name: "鮭の塩焼き" })).toBeNull()
  })

  it("対照: 常備品が未設定なら、同じ在庫でも揃う候補は 0 件（油・調味料を暗黙に数えない）", async () => {
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "salmon", name: "鮭", quantity: 2, unit: "slice" }),
      pantryRow(HOUSE, { ingredient_id: "egg", name: "卵", quantity: 6, unit: "piece" }),
    )
    render(await MealsNowPage())
    expect(screen.getByTestId("now-ready-count")).toHaveTextContent("揃う候補は 0 件です。")
    expect(screen.getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "常備品を設定する" })).toHaveAttribute("href", "/chores/meals/settings")
  })

  it("在庫が空なら食材の登録へ誘導する", async () => {
    render(await MealsNowPage())
    expect(screen.getByText("食材がまだ登録されていません")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "食材を登録する" })).toHaveAttribute("href", "/chores/meals/pantry")
  })

  it("家族の誰かの除外に当たる料理は、見ている本人の除外でなくても出さない（C-53）", async () => {
    db.tables.dinner_settings.push(settingsRow())
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "egg", name: "卵", quantity: 6, unit: "piece" }))
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { subject_kind: "member", subject_profile_id: SPOUSE, target_id: "egg" }),
    )
    render(await MealsNowPage())
    expect(screen.queryByRole("link", { name: "卵焼き" })).toBeNull()
    expect(screen.getByText(/「使わない食材」の設定に当たる料理 \d+ 件は、どの枠にも入れていません/)).toBeInTheDocument()
  })

  it("使わない食材を読めなければ throw する（除外を知らないまま提案しない）", async () => {
    db.failTable("food_exclusions")
    await expect(MealsNowPage()).rejects.toThrow("使わない食材の設定を読み込めませんでした")
  })

  it("R48 / ④: 候補から献立へ入れられる。今日に献立が在っても、在る料理を残して足せる（在る料理を見せる）", async () => {
    db.tables.dinner_settings.push(settingsRow())
    db.tables.pantry_items.push(
      pantryRow(HOUSE, { ingredient_id: "salmon", name: "鮭", quantity: 2, unit: "slice" }),
      pantryRow(HOUSE, { ingredient_id: "egg", name: "卵", quantity: 6, unit: "piece" }),
    )
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: TODAY, recipe_id: "nikujaga", pinned: true, status: "confirmed" }),
      // よその世帯の献立は数えない
      entryRow(OTHER_HOUSE, { plan_date: "2026-11-12", recipe_id: "tamagoyaki" }),
    )
    render(await MealsNowPage())
    const ready = within(screen.getByRole("region", { name: "食材と量が揃う料理" }))
    await act(async () => {
      fireEvent.click(ready.getByRole("button", { name: "鮭の塩焼きを献立に入れる" }))
    })
    const panel = ready.getByRole("group", { name: "鮭の塩焼きを献立に入れる日" })
    const keeps = within(panel).getByTestId("add-to-plan-keeps")
    expect(keeps).toHaveTextContent("主菜「肉じゃが」（確定・固定）")
    expect(keeps).toHaveTextContent("そのまま残し")
    // 在る料理を残して足せる（以前は在る日には入れられなかった）。確定済みの今日へは確定として足す
    expect(within(panel).getByRole("button", { name: "この日の献立に入れる" })).toBeInTheDocument()
    expect(within(panel).getByText(/確定済みのため、確定として足し/)).toBeInTheDocument()
    // 明日は（この世帯には）献立が無い（よその世帯の献立は数えない）
    fireEvent.change(within(panel).getByLabelText("入れる日"), { target: { value: "2026-11-12" } })
    expect(within(panel).queryByTestId("add-to-plan-keeps")).toBeNull()
    expect(within(panel).getByText(/提案として足します/)).toBeInTheDocument()
    expect(within(panel).getByRole("button", { name: "この日の献立に入れる" })).toBeInTheDocument()
    expect(db.calls.rpc).toEqual([])
  })

  it("R48: 献立を読めなくても提案は出す（「献立に入れる」の釦を出さないだけ）", async () => {
    db.tables.dinner_settings.push(settingsRow())
    db.tables.pantry_items.push(pantryRow(HOUSE, { ingredient_id: "salmon", name: "鮭", quantity: 2, unit: "slice" }))
    db.failTable("dinner_plan_entries")
    render(await MealsNowPage())
    expect(screen.getByRole("link", { name: "鮭の塩焼き" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /献立に入れる/ })).toBeNull()
  })
})

describe("/chores/meals/recipes/[id]（レシピ詳細）", () => {
  it("カタログのレシピを、世帯の人数に合わせて出す", async () => {
    db.tables.dinner_settings.push(settingsRow({ servings: 4 }))
    render(await MealRecipePage(recipeProps("nikujaga")))
    expect(screen.getByRole("heading", { level: 2, name: "肉じゃが" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 3, name: "材料（4人分）" })).toBeInTheDocument()
    expect(notFound).not.toHaveBeenCalled()
  })

  it("人数が未設定なら標準の 2 人分と明示する。`?servings=` で献立の枠の人数を渡せる（範囲外は無視）", async () => {
    const first = render(await MealRecipePage(recipeProps("nikujaga")))
    expect(screen.getByTestId("recipe-default-servings")).toBeInTheDocument()
    first.unmount()

    const second = render(await MealRecipePage(recipeProps("nikujaga", { servings: "6" })))
    expect(screen.getByRole("heading", { level: 3, name: "材料（6人分）" })).toBeInTheDocument()
    expect(screen.queryByTestId("recipe-default-servings")).toBeNull()
    second.unmount()

    for (const bad of ["0", "99", "abc", "2.5", "-1"]) {
      const rendered = render(await MealRecipePage(recipeProps("nikujaga", { servings: bad })))
      expect(screen.getByRole("heading", { level: 3, name: "材料（2人分）" }), bad).toBeInTheDocument()
      rendered.unmount()
    }
    const multi = render(await MealRecipePage(recipeProps("nikujaga", { servings: ["4", "6"] })))
    expect(screen.getByRole("heading", { level: 3, name: "材料（2人分）" })).toBeInTheDocument()
    multi.unmount()
  })

  it("存在しない ID は notFound。世帯のデータを読む前に止める", async () => {
    await expect(MealRecipePage(recipeProps("no_such_recipe"))).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404")
    expect(notFound).toHaveBeenCalledTimes(1)
    expect(db.calls.from).toEqual([])
  })

  it("ID の形でない値（区切り・大文字・長すぎる値・プロトタイプの名前）も notFound", async () => {
    for (const id of ["../settings", "NIKUJAGA", "a".repeat(65), "", "constructor", "__proto__", "nikujaga?x=1"]) {
      notFound.mockClear()
      await expect(MealRecipePage(recipeProps(id)), id).rejects.toThrow("NEXT_HTTP_ERROR_FALLBACK;404")
      expect(notFound, id).toHaveBeenCalledTimes(1)
    }
    expect(db.calls.from).toEqual([])
  })

  it("子ども・食事の段階の設定・除外を読んで、取り分けの案内と警告を出す", async () => {
    db.tables.children.push({ id: CHILD, household_id: HOUSE, name: "はると", birth_date: "2024-05-01", created_at: VERSION })
    // 保護者が「幼児食」に設定した 2 歳 6 か月の子
    db.tables.dinner_settings.push(settingsRow({ child_stages: { [CHILD]: "toddler" } }))
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "wheat" }))
    render(await MealRecipePage(recipeProps("nikujaga")))
    expect(within(screen.getByTestId("recipe-child")).getByText("味付けの前に取り分ける")).toBeInTheDocument()
    expect(screen.getByText(/世帯の「使わない食材」を含みます/)).toBeInTheDocument()
  })

  it("対照（C-61 / C-64）: 食事の段階が未設定の 2 歳児には案内を出さず、設定への導線を出す", async () => {
    db.tables.children.push({ id: CHILD, household_id: HOUSE, name: "はると", birth_date: "2024-05-01", created_at: VERSION })
    db.tables.dinner_settings.push(settingsRow())
    render(await MealRecipePage(recipeProps("nikujaga")))
    const card = within(screen.getByTestId("recipe-child"))
    expect(card.queryByText("味付けの前に取り分ける")).toBeNull()
    expect(card.getByText(/確認できないため、取り分け案内を表示していません/)).toBeInTheDocument()
    expect(card.getByRole("link", { name: "はるとの食事の段階を設定する" })).toHaveAttribute(
      "href",
      "/chores/meals/settings#meal-child-stages",
    )
  })

  it("使わない食材を読めなければ throw する（警告の無い詳細を出さない）", async () => {
    db.failTable("food_exclusions")
    await expect(MealRecipePage(recipeProps("nikujaga"))).rejects.toThrow("使わない食材の設定を読み込めませんでした")
  })

  it("R48: レシピ詳細から献立へ入れられる（対照: 使わない食材に当たる料理には、入れる釦を出さない）", async () => {
    const ok = render(await MealRecipePage(recipeProps("nikujaga")))
    expect(screen.getByRole("button", { name: "肉じゃがを献立に入れる" })).toBeInTheDocument()
    await act(async () => {})
    ok.unmount()

    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "wheat" }))
    render(await MealRecipePage(recipeProps("nikujaga")))
    expect(screen.getByText(/世帯の「使わない食材」を含みます/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /献立に入れる/ })).toBeNull()
  })

  it("R48: 献立を読めなくても詳細は出す（「献立に入れる」の釦を出さないだけ）", async () => {
    db.failTable("dinner_plan_entries")
    render(await MealRecipePage(recipeProps("nikujaga")))
    expect(screen.getByRole("heading", { level: 2, name: "肉じゃが" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /献立に入れる/ })).toBeNull()
  })
})

describe("/chores/meals/settings（設定）", () => {
  it("アレルゲンの件数を実データから出し、未設定の世帯には標準の人数を明示する", async () => {
    render(await MealSettingsPage())
    expect(screen.getByTestId("settings-allergen-count")).toHaveTextContent(`${ALLERGENS.length} 品目`)
    expect(screen.getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    expect(screen.getByTestId("settings-staple-count")).toHaveTextContent("常備品は選ばれていません。")
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull()
  })

  it("子どもの月齢から目安を添えるが、段階は未設定のまま。離乳の一般案内を出典つきで出す", async () => {
    // 2026-04-01 生まれ = 7 か月
    db.tables.children.push({ id: CHILD, household_id: HOUSE, name: "あかり", birth_date: "2026-04-01", created_at: VERSION })
    render(await MealSettingsPage())
    const area = within(screen.getByRole("region", { name: "子どもの食事" }))
    expect(area.getByLabelText(/あかり/)).toHaveValue("")
    expect(area.getByText(/月齢の目安では「離乳中期（生後7〜8か月頃）」に当たります/)).toBeInTheDocument()
    expect(area.getAllByTestId("weaning-stage")).toHaveLength(4)
    expect(area.getByText(/個別のレシピが離乳食に対応していることを示すものではありません/)).toBeInTheDocument()
    expect(area.getByRole("link", { name: /授乳・離乳の支援ガイド/ })).toHaveAttribute("href", expect.stringMatching(/^https:\/\//))
  })

  it("登録済みの除外と重なる献立を、固定の料理も含めて一覧で示す（献立は書き換えない）", async () => {
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { subject_kind: "member", subject_profile_id: SPOUSE, target_id: "egg" }),
    )
    db.tables.dinner_plan_entries.push(
      entryRow(HOUSE, { plan_date: "2026-11-13", recipe_id: "tamagoyaki", role: "side", pinned: true, status: "confirmed" }),
      entryRow(HOUSE, { plan_date: "2026-11-14", recipe_id: "salmon_shioyaki" }),
    )
    const before = JSON.stringify(db.tables.dinner_plan_entries)
    render(await MealSettingsPage())

    const panel = within(screen.getByRole("region", { name: "今の献立との重なり" }))
    const rows = panel.getAllByTestId("settings-plan-conflict")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveTextContent("11月13日（金）")
    expect(rows[0]).toHaveTextContent("卵焼き")
    expect(rows[0]).toHaveTextContent("固定")
    expect(panel.getByRole("link", { name: "献立で選び直す" })).toHaveAttribute("href", "/chores/meals/plan")
    // 対照: 重ならない料理は並ばない
    expect(panel.queryByText("鮭の塩焼き")).toBeNull()
    expect(JSON.stringify(db.tables.dinner_plan_entries)).toBe(before)
    expect(db.calls.rpc).toEqual([])
    expect(screen.getAllByTestId("settings-exclusion")[0]).toHaveTextContent("はなこ")
  })

  it("対照: 重なる献立が無ければ「見つかりませんでした」", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    db.tables.dinner_plan_entries.push(entryRow(HOUSE, { plan_date: "2026-11-14", recipe_id: "salmon_shioyaki" }))
    render(await MealSettingsPage())
    const panel = within(screen.getByRole("region", { name: "今の献立との重なり" }))
    expect(panel.getByText(/使わない食材と重なる料理は見つかりませんでした/)).toBeInTheDocument()
    expect(panel.queryByTestId("settings-plan-conflict")).toBeNull()
  })

  it("献立を読めなくても設定は開き、重なりは「確かめられませんでした」と示す", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    db.failTable("dinner_plan_entries")
    render(await MealSettingsPage())
    expect(screen.getAllByTestId("settings-exclusion")).toHaveLength(1)
    const panel = within(screen.getByRole("region", { name: "今の献立との重なり" }))
    expect(panel.getByRole("alert")).toHaveTextContent("重なりが無いとは限りません")
    expect(panel.queryByText(/見つかりませんでした/)).toBeNull()
  })

  it("読めない除外が在っても、読めた分の一覧と件数を出す。重なりは確かめられない扱い", async () => {
    db.tables.food_exclusions.push(
      exclusionRow(HOUSE, { target_id: "egg" }),
      exclusionRow(HOUSE, { target_kind: "from_a_newer_version", target_id: "x" }),
    )
    render(await MealSettingsPage())
    expect(screen.getAllByTestId("settings-exclusion")).toHaveLength(1)
    expect(screen.getByText(/読み取れない設定が 1 件あります/)).toBeInTheDocument()
    const panel = within(screen.getByRole("region", { name: "今の献立との重なり" }))
    expect(panel.getByRole("alert")).toHaveTextContent("重なりが無いとは限りません")
  })

  it("設定そのものを読めなければ throw する", async () => {
    db.failTable("dinner_settings")
    // R34: 初回の表示の失敗は、KeepLastGood が同じ文言で throw して error boundary へ渡す
    const tree = await MealSettingsPage()
    expect(() => render(tree)).toThrow("ごはんの設定を読み込めませんでした")
  })

  it("表示済みの設定の取り直しが失敗しても画面を倒さず、直前の内容を保って理由を出す（R34）", async () => {
    db.tables.food_exclusions.push(exclusionRow(HOUSE, { target_id: "egg" }))
    const view = render(await MealSettingsPage())
    const row = screen.getByTestId("settings-exclusion")
    db.failTable("dinner_settings")
    view.rerender(await MealSettingsPage())
    expect(screen.getByTestId("settings-exclusion")).toBe(row)
    expect(screen.getByTestId("stale-content-notice")).toHaveTextContent(
      "最新の内容に更新できませんでした（ごはんの設定を読み込めませんでした）",
    )
  })

  it("ほかの家族の個人の好みは見えるが、変更の釦は出さない（見ている本人はサーバーが決める）", async () => {
    db.tables.food_preferences.push(
      {
        id: "f5000000-0000-4000-8000-0000000000d1",
        household_id: HOUSE,
        scope: "personal",
        profile_id: SPOUSE,
        target_kind: "recipe",
        target_id: "nikujaga",
        sentiment: "like",
        updated_at: VERSION,
        created_at: VERSION,
      },
      {
        id: "f5000000-0000-4000-8000-0000000000d2",
        household_id: HOUSE,
        scope: "personal",
        profile_id: USER,
        target_kind: "recipe",
        target_id: "tamagoyaki",
        sentiment: "like",
        updated_at: VERSION,
        created_at: VERSION,
      },
    )
    render(await MealSettingsPage())
    const area = within(screen.getByRole("region", { name: "好み" }))
    expect(within(area.getByRole("list", { name: "ほかの家族（見るだけ）" })).queryByRole("button")).toBeNull()
    expect(within(area.getByRole("list", { name: "自分" })).getAllByRole("button")).toHaveLength(2)
  })
})
