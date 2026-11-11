/**
 * (main) layout の Suspense fallback（MainLoading）が、path に合う骨組みを出す。
 * 家事（/chores とその下位）で育児の骨組み（日付ナビ・クイック記録）を出さぬ。
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

let pathname: string | null = "/baby"
vi.mock("next/navigation", () => ({ usePathname: () => pathname }))
vi.mock("../loading/baby-loading", () => ({ default: () => <div data-skeleton="baby" /> }))
vi.mock("../loading/calendar-loading", () => ({ default: () => <div data-skeleton="calendar" /> }))
vi.mock("../loading/settings-loading", () => ({ default: () => <div data-skeleton="settings" /> }))

import { MainLoading } from "../main-loading"

afterEach(cleanup)

function skeletonAt(path: string | null): string | null | undefined {
  pathname = path
  const { container } = render(<MainLoading />)
  const kind = container.querySelector("[data-skeleton]")?.getAttribute("data-skeleton")
  cleanup()
  return kind
}

describe("MainLoading", () => {
  it("読み込み中であることを名前つきの status で伝える", () => {
    pathname = "/chores"
    render(<MainLoading />)
    const status = screen.getByRole("status", { name: "読み込み中" })
    expect(status).toHaveAttribute("aria-busy", "true")
  })

  it.each(["/chores", "/chores/garbage", "/chores/cleaning", "/chores/meals", "/chores/meals/shopping"])(
    "%s は家事の骨組み（実物）。育児の骨組みを出さぬ",
    (path) => {
      expect(skeletonAt(path)).toBe("chores")
    },
  )

  it("既存の画面は従来どおり（育児 / 予定 / 設定）", () => {
    expect(skeletonAt("/baby")).toBe("baby")
    expect(skeletonAt("/baby/search")).toBe("baby")
    expect(skeletonAt("/calendar")).toBe("calendar")
    expect(skeletonAt("/settings")).toBe("settings")
    expect(skeletonAt("/news")).toBe("baby")
    expect(skeletonAt(null)).toBe("baby")
  })

  it("対照: 接頭辞が似ただけの path（/choresx）は家事の骨組みにせぬ", () => {
    expect(skeletonAt("/choresx")).toBe("baby")
  })
})
