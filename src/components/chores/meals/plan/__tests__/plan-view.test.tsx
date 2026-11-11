/**
 * 献立の画面（PlanView）の契約（要件台帳 C-31 / C-33 / C-36 / C-37 / C-38 / C-55 / C-81 / C-89、
 * X-02 / X-03 / X-09）。
 *
 * 暦の前提: 2026-11-11 は水曜。金曜は 2026-11-13。
 * 表示（`DinnerPlanView`）はサーバーが作る。ここは「画面が何を見せ、何を送るか」を確かめる
 * （在庫の引当・除外の判定そのものは `src/lib/meals/**` のテストが担う）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import { formatMealDateWithRelative } from "@/lib/meals/server/format"
import type {
  DinnerRequest,
  DinnerSaveSuccess,
  InterpretWishRequest,
  InterpretWishResult,
  MealAiStatusView,
} from "@/lib/meals/server/plan-requests"
import type { DinnerDayView, DinnerEntryView, DinnerPlanView } from "@/lib/meals/server/plan-views"
import { shiftYmd } from "@/lib/utils/date-jst"

const { saveDinnerRequest, interpretDinnerWish, saveGroceryRequest, refresh, replace } = vi.hoisted(() => ({
  saveDinnerRequest: vi.fn<(request: DinnerRequest) => Promise<DinnerSaveSuccess | ChoreSaveFailure>>(),
  interpretDinnerWish: vi.fn<(request: InterpretWishRequest) => Promise<InterpretWishResult>>(),
  saveGroceryRequest: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest, interpretDinnerWish }))
vi.mock("@/app/(main)/chores/meals/shopping/actions", () => ({ saveGroceryRequest }))
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
  useRouter: () => ({ refresh, replace }),
  usePathname: () => "/chores/meals/plan",
}))

import { CHORE_PENDING_PREFIX } from "@/lib/domain/chore-pending"

import { PlanView, type PlanViewProps } from "../plan-view"
import { EMPTY_PLAN_PAGE_EXTRAS, type PlanPageExtras } from "../plan-types"

const OWNER: ChoreOwner = { userId: "a1000000-0000-4000-8000-000000000001", householdId: "a1000000-0000-4000-8000-0000000000a1" }
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"
const E_MAIN = "e1000000-0000-4000-8000-000000000001"
const E_SIDE = "e1000000-0000-4000-8000-000000000002"
const E_CURRY = "e1000000-0000-4000-8000-000000000003"
const E_CUSTOM = "e1000000-0000-4000-8000-000000000004"
const V1 = "2026-11-10T00:00:00.123456+00:00"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function entry(over: Partial<DinnerEntryView> = {}): DinnerEntryView {
  return {
    id: E_MAIN,
    version: V1,
    date: TODAY,
    role: "main",
    roleLabel: "主菜",
    position: 0,
    title: "肉じゃが",
    recipeId: "nikujaga",
    isCustom: false,
    minutes: 40,
    servings: 2,
    pinned: false,
    status: "proposed",
    statusLabel: "提案",
    origin: "auto",
    originLabel: "自動",
    stock: null,
    conflict: null,
    groceryUncomputed: false,
    ...over,
  }
}

function day(date: string, entries: DinnerEntryView[] = [], over: Partial<DinnerDayView> = {}): DinnerDayView {
  return {
    date,
    label: formatMealDateWithRelative(date, TODAY),
    isToday: date === TODAY,
    isPast: date < TODAY,
    entries,
    missingRoles: [],
    ...over,
  }
}

/** 今日から 7 日。`byDate` に挙げた日だけ料理を持つ。 */
function planView(
  byDate: Record<string, DinnerEntryView[]> = {},
  over: Partial<DinnerPlanView> = {},
  dayOver: Record<string, Partial<DinnerDayView>> = {},
): DinnerPlanView {
  const from = over.from ?? TODAY
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftYmd(from, index)
    return day(date, byDate[date] ?? [], dayOver[date])
  })
  const all = days.flatMap((item) => item.entries)
  return {
    today: TODAY,
    from,
    to: shiftYmd(from, 6),
    revision: 5,
    groceryStale: false,
    servings: { value: 3, isStandard: false },
    includeSoup: false,
    maxCookMinutes: null,
    days,
    counts: {
      proposed: all.filter((item) => item.status === "proposed").length,
      confirmed: all.filter((item) => item.status === "confirmed").length,
      cooked: all.filter((item) => item.status === "cooked").length,
      conflicts: all.filter((item) => item.conflict !== null).length,
    },
    limitedExclusions: [],
    unreadableEntries: 0,
    ...over,
  }
}

const AI: Record<"none" | "ok" | "limit" | "exhausted", MealAiStatusView> = {
  none: { state: "not_configured", resetsAt: null, resetsAtLabel: null, message: "AI 補助は設定されていません。自動献立はそのまま使えます。" },
  ok: { state: "available", resetsAt: null, resetsAtLabel: null, message: "AI 補助を使えます（希望の文の読み取りだけを手伝います）。" },
  limit: { state: "household_limit", resetsAt: null, resetsAtLabel: null, message: "AI 補助は本日の上限（10 回）に達しました。自動献立はそのまま使えます。" },
  exhausted: {
    state: "provider_exhausted",
    resetsAt: "2026-11-12T00:00:00.000Z",
    resetsAtLabel: "11月12日 9:00",
    message: "AI 補助の無料枠が終了しました。11月12日 9:00 以降に再開します。自動献立はそのまま使えます。",
  },
}

function props(over: Partial<PlanViewProps> = {}): PlanViewProps {
  return { owner: OWNER, view: planView(), extras: EMPTY_PLAN_PAGE_EXTRAS, ai: AI.none, ...over }
}
function view(over: Partial<PlanViewProps> = {}) {
  return render(<PlanView {...props(over)} />)
}

const saved = (over: Partial<DinnerSaveSuccess> = {}): DinnerSaveSuccess => ({
  status: "saved",
  revision: 6,
  notices: [],
  grocery: { ok: true, status: "saved" },
  ...over,
})

const createButton = (days = 7) => screen.getByRole("button", { name: `${days}日分の献立を作る` })
const dayCard = (date: string) => {
  const found = screen.getAllByTestId("plan-day").find((card) => card.getAttribute("data-date") === date)
  if (!found) throw new Error(`day card not found: ${date}`)
  return found
}
async function ready() {
  await waitFor(() => expect(createButton()).toBeEnabled())
}
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
function interpreted(over: Partial<Extract<InterpretWishResult, { ok: true }>> = {}): InterpretWishResult {
  return {
    ok: true,
    via: "rules",
    constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: ["fish"], avoidTags: [], maxMinutes: 30, preferRecipeIds: [] },
    summary: [
      { kind: "pin", date: FRIDAY, dateLabel: "11/13（金）", recipeId: "curry_rice", title: "カレーライス" },
      { kind: "prefer_tag", tag: "fish", label: "魚" },
      { kind: "max_minutes", minutes: 30 },
    ],
    unparsed: ["なんとなく軽め"],
    truncated: false,
    ai: AI.none,
    revision: 5,
    pinNotices: [],
    ...over,
  }
}
async function typeWish(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("希望（任意）"), { target: { value: text } })
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(async () => {
  // 端末の控えの読み込み（マウント後の非同期の state 更新）を流し切ってから片付ける
  await act(async () => {})
  cleanup()
  vi.restoreAllMocks()
})

