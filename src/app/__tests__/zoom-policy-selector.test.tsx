/**
 * touch-zoom.css の床セレクタが、意図した要素だけに一致することを jsdom の `matches()` で固定する。
 *
 * CSS の文字列検査（zoom-policy-contract.test.ts）だけでは「`text-base md:text-sm` の
 * Input が床に入るか」を言えぬ。セレクタを CSS から切り出し、要素に当てて対で確かめる。
 * 限界: `@media (pointer: coarse)` の発火と font-size の適用は実ブラウザ・実機の領分。
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const css = readFileSync(join(process.cwd(), "src/app/touch-zoom.css"), "utf-8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
)
const selector = css.match(/(:is\(input,\s*select,\s*textarea\):not\([^)]*\))\s*\{/)?.[1] ?? ""

function control(tag: "input" | "select" | "textarea" | "button", className: string) {
  const el = document.createElement(tag)
  el.className = className
  return el
}

describe("touch-zoom.css の床セレクタ", () => {
  it("セレクタを切り出せる（前提）", () => {
    expect(selector).not.toBe("")
  })

  it("標準の Input（text-base md:text-sm）は床に入る", () => {
    expect(control("input", "h-8 w-full text-base md:text-sm").matches(selector)).toBe(true)
  })

  it("小さく指定した欄（text-xs / text-sm）と指定の無い欄は床に入る", () => {
    expect(control("input", "h-10 flex-1 text-xs").matches(selector)).toBe(true)
    expect(control("select", "h-10 rounded-md text-sm").matches(selector)).toBe(true)
    expect(control("textarea", "").matches(selector)).toBe(true)
  })

  it("対照 — 18px 以上を明示した欄は床に入らぬ", () => {
    expect(control("input", "text-lg font-semibold").matches(selector)).toBe(false)
    expect(control("input", "text-2xl").matches(selector)).toBe(false)
  })

  it("対照 — 入力欄でない要素には当たらぬ", () => {
    expect(control("button", "text-sm").matches(selector)).toBe(false)
  })
})
