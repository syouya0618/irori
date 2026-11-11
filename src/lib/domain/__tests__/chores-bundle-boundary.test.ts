/**
 * X-04: 家事の重いコード（献立のカタログ・計算・AI アダプター・掃除の周期計算）を、育児トップ（/baby）の
 * 読み込みへ載せぬ。
 *
 * 育児トップと、その外側の layout から**値 import で到達できるモジュール**を辿り、家事のモジュールが
 * 「予定カードがごみの日を描くのに要る小さなもの」だけに留まることを固定する。Server / Client の
 * 区別はせず全部を辿る（サーバー側の読み込みも含めて、献立のカタログが育児トップへ紛れ込まぬ向き）。
 *
 * build 出力（route ごとの chunk）の代わりではない — ここは import の到達だけを見る。型だけの import
 * （`import type` / `export type`）は bundle に残らぬゆえ辿らぬ。
 */
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "../../../..")
const SRC = path.join(ROOT, "src")

/** コメントを除いた実コード（文書中の import を実コードと混同せぬ）。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

/** 値として残る import / re-export / 動的 import の指定子（型だけの文は除く）。 */
function valueImports(source: string): string[] {
  const code = codeOnly(source)
  const out: string[] = []
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^"';]*?\s*from\s*["']([^"']+)["']/g)) {
    if (!m[1]) out.push(m[2])
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) out.push(m[1])
  for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  return out
}

/** リポジトリ内のファイルへ解決する。パッケージは null、解決できぬ内部の指定子は undefined。 */
function resolveImport(from: string, spec: string): string | null | undefined {
  let base: string
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec)
  else return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

function reachableFrom(entries: string[]): { files: string[]; unresolved: string[] } {
  const seen = new Set<string>()
  const unresolved: string[] = []
  const stack = entries.map((entry) => path.join(ROOT, entry))
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.tsx?$/.test(file)) continue
    for (const spec of valueImports(readFileSync(file, "utf8"))) {
      const resolved = resolveImport(file, spec)
      if (resolved === null) continue
      if (resolved === undefined) unresolved.push(`${path.relative(ROOT, file)} -> ${spec}`)
      else stack.push(resolved)
    }
  }
  return { files: [...seen].map((file) => path.relative(ROOT, file).split(path.sep).join("/")).sort(), unresolved }
}

/** 育児トップを開いた時に読まれうる入口（root layout・(main) の layout / loading・育児トップ）。 */
const BABY_ENTRIES = [
  "src/app/layout.tsx",
  "src/app/(main)/layout.tsx",
  "src/app/(main)/loading.tsx",
  "src/app/(main)/baby/page.tsx",
  "src/app/(main)/baby/loading.tsx",
  "src/app/(main)/baby/error.tsx",
].filter((entry) => existsSync(path.join(ROOT, entry)))

/** 家事（ごみ・掃除・ごはん）のために足したモジュールか。 */
const CHORES_RELATED = /chores|\/meals\/|garbage|cleaning|event-purpose|chore-pending|rpc-outcome|ymd-math/

