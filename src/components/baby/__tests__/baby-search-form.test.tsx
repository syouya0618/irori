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
