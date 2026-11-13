/**
 * レシピ詳細の表示（要件台帳 C-51 / C-54 / C-62 / C-64 / C-65 / C-66 / C-67、V-C4、V-UI）。
 *
 * 同梱カタログ（実データ）で `buildRecipeDetailView` を通した結果を描いて確かめる。
 * 暦の前提: 今日は 2026-11-11。2024-05-01 生まれは 2 歳 6 か月、2026-05-01 生まれは 6 か月。
 */
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CHILD_GUIDANCE_DISCLAIMER, CHILD_SERVING_UNSUPPORTED_TEXT } from "@/lib/meals/catalog/child-guidance"
import { CHILD_SERVING_RECIPES } from "@/lib/meals/catalog"
import { allergenProfileOf } from "@/lib/meals/lookup"
import { getMealLookup, type MealChildProfile } from "@/lib/meals/server/context"
import { defaultDinnerSettings, type StoredFoodExclusion } from "@/lib/meals/server/rows"
import { buildRecipeDetailView, type RecipeDetailContext, type RecipeDetailView } from "@/lib/meals/server/views"

import { RecipeDetail } from "../recipe-detail"

const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const ME = "a1000000-0000-4000-8000-000000000001"
const SPOUSE = "a1000000-0000-4000-8000-000000000002"
const TODDLER = "a2000000-0000-4000-8000-000000000001"
const BABY = "a2000000-0000-4000-8000-000000000002"
const UNKNOWN_AGE = "a2000000-0000-4000-8000-000000000003"

const toddler: MealChildProfile = { id: TODDLER, name: "はると", birthDate: "2024-05-01" }
const baby: MealChildProfile = { id: BABY, name: "あかり", birthDate: "2026-05-01" }
const unknownAge: MealChildProfile = { id: UNKNOWN_AGE, name: "みお", birthDate: null }
/** 保護者が「はると」の食事の段階を「幼児食」に設定した世帯の設定。 */
const toddlerStageSettings = { ...defaultDinnerSettings(), childStages: { [TODDLER]: "toddler" }, version: VERSION }

function context(over: Partial<RecipeDetailContext> = {}): RecipeDetailContext {
  return {
    householdId: "household-a",
    today: TODAY,
    lookup: getMealLookup(),
    unreadable: {},
    issues: [],
    settings: { ...defaultDinnerSettings(), version: VERSION },
    settingsMissing: false,
    exclusions: [],
    children: [],
    members: [
      { id: ME, displayName: "たろう" },
      { id: SPOUSE, displayName: "はなこ" },
    ],
    ...over,
  }
}

function detail(recipeId: string, over: Partial<RecipeDetailContext> = {}, servings?: number): RecipeDetailView {
  const view = buildRecipeDetailView(context(over), recipeId, { servings })
  if (view === null) throw new Error(`recipe ${recipeId} is not in the catalog`)
  return view
}

const childCard = (name: string) =>
  screen.getAllByTestId("recipe-child").find((card) => within(card).queryByText(name) !== null) as HTMLElement
const ingredientRow = (name: string) =>
  screen.getAllByTestId("recipe-ingredient").find((row) => row.textContent?.startsWith(name)) as HTMLElement

afterEach(() => {
  cleanup()
})

describe("材料・手順・人数", () => {
  it("料理名・区分・時間・材料・手順を出す。材料の量は世帯の人数に合わせる", () => {
    const view = detail("nikujaga", { settings: { ...defaultDinnerSettings(), servings: 4, version: VERSION } })
    render(<RecipeDetail view={view} />)

    expect(screen.getByRole("heading", { level: 2, name: "肉じゃが" })).toBeInTheDocument()
    expect(screen.getByText(/主菜・約35分/)).toBeInTheDocument()
    expect(screen.getByRole("heading", { level: 3, name: "材料（4人分）" })).toBeInTheDocument()
    // 元のレシピ（2 人分 150g）を 4 人分へ
    expect(ingredientRow("豚こま切れ肉")).toHaveTextContent("300g")
    expect(screen.getByText(/元のレシピ（2人分）の分量を、4人分に合わせて計算しています/)).toBeInTheDocument()
    expect(screen.getAllByTestId("recipe-ingredient")).toHaveLength(view.ingredients.length)
    expect(screen.getAllByTestId("recipe-step")).toHaveLength(view.steps.length)
    expect(screen.getAllByTestId("recipe-step")[0]).toHaveTextContent(view.steps[0])
  })

  it("人数が未設定なら「標準 2 人分」と明示する（対照: 設定済みなら出さない）", () => {
    const missing = render(<RecipeDetail view={detail("nikujaga", { settingsMissing: true })} />)
    expect(screen.getByTestId("recipe-default-servings")).toHaveTextContent("標準の2人分で表示しています")
    expect(ingredientRow("豚こま切れ肉")).toHaveTextContent("150g")
    missing.unmount()

    render(<RecipeDetail view={detail("nikujaga")} />)
    expect(screen.queryByTestId("recipe-default-servings")).not.toBeInTheDocument()
  })
})

