/**
 * ごはんの設定の画面（要件台帳 C-25 / C-31 / C-51 / C-52 / C-53 / C-55 / C-61 / C-63 / C-73 / C-75、
 * X-03 / X-05 / X-09、V-C4 / V-C5 / V-UI）。
 *
 * 画面へ渡す値は、同梱カタログ（実データ）で `buildSettingsView` を通して作る。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import {
  ALLERGENS,
  ALLERGEN_JUDGEMENT_DISCLAIMER,
  ALLERGEN_LIST_DISCLAIMER,
  ALLERGEN_LIST_META,
} from "@/lib/meals/catalog/allergens"
import { WEANING_GENERAL_NOTES, WEANING_STAGE_GUIDES, getGuidanceSource } from "@/lib/meals/catalog/child-guidance"
import { DEFAULT_EXCLUSION_TERMS } from "@/lib/meals/exclusion-terms"
import { resolveExclusionLabel } from "@/lib/meals/exclusions"
import { getMealLookup } from "@/lib/meals/server/context"
import type { DinnerRequest, DinnerSaveSuccess } from "@/lib/meals/server/plan-requests"
import {
  defaultDinnerSettings,
  type DinnerSettings,
  type StoredDishFeedback,
  type StoredFoodExclusion,
  type StoredFoodPreference,
} from "@/lib/meals/server/rows"
import type {
  DinnerSettingsSaveSuccess,
  FoodExclusionDeleteSuccess,
  FoodExclusionSaveSuccess,
  FoodPreferenceSaveSuccess,
  MealDeleteSuccess,
  PlanConflictReport,
  PlanConflictView,
  SaveDinnerSettingsRequest,
  SaveFoodExclusionRequest,
  SaveFoodPreferenceRequest,
} from "@/lib/meals/server/settings-requests"
import { buildSettingsView, type SettingsViewContext } from "@/lib/meals/server/views"

const actions = vi.hoisted(() => ({
  saveDinnerSettings: vi.fn<(request: SaveDinnerSettingsRequest) => Promise<DinnerSettingsSaveSuccess | ChoreSaveFailure>>(),
  saveFoodExclusion: vi.fn<(request: SaveFoodExclusionRequest) => Promise<FoodExclusionSaveSuccess | ChoreSaveFailure>>(),
  deleteFoodExclusion: vi.fn<(request: { id: string }) => Promise<FoodExclusionDeleteSuccess | ChoreSaveFailure>>(),
  saveFoodPreference: vi.fn<(request: SaveFoodPreferenceRequest) => Promise<FoodPreferenceSaveSuccess | ChoreSaveFailure>>(),
  deleteFoodPreference: vi.fn<(request: { id: string }) => Promise<MealDeleteSuccess | ChoreSaveFailure>>(),
  deleteDishFeedback: vi.fn<(request: { id: string }) => Promise<MealDeleteSuccess | ChoreSaveFailure>>(),
  saveDinnerRequest: vi.fn<(request: DinnerRequest) => Promise<DinnerSaveSuccess | ChoreSaveFailure>>(),
  pantry: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/settings/actions", () => ({
  saveDinnerSettings: actions.saveDinnerSettings,
  saveFoodExclusion: actions.saveFoodExclusion,
  deleteFoodExclusion: actions.deleteFoodExclusion,
  saveFoodPreference: actions.saveFoodPreference,
  deleteFoodPreference: actions.deleteFoodPreference,
  deleteDishFeedback: actions.deleteDishFeedback,
}))
vi.mock("@/app/(main)/chores/meals/pantry/actions", () => ({
  previewPantryText: actions.pantry,
  addPantryItems: actions.pantry,
  savePantryItem: actions.pantry,
  deletePantryItem: actions.pantry,
}))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest: actions.saveDinnerRequest }))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: actions.refresh }) }))

import { childStageHint } from "../child-stage-hint"
import {
  EXCLUSION_HOLDS_EFFECT,
  EXCLUSION_NO_EFFECT,
  EXCLUSION_UNDETERMINED_LEAD,
  buildExclusionLexicon,
  lexiconCatalog,
  previewExclusionLabel,
} from "../exclusion-lexicon"
import { MealSettingsView, type MealSettingsViewProps } from "../settings-view"
import { WeaningGuide } from "../weaning-guide"

const ME = "b1000000-0000-4000-8000-000000000001"
const SPOUSE = "b1000000-0000-4000-8000-000000000002"
const CHILD = "b2000000-0000-4000-8000-000000000001"
const GONE_CHILD = "b2000000-0000-4000-8000-000000000009"
const OWNER: ChoreOwner = { userId: ME, householdId: "b1000000-0000-4000-8000-0000000000a1" }
const TODAY = "2026-11-11"
const VERSION = "2026-11-11T01:02:03.123456+00:00"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const SAVED: DinnerSettings = { ...defaultDinnerSettings(), version: VERSION }

function context(over: Partial<SettingsViewContext> = {}): SettingsViewContext {
  return {
    householdId: OWNER.householdId,
    today: TODAY,
    lookup: getMealLookup(),
    unreadable: {},
    issues: [],
    settings: SAVED,
    settingsMissing: false,
    exclusions: [],
    preferences: [],
    feedback: [],
    feedbackSince: "2026-05-15",
    children: [{ id: CHILD, name: "はると", birthDate: "2026-03-20" }],
    members: [
      { id: ME, displayName: "たろう" },
      { id: SPOUSE, displayName: "はなこ" },
    ],
    ...over,
  }
}

const EMPTY_REPORT: PlanConflictReport = { from: TODAY, to: "2027-12-16", conflicts: [], unreadableEntries: 0 }

function view(ctx: Partial<SettingsViewContext> = {}, over: Partial<MealSettingsViewProps> = {}) {
  const props: MealSettingsViewProps = {
    owner: OWNER,
    view: buildSettingsView(context(ctx), ME),
    planConflicts: EMPTY_REPORT,
    stageHints: {},
    ...over,
  }
  return render(<MealSettingsView {...props} />)
}

const section = (name: string) => screen.getByRole("region", { name })
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
/** 端末の控えを読み終えるまで、保存の釦は塞がっている。 */
async function ready() {
  await waitFor(() => expect(screen.getByRole("button", { name: "使わない食材に登録" })).toBeEnabled())
}

const exclusion = (over: Partial<StoredFoodExclusion> = {}): StoredFoodExclusion => ({
  id: "c1000000-0000-4000-8000-000000000001",
  reason: "allergy",
  target: { kind: "allergen", allergenId: "egg" },
  subject: { kind: "member", profileId: SPOUSE },
  version: VERSION,
  ...over,
})
const preference = (over: Partial<StoredFoodPreference> = {}): StoredFoodPreference => ({
  id: "c2000000-0000-4000-8000-000000000001",
  scope: "household",
  profileId: null,
  target: { kind: "recipe", id: "nikujaga" },
  sentiment: "like",
  version: VERSION,
  ...over,
})
const feedback = (over: Partial<StoredDishFeedback> = {}): StoredDishFeedback => ({
  id: "c3000000-0000-4000-8000-000000000001",
  profileId: ME,
  recipeId: "nikujaga",
  eatenOn: "2026-11-05",
  taste: 3,
  effort: 1,
  again: true,
  excludeFromLearning: false,
  dishTitle: "肉じゃが",
  version: VERSION,
  ...over,
})
const conflict = (over: Partial<PlanConflictView> = {}): PlanConflictView => ({
  entryId: "c4000000-0000-4000-8000-000000000001",
  date: "2026-11-13",
  role: "main",
  title: "親子丼",
  pinned: true,
  status: "confirmed",
  verdict: "blocked",
  ingredientNames: ["卵"],
  exclusionIds: ["someone-else"],
  unverifiable: [],
  causedByThisChange: true,
  ...over,
})

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.restoreAllMocks()
})

