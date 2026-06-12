/**
 * meals 書き込み UX の楽観更新に対する統合テスト。
 *
 * 方針 (shopping-item.tsx / shopping-list.tsx の手動 state 方式を meals へ展開):
 * - リアクション: タップで即時反映 → 裏で upsertReaction → 失敗時のみロールバック + toast。
 *   meal_reactions は Realtime 購読に乗っていない (channel は meals テーブルのみ) ため、
 *   成功時は楽観反映がそのまま最終状態として維持されることを pin する。
 * - 献立 CRUD: 保存/削除でシートを即閉じ週ビューへ楽観反映 → action 失敗時のみ
 *   ロールバック + toast。作成は temp id 行を挿入し、createMeal 成功時に確定 id へ
 *   差し替え、Realtime refetch (配列丸ごと置換) で真値収束する。
 *
 * idiom は meal-form-sheet.test.tsx と同一 (vi.hoisted + buildRefetchSupabaseMock +
 * MealFormSheet 実レンダー、render 対象は MealWeekView)。
 * 「action 解決前の即時反映」は deferred promise を action mock に仕込み、
 * resolve 前に同期 assertion することで pin する。
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  render,
  screen,
  cleanup,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react"
import { act } from "react"

import type { MealReaction } from "@/lib/types/database"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import {
  emitPayload,
  makePayloadFor,
  resetRefetchMockState,
  setRefetchData,
} from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// 型: テストで扱う MealWithDetails の row shape は meal-week-view.tsx の
//     SELECT 結果に合わせる (meal-week-view.test.tsx と同一)
// ---------------------------------------------------------------------------

type MealRow = {
  id: string
  date: string
  meal_type: "breakfast" | "lunch" | "dinner" | "snack"
  title: string
  is_eating_out: boolean
  template_id: string | null
  meal_reactions: { user_id: string; reaction: MealReaction }[]
  meal_ingredients: { name: string; quantity: string | null; category: string }[]
}

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  channelNameMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
  selectMock: undefined as unknown as ViFn,
  eqMock: undefined as unknown as ViFn,
  gteMock: undefined as unknown as ViFn,
  lteMock: undefined as unknown as ViFn,
  orderMock: undefined as unknown as ViFn,
  currentResolveData: [] as MealRow[],
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildRefetchSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildRefetchSupabaseMock<MealRow>(viMod, mockState)
})

// next/navigation: useSearchParams は空、useRouter は no-op
vi.mock("next/navigation", async () => {
  const { vi: viMod } = await import("vitest")
  const emptyParams = new URLSearchParams()
  return {
    useSearchParams: viMod.fn(() => emptyParams),
    useRouter: viMod.fn(() => ({
      replace: viMod.fn(),
      push: viMod.fn(),
      back: viMod.fn(),
      forward: viMod.fn(),
      refresh: viMod.fn(),
      prefetch: viMod.fn(),
    })),
  }
})

// meals/actions: render tree が import する action を全て stub する
// (meal-form-sheet.test.tsx と同じ全量リスト)
vi.mock("@/app/(main)/meals/actions", async () => {
  const { vi: viMod } = await import("vitest")
  return {
    loadTemplate: viMod.fn().mockResolvedValue({ data: null, error: null }),
    getTemplates: viMod.fn().mockResolvedValue({ data: [], error: null }),
    deleteTemplate: viMod.fn().mockResolvedValue({ error: null }),
    createMeal: viMod.fn().mockResolvedValue({ error: null, mealId: "m-new" }),
    updateMeal: viMod.fn().mockResolvedValue({ error: null }),
    deleteMeal: viMod.fn().mockResolvedValue({ error: null }),
    saveAsTemplate: viMod.fn().mockResolvedValue({ error: null }),
    upsertReaction: viMod
      .fn()
      .mockResolvedValue({ error: null, removed: false }),
  }
})

// sonner: 失敗時 toast 経路を assert するため fn 化
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { MealWeekView } from "../meal-week-view"
import {
  createMeal,
  updateMeal,
  deleteMeal,
  upsertReaction,
} from "@/app/(main)/meals/actions"
import { toast } from "sonner"

const createMealMock = vi.mocked(createMeal)
const updateMealMock = vi.mocked(updateMeal)
const deleteMealMock = vi.mocked(deleteMeal)
const upsertReactionMock = vi.mocked(upsertReaction)
const toastErrorMock = vi.mocked(toast.error)

// ---------------------------------------------------------------------------
// Test fixtures (meal-week-view.test.tsx と同じ月曜固定週)
// ---------------------------------------------------------------------------

// 月曜固定の週: 2026-04-13 (Mon) 〜 2026-04-19 (Sun)
const WEEK_START = "2026-04-13"

function makeMeal(
  overrides: Partial<MealRow> & Pick<MealRow, "id" | "date" | "meal_type" | "title">,
): MealRow {
  return {
    is_eating_out: false,
    template_id: null,
    meal_reactions: [],
    meal_ingredients: [],
    ...overrides,
  }
}

const makePayload = makePayloadFor<MealRow>("meals")

function defaultProps(
  overrides: Partial<Parameters<typeof MealWeekView>[0]> = {},
): Parameters<typeof MealWeekView>[0] {
  return {
    initialMeals: [],
    householdId: "h1",
    userId: "u1",
    initialWeekStart: WEEK_START,
    ...overrides,
  }
}

const emit = (payload: RealtimePayload<MealRow>) =>
  emitPayload(mockState, payload)

const setMockMeals = (rows: MealRow[]) => setRefetchData(mockState, rows)

/** dateKey の day row 内にある空スロット (mealType) をタップする */
function tapEmptySlot(dateKey: string, mealType: string) {
  fireEvent.click(
    within(screen.getByTestId(`meal-day-${dateKey}`)).getByTestId(
      `empty-meal-slot-${mealType}`,
    ),
  )
}

