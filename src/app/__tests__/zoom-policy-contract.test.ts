import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * ピンチ拡大の方針（1 つの関心事）の記述契約。
 *
 * - `src/app/layout.tsx` の viewport は `maximumScale` / `userScalable` を持たぬ（WCAG 2.2 SC 1.4.4）
 * - 代わりの守りは `src/app/touch-zoom.css`: `html { touch-action: manipulation }` と、
 *   指で触る端末での入力欄 16px 床。床は **@layer の外**に無ければ utilities に負ける
 * - 床の除外は 18px 以上（text-lg 以上）だけ。`text-base` を除外すると `text-base md:text-sm`
 *   の標準 Input / Textarea が横持ちの iPhone（幅 844〜932px）で 14px に戻り、封じたはずの
 *   自動拡大が戻る（独立レビューで見つかった穴）
 * - 除外一覧（allowlist）に無い大きさ（任意値 text-[20px] や text-5xl 以上）を入力欄に使うと、
 *   電話でだけ 16px へ縮む。現状 0 件であることを src の走査で固定し、増やす時に気付ける形にする
 *
 * 限界: 記述の検査であって描画・実機の検査ではない。iOS 実機での確認は未実施。
 */

const ROOT = process.cwd()
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf-8")
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

const CSS = stripComments(read("src/app/touch-zoom.css"))
const LAYOUT = stripComments(read("src/app/layout.tsx"))

/** 文字列中の位置 `index` が `{ }` の何段目に在るか（0 = どの層にも入っておらぬ）。 */
function braceDepthAt(css: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") depth--
  }
  return depth
}

describe("viewport: ピンチ拡大を禁じない", () => {
  const viewportLiteral =
    LAYOUT.match(/export const viewport\s*:\s*Viewport\s*=\s*\{([^}]*)\}/)?.[1] ?? null

  it("viewport の定義が在る（前提）", () => {
    expect(viewportLiteral).not.toBeNull()
  })

  it("maximumScale / userScalable の制限が無い", () => {
    expect(viewportLiteral).not.toMatch(/maximumScale\s*:/)
    expect(viewportLiteral).not.toMatch(/userScalable\s*:/)
  })

  it("viewport 自体は残っておる（device-width / viewport-fit: cover）", () => {
    expect(viewportLiteral).toMatch(/width:\s*"device-width"/)
    expect(viewportLiteral).toMatch(/viewportFit:\s*"cover"/)
  })

  it("layout が touch-zoom.css を読み込む（解除と守りは対）", () => {
    expect(LAYOUT).toMatch(/import\s+"\.\/touch-zoom\.css"/)
  })
})

describe("touch-zoom.css: 代わりの守り", () => {
  it("html に touch-action: manipulation（ダブルタップ拡大を切る）", () => {
    expect(CSS).toMatch(/html\s*\{[^}]*touch-action:\s*manipulation/)
  })

  const start = CSS.search(/@media\s*\(\s*pointer\s*:\s*coarse\s*\)/)
  const block = start === -1 ? "" : CSS.slice(start, CSS.indexOf("}", CSS.indexOf("font-size", start)) + 1)

  it("指で触る端末では input / select / textarea を 1rem にする", () => {
    expect(start).toBeGreaterThan(-1)
    expect(block).toMatch(/:is\(input,\s*select,\s*textarea\)/)
    expect(block).toMatch(/font-size:\s*1rem/)
  })

  it("除外は text-lg 以上だけ。text-base は除外せぬ（md:text-sm を打ち消すため）", () => {
    expect(block).toMatch(/:not\([^)]*\.text-lg/)
    expect(block).toMatch(/:not\([^)]*\.text-4xl/)
    expect(block).not.toMatch(/:not\([^)]*\.text-base/)
    expect(block).not.toMatch(/\.text-sm|\.text-xs/)
  })

  it("床はどの @layer にも入っておらぬ（utilities に勝つため）", () => {
    expect(braceDepthAt(CSS, start)).toBe(0)
    expect(CSS).not.toMatch(/@layer/)
  })
})

/** src 配下の .tsx（テストを除く）を列挙する。 */
function listTsx(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (name === "__tests__" || name === "node_modules") continue
    if (statSync(path).isDirectory()) listTsx(path, out)
    else if (name.endsWith(".tsx")) out.push(path)
  }
  return out
}

/** 床の除外一覧に無い大きさ（任意値・text-5xl 以上）を、入力欄の className に使っておらぬか。 */
const OVERSIZE_ON_CONTROL =
  /<(?:input|select|textarea|Input|Textarea)\b[^>]*className=(?:"[^"]*|\{[^}]*)(?:\btext-\[[^\]]+\]|\btext-(?:5xl|6xl|7xl|8xl|9xl)\b)/

describe("入力欄の文字サイズは床の除外一覧の内に在る", () => {
  it("src の input / select / textarea / Input / Textarea に任意値や text-5xl 以上が無い", () => {
    const offenders = listTsx(join(ROOT, "src"))
      .filter((path) => OVERSIZE_ON_CONTROL.test(readFileSync(path, "utf-8")))
      .map((path) => path.slice(ROOT.length + 1))
    expect(offenders).toEqual([])
  })

  it("対照 — 検出器は任意値を見つける", () => {
    expect(OVERSIZE_ON_CONTROL.test('<Input className="h-11 text-[20px]" />')).toBe(true)
    expect(OVERSIZE_ON_CONTROL.test('<input className="text-5xl" />')).toBe(true)
    expect(OVERSIZE_ON_CONTROL.test('<Input className="min-h-11 text-base md:text-sm" />')).toBe(false)
    expect(OVERSIZE_ON_CONTROL.test('<p className="text-[20px]">x</p>')).toBe(false)
  })
})
