/**
 * ログインの戻り方（E3・AC19 のログイン部分の component 層）。
 *
 * - 送信の期限切れ・通信断・例外は「送れたか分からぬ」（失敗とは断定せぬ）。押し直しの連打を止める
 * - 送った後は同じアドレスへ再送でき、間隔の残りを釦に出す
 * - 期限切れ・別のブラウザで開いた時の戻り方を、送った直後に読める
 * - サーバが答えた失敗（上限・検証）は従来どおり名指しの文言
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

const signInWithOtp = vi.fn()
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ auth: { signInWithOtp: (...a: unknown[]) => signInWithOtp(...a) } }),
}))
const toastError = vi.fn()
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import { LoginForm } from "../login-form"
import { SIGN_IN_TIMEOUT_MS } from "../login-resend"
import { readRecentFailures } from "@/lib/diagnostics/diagnostic-summary"

const emailInput = () => screen.getByLabelText("メールアドレス") as HTMLInputElement

async function submitWith(address: string) {
  fireEvent.change(emailInput(), { target: { value: address } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /マジックリンクを送信/ }))
  })
}

beforeEach(() => {
  signInWithOtp.mockReset()
  toastError.mockReset()
  sessionStorage.clear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("LoginForm の戻り方", () => {
  it("受け付けたら送信先と、別のブラウザ・期限切れの戻り方を出す（届いたとは言わぬ）", async () => {
    signInWithOtp.mockResolvedValue({ error: null })
    render(<LoginForm />)
    await submitWith("a@example.test")
    expect(screen.getByRole("heading", { name: "ログインリンクを送りました" })).toBeInTheDocument()
    expect(document.body).toHaveTextContent("送信を受け付けました")
    expect(document.body).toHaveTextContent("別のブラウザで開いてしまったときや、「期限切れ」「無効」と出たときは、この画面に戻って送り直してください")
  })

  it("⭐ 同じアドレスへの再送は 60 秒あけ、残りを釦に出す。過ぎたら同じアドレスで送る", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    signInWithOtp.mockResolvedValue({ error: null })
    render(<LoginForm />)
    await submitWith("a@example.test")
    const resend = screen.getByRole("button", { name: /同じアドレスに送り直す/ })
    expect(resend).toBeDisabled()
    expect(resend).toHaveAccessibleName("同じアドレスに送り直す（あと60秒）")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(resend).toHaveAccessibleName("同じアドレスに送り直す（あと30秒）")
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(resend).not.toBeDisabled()
    await act(async () => {
      fireEvent.click(resend)
    })
    expect(signInWithOtp).toHaveBeenCalledTimes(2)
    expect(signInWithOtp.mock.calls[1][0]).toMatchObject({ email: "a@example.test" })
    // アドレスは端末に残さぬ（残すのは時刻だけ）
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain("a@example.test")
  })

  it("⭐ 期限内に返らねば待ち続けず「送れたか分からぬ」と言い、間隔を置かせる（失敗とは断定せぬ）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    signInWithOtp.mockReturnValue(new Promise(() => {}))
    render(<LoginForm />)
    await submitWith("a@example.test")
    expect(screen.getByRole("button", { name: /送信中/ })).toBeDisabled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_TIMEOUT_MS)
    })
    expect(screen.getByRole("heading", { name: "送信できたか確かめられませんでした" })).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("まずメール（迷惑メールのフォルダも）を確認し")
    expect(screen.getByRole("button", { name: /同じアドレスに送り直す（あと/ })).toBeDisabled()
    expect(readRecentFailures()).toMatchObject([{ op: "login", kind: "timeout" }])
  })

  it("auth-js の fetch 失敗（返された AuthRetryableFetchError）も結果不明として扱う", async () => {
    signInWithOtp.mockResolvedValue({
      error: { name: "AuthRetryableFetchError", status: 0, message: "Failed to fetch" },
    })
    render(<LoginForm />)
    await submitWith("a@example.test")
    expect(screen.getByRole("heading", { name: "送信できたか確かめられませんでした" })).toBeInTheDocument()
    expect(toastError).not.toHaveBeenCalled()
  })

  it("想定外の例外でも固まらず、結果不明として戻れる", async () => {
    signInWithOtp.mockRejectedValue(new TypeError("boom"))
    render(<LoginForm />)
    await submitWith("a@example.test")
    expect(screen.getByRole("heading", { name: "送信できたか確かめられませんでした" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "別のメールアドレスで試す" }))
    expect(emailInput().value).toBe("")
  })

  it("対照: サーバが答えた失敗（送信回数の上限）は名指しの文言で、入力に戻す", async () => {
    signInWithOtp.mockResolvedValue({
      error: { name: "AuthApiError", status: 429, code: "over_email_send_rate_limit", message: "x" },
    })
    render(<LoginForm />)
    await submitWith("a@example.test")
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("送信回数が上限"), expect.anything())
    expect(emailInput().value).toBe("a@example.test")
    expect(screen.queryByRole("heading", { name: /確かめられませんでした/ })).not.toBeInTheDocument()
  })

  it("再読込の後は直前に送ったことを案内するが、入力の画面からの送信は塞がぬ（別のアドレスで入る家族を止めぬ）", async () => {
    sessionStorage.setItem("irori:login-last-send:v1", String(Date.now()))
    signInWithOtp.mockResolvedValue({ error: null })
    render(<LoginForm />)
    expect(screen.getByTestId("login-recent-send")).toHaveTextContent("少し前に送ったばかりです")
    await submitWith("b@example.test")
    expect(signInWithOtp).toHaveBeenCalledTimes(1)
    // 送った後の「同じアドレスに送り直す」は間隔を守る
    expect(screen.getByRole("button", { name: /同じアドレスに送り直す（あと/ })).toBeDisabled()
  })
})
