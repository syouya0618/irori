import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 育児ダッシュボードの「今日」は時計（useNow の戻り値 `now`）から導き、描画中に
 * 壁時計を直接読まぬことを固定する。
 *
 * ## なぜソースを読む形にするか
 * 依存の無い式で壁時計を読むと — 引数なしの `todayJstString()`、`todayJstString(new Date())`、
 * `new Date()`、`Date.now()` — React Compiler（next.config.ts の reactCompiler）が
 * 「依存の無い値」とみなし、`memo_cache_sentinel` の下で**マウント時に一度だけ**評価して
 * 凍結する（babel-plugin-react-compiler で baby-dashboard.tsx を変換した出力で確認）。
 * PWA を開いたまま日を跨ぐと「今日」が前日のまま残り、新しい日の行を編集すると
 * 選択日に属さぬと判定されてタイムラインから消える。
 *
 * ところが vitest は Compiler を通さぬ（vitest.config.ts の plugin は素の react()）ため、
 * 描画テストでは凍結を再現できず、緑のまま回帰する。ゆえに記述を検査する。
 *
 * ## 契約（このテストが名指しするもの）
 * - `todayJstString(` の引数は `now`（useNow の戻り値）だけ。別名にするならここも直せ
 * - 引数なしの `new Date()` と `Date.now()` を書かぬ（`new Date(log.logged_at)` 等の
 *   値の変換は純粋ゆえ許す）
 * - `todayJstString` を別名で import せぬ（検査の字面をすり抜けるため）
 */

const FILES = [
  "src/components/baby/baby-dashboard.tsx",
  "src/components/baby/baby-date-nav.tsx",
]

/** 行コメント・ブロックコメントを落とす（注記の中の記述を実コードと混同せぬ） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")
}

/** 契約違反の一覧を返す（空なら適合） */
function violations(src: string): string[] {
  const code = stripComments(src)
  const found: string[] = []
  for (const m of code.matchAll(/todayJstString\(([^)]*)\)/g)) {
    if (m[1].trim() !== "now") found.push(m[0])
  }
  for (const m of code.matchAll(/new Date\(\s*\)|Date\.now\(/g)) found.push(m[0])
  if (/todayJstString\s+as\b/.test(code)) found.push("todayJstString as")
  return found
}

describe("「今日」を描画中に壁時計から直接読まぬ", () => {
  it.each(FILES)("%s", (file) => {
    expect(violations(readFileSync(join(process.cwd(), file), "utf-8"))).toEqual([])
  })

  describe("検出器の対照", () => {
    it.each([
      ["引数なし", "const today = todayJstString()"],
      ["new Date() を渡す", "const today = todayJstString(new Date())"],
      ["素の new Date()", "const t = new Date()"],
      ["Date.now()", "const t = Date.now()"],
      ["別名 import", 'import { todayJstString as tj } from "@/lib/utils/date-jst"'],
    ])("%s は捕まえる", (_label, src) => {
      expect(violations(src)).not.toEqual([])
    })

    it.each([
      ["時計から導く形", "const today = todayJstString(now)"],
      ["値の変換", "const t = new Date(log.logged_at).getTime()"],
      ["注記の中", "// todayJstString() は注記\nconst today = todayJstString(now)"],
      ["URL を含む文字列の後", 'const u = "https://example.com"; const today = todayJstString(now)'],
    ])("%s は許す", (_label, src) => {
      expect(violations(src)).toEqual([])
    })

    it("URL を含む文字列と同じ行の違反も捕まえる（行コメント除去で消さぬ）", () => {
      expect(
        violations('const u = "https://example.com"; const t = todayJstString()'),
      ).not.toEqual([])
    })
  })
})
