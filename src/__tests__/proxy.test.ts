/**
 * proxy（認証ゲート）の fail-closed 検証。
 *
 * 本ファイルは `getUser()`（毎回 Auth サーバへ往復）から `getClaims()`（非対称鍵なら
 * ローカル WebCrypto 検証）へ切り替えるにあたって置いた。**認証の最外殻ゲートであり
 * ながらテストが1本も無かった**ため、切替の前に不変条件を固定する。
 *
 * 最重要の不変条件: **判定不能は必ず「未認証」へ倒す**（fail-closed）。
 * 署名不正・期限切れ・JWKS 取得失敗・想定外の戻り値のいずれでも、保護ページを
 * 素通しさせてはならない。ここが緩むと「OSS 公開 × 家族専用」が破れる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import { DEFAULT_PAGE, VALID_PAGES } from "@/lib/constants/pages"

const getClaims = vi.fn()
const profileSingle = vi.fn()

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: () => getClaims() },
    from: () => ({
      select: () => ({ eq: () => ({ single: () => profileSingle() }) }),
    }),
  }),
}))

import { proxy } from "../proxy"

/** 本物の NextRequest を使う（nextUrl / cookies が要るため素の Request では不足） */
function request(pathname: string) {
  return new NextRequest(new URL(pathname, "https://example.test"), {
    headers: { host: "example.test" },
  })
}

/** 認証済み扱いの claims（sub がユーザー ID） */
const validClaims = { data: { claims: { sub: "user-1" } }, error: null }

beforeEach(() => {
  getClaims.mockReset()
  profileSingle.mockReset()
  profileSingle.mockResolvedValue({ data: { is_approved: true }, error: null })
})

describe("proxy: 未認証の扱い（fail-closed）", () => {
  it.each([
    ["claims が空", { data: null, error: null }],
    ["error が返る（署名不正・期限切れ・JWKS 取得失敗を含む）", { data: null, error: { message: "invalid JWT" } }],
    ["claims はあるが sub が無い", { data: { claims: {} }, error: null }],
    ["想定外の戻り値（undefined）", undefined],
  ])("%s → 保護ページは /login へ redirect（素通しさせない）", async (_label, ret) => {
    getClaims.mockResolvedValue(ret)
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("getClaims が throw しても素通しさせない（例外も未認証へ倒す）", async () => {
    getClaims.mockRejectedValue(new Error("network down"))
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("未認証でも /login 自体は通す（リダイレクトループを作らない）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    const res = await proxy(request("/login"))
    expect(res.status).not.toBe(307)
  })
})

describe("proxy: 承認ゲート（DB 読みゆえ即時に効き続ける）", () => {
  it("承認済みは保護ページを通す", async () => {
    getClaims.mockResolvedValue(validClaims)
    const res = await proxy(request("/baby"))
    expect(res.status).not.toBe(307)
  })

  it("未承認は /pending-approval へ", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: { is_approved: false }, error: null })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })

  it("profiles が引けない時も承認済み扱いにしない（fail-closed）", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })
})

/**
 * 起動時ページの解決を proxy が担うことの固定（起動の 1 往復を削るための変更）。
 *
 * 以前は `/` へ飛ばし、`/` の Server Component が改めて認証して `profiles` を
 * もう一度引き `/${page}` へ再 redirect しておった。`is_approved` を読む同じ
 * 往復で `default_page` も取れるゆえ、その一式が不要になる。
 *
 * ⚠️ ここで最も危ういのは**ループ**じゃ。行き先が再び分岐に入る値だと、
 * 307 が無限に続いて起動できなくなる。ゆえに VALID_PAGES を総なめして
 * 「行き先では redirect されぬ」ことを固定する（1 つ足したときに落ちる形）。
 */
