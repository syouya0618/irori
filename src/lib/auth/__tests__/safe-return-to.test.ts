/**
 * open redirect 防止の唯一の判定源。
 *
 * 認証の着地点は増えていく（`/auth/callback`・`/auth/confirm`・今後の何か）。
 * 各々が自前の判定を持つと**片方だけ緩んだ時に誰も気づかぬ** —— そして
 * 緩んだ方は「ログイン直後に任意の外部サイトへ飛ばせる」入口になる。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { safeReturnTo } from "../safe-return-to"

describe("safeReturnTo", () => {
  it.each(["/baby", "/meals?date=2026-08-10", "/settings#notify", "/"])(
    "同一オリジンの相対パス %s は通す",
    (path) => {
      expect(safeReturnTo(path)).toBe(path)
    }
  )

  // 「通る側」と対で置く（片側だけだと常に null を返す実装を素通しする）
  it.each([
    ["絶対 URL", "https://evil.example.com"],
    ["スキーム相対（`/` 判定を素通りしながら別オリジンになる）", "//evil.example.com"],
    ["バックスラッシュ二連", "/\\evil.example.com"],
    ["javascript スキーム", "javascript:alert(1)"],
    ["スキーム無しのホスト", "evil.example.com"],
    ["空文字", ""],
    ["null", null],
    ["undefined", undefined],
  ])("%s は弾く", (_label, value) => {
    expect(safeReturnTo(value)).toBeNull()
  })
})

describe("判定源は 1 つ", () => {
  const CONSUMERS = [
    "src/app/auth/callback/route.ts",
    "src/app/auth/confirm/route.ts",
  ]

  it.each(CONSUMERS)("%s は safeReturnTo を使う", (file) => {
    const src = readFileSync(resolve(process.cwd(), file), "utf8")
    expect(src).toMatch(/safeReturnTo\s*\(/)
  })

  it.each(CONSUMERS)("%s は判定を自前で書き直さぬ", (file) => {
    const offending = readFileSync(resolve(process.cwd(), file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .filter((l) => /startsWith\(\s*["']\/\/?["']\s*\)/.test(l))
    expect(offending).toEqual([])
  })
})
