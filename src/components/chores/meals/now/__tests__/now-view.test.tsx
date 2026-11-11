/**
 * 「今あるもので」の表示（要件台帳 C-23 / C-24 / C-25 / C-27 / C-75、V-C1、V-UI）。
 *
 * 同梱カタログ（実データ）で `buildNowView` を通した結果を描いて確かめる
 * （表示のために作った値ではなく、実際に画面へ渡る値）。
 */
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { getMealLookup } from "@/lib/meals/server/context"
import {
  defaultDinnerSettings,
  type StoredDishFeedback,
  type StoredFoodExclusion,
  type StoredPantryItem,
} from "@/lib/meals/server/rows"
import { STAPLE_RULE_NOTE, buildNowView, type NowViewContext } from "@/lib/meals/server/views"

import { NowView } from "../now-view"

const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const ME = "a1000000-0000-4000-8000-000000000001"
const SPOUSE = "a1000000-0000-4000-8000-000000000002"
const BABY = "a2000000-0000-4000-8000-000000000001"
const STAPLES = ["salt", "rice_oil", "sugar", "soy_sauce", "salad_oil"]

let seq = 0
function stock(ingredientId: string | null, over: Partial<StoredPantryItem> = {}): StoredPantryItem {
  seq += 1
  return {
    id: `pantry-${seq}`,
    ingredientId,
    name: ingredientId === null ? "名前のままの食材" : (getMealLookup().index.byId.get(ingredientId)?.name ?? ingredientId),
    quantity: null,
    status: "have",
    useSoon: false,
    storage: "fridge",
    expiresOn: null,
    confirmedOn: TODAY,
    version: VERSION,
    ...over,
  }
}

function context(over: Partial<NowViewContext> = {}): NowViewContext {
  return {
    householdId: "household-a",
    today: TODAY,
    lookup: getMealLookup(),
    unreadable: {},
    issues: [],
    settings: { ...defaultDinnerSettings(), stapleIngredientIds: [...STAPLES], version: VERSION },
    settingsMissing: false,
    pantry: [],
    exclusions: [],
    preferences: [],
    feedback: [],
    feedbackSince: "2026-05-15",
    children: [],
    members: [
      { id: ME, displayName: "たろう" },
      { id: SPOUSE, displayName: "はなこ" },
    ],
    ...over,
  }
}

/** 鮭の塩焼きと卵焼きが「揃う」在庫。 */
function readyPantry(over: Partial<StoredPantryItem> = {}): StoredPantryItem[] {
  return [
    stock("salmon", { quantity: { amount: 2, unit: "slice" }, ...over }),
    stock("egg", { quantity: { amount: 6, unit: "piece" } }),
  ]
}

const readyRegion = () => screen.getByRole("region", { name: "食材と量が揃う料理" })
const checkRegion = () => screen.getByRole("region", { name: "分量を確認" })
const buyRegion = () => screen.getByRole("region", { name: "買い足せば作れる" })
const titlesIn = (region: HTMLElement) =>
  within(region)
    .queryAllByTestId("now-candidate")
    .map((card) => within(card).getAllByRole("link")[0].textContent)

afterEach(() => {
  cleanup()
})

