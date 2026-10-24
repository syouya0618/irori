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

/** 成功レスポンス（PDF blob）を作る。Content-Type は実 route と同じ application/pdf。 */
function pdfResponse(headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    type: "basic",
    blob: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    headers: new Headers({ "Content-Type": "application/pdf", ...headers }),
  }
}

const SESSION_LOST_MESSAGE = "セッションが切れました。ログインし直してください"
// proxy の 307 は未認証（/login）と未承認・profiles の一過性の取得失敗（/pending-approval）を
// 区別できぬゆえ、原因を断定せず再読み込みを促す（N1）。route の 401 だけが「セッション切れ」。
const GATE_REDIRECT_MESSAGE = "ログイン状態を確認できませんでした。画面を再読み込みしてください"

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
    // 401 は「再ログインで直る」ゆえ HTTP 番号ではなく次の一手を出す（P2-21）。
    // 500 は上のテストのとおり status を見せる。ログには両方とも status が残る。
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
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(SESSION_LOST_MESSAGE)
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("500"))
    expect(consoleError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 401 }),
    )
  })

  /**
   * UX-03: route は 401 を**未認証の時だけ**返し、profiles の一過性の取得失敗は 503、
   * 未承認・世帯なしは 403 を返す。どれも「ログインし直して」と案内してはならぬ —
   * 待てば直る障害で利用者をログアウトへ誘導し、組込み SMTP の送信上限の下では
   * ログインし直すこと自体ができぬことがある（受診当日に PDF もアプリも失う）。
   */
  it.each([
    { status: 503, statusText: "Service Unavailable" },
    { status: 500, statusText: "Internal Server Error" },
  ])(
    "$status（サーバ側の障害）は時間をおいた再試行を促し、セッション切れとは言わぬ",
    async ({ status, statusText }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status,
          statusText,
          type: "basic",
          headers: new Headers(),
        })),
      )
      render(<ExportCard />)
      clickDownload()

      await waitFor(() => expect(toastError).toHaveBeenCalled())
      expect(toastError).not.toHaveBeenCalledWith(SESSION_LOST_MESSAGE)
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("時間をおいて"),
      )
      // 利用者が報告できるよう status は見せ続ける
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining(String(status)),
      )
      expect(URL.createObjectURL).not.toHaveBeenCalled()
    },
  )

  it("403（未承認・世帯なし）は事実どおりに伝え、セッション切れとは言わぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        type: "basic",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).not.toHaveBeenCalledWith(SESSION_LOST_MESSAGE)
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("承認されていないか、世帯に参加していません"),
    )
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({ status: 403, period: "1week" }),
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

describe("ExportCard: セッション切れで login 画面を PDF として保存せぬ（P2-21）", () => {
  /**
   * proxy は /api/* にも未認証なら /login への 307 を返す。fetch の既定（follow）だと
   * login 画面の HTML を 200 で受け、`res.ok` だけを見る実装はそれを baby-log.pdf
   * として保存しておった（受診当日に開けぬファイルが黙って渡る）。
   */
  it("fetch に redirect: 'manual' を渡す（307 を追わせぬ）", async () => {
    // fake の fetch は option を無視するゆえ、渡しておること自体を見るしかない。
    const fetchMock = vi.fn(async () => pdfResponse())
    vi.stubGlobal("fetch", fetchMock)
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/baby-report?period=1week",
      expect.objectContaining({ redirect: "manual" }),
    )
  })

  it("opaqueredirect（status 0）は原因を断定せず再読み込みを促し、何も保存せぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 0,
        statusText: "",
        type: "opaqueredirect",
        headers: new Headers(),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(GATE_REDIRECT_MESSAGE)
    expect(toastError).not.toHaveBeenCalledWith(SESSION_LOST_MESSAGE)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({
        gate: "redirected",
        status: 0,
        type: "opaqueredirect",
        period: "1week",
      }),
    )
  })

  it("3xx（proxy の 307）も原因を断定せず再読み込みを促し、何も保存せぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 307,
        statusText: "Temporary Redirect",
        type: "basic",
        headers: new Headers({ Location: "/login" }),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(toastError).toHaveBeenCalledWith(GATE_REDIRECT_MESSAGE)
    expect(URL.createObjectURL).not.toHaveBeenCalled()
  })

  it("200 でも PDF でない応答（login 画面の HTML）は保存せぬ", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        type: "basic",
        blob: async () => new Blob(["<!doctype html>"], { type: "text/html" }),
        headers: new Headers({ "Content-Type": "text/html; charset=utf-8" }),
      })),
    )
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("export-card"),
      expect.objectContaining({ contentType: "text/html; charset=utf-8", period: "1week" }),
    )
  })

  it("対照: 正常な PDF（application/pdf）は保存する", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => pdfResponse()))
    render(<ExportCard />)
    clickDownload()

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(1))
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