describe("C-51 / C-54 含まれるアレルゲンと「原材料の確認が必要」", () => {
  it("アレルゲンの件数と内訳は食材辞書から導いたもの（画面に数字を埋め込まない）", () => {
    const view = detail("nikujaga")
    // 独立に、食材辞書から数え直す
    const lookup = getMealLookup()
    const expected = new Set<string>()
    for (const ingredient of lookup.recipeById.get("nikujaga")?.ingredients ?? []) {
      for (const id of allergenProfileOf(ingredient.ingredientId, lookup.index).allergens) expected.add(id)
    }
    expect(expected.size).toBeGreaterThan(0)

    render(<RecipeDetail view={view} />)
    const rows = screen.getAllByTestId("recipe-allergen")
    expect(rows).toHaveLength(expected.size)
    expect(
      screen.getByRole("heading", { level: 3, name: `含まれるアレルゲン（食材辞書から ${expected.size} 品目）` }),
    ).toBeInTheDocument()
    // しょうゆ由来の小麦・大豆（派生食材のアレルゲン）が、材料名と一緒に出る
    const wheat = rows.find((row) => row.textContent?.startsWith("小麦")) as HTMLElement
    expect(wheat).toHaveTextContent("特定原材料")
    expect(wheat).toHaveTextContent("しょうゆ")
    expect(rows.some((row) => row.textContent?.startsWith("大豆"))).toBe(true)
    // 判定の限界（商品ごとの原材料表示までは保証しない）を必ず添える
    expect(screen.getByText(/商品ごとの原材料や製造時の混入までは確認できません/)).toBeInTheDocument()
  })

  it("対照: 別の料理では件数が変わる（固定の数字ではない）", () => {
    const salmon = detail("salmon_shioyaki")
    const nikujaga = detail("nikujaga")
    expect(salmon.allergens.length).not.toBe(nikujaga.allergens.length)
    render(<RecipeDetail view={salmon} />)
    expect(screen.getAllByTestId("recipe-allergen")).toHaveLength(salmon.allergens.length)
    expect(
      screen.getByRole("heading", { level: 3, name: `含まれるアレルゲン（食材辞書から ${salmon.allergens.length} 品目）` }),
    ).toBeInTheDocument()
  })

  it("商品によって原材料が異なる材料には「原材料の確認が必要」の印を付ける（対照: 印の無い材料）", () => {
    const view = detail("curry_rice")
    expect(view.labelCheckIngredientNames.length).toBeGreaterThan(0)
    render(<RecipeDetail view={view} />)
    const flagged = view.ingredients.find((ingredient) => ingredient.labelCheck !== null)
    const plain = view.ingredients.find((ingredient) => ingredient.labelCheck === null)
    expect(flagged && plain).toBeTruthy()
    expect(within(ingredientRow(flagged?.name ?? "")).getByText("原材料の確認が必要")).toBeInTheDocument()
    expect(within(ingredientRow(plain?.name ?? "")).queryByText("原材料の確認が必要")).not.toBeInTheDocument()
    expect(screen.getByText(new RegExp(`原材料の確認が必要な材料: .*${view.labelCheckIngredientNames[0]}`))).toBeInTheDocument()
  })
})

