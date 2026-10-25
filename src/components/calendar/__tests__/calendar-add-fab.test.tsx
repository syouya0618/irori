/**
 * 予定追加 FAB の契約（DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）。
 *
 * 殻の globals.css は `html[data-fab]` が在る間だけ、下端トーストを FAB の上 1rem へ退避させる。
 * それが成り立つのは、FAB が次の 3 つを守る時だけじゃ:
 *   1. 根で useFabClearance() を呼ぶ（mount で `<html data-fab>` が立ち、unmount で外れる）
 *   2. 下端 = `above-bottom-nav`（ナビ `--bottom-nav-h` + safe-area + 1rem）
 *   3. 高さ = `h-(--fab-size)`（3.5rem）
 * 退避の式（globals.css の html[data-fab]）は 2 と 3 の変数から導く。FAB が直書きの値へ戻ると、
 * 変数を変えた時に片方だけが動き、トーストと FAB が重なる。ここで部品の側を固定する
 * （globals.css 側の式は globals-css-contract.test.ts、hook 自体は use-fab-clearance.test.tsx）。
 *
 * 実ブラウザでの重なり（360/390/768/1440・横向き・入退場・シート表示中）は静的に束ねたハーネスで
 * 測った（統合 PR 本文の検証表）。jsdom は配置を計算せぬゆえここでは見ぬ。
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, cleanup, fireEvent } from "@testing-library/react"
import { CalendarAddFab } from "../calendar-add-fab"
import { FAB_ATTRIBUTE } from "@/lib/hooks/use-fab-clearance"

const htmlHasFab = () => document.documentElement.hasAttribute(FAB_ATTRIBUTE)

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(FAB_ATTRIBUTE)
})

describe("CalendarAddFab", () => {
  it("mount の間だけ <html data-fab> を立て、unmount で外す（下端トーストの退避の目印）", () => {
    expect(htmlHasFab()).toBe(false)
    const view = render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={() => {}} />)
    expect(htmlHasFab()).toBe(true)
    view.unmount()
    expect(htmlHasFab()).toBe(false)
  })

  it("要素そのものには data-fab を付けぬ（属性は html に立つ。要素の属性は退避に効かぬ旧契約）", () => {
    render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={() => {}} />)
    expect(screen.getByRole("button", { name: "10月24日（土）に予定を追加" })).not.toHaveAttribute(
      FAB_ATTRIBUTE,
    )
  })

  it("下端は above-bottom-nav、高さは --fab-size（殻の退避の式と同じ変数）", () => {
    render(<CalendarAddFab label="10月24日（土）に予定を追加" onClick={() => {}} />)
    const cls = screen.getByRole("button").className.split(/\s+/)
    expect(cls).toContain("above-bottom-nav")
    expect(cls).toContain("h-(--fab-size)")
    expect(cls).toContain("fixed")
    // Button の基底の高さ（size=default の h-8）が残ると FAB の上端が --fab-size とずれる
    expect(cls).not.toContain("h-8")
    // 直書きの式へ戻さぬ（変数を変えた時に FAB だけが取り残される）
    expect(cls.some((c) => c.startsWith("bottom-"))).toBe(false)
    expect(cls).not.toContain("h-14")
    // 横向き（高さ 500px 以下）では画面の右端へ寄せ、中央 356px のトーストと横で交わらせぬ
    expect(cls).toContain("[@media(max-height:500px)]:right-4")
    // ナビ・シートの z-50 より下（シートの暗幕が FAB を覆う）
    expect(cls).toContain("z-10")
    // トーストの矩形を測って持ち上げる仕組みと同居させぬ（契約の禁止条項）
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
