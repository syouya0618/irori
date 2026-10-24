/**
 * I-02: 圏外でログアウトを叩いたときの PendingContent の挙動を固定する。
 *
 * `handleSignOut` は startTransition ではなく **プレーンな async onClick** ゆえ、
 * reject は error boundary へ bubble せず無言の unhandled rejection になる（機序が別）。
 * さらに `setIsSigningOut(true)` を戻さないとボタンが永久 disabled になる
 * （setup-form.test.tsx と同型の「永久ローディング」）。
 *
 * `signOut()` は成功時 `redirect("/login")` を throw するため、catch は
 * **先頭で `unstable_rethrow(err)`** を呼ばねばならない。順序が崩れると
 * 「ログアウトボタンが無反応」という無音の破壊になる。
 * ここでは (1) 通常 reject の握り (2) catch 先頭が unstable_rethrow であること
 * を固定する。「redirect の内部エラーを実際に再送出する」半分は
 * src/lib/__tests__/rethrow-contract.test.ts が実物で検証済み。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"
import { readFileSync } from "node:fs"
import path from "node:path"

const signOut = vi.fn()
vi.mock("../actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}))

// unstable_rethrow は「呼ばれたか・いつ呼ばれたか」を見るため spy 化する
// （実物の throw 挙動は rethrow-contract.test.ts が担保）。
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  unstable_rethrow: vi.fn(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

const purgeHouseholdCaches = vi.fn<() => Promise<boolean>>()
const clearCacheOwner = vi.fn<() => Promise<boolean>>().mockResolvedValue(true)
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: () => purgeHouseholdCaches(),
  clearCacheOwner: () => clearCacheOwner(),
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
}))

import { PendingContent } from "../pending-content"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"
import { act } from "@testing-library/react"

const mockedRethrow = vi.mocked(unstable_rethrow)
const mockedToast = vi.mocked(toast)

/** page.tsx が「承認待ち・世帯なし」と確かめた時に渡す props */
const CONFIRMED_PENDING = {
  approvalStatus: "pending",
  allowCachePurge: true,
} as const

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks は mockResolvedValueOnce の待ち行列を消さぬ（先に落ちたテストの残りが漏れる）
  signOut.mockReset()
  purgeHouseholdCaches.mockReset()
  purgeHouseholdCaches.mockResolvedValue(true)
  localStorage.clear()
})
afterEach(cleanup)

/**
 * P2-26 / P1-02: 承認待ちの案内を新しい承認モデルの事実に合わせる。
 *
 * - 承認するのは**このアプリの管理者（運用者）**で、承認されると自分の世帯を作れるだけ
 * - 家族の世帯へ入る道は**招待リンク**（招待の受諾は承認を待たずに通る ——
 *   proxy は未承認でも /invite/ を通し、accept_invitation が承認を付ける）
 * かつての「承認されると自動的にアプリをご利用いただけます」は、配偶者の承認を
 * 待てば同じ世帯に入れるかのように読め、世帯が二つに割れる誘因じゃった。
 */
describe("PendingContent の案内（P2-26）", () => {
  it("見出しは「承認待ち」のまま（e2e approval-gate が名前で掴む）", () => {
    render(<PendingContent {...CONFIRMED_PENDING} />)
    expect(screen.getByRole("heading", { name: "承認待ち" })).toBeInTheDocument()
  })

  it("承認するのは管理者で、家族の世帯へは招待リンクで入ると書く", () => {
    const { container } = render(<PendingContent {...CONFIRMED_PENDING} />)
    const text = container.textContent ?? ""

    expect(text).toContain("このアプリの管理者")
    expect(text).toContain("自分の世帯")
    expect(text).toContain("招待リンク")
    // 承認を待てば家族の世帯に入れるかのような旧文言は使わぬ
    expect(text).not.toContain("自動的にアプリをご利用いただけます")
  })
})

/**
 * P2-24: 承認待ち・世帯なしと**サーバが確かめた**利用者なら、ここで見える世帯キャッシュは
 * 前の利用者のものじゃ。CacheUserGuard は (main) にしか居らぬため、前の利用者の
 * ログアウトで破棄が空振りしておれば、/offline →「育児ページへ」の経路で前の世帯の
 * 記録が読めてしまう。ここでも破棄を試みる。
 *
 * ただし proxy は profiles の一過性の取得失敗でも承認済みの世帯員をここへ送る
 * （F1 / F3 / REG-05）。破棄してよいかは page.tsx が決め、ここは従うだけ。
 */
