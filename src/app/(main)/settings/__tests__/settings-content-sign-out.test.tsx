/**
 * I-02: 圏外でログアウトを叩いたときの SettingsContent の挙動を固定する。
 *
 * `handleSignOut` は startTransition 内で `purgeHouseholdCaches()` → `signOut()`
 * を await する。未処理の reject は最寄りの error boundary へ bubble し
 * (node_modules/next/dist/docs/01-app/01-getting-started/10-error-handling.md:375)、
 * さらに `setIsSigningOut(true)` を戻さないとボタンが永久 disabled になる。
 *
 * `signOut()` は成功時 `redirect("/login")` を throw するため、catch は
 * **先頭で `unstable_rethrow(err)`** を呼ばねばならない。順序が崩れると
 * 「ログアウトボタンが無反応」という無音の破壊になる（setup-form.test.tsx と同型）。
 * 「redirect の内部エラーを実際に再送出する」半分は
 * src/lib/__tests__/rethrow-contract.test.ts が実物で検証済み。
 *
 * ## LAST_USER_ID を消してよいのは「破棄を確かめた」かつ「signOut が成功した」時だけ（F2）
 * かつては破棄の直後・signOut の**前**に消しておった。圏外で signOut が reject すると
 * 鍵だけが消え、利用者 A はログインしたまま使い続け、SW は A の世帯の HTML / RSC を
 * 再び保存する。その後 B が同じ端末でログインすると、CacheUserGuard は前の ID が
 * 無い（＝初回）と見て破棄せず、A の世帯のスナップショットが B のオフライン閲覧で読める。
 *
 * signOut の成功は**クライアントでは reject として届く**: Server Action の
 * `redirect("/login")` は、action の promise を redirect エラーで reject する
 * （node_modules/next/dist/client/components/router-reducer/reducers/server-action-reducer.js
 *  の `if (redirectLocation !== undefined)` 節）。ゆえに成功は「unstable_rethrow が
 * 投げ返す＝フレームワークの信号」で見分ける。ここでは unstable_rethrow の mock を
 * 番兵（REDIRECT）にだけ投げ返させて、その現実を再現する。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Component, type ReactNode } from "react"
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react"

const signOut = vi.fn()
const purgeHouseholdCaches = vi.fn().mockResolvedValue(true)
const setCacheOwner = vi.fn<(userId: string) => Promise<boolean>>()
const clearCacheOwner = vi.fn<() => Promise<boolean>>()

// 実物と同じ鍵名（CacheUserGuard との組み合わせを同じ鍵で確かめるため）
const LAST_USER_ID_KEY = "irori-last-user-id"

vi.mock("@/app/(main)/settings/actions", () => ({
  signOut: (...args: unknown[]) => signOut(...args),
}))
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: (...args: unknown[]) => purgeHouseholdCaches(...args),
  setCacheOwner: (userId: string) => setCacheOwner(userId),
  clearCacheOwner: () => clearCacheOwner(),
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
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

// 子カードは各々 server action を呼ぶため無効化する（検証対象はログアウト経路のみ）
vi.mock("@/components/settings/profile-card", () => ({ ProfileCard: () => null }))
vi.mock("@/components/settings/invite-card", () => ({ InviteCard: () => null }))
vi.mock("@/components/settings/approval-card", () => ({ ApprovalCard: () => null }))
vi.mock("@/components/settings/default-page-card", () => ({
  DefaultPageCard: () => null,
}))
vi.mock("@/components/settings/baby-profile-card", () => ({
  BabyProfileCard: () => null,
}))
vi.mock("@/components/settings/export-card", () => ({ ExportCard: () => null }))
vi.mock("@/components/settings/theme-card", () => ({ ThemeCard: () => null }))
vi.mock("@/components/settings/help-card", () => ({ HelpCard: () => null }))

import { SettingsContent } from "../settings-content"
import { CacheUserGuard } from "@/components/common/cache-user-guard"
import { unstable_rethrow } from "next/navigation"
import { toast } from "sonner"

const mockedRethrow = vi.mocked(unstable_rethrow)
const mockedToast = vi.mocked(toast)

/** signOut 成功時にクライアントへ届く redirect エラーの番兵 */
const REDIRECT = new Error("NEXT_REDIRECT;replace;/login;307;")

