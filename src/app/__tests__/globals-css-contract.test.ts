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

/** 行頭の `selector {` で始まる最初の規則の中身を切り出す（入れ子なし前提）。 */
function topLevelRule(css: string, selector: string): string | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)
  return m ? m[1] : null
}

describe("globals.css — color-scheme をテーマと対で宣言する", () => {
  /**
   * UA が描く部品（date/time 入力の時計・カレンダーアイコン等）は light-dark() で
   * 絵を選ぶ。宣言が無いとダーク時も明色用の暗いアイコンが暗い欄に載り見えぬ。
   * Chrome for Android 154 からは、fine ポインタを報告する端末でこのアイコンが
   * ピッカーを開く入口の一つになっておる。
   */
  it(":root は light を宣言する", () => {
    expect(topLevelRule(CSS, ":root")).toMatch(/color-scheme:\s*light\s*;/)
  })

  it(".dark は dark を宣言する（:root の後に置き、同じ詳細度で上書きする）", () => {
    const dark = topLevelRule(CSS, ".dark")
    expect(dark).toMatch(/color-scheme:\s*dark\s*;/)
    expect(CSS.search(/^\.dark\s*\{/m)).toBeGreaterThan(CSS.search(/^:root\s*\{/m))
  })
})

/** 注記（`/* *\/`）を剥いだ CSS。波括弧を数える検査は注記の中の `{` に惑わされてはならぬ。 */
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

/** 文字列中の位置 `index` が `{ }` の何段目に在るか（0 = どの層にも入っておらぬ）。 */
function braceDepthAt(css: string, index: number): number {
  let depth = 0
  for (let i = 0; i < index; i++) {
    if (css[i] === "{") depth++
    else if (css[i] === "}") depth--
  }
  return depth
}

describe("globals.css — 殻の寸法はひとつの変数から導く", () => {
  /**
   * ナビの高さ（`h-(--bottom-nav-h)`）・(main) の下余白（`.pb-nav`）・トーストの退避量は
   * `--bottom-nav-h` と `--safe-bottom` を共有する。以前は layout が `pb-20`（80px）、
   * ナビが中身任せ（55px + safe-area 34px = 89px）と独立に決まり、各ページの `pb-8` が
   * 偶然埋めておった。
   */
  const root = topLevelRule(CSS, ":root")

  it(":root が --bottom-nav-h と --safe-bottom を宣言する", () => {
    expect(root).toMatch(/--bottom-nav-h:\s*4rem\s*;/)
    expect(root).toMatch(/--safe-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)\s*;/)
  })

  it(".pb-nav と .safe-bottom は両変数を見る", () => {
    expect(CSS).toMatch(/\.pb-nav\s*\{[^}]*calc\(var\(--bottom-nav-h\)\s*\+\s*var\(--safe-bottom\)\)/)
    expect(CSS).toMatch(/\.safe-bottom\s*\{[^}]*var\(--safe-bottom\)/)
  })

  it("html は固定ナビの分だけ scroll-padding-bottom を取る", () => {
    expect(CSS).toMatch(/scroll-padding-bottom:\s*calc\(var\(--bottom-nav-h\)\s*\+\s*var\(--safe-bottom\)\)/)
  })
})

describe("globals.css — 殻の背景 bg-hearth はトークン由来で両テーマに在る", () => {
  it("起点色 --hearth-glow を :root と .dark の両方が持ち、.bg-hearth はそれと background を使う", () => {
    expect(topLevelRule(CSS, ":root")).toMatch(/--hearth-glow:\s*oklch\(/)
    expect(topLevelRule(CSS, ".dark")).toMatch(/--hearth-glow:\s*oklch\(/)
    const rule = CSS_CODE.match(/\.bg-hearth\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(rule).toMatch(/var\(--background\)/)
    expect(rule).toMatch(/var\(--hearth-glow\)/)
  })

  /**
   * ⚠️ `color-mix(in oklab, var(--primary) 14%, transparent)` で書くと、Turbopack / webpack の
   * lightningcss が color-mix を落として `var(--primary) 0` だけを出し、本番では全開の
   * オレンジが角に出る（2026-10-24 に build 後 CSS で実測）。#169 の backdrop-filter と同族で、
   * tsc も lint も静的描画も気付かぬ。ゆえに記述で禁じる。
   */
  it("bg-hearth の定義に color-mix を使わぬ（lightningcss が落とす）", () => {
    const rule = CSS_CODE.match(/\.bg-hearth\s*\{([^}]*)\}/)?.[1] ?? ""
    expect(rule).not.toMatch(/color-mix/)
  })

  it("orange-50 / amber-50 のような固定色を持たぬ（注記は除く）", () => {
    expect(CSS_CODE).not.toMatch(/orange-\d{2,3}|amber-\d{2,3}/)
  })
})

describe("globals.css — 拡大まわりの守りは touch-zoom.css へ分離（関心事の分離）", () => {
  /**
   * viewport の解除・touch-action・入力欄 16px 床は 1 つの関心事として
   * `src/app/touch-zoom.css` と `zoom-policy-contract.test.ts` に在る。globals.css が
   * 同じ規則を二重に持つと、片方だけ直す事故が起きる。
   */
  it("globals.css は pointer: coarse の床も touch-action も持たぬ", () => {
    expect(CSS_CODE).not.toMatch(/pointer\s*:\s*coarse/)
    expect(CSS_CODE).not.toMatch(/touch-action/)
  })
})

describe("globals.css — 浮く要素の下端もナビの変数から導く", () => {
  it(".above-bottom-nav はナビ高さ + safe-area + 1rem", () => {
    expect(CSS).toMatch(/\.above-bottom-nav\s*\{[^}]*bottom:\s*calc\(var\(--bottom-nav-h\)\s*\+\s*var\(--safe-bottom\)\s*\+\s*1rem\)/)
  })
})

describe("globals.css — トーストと FAB の退避契約（DESIGN_SYSTEM.md「浮く操作（FAB）」）", () => {
  /**
   * トーストの退避量は変数 `--toast-clearance` 1 本で、ui/sonner.tsx は値を知らずこれを渡す。
   * 既定はナビの上。FAB の部品が useFabClearance() で `<html data-fab>` を立てておる間だけ
   * FAB の上端 + 1rem まで上げる。
   *   FAB の下端 = ナビ + safe + 1rem（.above-bottom-nav）、FAB の高さ = --fab-size
   *   → トーストの下端 = ナビ + safe + 1rem + --fab-size + 1rem
   * FAB 側でトーストの矩形を測って自分を持ち上げてはならぬ（sonner の入場中の矩形に反応して跳ねる。
   * DESIGN_SYSTEM.md「浮く操作（FAB）とトーストの契約」）。
   */
  const root = topLevelRule(CSS, ":root")

  it(":root が --fab-size 3.5rem と、ナビ基準の --toast-clearance 既定値を持つ", () => {
    expect(root).toMatch(/--fab-size:\s*3\.5rem\s*;/)
    expect(root).toMatch(
      /--toast-clearance:\s*calc\(var\(--bottom-nav-h\)\s*\+\s*var\(--safe-bottom\)\s*\+\s*0\.75rem\)\s*;/,
    )
  })

  it("html[data-fab] が --toast-clearance を FAB の上（+1rem + --fab-size + 1rem）へ上書きする", () => {
    const m = /^html\[data-fab\]\s*\{([^}]*)\}/m.exec(CSS_CODE)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(
      /--toast-clearance:\s*calc\(var\(--bottom-nav-h\)\s*\+\s*var\(--safe-bottom\)\s*\+\s*1rem\s*\+\s*var\(--fab-size\)\s*\+\s*1rem\)/,
    )
  })

  it("上書きは :root の後・@layer の外に在る（層の中では :root の宣言に負けはせぬが、順序で読む）", () => {
    const start = CSS_CODE.search(/^html\[data-fab\]/m)
    expect(start).toBeGreaterThan(CSS_CODE.search(/^:root\s*\{/m))
    expect(braceDepthAt(CSS_CODE, start)).toBe(0)
  })

  /**
   * Next 16.3 の docs（preserving-ui-state.md「The :has selector」）: 全体に効く状態は React が持つ
   * data-* 属性で表し、広い :has() は性能の瓶首。Cache Components で隠れた route の DOM は残るゆえ
   * `body:has([data-fab])` は隠れた画面の FAB にも反応する。属性は useFabClearance() が立てる。
   */
  it("退避の切り替えに文書全体の :has() を使わぬ（React が持つ html[data-fab]。部品内の局所的な :has() は別）", () => {
    expect(CSS_CODE).not.toMatch(/(?:html|body|:root):has\(/)
    const hook = readFileSync(join(process.cwd(), "src/lib/hooks/use-fab-clearance.ts"), "utf-8")
    expect(hook).toMatch(/documentElement\.setAttribute\(FAB_ATTRIBUTE/)
    expect(hook).toMatch(/FAB_ATTRIBUTE = "data-fab"/)
  })

  it("@theme inline が --primary-hover を bg-primary-hover として写す（hover は薄めず暗く）", () => {
    expect(CSS_CODE).toMatch(/--color-primary-hover:\s*var\(--primary-hover\)/)
    expect(root).toMatch(/--primary-hover:\s*oklch\(/)
    expect(topLevelRule(CSS, ".dark")).toMatch(/--primary-hover:\s*oklch\(/)
  })

  it("対照: 退避量の直書き（calc(var(--bottom-nav-h) …) をトースト側に持つ形）は sonner.tsx に残っておらぬ", () => {
    const sonner = readFileSync(join(process.cwd(), "src/components/ui/sonner.tsx"), "utf-8").replace(
      /\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      "",
    )
    expect(sonner).toMatch(/var\(--toast-clearance\)/)
    expect(sonner).not.toMatch(/calc\(var\(--bottom-nav-h\)/)
  })
})

describe("globals.css — トーストの操作ボタンは 44px（@layer の外）", () => {
  /**
   * sonner の既定は `[data-button]` が 24px・12px。片手で押し間違えた直後の「取り消す」が
   * 親指で押せぬ寸法じゃった。sonner は `[data-sonner-toast][data-styled=true] [data-button]`
   * （0,3,0）を実行時に差し込むため、属性 1 つ分だけ詳細度を上げて勝たせる。
   */
  it("[data-button] に min-height 2.75rem（44px）を与える", () => {
    const m = CSS.match(/\[data-sonner-toaster\]\s*\[data-sonner-toast\]\[data-styled="true"\]\s*\[data-button\]\s*\{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/min-height:\s*2\.75rem/)
    expect(m![1]).toMatch(/min-width:\s*2\.75rem/)
  })

  it("本文を 13px から 0.875rem（14px）へ", () => {
    const m = CSS.match(/\[data-sonner-toaster\]\s*\[data-sonner-toast\]\[data-styled="true"\]\s*\{([^}]*)\}/)
    expect(m).not.toBeNull()
    expect(m![1]).toMatch(/font-size:\s*0\.875rem/)
  })

  it("どの @layer にも入っておらぬ", () => {
    const start = CSS_CODE.indexOf('[data-sonner-toaster] [data-sonner-toast][data-styled="true"] [data-button]')
    expect(start).toBeGreaterThan(-1)
    expect(braceDepthAt(CSS_CODE, start)).toBe(0)
  })

  /**
   * richColors のライトの文字色は sonner の既定では 4.5:1 に届かぬ（success 4.26 / error 4.35 /
   * warning 3.08）。sonner は `[data-sonner-toaster][data-sonner-theme='light']`（0,2,0）で変数を置き、
   * その <style> は実行時に head の末尾へ入る（このファイルより後）。同じ詳細度では順序で負けるゆえ
   * `html` を足した（0,2,1）で書く。ダーク側に触れると 9〜12:1 の既定を壊すゆえ、選択子の形も固定する。
   * 数値は color-contrast-contract.test.ts が見る。
   */
  it("richColors のライト文字色を html [..][data-sonner-theme=light]（0,2,1）で上書きし、@layer の外に置く", () => {
    const m = /html \[data-sonner-toaster\]\[data-sonner-theme="light"\]\s*\{([^}]*)\}/.exec(CSS_CODE)
    expect(m).not.toBeNull()
    for (const name of ["--success-text", "--info-text", "--warning-text", "--error-text"]) {
      expect(m![1]).toMatch(new RegExp(`${name}:\\s*hsl\\(`))
    }
    expect(braceDepthAt(CSS_CODE, m!.index)).toBe(0)
    expect(CSS_CODE).not.toMatch(/\[data-sonner-theme="dark"\]\s*\{/)
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