describe("C-31 開始日と日数からワンタッチで作る", () => {
  it("既定は今日から 7 日分。1 回の押下で、提案の作成を送る（操作 ID・献立の版つき）", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    view()
    await ready()
    expect((screen.getByLabelText("開始日") as HTMLSelectElement).value).toBe(TODAY)
    expect((screen.getByLabelText("作る日数") as HTMLSelectElement).value).toBe("7")
    await click(createButton())
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    const request = saveDinnerRequest.mock.calls[0][0]
    expect(request).toEqual({
      op: "generate",
      operationId: expect.stringMatching(UUID),
      expectedRevision: 5,
      startDate: TODAY,
      days: 7,
      constraints: null,
      mode: "auto",
    })
    // 世帯 ID・人数は送らない（世帯はサーバーが決め、人数は保存済みの設定を使う）
    expect(JSON.stringify(request)).not.toContain(OWNER.householdId)
    expect(await screen.findByText("7日分の献立を作りました（自動）。")).toBeInTheDocument()
    expect(refresh).toHaveBeenCalled()
  })

  it("日数を 1 にすると、1 日分だけを送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    view()
    await ready()
    fireEvent.change(screen.getByLabelText("作る日数"), { target: { value: "1" } })
    await click(createButton(1))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "generate", startDate: TODAY, days: 1 })
    expect(await screen.findByText("1日分の献立を作りました（自動）。")).toBeInTheDocument()
  })

  it("日数は 1〜7 だけを選べる", async () => {
    view()
    await ready()
    const options = within(screen.getByLabelText("作る日数")).getAllByRole("option")
    expect(options.map((option) => option.textContent)).toEqual(["1日分", "2日分", "3日分", "4日分", "5日分", "6日分", "7日分"])
  })

  it("開始日を変えると、その日からの表示へ移る（URL に持つ）", async () => {
    view()
    await ready()
    fireEvent.change(screen.getByLabelText("開始日"), { target: { value: FRIDAY } })
    expect(replace).toHaveBeenCalledWith(`/chores/meals/plan?start=${FRIDAY}`, { scroll: false })
  })

  it("連打しても 1 回しか送らない（保存中は釦を止める）", async () => {
    const pending = deferred<DinnerSaveSuccess>()
    saveDinnerRequest.mockReturnValue(pending.promise)
    view()
    await ready()
    await click(createButton())
    expect(createButton()).toBeDisabled()
    await click(createButton())
    expect(saveDinnerRequest).toHaveBeenCalledTimes(1)
    expect(screen.getByText("保存しています…")).toBeInTheDocument()
    await act(async () => {
      pending.resolve(saved())
    })
    await waitFor(() => expect(createButton()).toBeEnabled())
  })

  it("人数は設定の値を出す。未設定なら標準の 2 人分と明示し、設定へのリンクを出す", async () => {
    view({ view: planView({}, { servings: { value: 2, isStandard: true } }) })
    await ready()
    expect(screen.getByText(/人数が未設定のため、標準の2人分で計算しています/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "人数や条件を設定で変える" })).toHaveAttribute("href", "/chores/meals/settings")
    cleanup()
    // 対照: 設定済みなら「未設定」とは言わない
    view()
    expect(screen.getByText("3人分")).toBeInTheDocument()
    expect(screen.queryByText(/人数が未設定/)).toBeNull()
  })

  it("過ぎた日を含む期間では、作成の釦を出さず、記録だけができると言う", async () => {
    const from = shiftYmd(TODAY, -7)
    view({ view: planView({ [shiftYmd(TODAY, -1)]: [entry({ date: shiftYmd(TODAY, -1), status: "confirmed", statusLabel: "確定" })] }, { from }) })
    await waitFor(() => expect(screen.getByRole("button", { name: "肉じゃがを「作った」にする" })).toBeEnabled())
    expect(screen.queryByRole("button", { name: /日分の献立を作る/ })).toBeNull()
    expect(screen.getByText(/「作った」「作らなかった」の記録だけができます/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "今日からの献立に戻る" })).toHaveAttribute("href", "/chores/meals/plan")
  })
})

describe("C-33 固定した料理は、作り直し・差し替えで保持する", () => {
  const curry = entry({ id: E_CURRY, date: FRIDAY, title: "カレーライス", recipeId: "curry_rice", pinned: true })
  const side = entry({ id: E_SIDE, date: FRIDAY, role: "side", roleLabel: "副菜", title: "ほうれん草のおひたし", recipeId: "spinach_ohitashi", position: 1 })

  it("固定の印を出し、固定した料理の差し替えは押せない（解除は明示の操作）", async () => {
    view({ view: planView({ [FRIDAY]: [curry, side] }) })
    await ready()
    const card = within(dayCard(FRIDAY))
    const rows = card.getAllByTestId("plan-entry")
    expect(within(rows[0]).getByText("固定")).toBeInTheDocument()
    expect(within(rows[1]).queryByText("固定")).toBeNull()
    expect(card.getByRole("button", { name: "カレーライスを差し替え" })).toBeDisabled()
    expect(card.getByRole("button", { name: "カレーライスの固定を解除" })).toHaveAttribute("aria-pressed", "true")
    // 対照: 固定していない料理は差し替えられる
    expect(card.getByRole("button", { name: "ほうれん草のおひたしを差し替え" })).toBeEnabled()
    expect(card.getByRole("button", { name: "ほうれん草のおひたしを固定する" })).toHaveAttribute("aria-pressed", "false")
  })

  it("固定・解除は、枠の ID と版を送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [FRIDAY]: [curry, side] }) })
    await ready()
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしを固定する" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "pin", entryId: E_SIDE, version: V1, pinned: true })
    await waitFor(() => expect(createButton()).toBeEnabled())
    await click(screen.getByRole("button", { name: "カレーライスの固定を解除" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    expect(saveDinnerRequest.mock.calls[1][0]).toEqual({ op: "pin", entryId: E_CURRY, version: V1, pinned: false })
  })

  it("作り直しの後、固定した料理をそのまま残したことを結果に出す", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto", notices: ["固定した料理・作った料理は、そのまま残しました。"] }))
    view({ view: planView({ [FRIDAY]: [curry, side] }) })
    await ready()
    await click(createButton())
    expect(await screen.findByText("固定した料理・作った料理は、そのまま残しました。")).toBeInTheDocument()
  })

  it("1 品の差し替えは枠の版を送り、2 回目は直前に見送った料理を添える", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [FRIDAY]: [curry, side] }) })
    await ready()
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしを差し替え" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "replace_dish", entryId: E_SIDE, version: V1 })
    await waitFor(() => expect(createButton()).toBeEnabled())
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしを差し替え" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    expect(saveDinnerRequest.mock.calls[1][0]).toMatchObject({ op: "replace_dish", avoidRecipeIds: ["spinach_ohitashi"] })
  })

  it("1 日の差し替えは、その日だけを献立の版つきで送る。固定だけの日は押せない", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [FRIDAY]: [curry, side], [TODAY]: [entry({ pinned: true })] }) })
    await ready()
    expect(within(dayCard(TODAY)).getByRole("button", { name: /の献立を差し替え$/ })).toBeDisabled()
    expect(within(dayCard(TODAY)).getByText(/差し替えるものがありません/)).toBeInTheDocument()
    await click(within(dayCard(FRIDAY)).getByRole("button", { name: /の献立を差し替え$/ }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "replace_day",
      operationId: expect.stringMatching(UUID),
      expectedRevision: 5,
      date: FRIDAY,
    })
  })

  it("日付の移動は、1 品の操作から移動先の日を選んで送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ notices: ["11/14（土）は副菜が 2 品になりました。元の料理はそのまま残しています。"] }))
    view({ view: planView({ [FRIDAY]: [curry, side] }) })
    await ready()
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("移動先の日"), { target: { value: "2026-11-14" } })
    await click(within(dialog).getByRole("button", { name: "この日へ移動" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "move", entryId: E_SIDE, version: V1, toDate: "2026-11-14" })
    expect(await screen.findByText(/副菜が 2 品になりました/)).toBeInTheDocument()
  })
})