/** 再送出されたフレームワークの信号を受ける（Next では RedirectBoundary の役） */
let caughtByBoundary: unknown = null
class SignalBoundary extends Component<{ children: ReactNode }, { caught: boolean }> {
  state = { caught: false }
  static getDerivedStateFromError() {
    return { caught: true }
  }
  componentDidCatch(error: unknown) {
    caughtByBoundary = error
  }
  render() {
    return this.state.caught ? <p>redirected</p> : this.props.children
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks は mockResolvedValueOnce の待ち行列を消さぬ。先に落ちたテストの残りが
  // 次のテストへ漏れて無関係に赤くならぬよう、Once を積む mock は個別に reset する
  signOut.mockReset()
  purgeHouseholdCaches.mockReset()
  purgeHouseholdCaches.mockResolvedValue(true)
  setCacheOwner.mockReset()
  setCacheOwner.mockResolvedValue(true)
  clearCacheOwner.mockReset()
  clearCacheOwner.mockResolvedValue(true)
  localStorage.clear()
  caughtByBoundary = null
  // 本物の unstable_rethrow はフレームワークの信号だけを投げ返す
  mockedRethrow.mockImplementation((err: unknown) => {
    if (err === REDIRECT) throw err
  })
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const SIGN_OUT_FAILED_MESSAGE =
  "ログアウトできませんでした。電波の良い場所でもう一度お試しください"

function renderSettings() {
  render(
    <SignalBoundary>
    <SettingsContent
      profile={{
        id: "u1",
        displayName: "テスト",
        avatarUrl: null,
        role: "owner",
        defaultPage: "baby",
      }}
      household={{ id: "h1", name: "我が家" }}
      email="test@example.com"
      isAppOperator={false}
      pendingUsers={[]}
      babyProfile={{ name: null, birthDate: null, feedingIntervalMin: 180 }}
      googleConnections={[]}
      googleNotice={null}
      pushDevices={[]}
      pushHealth={{
        runState: "healthy",
        ranAtLabel: "3分前",
        failedCount: 0,
        deliveryState: "sent",
        lastSentLabel: "1時間前",
      }}
      digestTime={null}
      digestTimeUnknown={false}
    />
    </SignalBoundary>,
  )
  return screen.getByRole("button", { name: "ログアウト" })
}

describe("SettingsContent の通信断 reject 握り（I-02）", () => {
  it("signOut が reject → ログアウトできなかったと伝え、ボタンが再び押せる", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    const button = renderSettings()

    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(SIGN_OUT_FAILED_MESSAGE),
    )
    expect(button).not.toBeDisabled()
    // 握り潰さず構造化ログへ残す
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("[settings-content]"),
      expect.objectContaining({ message: "network down" }),
    )
  })

  it("catch は toast より先に unstable_rethrow を呼ぶ（redirect を握り潰さない）", async () => {
    signOut.mockRejectedValueOnce(new Error("network down"))
    fireEvent.click(renderSettings())

    await waitFor(() => expect(mockedRethrow).toHaveBeenCalledTimes(1))
    expect(mockedRethrow.mock.invocationCallOrder[0]).toBeLessThan(
      mockedToast.error.mock.invocationCallOrder[0],
    )
  })

  it("purgeHouseholdCaches が reject しても握られる（signOut 前段の失敗）", async () => {
    purgeHouseholdCaches.mockRejectedValueOnce(new Error("sw unreachable"))
    const button = renderSettings()

    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(SIGN_OUT_FAILED_MESSAGE),
    )
    expect(signOut).not.toHaveBeenCalled()
    expect(button).not.toBeDisabled()
  })
})

