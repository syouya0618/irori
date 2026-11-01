import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { NewsRefresh } from "../news-refresh"
import { refreshNews } from "@/app/(main)/news/actions"
const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/app/(main)/news/actions", () => ({ refreshNews: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
it.each([
  ["updated", "配信元の確認が終わりました"],
  ["partial", "一部の配信元を取得できませんでした"],
  ["failed", "配信元を取得できませんでした"],
  ["cooldown", "取得中、または直前に確認済みです"],
] as const)("shows %s without claiming delivery", async (status, message) => {
  vi.mocked(refreshNews).mockResolvedValue({ status, fetched: 0 })
  render(<NewsRefresh />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "配信元から記事を更新" })))
  expect(screen.getByRole("status")).toHaveTextContent(message)
  expect(refresh).toHaveBeenCalledOnce()
})
it("keeps a lost response uncertain", async () => {
  vi.mocked(refreshNews).mockRejectedValue(new Error("synthetic disconnect"))
  render(<NewsRefresh />)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "配信元から記事を更新" })))
  expect(screen.getByRole("status")).toHaveTextContent("取得結果を確認できませんでした")
})
