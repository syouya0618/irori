import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * GoogleCalendarCard の **Liquid Glass 契約**をソース実体で固定する。
 *
 * ## なぜ DOM ではなくソースを見るのか
 * `src/components/ui/button.tsx` の `buttonVariants` は shadcn/base-ui 由来の
 * 既存プリミティブで、基底クラスに `transition-all` を**既に含んでおる**
 * （アプリ全体の全 Button が同じ）。ゆえに描画後の DOM を走査すると、
 * 自分が書いた覚えのない `transition-all` を必ず拾って恒久的に赤になる。
 * ここで守りたいのは「**このカードが自前で `transition-all` を持ち込まぬ**」
 * ことゆえ、判定対象はこのファイルのソース実体じゃ。
 *
 * ## この検査の限界（正直に書く）
 * リポジトリ全体を走る `transition-all` 検出器は**存在せぬ**
 * （`scripts/` にも `eslint.config.mjs` にも無いことを実測で確認済み）。
 * 本テストが守るのはこの 1 ファイルだけであり、他ファイルの違反は捕まえぬ。
 * 全体の機械ロックは別 PR の関心事じゃ。
 */

const CARD_PATH = fileURLToPath(
  new URL("../google-calendar-card.tsx", import.meta.url),
)
const source = readFileSync(CARD_PATH, "utf8")

/** コメント行を除いた実コード（規約の説明文が自己ヒットせぬようにする）。 */
const code = source
  .split("\n")
  .filter((line) => {
    const trimmed = line.trim()
    return (
      !trimmed.startsWith("//") &&
      !trimmed.startsWith("*") &&
      !trimmed.startsWith("/*")
    )
  })
  .join("\n")

describe("Liquid Glass の作法", () => {
  it("transition-all を使わぬ（transition-colors のみ）", () => {
    expect(code).not.toContain("transition-all")
  })

  it("transition を書くなら colors 限定・duration-200", () => {
    const transitions = [...code.matchAll(/\btransition-[a-z]+\b/g)].map(
      (m) => m[0],
    )
    expect(transitions.length).toBeGreaterThan(0)
    for (const t of transitions) {
      expect(t).toBe("transition-colors")
    }
    expect(code).toContain("transition-colors duration-200")
  })

  it("glass カードとして描く", () => {
    expect(code).toContain('Card className="glass"')
  })

  it("押せる要素は 44px 以上のタッチ領域を持つ", () => {
    // min-h-11 = 2.75rem = 44px / .touch-target は globals.css で min 44px。
    expect(code).toMatch(/min-h-11|touch-target/)
  })

  it("絵文字を使わぬ（アイコンは Lucide React）", () => {
    // meal reaction 以外で絵文字は禁止（CLAUDE.md / DESIGN_SYSTEM.md）。
    // 絵文字プレゼンテーション / サロゲートペア領域を検出する。
    expect(code).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{FE0F}\u{2600}-\u{27BF}]/u)
    expect(code).toContain('from "lucide-react"')
  })
})