/** resolve をテスト本体から制御できる deferred promise */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // cleanup() → resetRefetchMockState() の順序が load-bearing
  // (meal-week-view.test.tsx の beforeEach コメント参照)
  cleanup()
  resetRefetchMockState(mockState)
  vi.clearAllMocks()
  // deferred 上書き (mockImplementation) が次テストへ漏れぬよう毎回デフォルトへ戻す
  createMealMock.mockResolvedValue({ error: null, mealId: "m-new" })
  updateMealMock.mockResolvedValue({ error: null })
  deleteMealMock.mockResolvedValue({ error: null })
  upsertReactionMock.mockResolvedValue({ error: null, removed: false })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("リアクションの楽観更新", () => {
  it("タップで action 解決前に即時反映され、成功後もそのまま維持される", async () => {
    const meal = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "dinner",
      title: "カレーライス",
    })
    const d = deferred<Awaited<ReturnType<typeof upsertReaction>>>()
    upsertReactionMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps({ initialMeals: [meal] })} />)

    fireEvent.click(screen.getByRole("button", { name: "おいしい" }))

    // upsertReaction 未解決の時点で即時反映 (楽観)
    expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(upsertReactionMock).toHaveBeenCalledWith("meal-1", "good")

    await act(async () => {
      d.resolve({ error: null, removed: false })
    })

    // meal_reactions は Realtime 購読外: 成功後も楽観反映が最終状態として残る
    expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })

  it("action 失敗で未リアクション状態へロールバックし toast を出す", async () => {
    const meal = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "dinner",
      title: "カレーライス",
    })
    upsertReactionMock.mockResolvedValue({
      error: "リアクションの登録に失敗しました。",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [meal] })} />)

    fireEvent.click(screen.getByRole("button", { name: "おいしい" }))

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
        "aria-pressed",
        "false",
      )
    })
    expect(toastErrorMock).toHaveBeenCalledWith(
      "リアクションの登録に失敗しました。",
    )
  })

  it("既存リアクションがある状態での失敗は直前のリアクションへ戻す", async () => {
    const meal = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "dinner",
      title: "カレーライス",
      meal_reactions: [{ user_id: "u1", reaction: "ok" }],
    })
    upsertReactionMock.mockResolvedValue({
      error: "リアクションの更新に失敗しました。",
    })

    render(<MealWeekView {...defaultProps({ initialMeals: [meal] })} />)

    fireEvent.click(screen.getByRole("button", { name: "おいしい" }))

    // 楽観反映: good が押下状態、ok は外れる
    expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    expect(screen.getByRole("button", { name: "ふつう" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )

    // 失敗 → 直前の "ok" へロールバック
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "ふつう" })).toHaveAttribute(
        "aria-pressed",
        "true",
      )
    })
    expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
      "aria-pressed",
      "false",
    )
    expect(toastErrorMock).toHaveBeenCalledWith(
      "リアクションの更新に失敗しました。",
    )
  })

  it("pending 中の連打は無視され action は 1 回しか飛ばない", async () => {
    const meal = makeMeal({
      id: "meal-1",
      date: WEEK_START,
      meal_type: "dinner",
      title: "カレーライス",
    })
    const d = deferred<Awaited<ReturnType<typeof upsertReaction>>>()
    upsertReactionMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps({ initialMeals: [meal] })} />)

    const goodButton = screen.getByRole("button", { name: "おいしい" })
    fireEvent.click(goodButton)
    fireEvent.click(goodButton)
    fireEvent.click(goodButton)

    expect(upsertReactionMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      d.resolve({ error: null, removed: false })
    })

    // 連打しても状態は最初のタップの楽観反映のまま壊れない
    expect(screen.getByRole("button", { name: "おいしい" })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
  })
})