describe("C-31 人数・汁物・調理時間", () => {
  it("未設定の世帯には標準の人数を明示し、保存するまで登録しない（対照: 設定済みなら出さない）", async () => {
    const missing = view({ settings: defaultDinnerSettings(), settingsMissing: true })
    await ready()
    expect(within(section("献立の基本")).getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("2人分")
    expect(actions.saveDinnerSettings).not.toHaveBeenCalled()
    await act(async () => {})
    missing.unmount()

    view()
    await ready()
    expect(screen.queryByText(/人数が未設定のため/)).not.toBeInTheDocument()
    // 変更が無ければ保存の釦は押せない
    expect(screen.getByRole("button", { name: "基本の設定を保存" })).toBeDisabled()
  })

  it("人数を変えて保存すると、そのカードの項目だけを変え、残りは今の値のまま版つきで送る", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "saved", settings: { ...SAVED, servings: 3 }, deleted: false })
    view({ settings: { ...SAVED, stapleIngredientIds: ["salt"], childStages: { [CHILD]: "weaning_mid" } } })
    await ready()

    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("3人分")
    fireEvent.change(screen.getByLabelText("1 品あたりの調理時間の上限"), { target: { value: "30" } })
    await click(screen.getByRole("button", { name: "基本の設定を保存" }))

    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    const request = actions.saveDinnerSettings.mock.calls[0][0]
    expect(request).toEqual({
      version: VERSION,
      servings: 3,
      includeSoup: false,
      maxCookMinutes: 30,
      stapleIngredientIds: ["salt"],
      childStages: { [CHILD]: "weaning_mid" },
    })
    // 世帯は要求に無い（サーバーが認証から決める）
    expect(Object.keys(request)).not.toContain("householdId")
    await waitFor(() => expect(within(section("献立の基本")).getByRole("status")).toHaveTextContent("設定を保存しました。"))
  })

  it("人数は 1〜12 人の範囲に収める", async () => {
    view({ settings: { ...SAVED, servings: 12 } })
    await ready()
    expect(screen.getByRole("button", { name: "人数を1人増やす" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "人数を1人減らす" })).toBeEnabled()
  })

  it("家族が先に変えていたら上書きせず、入力を捨てて最新を見せる", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "conflict", settings: { ...SAVED, servings: 5 }, deleted: false })
    view()
    await ready()
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    await click(screen.getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(within(section("献立の基本")).getByRole("alert")).toHaveTextContent("上書きはしていません"))
    // 入力（3 人）を捨て、サーバーから渡されている値に戻る
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("2人分")
  })

  it("世帯にいない子・アプリが知らない段階・一覧に無い常備品を、保存の要求に持ち越さない", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "saved", settings: SAVED, deleted: false })
    view({
      settings: {
        ...SAVED,
        stapleIngredientIds: ["salt", "retired_item"],
        childStages: { [CHILD]: "future_stage", [GONE_CHILD]: "toddler" },
      },
    })
    await ready()
    expect(screen.getByText(/食材の一覧にない常備品が 1 件保存されています/)).toBeInTheDocument()
    expect(screen.getByText("保存されている段階を、このアプリで読み取れません。選び直してください。")).toBeInTheDocument()

    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    await click(screen.getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerSettings.mock.calls[0][0]).toMatchObject({ stapleIngredientIds: ["salt"], childStages: {} })
  })
})

describe("C-25 常備品（初期は未選択）", () => {
  it("初めは何も選ばれておらず、候補は食材辞書の常備品候補だけ", async () => {
    view()
    await ready()
    const staples = section("常備品")
    expect(screen.getByTestId("settings-staple-count")).toHaveTextContent("常備品は選ばれていません。")
    const chips = within(staples).getAllByRole("button", { pressed: false })
    const candidates = [...getMealLookup().index.byId.values()].filter((def) => def.stapleCandidate === true)
    expect(candidates.length).toBeGreaterThan(0)
    expect(chips.map((chip) => chip.textContent).sort()).toEqual(candidates.map((def) => def.name).sort())
    expect(within(staples).queryByRole("button", { pressed: true })).not.toBeInTheDocument()
  })

  it("選んで保存すると、選んだ食材の ID だけを送る（ほかのカードの入力途中の値は巻き込まない）", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "saved", settings: SAVED, deleted: false })
    view()
    await ready()
    // 別のカードで人数を変えたが、保存していない
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))

    const salt = getMealLookup().index.byId.get("salt")
    await click(within(section("常備品")).getByRole("button", { name: salt?.name ?? "" }))
    expect(screen.getByTestId("settings-staple-count")).toHaveTextContent("1件を選択中")
    await click(screen.getByRole("button", { name: "常備品を保存" }))

    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerSettings.mock.calls[0][0]).toMatchObject({
      version: VERSION,
      servings: 2,
      stapleIngredientIds: ["salt"],
    })
    // 人数のカードの入力は残っている
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("3人分")
  })
})

describe("C-51 使わない食材: 対象品目の一覧", () => {
  it("件数は実データから出し、義務／推奨の別・出典・版・確認日を示す", async () => {
    view()
    await ready()
    const mandatory = ALLERGENS.filter((allergen) => allergen.tier === "mandatory")
    const recommended = ALLERGENS.filter((allergen) => allergen.tier === "recommended")
    expect(ALLERGENS.length).toBeGreaterThanOrEqual(25)

    expect(screen.getByTestId("settings-allergen-count")).toHaveTextContent(`${ALLERGENS.length} 品目`)
    expect(screen.getByText(`特定原材料（表示義務・${mandatory.length}品目）`)).toBeInTheDocument()
    expect(screen.getByText(`特定原材料に準ずるもの（表示推奨・${recommended.length}品目）`)).toBeInTheDocument()
    const mandatoryList = screen.getByRole("list", { name: `特定原材料（表示義務・${mandatory.length}品目）` })
    expect(within(mandatoryList).getAllByRole("button").map((chip) => chip.textContent)).toEqual(
      mandatory.map((allergen) => allergen.name),
    )

    expect(screen.getByRole("link", { name: new RegExp(ALLERGEN_LIST_META.sourceTitle.slice(0, 12)) })).toHaveAttribute(
      "href",
      ALLERGEN_LIST_META.sourceUrl,
    )
    expect(screen.getByText(new RegExp(`版: ${ALLERGEN_LIST_META.version}・確認日: ${ALLERGEN_LIST_META.confirmedOn}`))).toBeInTheDocument()
    // 一覧の性質と判定の限界（法令適合・商品ごとの原材料表示は保証しない）
    expect(screen.getByText(ALLERGEN_LIST_DISCLAIMER)).toBeInTheDocument()
    expect(ALLERGEN_LIST_DISCLAIMER).toContain("保証するものでもありません")
    expect(screen.getByText(ALLERGEN_JUDGEMENT_DISCLAIMER)).toBeInTheDocument()
  })

  it("対照: 一覧が変われば件数の表示も変わる（数字を埋め込んでいない）", async () => {
    const base = buildSettingsView(context(), ME)
    const trimmed = { ...base, allergens: { ...base.allergens, items: base.allergens.items.slice(0, 3) } }
    view({}, { view: trimmed })
    await ready()
    expect(screen.getByTestId("settings-allergen-count")).toHaveTextContent("3 品目")
    expect(screen.getByTestId("settings-allergen-count")).not.toHaveTextContent(`${ALLERGENS.length} 品目`)
  })

  it("一覧から選んだもの・照合できたものは、アレルギー・苦手のどちらも必ず外すと書き、誰の分かを選べる", async () => {
    view()
    await ready()
    const area = section("使わない食材")
    // 「必ず外します」は、一覧から選んだもの・食材の一覧と照合できたものに限って言う（R01）
    expect(
      within(area).getByText(
        /一覧から選んだもの・食材の一覧と照合できたものは、どちらの理由でも、家族全員の献立と提案から必ず外します/,
      ),
    ).toBeInTheDocument()
    expect(
      within(area).getByText(/一覧から選んだ品目・食材は、アレルギー・苦手のどちらで登録しても、献立と提案から必ず外します/),
    ).toBeInTheDocument()
    expect(within(area).getByText(/自由に入力した名前は、食材の一覧と照合できた場合に限って外します/)).toBeInTheDocument()
    // 対照: 自由入力まで含めた無条件の約束は書かない
    expect(area.textContent).not.toMatch(/どちらも、家族全員の献立と提案から必ず外します/)
    const subject = within(area).getByLabelText("誰の分か")
    expect(within(subject).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "家族全体",
      "たろう（自分）",
      "はなこ",
      "はると（子ども）",
    ])
  })
})

