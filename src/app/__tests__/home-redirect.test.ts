/**
 * `/`（`src/app/page.tsx`）＝ 起動時ページ振り分けの**二層目**の回帰テスト。
 *
 * ## なぜ単体で撃つ必要があるか
 *
 * 一層目の `src/proxy.ts` が承認済み利用者を `/` の描画前に `/${page}` へ
 * 307 するようになったため、**平常時この経路は走らぬ**。走らぬコードは腐る。
 *
 * それでも消せぬのは、proxy が Next の規約ファイルだからじゃ —— 置き場所を一段
 * 間違えるだけで build も lint も型検査も緑のまま黙って無効化されうる。その時
 * `/` はここへ素通しされ、ここが無ければ「起動時のページ」設定は**再び死ぬ**
 * （それが `#219` で塞いだ穴そのもの）。
 *
 * ゆえに実経路の観測に頼らず、ここで機械的に撃ち続ける。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { DEFAULT_PAGE, VALID_PAGES } from "@/lib/constants/pages"

/** redirect() は本物同様「そこで打ち切る」ため throw で表現する */
class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}

const getVerifiedUserId = vi.fn()
const profileSingle = vi.fn()

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: () => profileSingle() }) }),
    }),
  }),
}))

vi.mock("@/lib/supabase/verified-user", () => ({
  getVerifiedUserId: (...args: unknown[]) => getVerifiedUserId(...args),
}))

import Home from "../page"

/** Home() を呼び、redirect 先を返す（redirect せねば失敗させる） */
async function redirectTargetOf(): Promise<string> {
  try {
    await Home()
  } catch (e) {
    if (e instanceof RedirectSignal) return e.to
    throw e
  }
  throw new Error("redirect せずに戻った（振り分けが機能しておらぬ）")
}

beforeEach(() => {
  getVerifiedUserId.mockReset()
  profileSingle.mockReset()
  getVerifiedUserId.mockResolvedValue("user-1")
  profileSingle.mockResolvedValue({
    data: { default_page: "meals" },
    error: null,
  })
})

describe("/ の振り分け（proxy が inert でも設定が効くこと）", () => {
  it.each(VALID_PAGES)("default_page=%s なら /%s へ送る", async (page) => {
    profileSingle.mockResolvedValue({
      data: { default_page: page },
      error: null,
    })
    expect(await redirectTargetOf()).toBe(`/${page}`)
  })

  it.each([
    ["NULL", null],
    ["未知の値", "dashboard"],
  ])("default_page が %s なら既定へ倒す", async (_label, value) => {
    profileSingle.mockResolvedValue({
      data: { default_page: value },
      error: null,
    })
    expect(await redirectTargetOf()).toBe(`/${DEFAULT_PAGE}`)
  })

  it("未認証は /login へ（DB を引く前に倒す）", async () => {
    getVerifiedUserId.mockResolvedValue(null)
    expect(await redirectTargetOf()).toBe("/login")
    expect(profileSingle).not.toHaveBeenCalled()
  })

  it("profiles が引けなくても既定へ倒して起動を止めない", async () => {
    profileSingle.mockResolvedValue({ data: null, error: { message: "boom" } })
    expect(await redirectTargetOf()).toBe(`/${DEFAULT_PAGE}`)
  })
})