/** 育児トップへ載せてはならぬ重いもの。 */
const HEAVY: { label: string; pattern: RegExp }[] = [
  { label: "献立のカタログ・計算・AI アダプター", pattern: /^src\/lib\/meals\// },
  { label: "ごはんの画面", pattern: /^src\/components\/chores\/meals\// },
  { label: "掃除の画面", pattern: /^src\/components\/chores\/cleaning\// },
  { label: "掃除の周期計算", pattern: /^src\/lib\/domain\/cleaning/ },
  { label: "家事ハブの読み取り", pattern: /^src\/lib\/supabase\/chores-hub-query\.ts$/ },
  { label: "ごみの画面の読み取り", pattern: /^src\/lib\/supabase\/garbage-overview-query\.ts$/ },
  { label: "家事の route", pattern: /^src\/app\/\(main\)\/chores\// },
]

describe("検査そのものの対照（検知できることを確かめる）", () => {
  it("値 import は拾い、型だけの import・コメント中の import は拾わぬ", () => {
    const sample = [
      `// import x from "@/lib/meals/planner"`,
      `/* import y from "ghost" */`,
      `import type { A } from "./types-only"`,
      `export type { B } from "./types-only-2"`,
      `import { type C, d } from "./mixed"`,
      `import e from "./default"`,
      `import "./side-effect"`,
      `export { f } from "./re-export"`,
      `const g = await import("./dynamic")`,
    ].join("\n")
    expect(valueImports(sample).sort()).toEqual(["./default", "./dynamic", "./mixed", "./re-export", "./side-effect"])
  })

  it("家事ハブ（/chores）からは献立のカタログへ到達する（辿り方が重いモジュールを検知できる）", () => {
    const hub = reachableFrom(["src/app/(main)/chores/page.tsx"])
    expect(hub.unresolved).toEqual([])
    expect(hub.files).toContain("src/lib/supabase/chores-hub-query.ts")
    expect(hub.files).toContain("src/lib/meals/catalog/recipes.ts")
    expect(hub.files).toContain("src/lib/meals/catalog/ingredients.ts")
    expect(hub.files).toContain("src/lib/domain/cleaning-schedule.ts")
  })
})

// ───────────────────────── Server → "use client" の値 import ─────────────────────────

const isClientFile = (source: string) => /^\s*["']use client["']/.test(codeOnly(source))

/** `import { a, type B, c as d } from "x"` / `import e from "x"` の、値として取り込む名前（元の名前）。 */
function importedValueNames(source: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = []
  for (const m of codeOnly(source).matchAll(/(?:^|\n)\s*import\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[1]) continue
    const clause = m[2]
    const names: string[] = []
    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) {
      for (const part of braces[1].split(",")) {
        const item = part.trim()
        if (item === "" || item.startsWith("type ")) continue
        names.push(item.split(/\s+as\s+/)[0].trim())
      }
    }
    const head = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim()
    if (head !== "" && !head.startsWith("*")) names.push(head)
    if (head.startsWith("*")) names.push("*")
    out.push({ spec: m[3], names })
  }
  return out
}

/** コンポーネントの名前か（先頭が大文字で、小文字を含む。`SOME_CONSTANT` は違う）。 */
const isComponentName = (name: string) => /^[A-Z]/.test(name) && /[a-z]/.test(name)

/**
 * Server Component から辿り（"use client" のファイルの中へは入らぬ）、"use client" のファイルから
 * コンポーネント以外の値を取り込んでおる import を集める。
 *
 * Next.js は client module の export を client reference へ差し替えるゆえ、定数・関数を Server 側で
 * 値として使うと実行時に壊れる（tsc も build も通る）。コンポーネントを描くだけなら正しい。
 */
function clientImportsFromServer(entry: string): { edge: string; name: string }[] {
  const edges: { edge: string; name: string }[] = []
  const seen = new Set<string>()
  const stack = [path.join(ROOT, entry)]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (seen.has(file)) continue
    seen.add(file)
    if (!/\.tsx?$/.test(file)) continue
    for (const { spec, names } of importedValueNames(readFileSync(file, "utf8"))) {
      const resolved = resolveImport(file, spec)
      if (!resolved) continue
      if (isClientFile(readFileSync(resolved, "utf8"))) {
        for (const name of names) edges.push({ edge: `${path.relative(ROOT, file)} <- ${spec}`, name })
      } else {
        stack.push(resolved)
      }
    }
  }
  return edges
}

function clientValueImportsFromServer(entry: string): string[] {
  return clientImportsFromServer(entry)
    .filter(({ name }) => !isComponentName(name))
    .map(({ edge, name }) => `${edge}: ${name}`)
}

describe("家事の Server Component は \"use client\" のファイルから定数・関数を値 import せぬ", () => {
  it("検査の対照: 定数・関数・名前空間は拾い、コンポーネントと型は拾わぬ", () => {
    const sample = [
      `import Default, { Card, LIMIT, helper, type Props, Other as Renamed } from "./a"`,
      `import type { OnlyType } from "./b"`,
      `import * as all from "./c"`,
    ].join("\n")
    expect(importedValueNames(sample)).toEqual([
      { spec: "./a", names: ["Card", "LIMIT", "helper", "Other", "Default"] },
      { spec: "./c", names: ["*"] },
    ])
    expect(["Card", "Default", "Other"].every(isComponentName)).toBe(true)
    expect(["LIMIT", "helper", "*", "activeSegmentHref"].some(isComponentName)).toBe(false)
  })

  it("検査の対照: 家事ハブから \"use client\" のファイルへの境界（取り直しの部品）まで辿れておる", () => {
    const names = clientImportsFromServer("src/app/(main)/chores/page.tsx").map(({ name }) => name)
    expect(names).toContain("RefreshOnVisible")
  })

  const pages = [
    "src/app/(main)/chores/page.tsx",
    "src/app/(main)/chores/garbage/page.tsx",
    "src/app/(main)/chores/cleaning/page.tsx",
    "src/app/(main)/chores/meals/layout.tsx",
    "src/app/(main)/chores/meals/page.tsx",
    "src/app/(main)/chores/meals/now/page.tsx",
    "src/app/(main)/chores/meals/plan/page.tsx",
    "src/app/(main)/chores/meals/shopping/page.tsx",
    "src/app/(main)/chores/meals/pantry/page.tsx",
    "src/app/(main)/chores/meals/settings/page.tsx",
    "src/app/(main)/chores/meals/recipes/[id]/page.tsx",
  ]

  it.each(pages)("%s", (page) => {
    expect(existsSync(path.join(ROOT, page))).toBe(true)
    expect(isClientFile(readFileSync(path.join(ROOT, page), "utf8"))).toBe(false)
    expect(clientValueImportsFromServer(page)).toEqual([])
  })
})

describe("育児トップ（/baby）の読み込み", () => {
  const baby = reachableFrom(BABY_ENTRIES)

  it("入口が在り、内部の import を全部解決できておる（辿り漏れが無い）", () => {
    expect(BABY_ENTRIES).toContain("src/app/(main)/baby/page.tsx")
    expect(BABY_ENTRIES).toContain("src/app/(main)/layout.tsx")
    expect(baby.unresolved).toEqual([])
    // 辿れておる証拠: 育児の本体と下ナビへ届いておる
    expect(baby.files).toContain("src/components/baby/baby-dashboard.tsx")
    expect(baby.files).toContain("src/components/common/bottom-nav.tsx")
  })

  it.each(HEAVY)("$label へ到達せぬ", ({ pattern }) => {
    expect(baby.files.filter((file) => pattern.test(file))).toEqual([])
  })

  it("到達する家事のモジュールは、予定カードのごみの表示・骨組み・端末の控えの掃除に要るものだけ", () => {
    // ここへ足す時は、それが育児トップの読み込みへ載ることを承知のうえで足すこと
    expect(baby.files.filter((file) => CHORES_RELATED.test(file))).toEqual([
      "src/components/chores/garbage/garbage-kind-icon.tsx",
      "src/components/common/loading/chores-loading.tsx",
      "src/lib/domain/chore-pending.ts",
      "src/lib/domain/garbage.ts",
      "src/lib/supabase/event-purpose-query.ts",
    ])
  })
})