describe("C-52 / C-55 使わない食材の登録と、献立との重なり", () => {
  async function registerEgg() {
    await click(screen.getByRole("button", { name: "卵" }))
    fireEvent.change(screen.getByLabelText("誰の分か"), { target: { value: `member:${SPOUSE}` } })
    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    await waitFor(() => expect(actions.saveFoodExclusion).toHaveBeenCalledTimes(1))
  }

  it("対象品目を選んで登録する。行 ID は画面が 1 回だけ作り、世帯の項目は送らない", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: EMPTY_REPORT,
    }))
    view()
    await ready()
    await registerEgg()

    const request = actions.saveFoodExclusion.mock.calls[0][0]
    expect(request).toEqual({
      id: expect.stringMatching(UUID),
      reason: "allergy",
      target: { kind: "allergen", allergenId: "egg" },
      subject: { kind: "member", profileId: SPOUSE },
    })
    await waitFor(() =>
      expect(within(section("使わない食材")).getByRole("status")).toHaveTextContent("使わない食材に登録しました。"),
    )
    expect(screen.getByText("今日以降の献立に、使わない食材と重なる料理は見つかりませんでした。")).toBeInTheDocument()
  })

  it("登録の後、重なった献立の日・料理を一覧で示し、献立の画面へ送る（固定の料理も含める）", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: {
        ...EMPTY_REPORT,
        conflicts: [
          conflict(),
          conflict({
            entryId: "c4000000-0000-4000-8000-000000000002",
            date: "2026-11-14",
            role: "side",
            title: "卵焼き",
            pinned: false,
            causedByThisChange: false,
          }),
        ],
      },
    }))
    view()
    await ready()
    // 対照: 登録の前は、重なりは無い
    expect(screen.queryByTestId("settings-plan-conflict")).not.toBeInTheDocument()
    await registerEgg()

    const panel = await waitFor(() => screen.getByRole("region", { name: "今の献立との重なり" }))
    await waitFor(() => expect(within(panel).getAllByTestId("settings-plan-conflict")).toHaveLength(2))
    const [first, second] = within(panel).getAllByTestId("settings-plan-conflict")
    expect(first).toHaveTextContent("11月13日（金）")
    expect(first).toHaveTextContent("主菜")
    expect(first).toHaveTextContent("親子丼")
    expect(first).toHaveTextContent("固定")
    expect(first).toHaveTextContent("使わない食材を含む")
    expect(first).toHaveTextContent("該当する材料: 卵")
    expect(first).toHaveTextContent("今回の登録に該当")
    expect(second).toHaveTextContent("11月14日（土）")
    expect(second).toHaveTextContent("卵焼き")
    expect(second).not.toHaveTextContent("固定")
    expect(second).not.toHaveTextContent("今回の登録に該当")
    // 勝手に置換していないことを言い、選び直す場所へ送る
    expect(within(panel).getByRole("alert")).toHaveTextContent("献立は自動では変えていません")
    expect(within(panel).getByRole("link", { name: "献立で選び直す" })).toHaveAttribute("href", "/chores/meals/plan")
  })

  it("重なりを確かめられなかったときは「無い」と言わず、献立で確認するよう促す", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: null,
    }))
    view()
    await ready()
    await registerEgg()
    const panel = screen.getByRole("region", { name: "今の献立との重なり" })
    await waitFor(() => expect(within(panel).getByRole("alert")).toHaveTextContent("重なりが無いとは限りません"))
    expect(within(panel).queryByText(/見つかりませんでした/)).not.toBeInTheDocument()
    expect(within(panel).getByRole("link", { name: "献立で選び直す" })).toBeInTheDocument()
  })

  it("サーバーが読んだ重なり（再読み込みの後も残るもの）を、開いた時点で示す", async () => {
    view({ exclusions: [exclusion()] }, { planConflicts: { ...EMPTY_REPORT, conflicts: [conflict({ causedByThisChange: false })] } })
    await ready()
    const panel = screen.getByRole("region", { name: "今の献立との重なり" })
    expect(within(panel).getAllByTestId("settings-plan-conflict")).toHaveLength(1)
    expect(within(panel).getByTestId("settings-plan-conflict")).not.toHaveTextContent("今回の登録に該当")
  })

  it("苦手・自由入力でも登録でき、判定の限界を示す（対照: 名前が空なら送らない）", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: EMPTY_REPORT,
    }))
    view()
    await ready()
    const area = section("使わない食材")
    await click(within(area).getByRole("button", { name: "苦手" }))
    await click(within(area).getByRole("button", { name: "自由に入力" }))
    expect(within(area).getByText(/別の呼び名や、加工品の原材料までは見分けられません/)).toBeInTheDocument()

    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    expect(within(area).getByRole("alert")).toHaveTextContent("1〜30文字")
    expect(actions.saveFoodExclusion).not.toHaveBeenCalled()

    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: " パクチー " } })
    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    await waitFor(() => expect(actions.saveFoodExclusion).toHaveBeenCalledTimes(1))
    expect(actions.saveFoodExclusion.mock.calls[0][0]).toMatchObject({
      reason: "dislike",
      target: { kind: "custom", label: "パクチー" },
      subject: { kind: "household" },
    })
  })

  it("食材からも選べる（食材辞書の食材を、売場ごとに並べる）", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: EMPTY_REPORT,
    }))
    view()
    await ready()
    const area = section("使わない食材")
    await click(within(area).getByRole("button", { name: "食材から" }))
    const select = within(area).getByLabelText("食材")
    expect(within(select).getAllByRole("option").length).toBe(getMealLookup().index.byId.size + 1)
    fireEvent.change(select, { target: { value: "onion" } })
    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    await waitFor(() => expect(actions.saveFoodExclusion).toHaveBeenCalledTimes(1))
    expect(actions.saveFoodExclusion.mock.calls[0][0].target).toEqual({ kind: "ingredient", ingredientId: "onion" })
  })

  it("登録済みの一覧に、理由・対象・誰の分かを出し、削除は 2 段の確認の後に送る", async () => {
    actions.deleteFoodExclusion.mockResolvedValue({ status: "saved", id: exclusion().id, planConflicts: EMPTY_REPORT })
    view({
      exclusions: [
        exclusion(),
        // 食材の一覧には無いが、料理名に含まれる語（名前の一致でだけ判定できる自由入力）。
        // どこにも当たらない語（「パクチー」等）は「判定できない」扱いで、下の R01 の群で確かめる
        exclusion({ id: "c1000000-0000-4000-8000-000000000002", reason: "dislike", target: { kind: "custom", label: "きんぴら" }, subject: { kind: "child", childId: CHILD } }),
      ],
    })
    await ready()
    const rows = screen.getAllByTestId("settings-exclusion")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("卵")
    expect(rows[0]).toHaveTextContent("アレルギー")
    expect(rows[0]).toHaveTextContent("はなこ")
    expect(rows[1]).toHaveTextContent("きんぴら")
    expect(rows[1]).toHaveTextContent("苦手")
    expect(rows[1]).toHaveTextContent("はると")
    // 自由入力は、名前の一致でしか判定できないことを示す
    expect(rows[1]).toHaveTextContent("名前に含まれるかどうかで判定します")
    expect(rows[0]).not.toHaveTextContent("名前に含まれるかどうかで判定します")

    await click(within(rows[0]).getByRole("button", { name: "卵（アレルギー・はなこ）を削除" }))
    expect(actions.deleteFoodExclusion).not.toHaveBeenCalled()
    await click(within(rows[0]).getByRole("button", { name: "削除する" }))
    await waitFor(() => expect(actions.deleteFoodExclusion).toHaveBeenCalledWith({ id: exclusion().id }))
  })

  it("読めない設定が在れば件数を出し、「登録されていません」と言わない", async () => {
    const base = buildSettingsView(context({ unreadable: { exclusions: 2 } }), ME)
    view({}, { view: base })
    await ready()
    const area = section("使わない食材")
    expect(within(area).getByText(/読み取れない設定が 2 件あります/)).toBeInTheDocument()
    expect(within(area).queryByText("使わない食材は、まだ登録されていません。")).not.toBeInTheDocument()
  })

  it("拒否された登録は理由を出し、入力を残す（X-03 失敗）", async () => {
    actions.saveFoodExclusion.mockResolvedValue({ error: "この設定を登録できません。", failure: "rejected" })
    view()
    await ready()
    await registerEgg()
    await waitFor(() => expect(within(section("使わない食材")).getByRole("alert")).toHaveTextContent("この設定を登録できません。"))
    expect(screen.getByRole("button", { name: "卵" })).toHaveAttribute("aria-pressed", "true")
    expect(screen.queryByText("保存できたか確認できていない操作")).not.toBeInTheDocument()
  })

  it("応答を失った登録は、同じ行 ID・同じ内容で確かめ直す（X-09）", async () => {
    actions.saveFoodExclusion.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    view()
    await ready()
    await registerEgg()
    await waitFor(() => expect(screen.getByText("保存できたか確認できていない操作")).toBeInTheDocument())
    expect(screen.getByText("使わない食材「卵」を登録")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "使わない食材に登録" })).toBeDisabled()

    actions.saveFoodExclusion.mockImplementationOnce(async (request) => ({
      status: "replayed",
      exclusion: { ...exclusion(), id: request.id },
      planConflicts: EMPTY_REPORT,
    }))
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(actions.saveFoodExclusion).toHaveBeenCalledTimes(2))
    expect(actions.saveFoodExclusion.mock.calls[1][0]).toEqual(actions.saveFoodExclusion.mock.calls[0][0])
  })
})

