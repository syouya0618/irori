import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react"

import { ReceiptEntrySheet } from "../receipt-entry-sheet"
import { addReceiptItemsToStock } from "@/app/(main)/stock/actions"

vi.mock("@/app/(main)/stock/actions", () => ({
  addReceiptItemsToStock: vi.fn(),
}))

const mockedAdd = vi.mocked(addReceiptItemsToStock)

beforeEach(() => {
  mockedAdd.mockReset()
})
afterEach(cleanup)

function nameInputs() {
  return screen.getAllByPlaceholderText("商品名")
}

describe("ReceiptEntrySheet", () => {
  it("最初は空の入力行を1つ表示する", () => {
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    expect(nameInputs()).toHaveLength(1)
  })

  it("「行を追加」で入力行が増える", () => {
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "行を追加" }))
    expect(nameInputs()).toHaveLength(2)
  })

  it("商品名からカテゴリを自動推測して表示する", () => {
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.change(nameInputs()[0], { target: { value: "牛乳" } })
    // 牛乳 → 乳製品 が推測されて select に反映される
    // (base-ui Select は値を可視 span と測定用 div の2箇所に描画する)
    expect(screen.getAllByText("乳製品").length).toBeGreaterThan(0)
  })

  it("まとめて追加でカテゴリ推測込みの行をサーバに渡し、成功で閉じる", async () => {
    mockedAdd.mockResolvedValue({ success: true, count: 1 })
    const onOpenChange = vi.fn()
    render(<ReceiptEntrySheet open onOpenChange={onOpenChange} />)

    fireEvent.change(nameInputs()[0], { target: { value: " トマト " } })
    fireEvent.click(screen.getByRole("button", { name: /まとめて追加/ }))

    await waitFor(() => expect(mockedAdd).toHaveBeenCalledTimes(1))
    const arg = mockedAdd.mock.calls[0][0]
    // クライアントは生値を渡し、trim はサーバ側 sanitizeReceiptItems の責務
    expect(arg[0].name).toContain("トマト")
    expect(arg[0].category).toBe("vegetable")
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("全行が空ならサーバを呼ばずエラー表示する", () => {
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /まとめて追加/ }))
    expect(mockedAdd).not.toHaveBeenCalled()
  })
})
