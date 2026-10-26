import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { markFeedbackSeen, submitFeedback } from "../actions"

const REQUEST_ID = "3f2b8c1e-6a4d-4c8b-9e2f-1a2b3c4d5e6f"
const FEEDBACK_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
const SECRET_TITLE = "娘の体重グラフを見やすくしてほしい"
const SECRET_BODY = "夜中の授乳記録が見づらい"

function setRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result)
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { rpc }, userId: "user-1", householdId: "h1" },
  })
  return rpc
}

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("submitFeedback — 入力の検証（RPC の前に欄ごとの文言で返す）", () => {
  it("鍵が UUID でなければ送らぬ", async () => {
    const rpc = setRpc({ data: [], error: null })
    const result = await submitFeedback({ requestId: "not-a-uuid", title: "題", body: "" })
    expect(result.status).toBe("error")
    expect(rpc).not.toHaveBeenCalled()
  })

  it("空の題は title 欄の誤りとして返す", async () => {
    const rpc = setRpc({ data: [], error: null })
    const result = await submitFeedback({
      requestId: REQUEST_ID,
      title: ` ${String.fromCodePoint(0x3000)} `,
      body: "",
    })
    expect(result).toMatchObject({ status: "error", field: "title" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("本文の制御文字は body 欄の誤りとして返す", async () => {
    const rpc = setRpc({ data: [], error: null })
    const result = await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "本文\u0007" })
    expect(result).toMatchObject({ status: "error", field: "body" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("文字列でない入力は拒む（直接 POST への備え）", async () => {
    const rpc = setRpc({ data: [], error: null })
    const result = await submitFeedback({ requestId: REQUEST_ID, title: ["題"], body: "" })
    expect(result.status).toBe("error")
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe("submitFeedback — RPC", () => {
  it("正規化した値で submit_feedback を呼び、新しい受付を返す", async () => {
    const rpc = setRpc({ data: [{ feedback_id: FEEDBACK_ID, created: true }], error: null })
    const result = await submitFeedback({
      requestId: REQUEST_ID,
      title: `  ${SECRET_TITLE} `,
      body: `${SECRET_BODY}\r\n続き\n`,
    })
    expect(rpc).toHaveBeenCalledWith("submit_feedback", {
      p_client_request_id: REQUEST_ID,
      p_title: SECRET_TITLE,
      p_body: `${SECRET_BODY}\n続き`,
    })
    expect(result).toEqual({ status: "created", feedbackId: FEEDBACK_ID })
    expect(revalidatePath).toHaveBeenCalledWith("/feedback", "layout")
  })

  it("同じ鍵の再送は duplicate（同じ 1 件の id）", async () => {
    setRpc({ data: [{ feedback_id: FEEDBACK_ID, created: false }], error: null })
    expect(await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })).toEqual({
      status: "duplicate",
      feedbackId: FEEDBACK_ID,
    })
  })

  it("同じ鍵で別の内容（IRF01）は conflict で、前に届いた要望の id を自分の行から引いて返す", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "IRF01", message: "client_request_id reused" },
    })
    const filters: Array<[string, unknown]> = []
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
      maybeSingle: async () => ({ data: { id: FEEDBACK_ID }, error: null }),
    }
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase: { rpc, from: () => chain }, userId: "user-1", householdId: "h1" },
    })
    expect(await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })).toEqual({
      status: "conflict",
      feedbackId: FEEDBACK_ID,
    })
    // 自分の行（submitter_id）を鍵で引く。他人の要望は RLS でも見えぬが、絞りを明示する
    expect(filters).toEqual([
      ["submitter_id", "user-1"],
      ["client_request_id", REQUEST_ID],
    ])
    // 応答を失った初回の送信で効かなかった revalidate をここで効かせる
    expect(revalidatePath).toHaveBeenCalledWith("/feedback", "layout")
  })

  it("前に届いた要望を引けなくても conflict は返す（id は null）", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "IRF01", message: "x" } })
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: { code: "XX000", message: "boom" } }),
    }
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase: { rpc, from: () => chain }, userId: "user-1", householdId: "h1" },
    })
    expect(await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })).toEqual({
      status: "conflict",
      feedbackId: null,
    })
  })

  it.each([
    ["IRF02", /明日もう一度/],
    ["42501", /権限がありません/],
    ["28000", /ログインし直して/],
    ["22023", /入力内容を確認/],
    ["XX000", /電波の良い場所/],
  ])("%s は利用者向けの文言に写す", async (code, pattern) => {
    setRpc({ data: null, error: { code, message: "x" } })
    const result = await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })
    expect(result.status).toBe("error")
    expect(result.status === "error" && result.error).toMatch(pattern)
  })

  it("0 行を成功と偽らぬ", async () => {
    setRpc({ data: [], error: null })
    expect((await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })).status).toBe(
      "error",
    )
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("⚠️ 失敗のログに題・本文・CHECK の details（行の中身）を出さぬ", async () => {
    setRpc({
      data: null,
      error: {
        code: "23514",
        message: 'new row for relation "feedback_items" violates check constraint',
        details: `Failing row contains (${SECRET_TITLE}, ${SECRET_BODY})`,
        hint: null,
      },
    })
    await submitFeedback({ requestId: REQUEST_ID, title: SECRET_TITLE, body: SECRET_BODY })
    expect(consoleError).toHaveBeenCalled()
    const logged = JSON.stringify(consoleError.mock.calls)
    expect(logged).not.toContain(SECRET_TITLE)
    expect(logged).not.toContain(SECRET_BODY)
    expect(logged).toContain("23514")
  })

  it("未承認・世帯なしは RPC を呼ばずに返す", async () => {
    getAuthContext.mockResolvedValue({ error: "承認待ちです", reason: "not-approved", context: null })
    expect(await submitFeedback({ requestId: REQUEST_ID, title: "題", body: "" })).toEqual({
      status: "error",
      error: "承認待ちです",
    })
  })
})

describe("markFeedbackSeen", () => {
  it("既読にして、一覧と設定の Client Cache を捨てさせる", async () => {
    const rpc = setRpc({ data: null, error: null })
    expect(await markFeedbackSeen(FEEDBACK_ID)).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith("mark_feedback_seen", { p_feedback_id: FEEDBACK_ID })
    expect(revalidatePath).toHaveBeenCalledWith("/feedback", "layout")
    expect(revalidatePath).toHaveBeenCalledWith("/settings")
  })
  it("見えぬ要望（P0002）は ok: false（画面は止めぬ）", async () => {
    setRpc({ data: null, error: { code: "P0002", message: "feedback not found" } })
    expect(await markFeedbackSeen(FEEDBACK_ID)).toEqual({ ok: false })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
  it("id の形が違えば RPC を呼ばぬ", async () => {
    const rpc = setRpc({ data: null, error: null })
    expect(await markFeedbackSeen("../etc")).toEqual({ ok: false })
    expect(rpc).not.toHaveBeenCalled()
  })
})