describe("C-73 好み（家族共通／自分）", () => {
  const mine = preference({ id: "c2000000-0000-4000-8000-000000000002", scope: "personal", profileId: ME, target: { kind: "tag", id: "fish" }, sentiment: "dislike" })
  const theirs = preference({ id: "c2000000-0000-4000-8000-000000000003", scope: "personal", profileId: SPOUSE, target: { kind: "ingredient", id: "onion" } })

  it("家族共通・自分・ほかの家族を分けて出し、ほかの家族の個人の好みは変えられない", async () => {
    view({ preferences: [preference(), mine, theirs] })
    await ready()
    const area = section("好み")
    expect(within(area).getByRole("list", { name: "家族共通" })).toHaveTextContent("肉じゃが")
    expect(within(area).getByRole("list", { name: "自分" })).toHaveTextContent("たろう")
    const others = within(area).getByRole("list", { name: "ほかの家族（見るだけ）" })
    expect(others).toHaveTextContent("玉ねぎ")
    expect(others).toHaveTextContent("はなこ")
    expect(within(others).queryByRole("button")).not.toBeInTheDocument()
    // 対照: 家族共通と自分の好みには、変更と削除が在る
    expect(within(within(area).getByRole("list", { name: "家族共通" })).getAllByRole("button")).toHaveLength(2)
    expect(within(within(area).getByRole("list", { name: "自分" })).getAllByRole("button")).toHaveLength(2)
  })

  it("好き／苦手の切替は、開いた時点の版で送る", async () => {
    actions.saveFoodPreference.mockResolvedValue({ status: "saved", preference: { ...mine, sentiment: "like" }, deleted: false })
    view({ preferences: [mine] })
    await ready()
    await click(screen.getByRole("button", { name: /を「好き」に変える/ }))
    await waitFor(() => expect(actions.saveFoodPreference).toHaveBeenCalledTimes(1))
    expect(actions.saveFoodPreference.mock.calls[0][0]).toEqual({
      id: mine.id,
      version: VERSION,
      scope: "personal",
      target: { kind: "tag", id: "fish" },
      sentiment: "like",
    })
  })

  it("新しい好みを登録する。個人の好みでも、持ち主の項目は送らない（サーバーが本人に固定する）", async () => {
    actions.saveFoodPreference.mockImplementation(async (request) => ({
      status: "saved",
      preference: { ...preference(), id: request.id },
      deleted: false,
    }))
    view()
    await ready()
    const area = section("好み")
    const scope = within(area).getByRole("group", { name: "誰の好みか" })
    await click(within(scope).getByRole("button", { name: "自分" }))
    fireEvent.change(within(area).getByLabelText("料理"), { target: { value: "nikujaga" } })
    const sentiment = within(area).getByRole("group", { name: "好き・苦手" })
    await click(within(sentiment).getByRole("button", { name: "苦手" }))
    await click(screen.getByRole("button", { name: "好みを登録" }))

    await waitFor(() => expect(actions.saveFoodPreference).toHaveBeenCalledTimes(1))
    const request = actions.saveFoodPreference.mock.calls[0][0]
    expect(request).toEqual({
      id: expect.stringMatching(UUID),
      version: null,
      scope: "personal",
      target: { kind: "recipe", id: "nikujaga" },
      sentiment: "dislike",
    })
    expect(Object.keys(request)).not.toContain("profileId")
    // ここの「苦手」は必須除外ではないことを言う
    expect(within(area).getByText(/ここの「苦手」は順位を下げるだけです/)).toBeInTheDocument()
  })

  it("対象を選ばなければ送らない", async () => {
    view()
    await ready()
    await click(screen.getByRole("button", { name: "好みを登録" }))
    expect(within(section("好み")).getByRole("alert")).toHaveTextContent("料理を選んでください。")
    expect(actions.saveFoodPreference).not.toHaveBeenCalled()
  })
})

describe("C-75 覚えた好み（食後の評価）", () => {
  const theirs = feedback({ id: "c3000000-0000-4000-8000-000000000002", profileId: SPOUSE, eatenOn: "2026-11-03", taste: 1, effort: null, again: false, excludeFromLearning: true })

  it("誰が・いつ・何を・味／手間／また食べたいを分けて出す", async () => {
    view({ feedback: [feedback(), theirs] })
    await ready()
    const rows = within(section("覚えた好み")).getAllByTestId("settings-feedback")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent("たろう（自分）・11/5（木）")
    expect(rows[0]).toHaveTextContent("肉じゃが")
    expect(rows[0]).toHaveTextContent("味:おいしい")
    expect(rows[0]).toHaveTextContent("手間:大変")
    expect(rows[0]).toHaveTextContent("また食べたい:はい")
    expect(rows[1]).toHaveTextContent("はなこ・11/3（火）")
    expect(rows[1]).toHaveTextContent("味:苦手")
    expect(rows[1]).toHaveTextContent("手間:未回答")
    expect(rows[1]).toHaveTextContent("また食べたい:いいえ")
    expect(rows[1]).toHaveTextContent("好みに反映しない記録")
    expect(rows[0]).not.toHaveTextContent("好みに反映しない記録")
  })

  it("削除できるのは自分の評価だけ。2 段の確認の後に送る", async () => {
    actions.deleteDishFeedback.mockResolvedValue({ status: "saved", id: feedback().id })
    view({ feedback: [feedback(), theirs] })
    await ready()
    const rows = within(section("覚えた好み")).getAllByTestId("settings-feedback")
    expect(within(rows[1]).queryByRole("button")).not.toBeInTheDocument()

    await click(within(rows[0]).getByRole("button", { name: "11/5（木）の「肉じゃが」の評価を削除" }))
    expect(actions.deleteDishFeedback).not.toHaveBeenCalled()
    await click(within(rows[0]).getByRole("button", { name: "削除する" }))
    await waitFor(() => expect(actions.deleteDishFeedback).toHaveBeenCalledWith({ id: feedback().id }))
    await waitFor(() =>
      expect(within(section("覚えた好み")).getByRole("status")).toHaveTextContent("次の提案と理由の表示から使いません"),
    )
  })

  it("評価が無ければ、その旨と付け方を示す", async () => {
    view()
    await ready()
    expect(within(section("覚えた好み")).getByText(/まだ評価がありません/)).toBeInTheDocument()
  })
})

describe("C-61 / C-63 子どもの食事の段階と、離乳の段階の一般案内", () => {
  it("段階は保護者が選ぶ。月齢の目安を添えても、初期値にはしない", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "saved", settings: SAVED, deleted: false })
    const hint = childStageHint(7, WEANING_STAGE_GUIDES)
    expect(hint).toContain("離乳中期")
    view({}, { stageHints: { [CHILD]: hint ?? "" } })
    await ready()
    const area = section("子どもの食事")
    const select = within(area).getByLabelText(/はると/)
    // 月齢の目安が「離乳中期」でも、選択は未設定のまま
    expect(select).toHaveValue("")
    expect(within(area).getByText(hint ?? "")).toBeInTheDocument()
    expect(within(area).getByText(/自動では決めません/)).toBeInTheDocument()
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "未設定",
      "離乳開始前",
      "離乳初期",
      "離乳中期",
      "離乳後期",
      "離乳完了期",
      "幼児食",
    ])

    fireEvent.change(select, { target: { value: "weaning_late" } })
    await click(screen.getByRole("button", { name: "食事の段階を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerSettings.mock.calls[0][0].childStages).toEqual({ [CHILD]: "weaning_late" })
  })

  it("子どもが登録されていなければ、登録の場所へ送る", async () => {
    view({ children: [] })
    await ready()
    const area = section("子どもの食事")
    expect(within(area).getByText(/お子さんが登録されていません/)).toBeInTheDocument()
    expect(within(area).getByRole("link", { name: "子どもの管理へ" })).toHaveAttribute("href", "/children")
    expect(screen.queryByRole("button", { name: "食事の段階を保存" })).not.toBeInTheDocument()
  })

  it("離乳の段階の一般案内は、段階・注記・出典をデータから出し、個別レシピの対応とは別と明記する", () => {
    const source = getGuidanceSource("cfa_weaning_guide_2019")
    if (!source) throw new Error("source table lost the weaning guide")
    render(
      <WeaningGuide
        stages={WEANING_STAGE_GUIDES.map(({ id, label, ageLabel, texture }) => ({ id, label, ageLabel, texture }))}
        notes={WEANING_GENERAL_NOTES}
        sources={[source]}
      />,
    )
    const stages = screen.getAllByTestId("weaning-stage")
    expect(stages).toHaveLength(WEANING_STAGE_GUIDES.length)
    expect(screen.getByText(`離乳の段階の一般的な目安（${WEANING_STAGE_GUIDES.length}段階）`)).toBeInTheDocument()
    expect(stages[0]).toHaveTextContent(`${WEANING_STAGE_GUIDES[0].label}（${WEANING_STAGE_GUIDES[0].ageLabel}）`)
    expect(screen.getByText(/個別のレシピが離乳食に対応していることを示すものではありません/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: new RegExp(source.title) })).toHaveAttribute("href", source.url)
    expect(screen.getByText(/専門家の監修は受けていません/)).toBeInTheDocument()
  })
})

