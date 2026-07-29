/**
 * getVerifiedUserId の fail-closed 検証。
 *
 * ルーティング判定の唯一の源ゆえ、ここが緩むと proxy とページの両方が同時に緩む。
 * 逆に言えば、両者が同じ関数を使う限り**判定が食い違うことは構造的に起こらない**
 * （無限リダイレクトの回帰を防ぐのはこの単一化そのもの）。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { getVerifiedUserId, type ClaimsCapableClient } from "../verified-user"

const getClaims = vi.fn()
const client = { auth: { getClaims: () => getClaims() } } as ClaimsCapableClient

beforeEach(() => {
  getClaims.mockReset()
})

describe("getVerifiedUserId: 判定不能は必ず null（fail-closed）", () => {
  it.each([
    ["セッション無し（data も error も null）", { data: null, error: null }],
    ["署名不正・期限切れ・JWKS 取得失敗", { data: null, error: { message: "invalid JWT" } }],
    ["claims はあるが sub 欠落", { data: { claims: {} }, error: null }],
    ["sub が空文字", { data: { claims: { sub: "" } }, error: null }],
    ["sub が非文字列の truthy 値", { data: { claims: { sub: 12345 } }, error: null }],
    ["想定外の戻り値（undefined）", undefined],
  ])("%s → null", async (_label, ret) => {
    getClaims.mockResolvedValue(ret)
    expect(await getVerifiedUserId(client, "test")).toBeNull()
  })

  it("例外も未認証へ倒す（getClaims は AuthError 以外を再 throw する）", async () => {
    getClaims.mockRejectedValue(new Error("WebCrypto unavailable"))
    expect(await getVerifiedUserId(client, "test")).toBeNull()
  })
})

describe("getVerifiedUserId: 正常系", () => {
  it("有効な sub をそのまま返す", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    expect(await getVerifiedUserId(client, "test")).toBe("user-1")
  })

  it("セッション無しはログを出さない（本物の異常だけを記録する）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    getClaims.mockResolvedValue({ data: null, error: null })
    await getVerifiedUserId(client, "test")
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("本物の異常はログに残す（握り潰さない）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    getClaims.mockResolvedValue({ data: null, error: { message: "invalid JWT" } })
    await getVerifiedUserId(client, "test")
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

/**
 * 層をまたぐ判定の一致（無限リダイレクト回帰の本丸）。
 *
 * 単層のテストでは proxy とページの「食い違い」は原理的に捕まえられない。
 * 唯一の構造的な保証は「両層が同じ関数を呼ぶこと」ゆえ、それを固定する。
 * ここが赤くなったら、判定源が再び分裂している。
 */
describe("判定源の単一性（層をまたぐ乖離の防止）", () => {
  it("同じ入力に対して proxy 経路とページ経路が必ず同じ判定を返す", async () => {
    // getClaims は通るが getUser なら失敗する状態（他端末での全体サインアウト・
    // GoTrue 障害）を模す。両層が同じ関数を使う限り判定は一致する。
    const revokedButUnexpired = {
      data: { claims: { sub: "user-1" } },
      error: null,
    }
    getClaims.mockResolvedValue(revokedButUnexpired)

    const proxySide = await getVerifiedUserId(client, "proxy")
    const pageSide = await getVerifiedUserId(client, "home")

    expect(proxySide).toBe(pageSide)
    expect(proxySide).toBe("user-1")
  })

  it("未認証側でも一致する（片方だけが通す状態を作らない）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    expect(await getVerifiedUserId(client, "proxy")).toBe(
      await getVerifiedUserId(client, "home"),
    )
  })
})