describe("献立作成の楽観更新", () => {
  it("保存でシートが即閉じ、createMeal 解決前に楽観行が週ビューへ出る (成功時は確定 id へ差し替え)", async () => {
    const d = deferred<Awaited<ReturnType<typeof createMeal>>>()
    createMealMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps()} />)

    tapEmptySlot("2026-04-15", "breakfast")
    fireEvent.change(await screen.findByLabelText("メニュー名"), {
      target: { value: "トースト" },
    })
    fireEvent.click(screen.getByRole("button", { name: "追加する" }))

    // createMeal 未解決の時点で週ビューに楽観行が出る
    expect(screen.getByText("トースト")).toBeInTheDocument()
    // シートは即閉じる (エラー時も再オープンしない契約)
    await waitFor(() => {
      expect(screen.queryByLabelText("メニュー名")).not.toBeInTheDocument()
    })

    await act(async () => {
      d.resolve({ error: null, mealId: "meal-real" })
    })

    // temp id が確定 id へ差し替わったことを「カードを開いて更新した時の id」で pin
    // (refetch 到着前に編集しても存在しない id で action が飛ばない)
    fireEvent.click(screen.getByText("トースト"))
    await screen.findByLabelText("メニュー名")
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    await waitFor(() => {
      expect(updateMealMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "meal-real" }),
      )
    })
  })

  it("createMeal 失敗で楽観行が除去され toast が出る", async () => {
    createMealMock.mockResolvedValue({
      error: "この日時のメニューは既に登録されています。",
    })

    render(<MealWeekView {...defaultProps()} />)

    tapEmptySlot("2026-04-15", "breakfast")
    fireEvent.change(await screen.findByLabelText("メニュー名"), {
      target: { value: "トースト" },
    })
    fireEvent.click(screen.getByRole("button", { name: "追加する" }))

    // 楽観反映 → 失敗でロールバック
    expect(screen.getByText("トースト")).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText("トースト")).not.toBeInTheDocument()
    })
    expect(toastErrorMock).toHaveBeenCalledWith(
      "この日時のメニューは既に登録されています。",
    )
  })
})