describe("childStageHint（月齢からの目安。決めつけない）", () => {
  it("案内のデータに範囲が在る月齢だけ、その段階を目安として言う", () => {
    expect(childStageHint(5, WEANING_STAGE_GUIDES)).toContain("離乳初期")
    expect(childStageHint(8.9, WEANING_STAGE_GUIDES)).toContain("離乳中期")
    expect(childStageHint(11, WEANING_STAGE_GUIDES)).toContain("離乳後期")
    expect(childStageHint(18, WEANING_STAGE_GUIDES)).toContain("離乳完了期")
    for (const months of [5, 8, 11, 18]) {
      expect(childStageHint(months, WEANING_STAGE_GUIDES)).toContain("実際の食べ方に合わせて選んでください")
    }
  })

  it("離乳の開始より前は、開始の目安だけを言う。範囲の外・月齢不明は何も言わない", () => {
    expect(childStageHint(2, WEANING_STAGE_GUIDES)).toContain("離乳の開始は「生後5〜6か月頃」が目安")
    expect(childStageHint(19, WEANING_STAGE_GUIDES)).toBeNull()
    expect(childStageHint(36, WEANING_STAGE_GUIDES)).toBeNull()
    expect(childStageHint(null, WEANING_STAGE_GUIDES)).toBeNull()
    expect(childStageHint(-1, WEANING_STAGE_GUIDES)).toBeNull()
    expect(childStageHint(Number.NaN, WEANING_STAGE_GUIDES)).toBeNull()
    expect(childStageHint(7, [])).toBeNull()
  })
})

