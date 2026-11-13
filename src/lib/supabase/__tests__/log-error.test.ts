import { format } from "node:util"

import { describe, it, expect, vi, afterEach } from "vitest"
import type { PostgrestError } from "@supabase/supabase-js"
import { logSupabaseError, logSupabaseErrorRedacted } from "../log-error"

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
    expect(spy).toHaveBeenCalledWith("[%s] %s", "auth-context", "profile lookup failed", {
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

    expect(spy).toHaveBeenCalledWith("[%s] %s", "home", "lookup failed", {
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

    expect(spy.mock.calls[0][3]).toMatchObject({
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

    expect(spy.mock.calls[0][3]).toMatchObject({
      userId: "u-1",
      pathname: "/invite/abc",
    })
  })

  it("外部の書式指定子を解釈しない", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logSupabaseError("%o", "%d", sampleError)
    const [template, scope, summary, fields] = spy.mock.calls[0]
    expect(template).toBe("[%s] %s")
    expect(format(template as string, scope, summary, fields)).toContain("[%o] %d")
    expect(fields).toMatchObject({ code: "PGRST116" })
  })

  it("redacted版でも固定書式を使い、detailsとhintを除外する", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    logSupabaseErrorRedacted("%o", "%d", sampleError, { userId: "u-456" })
    const [template, scope, summary, fields] = spy.mock.calls[0]
    expect(template).toBe("[%s] %s")
    expect(format(template as string, scope, summary, fields)).toContain("[%o] %d")
    expect(fields).toMatchObject({ userId: "u-456", code: "PGRST116" })
    expect(fields).not.toHaveProperty("details")
    expect(fields).not.toHaveProperty("hint")
  })
})
