/**
 * 端末の解除 Server Action（SEC-1 / B1）。
 *
 * ここで縛るのは「解除がブラウザ側の `unsubscribe()` と**対で成立する**ための
 * 1 ビットを、正しく運んでおるか」じゃ:
 *
 *   1. 呼び出し元の endpoint を RPC へ渡す（どの行が自分かはサーバでしか
 *      判定できぬ。endpoint は列 GRANT の外ゆえ返させぬ）
 *   2. 'deleted-this-device' の時だけ `deletedCurrentDevice: true` を返す
 *      （ここが緩むと、他端末を消した拍子に自分の購読を畳む）
 *   3. 'not-found' を「消せた」と偽らぬ（`.delete()` が 0 行でも error: null を
 *      返す罠を、RPC の 3 値で塞いである）
 *   4. **endpoint をログへ出さぬ**（送信能力そのものゆえ）
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { deletePushSubscription } from "../push-actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

const ENDPOINT = "https://fcm.googleapis.com/fcm/send/this-device"
const mockedLog = vi.mocked(logSupabaseError)

function setup(rpcResult: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn().mockResolvedValue({
    data: rpcResult.data ?? null,
    error: rpcResult.error ?? null,
  })
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: { rpc }, userId: "user-1", householdId: "house-1" },
  })
  return { rpc }
}

beforeEach(() => {
  getAuthContext.mockReset()
  mockedLog.mockClear()
})

describe("deletePushSubscription", () => {
  it("id と **自分の endpoint** を RPC へ渡す", async () => {
    const { rpc } = setup({ data: "deleted-this-device" })

    await deletePushSubscription("sub-1", ENDPOINT)

    expect(rpc).toHaveBeenCalledWith("delete_my_push_subscription_by_id", {
      p_id: "sub-1",
      p_endpoint: ENDPOINT,
    })
  })

  it("この端末だった時だけ deletedCurrentDevice を立てる", async () => {
    setup({ data: "deleted-this-device" })
    await expect(deletePushSubscription("sub-1", ENDPOINT)).resolves.toEqual({
      error: null,
      deletedCurrentDevice: true,
    })
  })

  it("別端末なら立てぬ（他端末の解除で自分の購読を畳まぬ）", async () => {
    setup({ data: "deleted-other-device" })
    await expect(deletePushSubscription("sub-2", ENDPOINT)).resolves.toEqual({
      error: null,
      deletedCurrentDevice: false,
    })
  })

  it("not-found は「消せた」と偽らぬ（0 行削除の罠）", async () => {
    setup({ data: "not-found" })
    const result = await deletePushSubscription("sub-3", ENDPOINT)
    expect(result.error).toBe("対象の端末が見つかりませんでした。")
    expect(result.deletedCurrentDevice).toBe(false)
  })

  it("endpoint を渡さねば p_endpoint は null（判定不能は「別端末」へ倒れる）", async () => {
    const { rpc } = setup({ data: "deleted-other-device" })
    await deletePushSubscription("sub-1")
    expect(rpc).toHaveBeenCalledWith("delete_my_push_subscription_by_id", {
      p_id: "sub-1",
      p_endpoint: null,
    })
  })

  it("上限を超える endpoint は渡さぬ（DB の CHECK と同じ 2048）", async () => {
    const { rpc } = setup({ data: "deleted-other-device" })
    await deletePushSubscription("sub-1", `https://fcm.googleapis.com/${"x".repeat(2100)}`)
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_endpoint: null })
  })

  it("RPC が落ちたらエラーを返し、**endpoint はログに出さぬ**", async () => {
    setup({ error: { message: "boom", code: "42501" } })

    const result = await deletePushSubscription("sub-1", ENDPOINT)

    expect(result).toEqual({
      error: "通知の解除に失敗しました。",
      deletedCurrentDevice: false,
    })
    expect(mockedLog).toHaveBeenCalled()
    // endpoint は「その端末へ任意の通知を送る能力そのもの」じゃ。
    // 診断のためとて、ログの文脈へ混ぜてはならぬ。
    expect(JSON.stringify(mockedLog.mock.calls)).not.toContain(ENDPOINT)
  })

  it("id が空なら DB へ触らぬ", async () => {
    const { rpc } = setup({ data: "deleted-this-device" })
    const result = await deletePushSubscription("", ENDPOINT)
    expect(result.error).toBe("端末が指定されていません。")
    expect(rpc).not.toHaveBeenCalled()
  })
})