describe("R33 / R37: 設定のカードは、触った時点の版を固定する", () => {
  const V2 = "2026-11-11T02:00:00.654321+00:00"
  const V3 = "2026-11-11T03:00:00.111111+00:00"
  const rerenderWith = (rerender: (ui: React.ReactElement) => void, settings: DinnerSettings) =>
    rerender(
      <MealSettingsView
        owner={OWNER}
        view={buildSettingsView(context({ settings }), ME)}
        planConflicts={EMPTY_REPORT}
        stageHints={{}}
      />,
    )

  it("危険側: 人数を触った後に家族が設定を変えたら、古い入力に新しい版を付けて送らない（保存を止めて知らせる）", async () => {
    actions.saveDinnerSettings.mockResolvedValue({ status: "saved", settings: { ...SAVED, version: V3 }, deleted: false })
    const { rerender } = view()
    await ready()
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("3人分")

    // 家族が別の端末で汁物と調理時間を変えた（版が進む）。定期の再取得で届く
    rerenderWith(rerender, { ...SAVED, includeSoup: true, maxCookMinutes: 30, version: V2 })
    const basics = section("献立の基本")
    // 入力は消さない
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("3人分")
    const notice = within(basics).getByTestId("changed-elsewhere")
    expect(notice).toHaveTextContent("設定は、入力を始めた後に他の端末で変更されました")
    expect(notice).toHaveTextContent("家族の変更を上書きしないため")
    const saveButton = within(basics).getByRole("button", { name: "基本の設定を保存" })
    expect(saveButton).toBeDisabled()
    await click(saveButton)
    expect(actions.saveDinnerSettings).not.toHaveBeenCalled()

    // 最新の内容を読み込むと、家族の値（汁物あり・30 分・2 人）から始まり、その版で送れる
    await click(within(notice).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(basics).queryByTestId("changed-elsewhere")).not.toBeInTheDocument()
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("2人分")
    expect(within(basics).getByRole("button", { name: /献立に付ける/ })).toHaveAttribute("aria-pressed", "true")
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    await click(within(basics).getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerSettings.mock.calls[0][0]).toMatchObject({
      version: V2,
      servings: 3,
      includeSoup: true,
      maxCookMinutes: 30,
    })
  })

  it("危険側: 常備品・子どもの食事の段階のカードも、触った後に版が進んだら保存を止める", async () => {
    const { rerender } = view()
    await ready()
    const salt = getMealLookup().index.byId.get("salt")
    await click(within(section("常備品")).getByRole("button", { name: salt?.name ?? "" }))
    fireEvent.change(within(section("子どもの食事")).getByLabelText(/はると/), { target: { value: "weaning_mid" } })

    rerenderWith(rerender, { ...SAVED, servings: 4, version: V2 })
    for (const [name, label] of [
      ["常備品", "常備品を保存"],
      ["子どもの食事", "食事の段階を保存"],
    ] as const) {
      const area = section(name)
      expect(within(area).getByTestId("changed-elsewhere"), name).toHaveTextContent("他の端末で変更されました")
      const button = within(area).getByRole("button", { name: label })
      expect(button, name).toBeDisabled()
      await click(button)
    }
    expect(actions.saveDinnerSettings).not.toHaveBeenCalled()
    // 対照: 触っていない「献立の基本」は、届いた最新の値を映すだけ（知らせを出さない）
    expect(within(section("献立の基本")).queryByTestId("changed-elsewhere")).not.toBeInTheDocument()
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("4人分")
  })

  it("正常側: 自分が別のカードを保存して進んだ版は、家族の変更と取り違えない（入力を残し、最新の版で送る）", async () => {
    actions.saveDinnerSettings.mockResolvedValueOnce({
      status: "saved",
      settings: { ...SAVED, stapleIngredientIds: ["salt"], version: V2 },
      deleted: false,
    })
    const { rerender } = view()
    await ready()
    // 人数を触ってから（未保存）、常備品を保存する
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    const salt = getMealLookup().index.byId.get("salt")
    await click(within(section("常備品")).getByRole("button", { name: salt?.name ?? "" }))
    await click(screen.getByRole("button", { name: "常備品を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(section("常備品")).getByRole("status")).toHaveTextContent("設定を保存しました。"))

    // 保存の結果がまだ画面へ届いていない間は、古い値をもとにした保存を止める（自分の保存を巻き戻さない）
    const basics = section("献立の基本")
    const pendingButton = within(basics).getByRole("button", { name: "基本の設定を保存" })
    expect(pendingButton).toBeDisabled()
    expect(within(basics).getByText(/先ほど保存した設定を読み込んでいます/)).toBeInTheDocument()
    await click(pendingButton)
    expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1)

    // 保存した内容が届いた（版 V2）。人数の入力は残り、知らせは出ない
    rerenderWith(rerender, { ...SAVED, stapleIngredientIds: ["salt"], version: V2 })
    expect(within(basics).queryByTestId("changed-elsewhere")).not.toBeInTheDocument()
    expect(within(basics).queryByText(/先ほど保存した設定を読み込んでいます/)).not.toBeInTheDocument()
    expect(screen.getByTestId("settings-servings")).toHaveTextContent("3人分")

    actions.saveDinnerSettings.mockResolvedValueOnce({
      status: "saved",
      settings: { ...SAVED, servings: 3, stapleIngredientIds: ["salt"], version: V3 },
      deleted: false,
    })
    await click(within(basics).getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(2))
    // 最新の版と、保存済みの常備品のまま送る（自分の常備品の保存を巻き戻さない）
    expect(actions.saveDinnerSettings.mock.calls[1][0]).toMatchObject({
      version: V2,
      servings: 3,
      stapleIngredientIds: ["salt"],
    })
  })

  it("危険側: 自分の保存の後に家族も変えていたら（自分の連なりの外の版）、残っていた入力は保存させない", async () => {
    actions.saveDinnerSettings.mockResolvedValueOnce({
      status: "saved",
      settings: { ...SAVED, stapleIngredientIds: ["salt"], version: V2 },
      deleted: false,
    })
    const { rerender } = view()
    await ready()
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    const salt = getMealLookup().index.byId.get("salt")
    await click(within(section("常備品")).getByRole("button", { name: salt?.name ?? "" }))
    await click(screen.getByRole("button", { name: "常備品を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    // 届いたのは、家族がさらに変えた後の版（V3）
    rerenderWith(rerender, { ...SAVED, stapleIngredientIds: ["salt"], includeSoup: true, version: V3 })
    const basics = section("献立の基本")
    expect(within(basics).getByTestId("changed-elsewhere")).toHaveTextContent("他の端末で変更されました")
    expect(within(basics).getByRole("button", { name: "基本の設定を保存" })).toBeDisabled()
  })

  it("釦だけで変わる未保存の入力（人数の増減）が在る間は、自動の取り直しを見送る（対照: 触る前は取り直す）", async () => {
    view()
    await ready()
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(actions.refresh).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/入力や保存の途中のため、自動の更新を止めています/)).toBeInTheDocument()
  })
})

describe("R45: 人数を変えた後、既に在る献立へ反映するかを選ぶ", () => {
  const V2 = "2026-11-11T02:00:00.654321+00:00"
  async function saveServings() {
    await click(screen.getByRole("button", { name: "人数を1人増やす" }))
    await click(screen.getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
  }

  it("変更前の人数のままの料理が在れば件数を知らせ、選んだときだけ「これからの献立」をそろえる", async () => {
    actions.saveDinnerSettings.mockResolvedValue({
      status: "saved",
      settings: { ...SAVED, servings: 3, version: V2 },
      deleted: false,
      planServingsMismatch: 4,
    })
    actions.saveDinnerRequest.mockResolvedValue({
      status: "saved",
      revision: 9,
      notices: ["これからの献立4品を3人分にしました。"],
      grocery: { ok: true, status: "saved" },
      changedEntries: 4,
    })
    view()
    await ready()
    await saveServings()
    const prompt = await screen.findByTestId("settings-servings-prompt")
    expect(prompt).toHaveTextContent("これからの献立のうち 4 品は、変更前の人数のままです")
    expect(prompt).toHaveTextContent("既に在る献立は自動では変えていません")
    // 設定を保存しただけでは、献立は書き換えない
    expect(actions.saveDinnerRequest).not.toHaveBeenCalled()

    await click(within(prompt).getByRole("button", { name: "これからの献立も3人分にする" }))
    await waitFor(() => expect(actions.saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "servings_upcoming", servings: 3 })
    await waitFor(() =>
      expect(within(section("献立の基本")).getByRole("status")).toHaveTextContent("これからの献立4品を3人分にしました。"),
    )
    expect(screen.queryByTestId("settings-servings-prompt")).not.toBeInTheDocument()
  })

  it("「そのままにする」を選べば、献立へは何も送らない", async () => {
    actions.saveDinnerSettings.mockResolvedValue({
      status: "saved",
      settings: { ...SAVED, servings: 3, version: V2 },
      deleted: false,
      planServingsMismatch: 1,
    })
    view()
    await ready()
    await saveServings()
    const prompt = await screen.findByTestId("settings-servings-prompt")
    await click(within(prompt).getByRole("button", { name: "そのままにする" }))
    expect(screen.queryByTestId("settings-servings-prompt")).not.toBeInTheDocument()
    expect(actions.saveDinnerRequest).not.toHaveBeenCalled()
  })

  it("危険側: 件数を確かめられなかったときは「ずれは無い」と見せず、献立で確かめるよう促す", async () => {
    actions.saveDinnerSettings.mockResolvedValue({
      status: "saved",
      settings: { ...SAVED, servings: 3, version: V2 },
      deleted: false,
      planServingsMismatch: null,
    })
    view()
    await ready()
    await saveServings()
    const prompt = await screen.findByTestId("settings-servings-prompt")
    expect(prompt).toHaveTextContent("確かめられませんでした")
    expect(within(prompt).getByRole("link", { name: "献立の画面で確認する" })).toHaveAttribute("href", "/chores/meals/plan")
    expect(within(prompt).queryByRole("button", { name: /これからの献立も/ })).not.toBeInTheDocument()
  })

  it("対照: ずれが 0 件・人数を変えていない保存では、尋ねない", async () => {
    actions.saveDinnerSettings.mockResolvedValue({
      status: "saved",
      settings: { ...SAVED, servings: 3, version: V2 },
      deleted: false,
      planServingsMismatch: 0,
    })
    const zero = view()
    await ready()
    await saveServings()
    await waitFor(() => expect(within(section("献立の基本")).getByRole("status")).toHaveTextContent("設定を保存しました。"))
    expect(screen.queryByTestId("settings-servings-prompt")).not.toBeInTheDocument()
    await act(async () => {})
    zero.unmount()

    // 人数は変えず、調理時間だけを変えた（献立に人数のずれが在っても、この保存では尋ねない）
    actions.saveDinnerSettings.mockReset()
    actions.saveDinnerSettings.mockResolvedValue({
      status: "saved",
      settings: { ...SAVED, maxCookMinutes: 30, version: V2 },
      deleted: false,
      planServingsMismatch: 5,
    })
    view()
    await ready()
    fireEvent.change(screen.getByLabelText("1 品あたりの調理時間の上限"), { target: { value: "30" } })
    await click(screen.getByRole("button", { name: "基本の設定を保存" }))
    await waitFor(() => expect(actions.saveDinnerSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(section("献立の基本")).getByRole("status")).toHaveTextContent("設定を保存しました。"))
    expect(screen.queryByTestId("settings-servings-prompt")).not.toBeInTheDocument()
  })
})

describe("R01（設定の重なり）: 判定できないアレルギーの登録が原因の「確認が必要」", () => {
  it("重なりの一覧の前に、登録が原因であることを出す（対照: 無ければ出さない）", async () => {
    const hold = "判定できないアレルギーの登録（「マンゴー」）があるため、料理の原材料を確かめられず、献立を確定できません。設定で一覧から選び直すと、該当する料理だけを外して確定できます。"
    const withHold = view(
      {},
      {
        planConflicts: {
          ...EMPTY_REPORT,
          conflicts: [conflict({ verdict: "label_check", ingredientNames: [], causedByThisChange: false })],
          holdMessage: hold,
        },
      },
    )
    await ready()
    const panel = screen.getByRole("region", { name: "今の献立との重なり" })
    expect(within(panel).getByTestId("settings-conflict-hold")).toHaveTextContent(hold)
    expect(within(panel).getByTestId("settings-conflict-hold")).toHaveTextContent("料理そのものの材料の問題ではなく")
    await act(async () => {})
    withHold.unmount()

    view({}, { planConflicts: { ...EMPTY_REPORT, conflicts: [conflict()], holdMessage: null } })
    await ready()
    expect(screen.queryByTestId("settings-conflict-hold")).not.toBeInTheDocument()
  })
})

describe("R44 / C-75: 覚えた好みを、設定の画面から直す", () => {
  // 献立の画面に出なくなった古い評価（7 日より前）
  const old = feedback({ id: "c3000000-0000-4000-8000-000000000009", eatenOn: "2026-10-01", taste: 1, effort: 2, again: null })
  const theirs = feedback({ id: "c3000000-0000-4000-8000-000000000002", profileId: SPOUSE, eatenOn: "2026-10-02" })
  const seeds = { [old.id]: { version: VERSION, dishTitle: "肉じゃが" } }
  const savedFeedback: DinnerSaveSuccess = { status: "saved", revision: null, notices: [], grocery: null }

  it("自分の古い評価を開いて直すと、評価の ID・開いた時点の版・元の料理と日付のまま送る", async () => {
    actions.saveDinnerRequest.mockResolvedValue(savedFeedback)
    view({ feedback: [old, theirs] }, { feedbackEdits: seeds })
    await ready()
    const area = section("覚えた好み")
    const row = within(area)
      .getAllByTestId("settings-feedback")
      .find((item) => item.textContent?.includes("たろう")) as HTMLElement
    await click(within(row).getByRole("button", { name: "10/1（木）の「肉じゃが」の評価を編集" }))
    const editor = within(row).getByRole("group", { name: "10/1（木）の「肉じゃが」の評価の編集" })
    // 今の評価から始まる
    expect(within(within(editor).getByRole("group", { name: "味" })).getByRole("button", { name: "苦手" })).toHaveAttribute("aria-pressed", "true")
    await click(within(within(editor).getByRole("group", { name: "味" })).getByRole("button", { name: "おいしい" }))
    await click(within(within(editor).getByRole("group", { name: "また食べたいか" })).getByRole("button", { name: "また食べたい" }))
    await click(within(editor).getByRole("checkbox", { name: "好みに反映しない" }))
    await click(within(editor).getByRole("button", { name: "評価を更新" }))

    await waitFor(() => expect(actions.saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "feedback",
      id: old.id,
      version: VERSION,
      recipeId: "nikujaga",
      dishTitle: "肉じゃが",
      eatenOn: "2026-10-01",
      taste: 3,
      effort: 2,
      again: true,
      excludeFromLearning: true,
    })
    // 持ち主は送らない（DB が本人に固定する）
    expect(Object.keys(actions.saveDinnerRequest.mock.calls[0][0])).not.toContain("profileId")
    await waitFor(() => expect(within(section("覚えた好み")).getByRole("status")).toHaveTextContent("評価を更新しました。"))
    // 保存できたら編集を閉じる
    expect(within(section("覚えた好み")).queryByRole("group", { name: /評価の編集/ })).not.toBeInTheDocument()
    expect(actions.deleteDishFeedback).not.toHaveBeenCalled()
  })

  it("対照: 家族の評価・編集の値を渡されていない評価には、編集の釦を出さない", async () => {
    view({ feedback: [old, theirs] }, { feedbackEdits: seeds })
    await ready()
    const rows = within(section("覚えた好み")).getAllByTestId("settings-feedback")
    const theirRow = rows.find((item) => item.textContent?.includes("はなこ")) as HTMLElement
    expect(within(theirRow).queryByRole("button")).not.toBeInTheDocument()
    cleanup()

    view({ feedback: [old] })
    await ready()
    const row = within(section("覚えた好み")).getByTestId("settings-feedback")
    expect(within(row).queryByRole("button", { name: /評価を編集/ })).not.toBeInTheDocument()
    expect(within(row).getByRole("button", { name: /評価を削除/ })).toBeInTheDocument()
  })

  it("危険側: 編集を開いた後に同じ評価が別の端末で変わったら、保存を止めて知らせる", async () => {
    const V2 = "2026-11-11T02:00:00.654321+00:00"
    const { rerender } = view({ feedback: [old] }, { feedbackEdits: seeds })
    await ready()
    const row = () => within(section("覚えた好み")).getByTestId("settings-feedback")
    await click(within(row()).getByRole("button", { name: /評価を編集/ }))
    await click(within(within(row()).getByRole("group", { name: "手間" })).getByRole("button", { name: "楽だった" }))
    rerender(
      <MealSettingsView
        owner={OWNER}
        view={buildSettingsView(context({ feedback: [{ ...old, taste: 2, version: V2 }] }), ME)}
        planConflicts={EMPTY_REPORT}
        stageHints={{}}
        feedbackEdits={{ [old.id]: { version: V2, dishTitle: "肉じゃが" } }}
      />,
    )
    expect(within(row()).getByTestId("changed-elsewhere")).toHaveTextContent("この評価は、入力を始めた後に他の端末で変更されました")
    const button = within(row()).getByRole("button", { name: "評価を更新" })
    expect(button).toBeDisabled()
    await click(button)
    expect(actions.saveDinnerRequest).not.toHaveBeenCalled()
    // 最新の内容を読み込むと、届いた評価（味: ふつう）から始まり、その版で送れる
    await click(within(row()).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(within(row()).getByRole("group", { name: "味" })).getByRole("button", { name: "ふつう" })).toHaveAttribute("aria-pressed", "true")
    actions.saveDinnerRequest.mockResolvedValue(savedFeedback)
    await click(within(row()).getByRole("button", { name: "評価を更新" }))
    await waitFor(() => expect(actions.saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(actions.saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "feedback", id: old.id, version: V2, taste: 2 })
  })

  it("別の端末が先に変えていた（conflict）ときは、上書きしていないと言う", async () => {
    actions.saveDinnerRequest.mockResolvedValue({
      status: "conflict",
      detail: "row_changed",
      revision: null,
      notices: ["この評価は別の端末で更新されていました。最新の内容を確認してください。"],
      grocery: null,
    })
    view({ feedback: [old] }, { feedbackEdits: seeds })
    await ready()
    const row = within(section("覚えた好み")).getByTestId("settings-feedback")
    await click(within(row).getByRole("button", { name: /評価を編集/ }))
    await click(within(row).getByRole("button", { name: "評価を更新" }))
    await waitFor(() =>
      expect(within(section("覚えた好み")).getByRole("alert")).toHaveTextContent("この評価は別の端末で更新されていました"),
    )
    expect(screen.queryByText(/評価を更新しました/)).not.toBeInTheDocument()
  })
})

describe("R01: 自由入力の「使わない食材」を、登録の前に正直に判定する", () => {
  const lexicon = buildExclusionLexicon(getMealLookup())
  // props は直列化されて画面へ届く。直列化した後の語彙でも同じ結果になること
  const wired = JSON.parse(JSON.stringify(lexicon)) as typeof lexicon

  it("語彙（判定が読む項目だけ）での判定は、実カタログでの判定と一致する（規則を書き直していない）", () => {
    const lookup = getMealLookup()
    const catalog = lexiconCatalog(wired)
    const labels = new Set<string>([
      ...DEFAULT_EXCLUSION_TERMS.flatMap((term) => term.terms),
      ...lookup.allergens.map((allergen) => allergen.name),
      ...[...lookup.index.byId.values()].flatMap((def) => [def.name, ...def.aliases]),
      ...lookup.recipes.map((recipe) => recipe.title),
      // 料理名・食材名の一部、品目名を含む語、どこにも当たらない語
      "カレー", "煮物", "炒め", "キャベ", "卵料理", "乳飲料", "ピーナッツバター", "すいか", "えび・かに",
      // 分類の語（「〜科」は含む品目で解決しない。「〜類」は総称の食材・アレルゲン名にだけ解決する）
      "なす科", "なす類", "えび類", "きのこ類全般", "焼きそばパン", "豆乳プリン",
      "マンゴー", "パクチー", "ドリアン", "ｴﾋﾞ", " 牛乳 ", "",
    ])
    expect(labels.size).toBeGreaterThan(300)
    const seen = new Set<string>()
    for (const label of labels) {
      for (const reason of ["allergy", "dislike"] as const) {
        const actual = previewExclusionLabel(label, reason, catalog)
        expect(actual, `${reason}:${label}`).toEqual(resolveExclusionLabel(label, reason, lookup))
        seen.add(actual.effect)
        seen.add(actual.status)
      }
    }
    // 対照: 3 通りの効き方と 3 通りの解決が、どれも実際に現れている（全部が同じ値で一致しているのではない）
    expect([...seen].sort()).toEqual(
      ["excludes", "holds_auto_confirm", "name_only", "no_effect", "resolved", "undetermined"].sort(),
    )
  })

  async function typeCustom(reason: "アレルギー" | "苦手", label: string) {
    const area = section("使わない食材")
    await click(within(area).getByRole("button", { name: reason }))
    await click(within(area).getByRole("button", { name: "自由に入力" }))
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: label } })
    return area
  }

  it("危険側: 一覧と照合できないアレルギーは、登録の前に「判定できない」「献立を確定できなくなる」と出す", async () => {
    // 前提: この語は、実カタログで判定できない
    expect(resolveExclusionLabel("マンゴー", "allergy", getMealLookup()).effect).toBe("holds_auto_confirm")
    view({}, { exclusionLexicon: wired })
    await ready()
    const area = await typeCustom("アレルギー", "マンゴー")
    const preview = within(area).getByTestId("exclusion-preview")
    expect(preview).toHaveAttribute("data-kind", "holds")
    expect(preview).toHaveTextContent(EXCLUSION_UNDETERMINED_LEAD)
    expect(preview).toHaveTextContent("この入力は自動では判定できません。一覧から選ぶか、食材名で登録してください。")
    expect(preview).toHaveTextContent(EXCLUSION_HOLDS_EFFECT)
    expect(preview).toHaveTextContent("登録すると、全料理が原材料の確認待ちになり、献立を確定できなくなります。")
    // 「自動では」と弱めない（実際は手でも確定できない）
    expect(preview).not.toHaveTextContent("自動では確定")
    // 判定できない入力に「外します」とは言わない
    expect(preview).not.toHaveTextContent("外します")
    expect(actions.saveFoodExclusion).not.toHaveBeenCalled()
  })

  it("危険側: 一覧と照合できない苦手は、「この入力では何も除外されません」と出す", async () => {
    expect(resolveExclusionLabel("マンゴー", "dislike", getMealLookup()).effect).toBe("no_effect")
    view({}, { exclusionLexicon: wired })
    await ready()
    const area = await typeCustom("苦手", "マンゴー")
    const preview = within(area).getByTestId("exclusion-preview")
    expect(preview).toHaveAttribute("data-kind", "no_effect")
    expect(preview).toHaveTextContent(EXCLUSION_UNDETERMINED_LEAD)
    expect(preview).toHaveTextContent(EXCLUSION_NO_EFFECT)
    expect(preview).not.toHaveTextContent("確定されなくなります")
    // 理由を変えると、効き方の説明も変わる（同じ入力でも、アレルギーなら献立を止める）
    await click(within(area).getByRole("button", { name: "アレルギー" }))
    expect(within(area).getByTestId("exclusion-preview")).toHaveAttribute("data-kind", "holds")
  })

  it("⑤ 判定できない語には、具体的な品目・食材を選び直す道をその場に出す（対照: 照合できた語には出さない）", async () => {
    view({}, { exclusionLexicon: wired })
    await ready()
    const area = await typeCustom("苦手", "からいもの")
    const reselect = within(area).getByTestId("exclusion-reselect")
    await click(within(reselect).getByRole("button", { name: "食材から選び直す" }))
    // 食材の一覧から選ぶ形へ切り替わる（自由入力の欄は消える）
    expect(within(area).getByLabelText("食材")).toBeInTheDocument()
    expect(within(area).queryByLabelText(/名前（30文字まで）/)).not.toBeInTheDocument()

    await click(within(area).getByRole("button", { name: "自由に入力" }))
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: "からいもの" } })
    await click(within(within(area).getByTestId("exclusion-reselect")).getByRole("button", { name: "対象品目から選び直す" }))
    expect(within(area).getByTestId("settings-allergen-count")).toBeInTheDocument()
    expect(actions.saveFoodExclusion).not.toHaveBeenCalled()

    // 対照: 照合できた語（乳製品）には、選び直す道を出さない
    await click(within(area).getByRole("button", { name: "自由に入力" }))
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: "乳製品" } })
    expect(within(area).getByTestId("exclusion-preview")).toHaveAttribute("data-kind", "resolved")
    expect(within(area).queryByTestId("exclusion-reselect")).not.toBeInTheDocument()
  })

  it("正常側: 総称（乳製品）・食材名は一覧と照合でき、何として扱うかを出す。名前でしか当たらない語は、その限界を出す", async () => {
    view({}, { exclusionLexicon: wired })
    await ready()
    const area = await typeCustom("アレルギー", "乳製品")
    const resolved = within(area).getByTestId("exclusion-preview")
    expect(resolved).toHaveAttribute("data-kind", "resolved")
    expect(resolved).toHaveTextContent("食材の一覧の「乳」として扱い、これを使う料理を献立と提案から外します。")
    expect(resolved).not.toHaveTextContent("判定できません")

    // 食材名・料理名の一部（辞書へは解決できないが、名前に含むものが在る）
    const partial = resolveExclusionLabel("きんぴら", "dislike", getMealLookup())
    expect(partial.status).toBe("name_only")
    await click(within(area).getByRole("button", { name: "苦手" }))
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: "きんぴら" } })
    const nameOnly = within(area).getByTestId("exclusion-preview")
    expect(nameOnly).toHaveAttribute("data-kind", "name_only")
    expect(nameOnly).toHaveTextContent("食材や料理の名前に含まれるかどうかで判定します")
    expect(nameOnly).toHaveTextContent(`料理 ${partial.nameMatchedRecipeIds.length} 件`)

    // 空・上限を超えた入力は判定しない
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: "   " } })
    expect(within(area).queryByTestId("exclusion-preview")).not.toBeInTheDocument()
    fireEvent.change(within(area).getByLabelText(/名前（30文字まで）/), { target: { value: "あ".repeat(31) } })
    expect(within(area).queryByTestId("exclusion-preview")).not.toBeInTheDocument()
  })

  it("危険側: 判定できない入力を登録した後は「献立と提案から外します」と言わず、何が起きるかを言う", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id, reason: request.reason, target: request.target, subject: request.subject },
      planConflicts: EMPTY_REPORT,
    }))
    view({}, { exclusionLexicon: wired })
    await ready()
    await typeCustom("アレルギー", "マンゴー")
    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    await waitFor(() => expect(actions.saveFoodExclusion).toHaveBeenCalledTimes(1))
    expect(actions.saveFoodExclusion.mock.calls[0][0]).toMatchObject({ reason: "allergy", target: { kind: "custom", label: "マンゴー" } })
    const alert = await waitFor(() => within(section("使わない食材")).getByRole("alert"))
    expect(alert).toHaveTextContent("使わない食材に登録しました。")
    expect(alert).toHaveTextContent("この登録は自動では判定できていません")
    expect(alert).toHaveTextContent("全料理が原材料の確認待ちになり、献立を確定できません")
    expect(alert).not.toHaveTextContent("献立と提案から外します")
  })

  it("対照: サーバーが返した解決の結果を優先する（語彙が無い画面でも、判定できない登録を「外します」と言わない）", async () => {
    actions.saveFoodExclusion.mockImplementation(async (request) => ({
      status: "saved",
      exclusion: { ...exclusion(), id: request.id, reason: request.reason, target: request.target, subject: request.subject },
      planConflicts: EMPTY_REPORT,
      resolution: { status: "undetermined", effect: "no_effect", targetNames: [], message: "" },
    }))
    view()
    await ready()
    await typeCustom("苦手", "マンゴー")
    await click(screen.getByRole("button", { name: "使わない食材に登録" }))
    const alert = await waitFor(() => within(section("使わない食材")).getByRole("alert"))
    expect(alert).toHaveTextContent("この登録では何も除外されていません")
    expect(alert).not.toHaveTextContent("献立と提案から外します")
  })

  it("登録済みの一覧: 判定できない除外に印と説明を付け、件数をまとめて知らせる（対照: 照合できた除外には付けない）", async () => {
    view(
      {
        exclusions: [
          exclusion({ id: "c1000000-0000-4000-8000-000000000011", target: { kind: "custom", label: "マンゴー" } }),
          exclusion({ id: "c1000000-0000-4000-8000-000000000012", reason: "dislike", target: { kind: "custom", label: "マンゴー" } }),
          exclusion({ id: "c1000000-0000-4000-8000-000000000013", target: { kind: "custom", label: "乳製品" } }),
          exclusion({ id: "c1000000-0000-4000-8000-000000000014" }),
        ],
      },
      { exclusionLexicon: wired },
    )
    await ready()
    const rows = screen.getAllByTestId("settings-exclusion")
    expect(rows).toHaveLength(4)
    // アレルギー × 判定できない: 献立の確定を止めている（自動でも手でも）
    expect(within(rows[0]).getByText("自動では判定できません")).toBeInTheDocument()
    expect(within(rows[0]).getByTestId("settings-exclusion-undetermined")).toHaveTextContent(
      "この登録がある間、全料理が原材料の確認待ちになり、献立を確定できません",
    )
    // 苦手 × 判定できない: 何も除外していない
    expect(within(rows[1]).getByTestId("settings-exclusion-undetermined")).toHaveTextContent(
      "この登録では何も除外されていません",
    )
    expect(rows[1]).not.toHaveTextContent("名前に含まれるかどうかで判定します")
    // 照合できた自由入力・一覧から選んだ品目には、判定できない印を付けない
    expect(within(rows[2]).queryByTestId("settings-exclusion-undetermined")).not.toBeInTheDocument()
    expect(rows[2]).toHaveTextContent("食材の一覧の「乳」として扱い")
    expect(within(rows[3]).queryByTestId("settings-exclusion-undetermined")).not.toBeInTheDocument()
    expect(screen.getByTestId("settings-undetermined-summary")).toHaveTextContent("自動では判定できない登録が 2 件あります")

    // 削除の確認も、実際に起きることを言う（何も除外していない登録の削除で「料理が出るようになります」と言わない）
    await click(within(rows[1]).getByRole("button", { name: /マンゴー（苦手・.*）を削除/ }))
    expect(rows[1]).toHaveTextContent("何も除外していないため、削除しても献立と提案は変わりません")
  })

  it("対照: 判定できない登録が無ければ、まとめの知らせを出さない", async () => {
    view({ exclusions: [exclusion()] }, { exclusionLexicon: wired })
    await ready()
    expect(screen.queryByTestId("settings-undetermined-summary")).not.toBeInTheDocument()
  })
})

