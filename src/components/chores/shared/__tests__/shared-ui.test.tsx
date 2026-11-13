/**
 * 家事の共有 UI（見出し・チェック・切替・空・取得失敗・再取得）の最小契約。
 * 見た目の実寸（44px）は e2e/touch-targets.spec.ts が実ブラウザで測る。ここは役割・名前・
 * 状態の伝え方と、規約のクラスが付いておること（対照つき）を見る。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Trash2 } from "lucide-react"

let pathname = "/chores/meals"
const refresh = vi.fn()
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ refresh }),
}))

import { CheckButton } from "../check-button"
import { ChoresHeader } from "../chores-header"
import { EmptyState } from "../empty-state"
import { REFRESH_POLL_MIN_MS, RefreshOnVisible } from "../refresh-on-visible"
import { SectionError } from "../section-error"
import { SegmentLinks, activeSegmentHref } from "../segment-links"

beforeEach(() => {
  vi.resetAllMocks()
  pathname = "/chores/meals"
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("ChoresHeader", () => {
  it("h1 と、家事へ戻るリンク（44px の押下領域・輪郭あり）を持つ", () => {
    render(<ChoresHeader title="掃除" description="今日・今週やること" />)
    expect(screen.getByRole("heading", { level: 1, name: "掃除" })).toBeInTheDocument()
    const back = screen.getByRole("link", { name: "家事" })
    expect(back).toHaveAttribute("href", "/chores")
    expect(back.className).toContain("touch-target")
    expect(back.className).toMatch(/focus-visible:outline-2/)
    expect(back.className).not.toMatch(/\boutline-none\b|transition-all/)
    expect(screen.getByText("今日・今週やること")).toBeInTheDocument()
  })

  it("戻り先とラベルを差し替えられる（下位のさらに下位）", () => {
    render(<ChoresHeader title="レシピ" backHref="/chores/meals" backLabel="ごはん" />)
    expect(screen.getByRole("link", { name: "ごはん" })).toHaveAttribute("href", "/chores/meals")
  })
})

describe("CheckButton", () => {
  it("role=checkbox と aria-checked で状態を伝え、押すと反対の値を渡す", () => {
    const onChange = vi.fn()
    const view = render(<CheckButton checked={false} onCheckedChange={onChange} label="牛乳" />)
    const box = screen.getByRole("checkbox", { name: "牛乳" })
    expect(box).toHaveAttribute("aria-checked", "false")
    // 色だけで示さぬ: 未チェックには印（svg）が無い
    expect(box.querySelector("svg")).toBeNull()
    fireEvent.click(box)
    expect(onChange).toHaveBeenCalledWith(true)

    view.rerender(<CheckButton checked onCheckedChange={onChange} label="牛乳" />)
    expect(screen.getByRole("checkbox", { name: "牛乳" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("checkbox").querySelector("svg")).not.toBeNull()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).toHaveBeenLastCalledWith(false)
  })

  it("キーボードで届く button で、要素自体が 44px（size-11）。フォームを送信せぬ", () => {
    render(<CheckButton checked={false} onCheckedChange={() => {}} label="卵" />)
    const box = screen.getByRole("checkbox")
    expect(box.tagName).toBe("BUTTON")
    expect(box).toHaveAttribute("type", "button")
    expect(box.className).toMatch(/\bsize-11\b/)
    expect(box.className).toMatch(/focus-visible:outline-2/)
    expect(box.className).not.toMatch(/transition-all|\boutline-none\b/)
    expect(box).not.toHaveAttribute("tabindex", "-1")
    box.focus()
    expect(document.activeElement).toBe(box)
  })

  it("送信中・無効の間は押下を受けぬ", () => {
    const onChange = vi.fn()
    const view = render(<CheckButton checked={false} onCheckedChange={onChange} label="卵" busy />)
    const box = screen.getByRole("checkbox")
    expect(box).toBeDisabled()
    expect(box).toHaveAttribute("aria-busy", "true")
    fireEvent.click(box)
    view.rerender(<CheckButton checked={false} onCheckedChange={onChange} label="卵" disabled />)
    fireEvent.click(screen.getByRole("checkbox"))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("SegmentLinks", () => {
  const items = [
    { href: "/chores/meals", label: "今日" },
    { href: "/chores/meals/plan", label: "献立" },
    { href: "/chores/meals/shopping", label: "買い物" },
  ]

  it("現在地だけに aria-current=page を付け、segmentCn の塗りで示す", () => {
    pathname = "/chores/meals/plan"
    render(<SegmentLinks items={items} label="ごはんの画面" />)
    expect(screen.getByRole("navigation", { name: "ごはんの画面" })).toBeInTheDocument()
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page")
    expect(current.map((a) => a.textContent)).toEqual(["献立"])
    expect(current[0].className).toContain("bg-primary")
    expect(screen.getByRole("link", { name: "今日" }).className).not.toMatch(/(^|\s)bg-primary(\s|$)/)
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toMatch(/\bmin-h-11\b/)
      expect(link.className).not.toContain("transition-all")
    }
  })

  it("下位の下位（/chores/meals/plan/…）でも最も近い項目が現在地。親は現在地にせぬ", () => {
    expect(activeSegmentHref("/chores/meals/plan/2026-11-11", items)).toBe("/chores/meals/plan")
    expect(activeSegmentHref("/chores/meals", items)).toBe("/chores/meals")
    expect(activeSegmentHref("/chores/meals/recipes/abc", items)).toBe("/chores/meals")
  })

  it("対照: 接頭辞が似ただけの path・無関係な path はどれも現在地にせぬ", () => {
    expect(activeSegmentHref("/chores/mealsx", items)).toBeNull()
    expect(activeSegmentHref("/chores/cleaning", items)).toBeNull()
    pathname = "/chores/cleaning"
    render(<SegmentLinks items={items} label="ごはんの画面" />)
    expect(screen.getAllByRole("link").filter((a) => a.hasAttribute("aria-current"))).toEqual([])
  })
})

describe("EmptyState", () => {
  it("アイコンは装飾、文と次の操作を出す", () => {
    const { container } = render(
      <EmptyState icon={Trash2} title="ごみの予定はまだありません" description="予定をごみとして分類すると、ここに並びます。">
        <a href="/calendar">予定を作る</a>
      </EmptyState>,
    )
    expect(screen.getByText("ごみの予定はまだありません")).toBeInTheDocument()
    expect(screen.getByText(/ここに並びます/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "予定を作る" })).toBeInTheDocument()
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true")
    expect(container.firstElementChild?.className).toContain("glass")
  })
})

describe("SectionError", () => {
  it("「無いとは限らない」と伝え、既定では router.refresh で読み直す", () => {
    render(<SectionError what="買い物リスト" />)
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("買い物リストを読み込めませんでした。買い物リストがないとは限りません。")
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("onRetry を渡せばそちらを呼ぶ（router.refresh は呼ばぬ）", () => {
    const onRetry = vi.fn()
    render(<SectionError what="献立" onRetry={onRetry} />)
    fireEvent.click(screen.getByRole("button", { name: "もう一度読み込む" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })
})

describe("RefreshOnVisible", () => {
  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state })
  }

  it("画面へ戻ったときに router.refresh し、反映タイミングを文で示す", () => {
    setVisibility("visible")
    render(<RefreshOnVisible />)
    expect(screen.getByText("ほかの端末での変更は、この画面に戻ったときに反映されます。")).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
    document.dispatchEvent(new Event("visibilitychange"))
    expect(refresh).toHaveBeenCalledTimes(1)
    // 対照: 隠れておる間の合図では取り直さぬ
    setVisibility("hidden")
    document.dispatchEvent(new Event("visibilitychange"))
    expect(refresh).toHaveBeenCalledTimes(1)
    setVisibility("visible")
  })

  it("pollMs を渡すと表示中に定期で取り直し、間隔を文に出す（下限つき）", async () => {
    // 定期の取り直しは、サーバーへ届くことを確かめてから呼ぶ（R04。届かぬ時の対照は refresh-gate.test.tsx）
    const probe = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", probe)
    vi.useFakeTimers()
    setVisibility("visible")
    render(<RefreshOnVisible pollMs={30_000} />)
    expect(screen.getByText(/開いている間は約30秒ごとに反映されます/)).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(29_999))
    expect(refresh).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(probe).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    cleanup()
    refresh.mockClear()
    // 短すぎる指定は下限まで延ばす（Server の再描画を叩き続けぬ）
    render(<RefreshOnVisible pollMs={100} />)
    expect(screen.getByText(new RegExp(`約${REFRESH_POLL_MIN_MS / 1000}秒ごと`))).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_POLL_MIN_MS - 1))
    expect(refresh).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("「今すぐ更新」で手動でも取り直せる。showNote=false なら何も描かぬ", () => {
    const view = render(<RefreshOnVisible />)
    const button = screen.getByRole("button", { name: "今すぐ更新" })
    expect(button.className).toContain("touch-target")
    fireEvent.click(button)
    expect(refresh).toHaveBeenCalledTimes(1)
    view.unmount()
    const silent = render(<RefreshOnVisible showNote={false} />)
    expect(silent.container).toBeEmptyDOMElement()
  })
})
