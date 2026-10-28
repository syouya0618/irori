/**
 * 要望の「診断情報を添える」（E4・AC27 の component 層）。
 *
 * - 既定はオフ。オフなら本文は利用者が書いたものだけ
 * - オンにすると、添える文面を全部見せ、その文面を**そのまま**本文の末尾に付けて送る
 * - 鍵（requestId）が同じ間は診断を作り直さぬ（押し直し・開き直しで本文が変わると IRF01 の衝突になる）
 * - 上限（2000 字）は付けた後の全体で数える
 * - 端末にある本文・名前・メール・token を載せぬ
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react"

const submitFeedback = vi.fn()
vi.mock("@/app/(main)/feedback/actions", () => ({
  submitFeedback: (...args: unknown[]) => submitFeedback(...args),
}))
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation")
  return {
    useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
    unstable_isUnrecognizedActionError: actual.unstable_isUnrecognizedActionError,
  }
})
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/utils/offline-error", () => ({ toastOfflineError: vi.fn() }))

import { FeedbackForm } from "../feedback-form"
import { DIAGNOSTIC_HEADER, RECENT_FAILURES_KEY } from "@/lib/diagnostics/diagnostic-summary"
import { FEEDBACK_BODY_MAX } from "@/lib/domain/feedback"
import { UnrecognizedActionError } from "next/dist/client/components/unrecognized-action-error"

const USER = "user-1"
const DRAFT_KEY = `irori:feedback-draft:v1:${USER}`
const titleInput = () => screen.getByLabelText("要望（ひとことで）") as HTMLInputElement
const bodyInput = () => screen.getByLabelText("詳しい内容（任意）") as HTMLTextAreaElement
const toggle = () => screen.getByRole("checkbox", { name: "診断情報を添える（任意）" }) as HTMLInputElement
const sentBodies = () => submitFeedback.mock.calls.map(([input]) => (input as { body: string }).body)

async function submit() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /送る|送信中/ }))
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  submitFeedback.mockReset()
  sessionStorage.clear()
  localStorage.clear()
  vi.stubEnv("IRORI_BUILD_SHA", "abc1234")
})
afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe("FeedbackForm の診断情報", () => {
  it("既定はオフ。オフのまま送ると本文は書いたものだけ", async () => {
    submitFeedback.mockResolvedValueOnce({ status: "created", feedbackId: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
    render(<FeedbackForm userId={USER} />)
    expect(toggle().checked).toBe(false)
    expect(screen.queryByTestId("feedback-diagnostic-preview")).not.toBeInTheDocument()
    fireEvent.change(titleInput(), { target: { value: "夜は暗く" } })
    fireEvent.change(bodyInput(), { target: { value: "設定で選べると嬉しい" } })
    await submit()
    expect(sentBodies()).toEqual(["設定で選べると嬉しい"])
  })

  it("⭐ オンにすると全文を見せ、その文面をそのまま本文の末尾へ付けて送る", async () => {
    submitFeedback.mockResolvedValueOnce({ status: "created", feedbackId: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "書き出しが止まる" } })
    fireEvent.change(bodyInput(), { target: { value: "全期間で失敗した" } })
    fireEvent.click(toggle())
    const preview = screen.getByTestId("feedback-diagnostic-preview").textContent ?? ""
    expect(preview.startsWith(DIAGNOSTIC_HEADER)).toBe(true)
    expect(preview).toContain("版: 2026年10月の更新 / abc1234")
    await submit()
    expect(sentBodies()).toEqual([`全期間で失敗した\n\n${preview}`])
  })

  it("⭐ 端末にある本文・名前・メール・token・失敗の自由文を、添える文面に載せぬ", () => {
    const secrets = ["hana@example.test", "みかん", "夜泣き日記の本文", "eyJ.token.x", "https://x.example/?q=1"]
    localStorage.setItem("irori:feeding-timer", JSON.stringify({ memo: secrets[2], userId: USER }))
    sessionStorage.setItem(
      RECENT_FAILURES_KEY,
      JSON.stringify([{ op: "export", kind: "network", elapsedSec: 2, at: "2026-10-27T14:40Z", message: secrets[0], url: secrets[4] }]),
    )
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(bodyInput(), { target: { value: secrets[1] } })
    fireEvent.click(toggle())
    const preview = screen.getByTestId("feedback-diagnostic-preview").textContent ?? ""
    for (const s of secrets) expect(preview).not.toContain(s)
    expect(preview).toContain("- 書き出し・通信できなかった・2秒")
    expect(preview).not.toContain(navigator.userAgent)
  })

  it("⭐ 通信断の後の押し直しは、同じ鍵・同じ本文（診断を作り直さぬ）。開き直しても同じ", async () => {
    submitFeedback.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    submitFeedback.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "通知が遅い" } })
    fireEvent.click(toggle())
    await submit()
    await submit()
    expect(new Set(sentBodies()).size).toBe(1)

    // 画面を開き直す（sessionStorage の下書きから戻る）
    cleanup()
    submitFeedback.mockResolvedValueOnce({ status: "duplicate", feedbackId: "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
    render(<FeedbackForm userId={USER} />)
    await waitFor(() => expect(toggle().checked).toBe(true))
    await submit()
    const bodies = sentBodies()
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies).size).toBe(1)
    const ids = submitFeedback.mock.calls.map(([i]) => (i as { requestId: string }).requestId)
    expect(new Set(ids).size).toBe(1)
  })

  it("診断を外すと次の送信は本文だけ（下書きからも外れる）", async () => {
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "x" } })
    fireEvent.click(toggle())
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).diagnostic).toContain(DIAGNOSTIC_HEADER)
    fireEvent.click(toggle())
    expect(JSON.parse(sessionStorage.getItem(DRAFT_KEY)!).diagnostic).toBeNull()
    expect(screen.queryByTestId("feedback-diagnostic-preview")).not.toBeInTheDocument()
  })

  it("上限は付けた後の全体で数え、超えたら送らずに理由を出す", async () => {
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "長文" } })
    fireEvent.change(bodyInput(), { target: { value: "あ".repeat(FEEDBACK_BODY_MAX - 10) } })
    fireEvent.click(toggle())
    await submit()
    expect(submitFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("診断情報を添えると 2000 文字を超えます")
  })

  it("形の崩れた下書きの診断（手で弄られた等）は添えぬ側へ倒す", async () => {
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({
        requestId: "11111111-1111-4111-8111-111111111111",
        title: "t",
        body: "",
        diagnostic: "hana@example.test",
      }),
    )
    render(<FeedbackForm userId={USER} />)
    await waitFor(() => expect(titleInput().value).toBe("t"))
    expect(toggle().checked).toBe(false)
  })

  it("古い画面のまま新しいデプロイへ送った時は、読み直しを促す（二重に届かぬとは言わぬ）", async () => {
    submitFeedback.mockRejectedValueOnce(new UnrecognizedActionError("not found"))
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "x" } })
    await submit()
    expect(screen.getByRole("status")).toHaveTextContent("アプリが新しくなっています")
  })
})
