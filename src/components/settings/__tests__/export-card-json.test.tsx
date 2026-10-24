/**
 * ExportCard の JSON 書き出し（機能 D）。PDF 側の契約は export-card.test.tsx が固定する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react"

const toastError = vi.fn()
const toastWarning = vi.fn()
const toastSuccess = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
  },
}))

import { ExportCard } from "../export-card"

function jsonResponse(
  body: unknown,
  headers: Record<string, string> = {},
  overrides: Partial<{ status: number; ok: boolean }> = {},
) {
  const text = JSON.stringify(body)
  return {
    ok: overrides.ok ?? true,
    status: overrides.status ?? 200,
    statusText: "OK",
    type: "basic",
    text: async () => text,
    blob: async () => new Blob([text], { type: "application/json" }),
    headers: new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": 'attachment; filename="uchinolog_2026-10-12_2026-10-19.json"',
      ...headers,
    }),
  }
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  toastError.mockReset()
  toastWarning.mockReset()
  toastSuccess.mockReset()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => "blob:fake")
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function clickJson() {
  fireEvent.click(screen.getByRole("button", { name: /JSONをダウンロード/ }))
}

describe("ExportCard: JSON の書き出し", () => {
  it("選んだ期間で baby-export を叩き（307 は追わぬ）、件数を知らせて保存する", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ schema_version: 1, counts: { logs: 12, diaries: 3 } }),
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "1ヶ月" }))
    clickJson()

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith("/api/baby-export?period=1month", {
      redirect: "manual",
    })
    expect(toastSuccess).toHaveBeenCalledWith("記録 12 件・日記 3 件を書き出しました")
    expect(toastError).not.toHaveBeenCalled()
  })

  it("全期間は JSON だけ: PDF ボタンは無効になり、JSON は period=all で叩く", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ counts: { logs: 0, diaries: 0 } }))
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "全期間" }))
    expect(screen.getByRole("button", { name: /PDFをダウンロード/ })).toBeDisabled()
    expect(screen.getByText(/PDF は 3ヶ月までです/)).toBeInTheDocument()
    clickJson()
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith("/api/baby-export?period=all", { redirect: "manual" })
  })

  it("JSON 以外（login の HTML 等）は保存せず失敗と言う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        type: "basic",
        text: async () => "<html>",
        headers: new Headers({ "Content-Type": "text/html" }),
      })),
    )
    render(<ExportCard />)
    clickJson()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("JSON を受け取れませんでした"))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it("JSON として読めぬ本文は保存せず失敗と言う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        type: "basic",
        text: async () => "{broken",
        headers: new Headers({ "Content-Type": "application/json" }),
      })),
    )
    render(<ExportCard />)
    clickJson()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("JSON を読み取れませんでした"))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it("切り詰め（X-Export-Truncated）は成功ではなく「全件ではない」と警告する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ counts: { logs: 50000, diaries: 1 }, complete: false }, {
          "X-Export-Truncated": "1",
        }),
      ),
    )
    render(<ExportCard />)
    clickJson()
    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    expect(toastWarning).toHaveBeenCalledWith(expect.stringContaining("全件ではありません"))
    expect(toastSuccess).not.toHaveBeenCalled()
    // 保存自体はする（一部でも持ち出せる）
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it("401 はセッション切れとして案内し、ログに kind と period を残す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        type: "basic",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickJson()
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith("セッションが切れました。ログインし直してください")
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({ kind: "json", status: 401, period: "1week" }),
    )
  })
})
