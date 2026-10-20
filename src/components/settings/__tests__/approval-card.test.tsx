/**
 * 承認カード（P2-26 / P1-02）。
 *
 * 承認は**インスタンスへの入場許可**であって、自分の世帯への参加ではない。承認された人は
 * /setup で**自分の世帯を新しく作る**ことになり、一度世帯に入ると退出も移籍もできぬ。
 * 「承認待ち」とだけ書けば、運用者は家族を世帯へ迎える操作だと読み、夫婦の世帯が
 * 二つに割れる。ゆえに事実と、家族を迎える正しい道（招待リンク）を書いておく。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}))
vi.mock("@/app/(main)/settings/actions", () => ({ approveUser: vi.fn() }))

import { ApprovalCard, type PendingUser } from "../approval-card"

const PENDING: PendingUser = {
  id: "p1",
  display_name: "しんき",
  email: "new@example.com",
  created_at: "2026-10-01T00:00:00.000Z",
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe("ApprovalCard の文言（P2-26）", () => {
  it("承認しても自分の世帯には入らぬこと、家族は招待リンクで迎えることを書く", () => {
    render(<ApprovalCard pendingUsers={[PENDING]} />)

    expect(screen.getByText(/自分の世帯を新しく作れる/)).toBeInTheDocument()
    expect(screen.getByText(/あなたの世帯には追加されません/)).toBeInTheDocument()
    expect(screen.getByText(/招待リンク/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "承認" })).toBeInTheDocument()
  })
})

describe("ApprovalCard — 一覧を読めなかった時", () => {
  it("「0 件」と偽らず失敗を示し、承認ボタンを出さぬ", () => {
    render(<ApprovalCard pendingUsers={null} />)

    expect(screen.getByRole("alert")).toHaveTextContent("取得できませんでした")
    expect(screen.queryByRole("button", { name: "承認" })).toBeNull()
  })
})
