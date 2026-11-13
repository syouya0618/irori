/**
 * 「献立に入れる」（R48。今あるもので・レシピ詳細 → 献立）の契約（要件台帳 C-23 / C-37 / C-74、X-09）。
 *
 * 2026-11-11 ④: 料理 1 品を、その日の献立へ**足す**（`add_recipe`）。その日に料理が在っても入れられる
 * （在る料理・固定枠はそのまま）。最初の押下で ID・区分・位置・人数・状態を固定し、再送は同じ内容。
 *
 * 暦の前提: 2026-11-11 は水曜。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ChoreOwner } from "@/lib/domain/chore-pending"
import type { ChoreSaveFailure } from "@/lib/domain/rpc-outcome"
import type { DinnerRequest, DinnerSaveSuccess } from "@/lib/meals/server/plan-requests"
import type { StoredPlanEntry } from "@/lib/meals/server/rows"

const { saveDinnerRequest, refresh } = vi.hoisted(() => ({
  saveDinnerRequest: vi.fn<(request: DinnerRequest) => Promise<DinnerSaveSuccess | ChoreSaveFailure>>(),
  refresh: vi.fn(),
}))
vi.mock("@/app/(main)/chores/meals/plan/actions", () => ({ saveDinnerRequest, interpretDinnerWish: vi.fn() }))
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }), usePathname: () => "/chores/meals/now" }))

import { AddToPlanProvider } from "../add-to-plan"
import { AddToPlanButton } from "../add-to-plan-button"
import { ADD_TO_PLAN_DAYS, addToPlanRange, buildAddToPlanSlots, type AddToPlanSlots } from "../add-to-plan-data"

const OWNER: ChoreOwner = { userId: "a7000000-0000-4000-8000-000000000001", householdId: "a7000000-0000-4000-8000-0000000000a1" }
const TODAY = "2026-11-11"
const FRIDAY = "2026-11-13"
const V1 = "2026-11-10T00:00:00.123456+00:00"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const TITLES: Record<string, string> = {
  nikujaga: "肉じゃが",
  salmon_shioyaki: "鮭の塩焼き",
  tamagoyaki: "卵焼き",
  curry_rice: "カレーライス",
  spinach_ohitashi: "ほうれん草のおひたし",
}

let seq = 0
function entry(over: Partial<StoredPlanEntry> = {}): StoredPlanEntry {
  seq += 1
  return {
    id: `e7000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    date: TODAY,
    role: "main",
    position: 0,
    recipeId: "nikujaga",
    recipeVersion: 1,
    customTitle: null,
    customIngredients: null,
    servings: 2,
    pinned: false,
    status: "proposed",
    origin: "auto",
    version: V1,
    ...over,
  }
}

function slots(
  entries: StoredPlanEntry[] = [],
  over: { revision?: number; unreadableEntries?: number; servings?: number } = {},
): AddToPlanSlots {
  return buildAddToPlanSlots(
    {
      today: TODAY,
      revision: over.revision ?? 5,
      servings: over.servings ?? 2,
      entries,
      unreadableEntries: over.unreadableEntries ?? 0,
    },
    (id) => TITLES[id],
  )
}

function view(value: AddToPlanSlots = slots(), dish: { recipeId: string; title: string; role: "main" | "side" } = SALMON) {
  return render(
    <AddToPlanProvider owner={OWNER} slots={value}>
      <AddToPlanButton recipeId={dish.recipeId} title={dish.title} role={dish.role} />
    </AddToPlanProvider>,
  )
}

const SALMON = { recipeId: "salmon_shioyaki", title: "鮭の塩焼き", role: "main" as const }
const OHITASHI = { recipeId: "spinach_ohitashi", title: "ほうれん草のおひたし", role: "side" as const }

const saved = (over: Partial<DinnerSaveSuccess> = {}): DinnerSaveSuccess => ({
  status: "saved",
  revision: 6,
  notices: [],
  grocery: { ok: true, status: "saved" },
  ...over,
})
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}
async function openPanel(title = "鮭の塩焼き") {
  await click(screen.getByRole("button", { name: `${title}を献立に入れる` }))
  return screen.getByRole("group", { name: `${title}を献立に入れる日` })
}
/** 端末の控えを読み終えるまで、入れる釦は塞がっている。 */
async function ready(panel: HTMLElement) {
  await waitFor(() => expect(within(panel).getByRole("button", { name: "この日の献立に入れる" })).toBeEnabled())
}