describe("C-53 世帯の「使わない食材」に触れる料理", () => {
  const wheat: StoredFoodExclusion = {
    id: "exclusion-1",
    reason: "allergy",
    target: { kind: "allergen", allergenId: "wheat" },
    subject: { kind: "member", profileId: SPOUSE },
    version: VERSION,
  }

  it("家族の誰かの除外に当たれば警告し、誰の・何の・どの材料かを示す", () => {
    render(<RecipeDetail view={detail("nikujaga", { exclusions: [wheat] })} />)
    const alert = screen
      .getAllByRole("alert")
      .find((node) => node.textContent?.includes("使わない食材」を含みます")) as HTMLElement
    expect(alert).toHaveTextContent("アレルギー（はなこ）: 小麦")
    expect(alert).toHaveTextContent("しょうゆ")
    expect(within(ingredientRow("しょうゆ")).getByText("使わない食材")).toBeInTheDocument()
    expect(screen.getByText("使わない食材を含む")).toBeInTheDocument()
  })

  it("対照: 除外が無ければ警告も印も出さない（「安全」「不使用」とも書かない）", () => {
    const { container } = render(<RecipeDetail view={detail("nikujaga")} />)
    expect(screen.queryByText(/使わない食材」を含みます/)).not.toBeInTheDocument()
    expect(within(ingredientRow("しょうゆ")).queryByText("使わない食材")).not.toBeInTheDocument()
    expect(container.textContent).not.toMatch(/安全|不使用|アレルゲンフリー/)
  })
})

