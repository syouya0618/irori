import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 下端トーストの入退場（globals.css の「滑りではなく薄れ」）の契約。
 *
 * ## 何を守るか
 * sonner は下端のトーストを自分の高さぶん下から滑り込ませ、退場でも下へ滑らせる。その間（約 0.2 秒）
 * ほぼ透明のトーストがナビと予定の FAB の上を通り、指を受ける。統合 harness の実測（Chromium・rAF ごとの
 * elementFromPoint）では、幅 360 / 390px で入場の最初の約 80ms、「取り消す」釦が育児画面の「設定」タブと
 * 予定画面の FAB の中心に重なった。globals.css はトーストを下へ動かす状態でだけ `--y` を止め、退場中の
 * 下端トーストに pointer-events: none を当てる。
 *
 * ## なぜ sonner 本体と照合するか
 * 上書きは sonner の内部の属性名（data-mounted / data-removed / data-front / data-swipe-out /
 * data-expanded / data-y-position）と `transform: var(--y)` の仕組みに依る。sonner を上げて名前や仕組みが
 * 変わると、上書きは**黙って効かなくなる**（tsc も lint も気付かぬ）。ゆえに実行時に効く CSS
 * （dist/index.mjs が head へ差す文字列）と JSX の属性名を読み、前提が今も在ることを固定する。
 *
 * 限界: 記述の検査であって描画の検査ではない。描画の前後比較は統合 PR 本文の harness 実測が持つ。
 */

const ROOT = process.cwd()
const SONNER_RUNTIME = readFileSync(join(ROOT, "node_modules/sonner/dist/index.mjs"), "utf-8")
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf-8")
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

/** 文字列中の位置 `index` が `{ }` の何段目に在るか（0 = どの層・規則にも入っておらぬ）。 */
function braceDepthAt(css: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") depth--
  }
  return depth
}

/** `selector {` の規則の中身。選択子の一覧（`a,\nb {`）の一員でもよい。 */
function ruleBodyFor(css: string, selector: string): string | null {
  const start = css.indexOf(selector)
  if (start === -1) return null
  const open = css.indexOf("{", start)
  const close = css.indexOf("}", open)
  return css.slice(open + 1, close)
}

/** 属性選択子と疑似クラス :not(...) の中身を数える（詳細度の b 列。html の型選択子は c 列）。 */
function attributeCount(selector: string): number {
  return (selector.match(/\[[^\]]+\]/g) ?? []).length
}

describe("sonner 本体の前提（実行時に効く CSS と属性名）", () => {
  it("トーストは transform: var(--y) で動き、下端の初期位置は translateY(100%)（下から滑り込む）", () => {
    expect(SONNER_RUNTIME).toMatch(/\[data-sonner-toast\]\{--y:translateY\(100%\);[^}]*transform:var\(--y\)/)
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-y-position=bottom]{bottom:0;--y:translateY(100%);--lift:-1;",
    )
    expect(SONNER_RUNTIME).toContain("[data-sonner-toast][data-mounted=true]{--y:translateY(0);opacity:1}")
  })

  it("退場は前面・背面（広げた / 畳んだ）の 3 規則で下へ送る", () => {
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-removed=true][data-front=true][data-swipe-out=false]{--y:translateY(calc(var(--lift) * -100%));opacity:0}",
    )
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset) + var(--lift) * -100%));opacity:0}",
    )
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-removed=true][data-front=false][data-swipe-out=false][data-expanded=false]{--y:translateY(40%);",
    )
  })

  it("退場中のトーストは ::before（scaleY(2)）で当たり判定を広げる（pointer-events: none が要る理由）", () => {
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-swiping=false][data-removed=true]::before{content:'';position:absolute;inset:0;transform:scaleY(2)}",
    )
  })

  it("スワイプで消したトーストは keyframe で本体ごと動く（--y の上書きが当たらぬ。pointer-events が要る理由）", () => {
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-swipe-out=true][data-y-position=bottom],[data-sonner-toast][data-swipe-out=true][data-y-position=top]{animation-duration:.2s;",
    )
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-swipe-out=true][data-swipe-direction=down]{animation-name:swipe-out-down}",
    )
  })

  it("広げた積み重ねの位置は translateY(lift × offset)（広げた背面の退場で写す式）", () => {
    expect(SONNER_RUNTIME).toContain(
      "[data-sonner-toast][data-mounted=true][data-expanded=true]{--y:translateY(calc(var(--lift) * var(--offset)));",
    )
  })

  it.each(["data-mounted", "data-removed", "data-front", "data-swipe-out", "data-expanded", "data-y-position"])(
    "トーストの要素は %s 属性を持つ",
    (attr) => {
      expect(SONNER_RUNTIME).toContain(`"${attr}":`)
    },
  )
})