describe("C-23 揃う候補（基本 3 案）と、別枠の分離", () => {
  it("揃う料理は「揃う」の区画にだけ出て、3 案までに絞られる。各候補からレシピ詳細へ移れる", () => {
    const view = buildNowView(context({ pantry: readyPantry() }))
    render(<NowView view={view} />)

    const ready = within(readyRegion()).getAllByTestId("now-candidate")
    expect(ready.length).toBe(view.ready.length)
    expect(ready.length).toBeGreaterThanOrEqual(2)
    expect(ready.length).toBeLessThanOrEqual(3)
    expect(titlesIn(readyRegion())).toEqual(view.ready.map((candidate) => candidate.title))
    for (const [index, card] of ready.entries()) {
      // 印は文字で「揃う」と言う（色だけにしない）
      expect(within(card).getByText("揃う")).toBeInTheDocument()
      expect(within(card).queryByText("買い足す食材")).not.toBeInTheDocument()
      expect(within(card).queryByText("分量を確認する食材")).not.toBeInTheDocument()
      expect(within(card).getAllByRole("link")[0]).toHaveAttribute(
        "href",
        `/chores/meals/recipes/${view.ready[index].recipeId}`,
      )
      expect(within(card).getByText(/約\d+分/)).toBeInTheDocument()
    }
    expect(screen.getByTestId("now-ready-count")).toHaveTextContent(`${view.readyTotal}件`)
  })

  it("買い足しが要る料理は別の区画に出て、足りない食材と量を示す（揃う区画に混ぜない）", () => {
    const view = buildNowView(context({ pantry: readyPantry() }))
    render(<NowView view={view} />)

    const buy = within(buyRegion()).getAllByTestId("now-candidate")
    expect(buy).toHaveLength(3)
    for (const [index, card] of buy.entries()) {
      expect(within(card).getByText("買い足し")).toBeInTheDocument()
      expect(within(card).getByText("買い足す食材")).toBeInTheDocument()
      const first = view.buy[index].missing[0]
      expect(within(card).getAllByText(new RegExp(first.name)).length).toBeGreaterThan(0)
      expect(within(card).getAllByText(new RegExp(first.required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).length).toBeGreaterThan(0)
    }
    // 3 つの区画に同じ料理は出ない
    const all = [...titlesIn(readyRegion()), ...titlesIn(checkRegion()), ...titlesIn(buyRegion())]
    expect(new Set(all).size).toBe(all.length)
    // 揃う区画には「買い足し」「分量要確認」の印が 1 つも無い
    expect(within(readyRegion()).queryByText("買い足し")).not.toBeInTheDocument()
    expect(within(readyRegion()).queryByText("分量要確認")).not.toBeInTheDocument()
    expect(within(buyRegion()).queryByText("揃う")).not.toBeInTheDocument()
  })

  it("数量が未登録の食材を使う料理は「分量を確認」の区画に、理由つきで出る（C-27）", () => {
    const view = buildNowView(context({ pantry: [stock("salmon")] }), { limit: 200 })
    render(<NowView view={view} />)

    expect(within(readyRegion()).queryByText("鮭の塩焼き")).not.toBeInTheDocument()
    const card = within(checkRegion())
      .getAllByTestId("now-candidate")
      .find((candidate) => within(candidate).queryByText("鮭の塩焼き") !== null) as HTMLElement
    expect(within(card).getByText("分量要確認")).toBeInTheDocument()
    expect(within(card).getByText("分量を確認する食材")).toBeInTheDocument()
    expect(within(card).getByText(/数量が登録されていません/)).toBeInTheDocument()
  })
})

describe("C-24 / C-25 揃う候補が 0 件のとき", () => {
  it("0 件と明示し、別の枠で埋めない。入力の見直し（食材・常備品）へ誘導する", () => {
    const ctx = context({ pantry: readyPantry() })
    // 常備品が未設定 = 塩も油も「ある」と数えない
    const view = buildNowView({ ...ctx, settings: { ...ctx.settings, stapleIngredientIds: [] } })
    expect(view.readyTotal).toBe(0)
    render(<NowView view={view} />)

    expect(screen.getByTestId("now-ready-count")).toHaveTextContent("揃う候補は 0 件です。")
    expect(within(readyRegion()).queryByTestId("now-candidate")).not.toBeInTheDocument()
    expect(within(readyRegion()).getByText(STAPLE_RULE_NOTE)).toBeInTheDocument()
    expect(within(readyRegion()).getByRole("link", { name: "食材を見直す" })).toHaveAttribute("href", "/chores/meals/pantry")
    expect(within(readyRegion()).getByRole("link", { name: "常備品を設定する" })).toHaveAttribute(
      "href",
      "/chores/meals/settings",
    )
    // 買い足しの候補は、別の区画のまま
    expect(within(buyRegion()).getAllByTestId("now-candidate").length).toBeGreaterThan(0)
  })

  it("数量不明の在庫・一覧にない名前を、見直しのヒントとして示す", () => {
    const view = buildNowView(context({ pantry: [stock("salmon"), stock(null, { name: "謎の葉" })] }))
    expect(view.readyTotal).toBe(0)
    render(<NowView view={view} />)
    for (const hint of view.hints) expect(within(readyRegion()).getByText(hint.text)).toBeInTheDocument()
    expect(view.hints.map((hint) => hint.code)).toEqual(expect.arrayContaining(["quantity_unknown", "unresolved_items"]))
    expect(within(readyRegion()).getByText(/食材の一覧にない名前: 「謎の葉」/)).toBeInTheDocument()
  })

  it("在庫が空なら食材の登録へ誘導する（対照: 在庫が在るときは登録の案内を出さない）", () => {
    const empty = render(<NowView view={buildNowView(context())} />)
    expect(screen.getByText("食材がまだ登録されていません")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "食材を登録する" })).toHaveAttribute("href", "/chores/meals/pantry")
    expect(screen.getByTestId("now-ready-count")).toHaveTextContent("揃う候補は 0 件です。")
    empty.unmount()

    render(<NowView view={buildNowView(context({ pantry: readyPantry() }))} />)
    expect(screen.queryByText("食材がまだ登録されていません")).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: "食材を登録する" })).not.toBeInTheDocument()
  })
})