describe("C-62 / C-64 / C-66 / C-67 取り分け", () => {
  it("肯定側: 対応レシピ × 保護者が「幼児食」に設定した 2 歳以降の子には、味付け前に取り分ける工程・注意・出典・監修を受けていない旨を出す", () => {
    const view = detail("nikujaga", { children: [toddler], settings: toddlerStageSettings })
    const recipe = getMealLookup().recipeById.get("nikujaga")
    const guide = recipe?.childServing
    expect(guide).toBeDefined()
    render(<RecipeDetail view={view} />)

    const card = childCard("はると")
    expect(within(card).getByText(/2歳6か月/)).toBeInTheDocument()
    expect(within(card).getByText(/食事の段階: 幼児食/)).toBeInTheDocument()
    expect(within(card).getByText(/取り分けの案内（幼児食）/)).toBeInTheDocument()
    expect(within(card).getByText("保護者が設定した食事の段階にもとづいて表示しています。")).toBeInTheDocument()
    expect(within(card).getByText("味付けの前に取り分ける")).toBeInTheDocument()
    // 案内が出ているときは、設定への導線を重ねて出さない
    expect(within(card).queryByRole("link", { name: /食事の段階を設定する/ })).not.toBeInTheDocument()
    // どの手順の前か（データの位置どおり。0 始まり → 表示は 1 始まり）
    const step = recipe?.steps[guide?.separateBeforeStep ?? 0] ?? ""
    expect(within(card).getByText(new RegExp(`手順 ${(guide?.separateBeforeStep ?? 0) + 1}`))).toHaveTextContent(step)
    for (const text of guide?.instructions ?? []) expect(within(card).getByText(text)).toBeInTheDocument()
    expect(within(card).getByText("形・やわらかさ・加熱の注意")).toBeInTheDocument()
    for (const text of guide?.cautions ?? []) expect(within(card).getByText(text)).toBeInTheDocument()
    // 出典（データに在るものだけ）
    const sources = within(card).getAllByTestId("guidance-source")
    expect(sources.length).toBeGreaterThan(0)
    for (const source of sources) {
      expect(within(source).getByRole("link")).toHaveAttribute("href", expect.stringMatching(/^https:\/\//))
      expect(source).toHaveTextContent("確認日")
    }
    // 監修を受けていない旨と、対象範囲
    expect(screen.getByText(CHILD_GUIDANCE_DISCLAIMER)).toBeInTheDocument()
    expect(CHILD_GUIDANCE_DISCLAIMER).toContain("専門家の監修は受けていません")
    expect(screen.getByText(/取り分けの案内は、離乳食を終えた2歳以降の幼児向けです/)).toBeInTheDocument()
  })

  it("肯定側: 初期カタログの取り分け対応レシピは 3 件以上あり、どれも段階を設定した 2 歳以降の子に案内を出す", () => {
    expect(CHILD_SERVING_RECIPES.length).toBeGreaterThanOrEqual(3)
    for (const recipe of CHILD_SERVING_RECIPES) {
      const { unmount } = render(
        <RecipeDetail view={detail(recipe.id, { children: [toddler], settings: toddlerStageSettings })} />,
      )
      expect(within(childCard("はると")).getByText("味付けの前に取り分ける"), recipe.id).toBeInTheDocument()
      unmount()
    }
  })

  it("否定側（C-61 / C-64）: 食事の段階が未設定の 2 歳児には、対応レシピでも案内を出さず、理由と設定への導線を出す", () => {
    // 月齢は対象（2 歳 6 か月）でも、保護者が段階を設定していなければ月齢だけからは出さない
    for (const recipe of CHILD_SERVING_RECIPES) {
      const { unmount, container } = render(<RecipeDetail view={detail(recipe.id, { children: [toddler] })} />)
      const card = childCard("はると")
      expect(within(card).getByText(/2歳6か月・食事の段階: 未設定/), recipe.id).toBeInTheDocument()
      expect(within(card).queryByText("味付けの前に取り分ける"), recipe.id).not.toBeInTheDocument()
      expect(within(card).queryByText(/取り分けの案内（/), recipe.id).not.toBeInTheDocument()
      expect(within(card).queryByText("形・やわらかさ・加熱の注意"), recipe.id).not.toBeInTheDocument()
      // 理由（確認できない）と、どこで設定できるか
      expect(within(card).getByText(/確認できないため、取り分け案内を表示していません/), recipe.id).toBeInTheDocument()
      expect(within(card).getByText(/食事の段階は保護者が選びます（月齢だけでは決めていません）/)).toBeInTheDocument()
      const link = within(card).getByRole("link", { name: "はるとの食事の段階を設定する" })
      expect(link).toHaveAttribute("href", "/chores/meals/settings#meal-child-stages")
      expect(link.className).toContain("min-h-11")
      // 生年月日は登録済みなので、生年月日の登録へは送らない
      expect(within(card).queryByRole("link", { name: /生年月日を登録する/ })).not.toBeInTheDocument()
      // 「月齢だけからの目安」という表示は、もう出ない（到達しない分岐を残さない）
      expect(container.textContent).not.toMatch(/月齢だけからの目安/)
      unmount()
    }
  })

  it("否定側: 取り分けに対応していない料理は、段階を設定した 2 歳以降の子でも「未対応」と出し、工程も設定への導線も出さない", () => {
    expect(getMealLookup().recipeById.get("ginger_pork")?.childServing).toBeUndefined()
    render(<RecipeDetail view={detail("ginger_pork", { children: [toddler], settings: toddlerStageSettings })} />)
    const card = childCard("はると")
    expect(within(card).getByText(CHILD_SERVING_UNSUPPORTED_TEXT)).toBeInTheDocument()
    expect(within(card).queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    expect(within(card).queryByText(/取り分けの案内（/)).not.toBeInTheDocument()
    // 料理が未対応のときは、段階を設定しても出ない。設定へ誘導しない
    expect(within(card).queryByRole("link")).not.toBeInTheDocument()
  })

  it("否定側: 対応レシピでも、0 歳の子には案内を出さず、対象外の理由を出す", () => {
    render(<RecipeDetail view={detail("nikujaga", { children: [baby] })} />)
    const card = childCard("あかり")
    expect(within(card).getByText(/6か月/)).toBeInTheDocument()
    expect(within(card).queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    expect(within(card).getByText(/対象外です/)).toBeInTheDocument()
  })

  it("否定側: 生年月日も食事の段階も未設定の子には、案内を出さず、確認できない旨を出す", () => {
    render(<RecipeDetail view={detail("nikujaga", { children: [unknownAge] })} />)
    const card = childCard("みお")
    expect(within(card).getByText(/生年月日は未登録・食事の段階: 未設定/)).toBeInTheDocument()
    expect(within(card).queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    expect(within(card).getByText(/確認できないため、取り分け案内を表示していません/)).toBeInTheDocument()
    // 段階の設定と、生年月日の登録の両方へ送る
    expect(within(card).getByRole("link", { name: "みおの食事の段階を設定する" })).toHaveAttribute(
      "href",
      "/chores/meals/settings#meal-child-stages",
    )
    expect(within(card).getByRole("link", { name: "みおの生年月日を登録する" })).toHaveAttribute("href", "/children")
  })

  it("否定側: 保護者が「離乳中期」と設定した子には、2 歳を過ぎていても案内を出さない（月齢で決めつけない）", () => {
    const settings = { ...defaultDinnerSettings(), childStages: { [TODDLER]: "weaning_mid" }, version: VERSION }
    render(<RecipeDetail view={detail("nikujaga", { children: [toddler], settings })} />)
    const card = childCard("はると")
    expect(within(card).getByText(/食事の段階: 離乳中期/)).toBeInTheDocument()
    expect(within(card).queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    // 段階は設定済み（対象外）なので、「設定する」への導線は出さない
    expect(within(card).queryByRole("link", { name: /食事の段階を設定する/ })).not.toBeInTheDocument()
  })

  it("どの場合も「食べられる」「そのまま与えられる」と書かない（子どもが混ざっていても、子ごとに分ける）", () => {
    const { container } = render(
      <RecipeDetail view={detail("nikujaga", { children: [toddler, baby, unknownAge], settings: toddlerStageSettings })} />,
    )
    expect(screen.getAllByTestId("recipe-child")).toHaveLength(3)
    expect(within(childCard("はると")).getByText("味付けの前に取り分ける")).toBeInTheDocument()
    expect(within(childCard("あかり")).queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    expect(container.textContent).not.toMatch(/食べられます|そのまま与え|安心して|監修済み/)
  })

  it("子どもが登録されていなければ、案内の本文を出さない（対照: 未対応の料理は「未対応」）", () => {
    const supported = render(<RecipeDetail view={detail("nikujaga")} />)
    expect(screen.getByText(/お子さんが登録されていないため、表示していません/)).toBeInTheDocument()
    expect(screen.queryByText("味付けの前に取り分ける")).not.toBeInTheDocument()
    supported.unmount()

    render(<RecipeDetail view={detail("ginger_pork")} />)
    expect(screen.getByText(CHILD_SERVING_UNSUPPORTED_TEXT)).toBeInTheDocument()
    expect(screen.queryByText(/お子さんが登録されていないため/)).not.toBeInTheDocument()
  })
})

describe("C-65 年齢の制約（1 歳未満にはちみつ）", () => {
  it("はちみつを使う料理には、子どもの登録が無くても一般の注意を出典つきで出す", () => {
    render(<RecipeDetail view={detail("sweet_potato_honey_lemon")} />)
    const rule = screen.getByTestId("recipe-age-rule")
    expect(rule).toHaveTextContent("はちみつは1歳を過ぎてから")
    expect(rule).toHaveTextContent("通常の加熱や調理ではなくなりません")
    expect(within(rule).getAllByTestId("guidance-source").length).toBeGreaterThan(0)
  })

  it("1 歳未満の子には「与えないでください」と警告する（対照: 2 歳の子には警告しない）", () => {
    render(<RecipeDetail view={detail("sweet_potato_honey_lemon", { children: [baby, toddler] })} />)
    const babyAlert = within(childCard("あかり")).getByRole("alert")
    expect(babyAlert).toHaveTextContent("はちみつは1歳を過ぎてから")
    expect(babyAlert).toHaveTextContent("あかりには与えないでください")
    expect(within(childCard("はると")).queryByRole("alert")).not.toBeInTheDocument()
  })

  it("生年月日が未登録の子には、年齢を確認するよう促す（「与えてよい」とは言わない）", () => {
    render(<RecipeDetail view={detail("sweet_potato_honey_lemon", { children: [unknownAge] })} />)
    expect(within(childCard("みお")).getByRole("alert")).toHaveTextContent("年齢を確認してください")
  })

  it("対照: はちみつを使わない料理には、年齢の注意を出さない", () => {
    render(<RecipeDetail view={detail("nikujaga", { children: [baby] })} />)
    expect(screen.queryByTestId("recipe-age-rule")).not.toBeInTheDocument()
    expect(within(childCard("あかり")).queryByRole("alert")).not.toBeInTheDocument()
  })
})

describe("V-UI 長い日本語・押下領域", () => {
  it("長い料理名・子どもの名前は折り返す", () => {
    const long = "とても長い名前の子どもを登録した場合でも画面からはみ出さないことを確かめる"
    const view = detail("nikujaga", { children: [{ ...toddler, name: long }] })
    render(<RecipeDetail view={{ ...view, title: long }} />)
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("[overflow-wrap:anywhere]")
    expect(within(screen.getByTestId("recipe-child")).getByText(long).className).toContain("[overflow-wrap:anywhere]")
  })

  it("出典のリンクは 44px の押下領域を持ち、新しいタブで開くことを読み上げにも伝える", () => {
    const { container } = render(
      <RecipeDetail view={detail("nikujaga", { children: [toddler], settings: toddlerStageSettings })} />,
    )
    const links = [...container.querySelectorAll("a")]
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) {
      expect(link.className).toContain("min-h-11")
      expect(link.className).toContain("min-w-11")
      expect(link).toHaveAttribute("rel", "noopener noreferrer")
      expect(link).toHaveTextContent("新しいタブで開きます")
    }
    expect(container.innerHTML).not.toContain("transition-all")
  })
})
