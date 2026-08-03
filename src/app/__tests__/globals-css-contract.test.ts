import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * `globals.css` が `docs/DESIGN_SYSTEM.md` の明文の契約を満たすことを固定する。
 *
 * ## なぜソースを読む形にするか
 * CSS のメディアクエリは jsdom でも実ブラウザでも「発火させて確かめる」のが
 * 難しい（`prefers-reduced-motion` はユーザー設定であり、Playwright の
 * emulateMedia は使えるが CI の全経路に敷くには重い）。
 * ここで固定したいのは**規約に沿った記述が在ること**と、**在ってはならぬ記述が
 * 無いこと**の 2 点ゆえ、ソースの検査で足りる。
 *
 * 限界: これは**記述の検査**であって描画の検査ではない。実ブラウザでの
 * glass のぼかしは `e2e/smoke.spec.ts` の「Liquid Glass: .glass のぼかしが
 * 実ブラウザで有効（prefix 落ちの回帰防止）」が別途担う。
 */

const CSS = readFileSync(
  join(process.cwd(), "src/app/globals.css"),
  "utf-8"
)

/** `@media (prefers-reduced-motion: reduce) { ... }` の中身を括弧の対応で切り出す。 */
function reducedMotionBlock(css: string): string | null {
  const start = css.search(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/)
  if (start === -1) return null
  const open = css.indexOf("{", start)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") {
      depth--
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

describe("globals.css — prefers-reduced-motion（DESIGN_SYSTEM.md:118 / 167）", () => {
  const block = reducedMotionBlock(CSS)

  it("`@media (prefers-reduced-motion: reduce)` のブロックが存在する", () => {
    expect(block).not.toBeNull()
  })

  it("アニメーションと遷移の両方を抑える（片方だけでは指針を満たさぬ）", () => {
    expect(block).toMatch(/animation-duration/)
    expect(block).toMatch(/transition-duration/)
  })

  /**
   * ⭐ 本テストの主眼。DESIGN_SYSTEM.md:167 は「**Glass blur は維持**、
   * アニメーションのみ無効化」と明記しておる。
   *
   * ここに `backdrop-filter: none` を足すと、**動きに弱い利用者だけが
   * 別のアプリを使っておるように見える**。しかも「アニメーションを止めた」
   * つもりの変更で起きるため気付きにくい。Chrome でぼかしが消える回帰は
   * #169 で一度起きており、同じ画を別経路で再現させぬ。
   */
  it("Glass blur を殺しておらぬ（backdrop-filter に触れぬ）", () => {
    expect(block).not.toMatch(/backdrop-filter/)
    expect(block).not.toMatch(/-webkit-backdrop-filter/)
    expect(block).not.toMatch(/\bfilter\s*:/)
  })

  /**
   * 定石の `animation-iteration-count: 1` は spinner を 1 回転で止める。
   * 読み込み表示は 34 箇所あり、止まった spinner は「処理中」ではなく
   * 「壊れた」に見える。`reduce` は `none` ではないゆえ、遅くするのが正しい。
   */
  it("読み込み表示（.animate-spin）は停止させず遅くする", () => {
    expect(block).toMatch(/\.animate-spin/)
    const spin = block?.slice(block.indexOf(".animate-spin")) ?? ""
    expect(spin).toMatch(/animation-iteration-count:\s*infinite/)
  })
})

describe("globals.css — 静的アセットの置き場", () => {
  /**
   * `src/app/favicon.ico` は Next の file convention に拾われ、
   * **Route Handler（サーバ関数）へ化ける**。実測では
   * `.next/server/app/favicon.ico/route.js` が生成され 36K を占めておった。
   * `public/` へ置けば静的配信になり、サーバ関数は 1 つも生成されぬ。
   */
  it("favicon は public/ に在り、src/app/ には無い", () => {
    const inPublic = join(process.cwd(), "public/favicon.ico")
    const inApp = join(process.cwd(), "src/app/favicon.ico")
    expect(() => readFileSync(inPublic)).not.toThrow()
    expect(() => readFileSync(inApp)).toThrow()
  })
})
