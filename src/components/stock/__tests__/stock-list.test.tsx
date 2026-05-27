/**
 * StockList の Realtime inline reducer に対する統合テスト。
 *
 * - PR #36 (BabyDashboard) と同じ idiom: vi.hoisted + vi.mock("@/lib/supabase/client", ...)
 *   で Supabase channel API を差し替え、テスト本体から payload を emit
 * - StockList は二次副作用として stock-list.tsx (line 117-134) で
 *   checkAndAutoAddLowStock を sessionStorage 30 分 throttle で呼ぶ
 *   → @/app/(main)/stock/actions をモジュール単位で mock 化（実 fetch を防止）
 *   → beforeEach で sessionStorage.clear() してテスト間で throttle 状態を絶縁
 * - StockSuggestions / StockFormSheet は server action + useRouter を呼ぶため
 *   無効化 stub に置き換える（テスト対象は親の inline reducer のみ）
 *
 * stock-list.tsx (line 78-114) の Realtime 流路:
 * - INSERT: 既存 id と衝突したら no-op、それ以外は push
 * - UPDATE: id 一致行を payload.new で置換
 * - DELETE: payload.old.id で filter
 *
 * 検証ケース:
 * 1. INSERT 重複防止: 同一 id を 2 度 emit しても 1 件のまま
 * 2. UPDATE で既存 item の name 等が置換される
 * 3. DELETE で件数 -1 / ヘッダー件数表示が更新される
 * 4. unmount で supabase.removeChannel が呼ばれる
 * 5. checkAndAutoAddLowStock の副次効果が test 中に発火しても reducer 結果に影響しない
 *    （mock 化で server 通信は抑止されていることを併せて確認）
 */

import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, cleanup, waitFor } from "@testing-library/react"
import { act } from "react"
import type { StockItemData } from "../stock-item"
import type {
  RealtimePayload,
  ViFn,
} from "@/test-utils/supabase-realtime-mock"
import {
  emitPayload,
  makePayloadFor,
  resetInlineReducerMockState,
} from "@/test-utils/supabase-realtime-mock"

// ---------------------------------------------------------------------------
// Mock state (vi.hoisted で factory と test body で共有)
//
// 共通の Realtime mock フィールドに加え、stock 固有の
// `checkAndAutoAddLowStockMock` を superset として持つ
// （Realtime 共通 helper は知らない追加フィールド）。
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  listeners: [] as Array<(payload: unknown) => void>,
  removeChannelMock: undefined as unknown as ViFn,
  fromMock: undefined as unknown as ViFn,
  checkAndAutoAddLowStockMock: undefined as unknown as ViFn,
}))

vi.mock("@/lib/supabase/client", async () => {
  const { vi: viMod } = await import("vitest")
  const { buildInlineReducerSupabaseMock } = await import(
    "@/test-utils/supabase-realtime-mock"
  )
  return buildInlineReducerSupabaseMock(viMod, mockState, {
    throwMessage:
      "supabase.from() should not be called in StockList Realtime callback tests",
  })
})

// 子コンポーネントは server action / useRouter を呼ぶため無効化
vi.mock("../stock-suggestions", () => ({
  StockSuggestions: () => null,
}))
vi.mock("../stock-form-sheet", () => ({
  StockFormSheet: () => null,
}))

// stock actions をモジュール単位で mock 化:
// - checkAndAutoAddLowStock は StockList mount 時に sessionStorage throttle を
//   通過すれば呼ばれる。実 fetch が発生せぬよう resolved value を返す
// - その他 server actions は StockItem 経由で呼ばれうるためまとめて潰す
vi.mock("@/app/(main)/stock/actions", async () => {
  const { vi: viMod } = await import("vitest")
  mockState.checkAndAutoAddLowStockMock = viMod
    .fn()
    .mockResolvedValue({ error: null, addedItems: [] })
  return {
    checkAndAutoAddLowStock: mockState.checkAndAutoAddLowStockMock,
    deleteStockItem: viMod.fn().mockResolvedValue({ error: null }),
    addToShoppingList: viMod.fn().mockResolvedValue({ error: null }),
    addStockItem: viMod.fn().mockResolvedValue({ error: null }),
    updateStockItem: viMod.fn().mockResolvedValue({ error: null }),
    getStockSuggestions: viMod.fn().mockResolvedValue({ data: [] }),
    getRecipeSuggestions: viMod.fn().mockResolvedValue({ data: [] }),
    getConsumptionRates: viMod.fn().mockResolvedValue({ data: {} }),
  }
})