describe("希望 → 読み取り結果 → 採用（C-33 / C-38 / C-81）", () => {
  it("「希望を反映」は読み取るだけで、献立を変えない。採用して初めて作成を送る", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted())
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    view()
    await ready()
    // 希望が空の間は押せない
    expect(screen.getByRole("button", { name: "希望を反映" })).toBeDisabled()
    await typeWish(" 金曜はカレー、魚多め、30分以内、なんとなく軽め ")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    expect(interpretDinnerWish).toHaveBeenCalledWith({
      wish: "金曜はカレー、魚多め、30分以内、なんとなく軽め",
      startDate: TODAY,
      days: 7,
    })
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).getByText("11/13（金）は「カレーライス」に固定")).toBeInTheDocument()
    expect(within(reading).getByText("「魚」の料理を多めに")).toBeInTheDocument()
    expect(within(reading).getByText("30分以内で作れる料理を優先")).toBeInTheDocument()
    expect(within(reading).getByText("反映できなかった部分: 「なんとなく軽め」")).toBeInTheDocument()
    // 経路を実際のとおりに出す（規則だけで読んだものを AI と言わない）
    expect(within(reading).getByText(/読み取り: 自動（決まった規則による読み取り）/)).toBeInTheDocument()
    expect(within(reading).getByText(/この時点では、献立は変わっていません/)).toBeInTheDocument()
    expect(saveDinnerRequest).not.toHaveBeenCalled()

    await click(within(reading).getByRole("button", { name: "この内容で献立を作る" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "generate",
      operationId: expect.stringMatching(UUID),
      // 読み取りの基にした献立の版（サーバーが採用の直前に検証し直す）
      expectedRevision: 5,
      startDate: TODAY,
      days: 7,
      constraints: { pins: [{ date: FRIDAY, recipeId: "curry_rice" }], preferTags: ["fish"], avoidTags: [], maxMinutes: 30, preferRecipeIds: [] },
      mode: "auto",
    })
    // 作成が成立したら、読み取り結果は片付ける（古い献立に対する読み取りを残さない）
    await waitFor(() => expect(screen.queryByRole("region", { name: "希望の読み取り結果" })).toBeNull())
  })

  it("AI 補助で読み取った結果は「AI 補助」と出し、採用すると AI 補助の経路として送る", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted({ via: "ai", unparsed: [], ai: AI.ok }))
    saveDinnerRequest.mockResolvedValue(saved({ via: "ai_assisted" }))
    view({ ai: AI.ok })
    await ready()
    await typeWish("金曜はカレーがいいな")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).getByText(/読み取り: AI 補助/)).toBeInTheDocument()
    await click(within(reading).getByRole("button", { name: "この内容で献立を作る" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "generate", mode: "ai_assisted" })
    expect(await screen.findByText("7日分の献立を作りました（AI 補助で読み取った希望を使いました）。")).toBeInTheDocument()
  })

  it("対照: サーバーが自動で作ったと答えたら、AI 補助で読み取っていても「自動」と出す", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted({ via: "ai", unparsed: [], ai: AI.ok }))
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    view({ ai: AI.ok })
    await ready()
    await typeWish("金曜はカレーがいいな")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    await click(within(await screen.findByRole("region", { name: "希望の読み取り結果" })).getByRole("button", { name: "この内容で献立を作る" }))
    expect(await screen.findByText("7日分の献立を作りました（自動）。")).toBeInTheDocument()
  })

  it("C-38: 読み取りを待つ間に献立が変わっていたら「他の端末で変更されました」と出し、採用の釦を出さない", async () => {
    // 画面が見ている版は 5、サーバーが読み取りの時に見た版は 6
    interpretDinnerWish.mockResolvedValue(interpreted({ revision: 6 }))
    view()
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).getByRole("alert")).toHaveTextContent("他の端末で変更されました")
    expect(within(reading).getByRole("alert")).toHaveTextContent("読み取った希望は適用していません")
    expect(within(reading).queryByRole("button", { name: "この内容で献立を作る" })).toBeNull()
    // 自動では適用しない。最新の献立を読み直すだけ
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("C-38: 読み取った後に他の端末の変更が届いたら、採用の釦を引っ込める", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted())
    const { rerender } = view()
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).getByRole("button", { name: "この内容で献立を作る" })).toBeEnabled()
    // 他の端末の変更が届いた（献立の版が進んだ）
    rerender(<PlanView {...props({ view: planView({}, { revision: 6 }) })} />)
    const stale = screen.getByRole("region", { name: "希望の読み取り結果" })
    expect(within(stale).getByRole("alert")).toHaveTextContent("他の端末で変更されました")
    expect(within(stale).queryByRole("button", { name: "この内容で献立を作る" })).toBeNull()
    expect(saveDinnerRequest).not.toHaveBeenCalled()
  })

  it("読み取りの間は、献立を変える操作を止める（待つ間の変更が自分の操作と混ざらない）", async () => {
    const pending = deferred<InterpretWishResult>()
    interpretDinnerWish.mockReturnValue(pending.promise)
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    expect(screen.getByRole("button", { name: "希望を読み取っています…" })).toBeDisabled()
    expect(createButton()).toBeDisabled()
    expect(screen.getByRole("button", { name: "肉じゃがを差し替え" })).toBeDisabled()
    await act(async () => {
      pending.resolve(interpreted())
    })
    await waitFor(() => expect(createButton()).toBeEnabled())
  })

  it("読み取れなかったときは理由を出し、希望を使わない作成はそのまま使える", async () => {
    interpretDinnerWish.mockRejectedValue(new Error("fetch failed"))
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    vi.spyOn(console, "error").mockImplementation(() => {})
    view()
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    expect(await screen.findByText(/希望を読み取れませんでした/)).toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "希望の読み取り結果" })).toBeNull()
    await waitFor(() => expect(createButton()).toBeEnabled())
    await click(createButton())
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ constraints: null, mode: "auto" })
  })

  it("希望の文を変えたら、前の読み取り結果は使わない", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted())
    view()
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    await screen.findByRole("region", { name: "希望の読み取り結果" })
    await typeWish("金曜はカレーではなく魚")
    expect(screen.queryByRole("region", { name: "希望の読み取り結果" })).toBeNull()
  })

  it("希望の欄に、名前や病名を書かない旨を添える", async () => {
    view()
    await ready()
    expect(screen.getByText(/名前・病名・お子さんの情報は書かないでください/)).toBeInTheDocument()
    expect(screen.getByLabelText("希望（任意）")).toHaveAttribute("placeholder", "例: 金曜はカレー、魚多め、30分以内")
  })
})

describe("C-81 / C-89 AI の状態を正直に出し、AI が無くても作れる", () => {
  it.each([
    ["未設定", AI.none, /AI 補助は設定されていません/],
    ["利用可", AI.ok, /AI 補助を使えます/],
    ["本日の上限", AI.limit, /本日の上限（10 回）に達しました/],
    ["無料枠終了と再開時刻", AI.exhausted, /無料枠が終了しました。11月12日 9:00 以降に再開します/],
  ])("%s: 状態を文で出し、作成の釦は使える", async (_label, ai, text) => {
    saveDinnerRequest.mockResolvedValue(saved({ via: "auto" }))
    view({ ai })
    await ready()
    expect(screen.getByTestId("meal-ai-status")).toHaveTextContent(text)
    await click(createButton())
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "generate", mode: "auto", constraints: null })
  })

  it("AI が未設定でも「希望を反映」は規則で読み取れる（AI の回答とは言わない）", async () => {
    interpretDinnerWish.mockResolvedValue(interpreted({ ai: AI.none }))
    view({ ai: AI.none })
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).queryByText(/読み取り: AI 補助/)).toBeNull()
    expect(screen.getByTestId("meal-ai-status")).toHaveTextContent("AI 補助は設定されていません")
  })

  it("読み取りで AI の状態が変わったら（今回は使えなかった）、その状態を出す", async () => {
    const failed: MealAiStatusView = { state: "temporary_failure", resetsAt: null, resetsAtLabel: null, message: "今回は AI 補助を使えませんでした。規則による読み取りで続けます。" }
    interpretDinnerWish.mockResolvedValue(interpreted({ ai: failed }))
    view({ ai: AI.ok })
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(screen.getByTestId("meal-ai-status")).toHaveTextContent("今回は AI 補助を使えませんでした")
  })

  it("料理ごとに出所（自動 / AI 補助 / 手動）を出す", async () => {
    view({
      view: planView({
        [TODAY]: [
          entry(),
          entry({ id: E_SIDE, role: "side", roleLabel: "副菜", title: "きんぴらごぼう", origin: "ai_assisted", originLabel: "AI 補助", position: 1 }),
          entry({ id: E_CUSTOM, title: "おでん", recipeId: null, isCustom: true, origin: "manual", originLabel: "手動", minutes: null, position: 2 }),
        ],
      }),
    })
    await ready()
    const rows = within(dayCard(TODAY)).getAllByTestId("plan-entry")
    expect(within(rows[0]).getByText("自動")).toBeInTheDocument()
    expect(within(rows[1]).getByText("AI 補助")).toBeInTheDocument()
    expect(within(rows[2]).getByText("手動")).toBeInTheDocument()
  })

  it("C-34: 栄養のバランスを保証する文言を出さない（保証しないと言う注意書きだけ）", async () => {
    const { container } = view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    const text = container.textContent ?? ""
    expect(text).not.toMatch(/栄養バランス|バランスの良い|バランスのとれた|管理栄養士|監修済み/)
    expect(text).toMatch(/栄養のバランスを保証するものではありません/)
  })
})