describe("C-75 理由は実記録にもとづくものだけ", () => {
  const liked: StoredDishFeedback = {
    id: "feedback-1",
    profileId: SPOUSE,
    recipeId: "tamagoyaki",
    eatenOn: "2026-11-05",
    taste: 3,
    effort: null,
    again: true,
    excludeFromLearning: false,
    dishTitle: "卵焼き",
    version: VERSION,
  }
  const cardOf = (title: string) =>
    within(readyRegion())
      .getAllByTestId("now-candidate")
      .find((card) => within(card).queryByText(title) !== null) as HTMLElement

  it("早く使いたい食材・家族の評価が在るときだけ、その理由を出す", () => {
    const view = buildNowView(context({ pantry: readyPantry({ useSoon: true }), feedback: [liked] }), { limit: 200 })
    render(<NowView view={view} />)
    expect(within(cardOf("鮭の塩焼き")).getByText(/早く使いたい「鮭」を使います/)).toBeInTheDocument()
    const reasons = within(cardOf("卵焼き")).getByRole("list", { name: "卵焼きの理由" })
    expect(reasons).toHaveTextContent("はなこ")
    expect(reasons).toHaveTextContent("11/5（木）")
  })

  it("対照: 印も評価も無ければ、理由を作らない", () => {
    const view = buildNowView(context({ pantry: readyPantry() }), { limit: 200 })
    render(<NowView view={view} />)
    expect(screen.queryByText(/早く使いたい/)).not.toBeInTheDocument()
    expect(within(cardOf("卵焼き")).queryByRole("list", { name: "卵焼きの理由" })).not.toBeInTheDocument()
    expect(within(cardOf("卵焼き")).queryByText(/はなこ/)).not.toBeInTheDocument()
  })
})

describe("使わない食材・年齢の注意・標準の人数", () => {
  const eggAllergy: StoredFoodExclusion = {
    id: "exclusion-1",
    reason: "allergy",
    target: { kind: "allergen", allergenId: "egg" },
    subject: { kind: "member", profileId: SPOUSE },
    version: VERSION,
  }

  it("除外に当たる料理はどの区画にも出さず、件数と判定の限界を示す", () => {
    const view = buildNowView(context({ pantry: readyPantry(), exclusions: [eggAllergy] }), { limit: 200 })
    render(<NowView view={view} />)
    expect(screen.queryByText("卵焼き")).not.toBeInTheDocument()
    expect(view.excludedCount).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(`「使わない食材」の設定に当たる料理 ${view.excludedCount} 件`))).toBeInTheDocument()
    expect(screen.getByText(/商品ごとの原材料や製造時の混入までは確認できません/)).toBeInTheDocument()
    // 原材料を確かめられない料理は、候補ではなく別の区画
    if (view.labelCheck.length > 0) {
      const label = screen.getByRole("region", { name: "原材料の確認が必要な料理" })
      expect(within(label).getAllByText("原材料の確認が必要").length).toBe(view.labelCheck.length)
      expect(within(label).queryByTestId("now-candidate")).not.toBeInTheDocument()
    }
  })

  it("対照: 除外が無ければ、除外の件数も判定の限界の注意も出さない", () => {
    render(<NowView view={buildNowView(context({ pantry: readyPantry() }))} />)
    expect(screen.queryByText(/「使わない食材」の設定に当たる料理/)).not.toBeInTheDocument()
    expect(screen.queryByText(/商品ごとの原材料や製造時の混入/)).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "原材料の確認が必要な料理" })).not.toBeInTheDocument()
  })

  it("1 歳未満の子がいる世帯では、はちみつを使う料理に注意を出す（C-65）", () => {
    const view = buildNowView(
      context({ pantry: readyPantry(), children: [{ id: BABY, name: "あかり", birthDate: "2026-03-01" }] }),
      { limit: 200 },
    )
    render(<NowView view={view} />)
    const honey = [...view.ready, ...view.check, ...view.buy].find(
      (candidate) => candidate.recipeId === "sweet_potato_honey_lemon",
    )
    expect(honey?.ageWarnings).toHaveLength(1)
    expect(screen.getByText(honey?.ageWarnings[0].text ?? "(missing)")).toBeInTheDocument()
    expect(honey?.ageWarnings[0].text).toContain("1歳未満")
  })

  it("人数が未設定なら、標準の人数で計算していることを示す（対照: 設定済みなら出さない）", () => {
    const missing = render(<NowView view={buildNowView(context({ settingsMissing: true }))} />)
    expect(screen.getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    missing.unmount()
    render(<NowView view={buildNowView(context())} />)
    expect(screen.queryByText(/人数が未設定のため/)).not.toBeInTheDocument()
    expect(screen.getByText(/2人分で計算しています/)).toBeInTheDocument()
  })

  it("読めない記録が在れば、件数を出す（提案に反映できていないことを隠さない）", () => {
    render(<NowView view={buildNowView(context({ unreadable: { pantry: 2 } }))} />)
    expect(screen.getByRole("alert")).toHaveTextContent("食材 2件")
  })
})

