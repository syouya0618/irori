/**
 * (main)/layout の遷移分岐の検証（I-16）。
 *
 * ## 直した欠陥
 * `getAuthContext` は profiles の lookup 失敗をログには残すが**分岐に使っておらず**、
 * 一過性の DB エラー（接続断・タイムアウト）が「世帯なし」と同じ経路に落ちていた。
 * 結果、**世帯が在るのに /setup（世帯作成画面）へ飛ばされる**。夫婦で使う世帯単位の
 * アプリで世帯を二重に作らせかねない導線じゃ。
 *
 * ## ここで固定する不変条件
 * 判定不能（lookup-failed）は**誘導に使わない**。redirect せず throw して
 * error boundary へ倒し、再試行ボタンで自己回復させる。
 *
 * ## throw を受けるのはどの error boundary か
 * `(main)/error.tsx` **ではなく** `app/error.tsx` じゃ。Next 公式 docs 原文
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md:96):
 *   "In the component hierarchy, `error.js` wraps `loading.js`, `not-found.js`,
 *    `page.js`, and nested `layout.js` files in a React error boundary.
 *    It does **not** wrap the `layout.js` or `template.js` above it in the same segment."
 * 同一セグメントの error.tsx は自分の layout の throw を捕まえられぬため、
 * 一段上（app/error.tsx）が受ける。どちらも再試行 (`unstable_retry`) を持つ。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getAuthContext = vi.fn()
const redirect = vi.fn()

vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

// 本物の redirect は throw して以降の実行を止める。テストでも同じ制御フローに
// せねば「redirect の後も処理が続く」現実には無い状態を検証してしまう。
class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`)
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirect(to)
    throw new RedirectSignal(to)
  },
}))

// 描画対象ではないため軽い stub に置き換える（分岐だけを見る）。
vi.mock("@/components/common/bottom-nav", () => ({ BottomNav: () => null }))
vi.mock("@/components/common/cache-user-guard", () => ({
  CacheUserGuard: () => null,
}))
vi.mock("@/components/common/onboarding-tour", () => ({
  OnboardingTour: () => null,
}))

import MainLayout from "../layout"

beforeEach(() => {
  getAuthContext.mockReset()
  redirect.mockReset()
})

function call() {
  return MainLayout({ children: null })
}

describe("(main)/layout: lookup 失敗を「世帯なし」と混同しない", () => {
  it("lookup-failed では /setup へ飛ばさない（世帯の二重作成を防ぐ）", async () => {
    getAuthContext.mockResolvedValue({
      error: "プロフィールの取得に失敗しました",
      reason: "lookup-failed",
      context: null,
    })

    await expect(call()).rejects.toThrow("プロフィールの取得に失敗しました")

    // 本丸: どこへも redirect しない
    expect(redirect).not.toHaveBeenCalled()
  })

  it("lookup-failed の throw は redirect シグナルではない（error boundary が受ける）", async () => {
    getAuthContext.mockResolvedValue({
      error: "プロフィールの取得に失敗しました",
      reason: "lookup-failed",
      context: null,
    })

    // redirect() の throw と区別できること。区別できねば「error boundary へ倒す」
    // という意図が成立しない。
    await expect(call()).rejects.not.toBeInstanceOf(RedirectSignal)
  })
})

describe("(main)/layout: 既存の遷移分岐を壊していない", () => {
  it("世帯なしは従来どおり /setup へ", async () => {
    getAuthContext.mockResolvedValue({
      error: "世帯が設定されていません",
      reason: "no-household",
      context: null,
    })
    await expect(call()).rejects.toBeInstanceOf(RedirectSignal)
    expect(redirect).toHaveBeenCalledWith("/setup")
  })

  it("未承認は /pending-approval へ（proxy の分岐と一致）", async () => {
    getAuthContext.mockResolvedValue({
      error: "承認待ちです",
      reason: "not-approved",
      context: null,
    })
    await expect(call()).rejects.toBeInstanceOf(RedirectSignal)
    expect(redirect).toHaveBeenCalledWith("/pending-approval")
  })

  it("未認証は /login へ", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    await expect(call()).rejects.toBeInstanceOf(RedirectSignal)
    expect(redirect).toHaveBeenCalledWith("/login")
  })

  it("正常時は redirect も throw もしない", async () => {
    getAuthContext.mockResolvedValue({
      error: null,
      reason: null,
      context: { supabase: {}, userId: "user-1", householdId: "house-1" },
    })
    await expect(call()).resolves.toBeTruthy()
    expect(redirect).not.toHaveBeenCalled()
  })
})