describe("C-36 不足枠と理由を出す", () => {
  it("料理のある日の足りない区分を、理由と一緒に「不足」と出す（除外を破って埋めていない）", async () => {
    view({
      view: planView({ [TODAY]: [entry()] }, {}, {
        [TODAY]: {
          missingRoles: [
            { role: "side", roleLabel: "副菜", reason: "all_excluded", message: "使わない食材の設定に当たらない副菜の候補がありません。" },
          ],
        },
      }),
    })
    await ready()
    const gap = within(dayCard(TODAY)).getByTestId("plan-gap")
    expect(gap).toHaveTextContent("副菜が不足: 使わない食材の設定に当たらない副菜の候補がありません。")
    // 対照: 不足の無い日には出さない
    expect(within(dayCard(FRIDAY)).queryByTestId("plan-gap")).toBeNull()
  })

  it("作成の結果の不足枠・採用しなかった固定を、結果の補足として出す", async () => {
    saveDinnerRequest.mockResolvedValue(
      saved({
        via: "auto",
        notices: ["11/15（日）: 使える主菜の候補を、この期間で使い切りました。", "11/13（金）: 使わない食材の設定に当たるため、固定しませんでした。"],
      }),
    )
    view()
    await ready()
    await click(createButton())
    expect(await screen.findByText("11/15（日）: 使える主菜の候補を、この期間で使い切りました。")).toBeInTheDocument()
    expect(screen.getByText("11/13（金）: 使わない食材の設定に当たるため、固定しませんでした。")).toBeInTheDocument()
  })

  it("料理が 1 品も無い日は「まだありません」と出し、手で足せる", async () => {
    view()
    await ready()
    expect(within(dayCard(TODAY)).getByText("この日の献立はまだありません。")).toBeInTheDocument()
    expect(within(dayCard(TODAY)).getByRole("button", { name: /に料理を手で追加$/ })).toBeEnabled()
  })
})

describe("C-55 使わない食材の設定との衝突を見せる（勝手に置き換えない）", () => {
  const blocked = entry({
    conflict: { verdict: "blocked", message: "使わない食材の設定に当たります（卵）。選び直してください。" },
  })
  const pinnedBlocked = entry({
    id: E_CURRY,
    date: FRIDAY,
    title: "カレーライス",
    recipeId: "curry_rice",
    pinned: true,
    conflict: { verdict: "label_check", message: "原材料の確認が必要です（商品により原材料が異なる材料を含みます）。" },
  })

  it("該当の料理に理由と「選び直す」を出し、件数を上にまとめる", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [TODAY]: [blocked], [FRIDAY]: [pinnedBlocked] }) })
    await ready()
    expect(screen.getByTestId("plan-conflict-summary")).toHaveTextContent("2 品あります")
    expect(screen.getByTestId("plan-conflict-summary")).toHaveTextContent("勝手には置き換えていません")
    const today = within(dayCard(TODAY))
    expect(today.getByTestId("plan-conflict")).toHaveTextContent("使わない食材の設定に当たります（卵）")
    expect(today.getByText("使わない食材を含む")).toBeInTheDocument()
    // 選び直すのは利用者（押すまで何も送らない）
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    await click(today.getByRole("button", { name: "肉じゃがを差し替え" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "replace_dish", entryId: E_MAIN })
  })

  it("固定した料理の衝突も隠さず、解除すれば選び直せると言う", async () => {
    view({ view: planView({ [FRIDAY]: [pinnedBlocked] }) })
    await ready()
    const friday = within(dayCard(FRIDAY))
    expect(friday.getByTestId("plan-conflict")).toHaveTextContent("原材料の確認が必要です")
    expect(friday.getByTestId("plan-conflict")).toHaveTextContent("固定を解除すると差し替えられます")
    expect(friday.getByText("原材料の確認が必要")).toBeInTheDocument()
    expect(friday.getByRole("button", { name: "カレーライスを差し替え" })).toBeDisabled()
    expect(friday.getByRole("button", { name: "カレーライスの固定を解除" })).toBeEnabled()
  })

  it("対照: 衝突が無ければ、まとめの警告も料理の警告も出さない", async () => {
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    expect(screen.queryByTestId("plan-conflict-summary")).toBeNull()
    expect(screen.queryByTestId("plan-conflict")).toBeNull()
    expect(screen.queryByTestId("plan-confirm-held")).toBeNull()
    expect(screen.getByRole("button", { name: "この献立で確定" })).toBeEnabled()
  })

  it("⑤ 当たる・未確認の料理（固定・手で入れた料理を含む）が提案に在れば、確定を止めて料理と理由を言う", async () => {
    const custom = entry({
      id: E_CUSTOM,
      date: FRIDAY,
      role: "side",
      title: "ポテトサラダ",
      recipeId: null,
      isCustom: true,
      pinned: true,
      origin: "manual",
      conflict: { verdict: "label_check", message: "材料が登録されていないため、使わない食材に当たるかを確かめられません。" },
    })
    view({ view: planView({ [TODAY]: [entry()], [FRIDAY]: [custom] }) })
    await ready()
    const held = screen.getByTestId("plan-confirm-held")
    expect(held).toHaveTextContent("「ポテトサラダ」")
    expect(held).toHaveTextContent("確定できません")
    expect(screen.getByRole("button", { name: "この献立で確定" })).toBeDisabled()
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    // 対照: 作った・確定済みの料理の衝突は、確定（提案 → 確定）を止めない
    cleanup()
    view({ view: planView({ [TODAY]: [entry()], [FRIDAY]: [{ ...custom, status: "confirmed", statusLabel: "確定" }] }) })
    await ready()
    expect(screen.queryByTestId("plan-confirm-held")).toBeNull()
    expect(screen.getByRole("button", { name: "この献立で確定" })).toBeEnabled()
  })

  it("名前でしか判定できない除外があれば、判定の限界を出す", async () => {
    view({ view: planView({}, { limitedExclusions: ["パクチー"] }) })
    await ready()
    expect(screen.getByText(/別の呼び名や、加工品の原材料までは見分けられません/)).toBeInTheDocument()
    expect(screen.getByText("名前で判定している設定: パクチー")).toBeInTheDocument()
  })
})

describe("在庫の充足（計画上の引当）", () => {
  it("買い足し・要確認の材料を、理由と一緒に出す", async () => {
    view({
      view: planView({
        [TODAY]: [
          entry({
            stock: {
              level: "buy",
              label: "買い足し",
              description: "買い足しが必要です",
              missing: [{ name: "豚こま切れ肉", detail: "あと200g・量が足りません" }],
              toCheck: [{ name: "じゃがいも", detail: "数量が登録されていません" }],
            },
          }),
        ],
      }),
    })
    await ready()
    const row = within(dayCard(TODAY)).getByTestId("plan-entry")
    expect(within(row).getByText("買い足し")).toBeInTheDocument()
    expect(within(row).getByText("買い足し: 豚こま切れ肉（あと200g・量が足りません）")).toBeInTheDocument()
    expect(within(row).getByText("要確認: じゃがいも（数量が登録されていません）")).toBeInTheDocument()
  })
})

