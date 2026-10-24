import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * 承認待ち画面のログアウト（PR #235 敵対レビュー P2）。
 *
 * `supabase.auth.signOut()` は失敗を throw せず `{ error }` で返す（auth-js の正式な戻り値）。
 * error を見ずに redirect("/login") すると、失敗したログアウトを成功として扱う。
 * settings の signOut と同じ契約: error も例外も明示的な失敗結果で返し、成功の時だけ
 * redirect する。
 */

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const authSignOut = vi.fn()
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signOut: () => authSignOut() } }),
}))
// redirect は本物と同じく「投げる」（Next の遷移信号）。呼ばれた先も控える。
const REDIRECT_SIGNAL = new Error("NEXT_REDIRECT;replace;/login;307;")
const redirect = vi.fn((_url: string) => {
  throw REDIRECT_SIGNAL
})
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => redirect(url),
}))

import { signOut } from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

const mockedLog = vi.mocked(logSupabaseError)
const FAILED = "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください"

beforeEach(() => {
  authSignOut.mockReset()
  redirect.mockClear()
  mockedLog.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("pending-approval の signOut: 失敗を成功と偽らない", () => {
  it("成功（error: null）の時だけ /login へ redirect する（Next の遷移信号は投げたまま返す）", async () => {
    authSignOut.mockResolvedValue({ error: null })
    await expect(signOut()).rejects.toBe(REDIRECT_SIGNAL)
    expect(redirect).toHaveBeenCalledWith("/login")
  })

  it("⭐ { error } が返ったら redirect せず、明示的な失敗結果を返して構造化ログへ残す", async () => {
    const error = { name: "AuthApiError", message: "Internal error", status: 500, code: "unexpected_failure" }
    authSignOut.mockResolvedValue({ error })
    expect(await signOut()).toEqual({ error: FAILED })
    expect(redirect).not.toHaveBeenCalled()
    expect(mockedLog).toHaveBeenCalledWith("pending-approval", expect.any(String), error, {})
  })

  it("⭐ 通信例外（signOut が throw）でも redirect せず、失敗結果を返して握り潰さずログへ残す", async () => {
    authSignOut.mockRejectedValue(new TypeError("fetch failed"))
    expect(await signOut()).toEqual({ error: FAILED })
    expect(redirect).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[pending-approval]"),
      expect.objectContaining({ message: "fetch failed" }),
    )
  })
})
