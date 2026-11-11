/**
 * ごみ（/chores/garbage）の page と loading。
 * - 世帯は認証の文脈から取る（クエリ文字列等から受けぬ）
 * - 文脈が無ければ何も描かぬ（遷移は (main)/layout が受ける）・読み取りも走らせぬ
 * - 読めなんだ時は「登録されていません」と描かぬ
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"

const { getAuthContext, loadGarbagePage } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  loadGarbagePage: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("@/lib/supabase/garbage-overview-query", () => ({ loadGarbagePage }))
vi.mock("@/app/(main)/chores/garbage/actions", () => ({ submitGarbageRequest: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

import GarbagePage from "../page"
import GarbageLoading from "../loading"
import type { GarbagePageData } from "@/lib/supabase/garbage-overview-query"
import { todayJstString } from "@/lib/utils/date-jst"

const SUPABASE = { marker: "supabase" }
const CONTEXT = {
  supabase: SUPABASE,
  userId: "a6000000-0000-4000-8000-000000000001",
  householdId: "a6000000-0000-4000-8000-0000000000aa",
}

function data(patch: Partial<GarbagePageData> = {}): GarbagePageData {
  return {
    today: todayJstString(),
    windowDays: 62,
    purposes: "ok",
    events: "ok",
    overview: { collections: [], moreCollections: 0, entries: [] },
    reminders: { status: "ok", byEventKey: {} },
    ...patch,
  }
}

async function renderPage() {
  const element = await GarbagePage()
  render(element)
  // 端末の控えの読み込み（microtask）を流す
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  getAuthContext.mockResolvedValue({ error: null, reason: null, context: CONTEXT })
  loadGarbagePage.mockResolvedValue(data())
})
afterEach(cleanup)

describe("ごみ（/chores/garbage）", () => {
  it("認証の文脈の世帯と、JST の今日で読む", async () => {
    await renderPage()
    expect(loadGarbagePage).toHaveBeenCalledTimes(1)
    expect(loadGarbagePage).toHaveBeenCalledWith(SUPABASE, CONTEXT.householdId, todayJstString())
  })

  it("見出し・家事への戻り・未登録の案内（カレンダーへの導線）を描く", async () => {
    await renderPage()
    expect(screen.getByRole("heading", { level: 1, name: "ごみ" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "家事" })).toHaveAttribute("href", "/chores")
    expect(screen.getByText("ごみの日はまだ登録されていません")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "カレンダーで予定を作る" })).toHaveAttribute("href", "/calendar")
  })

  it("分類を読めなんだ時は「登録されていません」と描かぬ", async () => {
    loadGarbagePage.mockResolvedValue(data({ purposes: "failed" }))
    await renderPage()
    expect(screen.queryByText("ごみの日はまだ登録されていません")).toBeNull()
    expect(screen.getByRole("alert")).toHaveTextContent("ごみの分類を読み込めませんでした")
  })

  it("認証の文脈が無ければ何も描かず、読み取りも走らせぬ", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await GarbagePage()).toBeNull()
    expect(loadGarbagePage).not.toHaveBeenCalled()
  })

  it("絵文字を使わぬ", async () => {
    await renderPage()
    expect(document.body.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
  })

  it("loading はページと同じ外枠で、読み込み中と伝える", () => {
    const { container } = render(<GarbageLoading />)
    const status = screen.getByRole("status", { name: "読み込み中" })
    expect(status).toHaveAttribute("aria-busy", "true")
    expect(container.firstElementChild?.className).toContain("flex flex-col gap-6 px-4 pt-12 pb-8")
  })
})
