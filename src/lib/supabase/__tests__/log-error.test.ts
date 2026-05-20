import { describe, it, expect, vi, afterEach } from "vitest"
import type { PostgrestError } from "@supabase/supabase-js"
import { logSupabaseError } from "../log-error"

const sampleError = {
  name: "PostgrestError",
  message: "row not found",
  code: "PGRST116",
  details: "Results contain 0 rows",
  hint: "",
} as PostgrestError

describe("logSupabaseError", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("scope と summary を整形し、error フィールドを構造化して出力する", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    logSupabaseError("auth-context", "profile lookup failed", sampleError, {
      userId: "u-123",
    })

    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledWith("[auth-context] profile lookup failed", {
      userId: "u-123",
      message: "row not found",
      code: "PGRST116",
      details: "Results contain 0 rows",
      hint: "",
    })
  })

  it("context 省略時も error フィールドのみで出力する", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    logSupabaseError("home", "lookup failed", sampleError)

    expect(spy).toHaveBeenCalledWith("[home] lookup failed", {
      message: "row not found",
      code: "PGRST116",
      details: "Results contain 0 rows",
      hint: "",
    })
  })

  it("context は同名キーで error フィールドを上書きできない", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    logSupabaseError("x", "y", sampleError, {
      message: "context attempted to override",
      code: "FAKE",
    })

    expect(spy.mock.calls[0][1]).toMatchObject({
      message: "row not found",
      code: "PGRST116",
    })
  })

  it("context の追加キーは保持される", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})

    logSupabaseError("invite", "invitation lookup failed", sampleError, {
      userId: "u-1",
      pathname: "/invite/abc",
    })

    expect(spy.mock.calls[0][1]).toMatchObject({
      userId: "u-1",
      pathname: "/invite/abc",
    })
  })
})