describe("PendingContent の世帯キャッシュ破棄（P2-24）", () => {
  it("破棄を許された時は表示時に世帯キャッシュの破棄を試みる", async () => {
    render(<PendingContent {...CONFIRMED_PENDING} />)
    await waitFor(() => expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1))
  })

  it("破棄を許されねば試みぬ（承認状態を確かめられなんだ時・本人の世帯かもしれぬ時）", async () => {
    render(<PendingContent approvalStatus="pending" allowCachePurge={false} />)
    // effect を流し切ってから見る（流す前なら破棄する実装でも緑になる）
    await act(async () => {})
    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
  })

  it("承認状態を確かめられねば「承認待ち」と断定せぬ", async () => {
    render(<PendingContent approvalStatus="unconfirmed" allowCachePurge={false} />)
    await act(async () => {})
    expect(screen.queryByRole("heading", { name: "承認待ち" })).toBeNull()
    expect(
      screen.getByRole("heading", { name: "承認状態を確認できませんでした" }),
    ).toBeInTheDocument()
    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
  })

  it("LAST_USER_ID には触れぬ（鍵の持ち主は (main) の CacheUserGuard）", async () => {
    localStorage.setItem("irori-last-user-id", "user-a")
    render(<PendingContent {...CONFIRMED_PENDING} />)
    await waitFor(() => expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem("irori-last-user-id")).toBe("user-a")
  })
})

const OFFLINE_MESSAGE = "通信できませんでした。電波の良い場所でもう一度お試しください"

describe("PendingContent の通信断 reject 握り（I-02）", () => {
  it("signOut が reject → 圏外トースト + ログアウトボタンが再び押せる", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    render(<PendingContent {...CONFIRMED_PENDING} />)

    const button = screen.getByRole("button", { name: "ログアウト" })
    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE),
    )
    expect(button).not.toBeDisabled()
  })

  it("catch は toast より先に unstable_rethrow を呼ぶ（redirect を握り潰さない）", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    render(<PendingContent {...CONFIRMED_PENDING} />)

    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }))

    await waitFor(() => expect(mockedRethrow).toHaveBeenCalledTimes(1))
    expect(mockedRethrow.mock.invocationCallOrder[0]).toBeLessThan(
      mockedToast.error.mock.invocationCallOrder[0],
    )
  })
})

/**
 * P3-08 / レビュー P3-9: 端末に残る授乳タイマーを消すのは signOut が**成功した時だけ**。
 * 承認済みの世帯員も profiles の一過性の取得失敗でこの画面へ送られうる（F1 / F3）ゆえ、
 * 圏外でログアウトに失敗した時に消すと、ログインしたまま計測だけを失う。
 */
describe("PendingContent のログアウトと授乳タイマーの端末保存", () => {
  const TIMER_KEY = "irori:feeding-timer"
  const SAVED = JSON.stringify({
    startedAt: "2026-10-19T03:00:00.000Z",
    feedingType: "breast_left",
    userId: "u1",
  })

  it("signOut が本物の失敗（圏外）で reject した時は計測を消さぬ", async () => {
    localStorage.setItem(TIMER_KEY, SAVED)
    signOut.mockRejectedValueOnce(new Error("network down"))
    render(<PendingContent {...CONFIRMED_PENDING} />)

    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }))
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(OFFLINE_MESSAGE))

    expect(localStorage.getItem(TIMER_KEY)).toBe(SAVED)
  })

  /**
   * PR #235 敵対レビュー P2: signOut は失敗を `{ error }` で返す（成功は redirect = reject で
   * 届く）。かつての「redirect せずに解決した = 成功」は、失敗したログアウトで計測を消していた。
   */
  it("⭐ 失敗結果（{ error }）で解決した時は計測を消さず、ボタンを戻して理由を伝える", async () => {
    localStorage.setItem(TIMER_KEY, SAVED)
    signOut.mockResolvedValueOnce({
      error: "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください",
    })
    render(<PendingContent {...CONFIRMED_PENDING} />)

    const button = screen.getByRole("button", { name: "ログアウト" })
    fireEvent.click(button)
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください",
      ),
    )
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(localStorage.getItem(TIMER_KEY)).toBe(SAVED)
    // 失敗では世帯キャッシュの持ち主の記録にも触れぬ（消すのは成功の時だけ・独立レビュー r4）
    expect(clearCacheOwner).not.toHaveBeenCalled()
  })

  it("redirect（成功の信号）を再送出する経路でも計測を消す — 構造を固定する", () => {
    // unstable_rethrow が投げ返す（＝成功）時だけ消してから返す。settings-content と同じ形。
    // イベントハンドラの再送出は test では unhandled rejection になるため、source で縛る
    const source = readFileSync(path.join(__dirname, "../pending-content.tsx"), "utf8")
    const start = source.indexOf("unstable_rethrow(err)")
    const end = source.indexOf("throw frameworkSignal")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(source.slice(start, end)).toContain("clearPersistedTimer()")
    // 失敗経路（throw の後）には消す呼び出しが無い
    expect(source.slice(end)).not.toContain("clearPersistedTimer()")
  })
})
