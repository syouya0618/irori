/**
 * ExportCard の CSV・期限・取消し・分割回収（E2・AC22/AC23 の component 層）。
 *
 * - 取消しと期限切れを分けて伝え、どちらもファイルを保存せぬ（待ち続けさせぬ）
 * - CSV は blob のまま保存する（text() を通すと BOM が落ちる）。login の HTML を CSV として保存せぬ
 * - 一部の書き出しは「一部」と伝え、続きの位置と最初の範囲を固定した続きの要求を出す
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react"

const toastError = vi.fn()
const toastWarning = vi.fn()
const toastSuccess = vi.fn()
const toastInfo = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
  },
}))

import {
  ExportCard,
  EXPORT_CANCELED_MESSAGE,
  EXPORT_TIMEOUT_MESSAGE,
  EXPORT_TIMEOUT_MS,
} from "../export-card"
import { readRecentFailures } from "@/lib/diagnostics/diagnostic-summary"

function csvResponse(headers: Record<string, string> = {}, contentType = "text/csv; charset=utf-8") {
  const blob = new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), '"記録ID"\r\n'], { type: contentType })
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    text: vi.fn(async () => '"記録ID"\r\n'),
    blob: vi.fn(async () => blob),
    headers: new Headers({
      "Content-Type": contentType,
      "Content-Disposition": 'attachment; filename="uchinolog_logs_2026-10-20_2026-10-27.csv"',
      "X-Export-From": "2026-10-20",
      "X-Export-To": "2026-10-27",
      "X-Export-Fetched-At": "2026-10-27T14:40:00.000Z",
      "X-Export-Count-Logs": "12",
      "X-Export-Count-Diaries": "0",
      ...headers,
    }),
  }
}

function jsonPart(body: unknown, headers: Record<string, string>) {
  const text = JSON.stringify(body)
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    text: async () => text,
    blob: async () => new Blob([text]),
    headers: new Headers({ "Content-Type": "application/json; charset=utf-8", ...headers }),
  }
}

/** signal が abort されたら AbortError で reject する、返らぬ fetch */
function hangingFetch() {
  return vi.fn(
    (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted.", "AbortError")),
        )
      }),
  )
}

beforeEach(() => {
  toastError.mockReset()
  toastWarning.mockReset()
  toastSuccess.mockReset()
  toastInfo.mockReset()
  sessionStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  URL.createObjectURL = vi.fn(() => "blob:fake")
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ExportCard: CSV", () => {
  it("記録の CSV を format=csv&table=logs で叩き、blob のまま保存する（BOM を落とさぬ）", async () => {
    const res = csvResponse()
    const fetchMock = vi.fn(async () => res)
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /記録のCSV/ }))
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/baby-export?period=1week&format=csv&table=logs",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    )
    expect(res.blob).toHaveBeenCalled()
    expect(res.text).not.toHaveBeenCalled()
    const saved = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
    const head = new Uint8Array(await saved.slice(0, 3).arrayBuffer())
    expect(Array.from(head)).toEqual([0xef, 0xbb, 0xbf])
    expect(toastSuccess).toHaveBeenCalledWith("記録 12 件を書き出しました")
    // 範囲・取得時刻・件数・整合性の限界を画面に残す
    const outcome = screen.getByTestId("export-outcome")
    expect(outcome).toHaveTextContent("範囲: 2026-10-20〜2026-10-27")
    expect(outcome).toHaveTextContent("取得:")
    expect(outcome).toHaveTextContent("記録 12 件")
    expect(outcome).toHaveTextContent("同じ時点の完全な写しではありません")
  })

  it("日記の CSV は table=diaries", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      csvResponse({ "X-Export-Count-Diaries": "4" }),
    )
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /日記のCSV/ }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("日記 4 件を書き出しました"))
    expect(fetchMock.mock.calls[0][0]).toBe("/api/baby-export?period=1week&format=csv&table=diaries")
  })

  it("CSV のはずが HTML（login 画面など）なら保存せず失敗と言う", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => csvResponse({}, "text/html")))
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /記録のCSV/ }))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("CSV を受け取れませんでした")))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })
})

describe("ExportCard: 取消し・期限（待ち続けさせぬ）", () => {
  it("⭐ 取消しボタンで取り消し、「取り消した」と伝え（失敗とは言わぬ）、何も保存せぬ", async () => {
    const fetchMock = hangingFetch()
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /JSONをダウンロード/ }))
    const cancel = await screen.findByRole("button", { name: "書き出しを取り消す" })
    fireEvent.click(cancel)
    await waitFor(() => expect(toastInfo).toHaveBeenCalledWith(EXPORT_CANCELED_MESSAGE))
    expect(toastError).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    // 取消しは失敗の記録（診断）に残さぬ
    expect(readRecentFailures()).toEqual([])
    // また押せる
    expect(screen.getByRole("button", { name: /JSONをダウンロード/ })).not.toBeDisabled()
  })

  it("⭐ 期限を過ぎたら取り消し、期限切れとして伝え（取消しとは分ける）、何も保存せぬ", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", hangingFetch())
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /記録のCSV/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS)
    })
    expect(toastError).toHaveBeenCalledWith(EXPORT_TIMEOUT_MESSAGE)
    expect(toastInfo).not.toHaveBeenCalled()
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(readRecentFailures()).toMatchObject([{ op: "export", kind: "timeout", elapsedSec: 45 }])
  })

  it("対照: 期限より前に返れば取り消さず保存する", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", vi.fn(async () => csvResponse()))
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /記録のCSV/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(URL.createObjectURL).toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXPORT_TIMEOUT_MS)
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it("本文の読み込み中に取り消されたら、受け取った本文も保存せぬ", async () => {
    let resolveBlob: (b: Blob) => void = () => {}
    const res = {
      ...csvResponse(),
      blob: vi.fn(() => new Promise<Blob>((r) => (resolveBlob = r))),
    }
    vi.stubGlobal("fetch", vi.fn(async () => res))
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: /記録のCSV/ }))
    await waitFor(() => expect(res.blob).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: "書き出しを取り消す" }))
    await act(async () => {
      resolveBlob(new Blob(["x"]))
    })
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith(EXPORT_CANCELED_MESSAGE)
  })
})