describe("C-37 手動料理・確定・作った／作らなかった", () => {
  const custom = entry({
    id: E_CUSTOM,
    title: "おでん",
    recipeId: null,
    isCustom: true,
    minutes: null,
    origin: "manual",
    originLabel: "手動",
    pinned: true,
    groceryUncomputed: true,
  })

  it("材料が未登録の手動料理は「買い物の自動計算の対象外」と出し、材料の追加へつなげる", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    const extras: PlanPageExtras = { ...EMPTY_PLAN_PAGE_EXTRAS, customByEntry: { [E_CUSTOM]: [] } }
    view({ view: planView({ [TODAY]: [custom] }), extras })
    await ready()
    const row = within(dayCard(TODAY)).getByTestId("plan-entry")
    expect(within(row).getByText("材料が未登録のため、買い物の自動計算の対象外です。")).toBeInTheDocument()
    await click(within(row).getByRole("button", { name: "おでんの材料を追加" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/材料を登録しない料理は、買い物の自動計算の対象外になります/)).toBeInTheDocument()
    await click(within(dialog).getByRole("button", { name: "材料を足す" }))
    fireEvent.change(within(dialog).getByLabelText("材料 1 の名前"), { target: { value: "大根" } })
    fireEvent.change(within(dialog).getByLabelText("材料 1 の量"), { target: { value: "300" } })
    await click(within(dialog).getByRole("button", { name: "変更を保存" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "custom_dish",
      id: E_CUSTOM,
      version: V1,
      date: TODAY,
      role: "main",
      title: "おでん",
      ingredients: [{ name: "大根", amount: 300, unit: "g" }],
    })
  })

  it("料理を手で追加: 新しい ID を 1 回だけ作り、材料なしは null で送る（対象外と知らせる）", async () => {
    saveDinnerRequest.mockResolvedValue(
      saved({ notices: ["材料が登録されていないため、この料理は買い物の自動計算に入りません。材料を足すと計算されます。"] }),
    )
    view()
    await ready()
    await click(within(dayCard(FRIDAY)).getByRole("button", { name: /に料理を手で追加$/ }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("料理名"), { target: { value: " 手巻き寿司 " } })
    await click(within(dialog).getByRole("button", { name: "この料理を追加" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "custom_dish",
      id: expect.stringMatching(UUID),
      version: null,
      date: FRIDAY,
      role: "main",
      title: "手巻き寿司",
      ingredients: null,
    })
    expect(await screen.findByText(/この料理は買い物の自動計算に入りません/)).toBeInTheDocument()
  })

  it("⑤ 手で入れた料理が使わない食材に当たったら、保存の結果を警告として出す（補足に埋もれさせない）", async () => {
    const warning = "「ポテトサラダ」は使わない食材の設定に当たります（マヨネーズ）。献立には残しましたが、このままでは確定できません。料理か材料を選び直してください。"
    saveDinnerRequest.mockResolvedValue(saved({ notices: [warning], exclusionWarning: { verdict: "blocked", message: warning } }))
    view()
    await ready()
    await click(within(dayCard(FRIDAY)).getByRole("button", { name: /に料理を手で追加$/ }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("料理名"), { target: { value: "ポテトサラダ" } })
    await click(within(dialog).getByRole("button", { name: "この料理を追加" }))
    const notice = await screen.findByTestId("plan-notice")
    expect(within(notice).getByRole("alert")).toHaveTextContent("「ポテトサラダ」を献立へ追加しました。")
    expect(within(notice).getByRole("alert")).toHaveTextContent("使わない食材の設定に当たります（マヨネーズ）")
    expect(within(notice).queryByRole("status")).toBeNull()
  })

  it("料理名が空なら送らない", async () => {
    view()
    await ready()
    await click(within(dayCard(FRIDAY)).getByRole("button", { name: /に料理を手で追加$/ }))
    const dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "この料理を追加" }))
    expect(within(dialog).getByRole("alert")).toHaveTextContent("料理名を入力してください。")
    expect(saveDinnerRequest).not.toHaveBeenCalled()
  })

  it("提案 →「この献立で確定」: 表示中の期間と献立の版を送り、買い物への導線を出す", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    expect(screen.getByText(/確定した料理だけが、買い物リストの自動計算に入ります/)).toBeInTheDocument()
    await click(screen.getByRole("button", { name: "この献立で確定" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "confirm", expectedRevision: 5, startDate: TODAY, days: 7 })
    expect(await screen.findByText(/献立を確定しました/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "買い物リストを見る" })).toHaveAttribute("href", "/chores/meals/shopping")
  })

  it("対照: 提案が無ければ確定の釦を出さない", async () => {
    view({ view: planView({ [TODAY]: [entry({ status: "confirmed", statusLabel: "確定" })] }) })
    await ready()
    expect(screen.queryByRole("button", { name: "この献立で確定" })).toBeNull()
    expect(screen.getByText("この期間の料理は、すべて確定済みです。")).toBeInTheDocument()
  })

  it("買い物の更新だけ失敗したら、献立の成功と分けて知らせる", async () => {
    saveDinnerRequest.mockResolvedValue(
      saved({ grocery: { ok: false, message: "買い物リストを更新できませんでした。買い物の画面で「献立から更新」を押してください。" } }),
    )
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    await click(screen.getByRole("button", { name: "この献立で確定" }))
    expect(await screen.findByText(/献立を確定しました/)).toBeInTheDocument()
    expect(screen.getByText(/買い物リストを更新できませんでした/)).toBeInTheDocument()
  })

  it("「作った」「作らなかった」は、その日が来た料理にだけ出す", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({
      view: planView({
        [TODAY]: [entry({ status: "confirmed", statusLabel: "確定" })],
        [FRIDAY]: [entry({ id: E_CURRY, date: FRIDAY, title: "カレーライス", recipeId: "curry_rice", status: "confirmed", statusLabel: "確定" })],
      }),
    })
    await ready()
    expect(within(dayCard(FRIDAY)).queryByRole("button", { name: /「作った」にする/ })).toBeNull()
    expect(within(dayCard(TODAY)).getByRole("button", { name: "肉じゃがを「作らなかった」にする" })).toBeEnabled()
    await click(within(dayCard(TODAY)).getByRole("button", { name: "肉じゃがを「作った」にする" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "cooked", entryId: E_MAIN, version: V1 })
    // 在庫は自動では減らさないと言う
    expect(await screen.findByText(/食材は自動では減らしていません/)).toBeInTheDocument()
  })

  it("作った後: 使った食材は利用者が選んだものだけ送り、評価は味・手間・また食べたいを分けて送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ revision: null, grocery: null }))
    const P_PORK = "b1000000-0000-4000-8000-000000000001"
    const P_POTATO = "b1000000-0000-4000-8000-000000000002"
    const extras: PlanPageExtras = {
      ...EMPTY_PLAN_PAGE_EXTRAS,
      pantryByEntry: {
        [E_MAIN]: [
          { id: P_PORK, version: V1, name: "豚こま切れ肉", quantityText: "300g", status: "have", statusLabel: "ある" },
          { id: P_POTATO, version: V1, name: "じゃがいも", quantityText: "数量不明", status: "have", statusLabel: "ある" },
        ],
      },
    }
    view({ view: planView({ [TODAY]: [entry({ status: "cooked", statusLabel: "作った" })] }), extras })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの食材と評価を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/食材は自動では減らしません/)).toBeInTheDocument()
    // 何も選ばなければ送れない
    expect(within(dialog).getByRole("button", { name: "選んだ食材を更新（0件）" })).toBeDisabled()
    const pork = within(dialog).getByRole("group", { name: /^豚こま切れ肉/ })
    await click(within(pork).getByRole("button", { name: "使い切った" }))
    await click(within(dialog).getByRole("button", { name: "選んだ食材を更新（1件）" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    // 選ばなかったじゃがいもは送らない
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "pantry_after_cooking",
      updates: [{ id: P_PORK, version: V1, status: "out" }],
    })

    await waitFor(() => expect(within(dialog).getByRole("button", { name: "評価を記録" })).toBeDisabled())
    await click(within(within(dialog).getByRole("group", { name: "味" })).getByRole("button", { name: "おいしい" }))
    await click(within(within(dialog).getByRole("group", { name: "手間" })).getByRole("button", { name: "大変だった" }))
    await click(within(within(dialog).getByRole("group", { name: "また食べたいか" })).getByRole("button", { name: "また食べたい" }))
    await click(within(dialog).getByRole("checkbox", { name: "好みに反映しない" }))
    await click(within(dialog).getByRole("button", { name: "評価を記録" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    expect(saveDinnerRequest.mock.calls[1][0]).toEqual({
      op: "feedback",
      id: expect.stringMatching(UUID),
      version: null,
      recipeId: "nikujaga",
      dishTitle: "肉じゃが",
      eatenOn: TODAY,
      taste: 3,
      effort: 1,
      again: true,
      excludeFromLearning: true,
    })
  })

  it("記録済みの自分の評価は、その ID と版で直す（新しい ID を作らない）", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ revision: null, grocery: null }))
    const F1 = "f1000000-0000-4000-8000-000000000001"
    const extras: PlanPageExtras = {
      ...EMPTY_PLAN_PAGE_EXTRAS,
      feedbackByEntry: { [E_MAIN]: { id: F1, version: V1, taste: 2, effort: null, again: null, excludeFromLearning: false } },
    }
    view({ view: planView({ [TODAY]: [entry({ status: "cooked", statusLabel: "作った" })] }), extras })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの食材と評価を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(within(dialog).getByRole("group", { name: "味" })).getByRole("button", { name: "ふつう" })).toHaveAttribute("aria-pressed", "true")
    await click(within(within(dialog).getByRole("group", { name: "味" })).getByRole("button", { name: "苦手" }))
    await click(within(dialog).getByRole("button", { name: "評価を更新" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "feedback", id: F1, version: V1, taste: 1 })
  })
})

