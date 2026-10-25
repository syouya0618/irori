/**
 * 予定追加 FAB の位置の契約（Agent A の「浮く操作（FAB）とトーストの契約」）。
 *
 * A の globals.css は `body:has([data-fab])` で下端トーストを FAB の上 1rem へ退避させる。
 * それが成り立つのは、FAB が次の 3 つを守る時だけじゃ:
 *   1. 根に data-fab を持つ
 *   2. 下端 = ナビ（4rem = --bottom-nav-h）+ safe-area + 1rem（= above-bottom-nav）
 *   3. 高さ = 3.5rem（h-14 = --fab-size）
 * C 単独の branch には A の変数が無いゆえ値を直書きしておる。片方だけを変えると、統合後に
 * トーストと FAB が重なる。ここで式そのものを固定し、変える時に両方を見直させる。
 *
 * 実ブラウザでの重なりの実測（360/390/768/1440・横向き・長文・積み重ね・シート表示中）は
 * 静的に束ねたハーネスで行った（PR 本文の検証表）。jsdom は配置を計算せぬゆえここでは見ぬ。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { CalendarAddFab } from "../calendar-add-fab"

afterEach(cleanup)

describe("CalendarAddFab", () => {
  it("A の退避の目印 data-fab を持つ", () => {
    render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={() => {}} />)
    expect(screen.getByRole("button", { name: "10月24日（土）に予定を追加" })).toHaveAttribute(
      "data-fab",
    )
  })

  it("下端はナビ + safe-area + 1rem、高さは 3.5rem（A の above-bottom-nav / --fab-size と同値）", () => {
    render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={() => {}} />)
    const cls = screen.getByRole("button").className
    expect(cls).toContain("bottom-[calc(4rem+env(safe-area-inset-bottom,0px)+1rem)]")
    expect(cls).toMatch(/\bh-14\b/)
    expect(cls).toContain("fixed")
    // 横向き（高さ 500px 以下）では画面の右端へ寄せ、中央 356px のトーストと横で交わらせぬ
    expect(cls).toContain("[@media(max-height:500px)]:right-4")
    // トーストの矩形を測って持ち上げる仕組みと同居させぬ（A の契約の禁止条項）
    expect(screen.getByRole("button").getAttribute("style")).toBeNull()
  })

  it("見えている「追加」を読み上げ名に含み、押せば onClick を呼ぶ", () => {
    const onClick = vi.fn()
    render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={onClick} />)
    const button = screen.getByRole("button")
    expect(button).toHaveTextContent("追加")
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
