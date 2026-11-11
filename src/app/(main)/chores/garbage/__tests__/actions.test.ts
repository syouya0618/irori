/**
 * chores/garbage/actions の単体テスト（DB なし）。
 * 認証・入力の検証・世帯 id を受け取らぬこと・RPC の 3 状態・結果不明の分類を固定する。
 * RPC そのものの認可（別世帯・viewer・anon）は pgTAP `supabase/tests/event_purposes.sql` の H 群が持つ。
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
const logSupabaseError = vi.fn()
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { submitGarbageRequest } from "../actions"

const HOUSEHOLD = "aa000000-0000-4000-8000-000000000001"
const OTHER_HOUSEHOLD = "bb000000-0000-4000-8000-000000000002"
const EVENT = "c2000000-0000-4000-8000-000000000010"
const PURPOSE = "d3000000-0000-4000-8000-000000000020"

type RpcResult = { data: unknown; error: unknown }

function setContext(rpcResult: RpcResult | (() => Promise<RpcResult>)) {
  const rpc = vi.fn((_name: string, _args: unknown) =>
    typeof rpcResult === "function" ? rpcResult() : Promise.resolve(rpcResult),
  )
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { rpc }, userId: "user-1", householdId: HOUSEHOLD },
  })
  return rpc
}

const save = {
  op: "save" as const,
  eventId: EVENT,
  scope: "series" as const,
  action: "garbage" as const,
  garbageKind: "燃えるごみ",
  reminder: "prev_day_20" as const,
  // 画面が見ておった分類の行の版（series 行は在った・event 行は無かった）
  seen: { series: "2026-11-10T00:00:00.123456+00:00", event: null },
}

const CONSUMERS = ["/baby", "/calendar", "/chores", "/chores/garbage"]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("submitGarbageRequest: 認証と入力", () => {
  it("未認証は rejected で返し、RPC を呼ばぬ", async () => {
    const rpc = vi.fn()
    getAuthContext.mockResolvedValue({ error: "ログインが必要です", reason: "unauthenticated", context: null })
    const r = await submitGarbageRequest(save)
    expect(r).toEqual({ error: "ログインが必要です", failure: "rejected" })
    expect(rpc).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    ["世帯 id を足した要求", { ...save, householdId: OTHER_HOUSEHOLD }],
    ["snake_case の世帯 id を足した要求", { ...save, household_id: OTHER_HOUSEHOLD }],
    ["UUID でない予定 id", { ...save, eventId: "1 OR 1=1" }],
    ["未知の範囲", { ...save, scope: "household" }],
    ["未知の操作", { ...save, action: "delete" }],
    ["未知の通知の扱い", { ...save, reminder: "m10" }],
    ["21 文字の名称", { ...save, garbageKind: "あ".repeat(21) }],
    ["空白だけの名称", { ...save, garbageKind: "   " }],
    ["シリーズ全体を通常へ戻す", { ...save, action: "normal", garbageKind: null }],
    ["解除と同時に通知を足す", { ...save, action: "clear", garbageKind: null }],
    ["見ておった版を持たぬ要求", (({ seen: _seen, ...rest }) => rest)(save)],
    ["版の形が合わぬ要求", { ...save, seen: { series: "2026-11-10", event: null } }],
    ["版に余分な項目を足した要求", { ...save, seen: { ...save.seen, force: true } }],
    ["null", null],
    ["文字列", "save"],
    ["整理の id が UUID でない", { op: "delete-orphan", purposeId: "x" }],
  ])("不正な入力（%s）は rejected で返し、RPC を呼ばぬ", async (_name, input) => {
    const rpc = setContext({ data: { status: "saved", purpose: null }, error: null })
    const r = await submitGarbageRequest(input)
    expect(r).toEqual({ error: "入力内容を確認してください。", failure: "rejected" })
    expect(rpc).not.toHaveBeenCalled()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("RPC へ渡すのは予定の行 id と選択だけ（世帯 id も鍵も渡さぬ）", async () => {
    const rpc = setContext({ data: { status: "saved", purpose: { id: PURPOSE } }, error: null })
    await submitGarbageRequest(save)
    expect(rpc.mock.calls).toEqual([
      [
        "save_event_purpose",
        {
          p_event_id: EVENT,
          p_scope: "series",
          p_action: "garbage",
          p_garbage_kind: "燃えるごみ",
          p_reminder: "prev_day_20",
          // 版は表記のまま（マイクロ秒を落とさぬ）。行が無かった側は null
          p_seen_series: "2026-11-10T00:00:00.123456+00:00",
          p_seen_event: null,
        },
      ],
    ])
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(HOUSEHOLD)
  })

  it("端末の控えの再送も、控えに残っておる版をそのまま渡す（最新の版へ差し替えぬ。R38）", async () => {
    const rpc = setContext({ data: { status: "conflict", purpose: { id: PURPOSE } }, error: null })
    const stale = {
      ...save,
      scope: "event" as const,
      action: "normal" as const,
      garbageKind: null,
      reminder: "off" as const,
      seen: { series: "2026-11-01T00:00:00.000001+00:00", event: "2026-11-02T00:00:00.999999+00:00" },
    }
    const r = await submitGarbageRequest(stale)
    // RPC が版の違いで止めた（何も書いておらぬ）。Action は conflict をそのまま返す
    expect(r).toEqual({ status: "conflict" })
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_seen_series: "2026-11-01T00:00:00.000001+00:00",
      p_seen_event: "2026-11-02T00:00:00.999999+00:00",
    })
    // Action は版を確かめるための読み取りを自分ではせぬ（照合は RPC がロックの中で行う）
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})

describe("submitGarbageRequest: RPC の結果", () => {
  it.each(["saved", "replayed", "conflict"] as const)(
    "%s をそのまま返し、分類を読む 4 画面を無効化する",
    async (status) => {
      setContext({ data: { status, purpose: null }, error: null })
      const r = await submitGarbageRequest(save)
      expect(r).toEqual({ status })
      expect(revalidatePath.mock.calls.map(([p]) => p).sort()).toEqual(CONSUMERS)
    },
  )

  it("解除（purpose が null の応答）も saved として読める", async () => {
    const rpc = setContext({ data: { status: "saved", purpose: null }, error: null })
    const r = await submitGarbageRequest({ ...save, action: "clear", garbageKind: null, reminder: "keep" })
    expect(r).toEqual({ status: "saved" })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: "clear", p_garbage_kind: null, p_reminder: "keep" })
  })

  it("別世帯の予定 id（RPC が 42501）は rejected。存在を言い分けぬ文を返す", async () => {
    setContext({ data: null, error: { code: "42501", message: "event unavailable", details: "", hint: "" } })
    const r = await submitGarbageRequest(save)
    expect(r).toEqual({
      error: "この予定は分類できません。予定が削除されたか、操作する権限がありません。",
      failure: "rejected",
    })
    expect(revalidatePath).not.toHaveBeenCalled()
    expect(logSupabaseError).toHaveBeenCalled()
  })

  it.each([
    ["medical events cannot be classified", "健診・予防接種の予定は、ごみの日にできません。"],
    ["event is not part of a series", "この予定は繰り返しではないため、「シリーズ全体」は選べません。"],
    ["invalid event purpose input", "入力内容を確認してください。"],
  ])("22023（%s）は rejected で、DB の生の文言を返さぬ", async (message, expected) => {
    setContext({ data: null, error: { code: "22023", message, details: "", hint: "" } })
    const r = await submitGarbageRequest(save)
    expect(r).toEqual({ error: expected, failure: "rejected" })
  })

  it("code を持たぬ失敗（通信断・timeout）は unknown（保存されたかもしれぬ）", async () => {
    setContext({ data: null, error: { code: "", message: "TypeError: fetch failed", details: "", hint: "" } })
    const r = await submitGarbageRequest(save)
    expect(r).toMatchObject({ failure: "unknown" })
    // 対照: SQLSTATE を持つ失敗は rejected（上の 42501 / 22023）
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it.each([
    ["status が無い", { purpose: null }],
    ["未知の status", { status: "ok" }],
    ["null", null],
    ["配列", [{ status: "saved" }]],
  ])("戻り値を読めぬ時（%s）は unknown。成功とも失敗とも断定せぬ", async (_name, data) => {
    setContext({ data, error: null })
    const r = await submitGarbageRequest(save)
    expect(r).toMatchObject({ failure: "unknown" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("RPC が throw しても Action は throw せず unknown を返す", async () => {
    setContext(() => Promise.reject(new Error("socket hang up")))
    const r = await submitGarbageRequest(save)
    expect(r).toMatchObject({ failure: "unknown" })
  })
})

describe("submitGarbageRequest: 予定が見つからぬ分類の整理", () => {
  it("分類の行 id だけを渡す", async () => {
    const rpc = setContext({ data: { status: "saved" }, error: null })
    const r = await submitGarbageRequest({ op: "delete-orphan", purposeId: PURPOSE })
    expect(r).toEqual({ status: "saved" })
    expect(rpc.mock.calls).toEqual([["delete_orphan_event_purpose", { p_id: PURPOSE }]])
    expect(revalidatePath.mock.calls.map(([p]) => p).sort()).toEqual(CONSUMERS)
  })

  it("予定が見つかった（conflict = 消しておらぬ）をそのまま返す", async () => {
    setContext({ data: { status: "conflict" }, error: null })
    expect(await submitGarbageRequest({ op: "delete-orphan", purposeId: PURPOSE })).toEqual({ status: "conflict" })
  })
})
