/**
 * CacheUserGuard（P2-24）—— 共用端末で持ち主が替わった時の後段の安全網。
 *
 * 固定する契約:
 *   1. 前の利用者と違えば世帯キャッシュを破棄し、鍵を今の利用者へ書き換える
 *   2. 同じ利用者なら破棄せぬ（毎回捨てればオフライン閲覧が死ぬ）
 *   3. **破棄を確かめられねば前の ID を残す** —— 書き換えてしまえば、次のマウントでは
 *      「同じ利用者」に見えて二度と破棄を試みぬ。前の世帯の HTML / RSC が居座る
 *   4. 世帯キャッシュの持ち主を今の利用者へ書く（PR #235 P2）。**破棄の成否に従属させぬ** —
 *      破棄に失敗した時こそ要る（SW は持ち主のタグが合う項目しか配らぬ）。破棄の後に書く
 *      （破棄は持ち主を先に消すゆえ、順が逆だと書いた持ち主が消える）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, cleanup, waitFor, act } from "@testing-library/react"

const purgeHouseholdCaches = vi.fn<() => Promise<boolean>>()
const setCacheOwner = vi.fn<(userId: string) => Promise<boolean>>()
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: () => purgeHouseholdCaches(),
  setCacheOwner: (userId: string) => setCacheOwner(userId),
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
}))

import { CacheUserGuard } from "../cache-user-guard"

const KEY = "irori-last-user-id"

beforeEach(() => {
  localStorage.clear()
  purgeHouseholdCaches.mockReset()
  setCacheOwner.mockReset()
  setCacheOwner.mockResolvedValue(true)
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("CacheUserGuard", () => {
  it("前の利用者と違えば破棄し、鍵を今の利用者へ書き換える", async () => {
    localStorage.setItem(KEY, "user-a")
    purgeHouseholdCaches.mockResolvedValue(true)

    render(<CacheUserGuard userId="user-b" householdId="h1" />)

    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("user-b"))
    expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1)
  })

  it("同じ利用者なら破棄せぬ（対照）", async () => {
    localStorage.setItem(KEY, "user-a")
    purgeHouseholdCaches.mockResolvedValue(true)

    render(<CacheUserGuard userId="user-a" householdId="h1" />)

    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("user-a"))
    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
  })

  it("初回（前の ID 無し）は破棄せず、鍵だけを置く", async () => {
    purgeHouseholdCaches.mockResolvedValue(true)

    render(<CacheUserGuard userId="user-a" householdId="h1" />)

    await waitFor(() => expect(localStorage.getItem(KEY)).toBe("user-a"))
    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
  })

  it("破棄を確かめられねば前の ID を残す（次のマウントで再び破棄を試みる）", async () => {
    localStorage.setItem(KEY, "user-a")
    let resolvePurge: (ok: boolean) => void = () => {}
    purgeHouseholdCaches.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePurge = resolve
        }),
    )

    render(<CacheUserGuard userId="user-b" householdId="h1" />)

    await waitFor(() => expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1))
    // 破棄の結果が出た**後**の状態を見る（resolve 前に読んで偽緑にせぬ）
    await act(async () => {
      resolvePurge(false)
    })
    expect(localStorage.getItem(KEY)).toBe("user-a")
  })

  it("持ち主は利用者が同じでも初回でも、マウントのたびに今の利用者へ書く", async () => {
    purgeHouseholdCaches.mockResolvedValue(true)
    localStorage.setItem(KEY, "user-a")
    render(<CacheUserGuard userId="user-a" householdId="h1" />)
    await waitFor(() => expect(setCacheOwner).toHaveBeenCalledWith("user-a"))
    cleanup()

    localStorage.clear()
    render(<CacheUserGuard userId="user-c" householdId="h1" />)
    await waitFor(() => expect(setCacheOwner).toHaveBeenCalledWith("user-c"))
  })

  it("持ち主の交代では、破棄の**後**に今の利用者を持ち主として書く（破棄は持ち主を先に消す）", async () => {
    localStorage.setItem(KEY, "user-a")
    purgeHouseholdCaches.mockResolvedValue(true)
    render(<CacheUserGuard userId="user-b" householdId="h1" />)
    await waitFor(() => expect(setCacheOwner).toHaveBeenCalledWith("user-b"))
    expect(purgeHouseholdCaches.mock.invocationCallOrder[0]).toBeLessThan(
      setCacheOwner.mock.invocationCallOrder[0],
    )
  })

  it("⭐ 破棄を確かめられなくても、持ち主は今の利用者へ書く（前の ID は残す）", async () => {
    localStorage.setItem(KEY, "user-a")
    purgeHouseholdCaches.mockResolvedValue(false)
    render(<CacheUserGuard userId="user-b" householdId="h1" />)
    await waitFor(() => expect(setCacheOwner).toHaveBeenCalledWith("user-b"))
    // 破棄の再試行のため鍵は前の利用者のまま
    expect(localStorage.getItem(KEY)).toBe("user-a")
  })

  it("破棄の途中で (main) を離れた（ログアウト等）なら、持ち主を書き戻さぬ", async () => {
    localStorage.setItem(KEY, "user-a")
    let resolvePurge: (ok: boolean) => void = () => {}
    purgeHouseholdCaches.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvePurge = resolve
        }),
    )
    const view = render(<CacheUserGuard userId="user-b" householdId="h1" />)
    await waitFor(() => expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1))
    view.unmount()
    await act(async () => {
      resolvePurge(true)
    })
    expect(setCacheOwner).not.toHaveBeenCalled()
  })
})
