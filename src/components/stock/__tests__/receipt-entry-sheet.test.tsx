import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  act,
} from "@testing-library/react"

import { toast } from "sonner"
import { ReceiptEntrySheet, draftQuantity } from "../receipt-entry-sheet"
import { addReceiptItemsToStock } from "@/app/(main)/stock/actions"
import { scanReceipt } from "@/lib/ocr/scan-receipt"
import type { ScannedReceiptItem } from "@/lib/domain/receipt-ocr-parse"

vi.mock("@/app/(main)/stock/actions", () => ({
  addReceiptItemsToStock: vi.fn(),
}))
// 実 OCR（WASM / クラウド）は browser/server 専用ゆえ、client 配線の検証のためモックする
vi.mock("@/lib/ocr/scan-receipt", () => ({
  scanReceipt: vi.fn(),
}))

const mockedAdd = vi.mocked(addReceiptItemsToStock)
const mockedScan = vi.mocked(scanReceipt)

// OCR provider 設定は localStorage 由来。テスト間で漏らさないよう毎回リセットする
const OCR_PROVIDER_KEY = "irori:ocr-provider"

beforeEach(() => {
  mockedAdd.mockReset()
  mockedScan.mockReset()
  localStorage.clear()
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

  it("数量が空欄の行は submit 時に 1 で送る（0在庫にしない）", async () => {
    mockedAdd.mockResolvedValue({ success: true, count: 1 })
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.change(nameInputs()[0], { target: { value: "牛乳" } })
    fireEvent.change(screen.getByLabelText("数量 1"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: /まとめて追加/ }))

    await waitFor(() => expect(mockedAdd).toHaveBeenCalledTimes(1))
    expect(mockedAdd.mock.calls[0][0][0].quantity).toBe(1)
  })

  it("明示の 0 は submit 時に 0 のまま送る（切らした記録として有効）", async () => {
    mockedAdd.mockResolvedValue({ success: true, count: 1 })
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.change(nameInputs()[0], { target: { value: "牛乳" } })
    fireEvent.change(screen.getByLabelText("数量 1"), { target: { value: "0" } })
    fireEvent.click(screen.getByRole("button", { name: /まとめて追加/ }))

    await waitFor(() => expect(mockedAdd).toHaveBeenCalledTimes(1))
    expect(mockedAdd.mock.calls[0][0][0].quantity).toBe(0)
  })

  it("全行が空ならサーバを呼ばずエラー表示する", () => {
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: /まとめて追加/ }))
    expect(mockedAdd).not.toHaveBeenCalled()
  })

  it("写真を選ぶと端末内OCRの結果が入力行に反映される", async () => {
    mockedScan.mockResolvedValue([
      { name: "牛乳", quantity: null },
      { name: "トマト", quantity: 3 },
    ])
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    // Sheet は portal で body 直下に描画されるため document から探す
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(mockedScan).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const values = nameInputs().map((el) => (el as HTMLInputElement).value)
      expect(values).toContain("牛乳")
      expect(values).toContain("トマト")
    })
  })

  it("端末内(tesseract)設定では tesseract 経路が選ばれる（送信なしのプライバシー配線）", async () => {
    localStorage.setItem(OCR_PROVIDER_KEY, "tesseract")
    mockedScan.mockResolvedValue([])
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(mockedScan).toHaveBeenCalledTimes(1))
    expect(mockedScan.mock.calls[0][1]).toBe("tesseract")
  })

  it("クラウド(google-vision)設定では google-vision 経路が選ばれる", async () => {
    localStorage.setItem(OCR_PROVIDER_KEY, "google-vision")
    mockedScan.mockResolvedValue([])
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => expect(mockedScan).toHaveBeenCalledTimes(1))
    expect(mockedScan.mock.calls[0][1]).toBe("google-vision")
  })

  it("scan 失敗時はサーバ由来の日本語メッセージをトーストに出す（握り潰さない）", async () => {
    mockedScan.mockRejectedValue(new Error("Google Vision APIキーが未設定です"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const toastSpy = vi.spyOn(toast, "error")
    render(<ReceiptEntrySheet open onOpenChange={() => {}} />)
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith("Google Vision APIキーが未設定です"),
    )
    // err を握り潰さず console.error に出す
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
    toastSpy.mockRestore()
  })

  it("シートを閉じて再開後に旧スキャンが解決しても行に混入しない（世代ガード）", async () => {
    let resolveScan: (v: ScannedReceiptItem[]) => void = () => {}
    mockedScan.mockReturnValue(
      new Promise<ScannedReceiptItem[]>((resolve) => {
        resolveScan = resolve
      }),
    )
    const { rerender } = render(
      <ReceiptEntrySheet open onOpenChange={() => {}} />,
    )
    const fileInput = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement
    const file = new File(["dummy"], "receipt.jpg", { type: "image/jpeg" })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() => expect(mockedScan).toHaveBeenCalledTimes(1))

    // 閉じる → 再開（この間に世代が進む）
    rerender(<ReceiptEntrySheet open={false} onOpenChange={() => {}} />)
    rerender(<ReceiptEntrySheet open onOpenChange={() => {}} />)

    // 旧スキャンが今になって解決しても、新セッションの行には反映されない
    await act(async () => {
      resolveScan([{ name: "牛乳", quantity: null }])
    })
    const values = nameInputs().map((el) => (el as HTMLInputElement).value)
    expect(values).toEqual([""])
  })
})

describe("draftQuantity（数量入力の正規化）", () => {
  it("空欄は未指定として 1（stock-form の quantity||1 と統一）", () => {
    expect(draftQuantity("")).toBe(1)
    expect(draftQuantity("  ")).toBe(1)
  })
  it("明示の 0 はそのまま通す（0=切らした記録として有効）", () => {
    expect(draftQuantity("0")).toBe(0)
  })
  it("負値はそのまま返し、サーバ側 sanitize が 1 に丸める", () => {
    expect(draftQuantity("-2")).toBe(-2)
  })
  it("非数は NaN を返し、サーバ側 sanitize が 1 に丸める", () => {
    expect(draftQuantity("abc")).toBeNaN()
  })
})
