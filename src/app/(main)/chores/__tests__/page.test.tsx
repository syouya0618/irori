/**
 * 家事ハブ（/chores）: ごみ・掃除・ごはんへの入口 3 つと、それぞれの「今日の要約」。
 *
 * - 入口は要約の成否に依らず常に出る（どれか 1 つの取得失敗でハブ全体を倒さぬ）
 * - 読めなんだ枠だけ「読み込めませんでした」。ほかの枠はそのまま出す（「ありません」と言い換えぬ）
 * - 世帯は認証の文脈から渡す（クライアントの入力を使わぬ）
 *
 * 要約の文の組み立ては `src/lib/domain/__tests__/chores-hub.test.ts`、読み取りの枠ごとの分離は
 * `src/lib/supabase/__tests__/chores-hub-query.test.ts` が持つ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import { Trash2 } from "lucide-react"

const { getAuthContext, loadChoresHubSummary, refresh } = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  loadChoresHubSummary: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext }))
vi.mock("@/lib/supabase/chores-hub-query", () => ({ loadChoresHubSummary }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))

import ChoresPage from "../page"
import ChoresLoading from "@/components/common/loading/chores-loading"
import { ChoresHubCard } from "@/components/chores/chores-hub-card"
import { CHORES_HUB_FAILED_TEXT, failedHubLine, type ChoresHubSummary } from "@/lib/domain/chores-hub"

const SUPABASE = { marker: "server-client" }
const CONTEXT = { supabase: SUPABASE, userId: "user-1", householdId: "house-1" }

const OK: ChoresHubSummary = {
  garbage: { status: "ok", text: "次の収集日は明日 11月12日（木）、プラスチックです。" },
  cleaning: { status: "ok", text: "今日 1件・今週のこり 2件・期限超過 0件" },
  meals: { status: "ok", text: "今夜: 鶏の照り焼き（確定）・まだ買うもの 3件" },
}

function summaryOf(name: RegExp): HTMLElement {
  const slot = screen.getByRole("link", { name }).querySelector<HTMLElement>('[data-slot="chores-hub-summary"]')
  if (!slot) throw new Error("要約の枠が無い")
  return slot
}

beforeEach(() => {
  getAuthContext.mockReset()
  getAuthContext.mockResolvedValue({ error: null, reason: null, context: CONTEXT })
  loadChoresHubSummary.mockReset()
  loadChoresHubSummary.mockResolvedValue(OK)
  refresh.mockReset()
  vi.useFakeTimers({ toFake: ["Date"] })
  // JST では 2026-11-11 の 08:30（UTC では前日 23:30）。UTC の日付を使えば 11-10 になる
  vi.setSystemTime(new Date("2026-11-10T23:30:00Z"))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("家事ハブ", () => {
  it("h1「家事」と、ごみ・掃除・ごはんへの行リンクを持つ", async () => {
    render(await ChoresPage())
    expect(screen.getByRole("heading", { level: 1, name: "家事" })).toBeInTheDocument()
    const nav = screen.getByRole("navigation", { name: "家事の機能" })
    const links = screen.getAllByRole("link")
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/chores/garbage", "/chores/cleaning", "/chores/meals"])
    for (const link of links) {
      expect(nav).toContainElement(link)
      // glass カード・44px 以上・遷移は色だけ・輪郭あり
      expect(link.className).toMatch(/\bglass\b/)
      expect(link.className).toMatch(/\brounded-2xl\b/)
      expect(link.className).toMatch(/\bmin-h-11\b/)
      expect(link.className).toContain("transition-colors duration-200")
      expect(link.className).not.toMatch(/transition-all|\boutline-none\b/)
      expect(link.className).toMatch(/focus-visible:outline-2/)
      // アイコンは装飾
      for (const icon of link.querySelectorAll("svg")) expect(icon).toHaveAttribute("aria-hidden", "true")
      // カード全体がリンクゆえ、中に操作できる要素を入れ子にせぬ
      expect(link.querySelector("button, a, input, [role='button']")).toBeNull()
    }
    expect(screen.getByRole("link", { name: /^ごみ/ })).toHaveTextContent("次の収集日")
    expect(screen.getByRole("link", { name: /^掃除/ })).toHaveTextContent("今日・今週やること")
    expect(screen.getByRole("link", { name: /^ごはん/ })).toHaveTextContent("買い物リスト")
  })

  it("3 枠の今日の要約を、それぞれのカードの中に出す", async () => {
    render(await ChoresPage())
    expect(summaryOf(/^ごみ/)).toHaveTextContent("次の収集日は明日 11月12日（木）、プラスチックです。")
    expect(summaryOf(/^掃除/)).toHaveTextContent("今日 1件・今週のこり 2件・期限超過 0件")
    expect(summaryOf(/^ごはん/)).toHaveTextContent("今夜: 鶏の照り焼き（確定）・まだ買うもの 3件")
    // 正常な枠は失敗の表示を持たぬ
    expect(document.querySelectorAll('[data-state="failed"]')).toHaveLength(0)
    expect(document.body).not.toHaveTextContent("読み込めませんでした")
  })

  it.each([
    ["garbage", /^ごみ/],
    ["cleaning", /^掃除/],
    ["meals", /^ごはん/],
  ] as const)("%s の取得だけが失敗しても、その枠だけ「読み込めませんでした」にし、ほかの枠と入口は保つ", async (part, name) => {
    loadChoresHubSummary.mockResolvedValue({ ...OK, [part]: failedHubLine(part) })
    render(await ChoresPage())

    // 入口は 3 つとも残る
    expect(screen.getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual([
      "/chores/garbage",
      "/chores/cleaning",
      "/chores/meals",
    ])
    // 失敗の表示は 1 つだけで、その枠の中に在る（色だけでなくアイコンと文で示す）
    const failed = document.querySelectorAll('[data-state="failed"]')
    expect(failed).toHaveLength(1)
    expect(summaryOf(name)).toContainElement(failed[0] as HTMLElement)
    expect(summaryOf(name)).toHaveTextContent(CHORES_HUB_FAILED_TEXT[part])
    expect(failed[0].querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    // 失敗を「ありません」「0 件」「未定」と言い換えぬ
    expect(summaryOf(name).textContent ?? "").not.toMatch(/ありません|0件|未定/)

    // ほかの 2 枠は読めた内容のまま
    for (const other of ["garbage", "cleaning", "meals"] as const) {
      if (other === part) continue
      const otherName = other === "garbage" ? /^ごみ/ : other === "cleaning" ? /^掃除/ : /^ごはん/
      const line = OK[other]
      expect(summaryOf(otherName)).toHaveTextContent(line.text)
    }
  })

  it("3 枠すべてが失敗しても、見出しと 3 つの入口は出る（throw せぬ）", async () => {
    loadChoresHubSummary.mockResolvedValue({
      garbage: failedHubLine("garbage"),
      cleaning: failedHubLine("cleaning"),
      meals: failedHubLine("meals"),
    })
    render(await ChoresPage())
    expect(screen.getByRole("heading", { level: 1, name: "家事" })).toBeInTheDocument()
    expect(screen.getAllByRole("link")).toHaveLength(3)
    expect(document.querySelectorAll('[data-state="failed"]')).toHaveLength(3)
  })

  it("読めた枠の注記（表示できない行の件数）を、その枠の中に出す。対照: 注記の無い枠には出さぬ", async () => {
    loadChoresHubSummary.mockResolvedValue({
      ...OK,
      cleaning: { status: "ok", text: "今日 1件・今週のこり 0件・期限超過 0件", note: "表示できない項目が2件あります。" },
    })
    render(await ChoresPage())
    expect(summaryOf(/^掃除/)).toHaveTextContent("表示できない項目が2件あります。")
    expect(summaryOf(/^ごみ/)).not.toHaveTextContent("表示できない")
    expect(summaryOf(/^ごはん/)).not.toHaveTextContent("表示できない")
  })

  it("要約は認証の文脈の世帯と JST の今日で読む（1 回だけ）", async () => {
    render(await ChoresPage())
    expect(loadChoresHubSummary).toHaveBeenCalledTimes(1)
    // UTC の日付（2026-11-10）ではなく JST の暦日
    expect(loadChoresHubSummary).toHaveBeenCalledWith(SUPABASE, "house-1", "2026-11-11")
  })

  it("認証の文脈が無ければ何も描かず、要約も読まぬ（遷移は (main)/layout が受ける）", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    expect(await ChoresPage()).toBeNull()
    expect(loadChoresHubSummary).not.toHaveBeenCalled()
  })

  it("ほかの端末の変更の反映タイミングを文で示し、取り直しの釦はカードの外に置く", async () => {
    render(await ChoresPage())
    expect(screen.getByText(/ほかの端末での変更は、この画面に戻ったときに反映されます/)).toBeInTheDocument()
    const button = screen.getByRole("button", { name: "今すぐ更新" })
    expect(screen.getByRole("navigation", { name: "家事の機能" })).not.toContainElement(button)
    button.click()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("絵文字を使わぬ", async () => {
    const { container } = render(await ChoresPage())
    expect(container.textContent ?? "").not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

describe("ChoresHubCard", () => {
  it("要約を渡すとカードの中に出し、リンクの名前に含まれる", () => {
    render(
      <ChoresHubCard
        href="/chores/garbage"
        icon={Trash2}
        title="ごみ"
        description="次の収集日と種別"
        summary="明日は燃えるごみ"
      />,
    )
    const link = screen.getByRole("link", { name: /ごみ.*明日は燃えるごみ/ })
    expect(link).toHaveAttribute("href", "/chores/garbage")
    expect(link.querySelector('[data-slot="chores-hub-summary"]')).toHaveTextContent("明日は燃えるごみ")
  })

  it("対照: 要約を渡さねば枠ごと出さぬ", () => {
    const { container } = render(
      <ChoresHubCard href="/chores/garbage" icon={Trash2} title="ごみ" description="次の収集日と種別" />,
    )
    expect(container.querySelector('[data-slot="chores-hub-summary"]')).toBeNull()
  })
})

describe("家事の骨組み", () => {
  it("ページと同じ外枠で、育児の骨組みではない目印を持つ", () => {
    const { container } = render(<ChoresLoading />)
    const root = container.firstElementChild as HTMLElement
    expect(root).toHaveAttribute("data-skeleton", "chores")
    expect(root.className).toBe("flex flex-col gap-6 px-4 pt-12 pb-8")
  })
})
