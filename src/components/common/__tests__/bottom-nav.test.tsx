/**
 * BottomNav の契約。
 *
 * - 3 タブが link として在り、タブ名が accessible name（アイコンは装飾）
 * - 現在地は `aria-current="page"` で示し、下位ページ（/baby/search 等）でも親タブが現在地
 * - 現在地の印は**色だけに頼らぬ**（アイコン裏の帯 `bg-primary/12`）。夜間の一瞥・色弱でも分かる
 * - 高さは globals.css の `--bottom-nav-h` を見る。(main) layout の `pb-nav` と同じ変数ゆえ、
 *   片方だけ変えて中身がナビの下に隠れる事故を構造で防ぐ（layout.test.tsx が対になる）
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"

let pathname = "/baby"
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
}))

import { BottomNav } from "../bottom-nav"

afterEach(() => {
  cleanup()
})

function activeLinks() {
  return screen
    .getAllByRole("link")
    .filter((a) => a.getAttribute("aria-current") === "page")
    .map((a) => a.textContent?.trim())
}

describe("BottomNav: 3 タブと accessible name", () => {
  it("育児 / 予定 / 設定 の 3 本が link で、nav に名前がある", () => {
    pathname = "/baby"
    render(<BottomNav />)
    expect(screen.getByRole("navigation", { name: "メインナビゲーション" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "育児" })).toHaveAttribute("href", "/baby")
    expect(screen.getByRole("link", { name: "予定" })).toHaveAttribute("href", "/calendar")
    expect(screen.getByRole("link", { name: "設定" })).toHaveAttribute("href", "/settings")
  })

  it("アイコンは装飾（aria-hidden）で、名前に混ざらぬ", () => {
    pathname = "/baby"
    const { container } = render(<BottomNav />)
    const icons = container.querySelectorAll("svg")
    expect(icons).toHaveLength(3)
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true")
  })
})

describe("BottomNav: 現在地", () => {
  it("/baby では 育児 だけが現在地", () => {
    pathname = "/baby"
    render(<BottomNav />)
    expect(activeLinks()).toEqual(["育児"])
  })

  it("下位ページ（/baby/search）でも 育児 が現在地", () => {
    pathname = "/baby/search"
    render(<BottomNav />)
    expect(activeLinks()).toEqual(["育児"])
  })

  it("/calendar では 予定 だけが現在地（対照: 育児は外れる）", () => {
    pathname = "/calendar"
    render(<BottomNav />)
    expect(activeLinks()).toEqual(["予定"])
  })

  it("現在地は帯と太さでも示す（色だけに頼らぬ）。非現在地には帯が無い", () => {
    pathname = "/calendar"
    render(<BottomNav />)
    const active = screen.getByRole("link", { name: "予定" })
    const inactive = screen.getByRole("link", { name: "育児" })
    const band = (link: HTMLElement) => link.querySelector("span")!
    const label = (link: HTMLElement) => link.querySelector("span:last-child")!
    expect(band(active).className).toContain("bg-primary/15")
    expect(band(inactive).className).not.toContain("bg-primary/15")
    expect(label(active).className).toContain("font-semibold")
    expect(label(inactive).className).not.toContain("font-semibold")
    expect(active.querySelector("svg")).toHaveAttribute("stroke-width", "2.5")
    expect(inactive.querySelector("svg")).toHaveAttribute("stroke-width", "2")
  })
})

describe("BottomNav: キーボードの輪郭", () => {
  /**
   * Tailwind v4 の `outline-none` は `--tw-outline-style: none` を立て、
   * `focus-visible:outline-2` はその変数を読む。同居させると focus 中も輪郭が none に
   * 解決し、Tab でどのタブに居るか見えぬ（独立レビューで見つかった退行・WCAG 2.4.7）。
   * className の検査ゆえ CSS の解決までは証明せぬ。描画は静的描画の Playwright で
   * `outlineStyle !== "none"` を確かめた（受け入れ記録）。
   */
  it("focus-visible の輪郭を持ち、outline-none / outline-hidden を同居させぬ", () => {
    pathname = "/baby"
    render(<BottomNav />)
    for (const link of screen.getAllByRole("link")) {
      expect(link.className).toMatch(/focus-visible:outline-2/)
      expect(link.className).not.toMatch(/\boutline-none\b|\boutline-hidden\b/)
    }
  })
})

describe("BottomNav: 殻との寸法契約", () => {
  it("高さは --bottom-nav-h を見る（layout の pb-nav と同じ変数）", () => {
    pathname = "/baby"
    render(<BottomNav />)
    const nav = screen.getByRole("navigation")
    expect(nav.className).toContain("safe-bottom")
    const row = nav.firstElementChild as HTMLElement
    expect(row.className).toContain("h-(--bottom-nav-h)")
  })
})