describe("R24: 総称で登録した食材は、材料に数えていないことと直す場所を出す", () => {
  // 肉じゃがの材料は、豚こま切れ肉 以外すべて十分に在る。豚肉だけが総称（「豚肉」）で登録されている
  const withGenericPork = () => {
    const recipe = getMealLookup().recipeById.get("nikujaga")
    if (!recipe) throw new Error("fixture recipe is missing")
    const others = recipe.ingredients.filter((ingredient) => !ingredient.ingredientId.startsWith("pork"))
    expect(others.length).toBe(recipe.ingredients.length - 1)
    return context({
      pantry: [
        stock("pork", { name: "豚肉", quantity: { amount: 300, unit: "g" } }),
        ...others.map((ingredient) =>
          stock(ingredient.ingredientId, {
            quantity:
              ingredient.quantity.amount === null ? null : { amount: 9999, unit: ingredient.quantity.unit },
          }),
        ),
      ],
    })
  }

  it("総称の在庫が在れば、名前を挙げて「材料に数えていません」と言い、食材の画面へ送る", () => {
    const view = buildNowView(withGenericPork())
    // 前提: サーバーの表示が、総称の在庫を挙げている
    expect((view.genericItems ?? []).map((item) => item.name)).toEqual(["豚肉"])
    render(<NowView view={view} />)
    const notice = screen.getByTestId("now-generic-items")
    expect(notice).toHaveTextContent("総称で登録した食材は、材料に数えていません。")
    expect(notice).toHaveTextContent("「豚肉」は部位・種類が分からないため、材料が揃っているとは数えていません")
    expect(notice).toHaveTextContent("具体的な名前（部位・種類）に直すと、候補に数えます")
    expect(within(notice).getByRole("link", { name: "食材の画面で直す" })).toHaveAttribute("href", "/chores/meals/pantry")
  })

  it("総称が当たりうる材料の行には、確認が要る理由（どの名前で登録されているか）を出す。「揃う」には入れない", () => {
    const view = buildNowView(withGenericPork())
    // 前提: サーバーの表示が、総称が当たりうる材料の行を持っている（表示している候補の中に在る）
    const expected = [...view.ready, ...view.check, ...view.buy].flatMap((candidate) =>
      candidate.toCheck.filter((line) => line.genericStock !== null && line.genericStock !== undefined),
    )
    expect(
      expected.length,
      JSON.stringify({
        check: view.check.map((candidate) => [candidate.title, candidate.toCheck.map((line) => line.name)]),
        buy: view.buy.map((candidate) => [candidate.title, candidate.missing.map((line) => line.name)]),
      }),
    ).toBeGreaterThan(0)
    render(<NowView view={view} />)
    const lines = screen.getAllByTestId("now-generic-line")
    expect(lines.length).toBe(expected.length)
    for (const line of lines) expect(line).toHaveTextContent("「豚肉」で登録されています")
    // 総称の行を持つ候補は、どれも「揃う」の区画には無い
    for (const line of lines) expect(readyRegion().contains(line)).toBe(false)
  })

  it("対照: 具体的な名前（豚こま切れ肉）で登録していれば、知らせも行の注意も出さない", () => {
    const view = buildNowView(
      context({
        pantry: [
          stock("pork_komagire", { quantity: { amount: 300, unit: "g" } }),
          stock("potato", { quantity: { amount: 4, unit: "piece" } }),
        ],
      }),
    )
    expect(view.genericItems ?? []).toEqual([])
    render(<NowView view={view} />)
    expect(screen.queryByTestId("now-generic-items")).not.toBeInTheDocument()
    expect(screen.queryByTestId("now-generic-line")).not.toBeInTheDocument()
  })
})

