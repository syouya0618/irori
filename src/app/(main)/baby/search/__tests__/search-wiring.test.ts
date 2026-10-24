/**
 * baby/search/page.tsx の**配線**を縛る（機能 B）。
 *
 * page.tsx を描画するテストは無い（Supabase の chain を 5 本ぶん模す費用に見合わぬ）ため、
 * 本番の意味を決める行を source 走査で固定する: 世帯の境界・ILIKE の escape・keyset の
 * ページ送り・件数の exact count。走査の空振りを偽緑にせぬよう、まず読めておることを固定する。
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/baby/search/page.tsx")

function pageSource(): string {
  return readFileSync(PAGE, "utf8")
}

function pageCode(): string {
  return pageSource()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

describe("baby/search/page の配線", () => {
  it("走査が空回りしておらぬ", () => {
    expect(pageSource().length).toBeGreaterThan(0)
    expect(pageSource()).toContain("BabySearchResults")
  })

  it("記録・日記・世帯員の問い合わせは全て household_id で絞る（RLS と二重）", () => {
    const code = pageCode()
    const occurrences = code.match(/\.eq\("household_id", householdId\)/g) ?? []
    // logsBase / diariesBase / profiles の 3 箇所
    expect(occurrences.length).toBeGreaterThanOrEqual(3)
  })

  it("検索語は toIlikePattern で escape してから ilike に渡す（生の文字列を渡さぬ）", () => {
    const code = pageCode()
    expect(code).toContain("toIlikePattern(query.q)")
    expect(code).toMatch(/\.ilike\("memo", pattern\)/)
    expect(code).toMatch(/\.ilike\("content", pattern\)/)
    expect(code).not.toMatch(/ilike\([^)]*query\.q/)
  })

  it("ページは (logged_at, id) の keyset で送り、件数は exact count で数える", () => {
    const code = pageCode()
    // keyset の条件文字列（引用符・比較の向き）は baby-log-keyset.ts が正本で、その
    // 単体テストが文字列を固定する。ここでは「その部品を降順で使う」配線だけを見る
    // （PDF・JSON と同じ実装を共有し、ページだけ自前の条件を書き直さぬこと）。
    expect(code).toMatch(/withBabyLogKeyset\([\s\S]*?query\.before,\s*"desc",?\s*\)/)
    expect(code).not.toMatch(/logged_at\.(lt|gt)\./)
    expect(code).toContain(".limit(SEARCH_PAGE_SIZE + 1)")
    expect(code).toContain('{ count: "exact", head: true }')
    expect(code).toContain('.order("logged_at", { ascending: false })')
    expect(code).toContain('.order("id", { ascending: false })')
  })

  it("条件の読み取りは parseBabySearchParams に閉じる（クエリ名をここで書かぬ）", () => {
    const code = pageCode()
    expect(code).toContain("parseBabySearchParams(await searchParams")
    expect(code).not.toMatch(/searchParams\.(q|kind|from|to|before)\b/)
  })

  it("検索結果（Server Component）は要約を中立モジュールから取り、use client のファイルから値を import せぬ", () => {
    // レビューで見つかった P1: "use client" の baby-timeline-item から getLogSummary を
    // 値 import しており、結果が 1 件でもあれば Server 描画で throw しておった
    const results = readFileSync(
      path.join(ROOT, "src/components/baby/baby-search-results.tsx"),
      "utf8",
    )
    expect(results).toContain(
      'import { getLogSummary } from "@/lib/domain/baby-log-summary"',
    )
    expect(results).not.toMatch(/import \{[^}]*\} from "\.\/baby-timeline-item"/)
    const summary = readFileSync(path.join(ROOT, "src/lib/domain/baby-log-summary.ts"), "utf8")
    expect(summary.trimStart().startsWith('"use client"')).toBe(false)
  })
})