beforeEach(() => {
  localStorage.clear()
  vi.resetAllMocks()
})
afterEach(async () => {
  await act(async () => {})
  cleanup()
  vi.restoreAllMocks()
})

describe("buildAddToPlanSlots（今日からの献立と、足す位置・状態）", () => {
  it("今日から 7 日を並べ、日ごとに既に在る料理（提案・確定・作った・固定）と、足す位置・状態を載せる", () => {
    const value = slots(
      [
        entry({ status: "confirmed", pinned: true }),
        entry({ role: "side", position: 1, recipeId: null, customTitle: "ばあばの煮物", status: "cooked" }),
        entry({ date: FRIDAY, recipeId: "no_such_recipe" }),
        // 範囲の外の枠は載らない
        entry({ date: "2026-11-18" }),
      ],
      { servings: 3 },
    )
    expect(value.days).toHaveLength(ADD_TO_PLAN_DAYS)
    expect(value.days.map((day) => day.date)).toEqual(Array.from({ length: 7 }, (_, index) => `2026-11-${11 + index}`))
    expect(addToPlanRange(TODAY)).toEqual({ from: TODAY, to: "2026-11-17" })
    expect(value.days[0].label).toContain("今日")
    expect(value.days[0].dishes).toEqual([
      { title: "肉じゃが", roleLabel: "主菜", statusLabel: "確定", pinned: true, recipeId: "nikujaga" },
      { title: "ばあばの煮物", roleLabel: "副菜", statusLabel: "作った", pinned: false, recipeId: null },
    ])
    // 足す位置は空いている最初の位置。状態は、提案・確定の料理が全て確定なら確定
    expect(value.days[0]).toMatchObject({ nextPosition: 2, addStatus: "confirmed" })
    // カタログに無い料理も「在る料理」として数える（空いている日と偽らない）
    expect(value.days[2].dishes).toEqual([
      { title: "一覧に無い料理", roleLabel: "主菜", statusLabel: "提案", pinned: false, recipeId: "no_such_recipe" },
    ])
    expect(value.days[2]).toMatchObject({ nextPosition: 1, addStatus: "proposed" })
    expect(value.days[1]).toMatchObject({ dishes: [], nextPosition: 0, addStatus: "proposed" })
    expect(value.revision).toBe(5)
    expect(value.servings).toBe(3)
  })

  it("10 品で埋まった日は足す位置が無い（null）。作った料理だけの日は提案として足す", () => {
    const full = slots(Array.from({ length: 10 }, (_, position) => entry({ position, role: "side" })))
    expect(full.days[0].nextPosition).toBeNull()
    const cookedOnly = slots([entry({ status: "cooked" })])
    expect(cookedOnly.days[0]).toMatchObject({ nextPosition: 1, addStatus: "proposed" })
  })
})

