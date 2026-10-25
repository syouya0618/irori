/**
 * useFabClearance の契約: FAB が在る間だけ `<html data-fab>` が立ち、消えれば外れる。
 * globals.css の `html[data-fab]` がトーストの退避量をこれで切り替える（globals-css-contract.test.ts）。
 */
import { describe, it, expect, afterEach } from "vitest"
import { StrictMode, Activity } from "react"
import { render, cleanup } from "@testing-library/react"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

import { useFabClearance, FAB_ATTRIBUTE } from "../use-fab-clearance"

function Fab({ active = true }: { active?: boolean }) {
  useFabClearance(active)
  return <button type="button">追加</button>
}

const hasAttr = () => document.documentElement.hasAttribute(FAB_ATTRIBUTE)

afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute(FAB_ATTRIBUTE)
})

describe("useFabClearance — html[data-fab] は FAB の在る間だけ立つ", () => {
  it("mount で立ち、unmount で外れる", () => {
    const view = render(<Fab />)
    expect(hasAttr()).toBe(true)
    view.unmount()
    expect(hasAttr()).toBe(false)
  })

  it("FAB が 2 つ在れば、片方が消えても最後の 1 つが消えるまで保つ", () => {
    const a = render(<Fab />)
    const b = render(<Fab />)
    expect(hasAttr()).toBe(true)
    a.unmount()
    expect(hasAttr()).toBe(true)
    b.unmount()
    expect(hasAttr()).toBe(false)
  })

  it("対照: active=false なら立てぬ（表示せぬ FAB は退避させぬ）", () => {
    const view = render(<Fab active={false} />)
    expect(hasAttr()).toBe(false)
    view.unmount()
    expect(hasAttr()).toBe(false)
  })

  /** StrictMode は effect を mount → cleanup → mount と二重に走らせる。件数が 1 → 0 → 1 と戻り、最後に立つ。 */
  it("StrictMode の二重実行でも最後に立ち、unmount で外れる", () => {
    const view = render(
      <StrictMode>
        <Fab />
      </StrictMode>,
    )
    expect(hasAttr()).toBe(true)
    view.unmount()
    expect(hasAttr()).toBe(false)
  })

  /**
   * Cache Components / <Activity> で隠された route は DOM に残るが、layout effect の cleanup は隠す時に走る
   * （Next docs preserving-ui-state.md）。隠れた予定画面の FAB が他の画面のトーストを上げ続けてはならぬ。
   */
  /** 最初から隠れておる中身（先に描いておく route）は effect を mount せぬゆえ、属性も立たぬ。 */
  it("最初から Activity hidden で mount した FAB は属性を立てぬ", () => {
    const view = render(
      <Activity mode="hidden">
        <Fab />
      </Activity>,
    )
    expect(hasAttr()).toBe(false)
    view.unmount()
    expect(hasAttr()).toBe(false)
  })

  it("Activity で隠れると外れ、再び見えると立つ", () => {
    const view = render(
      <Activity mode="visible">
        <Fab />
      </Activity>,
    )
    expect(hasAttr()).toBe(true)
    view.rerender(
      <Activity mode="hidden">
        <Fab />
      </Activity>,
    )
    expect(hasAttr()).toBe(false)
    view.rerender(
      <Activity mode="visible">
        <Fab />
      </Activity>,
    )
    expect(hasAttr()).toBe(true)
    view.unmount()
    expect(hasAttr()).toBe(false)
  })
})

/**
 * 契約の守り（統合時に無音で壊れる経路を塞ぐ）: 要素に `data-fab` 属性を書いても退避は効かぬ。
 * 旧契約（`body:has([data-fab])`）で作られた FAB が hook を呼ばずに統合されると、A のテストも
 * その FAB のテストも緑のまま、下端トーストが FAB を覆う。src の .tsx を走査して音を立てて落とす。
 */
/** 注記（ブロックと行頭の行コメント）を剥ぎ、JSX の属性の形 `data-fab=` / `data-fab ` / `data-fab>` だけを数える。 */
function hasJsxFabAttribute(code: string): boolean {
  const stripped = code.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "")
  return /\sdata-fab(?:=|\s|\/|>)/.test(stripped)
}

describe("契約の守り: 要素の data-fab 属性ではなく useFabClearance() を呼ぶ", () => {
  it("src の .tsx（__tests__ を除く）に JSX の data-fab 属性が無い", () => {
    const root = join(process.cwd(), "src")
    const offenders: string[] = []
    const visited: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(path)
          continue
        }
        if (!path.endsWith(".tsx")) continue
        visited.push(relative(process.cwd(), path))
        if (hasJsxFabAttribute(readFileSync(path, "utf-8"))) offenders.push(relative(process.cwd(), path))
      }
    }
    walk(root)
    // 走査そのものの対照: 1 つも訪れずに緑になる形ではないこと
    expect(visited.length).toBeGreaterThan(0)
    expect(visited).toContain(join("src", "components", "common", "bottom-nav.tsx"))
    expect(visited.some((p) => p.includes("__tests__"))).toBe(false)
    expect(
      offenders,
      "要素の data-fab 属性は何もせぬ。FAB の根で useFabClearance() を呼べ（DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）",
    ).toEqual([])
  })

  /** 落ちるべき fixture: JSX の属性（C の旧契約の形）。 */
  it("対照（落ちるべき）: JSX の data-fab 属性を見つける", () => {
    expect(hasJsxFabAttribute('<button data-fab="" type="button">追加</button>')).toBe(true)
    expect(hasJsxFabAttribute("<div data-fab>\n</div>")).toBe(true)
  })

  /** 通るべき fixture: 文字列・注記・backtick の言及は数えぬ。 */
  it("対照（通るべき）: setAttribute の文字列、注記、backtick の言及は見つけぬ", () => {
    expect(hasJsxFabAttribute('document.documentElement.setAttribute("data-fab", "")')).toBe(false)
    expect(hasJsxFabAttribute("/** 根に data-fab を付ける旧契約は廃止 */\nexport const x = 1")).toBe(false)
    expect(hasJsxFabAttribute("  // data-fab は hook が立てる\nexport const y = 2")).toBe(false)
    expect(hasJsxFabAttribute("const note = `A の \\`data-fab\\` は html に付く`")).toBe(false)
  })
})