describe("SettingsContent の LAST_USER_ID（破棄の確認 + signOut の成功の後にだけ消す・F2 / P2-24）", () => {
  it("signOut が成功（redirect）し破棄も確かめられたら、鍵を消してから redirect を再送出する", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    signOut.mockRejectedValueOnce(REDIRECT)
    fireEvent.click(renderSettings())

    // redirect は握り潰さずフレームワークへ返す（ここでは boundary が受ける）
    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBeNull()
    expect(mockedToast.error).not.toHaveBeenCalled()
    // 成功の後に持ち主の記録を改めて消す（往復の間に別タブの guard が書き戻しておりうる。
    // 成功の redirect は SPA 遷移で SW の /login 経路を通らぬ — 独立レビュー r4）
    expect(clearCacheOwner).toHaveBeenCalledTimes(1)
  })

  it("⭐ signOut が通信断で失敗したら鍵を残す（利用者は同じまま・CacheUserGuard の安全網を消さぬ）", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    signOut.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(renderSettings())

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalled(),
    )
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBe("u1")
    // 失敗では持ち主の記録を消さぬ（利用者は同じまま。通信断は戻す側）
    expect(clearCacheOwner).not.toHaveBeenCalled()
  })

  it("破棄を確かめられねば、signOut が成功しても鍵を残す（次の利用者の guard に破棄を試み直させる）", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    purgeHouseholdCaches.mockResolvedValueOnce(false)
    signOut.mockRejectedValueOnce(REDIRECT)
    fireEvent.click(renderSettings())

    // ログアウト自体は止めぬ（順序: 購読解除 → 破棄 → signOut は保つ）
    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
    expect(signOut).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBe("u1")
  })

  it("破棄は signOut より前に行う（redirect の後は実行の保証が無い）", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    signOut.mockRejectedValueOnce(REDIRECT)
    fireEvent.click(renderSettings())

    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
    expect(purgeHouseholdCaches.mock.invocationCallOrder[0]).toBeLessThan(
      signOut.mock.invocationCallOrder[0],
    )
  })

  /**
   * PR #235 敵対レビュー P2: signOut は失敗を `{ error }` で返す（成功は redirect = reject で
   * 届く）。かつての「redirect せずに解決した = 成功」は、失敗したログアウトで鍵と端末の
   * 計測を消し、利用者 A がログインしたまま CacheUserGuard の安全網を外していた。
   */
  it("⭐ signOut が失敗結果（{ error }）で解決したら、鍵も端末の計測も消さず、ボタンを戻して理由を伝える", async () => {
    const TIMER_KEY = "irori:feeding-timer"
    const SAVED_TIMER = JSON.stringify({
      startedAt: "2026-10-21T03:00:00.000Z",
      feedingType: "breast_left",
      userId: "u1",
    })
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    localStorage.setItem(TIMER_KEY, SAVED_TIMER)
    signOut.mockResolvedValueOnce({
      error: "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください",
    })
    const button = renderSettings()
    fireEvent.click(button)

    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalledWith(
        "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください",
      ),
    )
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBe("u1")
    expect(localStorage.getItem(TIMER_KEY)).toBe(SAVED_TIMER)
    // 成功の後処理（redirect の再送出）へは進まぬ
    expect(caughtByBoundary).toBeNull()
    // 世帯キャッシュの持ち主は戻さぬ: auth-js は失効に失敗した時も端末のセッションを消して
    // から error を返す。戻すと、実質ログアウト済みの端末で残った項目が再び配られる
    expect(setCacheOwner).not.toHaveBeenCalled()
  })

  it("signOut が通信断で reject した時（セッションは残る）は、世帯キャッシュの持ち主を今の利用者へ戻す", async () => {
    signOut.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(renderSettings())
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(SIGN_OUT_FAILED_MESSAGE))
    expect(setCacheOwner).toHaveBeenCalledWith("u1")
  })

  it("対照: signOut が成功（redirect）した時は持ち主を戻さぬ（ログアウトした利用者のまま保存させぬ）", async () => {
    signOut.mockRejectedValueOnce(REDIRECT)
    fireEvent.click(renderSettings())
    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
    expect(setCacheOwner).not.toHaveBeenCalled()
  })

  it("失敗結果の後は押し直せ、2 回目が成功（redirect）すれば鍵を消す", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    signOut
      .mockResolvedValueOnce({
        error: "ログアウトを完了できませんでした。電波の良い場所でもう一度お試しください",
      })
      .mockRejectedValueOnce(REDIRECT)
    const button = renderSettings()
    fireEvent.click(button)
    await waitFor(() => expect(mockedToast.error).toHaveBeenCalled())
    await waitFor(() => expect(button).not.toBeDisabled())
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBe("u1")

    fireEvent.click(button)
    await waitFor(() => expect(caughtByBoundary).toBe(REDIRECT))
    expect(signOut).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(LAST_USER_ID_KEY)).toBeNull()
  })

  /**
   * 組み合わせの不変条件: ログアウトに失敗した A の端末で、後から B がログインしても
   * A の世帯キャッシュは B に読めぬ。鍵が A のまま残るゆえ、B の (main) で CacheUserGuard が
   * 持ち主の交代を検知して破棄する（鍵が消えておれば「初回」と見て破棄せなんだ）。
   */
  it("ログアウトに失敗した後で別の利用者がログインしても、CacheUserGuard が破棄する", async () => {
    localStorage.setItem(LAST_USER_ID_KEY, "u1")
    signOut.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    fireEvent.click(renderSettings())
    await waitFor(() =>
      expect(mockedToast.error).toHaveBeenCalled(),
    )
    cleanup()
    purgeHouseholdCaches.mockClear()

    // A のセッションが後で失効し、同じ端末で B がログインして (main) に入る
    render(<CacheUserGuard userId="u2" />)

    await waitFor(() => expect(localStorage.getItem(LAST_USER_ID_KEY)).toBe("u2"))
    expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1)
  })
})