describe("proxy: 起動時ページの解決（/ の動的描画を省く）", () => {
  const approvedWith = (defaultPage: unknown) =>
    profileSingle.mockResolvedValue({
      data: { is_approved: true, default_page: defaultPage },
      error: null,
    })

  it.each(VALID_PAGES)(
    "承認済みが / に来たら default_page=%s の行き先へ直接 307 する",
    async (page) => {
      getClaims.mockResolvedValue(validClaims)
      approvedWith(page)
      const res = await proxy(request("/"))
      expect(res.status).toBe(307)
      expect(new URL(res.headers.get("location")!).pathname).toBe(`/${page}`)
    }
  )

  it.each([
    ["NULL", null],
    ["未知の値", "dashboard"],
    ["列が無い（select 漏れ）", undefined],
  ])("default_page が %s なら既定へ倒す", async (_label, value) => {
    getClaims.mockResolvedValue(validClaims)
    approvedWith(value)
    const res = await proxy(request("/"))
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      `/${DEFAULT_PAGE}`
    )
  })

  it("ログイン直後（/login）も最終目的地まで一度で送る", async () => {
    getClaims.mockResolvedValue(validClaims)
    approvedWith("stock")
    const res = await proxy(request("/login"))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/stock")
  })

  it.each(VALID_PAGES)(
    "行き先 /%s では redirect されぬ（307 のループを作らない）",
    async (page) => {
      getClaims.mockResolvedValue(validClaims)
      approvedWith(page)
      const res = await proxy(request(`/${page}`))
      expect(res.status).not.toBe(307)
    }
  )

  it("クエリ文字列は行き先へ引き継ぐ", async () => {
    getClaims.mockResolvedValue(validClaims)
    approvedWith("shopping")
    const res = await proxy(request("/?from=push"))
    const url = new URL(res.headers.get("location")!)
    expect(url.pathname).toBe("/shopping")
    expect(url.search).toBe("?from=push")
  })

  // ── ゲートは動いておらぬことの確認（/ が「前へ進む」経路にならぬこと）──
  it("未認証で / に来ても /login へ倒す（前へ進ませない）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    const res = await proxy(request("/"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/login")
  })

  it("未承認で / に来たら /pending-approval へ倒す", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({
      data: { is_approved: false, default_page: "shopping" },
      error: null,
    })
    const res = await proxy(request("/"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })

  it("profiles の lookup が失敗したら / でも前へ進ませない（fail-closed）", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    const res = await proxy(request("/"))
    expect(res.status).toBe(307)
    expect(res.headers.get("location")).toContain("/pending-approval")
  })
})

/**
 * Server-Timing による最小の可観測性（I-15）。
 *
 * 「もっさりする」という訴えを**次回は測れる**ようにする経路じゃ。proxy は静的
 * アセット以外の全リクエストを通り、TTFB の支配項が認証往復であることが実測で
 * 分かっている（getUser 16.55ms → getClaims 0.14ms への切替が #171）。ゆえに
 * 認証と DB の内訳をここで返す。
 *
 * 計測範囲は **proxy 自身の auth + db のみ**（ページ本体の描画は含まぬ）。
 *
 * `Server-Timing` は同一オリジンなら追加設定なしでブラウザが解釈し、DevTools の
 * Network → Timing に出て `PerformanceServerTiming` からも読める。ブラウザが実際に
 * 解釈することは e2e（e2e/server-timing.spec.ts）が実ブラウザで固定する。
 * ここでは全 return 経路に載っていることを固定する — `supabaseResponse` は
 * cookie 書き込みのたびに再代入されるため、載せ忘れが起きやすい。
 */
describe("proxy: Server-Timing（体感の遅さを次回は測れるようにする）", () => {
  it("通常応答に auth と db の内訳が載る", async () => {
    getClaims.mockResolvedValue(validClaims)
    const res = await proxy(request("/baby"))
    const timing = res.headers.get("Server-Timing")
    expect(timing).toMatch(/auth;dur=[\d.]+/)
    expect(timing).toMatch(/db;dur=[\d.]+/)
  })

  it("未認証の /login redirect にも載る（307 が遅い場合も測れる）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("Server-Timing")).toMatch(/auth;dur=[\d.]+/)
  })

  it("未認証は DB を引かぬゆえ db は載らない（測っていないものを載せない）", async () => {
    getClaims.mockResolvedValue({ data: null, error: null })
    const res = await proxy(request("/login"))
    const timing = res.headers.get("Server-Timing")
    expect(timing).toMatch(/auth;dur=/)
    expect(timing).not.toMatch(/db;dur=/)
  })

  it("未承認の /pending-approval redirect にも載る", async () => {
    getClaims.mockResolvedValue(validClaims)
    profileSingle.mockResolvedValue({ data: { is_approved: false }, error: null })
    const res = await proxy(request("/baby"))
    expect(res.status).toBe(307)
    expect(res.headers.get("Server-Timing")).toMatch(/db;dur=/)
  })

  it("承認済みが /login に来た時の / redirect にも載る", async () => {
    getClaims.mockResolvedValue(validClaims)
    const res = await proxy(request("/login"))
    expect(res.status).toBe(307)
    expect(res.headers.get("Server-Timing")).toMatch(/db;dur=/)
  })
})