describe("V-UI 長い日本語・押下領域", () => {
  const LONG = "とても長い自由入力の名前でも折り返して表示できることを確かめるための文字列"

  it("長い名前（自由入力の除外・子どもの名前）は折り返す", async () => {
    view({
      exclusions: [exclusion({ target: { kind: "custom", label: LONG } })],
      children: [{ id: CHILD, name: LONG, birthDate: null }],
    })
    await ready()
    const row = screen.getByTestId("settings-exclusion")
    expect(within(row).getByText(LONG).className).toContain("[overflow-wrap:anywhere]")
    expect(within(section("子どもの食事")).getByText(new RegExp(LONG)).className).toContain("[overflow-wrap:anywhere]")
  })

  it("button と a は 44px の担い手（min-h-11 / size-11 / touch-target）を持ち、transition-all を使わない", async () => {
    const { container } = view({ exclusions: [exclusion()], preferences: [preference()], feedback: [feedback()] })
    await ready()
    const targets = [...container.querySelectorAll("button, a")]
    expect(targets.length).toBeGreaterThan(30)
    for (const target of targets) {
      expect(target.className, target.textContent ?? "").toMatch(/min-h-11|size-11|touch-target/)
    }
    expect(container.innerHTML).not.toContain("transition-all")
  })
})
