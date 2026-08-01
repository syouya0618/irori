/**
 * I-02: 圏外で Server Action が reject したときの ShoppingItem の挙動を固定する。
 *
 * startTransition 内の未処理 reject は最寄りの error boundary へ bubble する
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)。
 * ハンドラが try/catch で握らないと、圏外タップのたびに /shopping が全画面
 * エラー化し、しかも楽観更新が巻き戻らないため「チェック済み・削除済みに見えるのに
 * 保存されていない」嘘が残る。
 *
 * ここでは reject 経路が
 *   1. 圏外トースト（catch 内でしか出ない文言）を出す = reject が漏れていない証跡
 *   2. 楽観更新を result.error 時と同じ形で巻き戻す
 * ことを固定する。巻き戻しの根拠: reject は「サーバへ届いてすらいない」ため
 * result.error（サーバが業務エラーを返した）より確実に未反映である。
 *
 * 全箇所に try/catch が在ることの網羅は scripts/check-transition-reject-guard.py
 * が機械で担保する（本テストは代表 1 ファイルの挙動契約）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

import { ShoppingItem, type ShoppingItemData } from "../shopping-item"
import { toggleItem, deleteItem } from "@/app/(main)/shopping/actions"
import { toast } from "sonner"
import { OFFLINE_ERROR_MESSAGE } from "@/lib/utils/offline-error"

vi.mock("@/app/(main)/shopping/actions", () => ({
  toggleItem: vi.fn(),
  deleteItem: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const mockedToggleItem = vi.mocked(toggleItem)
const mockedDeleteItem = vi.mocked(deleteItem)
const mockedToast = vi.mocked(toast)

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

const ITEM: ShoppingItemData = {
  id: "i1",
  name: "牛乳",
  quantity: null,
  category: "other_food",
  store_type: "supermarket",
  is_checked: false,
  checked_by: null,
  checked_at: null,
  sort_order: 0,
}

function renderItem(overrides: Partial<ShoppingItemData> = {}) {
  const onOptimisticToggle = vi.fn()
  const onOptimisticDelete = vi.fn()
  const onRollbackDelete = vi.fn()
  render(
    <ShoppingItem
      item={{ ...ITEM, ...overrides }}
      onOptimisticToggle={onOptimisticToggle}
      onOptimisticDelete={onOptimisticDelete}
      onRollbackDelete={onRollbackDelete}
    />,
  )
  return { onOptimisticToggle, onOptimisticDelete, onRollbackDelete }
}

describe("ShoppingItem の通信断 reject 握り（I-02）", () => {
  it("toggleItem が reject → 圏外トースト + 楽観トグルを巻き戻す", async () => {
    mockedToggleItem.mockRejectedValue(new Error("network down"))
    const { onOptimisticToggle } = renderItem()

    fireEvent.click(screen.getByRole("button", { name: "牛乳をチェック" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_ERROR_MESSAGE),
    )
    // 1 回目 = 楽観 ON、2 回目 = 巻き戻しで元の false へ
    expect(onOptimisticToggle).toHaveBeenNthCalledWith(1, "i1", true)
    expect(onOptimisticToggle).toHaveBeenNthCalledWith(2, "i1", false)
  })

  it("deleteItem が reject → 圏外トースト + 削除した行を復元する", async () => {
    mockedDeleteItem.mockRejectedValue(new Error("network down"))
    const { onOptimisticDelete, onRollbackDelete } = renderItem()

    // 削除は 2 タップ確認式（1 タップ目は確認状態にするだけ）
    fireEvent.click(screen.getByRole("button", { name: "牛乳を削除" }))
    fireEvent.click(screen.getByRole("button", { name: "牛乳を削除（確認）" }))

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_ERROR_MESSAGE),
    )
    expect(onOptimisticDelete).toHaveBeenCalledWith("i1")
    expect(onRollbackDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: "i1", name: "牛乳" }),
    )
  })
})