describe("献立更新の楽観更新", () => {
  it("更新でシートが即閉じ、解決前に新タイトルが反映され、失敗で旧値へロールバックする", async () => {
    const existing = makeMeal({
      id: "meal-1",
      date: "2026-04-14",
      meal_type: "dinner",
      title: "カレーライス",
    })
    const d = deferred<Awaited<ReturnType<typeof updateMeal>>>()
    updateMealMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    fireEvent.click(screen.getByText("カレーライス"))
    fireEvent.change(await screen.findByLabelText("メニュー名"), {
      target: { value: "シチュー" },
    })
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))

    // updateMeal 未解決の時点で楽観反映 (カードは新タイトルに置換)
    expect(screen.getByText("シチュー")).toBeInTheDocument()
    expect(screen.queryByText("カレーライス")).not.toBeInTheDocument()
    expect(updateMealMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "meal-1", title: "シチュー" }),
    )

    await act(async () => {
      d.resolve({ error: "献立の更新に失敗しました。" })
    })

    // 失敗 → snapshot へロールバック
    await waitFor(() => {
      expect(screen.getByText("カレーライス")).toBeInTheDocument()
    })
    expect(screen.queryByText("シチュー")).not.toBeInTheDocument()
    expect(toastErrorMock).toHaveBeenCalledWith("献立の更新に失敗しました。")
  })
})

describe("献立削除の楽観更新", () => {
  it("確認後に即時除去され、失敗時は復元して toast を出す", async () => {
    const existing = makeMeal({
      id: "meal-1",
      date: "2026-04-14",
      meal_type: "dinner",
      title: "カレーライス",
    })
    const d = deferred<Awaited<ReturnType<typeof deleteMeal>>>()
    deleteMealMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps({ initialMeals: [existing] })} />)

    fireEvent.click(screen.getByText("カレーライス"))
    await screen.findByLabelText("メニュー名")
    fireEvent.click(screen.getByRole("button", { name: "この献立を削除" }))
    fireEvent.click(screen.getByRole("button", { name: "削除する" }))

    // deleteMeal 未解決の時点で即時除去
    expect(screen.queryByText("カレーライス")).not.toBeInTheDocument()
    expect(deleteMealMock).toHaveBeenCalledWith("meal-1")

    await act(async () => {
      d.resolve({ error: "献立の削除に失敗しました。" })
    })

    // 失敗 → 復元 + toast
    await waitFor(() => {
      expect(screen.getByText("カレーライス")).toBeInTheDocument()
    })
    expect(toastErrorMock).toHaveBeenCalledWith("献立の削除に失敗しました。")
  })
})

describe("Realtime refetch との収束", () => {
  it("temp 行は refetch で正規行に置換され、遅れて createMeal が解決しても重複しない", async () => {
    const d = deferred<Awaited<ReturnType<typeof createMeal>>>()
    createMealMock.mockImplementation(() => d.promise)

    render(<MealWeekView {...defaultProps()} />)

    tapEmptySlot("2026-04-15", "breakfast")
    fireEvent.change(await screen.findByLabelText("メニュー名"), {
      target: { value: "唐揚げ" },
    })
    fireEvent.click(screen.getByRole("button", { name: "追加する" }))
    expect(screen.getByText("唐揚げ")).toBeInTheDocument()

    // サーバー側 INSERT が Realtime で届き refetch → 配列ごと真値へ置換
    const serverRow = makeMeal({
      id: "meal-srv",
      date: "2026-04-15",
      meal_type: "breakfast",
      title: "唐揚げ",
    })
    setMockMeals([serverRow])
    await act(async () => {
      emit(makePayload("INSERT", serverRow))
    })

    await waitFor(() => {
      expect(mockState.fromMock).toHaveBeenCalledWith("meals")
    })
    expect(screen.getAllByText("唐揚げ")).toHaveLength(1)

    // 遅れて createMeal が解決しても id 差し替えは no-op (重複や復活は起きない)
    await act(async () => {
      d.resolve({ error: null, mealId: "meal-srv" })
    })
    expect(screen.getAllByText("唐揚げ")).toHaveLength(1)

    // 以後の編集は正規 id で飛ぶ
    fireEvent.click(screen.getByText("唐揚げ"))
    await screen.findByLabelText("メニュー名")
    fireEvent.click(screen.getByRole("button", { name: "更新する" }))
    await waitFor(() => {
      expect(updateMealMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "meal-srv" }),
      )
    })
  })
})
