import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 画面の「殻」（ナビを持たぬ画面・共通の状態表示・ルート layout）の記述契約。
 *
 * ## ダークモード
 * ログイン・世帯作成・404・全体エラー・オフライン・承認待ちは、以前 `from-orange-50` /
 * `bg-amber-100` / `text-[oklch(...)]` のような**ライト固定の直書き**で組まれており、
 * OS がダークの夜間に見出しと説明がほぼ読めなんだ（実測: ダークのログイン画面で
 * 見出し・説明が背景と同化）。殻はトークン由来の `bg-hearth`（globals.css）で描き、
 * ライト固定のパレットを持ち込まぬことをここで固定する。
 *
 * ピンチ拡大の方針（viewport / touch-zoom.css）は関心事が別ゆえ zoom-policy-contract.test.ts が持つ。
 *
 * 限界: これは記述の検査であって描画の検査ではない。
 */

const ROOT = process.cwd()

/**
 * `/* *\/`（JSX の `{/* *\/}` も含む）と行頭の `//` を剥ぐ。
 * 注記が「以前は bg-amber-100 じゃった」と書くのは正しい記録であって違反ではない。
 * 文字列走査がコメントを実 code と混同せぬよう、code だけを見る。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

const read = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf-8"))

/** ライト固定のパレット（ダーク用の対が無い直書き）を検出する。 */
const LIGHT_ONLY_PALETTE =
  /\b(?:from|via|to|bg|text|border)-(?:orange|amber|rose|yellow|stone|gray|neutral|slate|zinc)-\d{2,3}\b|\b(?:bg|text)-white(?:\/\d+)?\b|\b(?:bg|text)-\[oklch\(/

function hasLightOnlyPalette(source: string): boolean {
  return LIGHT_ONLY_PALETTE.test(source)
}

const NAVLESS_SHELLS = [
  "src/app/(auth)/layout.tsx",
  "src/app/setup/layout.tsx",
  "src/app/not-found.tsx",
  "src/app/error.tsx",
  "src/app/offline/page.tsx",
  "src/app/pending-approval/pending-content.tsx",
]

const SHARED_STATE_VIEWS = [
  "src/components/common/error-view.tsx",
  "src/components/common/offline-banner.tsx",
  "src/components/common/bottom-nav.tsx",
  "src/components/ui/skeleton.tsx",
]

describe("殻のダークモード: ライト固定のパレットを持ち込まぬ", () => {
  for (const rel of [...NAVLESS_SHELLS, ...SHARED_STATE_VIEWS]) {
    it(`${rel}: orange-50 / amber-100 / bg-white / text-[oklch(...)] が無い`, () => {
      expect(hasLightOnlyPalette(read(rel))).toBe(false)
    })
  }

  for (const rel of NAVLESS_SHELLS) {
    it(`${rel}: 背景は bg-hearth（トークン由来）`, () => {
      expect(read(rel)).toMatch(/\bbg-hearth\b/)
    })
  }

  it("対照 — 検出器は直書きを見つける（偽陰性の否定）", () => {
    expect(hasLightOnlyPalette('className="bg-gradient-to-b from-orange-50 to-amber-50"')).toBe(true)
    expect(hasLightOnlyPalette('className="bg-amber-100"')).toBe(true)
    expect(hasLightOnlyPalette('className="bg-white/55"')).toBe(true)
    expect(hasLightOnlyPalette('className="text-[oklch(0.18_0.02_50)]"')).toBe(true)
    // 許容: トークンと shadow-black（影は両テーマで黒でよい）
    expect(hasLightOnlyPalette('className="bg-primary/10 text-primary shadow-black/[0.04]"')).toBe(false)
  })

  it("対照 — コメントの中の記録は違反に数えぬ（code だけを見る）", () => {
    expect(hasLightOnlyPalette(stripComments("/* 以前は bg-amber-100 */ className=\"bg-primary/10\""))).toBe(false)
    expect(hasLightOnlyPalette(stripComments("  // from-orange-50 じゃった\n className=\"bg-hearth\""))).toBe(false)
  })
})

describe("ルート layout: トーストの殻", () => {
  const layout = read("src/app/layout.tsx")

  it("Toaster は props 無しで置く（位置・退避・テーマは ui/sonner.tsx が持つ）", () => {
    expect(layout).toMatch(/<Toaster\s*\/>/)
    expect(layout).not.toMatch(/top-center/)
  })
})

describe("(main) の殻: 中身とナビが同じ変数を見る", () => {
  it("layout の main は pb-nav、BottomNav は h-(--bottom-nav-h)", () => {
    expect(read("src/app/(main)/layout.tsx")).toMatch(/<main className="[^"]*\bpb-nav\b/)
    expect(read("src/components/common/bottom-nav.tsx")).toMatch(/h-\(--bottom-nav-h\)/)
  })
})
