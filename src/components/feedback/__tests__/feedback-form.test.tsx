/**
 * 要望の投稿フォーム — 二重送信・通信断で同じ要望を 2 件にせぬ契約。
 *
 * DB の UNIQUE (submitter_id, client_request_id) が最後の砦じゃが、それが効くのは
 * **画面が同じ鍵を送り続ける**時だけ。ここではその「鍵の持ち方」を固定する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react"

const submitFeedback = vi.fn()
vi.mock("@/app/(main)/feedback/actions", () => ({
  submitFeedback: (...args: unknown[]) => submitFeedback(...args),
}))
const push = vi.fn()
const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
const toastOfflineError = vi.fn()
vi.mock("@/lib/utils/offline-error", () => ({
  toastOfflineError: (...args: unknown[]) => toastOfflineError(...args),
}))

import { FeedbackForm } from "../feedback-form"

const USER = "user-1"
const FEEDBACK_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
const DRAFT_KEY = `irori:feedback-draft:v1:${USER}`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const titleInput = () => screen.getByLabelText("要望（ひとことで）") as HTMLInputElement
const bodyInput = () => screen.getByLabelText("詳しい内容（任意）") as HTMLTextAreaElement
const submitButton = () => screen.getByRole("button", { name: /送る|送信中/ })
const requestIds = () => submitFeedback.mock.calls.map(([input]) => (input as { requestId: string }).requestId)

async function submit() {
  await act(async () => {
    fireEvent.click(submitButton())
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})
afterEach(cleanup)

describe("FeedbackForm — 鍵の持ち方", () => {
  it("送信中に 2 度押しても、送るのは同じ鍵だけ", async () => {
    const pending = deferred<unknown>()
    submitFeedback.mockReturnValue(pending.promise)
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "夜は画面を暗くしてほしい" } })

    await act(async () => {
      fireEvent.click(submitButton())
      fireEvent.click(submitButton())
    })
    await act(async () => {
      pending.resolve({ status: "created", feedbackId: FEEDBACK_ID })
    })

    expect(submitFeedback).toHaveBeenCalled()
    expect(new Set(requestIds()).size).toBe(1)
  })

  it("通信断の後の押し直しは同じ鍵で送る（応答だけ失われた送信を 2 件にせぬ）", async () => {
    submitFeedback.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    submitFeedback.mockResolvedValueOnce({ status: "duplicate", feedbackId: FEEDBACK_ID })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "夜は画面を暗くしてほしい" } })

    await submit()
    await waitFor(() => expect(toastOfflineError).toHaveBeenCalled())
    expect(screen.getByRole("status")).toHaveTextContent("二重に届くことはありません")
    // 入力は消えておらぬ（打ち直しを強いぬ）
    expect(titleInput().value).toBe("夜は画面を暗くしてほしい")
    // 届いておれば一覧に出るよう読み直す
    expect(refresh).toHaveBeenCalled()

    await submit()
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/feedback/${FEEDBACK_ID}`))
    expect(submitFeedback).toHaveBeenCalledTimes(2)
    expect(requestIds()[0]).toBe(requestIds()[1])
  })

  it("同じ鍵で別の文面（conflict）なら鍵を作り直し、文面は残し、前の要望へ辿れる", async () => {
    const priorId = "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
    submitFeedback.mockResolvedValueOnce({ status: "conflict", feedbackId: priorId })
    submitFeedback.mockResolvedValueOnce({ status: "created", feedbackId: FEEDBACK_ID })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "書き直した要望" } })

    await submit()
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("前に送った要望が既に届いています"),
    )
    expect(titleInput().value).toBe("書き直した要望")
    expect(screen.getByRole("link", { name: "前に届いた要望を見る" })).toHaveAttribute(
      "href",
      `/feedback/${priorId}`,
    )
    expect(refresh).toHaveBeenCalled()

    await submit()
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(2))
    expect(requestIds()[0]).not.toBe(requestIds()[1])
  })

  it("成功の後に書き始めた次の要望は、新しい鍵で送る", async () => {
    submitFeedback.mockResolvedValue({ status: "created", feedbackId: FEEDBACK_ID })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "一つ目" } })
    await submit()
    await waitFor(() => expect(push).toHaveBeenCalled())
    // 成功で欄と下書きは消える
    expect(titleInput().value).toBe("")
    expect(sessionStorage.getItem(DRAFT_KEY)).toBeNull()

    fireEvent.change(titleInput(), { target: { value: "二つ目" } })
    await submit()
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(2))
    expect(requestIds()[0]).not.toBe(requestIds()[1])
  })

  it("成功の直後、書き換えずに再生された送信は同じ鍵のまま（新しい鍵を作らぬ）", async () => {
    submitFeedback.mockResolvedValue({ status: "created", feedbackId: FEEDBACK_ID })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "一つ目" } })
    await submit()
    await waitFor(() => expect(push).toHaveBeenCalled())

    // 待ち行列から再生された 2 度目を模す: 欄に同じ文面が残っておる状態で、
    // 利用者の書き換え（onChange）を経ずに送信が走る。
    titleInput().value = "一つ目"
    await submit()
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(2))
    expect(requestIds()[0]).toBe(requestIds()[1])
  })
})

describe("FeedbackForm — 下書き（sessionStorage・利用者ごと）", () => {
  it("開き直した時、下書きと鍵を復元して同じ鍵で送る", async () => {
    const savedKey = "3f2b8c1e-6a4d-4c8b-9e2f-1a2b3c4d5e6f"
    sessionStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ requestId: savedKey, title: "途中の要望", body: "途中の本文" }),
    )
    submitFeedback.mockResolvedValue({ status: "duplicate", feedbackId: FEEDBACK_ID })
    render(<FeedbackForm userId={USER} />)
    await waitFor(() => expect(titleInput().value).toBe("途中の要望"))
    expect(bodyInput().value).toBe("途中の本文")

    await submit()
    await waitFor(() => expect(submitFeedback).toHaveBeenCalled())
    expect(requestIds()[0]).toBe(savedKey)
  })

  it("別の利用者の下書きは読まぬ（共用端末）", async () => {
    sessionStorage.setItem(
      "irori:feedback-draft:v1:someone-else",
      JSON.stringify({
        requestId: "3f2b8c1e-6a4d-4c8b-9e2f-1a2b3c4d5e6f",
        title: "他人の下書き",
        body: "",
      }),
    )
    render(<FeedbackForm userId={USER} />)
    await act(async () => {})
    expect(titleInput().value).toBe("")
  })

  it("壊れた下書きは捨てる（形の違う鍵を送らぬ）", async () => {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ requestId: "../x", title: "x", body: "" }))
    render(<FeedbackForm userId={USER} />)
    await act(async () => {})
    expect(titleInput().value).toBe("")
  })
})

describe("FeedbackForm — 検証", () => {
  it("題が空なら送らず、欄に誤りを結ぶ", async () => {
    render(<FeedbackForm userId={USER} />)
    await submit()
    expect(submitFeedback).not.toHaveBeenCalled()
    expect(screen.getByRole("alert")).toHaveTextContent("要望を入力してください")
    expect(titleInput()).toHaveAttribute("aria-invalid", "true")
  })

  it("サーバが返した欄の誤りを、その欄に結ぶ", async () => {
    submitFeedback.mockResolvedValue({ status: "error", field: "body", error: "詳しい内容に使えない文字が含まれています" })
    render(<FeedbackForm userId={USER} />)
    fireEvent.change(titleInput(), { target: { value: "題" } })
    await submit()
    await waitFor(() => expect(bodyInput()).toHaveAttribute("aria-invalid", "true"))
  })

  it("送った内容が同じ世帯の家族にも見えぬことを書く", () => {
    render(<FeedbackForm userId={USER} />)
    expect(screen.getByText(/同じ世帯の家族にも表示されません/)).toBeInTheDocument()
  })
})