describe("globals.css の上書き（下端だけ・下へ動かす状態だけ・@layer の外）", () => {
  const STOP_SLIDE = [
    'html [data-sonner-toast][data-y-position="bottom"]:not([data-mounted="true"])',
    'html [data-sonner-toast][data-y-position="bottom"][data-removed="true"][data-front="true"][data-swipe-out="false"]',
    'html [data-sonner-toast][data-y-position="bottom"][data-removed="true"][data-front="false"][data-swipe-out="false"][data-expanded="false"]',
  ]
  const KEEP_EXPANDED =
    'html [data-sonner-toast][data-y-position="bottom"][data-removed="true"][data-front="false"][data-swipe-out="false"][data-expanded="true"]'
  // 止めるのは広げた当たり判定（::before）だけ。トースト本体は退場中も指を受ける（二度押しを下へ落とさぬ）
  const NO_POINTER = 'html [data-sonner-toast][data-y-position="bottom"][data-removed="true"]::before {'

  it.each(STOP_SLIDE)("%s は --y を translateY(0) に止める", (selector) => {
    expect(ruleBodyFor(CSS_CODE, selector)).toMatch(/--y:\s*translateY\(0\);/)
  })

  it("広げた背面の退場はその場（mounted・expanded の位置）に留める", () => {
    expect(ruleBodyFor(CSS_CODE, KEEP_EXPANDED)).toMatch(
      /--y:\s*translateY\(calc\(var\(--lift\) \* var\(--offset\)\)\);/,
    )
  })

  it("退場中の下端トーストが広げる当たり判定（::before）は指を受けぬ", () => {
    expect(ruleBodyFor(CSS_CODE, NO_POINTER)).toMatch(/pointer-events:\s*none;/)
  })

  it("スワイプで消した下端トーストは本体ごと指を受けぬ（keyframe で下へ滑る 200ms）", () => {
    const selector = 'html [data-sonner-toast][data-y-position="bottom"][data-swipe-out="true"] {'
    expect(ruleBodyFor(CSS_CODE, selector)).toMatch(/pointer-events:\s*none;/)
    expect(braceDepthAt(CSS_CODE, CSS_CODE.indexOf(selector))).toBe(0)
  })

  it("対照: トースト本体（::before でない）には pointer-events を当てぬ（二度押しの 2 回目を下へ落とさぬ）", () => {
    expect(CSS_CODE).not.toMatch(
      /html \[data-sonner-toast\]\[data-y-position="bottom"\]\[data-removed="true"\]\s*\{[^}]*pointer-events/,
    )
  })

  it("全て @layer の外に在り、html を足して sonner の --y を書く規則より詳細度が高い", () => {
    for (const selector of [...STOP_SLIDE, KEEP_EXPANDED, NO_POINTER]) {
      const at = CSS_CODE.indexOf(selector)
      expect(at, selector).toBeGreaterThan(-1)
      expect(braceDepthAt(CSS_CODE, at), selector).toBe(0)
      expect(selector.startsWith("html ")).toBe(true)
    }
    // 詳細度は sonner の実行時 CSS から数える（直書きせぬ — sonner がより詳細な規則を足せば、上書きが黙って
    // 負ける前にここで落ちる）。sonner の規則は (0, 属性数, 0)、上書きは html を足した (0, 属性数, 1) ゆえ、
    // 属性数が同じか多ければ勝つ。
    const ySetters = [...SONNER_RUNTIME.matchAll(/(\[data-sonner-toast\][^{},]*)\{[^}]*--y:/g)].map((m) => m[1])
    expect(ySetters.length).toBeGreaterThan(5)
    // 退場の上書きは、--y を書く sonner の全規則の最大と比べる
    const sonnerMax = Math.max(...ySetters.map(attributeCount))
    expect(sonnerMax).toBeGreaterThanOrEqual(5)
    for (const selector of [STOP_SLIDE[1], STOP_SLIDE[2], KEEP_EXPANDED]) {
      expect(attributeCount(selector), selector).toBeGreaterThanOrEqual(sonnerMax)
    }
    // 入場の上書きは、入場中のトースト（未 mount・未退場・スワイプ前）に当たりうる規則の最大と比べる
    const enterRivals = ySetters.filter((s) => !/data-removed=true|data-mounted=true|data-swiping=true/.test(s))
    expect(enterRivals.length).toBeGreaterThan(0)
    expect(attributeCount(STOP_SLIDE[0])).toBeGreaterThanOrEqual(Math.max(...enterRivals.map(attributeCount)))
  })

  it("対照: 詳細度の数え方は sonner より属性の少ない上書きを見逃さぬ", () => {
    const weak = 'html [data-sonner-toast][data-removed="true"]'
    const ySetters = [...SONNER_RUNTIME.matchAll(/(\[data-sonner-toast\][^{},]*)\{[^}]*--y:/g)].map((m) => m[1])
    expect(attributeCount(weak)).toBeLessThan(Math.max(...ySetters.map(attributeCount)))
  })

  it("対照: 上端（シート表示中）のトーストには触れぬ・積み重ねとスワイプの規則も上書きせぬ", () => {
    expect(CSS_CODE).not.toMatch(/\[data-y-position="top"\]/)
    expect(CSS_CODE).not.toMatch(/\[data-swiping=/)
    expect(CSS_CODE).not.toMatch(/\[data-mounted="true"\](?!\))/)
  })
})
