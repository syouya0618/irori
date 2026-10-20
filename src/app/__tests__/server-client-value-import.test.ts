/**
 * Server Component が use client 指令のファイルから**値**を import しておらぬかを走査する。
 *
 * Next.js は client module の export を client reference に差し替えるため、Server 側で
 * その関数を呼ぶと実行時に throw し（"Attempted to call X() from the server…"）、定数は
 * 文字列として使えぬ。tsc も next build も vitest（jsdom）も通ったまま、実ブラウザで初めて
 * 落ちる（irori 2026-07-26 の `EVENT_COLUMNS`、2026-10-20 のレビューで見つかった
 * `getLogSummary`）。型（`import type` / `type X`）はビルド時に消えるため安全。
 * Component（PascalCase）を描画するのは正当な境界ゆえ許す。
 *
 * 走査: src/app の page / layout / template / loading / not-found / default / route を
 * Server の起点にし、境界指令を持たぬモジュールを辿る。use client のモジュールに当たったら
 * import した名前が Component 風（先頭大文字・小文字を含む・下線なし）でなければ違反。
 */

import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../..")
const SRC = path.join(ROOT, "src")
const APP = path.join(SRC, "app")

const ENTRY_FILE = /^(page|layout|template|loading|not-found|default|route)\.(ts|tsx)$/

type Directive = "client" | "server" | null

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

/** 先頭のコメントと空白を飛ばした最初の文が指令かを見る（本文中の文字列には反応せぬ） */
function directiveOf(source: string): Directive {
  const head = stripComments(source).replace(/^﻿/, "").trimStart()
  const m = /^["'](use client|use server)["']/.exec(head)
  if (!m) return null
  return m[1] === "use client" ? "client" : "server"
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "node_modules") continue
      walk(full, out)
    } else if (ENTRY_FILE.test(name)) {
      out.push(full)
    }
  }
}

function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier)
  else return null
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && /\.(ts|tsx)$/.test(c)) return c
  }
  return null
}

interface ImportSite {
  specifier: string
  /** 値として import した名前（型だけの import は含まぬ）。`*` は namespace */
  valueNames: string[]
}

const IMPORT_RE =
  /(?:^|\n)\s*(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*["']([^"']+)["']/g

function importsOf(source: string): ImportSite[] {
  const code = stripComments(source)
  const sites: ImportSite[] = []
  for (const m of code.matchAll(IMPORT_RE)) {
    const [, , typeOnly, clause, specifier] = m
    if (typeOnly) continue
    const valueNames: string[] = []
    let rest = clause.trim()
    const braces = /\{([\s\S]*?)\}/.exec(rest)
    if (braces) {
      for (const raw of braces[1].split(",")) {
        const item = raw.trim()
        if (!item || item.startsWith("type ")) continue
        // `a as b` は元の名前 a で判定する（export 元の実体が何かで決まる）
        valueNames.push(item.split(/\s+as\s+/)[0].trim())
      }
      rest = rest.replace(braces[0], "").trim()
    }
    for (const part of rest.split(",")) {
      const item = part.trim()
      if (!item) continue
      if (item.startsWith("*")) valueNames.push("*")
      else valueNames.push(item)
    }
    sites.push({ specifier, valueNames })
  }
  return sites
}

/** Component 風の名前: 先頭が大文字で小文字を含み、下線を持たぬ（EVENT_COLUMNS / TODAY は値） */
function looksLikeComponent(name: string): boolean {
  return /^[A-Z](?=.*[a-z])[A-Za-z0-9]*$/.test(name)
}

interface Violation {
  file: string
  target: string
  names: string[]
}

function scan(): { violations: Violation[]; visited: number; clientBoundaries: number } {
  const entries: string[] = []
  walk(APP, entries)
  const visited = new Set<string>()
  const queue = [...entries]
  const violations: Violation[] = []
  let clientBoundaries = 0

  while (queue.length > 0) {
    const file = queue.pop()!
    if (visited.has(file)) continue
    visited.add(file)
    const source = readFileSync(file, "utf8")
    // 起点が client（error.tsx 等）なら Server 側の走査対象ではない
    if (directiveOf(source) !== null) continue
    for (const site of importsOf(source)) {
      const target = resolveSpecifier(file, site.specifier)
      if (!target) continue
      const targetDirective = directiveOf(readFileSync(target, "utf8"))
      if (targetDirective === "server") continue
      if (targetDirective === "client") {
        clientBoundaries++
        const bad = site.valueNames.filter((n) => !looksLikeComponent(n))
        if (bad.length > 0) {
          violations.push({
            file: path.relative(ROOT, file),
            target: path.relative(ROOT, target),
            names: bad,
          })
        }
        continue
      }
      queue.push(target)
    }
  }
  return { violations, visited: visited.size, clientBoundaries }
}

describe("Server Component から use client のファイルへの値 import", () => {
  const result = scan()

  it("走査が空回りしておらぬ（起点と client 境界を実際に辿っておる）", () => {
    expect(result.visited).toBeGreaterThan(20)
    expect(result.clientBoundaries).toBeGreaterThan(5)
  })

  it("use client のファイルから Server 側が値（関数・定数）を import しておらぬ", () => {
    const lines = result.violations.map(
      (v) => `${v.file} → ${v.target}: ${v.names.join(", ")}`,
    )
    expect(lines).toEqual([])
  })

  it("判定の対照: 指令の検出は先頭の文だけを見る（本文中の文字列や関数名には反応せぬ）", () => {
    expect(directiveOf('"use client"\nimport x from "y"')).toBe("client")
    expect(directiveOf('// comment\n/* block */\n"use server"\n')).toBe("server")
    expect(directiveOf('const s = "use client"\n')).toBeNull()
    expect(looksLikeComponent("BabyDashboard")).toBe(true)
    expect(looksLikeComponent("PWAInstallPrompt")).toBe(true)
    expect(looksLikeComponent("getLogSummary")).toBe(false)
    expect(looksLikeComponent("EVENT_COLUMNS")).toBe(false)
    expect(looksLikeComponent("*")).toBe(false)
  })
})
