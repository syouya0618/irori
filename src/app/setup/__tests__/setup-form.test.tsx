/**
 * SetupForm の「永久ローディング」回帰テスト。
 *
 * createHousehold は成功時 redirect() を throw し、失敗時 { error } を返す。
 * 通信断などで reject した場合、従来は setIsLoading(false) に到達せず送信ボタンが
 * 永久 disabled になっていた。try/catch で拾い、redirect の内部エラーは
 * unstable_rethrow で再送出する（redirect 契約は rethrow-contract.test.ts で検証）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const createHousehold = vi.fn()
vi.mock("../actions", () => ({
  createHousehold: (...args: unknown[]) => createHousehold(...args),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

import { SetupForm } from "../setup-form"
import { toast } from "sonner"

beforeEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("SetupForm 永久ローディング防止", () => {
  it("createHousehold が例外を投げても送信ボタンが再び押せる", async () => {
    createHousehold.mockRejectedValueOnce(new Error("network down"))
    render(<SetupForm />)

    fireEvent.change(screen.getByLabelText("世帯名"), {
      target: { value: "我が家" },
    })
    const button = screen.getByRole("button")
    fireEvent.click(button)

    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(button).not.toBeDisabled()
  })
})