describe("R01（提案側）: 判定できない「使わない食材」の登録が在るとき", () => {
  const custom = (reason: "allergy" | "dislike", label: string): StoredFoodExclusion => ({
    id: `exclusion-${reason}-${label}`,
    reason,
    target: { kind: "custom", label },
    subject: { kind: "household" },
    version: VERSION,
  })

  it("判定できないアレルギーの登録が在れば、献立を確定できない理由と、直す場所を出す", () => {
    const view = buildNowView(context({ pantry: readyPantry(), exclusions: [custom("allergy", "マンゴー")] }))
    // 前提: どの料理も候補にしていない
    expect(view.exclusions.holdsAutoConfirm).toBe(true)
    expect(view.readyTotal).toBe(0)
    render(<NowView view={view} />)
    const hold = screen.getByTestId("exclusion-hold")
    expect(hold).toHaveTextContent("献立を確定できません。")
    expect(hold).toHaveTextContent("判定できないアレルギーの登録（「マンゴー」）があるため、料理の原材料を確かめられず、献立を確定できません")
    // 「自動では」と弱めない（実際は手でも確定できない）
    expect(hold).not.toHaveTextContent("自動では確定")
    expect(within(hold).getByRole("link", { name: "使わない食材の設定を開く" })).toHaveAttribute("href", "/chores/meals/settings")
    // 外した料理には「材料の原材料が商品で違う」ではなく、登録のためだと出す
    const held = view.labelCheck.filter((dish) => dish.undeterminedHold === true)
    expect(held.length).toBeGreaterThan(0)
    expect(screen.getAllByText(/判定できないアレルギーの登録があるため、この料理が該当するかを見分けられません/).length).toBe(
      held.length,
    )
  })

  it("判定できない苦手の登録は、何も除外していないと出す（献立は止めていない）", () => {
    const view = buildNowView(context({ pantry: readyPantry(), exclusions: [custom("dislike", "マンゴー")] }))
    expect(view.exclusions.holdsAutoConfirm).toBe(false)
    render(<NowView view={view} />)
    const hold = screen.getByTestId("exclusion-hold")
    expect(hold).toHaveTextContent("判定できない苦手の登録「マンゴー」では、何も除外されていません")
    expect(hold).not.toHaveTextContent("献立を確定できません")
    // 候補は出ている
    expect(within(readyRegion()).getAllByTestId("now-candidate").length).toBeGreaterThan(0)
  })

  it("対照: 一覧と照合できる登録だけなら、知らせを出さない", () => {
    const egg: StoredFoodExclusion = {
      id: "exclusion-egg",
      reason: "allergy",
      target: { kind: "allergen", allergenId: "egg" },
      subject: { kind: "household" },
      version: VERSION,
    }
    render(<NowView view={buildNowView(context({ pantry: readyPantry(), exclusions: [egg, custom("allergy", "乳製品")] }))} />)
    expect(screen.queryByTestId("exclusion-hold")).not.toBeInTheDocument()
  })
})

describe("R48: 「献立に入れる」の釦", () => {
  it("対照: 献立を読めていない画面（Provider の外）では、釦を出さない（押せない釦を並べない）", () => {
    render(<NowView view={buildNowView(context({ pantry: readyPantry() }))} />)
    expect(within(readyRegion()).getAllByTestId("now-candidate").length).toBeGreaterThan(0)
    expect(screen.queryByTestId("add-to-plan")).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /献立に入れる/ })).not.toBeInTheDocument()
  })
})

describe("V-UI 長い日本語・押下領域", () => {
  it("リンクは 44px の押下領域を持ち、transition-all を使わない", () => {
    const ctx = context({ pantry: readyPantry() })
    const { container } = render(
      <NowView view={buildNowView({ ...ctx, settings: { ...ctx.settings, stapleIngredientIds: [] } })} />,
    )
    const links = [...container.querySelectorAll("a")]
    expect(links.length).toBeGreaterThan(3)
    for (const link of links) expect(link.className, link.textContent ?? "").toContain("min-h-11")
    expect(container.innerHTML).not.toContain("transition-all")
  })

  it("長い食材名（一覧にない名前）は折り返す", () => {
    const long = "とても長い名前の食材をそのまま登録した場合でも画面からはみ出さないことを確かめる"
    render(<NowView view={buildNowView(context({ pantry: [stock(null, { name: long })] }))} />)
    expect(screen.getByText(new RegExp(long)).className).toContain("break-words")
  })
})