describe("正常側: 料理 1 品を、その日の献立へ足す", () => {
  it("既定は今日（今夜）。ID・区分・位置・人数・状態を固定した 1 品の追加を、1 回だけ送る", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view()
    const panel = await openPanel()
    expect(within(panel).getByLabelText("入れる日")).toHaveValue(TODAY)
    // 何が起きるかを、押す前に言う
    expect(within(panel).getByText(/「鮭の塩焼き」を、この日の献立に固定して入れます/)).toBeInTheDocument()
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))

    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "add_recipe",
      id: expect.stringMatching(UUID),
      // 読んだ時点の献立の版（確かめ直しの間に消された料理を蘇らせないため、サーバーが比べる）
      expectedRevision: 5,
      date: TODAY,
      recipeId: "salmon_shioyaki",
      role: "main",
      position: 0,
      servings: 2,
      status: "proposed",
    })
    // 世帯は要求に無い（サーバーが認証から決める）
    expect(Object.keys(saveDinnerRequest.mock.calls[0][0])).not.toContain("householdId")
    const result = await screen.findByTestId("add-to-plan-result")
    expect(within(result).getByRole("status")).toHaveTextContent("「鮭の塩焼き」を11/11（水）の献立に入れました（固定・提案）。")
    expect(within(result).getByRole("link", { name: "献立の画面で確認する" })).toHaveAttribute("href", "/chores/meals/plan")
    expect(refresh).toHaveBeenCalled()
  })

  it("④ 固定したカレーが在る金曜へ、副菜を足せる。在る料理はそのまま残すと言い、送るのは足す 1 品だけ", async () => {
    saveDinnerRequest.mockResolvedValue(saved({ notices: [] }))
    const curry = entry({ date: FRIDAY, recipeId: "curry_rice", pinned: true, status: "confirmed" })
    view(slots([curry]), OHITASHI)
    const panel = await openPanel("ほうれん草のおひたし")
    fireEvent.change(within(panel).getByLabelText("入れる日"), { target: { value: FRIDAY } })
    const keeps = within(panel).getByTestId("add-to-plan-keeps")
    expect(keeps).toHaveTextContent("主菜「カレーライス」（確定・固定）")
    expect(keeps).toHaveTextContent("そのまま残し")
    expect(keeps).toHaveTextContent("副菜として足します")
    // 確定済みの日なので確定として足し、買い物に入ると言う
    expect(within(panel).getByText(/確定済みのため、確定として足し、材料を買い物リストへ入れます/)).toBeInTheDocument()
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toEqual({
      op: "add_recipe",
      id: expect.stringMatching(UUID),
      expectedRevision: 5,
      date: FRIDAY,
      recipeId: "spinach_ohitashi",
      role: "side",
      position: 1,
      servings: 2,
      status: "confirmed",
    })
    // 作り直し（generate）・差し替えは送らない
    expect(saveDinnerRequest.mock.calls.every(([request]) => request.op === "add_recipe")).toBe(true)
    const result = await screen.findByTestId("add-to-plan-result")
    expect(within(result).getByRole("status")).toHaveTextContent(
      "「ほうれん草のおひたし」を11/13（金）の献立に入れました（固定・確定）。",
    )
    expect(result).toHaveTextContent("材料を買い物リストへ入れました")
    expect(within(result).getByRole("link", { name: "献立の画面で確認する" })).toHaveAttribute(
      "href",
      `/chores/meals/plan?start=${FRIDAY}`,
    )
  })

  it("提案と確定が混じる日・作った料理だけの日へは、提案として足す（位置は空いている最初の位置）", async () => {
    saveDinnerRequest.mockResolvedValue(saved())
    view(slots([entry({ status: "confirmed" }), entry({ role: "side", position: 1, recipeId: "tamagoyaki" })]))
    const panel = await openPanel()
    expect(within(panel).getByText(/提案として足します/)).toBeInTheDocument()
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(1))
    expect(saveDinnerRequest.mock.calls[0][0]).toMatchObject({ op: "add_recipe", position: 2, status: "proposed" })
  })

  it("二重に押しても 1 回だけ送る（送信中は新しい操作を受けない）", async () => {
    let resolve: (value: DinnerSaveSuccess) => void = () => undefined
    saveDinnerRequest.mockImplementation(() => new Promise((done) => (resolve = done)))
    view()
    const panel = await openPanel()
    await ready(panel)
    const button = within(panel).getByRole("button", { name: "この日の献立に入れる" })
    await click(button)
    await click(button)
    expect(saveDinnerRequest).toHaveBeenCalledTimes(1)
    await act(async () => resolve(saved()))
    await screen.findByTestId("add-to-plan-result")
    expect(saveDinnerRequest).toHaveBeenCalledTimes(1)
  })
})

describe("危険側: 足せない日・上書きしない", () => {
  it("同じ料理が既に入っている日は「すでに入っています」と出し、送らない", async () => {
    view(slots([entry({ recipeId: "salmon_shioyaki" })]))
    const panel = await openPanel()
    expect(within(panel).getByText("この料理は、すでにこの日の献立に入っています。")).toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "この日の献立に入れる" })).not.toBeInTheDocument()
  })

  it("10 品で埋まった日には足せない（献立の画面へ送る）", async () => {
    view(slots(Array.from({ length: 10 }, (_, position) => entry({ position, role: "side", recipeId: "tamagoyaki" }))))
    const panel = await openPanel()
    expect(within(panel).getByText(/これ以上は足せません/)).toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "この日の献立に入れる" })).not.toBeInTheDocument()
    expect(within(panel).getByRole("link", { name: "献立の画面でこの日を開く" })).toBeInTheDocument()
  })

  it("読めない献立の記録が在るときは空いている位置を確かめられないので、どの日にも入れさせない", async () => {
    view(slots([], { unreadableEntries: 2 }))
    const panel = await openPanel()
    expect(within(panel).getByText(/表示できない献立の記録が 2 件あるため、空いている枠を確かめられません/)).toBeInTheDocument()
    expect(within(panel).queryByRole("button", { name: "この日の献立に入れる" })).not.toBeInTheDocument()
  })

  it("日の選択肢に、献立の有無を文字で出す（色だけにしない）", async () => {
    view(slots([entry({ status: "confirmed", pinned: true }), entry({ role: "side", position: 1, recipeId: "tamagoyaki" })]))
    const panel = await openPanel()
    const options = within(within(panel).getByLabelText("入れる日")).getAllByRole("option")
    expect(options[0]).toHaveTextContent("献立あり・2品")
    expect(options[1]).toHaveTextContent("献立なし")
  })
})