describe("ExportCard: 分割回収（続きを書き出す）", () => {
  it("⭐ 一部の書き出しは「一部」と伝え、続きは最初の範囲と続きの位置を固定して叩く。最後の部で終わりを示す", async () => {
    const cursor = "2026-08-01T00:00:00.000123+00:00|00000001-0000-4000-8000-000000000000"
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonPart(
          { counts: { logs: 9000, diaries: 3 }, complete: false },
          {
            "X-Export-Truncated": "1",
            "X-Export-From": "all",
            "X-Export-To": "2026-10-27",
            "X-Export-Next-Logs-After": encodeURIComponent(cursor),
            "X-Export-Next-Diaries-After": "end",
            "Content-Disposition": 'attachment; filename="uchinolog_all_2026-10-27.json"',
          },
        ),
      )
      .mockResolvedValueOnce(
        jsonPart(
          { counts: { logs: 1200, diaries: 0 }, complete: true },
          {
            "X-Export-From": "all",
            "X-Export-To": "2026-10-27",
            "Content-Disposition": 'attachment; filename="uchinolog_all_2026-10-27_part2.json"',
          },
        ),
      )
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "全期間" }))
    fireEvent.click(screen.getByRole("button", { name: /JSONをダウンロード/ }))

    await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(expect.stringContaining("全件ではありません")))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByTestId("export-outcome")).toHaveTextContent("第1部を書き出しました（一部です。続きがあります）")

    fireEvent.click(screen.getByRole("button", { name: "続きを書き出す（第2部）" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const second = new URL(String(fetchMock.mock.calls[1][0]), "http://x")
    expect(second.pathname).toBe("/api/baby-export")
    expect(Object.fromEntries(second.searchParams)).toEqual({
      period: "all",
      from: "all",
      to: "2026-10-27",
      part: "2",
      logs_after: cursor,
      diaries_after: "end",
    })
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("記録 1200 件・日記 0 件を書き出しました（第2部で最後です）"),
    )
    expect(screen.getByTestId("export-outcome")).toHaveTextContent("第1部〜第2部を合わせて範囲の全体です")
    expect(screen.queryByRole("button", { name: /続きを書き出す/ })).not.toBeInTheDocument()
  })

  it("続きの途中で失敗したら、全件とは言わず続きの釦を残す（同じ位置から取り直せる）", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonPart(
          { counts: { logs: 9000, diaries: 3 } },
          {
            "X-Export-Truncated": "1",
            "X-Export-From": "all",
            "X-Export-To": "2026-10-27",
            "X-Export-Next-Logs-After": encodeURIComponent("2026-08-01T00:00:00Z|00000001-0000-4000-8000-000000000000"),
            "X-Export-Next-Diaries-After": "end",
          },
        ),
      )
      .mockResolvedValueOnce({ ok: false, status: 500, statusText: "err", type: "basic", headers: new Headers() })
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "全期間" }))
    fireEvent.click(screen.getByRole("button", { name: /JSONをダウンロード/ }))
    const next = await screen.findByRole("button", { name: "続きを書き出す（第2部）" })
    fireEvent.click(next)
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("HTTP 500")))
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "続きを書き出す（第2部）" })).toBeInTheDocument()
  })

  it("期間を変えたら前の続きを捨てる（別の範囲の続きを混ぜぬ）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonPart(
          { counts: { logs: 1, diaries: 0 } },
          {
            "X-Export-Truncated": "1",
            "X-Export-From": "all",
            "X-Export-To": "2026-10-27",
            "X-Export-Next-Logs-After": "end",
            "X-Export-Next-Diaries-After": "2026-01-01",
          },
        ),
      ),
    )
    render(<ExportCard />)
    fireEvent.click(screen.getByRole("button", { name: "全期間" }))
    fireEvent.click(screen.getByRole("button", { name: /JSONをダウンロード/ }))
    await screen.findByRole("button", { name: /続きを書き出す/ })
    fireEvent.click(screen.getByRole("button", { name: "1ヶ月" }))
    expect(screen.queryByRole("button", { name: /続きを書き出す/ })).not.toBeInTheDocument()
  })
})
