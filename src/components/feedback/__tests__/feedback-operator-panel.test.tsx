/**
 * 運用者の操作パネル — 「反映済み」は本番確認の宣言と SHA が揃わねば押せぬ・
 * 通常の状態変更では選べぬ・操作の鍵は成功か衝突まで変えぬ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react"

const updateFeedbackStatus = vi.fn()
const releaseFeedback = vi.fn()
vi.mock("@/app/(main)/feedback/inbox/actions", () => ({
  updateFeedbackStatus: (...args: unknown[]) => updateFeedbackStatus(...args),
  releaseFeedback: (...args: unknown[]) => releaseFeedback(...args),
}))
const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh }),
}))
const { toast } = vi.hoisted(() => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("sonner", () => ({ toast }))
const toastOfflineError = vi.fn()
vi.mock("@/lib/utils/offline-error", () => ({
  toastOfflineError: (...args: unknown[]) => toastOfflineError(...args),
}))

import { FeedbackOperatorPanel } from "../feedback-operator-panel"

const FEEDBACK_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"

function renderPanel(over: Partial<Parameters<typeof FeedbackOperatorPanel>[0]> = {}) {
  return render(
    <FeedbackOperatorPanel
      feedbackId={FEEDBACK_ID}
      version={3}
      status="in_progress"
      released={false}
      runningDeploy="production:abcdef1234567"
      {...over}
    />,
  )
}

const releaseButton = () => screen.getByRole("button", { name: /反映済みにする|確定中/ })
const verifiedBox = () =>
  screen.getByRole("checkbox", { name: "本番環境で、この変更が動いていることを確かめました" })
const shaInput = () => screen.getByLabelText("確かめたコミット（SHA・7〜40 桁）") as HTMLInputElement

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("本番反映の確定フォーム", () => {
  it("本番確認のチェックと SHA が揃うまで押せぬ", () => {
    renderPanel()
    expect(releaseButton()).toBeDisabled()

    fireEvent.change(shaInput(), { target: { value: "abcdef1" } })
    expect(releaseButton()).toBeDisabled()

    fireEvent.click(verifiedBox())
    expect(releaseButton()).toBeEnabled()

    fireEvent.change(shaInput(), { target: { value: "main" } })
    expect(releaseButton()).toBeDisabled()
  })

  it("マージやプレビューだけで確定するなと書く", () => {
    renderPanel()
    expect(screen.getByText(/PR のマージやプレビューでの確認だけでは確定しないでください/)).toBeInTheDocument()
  })

  it("稼働中のデプロイの SHA を入れられ、同じコミットだと示す", () => {
    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "この SHA を入れる" }))
    expect(shaInput().value).toBe("abcdef1234567")
    expect(screen.getByText("稼働中のデプロイと同じコミットです。")).toBeInTheDocument()
  })

  it("稼働中のデプロイが読めぬ時は、読めなかったと書く（推測で埋めぬ）", () => {
    renderPanel({ runningDeploy: null })
    expect(screen.queryByRole("button", { name: "この SHA を入れる" })).toBeNull()
    expect(screen.getByText(/稼働中のデプロイを読み取れませんでした/)).toBeInTheDocument()
  })

  it("確定は宣言と SHA を添えて送り、通信断の押し直しは同じ鍵", async () => {
    releaseFeedback.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    releaseFeedback.mockResolvedValueOnce({ status: "ok", version: 4, duplicate: true })
    renderPanel()
    fireEvent.change(shaInput(), { target: { value: "abcdef1" } })
    fireEvent.click(verifiedBox())

    await act(async () => {
      fireEvent.click(releaseButton())
    })
    await waitFor(() => expect(toastOfflineError).toHaveBeenCalled())
    await act(async () => {
      fireEvent.click(releaseButton())
    })
    await waitFor(() => expect(releaseFeedback).toHaveBeenCalledTimes(2))

    const [first, second] = releaseFeedback.mock.calls.map(([input]) => input)
    expect(first).toMatchObject({
      feedbackId: FEEDBACK_ID,
      expectedVersion: 3,
      commitSha: "abcdef1",
      productionVerified: true,
    })
    expect(first.requestId).toBe(second.requestId)
    // 再送が「記録済み」で返った時は、その旨を伝える（届いたとは言わぬ）
    expect(toast.success).toHaveBeenCalledWith("この操作は既に保存されていました")
  })

  it("⚠️ 通信断の後に SHA を直して送り直すと、新しい鍵で送る（前の確定の再送として捨てさせぬ）", async () => {
    releaseFeedback.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    releaseFeedback.mockResolvedValueOnce({ status: "conflict" })
    renderPanel()
    fireEvent.change(shaInput(), { target: { value: "abcdef1" } })
    fireEvent.click(verifiedBox())
    await act(async () => {
      fireEvent.click(releaseButton())
    })
    await waitFor(() => expect(toastOfflineError).toHaveBeenCalled())

    fireEvent.change(shaInput(), { target: { value: "1234567" } })
    await act(async () => {
      fireEvent.click(releaseButton())
    })
    await waitFor(() => expect(releaseFeedback).toHaveBeenCalledTimes(2))
    const [first, second] = releaseFeedback.mock.calls.map(([input]) => input)
    expect(second.commitSha).toBe("1234567")
    expect(second.requestId).not.toBe(first.requestId)
  })

  it("反映済みの要望には確定フォームを出さず、差し戻しの道を書く", () => {
    renderPanel({ status: "released", released: true })
    expect(screen.queryByRole("button", { name: "反映済みにする" })).toBeNull()
    expect(screen.getByText(/差し戻す場合は/)).toBeInTheDocument()
  })
})

describe("状態の変更・返信フォーム", () => {
  it("「反映済み」は選択肢に無い", () => {
    renderPanel()
    const radios = screen.getAllByRole("radio").map((r) => (r as HTMLInputElement).value)
    expect(radios).toEqual(["comment-only", "received", "considering", "in_progress", "declined"])
    expect(radios).not.toContain("released")
  })

  it("今の状態は選べぬ（同じ状態への変更は DB も拒む）", () => {
    renderPanel({ status: "considering" })
    expect(screen.getByRole("radio", { name: "検討中（今）" })).toBeDisabled()
  })

  it("返信だけは status=null で送る", async () => {
    updateFeedbackStatus.mockResolvedValue({ status: "ok", version: 4, duplicate: false })
    renderPanel()
    fireEvent.change(screen.getByLabelText(/返信（投稿者に表示されます）/), {
      target: { value: "確認しました" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存する/ }))
    })
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalled())
    expect(updateFeedbackStatus.mock.calls[0][0]).toMatchObject({
      status: null,
      comment: "確認しました",
      expectedVersion: 3,
    })
  })

  it("対応中へ変える時だけ「取り込み済み」の欄を出し、本番反映ではないと書く", () => {
    renderPanel({ status: "considering" })
    expect(screen.queryByLabelText("取り込み済みの変更（任意）")).toBeNull()
    fireEvent.click(screen.getByRole("radio", { name: "対応中" }))
    expect(screen.getByLabelText("取り込み済みの変更（任意）")).toBeInTheDocument()
    expect(screen.getByText(/本番への反映ではないため/)).toBeInTheDocument()
  })

  it("通信断の後、書き換えずに押し直せば同じ鍵・書き換えれば新しい鍵", async () => {
    updateFeedbackStatus.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    updateFeedbackStatus.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    updateFeedbackStatus.mockResolvedValueOnce({ status: "ok", version: 4, duplicate: false })
    renderPanel()
    fireEvent.click(screen.getByRole("radio", { name: "検討中" }))
    const save = () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /保存する|保存中/ }))
      })
    await save()
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(1))
    await save()
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(2))
    // 状態を選び直してから送る（前の操作の再送ではない）
    fireEvent.click(screen.getByRole("radio", { name: "見送り" }))
    fireEvent.change(screen.getByLabelText(/返信（投稿者に表示されます）/), {
      target: { value: "今回は見送ります" },
    })
    await save()
    await waitFor(() => expect(updateFeedbackStatus).toHaveBeenCalledTimes(3))

    const ids = updateFeedbackStatus.mock.calls.map(([input]) => input.requestId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[2]).not.toBe(ids[1])
    expect(updateFeedbackStatus.mock.calls[2][0]).toMatchObject({ status: "declined" })
  })

  it("送信中に書き始めた返信は、前の操作の成功で消さぬ", async () => {
    let resolve!: (value: unknown) => void
    updateFeedbackStatus.mockReturnValueOnce(new Promise((res) => (resolve = res)))
    renderPanel()
    const comment = () =>
      screen.getByLabelText(/返信（投稿者に表示されます）/) as HTMLTextAreaElement
    fireEvent.change(comment(), { target: { value: "確認しました" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存する/ }))
    })
    // 送信中に次の返信を書き始める
    fireEvent.change(comment(), { target: { value: "次の返信の書きかけ" } })
    await act(async () => {
      resolve({ status: "ok", version: 4, duplicate: false })
    })
    expect(comment().value).toBe("次の返信の書きかけ")
  })

  it("衝突（版が古い）なら知らせて読み直す", async () => {
    updateFeedbackStatus.mockResolvedValue({ status: "conflict" })
    renderPanel()
    fireEvent.click(screen.getByRole("radio", { name: "検討中" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存する/ }))
    })
    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("更新されていました"))
  })

  it("成功の文言は「届いた」と断定せぬ", async () => {
    updateFeedbackStatus.mockResolvedValue({ status: "ok", version: 4, duplicate: false })
    renderPanel()
    fireEvent.click(screen.getByRole("radio", { name: "検討中" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /保存する/ }))
    })
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const text = toast.success.mock.calls[0][0] as string
    expect(text).toContain("投稿者の画面に表示されます")
    expect(text).not.toMatch(/届きました|届けました|通知しました/)
  })
})