describe("保存の結果（X-03 / X-09 / C-38）", () => {
  it("献立の版の衝突は「他の端末で変更されました」と出し、上書きしていないと言う", async () => {
    saveDinnerRequest.mockResolvedValue({ status: "conflict", detail: "stale_plan", revision: 9, notices: [], grocery: null })
    view()
    await ready()
    await click(createButton())
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("他の端末で献立が変更されました")
    expect(alert).toHaveTextContent("上書きはしていません")
    expect(refresh).toHaveBeenCalled()
  })

  it("拒否されたら理由を出し、控えを残さない", async () => {
    saveDinnerRequest.mockResolvedValue({ error: "開始日は今日から21日先までの日を選んでください。", failure: "rejected" })
    view()
    await ready()
    await click(createButton())
    expect(await screen.findByRole("alert")).toHaveTextContent("開始日は今日から21日先までの日を選んでください。")
    expect(screen.queryByText("保存できたか確認できていない操作")).toBeNull()
    expect(Object.keys(localStorage).filter((key) => key.startsWith(CHORE_PENDING_PREFIX))).toEqual([])
  })

  it("結果不明は成功と言わず、同じ操作 ID・同じ内容で確かめ直せる控えを出す（新しい操作は止める）", async () => {
    saveDinnerRequest.mockRejectedValueOnce(new Error("fetch failed"))
    view()
    await ready()
    await click(createButton())
    expect(await screen.findByText("保存できたか確認できていない操作")).toBeInTheDocument()
    expect(screen.getByText("11/11（水）から7日分の献立を作成")).toBeInTheDocument()
    expect(screen.queryByText(/献立を作りました/)).toBeNull()
    expect(createButton()).toBeDisabled()
    const first = saveDinnerRequest.mock.calls[0][0]

    saveDinnerRequest.mockResolvedValueOnce(saved({ status: "replayed", via: "auto" }))
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    // 再送は同じ操作 ID・同じ内容（新しい ID で作り直さない）
    expect(saveDinnerRequest.mock.calls[1][0]).toEqual(first)
    await waitFor(() => expect(screen.queryByText("保存できたか確認できていない操作")).toBeNull())
  })

  it("買い物の画面で結果不明になった操作も、読めない控えにせず、ここから確かめ直せる", async () => {
    const G1 = "d1000000-0000-4000-8000-000000000001"
    const OP = "91000000-0000-4000-8000-000000000001"
    const payload = { op: "purchase", id: G1, version: V1, purchase: { kind: "full" } }
    localStorage.setItem(
      `${CHORE_PENDING_PREFIX}${OWNER.userId}:${OWNER.householdId}:meal:${OP}`,
      JSON.stringify({
        schema: 1,
        id: OP,
        owner: OWNER,
        kind: "meal",
        label: "「牛乳」を購入済みに変更",
        payload,
        phase: "unknown",
        firstAttemptAt: "2026-11-11T01:00:00.000Z",
      }),
    )
    saveGroceryRequest.mockResolvedValue({ status: "replayed", notices: [] })
    view()
    expect(await screen.findByText("「牛乳」を購入済みに変更")).toBeInTheDocument()
    expect(screen.queryByText(/読み取れない保存の控え/)).toBeNull()
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveGroceryRequest).toHaveBeenCalledTimes(1))
    expect(saveGroceryRequest.mock.calls[0][0]).toEqual(payload)
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    expect(await screen.findByText("ほかの画面で確認できていなかった操作は、保存されていました。")).toBeInTheDocument()
  })

  it("対照: どの画面の操作としても読めない控えは、読めない控えとして止める", async () => {
    const OP = "91000000-0000-4000-8000-000000000002"
    localStorage.setItem(
      `${CHORE_PENDING_PREFIX}${OWNER.userId}:${OWNER.householdId}:meal:${OP}`,
      JSON.stringify({
        schema: 1,
        id: OP,
        owner: OWNER,
        kind: "meal",
        label: "知らない操作",
        payload: { op: "purchase", id: "not-a-uuid" },
        phase: "unknown",
        firstAttemptAt: "2026-11-11T01:00:00.000Z",
      }),
    )
    view()
    expect(await screen.findByText(/読み取れない保存の控えが 1 件あります/)).toBeInTheDocument()
    expect(createButton()).toBeDisabled()
  })

  it("他の端末の変更が反映されるタイミングを文で示す", async () => {
    view()
    await ready()
    expect(screen.getByText(/ほかの端末での変更は、この画面に戻ったときと、開いている間は約60秒ごとに反映されます/)).toBeInTheDocument()
  })
})

