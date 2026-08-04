import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `POST /api/google/sync`（明示トリガ）の認可と、同期エンジンへの渡し方。
 *
 * ## D-4 と D-5 の統合で形が変わった経緯
 * D-4 は当初これを「殻」として作り、`connectionId` の UUID 検証と 501 応答を
 * 固定しておった。D-5 が同期エンジンを実装した際、`syncHousehold` は**世帯単位で
 * しか動かず** `connectionId` を消費する経路が無いことが分かったため、統合時に
 * 本文の解析ごと落とした。**何も消費せぬ入力の検証は、受け付ける契約が在るかの
 * ように見せる分だけ有害じゃ。**
 *
 * ゆえにここで固定するのは次の 4 点:
 * 1. 未認証 / 未承認 / 世帯未設定 は**すべて 401**（承認ゲートの二層目）
 * 2. **世帯 ID はリクエストではなく認証文脈から取る**（body で受けると世帯跨ぎ）
 * 3. **service role は認可を通った後にしか生成せぬ**（`admin.ts` の契約）
 * 4. 同期の失敗は 500 で、握り潰さず構造化ログを残す
 *
 * ## 限界の明示
 * Route Handler を直接 import するテストは **proxy を通らぬ**。ゆえに
 * 「proxy の承認ゲートが効いていること」はここでは検査できておらぬ
 * （CLAUDE.md が名指しする「テスト緑・本番不発」の型）。本ルートは
 * `/api/cron/` 配下では**ない**ため proxy の既定挙動（認証必須）に乗るのが正しく、
 * 除外設定を足しておらぬ = 素通りの窓を新設しておらぬ。実経路の 307 検査は
 * `e2e/google-cron-proxy.spec.ts` が cron 側と併せて担う。
 */

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

const createAdminClient = vi.fn()
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}))

const syncHousehold = vi.fn()
vi.mock("@/lib/google/sync", () => ({
  syncHousehold: (...args: unknown[]) => syncHousehold(...args),
}))

import { POST } from "@/app/api/google/sync/route"

const ADMIN = { __brand: "admin-client" }

const AUTHED = {
  error: null,
  reason: null,
  context: { supabase: {}, userId: "user-1", householdId: "household-1" },
}

beforeEach(() => {
  vi.clearAllMocks()
  getAuthContext.mockResolvedValue(AUTHED)
  createAdminClient.mockReturnValue(ADMIN)
  syncHousehold.mockResolvedValue({ subscriptions: 2, upserted: 7 })
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("認可（session 認証。CRON_SECRET は使わぬ）", () => {
  const denials: [string, string, string][] = [
    ["未認証", "認証されていません", "unauthenticated"],
    ["未承認（承認ゲートの二層目）", "承認待ちです", "not-approved"],
    ["世帯未設定", "世帯が設定されていません", "no-household"],
    ["一過性の参照失敗", "読み込みに失敗しました", "lookup-failed"],
  ]

  it.each(denials)("%s は 401", async (_name, error, reason) => {
    getAuthContext.mockResolvedValue({ error, reason, context: null })
    expect((await POST()).status).toBe(401)
  })

  /**
   * ⭐ `admin.ts` の契約「service role は認可を通した**後**にのみ生成する」。
   * これが破れると、未認証リクエストでも RLS をバイパスするクライアントが
   * 作られる経路が生まれる（描画経路に service role を置かぬのと同根）。
   */
  it.each(denials)("%s では service role を生成せぬ", async (_n, error, reason) => {
    getAuthContext.mockResolvedValue({ error, reason, context: null })
    await POST()
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(syncHousehold).not.toHaveBeenCalled()
  })
})

describe("同期エンジンへの渡し方", () => {
  it("認可を通ると service role で syncHousehold を呼び、結果を返す", async () => {
    const response = await POST()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: { subscriptions: 2, upserted: 7 },
    })
    expect(createAdminClient).toHaveBeenCalledTimes(1)
    expect(syncHousehold).toHaveBeenCalledWith(ADMIN, "household-1")
  })

  /**
   * ⭐ **世帯 ID はリクエストから取らぬ。** body で受けると、認証済みの者が
   * 他世帯を指定して同期を撃てる。`POST()` が引数を一切取らぬ形にしてあるのは
   * その保証じゃ — ゆえに「認証文脈の値がそのまま渡ること」を固定する。
   */
  it("世帯 ID は認証文脈の値であって、リクエスト由来ではない", async () => {
    getAuthContext.mockResolvedValue({
      ...AUTHED,
      context: { ...AUTHED.context, householdId: "household-from-auth" },
    })
    await POST()
    expect(syncHousehold).toHaveBeenCalledWith(ADMIN, "household-from-auth")
  })

  it("同期が throw したら 500 を返し、握り潰さず構造化ログを残す", async () => {
    syncHousehold.mockRejectedValue(new Error("boom"))
    const response = await POST()
    expect(response.status).toBe(500)
    expect(console.error).toHaveBeenCalledWith(
      "[api-google-sync] 同期に失敗",
      expect.objectContaining({ householdId: "household-1", message: "boom" })
    )
  })

  it("Error でない throw でも 500 とログ（String 化して落とさぬ）", async () => {
    syncHousehold.mockRejectedValue("文字列で投げられた")
    const response = await POST()
    expect(response.status).toBe(500)
    expect(console.error).toHaveBeenCalledWith(
      "[api-google-sync] 同期に失敗",
      expect.objectContaining({ message: "文字列で投げられた" })
    )
  })
})
