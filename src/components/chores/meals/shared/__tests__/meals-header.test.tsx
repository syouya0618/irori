import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { route } = vi.hoisted(() => ({
  route: { pathname: "/chores/meals/plan", query: "start=2026-11-22" },
}))

vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.query),
}))

import { MealsHeader } from "../meals-nav"

describe("献立の詳細編集を終えたときの戻り先", () => {
  beforeEach(() => {
    route.pathname = "/chores/meals/plan"
    route.query = "start=2026-11-22"
  })
  afterEach(() => cleanup())

  it("日曜の1品編集からその週のスケジュール一覧へ戻る", () => {
    render(<MealsHeader />)
    expect(screen.getByRole("link", { name: "週間スケジュールへ戻る" }))
      .toHaveAttribute("href", "/chores/meals?start=2026-11-16")
  })

  it("翌週の編集では翌週を保ち、URLが無ければ今週に戻る", () => {
    route.query = "start=2026-11-25"
    const { rerender } = render(<MealsHeader />)
    expect(screen.getByRole("link", { name: "週間スケジュールへ戻る" }))
      .toHaveAttribute("href", "/chores/meals?start=2026-11-23")

    route.query = ""
    rerender(<MealsHeader />)
    expect(screen.getByRole("link", { name: "週間スケジュールへ戻る" }))
      .toHaveAttribute("href", "/chores/meals")
  })

  it("スケジュール画面自体の戻るは従来通り家事トップを指す", () => {
    route.pathname = "/chores/meals"
    route.query = ""
    render(<MealsHeader />)
    expect(screen.getByRole("link", { name: "家事" }))
      .toHaveAttribute("href", "/chores")
  })
})
