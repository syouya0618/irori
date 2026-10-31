/**
 * The required children migration makes the selected child's row authoritative for SSR.
 * Reuse that row and the shared decoder; keep client refresh queries independent.
 */
import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(__dirname, "../../../../..")
const PAGE = path.join(ROOT, "src/app/(main)/baby/page.tsx")

function pageCode(): string {
  return readFileSync(PAGE, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

function dashboardProps(): string {
  const code = pageCode()
  const start = code.indexOf("<BabyDashboard")
  if (start < 0) return ""
  const end = code.indexOf("/>", start)
  return end < 0 ? "" : code.slice(start, end)
}

describe("baby/page → いつものミルク量の配線", () => {
  it("走査が空回りしておらぬ", () => {
    expect(pageCode().length).toBeGreaterThan(0)
    expect(dashboardProps()).toContain("householdId={householdId}")
  })

  it("既に読んだ子どもの行を再利用し、未設定とエラーの判定は共通decoderに任せる", () => {
    const code = pageCode()
    expect(code).toContain("{ data: child, error: null }")
    expect(code).not.toContain("selectBottleDefault(")
    expect(code).toContain("decodeBottleDefault(bottleDefaultResult)")
    expect(dashboardProps()).toContain("initialBottleDefault={bottleDefault}")
  })

  it("プロフィールは子どものコンテキストから取得し、量を子どもで指定する", () => {
    const code = pageCode()
    expect(code).toContain("await getChildContext(")
    expect(code).toContain("babyName={child.name || null}")
    expect(code).not.toContain('.from("households")')
  })
})
