import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * 色トークンのコントラスト契約（WCAG 2.2 SC 1.4.3 / 1.4.11）。
 *
 * ## なぜ計算で固定するか
 * 主色 `--primary` は 2026-10 まで oklch(0.65 0.19 50) で、白文字 3.45:1・白地の上の文字 3.30:1
 * と通常文字の 4.5:1 を満たしておらなんだ（Agent B の実測と一致）。色は「見た目で良さそう」で
 * 戻されやすく、tsc も lint も気付かぬ。ゆえに globals.css の宣言値から sRGB へ変換し、
 * 比を**数値で**固定する。描画の実測（Playwright）は別途行うが、CI の全経路で走るのはこれじゃ。
 *
 * ## 計算の正しさの担保
 * 既知の対（白/黒 = 21:1、#777777/白 = 4.48:1）で変換を校正し、**旧値が落ちること**を対照に置く。
 * 判定は 8bit に丸めた sRGB で行う（画面に出る値と同じ）。半透明の glass はテーマの背景の上に
 * sRGB 空間で合成する（ブラウザの通常合成と同じ空間）。
 */

const CSS = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf-8")
const CSS_CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

type Rgb = readonly [number, number, number]
type Oklch = { L: number; C: number; h: number; a: number }

/** 行頭の `selector {` で始まる規則の中身（入れ子なし前提）。 */
function topLevelRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

function parseOklch(value: string): Oklch {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%?)?\s*\)/.exec(value)
  if (!m) throw new Error(`not an oklch literal: ${value}`)
  const alphaRaw = m[4]
  const a = alphaRaw === undefined ? 1 : value.includes("%") ? Number(alphaRaw) / 100 : Number(alphaRaw)
  return { L: Number(m[1]), C: Number(m[2]), h: Number(m[3]), a }
}

function token(rule: string, name: string): Oklch {
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(rule)
  if (!m) throw new Error(`token not found: ${name}`)
  return parseOklch(m[1])
}

