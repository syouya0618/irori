/**
 * getAuthContext の fail-closed 検証。
 *
 * proxy と同じく `getUser()` → `getClaims()` へ切り替えるにあたり、切替前に
 * 不変条件を固定するために置いた（従前テストなし）。
 *
 * 判定不能（claims なし・error・sub 欠落・例外）は必ず "unauthenticated" へ倒す。
 * ページと Server Action はこの戻り値だけを信じて世帯データを触るため、ここが
 * 緩むと household 分離が破れる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getClaims = vi.fn()
const profileSingle = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: () => getClaims() },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => profileSingle() }) }),
    }),
  }),
}))

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

// React.cache は同一リクエスト内メモ化。テストでは素通しにして各ケースを独立させる。
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>()
  return { ...actual, cache: (fn: unknown) => fn }
})

import { getAuthContext } from "../auth-context"

beforeEach(() => {
  getClaims.mockReset()
  profileSingle.mockReset()
})

describe("getAuthContext: 認証不能は必ず unauthenticated（fail-closed）", () => {
  it.each([
    ["claims が空", { data: null, error: null }],
    ["error が返る", { data: null, error: { message: "invalid JWT" } }],
    ["sub が無い", { data: { claims: {} }, error: null }],
    ["想定外の戻り値", undefined],
  ])("%s → unauthenticated（世帯データへ到達させない）", async (_l, ret) => {
    getClaims.mockResolvedValue(ret)
    const r = await getAuthContext()
    expect(r.reason).toBe("unauthenticated")
    expect(r.context).toBeNull()
    // profiles を引きに行かない（無駄な往復も作らない）
    expect(profileSingle).not.toHaveBeenCalled()
  })

  it("getClaims が throw しても unauthenticated へ倒す", async () => {
    getClaims.mockRejectedValue(new Error("network down"))
    const r = await getAuthContext()
    expect(r.reason).toBe("unauthenticated")
    expect(r.context).toBeNull()
  })
})

describe("getAuthContext: 正常系と世帯なし", () => {
  it("claims.sub と household_id が揃えば context を返す", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: { household_id: "house-1" }, error: null })
    const r = await getAuthContext()
    expect(r.error).toBeNull()
    expect(r.context?.userId).toBe("user-1")
    expect(r.context?.householdId).toBe("house-1")
  })

  it("世帯未設定は no-household（unauthenticated と区別する）", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: { household_id: null }, error: null })
    const r = await getAuthContext()
    expect(r.reason).toBe("no-household")
    expect(r.context).toBeNull()
  })

  it("profiles が引けない時も context を返さない（fail-closed）", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const r = await getAuthContext()
    expect(r.context).toBeNull()
  })
})

/**
 * 承認ゲートの**二層目**。一層目は proxy にあるが、規約ファイル（proxy.ts）は
 * 置き場所を一段間違えるだけでビルドも lint も型検査も緑のまま黙って無効化されうる
 * （過去に半年間ゲートが不稼働だった類型）。proxy が inert になった場合でも、
 * 承認されておらぬ利用者へ世帯データの経路を開かぬことをここで固定する。
 */
describe("getAuthContext: 承認ゲート（二層目）", () => {
  it("承認済みなら従来どおり context を返す", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({
      data: { household_id: "house-1", is_approved: true },
      error: null,
    })
    const r = await getAuthContext()
    expect(r.error).toBeNull()
    expect(r.context?.householdId).toBe("house-1")
  })

  it("承認を取り消された利用者は世帯が残っていても not-approved（context なし）", async () => {
    // 承認取り消しでは household_id は残るため、household 判定だけでは素通りする。
    // ここが二層目の要じゃ。
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({
      data: { household_id: "house-1", is_approved: false },
      error: null,
    })
    const r = await getAuthContext()
    expect(r.reason).toBe("not-approved")
    expect(r.context).toBeNull()
  })

  it("未承認かつ世帯なしは no-household ではなく not-approved（proxy の分岐と揃える）", async () => {
    // 遷移先が層ごとに食い違うと無限リダイレクトになる。proxy は未承認を
    // /pending-approval へ送るため、承認判定を household 判定より先に置く。
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({
      data: { household_id: null, is_approved: false },
      error: null,
    })
    const r = await getAuthContext()
    expect(r.reason).toBe("not-approved")
  })

  // I-16 で足した lookup-failed が、この「断定しない」不変条件を満たす具体値である
  // ことを下の describe が正面から固定する（ここは否定形ゆえ単独では弱い）。
  it("is_approved が読めなかった場合は not-approved と断定しない（一過性エラーで /pending-approval へ飛ばさぬ）", async () => {
    // lookup 失敗を「未承認」と断定すると、一過性の DB エラーで承認済みの利用者が
    // 承認待ち画面へ落ちる。context を返さぬ点は同じ（fail-closed は保たれる）。
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const r = await getAuthContext()
    expect(r.reason).not.toBe("not-approved")
    expect(r.context).toBeNull()
  })
})

/**
 * 一過性エラーと「世帯なし」の弁別（I-16）。
 *
 * 従前は profiles の lookup 失敗をログには残すが**分岐に使っておらず**、
 * `!profile?.household_id` に吸われて `no-household` を返していた。呼び出し元の
 * (main)/layout はそれを見て /setup へ redirect するため、**世帯が在るのに
 * 世帯作成画面へ飛ぶ**（世帯を二重に作りかねない）。
 *
 * `settings/page.tsx` は既に「lookup 失敗は throw して error boundary」の流儀を
 * 採っており、同一リポ内で不統一だったのを揃える。
 */
describe("getAuthContext: 一過性エラーを「世帯なし」と区別する（I-16）", () => {
  it("profiles の lookup 失敗は lookup-failed（no-household ではない）", async () => {
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({
      data: null,
      error: { message: "connection reset", code: "08006" },
    })
    const r = await getAuthContext()
    // 正面から固定する（否定形の assertion では typo も他の reason も素通りする）
    expect(r.reason).toBe("lookup-failed")
    expect(r.context).toBeNull()
  })

  it("error なしで profile が空でも lookup-failed へ倒す（判定不能を誘導に使わない）", async () => {
    // .single() は通常 0 行で PGRST116 を返すが、将来 .maybeSingle() へ
    // 変えた場合などにこの経路が生きる。「世帯なし」と断定してはならぬ。
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({ data: null, error: null })
    const r = await getAuthContext()
    expect(r.reason).toBe("lookup-failed")
    expect(r.context).toBeNull()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("本当に世帯が無い場合は従来どおり no-household（/setup 誘導は残す）", async () => {
    // lookup-failed を足したせいで正常な世帯なし導線まで壊しては本末転倒じゃ。
    getClaims.mockResolvedValue({ data: { claims: { sub: "user-1" } }, error: null })
    profileSingle.mockResolvedValue({
      data: { household_id: null, is_approved: true },
      error: null,
    })
    const r = await getAuthContext()
    expect(r.reason).toBe("no-household")
  })
})