describe("保存の結果（X-03 / X-09）", () => {
  it("使わない食材に当たる等で拒否されたら理由を出し、「入れました」と言わない。控えを残さない", async () => {
    saveDinnerRequest.mockResolvedValue({ error: "使わない食材の設定に当たる料理は、献立に入れられません。", failure: "rejected" })
    view()
    const panel = await openPanel()
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))
    const result = await screen.findByTestId("add-to-plan-result")
    expect(within(result).getByRole("alert")).toHaveTextContent("使わない食材の設定に当たる料理は、献立に入れられません。")
    expect(result).not.toHaveTextContent("入れました")
    expect(screen.queryByText("保存できたか確認できていない操作")).not.toBeInTheDocument()
  })

  it("別の端末が先にその日を変えていたら、上書き・二重の追加をしていないと言う", async () => {
    saveDinnerRequest.mockResolvedValue({
      status: "conflict",
      detail: "day_changed",
      revision: 9,
      notices: ["入れようとした枠に、別の端末が先に料理を入れました。上書きはしていません。"],
      grocery: null,
    })
    view()
    const panel = await openPanel()
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))
    const result = await screen.findByTestId("add-to-plan-result")
    expect(within(result).getByRole("alert")).toHaveTextContent("この日の献立が、他の端末で先に変わっていました。上書き・二重の追加はしていません")
    expect(result).toHaveTextContent("別の端末が先に料理を入れました")
    expect(result).not.toHaveTextContent("入れました（")
  })

  it("結果不明は「入れました」と言わず、同じ ID・同じ内容（位置・状態も）で確かめ直せる控えを出す", async () => {
    saveDinnerRequest.mockRejectedValueOnce(new Error("fetch failed"))
    view(slots([entry({ date: TODAY, recipeId: "curry_rice", pinned: true, status: "confirmed" })]), OHITASHI)
    const panel = await openPanel("ほうれん草のおひたし")
    await ready(panel)
    await click(within(panel).getByRole("button", { name: "この日の献立に入れる" }))
    expect(await screen.findByText("保存できたか確認できていない操作")).toBeInTheDocument()
    expect(screen.getByText("「ほうれん草のおひたし」を11/11（水）の献立へ追加")).toBeInTheDocument()
    expect(screen.queryByTestId("add-to-plan-result")).not.toBeInTheDocument()
    // 控えが在る間は、新しく入れる操作を受けない
    expect(within(panel).getByRole("button", { name: "この日の献立に入れる" })).toBeDisabled()
    const first = saveDinnerRequest.mock.calls[0][0]
    expect(first).toMatchObject({ op: "add_recipe", position: 1, status: "confirmed" })

    saveDinnerRequest.mockResolvedValueOnce(saved({ status: "replayed" }))
    await click(screen.getByRole("button", { name: "同じ操作で確認" }))
    await waitFor(() => expect(saveDinnerRequest).toHaveBeenCalledTimes(2))
    // 位置・状態を計算し直さない（同じ ID で別の内容を送ると、成立した追加が conflict になる）
    expect(saveDinnerRequest.mock.calls[1][0]).toEqual(first)
    await waitFor(() => expect(screen.queryByText("保存できたか確認できていない操作")).not.toBeInTheDocument())
  })
})

describe("規約（X-02）", () => {
  it("釦・選択・リンクは 44px の担い手を持ち、transition-all を使わない", async () => {
    const { container } = view(slots([entry({ recipeId: "salmon_shioyaki" })]))
    await openPanel()
    const raw = [...container.querySelectorAll("a, select")]
    expect(raw.length).toBeGreaterThanOrEqual(2)
    for (const element of raw) expect(element.className, element.textContent ?? "").toContain("min-h-11")
    expect(container.innerHTML).not.toContain("transition-all")
  })
})