describe("R35: 保存の応答は、その操作を送ったシートだけを閉じる", () => {
  const twoDishes = () =>
    planView({
      [TODAY]: [
        entry(),
        entry({ id: E_SIDE, role: "side", roleLabel: "副菜", title: "ほうれん草のおひたし", recipeId: "spinach_ohitashi" }),
      ],
    })

  it("危険側: 「作った」の応答が、送信中に開いた別の料理のシートを差し替えず、選びかけの移動先を消さない", async () => {
    const pending = deferred<DinnerSaveSuccess>()
    saveDinnerRequest.mockReturnValue(pending.promise)
    view({ view: twoDishes() })
    await ready()
    await click(within(dayCard(TODAY)).getByRole("button", { name: "肉じゃがを「作った」にする" }))
    expect(saveDinnerRequest).toHaveBeenCalledTimes(1)

    // 応答を待つ間に、別の料理の操作を開いて移動先を選ぶ
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    const select = within(dialog).getByLabelText("移動先の日")
    fireEvent.change(select, { target: { value: FRIDAY } })

    await act(async () => {
      pending.resolve(saved())
    })
    await waitFor(() => expect(within(dialog).getByText(/「肉じゃが」を「作った」にしました/)).toBeInTheDocument())
    // 開いていたシートのまま（肉じゃがの「食材と評価」へ差し替えない）、選んだ移動先も残る
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByRole("heading", { name: "ほうれん草のおひたし" })).toBeInTheDocument()
    expect(within(dialog).getByLabelText("移動先の日")).toBe(select)
    expect(select).toHaveValue(FRIDAY)
  })

  it("危険側: 一覧の操作が結果不明に終わっても、後から開いたシートを閉じない", async () => {
    const pending = deferred<DinnerSaveSuccess>()
    saveDinnerRequest.mockReturnValue(pending.promise)
    view({ view: twoDishes() })
    await ready()
    await click(within(dayCard(TODAY)).getByRole("button", { name: "肉じゃがを固定する" }))
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("移動先の日"), { target: { value: FRIDAY } })
    await act(async () => {
      pending.reject(new Error("fetch failed"))
    })
    await waitFor(() => expect(screen.getByText("保存できたか確認できていない操作")).toBeInTheDocument())
    expect(screen.getByRole("dialog")).toBe(dialog)
    expect(within(dialog).getByLabelText("移動先の日")).toHaveValue(FRIDAY)
  })

  it("正常側: シートを開いていなければ、「作った」の後に食材と評価のシートを開く。シートから送った移動は、そのシートを閉じる", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    const { rerender } = view({ view: twoDishes() })
    await ready()
    await click(within(dayCard(TODAY)).getByRole("button", { name: "肉じゃがを「作った」にする" }))
    const opened = await screen.findByRole("dialog")
    expect(within(opened).getByRole("heading", { name: "肉じゃが" })).toBeInTheDocument()
    await click(within(opened).getByRole("button", { name: /閉じる|Close/ }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    rerender(<PlanView {...props({ view: twoDishes() })} />)
    await click(screen.getByRole("button", { name: "ほうれん草のおひたしの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "この日へ移動" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(saveDinnerRequest).toHaveBeenLastCalledWith(expect.objectContaining({ op: "move", entryId: E_SIDE }))
  })
})

describe("R45: 人数（設定とのずれの知らせ・1 品の人数の変更）", () => {
  const V2 = "2026-11-11T02:00:00.654321+00:00"

  it("設定の人数と違う料理が在れば件数を知らせ、そろえるかは利用者が選ぶ（選んだときだけ送る）", async () => {
    saveDinnerRequest.mockResolvedValue(
      saved({ changedEntries: 2, notices: ["これからの献立2品を3人分にしました。"] }),
    )
    view({
      view: planView(
        { [TODAY]: [entry({ servings: 2, pinned: true }), entry({ id: E_SIDE, role: "side", roleLabel: "副菜", title: "卵焼き", servings: 3 })] },
        { servings: { value: 3, isStandard: false, mismatchCount: 2 } },
      ),
    })
    await ready()
    const notice = screen.getByTestId("plan-servings-mismatch")
    expect(notice).toHaveTextContent("これからの献立のうち 2 品が、設定の人数（3人分）と違う人数のままです")
    expect(notice).toHaveTextContent("既に在る献立は自動では変えていません")
    // 料理の行にも、設定と違うことを出す（対照: 同じ人数の料理には出さない）
    const rows = within(dayCard(TODAY)).getAllByTestId("plan-entry")
    expect(within(rows[0]).getByTestId("plan-servings-differs")).toHaveTextContent("設定は3人分")
    expect(within(rows[1]).queryByTestId("plan-servings-differs")).toBeNull()
    // 開いただけでは何も送らない
    expect(saveDinnerRequest).not.toHaveBeenCalled()

    await click(within(notice).getByRole("button", { name: "これからの献立を3人分にそろえる" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "servings_upcoming", servings: 3 })
    const status = await screen.findByTestId("plan-notice")
    expect(status).toHaveTextContent("これからの献立の人数を、3人分にそろえました。")
    expect(status).toHaveTextContent("これからの献立2品を3人分にしました。")
  })

  it("対照: ずれが無ければ知らせを出さない（件数が渡されない古い表示でも出さない）", async () => {
    const zero = view({ view: planView({ [TODAY]: [entry()] }, { servings: { value: 3, isStandard: false, mismatchCount: 0 } }) })
    await ready()
    expect(screen.queryByTestId("plan-servings-mismatch")).toBeNull()
    await act(async () => {})
    zero.unmount()
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    expect(screen.queryByTestId("plan-servings-mismatch")).toBeNull()
  })

  it("固定した料理も、1 品だけ人数を変えられる。枠の ID と開いた時点の版を送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view({ view: planView({ [TODAY]: [entry({ servings: 2, pinned: true, status: "confirmed", statusLabel: "確定" })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    const area = within(dialog).getByTestId("entry-servings")
    expect(within(area).getByTestId("entry-servings-value")).toHaveTextContent("2人分")
    // 変えるまでは保存できない
    expect(within(area).getByRole("button", { name: "人数を保存" })).toBeDisabled()
    await click(within(area).getByRole("button", { name: "人数を1人増やす" }))
    await click(within(area).getByRole("button", { name: "人数を1人増やす" }))
    expect(within(area).getByTestId("entry-servings-value")).toHaveTextContent("4人分")
    await click(within(area).getByRole("button", { name: "人数を保存" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({ op: "servings", entryId: E_MAIN, version: V1, servings: 4 })
    expect(await screen.findByText(/「肉じゃが」を4人分にしました。買い物の量は、この人数で計算し直します。/)).toBeInTheDocument()
  })

  it("「設定の人数にする」で設定の人数へ合わせられる。範囲は 1〜12 人", async () => {
    view({ view: planView({ [TODAY]: [entry({ servings: 12 })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの操作を開く" }))
    const area = within(await screen.findByRole("dialog")).getByTestId("entry-servings")
    expect(within(area).getByRole("button", { name: "人数を1人増やす" })).toBeDisabled()
    await click(within(area).getByRole("button", { name: "設定の人数にする" }))
    expect(within(area).getByTestId("entry-servings-value")).toHaveTextContent("3人分")
    expect(within(area).queryByRole("button", { name: "設定の人数にする" })).toBeNull()
  })

  it("危険側: 人数を選んでいる途中で料理の版が進んだら、古い入力に新しい版を付けて送らない", async () => {
    const { rerender } = view({ view: planView({ [TODAY]: [entry({ servings: 2 })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの操作を開く" }))
    const dialog = await screen.findByRole("dialog")
    await click(within(dialog).getByRole("button", { name: "人数を1人増やす" }))
    // 家族が先に 5 人分へ変えた（版が進む）
    rerender(<PlanView {...props({ view: planView({ [TODAY]: [entry({ servings: 5, version: V2 })] }) })} />)
    const area = within(dialog).getByTestId("entry-servings")
    expect(within(area).getByTestId("changed-elsewhere")).toHaveTextContent("この料理は、入力を始めた後に他の端末で変更されました")
    expect(within(area).getByTestId("entry-servings-value")).toHaveTextContent("3人分")
    const button = within(area).getByRole("button", { name: "人数を保存" })
    expect(button).toBeDisabled()
    await click(button)
    expect(saveDinnerRequest).not.toHaveBeenCalled()
    await click(within(area).getByRole("button", { name: "最新の内容を読み込む" }))
    expect(within(area).getByTestId("entry-servings-value")).toHaveTextContent("5人分")
  })

  it("対照: 作った料理には、人数の変更を出さない", async () => {
    view({ view: planView({ [TODAY]: [entry({ status: "cooked", statusLabel: "作った" })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの食材と評価を開く" }))
    expect(within(await screen.findByRole("dialog")).queryByTestId("entry-servings")).toBeNull()
  })
})

describe("「作った」の取り消しは、作る前の状態へ戻すと言う", () => {
  it("提案のまま作った料理は「提案へ戻します」（対照: 確定から作った料理は「確定へ戻します」）", async () => {
    view({ view: planView({ [TODAY]: [entry({ status: "cooked", statusLabel: "作った", restoreTo: "proposed" })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの食材と評価を開く" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/「作った」を取り消して、提案へ戻します。/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/確定へ戻します/)).toBeNull()
    cleanup()

    view({ view: planView({ [TODAY]: [entry({ status: "cooked", statusLabel: "作った", restoreTo: "confirmed" })] }) })
    await ready()
    await click(screen.getByRole("button", { name: "肉じゃがの食材と評価を開く" }))
    expect(within(await screen.findByRole("dialog")).getByText(/「作った」を取り消して、確定へ戻します。/)).toBeInTheDocument()
  })
})

describe("R46: 年齢の制約の注意を、献立の料理に出す", () => {
  const warning = {
    childId: "c5000000-0000-4000-8000-000000000001",
    childName: "あかり",
    ingredientName: "はちみつ",
    ageUnknown: false,
    text: "はちみつを使います。あかり（8か月）は1歳未満のため、与えません。",
  }

  it("注意の在る料理に、子どもの名前つきの注意を出す（対照: 注意の無い料理には出さない）", async () => {
    view({
      view: planView(
        {
          [TODAY]: [
            entry({ title: "さつまいものはちみつレモン煮", recipeId: "sweet_potato_honey_lemon", role: "side", roleLabel: "副菜", ageWarnings: [warning] }),
            entry({ id: E_SIDE, ageWarnings: [] }),
          ],
        },
        { ageRulesChecked: true },
      ),
    })
    await ready()
    const rows = within(dayCard(TODAY)).getAllByTestId("plan-entry")
    expect(within(rows[0]).getByTestId("plan-age-warning")).toHaveTextContent("あかり（8か月）は1歳未満のため、与えません")
    expect(within(rows[1]).queryByTestId("plan-age-warning")).toBeNull()
    expect(screen.queryByTestId("plan-age-unchecked")).toBeNull()
  })

  it("危険側: 子どもを読めておらず確かめられていないときは、「注意なし」と見せず、確かめられていないと出す", async () => {
    view({ view: planView({ [TODAY]: [entry()] }, { ageRulesChecked: false }) })
    await ready()
    expect(screen.getByTestId("plan-age-unchecked")).toHaveTextContent("この画面では確認できていません")
  })
})

describe("R01（献立側）: 判定できない「使わない食材」の登録が在るとき", () => {
  const HOLD = "判定できないアレルギーの登録（「マンゴー」）があるため、料理の原材料を確かめられず、献立を確定できません。設定で一覧から選び直すと、該当する料理だけを外して確定できます。"

  it("献立を確定できない理由と、直す場所を出す。料理の行にも、登録が原因だと出す", async () => {
    view({
      view: planView(
        { [TODAY]: [entry({ conflict: { verdict: "label_check", message: HOLD, undeterminedHold: true } })] },
        {
          exclusions: {
            hasAny: true,
            hasAllergy: true,
            limited: [],
            holdsAutoConfirm: true,
            undetermined: [
              { exclusionId: "x1", label: "マンゴー", reason: "allergy", reasonLabel: "アレルギー", effect: "holds_auto_confirm" },
            ],
            holdMessage: HOLD,
          },
        },
      ),
    })
    await ready()
    const hold = screen.getByTestId("exclusion-hold")
    expect(hold).toHaveTextContent("献立を確定できません。")
    expect(hold).toHaveTextContent("判定できないアレルギーの登録（「マンゴー」）があるため")
    expect(within(hold).getByRole("link", { name: "使わない食材の設定を開く" })).toHaveAttribute("href", "/chores/meals/settings")
    expect(within(dayCard(TODAY)).getByTestId("plan-conflict")).toHaveTextContent("判定できないアレルギーの登録（「マンゴー」）があるため")
  })

  it("作成の結果に、自動では決められなかった理由を出す", async () => {
    saveDinnerRequest.mockResolvedValue(
      saved({ via: "auto", autoConfirmHold: HOLD, notices: [HOLD, "11/11（水）: 主菜は、原材料の確認が必要な候補しか残っていません。"] }),
    )
    view()
    await ready()
    await click(createButton())
    const notice = await screen.findByTestId("plan-notice")
    expect(notice).toHaveTextContent(HOLD)
    expect(notice).toHaveTextContent("原材料の確認が必要な候補しか残っていません")
  })

  it("対照: 判定できない登録が無ければ、知らせを出さない", async () => {
    view({
      view: planView({}, { exclusions: { hasAny: true, hasAllergy: true, limited: [], holdsAutoConfirm: false, undetermined: [], holdMessage: null } }),
    })
    await ready()
    expect(screen.queryByTestId("exclusion-hold")).toBeNull()
  })
})

describe("R21 / R28: 1 日の差替えで献立から外れた料理を知らせる", () => {
  it("主食を含む料理へ替わって外れた主食を、料理名つきで本文と補足に出す（対照: 外れた料理が無ければ出さない）", async () => {
    const message = "11/11（水）: 主食を含む料理（丼・カレー・麺など）に替わったため、主食の「ごはん」を献立から外しました。"
    saveDinnerRequest.mockResolvedValueOnce(
      saved({
        droppedEntries: [{ entryId: E_CURRY, date: TODAY, role: "staple", title: "ごはん", reason: "main_includes_staple", message }],
        notices: [message],
      }),
    )
    view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    await click(screen.getByRole("button", { name: /の献立を差し替え$/ }))
    const notice = await screen.findByTestId("plan-notice")
    expect(notice).toHaveTextContent("の献立を差し替えました。 「ごはん」を献立から外しました")
    expect(notice).toHaveTextContent(message)

    saveDinnerRequest.mockResolvedValueOnce(saved({ droppedEntries: [] }))
    await waitFor(() => expect(screen.getByRole("button", { name: /の献立を差し替え$/ })).toBeEnabled())
    await click(screen.getByRole("button", { name: /の献立を差し替え$/ }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId("plan-notice")).not.toHaveTextContent("献立から外しました"))
  })
})

describe("R29: 同じ日・同じ区分の 2 つ目の固定を採らなかったことを知らせる", () => {
  it("読み取り結果に、残した固定と採らなかった固定を出す（対照: 無ければ出さない）", async () => {
    interpretDinnerWish.mockResolvedValueOnce(
      interpreted({
        unparsed: ["金曜はハンバーグ"],
        pinConflicts: [
          {
            text: "金曜はハンバーグ",
            date: FRIDAY,
            dateLabel: "11/13（金）",
            recipeId: "hamburg_steak",
            title: "ハンバーグ",
            keptRecipeId: "curry_rice",
            keptTitle: "カレーライス",
            message: "11/13（金）の主菜は「カレーライス」に固定しました。同じ日の「ハンバーグ」は固定していません（同じ日・同じ区分に 2 つは固定できません）。",
          },
        ],
      }),
    )
    view()
    await ready()
    await typeWish("金曜はカレー、金曜はハンバーグ")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    const conflicts = within(reading).getByTestId("wish-pin-conflicts")
    expect(conflicts).toHaveTextContent("「カレーライス」に固定しました。同じ日の「ハンバーグ」は固定していません")
    // 残した固定で、そのまま作成へ進める
    expect(within(reading).getByRole("button", { name: "この内容で献立を作る" })).toBeEnabled()

    interpretDinnerWish.mockResolvedValueOnce(interpreted())
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const second = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(second).queryByTestId("wish-pin-conflicts")).toBeNull()
  })
})

describe("取り直しは共通の門を通す（R04 の残り・未保存の選択）", () => {
  it("危険側: 圏外では、読み取りの間に献立が変わっていても router.refresh を呼ばない（画面を失わない）", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
    interpretDinnerWish.mockResolvedValue(interpreted({ revision: 6 }))
    view()
    await ready()
    await typeWish("金曜はカレー")
    await click(screen.getByRole("button", { name: "希望を反映" }))
    const reading = await screen.findByRole("region", { name: "希望の読み取り結果" })
    expect(within(reading).getByRole("alert")).toHaveTextContent("他の端末で変更されました")
    expect(refresh).not.toHaveBeenCalled()
    // 希望の文は残っている
    expect(screen.getByLabelText("希望（任意）")).toHaveValue("金曜はカレー")
  })

  it("危険側: 「主食の枠も作る」を選んでいる間は、自動の取り直しを見送る（対照: 外せば取り直す）", async () => {
    view()
    await ready()
    const staple = screen.getByRole("checkbox", { name: "主食の枠も作る" })
    await click(staple)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.getByText(/入力や保存の途中のため、自動の更新を止めています/)).toBeInTheDocument()

    await click(staple)
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
    })
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe("規約（X-02）", () => {
  it("押下対象は 44px 以上の部品で、transition-all・outline-none を持ち込まない（素の釦・リンク）", async () => {
    const { container } = view({ view: planView({ [TODAY]: [entry()] }) })
    await ready()
    const raw = [...container.querySelectorAll("a, button, select")].filter(
      (element) => element.getAttribute("data-slot") !== "button",
    )
    expect(raw.length).toBeGreaterThan(3)
    for (const element of raw) {
      const cls = element.getAttribute("class") ?? ""
      expect(cls, element.textContent ?? "").toMatch(/\bmin-h-11\b|\bsize-11\b|\btouch-target\b/)
      expect(cls).not.toMatch(/transition-all/)
      expect(cls).not.toMatch(/(^|\s)outline-none(\s|$)/)
    }
    // 絵文字を使わない（アイコンは Lucide の svg）
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
  })
})
