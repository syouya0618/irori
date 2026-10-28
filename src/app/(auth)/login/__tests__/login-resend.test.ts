import { describe, it, expect, vi, afterEach } from "vitest"
import { cooldownRemainingSec, raceWithTimeout, RESEND_COOLDOWN_SEC } from "../login-resend"
import { isSignInResultUnknown } from "@/lib/auth/auth-error-messages"

afterEach(() => {
  vi.useRealTimers()
})

describe("cooldownRemainingSec", () => {
  it("送っていなければ 0", () => {
    expect(cooldownRemainingSec(null, 1000)).toBe(0)
  })
  it("送った直後は 60 秒、59.1 秒後は 1 秒、60 秒後は 0", () => {
    expect(cooldownRemainingSec(0, 0)).toBe(RESEND_COOLDOWN_SEC)
    expect(cooldownRemainingSec(0, 59_100)).toBe(1)
    expect(cooldownRemainingSec(0, 60_000)).toBe(0)
  })
  it("時計が戻った（未来の送信時刻）時は待たせぬ", () => {
    expect(cooldownRemainingSec(10_000, 0)).toBe(0)
  })
})

describe("raceWithTimeout", () => {
  it("期限より先に返れば done", async () => {
    await expect(raceWithTimeout(Promise.resolve(1), 1000)).resolves.toEqual({ kind: "done", value: 1 })
  })
  it("期限が先なら timeout（待ち続けぬ）", async () => {
    vi.useFakeTimers()
    const pending = raceWithTimeout(new Promise(() => {}), 15_000)
    await vi.advanceTimersByTimeAsync(15_000)
    await expect(pending).resolves.toEqual({ kind: "timeout" })
  })
  it("reject はそのまま投げる（呼び出し側が結果不明として扱う）", async () => {
    await expect(raceWithTimeout(Promise.reject(new Error("x")), 1000)).rejects.toThrow("x")
  })
})

describe("isSignInResultUnknown", () => {
  it("auth-js の fetch 失敗（AuthRetryableFetchError・status 0）は結果不明", () => {
    expect(isSignInResultUnknown({ name: "AuthRetryableFetchError", status: 0 })).toBe(true)
  })
  it("対照: サーバが答えた失敗（429・5xx・検証）は結果不明ではない", () => {
    expect(isSignInResultUnknown({ name: "AuthApiError", status: 429, code: "over_email_send_rate_limit" })).toBe(false)
    expect(isSignInResultUnknown({ name: "AuthRetryableFetchError", status: 503 })).toBe(false)
  })
})
