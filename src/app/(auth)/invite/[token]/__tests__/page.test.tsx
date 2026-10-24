/**
 * 招待ページの分岐と文言（P2-26 / F2 / UX-04）。
 *
 * ## 直した欠陥
 * 世帯を持つ利用者には、招待先の世帯を**見ずに**「別の世帯に参加済みのため、この
 * 招待は使えません（参加する世帯はあとから移れません）」を出しておった。招待を受けて
 * 世帯に入った配偶者が、別の端末やチャットの履歴から**同じ招待リンク**を開き直すと、
 * 自分の世帯なのに「別の世帯に入って元に戻せない」と読める。P2-26 が防ごうとした
 * 「世帯が割れた」という誤解を逆方向から生む。
 *
 * ## 固定する分岐（上から順に評価する）
 *   1. 世帯あり・招待先と同じ世帯 → 「この世帯にはすでに参加しています」+ /baby への導線
 *      （開き直したリンクは普通「使用済み」ゆえ、期限切れ・使用済みより**先**に見る）
 *   2. 世帯あり・招待先が別の世帯 → 「別の世帯に参加済み」
 *   3. 世帯あり・招待が引けぬ → 中立の「すでに世帯に参加しています」（別の／移れぬ と断定せぬ）
 *   4. 世帯なし → 従来どおり 無効 / 期限切れ / 使用済み / 参加フォーム
 * どの分岐も「退出」を案内せぬ（退出の機能は無い・P2-26）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

type Row = Record<string, unknown> | null
type DbError = { message: string; code?: string } | null

let profileResult: { data: Row; error: DbError } = { data: null, error: null }
let invitationsResult: { data: Row[] | null; error: DbError } = {
  data: [],
  error: null,
}
const rpc = vi.fn()

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`想定外のテーブル: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            single: async () => profileResult,
          }),
        }),
      }
    },
    rpc: async (...args: unknown[]) => {
      rpc(...args)
      return invitationsResult
    },
  }),
}))

const getVerifiedUserId = vi.fn<() => Promise<string | null>>()
vi.mock("@/lib/supabase/verified-user", () => ({
  getVerifiedUserId: () => getVerifiedUserId(),
}))

// 本物の redirect は throw して以降の実行を止める。テストでも同じ制御フローにする。
class RedirectSignal extends Error {
  constructor(public to: string) {
    super(`NEXT_REDIRECT:${to}`)
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to)
  },
}))

// 参加フォームは server action を呼ぶ client component ゆえ印だけ置く。
vi.mock("../invite-accept-form", () => ({
  InviteAcceptForm: ({ invitationId }: { invitationId: string }) => (
    <div data-testid="invite-accept-form" data-invitation-id={invitationId} />
  ),
}))

import InvitePage from "../page"

const HOUSEHOLD_A = "household-a"
const HOUSEHOLD_B = "household-b"
const FUTURE = "2999-01-01T00:00:00.000Z"
const PAST = "2000-01-01T00:00:00.000Z"

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    household_id: HOUSEHOLD_A,
    household_name: "田中家",
    role: "member",
    status: "pending",
    expires_at: FUTURE,
    ...overrides,
  }
}

async function renderPage() {
  const { container } = render(
    await InvitePage({ params: Promise.resolve({ token: "tok" }) }),
  )
  return container.textContent ?? ""
}

beforeEach(() => {
  rpc.mockReset()
  getVerifiedUserId.mockReset()
  getVerifiedUserId.mockResolvedValue("user-1")
  profileResult = { data: { household_id: null }, error: null }
  invitationsResult = { data: [invitation()], error: null }
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("世帯に参加済みの利用者（F2 / UX-04）", () => {
  it("招待先と同じ世帯なら「この世帯にはすでに参加しています」と /baby への導線を出す", async () => {
    profileResult = { data: { household_id: HOUSEHOLD_A }, error: null }
    // 開き直したリンクは普通「使用済み」— それでも使用済みの案内より先に出す
    invitationsResult = {
      data: [invitation({ household_id: HOUSEHOLD_A, status: "accepted" })],
      error: null,
    }

    const text = await renderPage()

    expect(
      screen.getByRole("heading", { name: "この世帯にはすでに参加しています" }),
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /育児ページへ/ })).toHaveAttribute(
      "href",
      "/baby",
    )
    // 本丸: 自分の世帯を「別の世帯」「移れません」と案内せぬ
    expect(text).not.toContain("別の世帯")
    expect(text).not.toContain("移れません")
    expect(text).not.toContain("使用済み")
    expect(text).not.toContain("退出")
    expect(screen.queryByTestId("invite-accept-form")).toBeNull()
  })

  it("期限切れのリンクでも、同じ世帯なら参加済みの案内を出す", async () => {
    profileResult = { data: { household_id: HOUSEHOLD_A }, error: null }
    invitationsResult = {
      data: [invitation({ household_id: HOUSEHOLD_A, expires_at: PAST })],
      error: null,
    }

    const text = await renderPage()

    expect(text).toContain("この世帯にはすでに参加しています")
    expect(text).not.toContain("有効期限")
  })

  it("対照: 招待先が別の世帯なら「別の世帯に参加済み」と出す", async () => {
    profileResult = { data: { household_id: HOUSEHOLD_B }, error: null }
    invitationsResult = {
      data: [invitation({ household_id: HOUSEHOLD_A })],
      error: null,
    }

    const text = await renderPage()

    expect(
      screen.getByRole("heading", { name: "すでに世帯に参加しています" }),
    ).toBeInTheDocument()
    expect(text).toContain("別の世帯に参加済み")
    expect(text).not.toContain("この世帯にはすでに参加しています")
    expect(text).not.toContain("退出")
    expect(screen.queryByTestId("invite-accept-form")).toBeNull()
  })

  it("招待が引けぬ（無効なリンク・取得失敗）なら、別の／移れぬ と断定せぬ中立の案内", async () => {
    profileResult = { data: { household_id: HOUSEHOLD_B }, error: null }
    invitationsResult = { data: [], error: null }

    const text = await renderPage()

    expect(
      screen.getByRole("heading", { name: "すでに世帯に参加しています" }),
    ).toBeInTheDocument()
    expect(text).not.toContain("別の世帯")
    expect(text).not.toContain("移れません")
    expect(text).not.toContain("退出")
    expect(screen.queryByTestId("invite-accept-form")).toBeNull()
  })

  it("招待の取得がエラーでも中立の案内に倒し、エラーはログへ残す", async () => {
    profileResult = { data: { household_id: HOUSEHOLD_B }, error: null }
    invitationsResult = { data: null, error: { message: "timeout", code: "57014" } }

    const text = await renderPage()

    expect(text).toContain("すでに世帯に参加しています")
    expect(text).not.toContain("別の世帯")
    expect(console.error).toHaveBeenCalledWith(
      "[invite] invitation lookup failed",
      expect.objectContaining({ userId: "user-1", message: "timeout" }),
    )
  })
})

describe("世帯の無い利用者（既存の分岐を壊していない）", () => {
  it("有効な招待なら参加フォームを出す", async () => {
    const text = await renderPage()
    expect(screen.getByTestId("invite-accept-form")).toHaveAttribute(
      "data-invitation-id",
      "inv-1",
    )
    expect(text).not.toContain("退出")
  })

  it("招待が引けねば「無効な招待リンク」", async () => {
    invitationsResult = { data: [], error: null }
    const text = await renderPage()
    expect(text).toContain("無効な招待リンク")
    expect(text).not.toContain("すでに世帯に参加しています")
  })

  it("期限切れは「招待の有効期限切れ」", async () => {
    invitationsResult = { data: [invitation({ expires_at: PAST })], error: null }
    expect(await renderPage()).toContain("招待の有効期限切れ")
  })

  it("使用済みは「この招待は使用済みです」", async () => {
    invitationsResult = { data: [invitation({ status: "accepted" })], error: null }
    expect(await renderPage()).toContain("この招待は使用済みです")
  })

  it("未認証は returnTo 付きで /login へ", async () => {
    getVerifiedUserId.mockResolvedValue(null)
    await expect(
      InvitePage({ params: Promise.resolve({ token: "tok" }) }),
    ).rejects.toMatchObject({ to: "/login?returnTo=/invite/tok" })
  })
})
