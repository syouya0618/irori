/**
 * /pending-approval の世帯キャッシュ破棄は「承認待ちとサーバが確かめた時だけ」（F1 / F3 / REG-05）。
 *
 * ## 直した欠陥
 * PendingContent はマウントのたびに無条件で世帯キャッシュ（documents / rsc）を破棄して
 * おった。前提は「承認待ちの利用者は世帯を持たぬ → ここで見える世帯キャッシュは必ず前の
 * 利用者のもの」じゃが、proxy は profiles の取得が**一過性に失敗した**時も
 * `profile?.is_approved ?? false` で承認済みの世帯員をここへ 307 する。その瞬間に
 * 本人のオフライン用スナップショットが消え、直後に圏外になると /baby が /offline になる。
 *
 * ## 固定する契約
 * page（Server Component）が profiles を読み直し、**読めて**・`is_approved === false`・
 * `household_id === null` の時だけ破棄を許す。読めぬ・承認済み・世帯あり は破棄せぬ。
 * 読めぬ時は「承認待ち」と断定せず、確認を促す（画面は使えるまま）。
 *
 * 「破棄せぬ」を見る assert は、effect を流し切ってから行う（流す前に見れば、破棄する
 * 実装でも緑になる）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup, act, waitFor } from "@testing-library/react"

type DbError = { message: string; code?: string } | null
let profileResult: {
  data: { is_approved: boolean; household_id: string | null } | null
  error: DbError
} = { data: null, error: null }
const selectedColumns = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`想定外のテーブル: ${table}`)
      return {
        select: (cols: string) => {
          selectedColumns(cols)
          return {
            eq: () => ({
              single: async () => profileResult,
            }),
          }
        },
      }
    },
  }),
}))

const getVerifiedUserId = vi.fn<() => Promise<string | null>>()
vi.mock("@/lib/supabase/verified-user", () => ({
  getVerifiedUserId: () => getVerifiedUserId(),
}))

vi.mock("../actions", () => ({ signOut: vi.fn() }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  unstable_rethrow: vi.fn(),
}))
vi.mock("sonner", async () => {
  const { vi: viMod } = await import("vitest")
  return { toast: { error: viMod.fn(), success: viMod.fn() } }
})

const purgeHouseholdCaches = vi.fn<() => Promise<boolean>>()
vi.mock("@/lib/pwa/sw-messages", () => ({
  purgeHouseholdCaches: () => purgeHouseholdCaches(),
  clearCacheOwner: () => Promise.resolve(true),
  LAST_USER_ID_STORAGE_KEY: "irori-last-user-id",
}))

import PendingApprovalPage from "../page"

async function renderPage() {
  render(await PendingApprovalPage())
  // 破棄の effect を流し切る（「呼ばれぬ」を偽緑にせぬ）
  await act(async () => {})
}

beforeEach(() => {
  vi.clearAllMocks()
  purgeHouseholdCaches.mockResolvedValue(true)
  getVerifiedUserId.mockResolvedValue("user-1")
  profileResult = { data: { is_approved: false, household_id: null }, error: null }
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("/pending-approval: 世帯キャッシュ破棄の条件（F1 / F3 / REG-05）", () => {
  it("承認待ちで世帯なしと確かめられたら破棄する", async () => {
    await renderPage()
    await waitFor(() => expect(purgeHouseholdCaches).toHaveBeenCalledTimes(1))
    expect(screen.getByRole("heading", { name: "承認待ち" })).toBeInTheDocument()
    // 判定に要る 2 列を同じ 1 往復で読む
    expect(selectedColumns).toHaveBeenCalledWith(
      expect.stringMatching(/is_approved.*household_id|household_id.*is_approved/),
    )
  })

  it("profiles を読めなんだら破棄せず、エラーを構造化ログへ残す", async () => {
    profileResult = {
      data: null,
      error: { message: "upstream timeout", code: "57014" },
    }
    await renderPage()

    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
    expect(console.error).toHaveBeenCalledWith(
      "[pending-approval] profile lookup failed",
      expect.objectContaining({ userId: "user-1", message: "upstream timeout" }),
    )
  })

  it("profiles を読めなんだら「承認待ち」と断定せず、確認を促す（画面は使えるまま）", async () => {
    profileResult = { data: null, error: { message: "upstream timeout" } }
    await renderPage()

    expect(screen.queryByRole("heading", { name: "承認待ち" })).toBeNull()
    expect(
      screen.getByRole("heading", { name: "承認状態を確認できませんでした" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /承認状態を確認/ })).toBeEnabled()
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeEnabled()
  })

  it("承認済み（proxy の取得失敗でここへ来た）なら破棄せぬ", async () => {
    profileResult = {
      data: { is_approved: true, household_id: "household-1" },
      error: null,
    }
    await renderPage()

    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
    expect(screen.queryByRole("heading", { name: "承認待ち" })).toBeNull()
  })

  it("承認待ちでも世帯を持つ（承認の取り消し等）なら破棄せぬ — キャッシュは本人の世帯のものかもしれぬ", async () => {
    profileResult = {
      data: { is_approved: false, household_id: "household-1" },
      error: null,
    }
    await renderPage()

    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
    // 承認されていないこと自体は確かめられておる
    expect(screen.getByRole("heading", { name: "承認待ち" })).toBeInTheDocument()
  })

  it("本人を確かめられねば破棄せぬ（profiles も引かぬ）", async () => {
    getVerifiedUserId.mockResolvedValue(null)
    await renderPage()

    expect(purgeHouseholdCaches).not.toHaveBeenCalled()
    expect(selectedColumns).not.toHaveBeenCalled()
  })
})
