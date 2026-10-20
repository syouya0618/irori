import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Next のランタイムが error.tsx へ**何という名前で**再試行関数を渡すかを固定する（P2-01）。
 *
 * ## なぜ node_modules を読むか
 * error.tsx の props の型はアプリ自身が宣言するゆえ、Next が prop を改名しても
 * tsc も lint も黙る（16.3 で `unstable_retry` → `retry` に改名され、全ての
 * 「もう一度試す」が無反応のまま本番に入った）。次の Next 更新でまた改名されたら、
 * この検査が赤くなって気付ける形にしておく。
 *
 * ## 検査の粒度
 * `includes("retry")` では足りぬ。`this.retry = ...` の定義やコメントでも真になる。
 * `this.props.errorComponent` へ渡す props オブジェクトだけを括弧の対応で切り出し、
 * コメントを剥いだ上で `retry: this.retry` を探す。下の対照（改名した写し）で
 * この述語が偽になることも確かめる。
 */

const NEXT_DIR = join(process.cwd(), "node_modules/next/dist")
const RUNTIME_FILES = [
  join(NEXT_DIR, "client/components/error-boundary.js"),
  join(NEXT_DIR, "esm/client/components/error-boundary.js"),
]

/** `/* *\/` と `//` のコメントを剥ぐ（文字列中の誤爆は対象ファイルの範囲では起きぬ）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** `this.props.errorComponent, {` に続く props オブジェクトの中身を返す。無ければ null。 */
function errorComponentProps(source: string): string | null {
  const code = stripComments(source)
  const anchor = code.search(/this\.props\.errorComponent\s*,\s*\{/)
  if (anchor === -1) return null
  const open = code.indexOf("{", anchor)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++
    else if (code[i] === "}") {
      depth--
      if (depth === 0) return code.slice(open + 1, i)
    }
  }
  return null
}

/** 再試行関数が `retry` の名で渡っておるか（旧名 `unstable_retry` ではなく）。 */
function passesRetryProp(source: string): boolean {
  const props = errorComponentProps(source)
  if (props === null) return false
  return /(^|[\s,{])retry\s*:\s*this\.retry\b/.test(props) && !/unstable_retry/.test(props)
}

describe("Next ランタイム契約: error コンポーネントへ渡る再試行 prop の名", () => {
  it("CJS 版の error-boundary が存在する（前提）", () => {
    expect(existsSync(RUNTIME_FILES[0])).toBe(true)
  })

  for (const file of RUNTIME_FILES.filter((f) => existsSync(f))) {
    const rel = file.slice(NEXT_DIR.length + 1)

    it(`${rel}: errorComponent へ retry を渡す`, () => {
      const source = readFileSync(file, "utf-8")
      expect(errorComponentProps(source)).not.toBeNull()
      expect(passesRetryProp(source)).toBe(true)
    })

    it(`${rel}: 対照 — prop 名を unstable_retry に戻した写しでは偽になる`, () => {
      const source = readFileSync(file, "utf-8")
      const reverted = source.replace(/(\n\s*)retry:\s*this\.retry/, "$1unstable_retry: this.retry")
      expect(reverted).not.toBe(source)
      expect(passesRetryProp(reverted)).toBe(false)
    })
  }

  it("対照 — props に retry が無く定義だけ在る写しでは偽になる（this.retry = 誤爆の否定）", () => {
    const fake = `
      this.retry = () => {}
      // retry: this.retry
      jsx(this.props.errorComponent, { error: thrownValue, reset: this.reset })
    `
    expect(passesRetryProp(fake)).toBe(false)
  })
})