// ---------------------------------------------------------------------------
// Imports after vi.mock
// ---------------------------------------------------------------------------
import { StockList } from "../stock-list"

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeItem(
  overrides: Partial<StockItemData> & Pick<StockItemData, "id" | "name">,
): StockItemData {
  return {
    category: "other_food",
    quantity: 1,
    unit: null,
    // expires_at: null にして「期限切れ間近」バナーが count に混入せぬよう絶縁
    expires_at: null,
    created_by: "u1",
    created_at: "2026-04-16T00:00:00+09:00",
    updated_at: "2026-04-16T00:00:00+09:00",
    ...overrides,
  }
}

const makePayload = makePayloadFor<StockItemData>("stock_items")

function defaultProps(
  overrides: Partial<Parameters<typeof StockList>[0]> = {},
): Parameters<typeof StockList>[0] {
  return {
    initialItems: [],
    initialSuggestions: [],
    consumptionRates: {},
    householdId: "h1",
    ...overrides,
  }
}

const emit = (payload: RealtimePayload<StockItemData>) =>
  emitPayload(mockState, payload)

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  // cleanup() → resetInlineReducerMockState() の順序が load-bearing:
  // cleanup() で前テストの unmount が走り removeChannel カウントが +1 されるので、
  // その後で reset() (内部で mockClear) を呼ぶことでカウントを境界跨ぎさせない。
  cleanup()
  // checkAndAutoAddLowStock の 30 分 throttle 状態をテスト間で絶縁
  sessionStorage.clear()
  resetInlineReducerMockState(mockState)
  // stock 固有の mock は helper では掃かれないので個別に clear
  mockState.checkAndAutoAddLowStockMock.mockClear()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StockList / Realtime inline reducer", () => {
  it("INSERT 重複防止: 同一 id を 2 度 emit しても 1 件のまま", () => {
    render(<StockList {...defaultProps()} />)

    expect(screen.getByText("0件")).toBeInTheDocument()

    const newItem = makeItem({ id: "stock-1", name: "玉ねぎ" })

    act(() => {
      emit(makePayload("INSERT", newItem))
    })

    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()

    // 同一 id 再 emit
    act(() => {
      emit(makePayload("INSERT", newItem))
    })

    expect(screen.getAllByText("玉ねぎ")).toHaveLength(1)
    expect(screen.getByText("1件")).toBeInTheDocument()
  })

  it("UPDATE で既存 item の name が payload.new に置換される", () => {
    const existing = makeItem({ id: "stock-1", name: "玉ねぎ" })

    render(<StockList {...defaultProps({ initialItems: [existing] })} />)

    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()

    act(() => {
      emit(makePayload("UPDATE", { ...existing, name: "人参" }))
    })

    expect(screen.queryByText("玉ねぎ")).not.toBeInTheDocument()
    expect(screen.getByText("人参")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()
  })

  it("DELETE で件数 -1 / ヘッダー件数表示が更新される", () => {
    const item1 = makeItem({ id: "stock-1", name: "玉ねぎ" })
    const item2 = makeItem({ id: "stock-2", name: "人参" })

    render(<StockList {...defaultProps({ initialItems: [item1, item2] })} />)

    expect(screen.getByText("玉ねぎ")).toBeInTheDocument()
    expect(screen.getByText("人参")).toBeInTheDocument()
    expect(screen.getByText("2件")).toBeInTheDocument()

    act(() => {
      emit(makePayload("DELETE", item1.id))
    })

    expect(screen.queryByText("玉ねぎ")).not.toBeInTheDocument()
    expect(screen.getByText("人参")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()
  })

  it("unmount で supabase.removeChannel が呼ばれる", () => {
    const { unmount } = render(<StockList {...defaultProps()} />)

    expect(mockState.removeChannelMock).not.toHaveBeenCalled()

    unmount()

    expect(mockState.removeChannelMock).toHaveBeenCalledTimes(1)
  })

  it("checkAndAutoAddLowStock の副次効果: mount で 1 回呼ばれ、reducer 結果には影響しない", async () => {
    // sessionStorage が空 → throttle 通過で 1 回呼ばれる想定
    render(<StockList {...defaultProps()} />)

    // mock 化されているため、本テスト中に実 server fetch は走らない
    await waitFor(() => {
      expect(mockState.checkAndAutoAddLowStockMock).toHaveBeenCalledTimes(1)
    })

    // 反応として items は空のまま（mock 戻り値が addedItems: [] であるため toast も発火しない）
    expect(screen.getByText("0件")).toBeInTheDocument()

    // 続けて Realtime INSERT を流しても reducer は正常動作
    act(() => {
      emit(
        makePayload(
          "INSERT",
          makeItem({ id: "stock-after-check", name: "牛乳" }),
        ),
      )
    })

    expect(screen.getByText("牛乳")).toBeInTheDocument()
    expect(screen.getByText("1件")).toBeInTheDocument()
  })
})
