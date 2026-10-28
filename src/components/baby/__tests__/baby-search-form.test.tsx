import { describe, it, expect, afterEach } from "vitest"
import { render, screen, cleanup } from "@testing-library/react"
import { BabySearchForm } from "../baby-search-form"

afterEach(cleanup)

const TODAY = "2026-10-19"

describe("BabySearchForm（記録を探す条件・GET フォーム）", () => {
  it("条件があれば「条件をクリア」を Link として描き、<a> に type=\"button\" を付けぬ", () => {
    render(
      <BabySearchForm
        query={{ q: "鼻水", kind: "all", from: null, to: null, before: null, beforeDate: null }}
        today={TODAY}
      />,
    )
    const clear = screen.getByRole("link", { name: "条件をクリア" })
    expect(clear.tagName).toBe("A")
    expect(clear).toHaveAttribute("href", "/baby/search")
    // Base UI の Button に Link を描かせぬ: 既定では <a> に type="button" が付き（開発時に
    // 警告）、nativeButton={false} では role="button" が付いて link でなくなる（レビュー P3-11）
    expect(clear).not.toHaveAttribute("type")
    expect(clear).not.toHaveAttribute("role")
    expect(clear.className).toContain("min-h-11")
    expect(clear.className).not.toContain("transition-all")
  })

  it("よく使う条件の入口を Link で出し（44px）、今の条件に当たる入口に aria-current を付ける", () => {
    render(
      <BabySearchForm
        query={{ q: "", kind: "all", from: "2026-10-13", to: TODAY, before: null, beforeDate: null }}
        today={TODAY}
      />,
    )
    const nav = screen.getByRole("navigation", { name: "よく使う条件" })
    const week = screen.getByRole("link", { name: "直近7日" })
    expect(nav).toContainElement(week)
    expect(week).toHaveAttribute("aria-current", "true")
    expect(week.className).toContain("min-h-11")
    expect(screen.getByRole("link", { name: "今日" })).not.toHaveAttribute("aria-current")
    expect(screen.getByRole("link", { name: "授乳" })).toHaveAttribute(
      "href",
      "/baby/search?kind=feeding&from=2026-10-13&to=2026-10-19",
    )
  })

  it("過去の日へ移る入口は /baby?date= の GET フォームで、未来の日を選ばせぬ", () => {
    render(
      <BabySearchForm
        query={{ q: "", kind: "all", from: null, to: null, before: null, beforeDate: null }}
        today={TODAY}
      />,
    )
    const form = screen.getByRole("form", { name: "日付を指定して開く" })
    expect(form).toHaveAttribute("action", "/baby")
    expect(form).toHaveAttribute("method", "get")
    const input = screen.getByLabelText("日付を指定して開く", { selector: "input" })
    expect(input).toHaveAttribute("name", "date")
    expect(input).toHaveAttribute("max", TODAY)
  })

  it("条件が無ければ「条件をクリア」は出さぬ", () => {
    render(
      <BabySearchForm
        query={{ q: "", kind: "all", from: null, to: null, before: null, beforeDate: null }}
        today={TODAY}
      />,
    )
    expect(screen.queryByRole("link", { name: "条件をクリア" })).toBeNull()
    expect(screen.getByRole("button", { name: "探す" })).toBeInTheDocument()
  })
})
