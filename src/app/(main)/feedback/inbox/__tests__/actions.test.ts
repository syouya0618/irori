import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { releaseFeedback, updateFeedbackStatus } from "../actions"

const FEEDBACK_ID = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
const REQUEST_ID = "3f2b8c1e-6a4d-4c8b-9e2f-1a2b3c4d5e6f"

function setRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result)
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { rpc }, userId: "operator-1", householdId: "h1" },
  })
  return rpc
}

const base = {
  feedbackId: FEEDBACK_ID,
  requestId: REQUEST_ID,
  expectedVersion: 3,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("updateFeedbackStatus", () => {
  it("状態の変更を版つきで RPC へ渡す", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    const result = await updateFeedbackStatus({
      ...base,
      status: "in_progress",
      comment: " 取りかかります \r\n",
      mergeRef: "PR #241",
    })
    expect(rpc).toHaveBeenCalledWith("operator_update_feedback", {
      p_feedback_id: FEEDBACK_ID,
      p_client_request_id: REQUEST_ID,
      p_expected_version: 3,
      p_status: "in_progress",
      p_comment: "取りかかります",
      p_merge_ref: "PR #241",
    })
    expect(result).toEqual({ status: "ok", version: 4, duplicate: false })
    expect(revalidatePath).toHaveBeenCalledWith("/feedback", "layout")
  })

  it("返信だけは status=null で送る", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    await updateFeedbackStatus({ ...base, status: null, comment: "確認しました", mergeRef: null })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_status: null, p_comment: "確認しました" })
  })

  it("⚠️ released はここでは送らぬ（証拠を伴う確定フォームだけ）", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    const result = await updateFeedbackStatus({ ...base, status: "released", comment: null, mergeRef: null })
    expect(result.status).toBe("error")
    expect(rpc).not.toHaveBeenCalled()
  })

  it("見送りは理由が無ければ送らぬ", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    const result = await updateFeedbackStatus({ ...base, status: "declined", comment: "  ", mergeRef: null })
    expect(result).toMatchObject({ status: "error", error: expect.stringContaining("理由") })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("状態も返信も無い操作は送らぬ", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    expect((await updateFeedbackStatus({ ...base, status: null, comment: "", mergeRef: "" })).status).toBe("error")
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([
    [{ expectedVersion: 0 }],
    [{ expectedVersion: "3" }],
    [{ feedbackId: "x" }],
    [{ requestId: null }],
  ])("鍵・版の形が違えば送らぬ %o", async (over) => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    expect((await updateFeedbackStatus({ ...base, ...over, status: "considering", comment: null, mergeRef: null })).status).toBe("error")
    expect(rpc).not.toHaveBeenCalled()
  })

  it("同じ操作の再送は duplicate として ok", async () => {
    setRpc({ data: [{ version: 4, created: false }], error: null })
    expect(await updateFeedbackStatus({ ...base, status: "considering", comment: null, mergeRef: null })).toEqual({
      status: "ok",
      version: 4,
      duplicate: true,
    })
  })

  it.each([
    ["IRF03", { status: "conflict" }],
    ["42501", { status: "error", error: "運用者の権限がありません" }],
    ["P0002", { status: "error", error: "要望が見つかりませんでした" }],
  ])("%s を写す", async (code, expected) => {
    setRpc({ data: null, error: { code, message: "x" } })
    expect(await updateFeedbackStatus({ ...base, status: "considering", comment: null, mergeRef: null })).toEqual(expected)
  })
})

describe("releaseFeedback — 本番確認の宣言とコミット SHA が無ければ送らぬ", () => {
  const release = { ...base, commitSha: "ABCDEF1", releaseNote: "v1.7.0", comment: null }

  it("⚠️ 本番確認の宣言が true でなければ RPC を呼ばぬ", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    for (const productionVerified of [false, undefined, "true", 1]) {
      const result = await releaseFeedback({ ...release, productionVerified })
      expect(result.status).toBe("error")
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it("SHA の形が違えば RPC を呼ばぬ", async () => {
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    for (const commitSha of ["", "main", "abc", 1234567]) {
      expect((await releaseFeedback({ ...release, commitSha, productionVerified: true })).status).toBe("error")
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it("SHA を正規化し、サーバが観測したデプロイを添えて確定する", async () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "ABCDEF1234567")
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    const result = await releaseFeedback({ ...release, productionVerified: true })
    expect(rpc).toHaveBeenCalledWith("operator_release_feedback", {
      p_feedback_id: FEEDBACK_ID,
      p_client_request_id: REQUEST_ID,
      p_expected_version: 3,
      p_commit_sha: "abcdef1",
      p_release_note: "v1.7.0",
      p_observed_deploy: "production:abcdef1234567",
      p_production_verified: true,
      p_comment: null,
    })
    expect(result).toEqual({ status: "ok", version: 4, duplicate: false })
  })

  it("稼働中のデプロイが読めぬ環境では observed_deploy を null で送る（偽の観測を作らぬ）", async () => {
    vi.stubEnv("VERCEL_ENV", "")
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "")
    const rpc = setRpc({ data: [{ version: 4, created: true }], error: null })
    await releaseFeedback({ ...release, productionVerified: true })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_observed_deploy: null })
  })

  it("版の衝突は conflict", async () => {
    setRpc({ data: null, error: { code: "IRF03", message: "x" } })
    expect(await releaseFeedback({ ...release, productionVerified: true })).toEqual({ status: "conflict" })
  })
})