/** oklch → 線形 sRGB（Björn Ottosson の行列）。 */
function oklchToLinearSrgb({ L, C, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180
  const a = C * Math.cos(hr)
  const b = C * Math.sin(hr)
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)
const degamma = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

/** sRGB の内側か（各チャネルが 0..1。わずかな数値誤差は許す）。 */
function inSrgbGamut(c: Oklch): boolean {
  return oklchToLinearSrgb(c).every((v) => v >= -0.0005 && v <= 1.0005)
}

/** 8bit に丸めた sRGB（0..255）。画面に出る値。 */
function toRgb255(c: Oklch): Rgb {
  const [r, g, b] = oklchToLinearSrgb(c).map((v) => Math.min(1, Math.max(0, v))).map(gamma)
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

/** `top`（不透明度 alpha）を `bottom` の上に sRGB 空間で合成する。 */
function over(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => Math.round(top[i] * alpha + bottom[i] * (1 - alpha))) as unknown as Rgb
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * degamma(r / 255) + 0.7152 * degamma(g / 255) + 0.0722 * degamma(b / 255)
}

/** WCAG コントラスト比（小数 2 桁へ丸め）。 */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

describe("色の計算の校正（この検査自身が正しいことの対照）", () => {
  it("白/黒は 21:1、#777777/白は 4.48:1（WCAG の既知の対）", () => {
    expect(contrast(WHITE, BLACK)).toBe(21)
    expect(contrast([0x77, 0x77, 0x77], WHITE)).toBe(4.48)
  })

  it("対照: 旧主色 oklch(0.65 0.19 50) は白文字 4.5:1 を満たさず、sRGB の外に在る", () => {
    const old: Oklch = { L: 0.65, C: 0.19, h: 50, a: 1 }
    expect(contrast(WHITE, toRgb255(old))).toBeLessThan(4.5)
    expect(inSrgbGamut(old)).toBe(false)
  })
})

/** テーマ 1 つ分の実効色。glass 系は背景の上に合成した色。 */
function palette(rule: string, glassNavRule: string, glassRule: string) {
  const bg = toRgb255(token(rule, "--background"))
  const nav = token(glassNavRule, "background")
  const glass = token(glassRule, "background")
  return {
    background: bg,
    foreground: toRgb255(token(rule, "--foreground")),
    primary: token(rule, "--primary"),
    primaryRgb: toRgb255(token(rule, "--primary")),
    primaryHover: token(rule, "--primary-hover"),
    primaryHoverRgb: toRgb255(token(rule, "--primary-hover")),
    primaryForeground: toRgb255(token(rule, "--primary-foreground")),
    ring: token(rule, "--ring"),
    hearthGlow: token(rule, "--hearth-glow"),
    muted: toRgb255(token(rule, "--muted")),
    mutedForeground: toRgb255(token(rule, "--muted-foreground")),
    destructive: toRgb255(token(rule, "--destructive")),
    glassNav: over(toRgb255(nav), nav.a, bg),
    glass: over(toRgb255(glass), glass.a, bg),
  }
}

/** 行頭（字下げ可）の `selector {` に限る。`.glass` が `.dark .glass {` や `.glass-nav {` に当たらぬように。 */
function glassRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const m = new RegExp(`^[ \\t]*${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css)
  if (!m) throw new Error(`rule not found: ${selector}`)
  return m[1]
}

const THEMES = {
  light: palette(topLevelRule(CSS_CODE, ":root"), glassRule(CSS_CODE, ".glass-nav"), glassRule(CSS_CODE, ".glass")),
  dark: palette(topLevelRule(CSS_CODE, ".dark"), glassRule(CSS_CODE, ".dark .glass-nav"), glassRule(CSS_CODE, ".dark .glass")),
}

describe("規則の切り出しの対照", () => {
  it("glassRule('.glass') はライトの .glass に当たり、.dark .glass や .glass-nav には当たらぬ", () => {
    expect(glassRule(CSS_CODE, ".glass")).toMatch(/oklch\(1 0 0 \/ 55%\)/)
    expect(glassRule(CSS_CODE, ".dark .glass")).toMatch(/oklch\(0\.18 0\.01 50 \/ 55%\)/)
  })
})

describe.each(Object.entries(THEMES))("トークンのコントラスト — %s", (_name, p) => {
  /** 通常文字（ボタンの白文字、ナビの現在地ラベル 12px、リンク、見出し）: 4.5:1 以上。 */
  it("primary-foreground（ボタンの文字）は primary の上で 4.5:1 以上", () => {
    expect(contrast(p.primaryForeground, p.primaryRgb)).toBeGreaterThanOrEqual(4.5)
  })

  /** hover 中も状態の一つ。`bg-primary/80` のように薄めると白文字が 3.5:1 に落ちるゆえ専用トークン。 */
  it("primary-foreground は primary-hover の上でも 4.5:1 以上、primary-hover は sRGB の内側", () => {
    expect(contrast(p.primaryForeground, p.primaryHoverRgb)).toBeGreaterThanOrEqual(4.5)
    expect(inSrgbGamut(p.primaryHover)).toBe(true)
  })

  /**
   * 汎用の focus リング（ui/ の button・input・select・textarea の `focus-visible:ring-ring`）は、--ring
   * （主色 90%）を敷いた実効色で 3:1 以上（WCAG 2.2 1.4.11）。以前は --ring 40% × 部品側の /50 = 実効 20% で
   * 約 1.3:1 じゃった。地は background だけでなく、殻の角（bg-hearth の --hearth-glow が乗る所）と --muted
   * の上でも見る — 80% は殻の角で 2.91 と割った（Playwright 実測）。濃さの最終判断は計画書 D-3 どおり実機で
   * 人間が決める（ここは下限だけを守る）。ナビの `focus-visible:outline-primary` は不透明な主色で別物。
   */
  it("汎用 focus リング（--ring を ring-ring で全量）は background / 殻の角 / muted の上で 3:1 以上", () => {
    const ringOnBg = over(toRgb255(p.ring), p.ring.a, p.background)
    expect(contrast(ringOnBg, p.background)).toBeGreaterThanOrEqual(3)
    const corner = over(toRgb255(p.hearthGlow), p.hearthGlow.a, p.background)
    expect(contrast(over(toRgb255(p.ring), p.ring.a, corner), corner)).toBeGreaterThanOrEqual(3)
    expect(contrast(over(toRgb255(p.ring), p.ring.a, p.muted), p.muted)).toBeGreaterThanOrEqual(3)
  })

  it("対照: 部品側で ring-ring/50 に薄めると 3:1 に届かぬ（薄めてはならぬ理由）", () => {
    const ringOver = over(toRgb255(p.ring), p.ring.a * 0.5, p.background)
    expect(contrast(ringOver, p.background)).toBeLessThan(3)
  })

  it("primary の文字は background / glass-nav / glass の上で 4.5:1 以上（ナビの現在地ラベル・見出し）", () => {
    expect(contrast(p.primaryRgb, p.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.primaryRgb, p.glassNav)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.primaryRgb, p.glass)).toBeGreaterThanOrEqual(4.5)
  })

  it("muted-foreground（ナビの非選択ラベル・補足）は background / glass-nav の上で 4.5:1 以上", () => {
    expect(contrast(p.mutedForeground, p.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(p.mutedForeground, p.glassNav)).toBeGreaterThanOrEqual(4.5)
  })

  it("foreground は background の上で 7:1 以上（本文）", () => {
    expect(contrast(p.foreground, p.background)).toBeGreaterThanOrEqual(7)
  })

  it("白文字は destructive の上で 4.5:1 以上", () => {
    expect(contrast(WHITE, p.destructive)).toBeGreaterThanOrEqual(4.5)
  })

  /** 非テキスト（アイコン、BottomNav の focus-visible:outline-primary）: 3:1 以上。 */
  it("primary は background の上で 3:1 以上（アイコン・BottomNav の輪郭）", () => {
    expect(contrast(p.primaryRgb, p.background)).toBeGreaterThanOrEqual(3)
  })

  /** sRGB の外の色はブラウザごとに丸め方が違い、同じ CSS が端末で別の色になる。 */
  it("primary は sRGB の内側に在る（端末で色が揺れぬ）", () => {
    expect(inSrgbGamut(p.primary)).toBe(true)
  })
})

/** `hsl(h, s%, l%)` → 8bit sRGB。 */
function hslToRgb255(value: string): Rgb {
  const m = /hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/.exec(value)
  if (!m) throw new Error(`not an hsl literal: ${value}`)
  const h = Number(m[1])
  const s = Number(m[2]) / 100
  const l = Number(m[3]) / 100
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const mm = l - c / 2
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + mm, g + mm, b + mm].map((v) => Math.round(v * 255)) as unknown as Rgb
}

function hslToken(rule: string, name: string): string {
  const m = new RegExp(`${name}:\\s*(hsl\\([^)]*\\))\\s*;`).exec(rule)
  if (!m) throw new Error(`token not found: ${name}`)
  return m[1]
}

describe("トースト（sonner richColors）のライトの文字色は地色の上で 4.5:1 以上", () => {
  /**
   * sonner の既定（dist/styles.css の `[data-sonner-toaster][data-sonner-theme='light']`）は淡い地に
   * 中間の明度の文字で 4.26〜4.35:1（warning は 3.08）。globals.css が
   * `html [data-sonner-toaster][data-sonner-theme="light"]`（0,2,1 — sonner の 0,2,0 に順序を問わず勝つ）で上書く。
   * 地色は **node_modules の sonner 本体から読む**ゆえ、sonner を上げて地色が変われば落ちる。
   */
  const SONNER = readFileSync(join(process.cwd(), "node_modules/sonner/dist/styles.css"), "utf-8")
  /** 実行時に効くのは index.mjs が head へ差す文字列。styles.css と同じ値であることも併せて見る。 */
  const SONNER_RUNTIME = readFileSync(join(process.cwd(), "node_modules/sonner/dist/index.mjs"), "utf-8")
  const lightVars = /\[data-sonner-toaster\]\[data-sonner-theme='light'\]\s*\{([^}]*--success-bg[^}]*)\}/.exec(SONNER)?.[1]
  const override = /html \[data-sonner-toaster\]\[data-sonner-theme="light"\]\s*\{([^}]*)\}/.exec(CSS_CODE)?.[1]

  it("sonner の地色と globals.css の上書きの両方が見つかる", () => {
    expect(lightVars).toBeDefined()
    expect(override).toBeDefined()
  })

  it.each(["success", "info", "warning", "error"])("%s: styles.css の地色は index.mjs が実行時に差す文字列と同じ", (type) => {
    const bg = hslToken(lightVars!, `--${type}-bg`)
    expect(SONNER_RUNTIME).toContain(`--${type}-bg:${bg}`)
  })

  it.each(["success", "info", "warning", "error"])("%s: 上書きした文字色 / sonner の地色 ≥ 4.5", (type) => {
    const bg = hslToRgb255(hslToken(lightVars!, `--${type}-bg`))
    const text = hslToRgb255(hslToken(override!, `--${type}-text`))
    expect(contrast(text, bg)).toBeGreaterThanOrEqual(4.5)
  })

  it("対照: sonner の既定の文字色は少なくとも 1 種で 4.5 に届かぬ（上書きが要る理由）", () => {
    const below = ["success", "info", "warning", "error"].filter((type) => {
      const bg = hslToRgb255(hslToken(lightVars!, `--${type}-bg`))
      const text = hslToRgb255(hslToken(lightVars!, `--${type}-text`))
      return contrast(text, bg) < 4.5
    })
    expect(below.length).toBeGreaterThan(0)
  })
})

describe("ui/ の focus リングは --ring を薄めずに使う（薄めると上の対照のとおり 3:1 に届かぬ）", () => {
  it.each(["button", "input", "select", "textarea"])("ui/%s.tsx は focus-visible:ring-ring を全量で持ち、ring-ring/<alpha> を持たぬ", (name) => {
    const src = readFileSync(join(process.cwd(), `src/components/ui/${name}.tsx`), "utf-8")
    expect(src).toMatch(/focus-visible:ring-ring(?![\w/-])/)
    expect(src).not.toMatch(/ring-ring\/\d/)
  })

  it("globals.css の基底の outline-color も --ring を薄めぬ", () => {
    expect(CSS_CODE).toMatch(/@apply border-border outline-ring;/)
    expect(CSS_CODE).not.toMatch(/outline-ring\/\d/)
  })

  /**
   * 共通部品だけでなく、画面側が自前で描く focus 表示（`focus:` / `focus-visible:` / `focus-within:` の
   * ring・outline の色）も薄めぬ。統合の時点で育児の検索欄と日付ナビに `ring-ring/50`（実効 45%、
   * 約 2:1）、共通 Button の destructive に `focus-visible:ring-destructive/20`（実測 1.38:1）が残っておった。
   * 選択状態の枠（`ring-primary/50` 等）は focus ではないゆえ対象外。
   */
  const DILUTED_FOCUS = /focus(?:-visible|-within)?:(?:ring|outline)-[a-z]+(?:-[a-z]+)*\/\d/
  it("src の .tsx（テストを除く）の focus 表示は ring-ring / outline-ring を薄めぬ", () => {
    const root = join(process.cwd(), "src")
    const visited: string[] = []
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(path)
          continue
        }
        if (!path.endsWith(".tsx")) continue
        const rel = relative(process.cwd(), path)
        visited.push(rel)
        if (DILUTED_FOCUS.test(readFileSync(path, "utf-8"))) offenders.push(rel)
      }
    }
    walk(root)
    // 走査そのものの対照: 画面側のファイルを実際に訪れておること
    expect(visited).toContain(join("src", "components", "baby", "baby-date-nav.tsx"))
    expect(visited).toContain(join("src", "components", "baby", "baby-search-form.tsx"))
    expect(offenders).toEqual([])
  })

  it("対照: 薄めた focus 表示を見つけ、選択の枠や全量の ring-ring は見つけぬ", () => {
    expect(DILUTED_FOCUS.test("focus-within:ring-3 focus-within:ring-ring/50")).toBe(true)
    expect(DILUTED_FOCUS.test("dark:focus-visible:ring-ring/40")).toBe(true)
    expect(DILUTED_FOCUS.test("focus-visible:outline-ring/50")).toBe(true)
    expect(DILUTED_FOCUS.test("focus-visible:ring-destructive/20")).toBe(true)
    expect(DILUTED_FOCUS.test("focus-visible:ring-3 focus-visible:ring-ring")).toBe(false)
    expect(DILUTED_FOCUS.test("focus-visible:aria-invalid:ring-ring")).toBe(false)
    expect(DILUTED_FOCUS.test("focus-visible:border-destructive/40")).toBe(false)
    expect(DILUTED_FOCUS.test("bg-primary/12 ring-1 ring-primary/50 ring-inset")).toBe(false)
  })

  /**
   * 不正な欄（aria-invalid）は状態の印として淡い赤の輪（ring-destructive/20）を持つ。同じ詳細度の
   * `focus-visible:ring-ring` より後に出力されるゆえ、focus しても輪は淡い赤のまま（実測 1.38:1）じゃった。
   * focus 中だけ `focus-visible:aria-invalid:ring-ring`（詳細度が 1 つ高い）で --ring に戻す。赤の枠は残る。
   */
  it.each(["button", "input", "select", "textarea"])(
    "ui/%s.tsx は aria-invalid の輪を持つなら、focus 中は --ring に戻す",
    (name) => {
      const src = readFileSync(join(process.cwd(), `src/components/ui/${name}.tsx`), "utf-8")
      expect(src).toMatch(/aria-invalid:ring-destructive/)
      expect(src).toMatch(/focus-visible:aria-invalid:ring-ring(?![\w/-])/)
    },
  )
})

describe("主色を使う派生トークンは primary と対で動く", () => {
  /**
   * --ring（focus リング）・--hearth-glow（殻の背景）・--chart-1 は primary の色相・明度を
   * 写した値で、primary だけ変えると focus リングが別の橙になる。L/C/h が一致することを固定する。
   */
  it.each([":root", ".dark"])("%s: --ring / --hearth-glow / --chart-1 の L C h は --primary と同じ", (sel) => {
    const rule = topLevelRule(CSS_CODE, sel)
    const p = token(rule, "--primary")
    for (const name of ["--ring", "--hearth-glow", "--chart-1"]) {
      const t = token(rule, name)
      expect([t.L, t.C, t.h], name).toEqual([p.L, p.C, p.h])
    }
  })
})
