/**
 * ExportCard の**診断可能性**の検証（I-15b のクライアント側）。
 *
 * 従前は `catch {}`（bind すら無い）で失敗を完全に握り潰しており、
 * 「ダウンロードに失敗しました」以外の情報が**どこにも残らなかった**。
 * 小児科の受診当日に PDF が出せない時、401（セッション切れ・再ログインで直る）と
 * 500（サーバ側の DB エラー・こちらでは直せない）では利用者の次の一手が全く違う。
 *
 * ここで固定するのは「原因に辿り着けるか」であり、PDF の中身ではない。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

const toastError = vi.fn()
const toastWarning = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    success: vi.fn(),
  },
}))

import { ExportCard } from "../export-card"

/** 成功レスポンス（PDF blob）を作る */
function pdfResponse(headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    blob: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    headers: new Headers(headers),
  }
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  toastError.mockReset()
  toastWarning.mockReset()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  // jsdom は未実装
  URL.createObjectURL = vi.fn(() => "blob:fake")
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function clickDownload() {
  fireEvent.click(screen.getByRole("button", { name: /PDFをダウンロード/ }))
}

describe("ExportCard: 失敗の真因を残す（握り潰さない）", () => {
  it("HTTP エラーは status を console.error とトーストの両方に残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())

    // 利用者が「何が起きたか」を報告できる形（status を見せる）
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("500"),
    )
    // 後から追える形（構造化ログ）
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({ status: 500, period: "1week" }),
    )
  })

  it("401（セッション切れ）と 500 を利用者が弁別できる", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("401"))
    expect(consoleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 401 }),
    )
  })

  it("例外（通信断など）も bind して構造化ログに残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch")
      }),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    // `catch {}` に戻ると message が消えてここが落ちる
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({ message: "Failed to fetch" }),
    )
  })

  it("選択中の期間をログに含める（どの期間で失敗したか分かる）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "err",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "3ヶ月" }))
    clickDownload()

    await waitFor(() => expect(consoleError).toHaveBeenCalled())
    expect(consoleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ period: "3months" }),
    )
  })
})

describe("ExportCard: 切り詰めを利用者へ伝える", () => {
  it("X-Report-Truncated が立っていれば「全件ではない」と警告する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pdfResponse({ "X-Report-Truncated": "1" })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning).toHaveBeenCalledWith(
      expect.stringContaining("全件ではありません"),
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it("通常の成功では警告を出さない（狼少年にしない）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()))
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(toastWarning).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
  })
})

describe("ExportCard: 失敗しても操作不能にならない", () => {
  it("失敗後もボタンは再び押せる（isDownloading が巻き戻る）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        statusText: "err",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /PDFをダウンロード/ }),
      ).not.toBeDisabled(),
    )
  })
})
