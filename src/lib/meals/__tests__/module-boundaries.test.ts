import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

/**
 * ごはんの純粋ロジックの境界を固定する。
 * 旧 Irori の欠陥 (d)「削除済みテーブル・モジュールへの依存」の回帰テストでもある。
 */

const MODULES = [
  "units.ts",
  "normalize.ts",
  "lookup.ts",
  "exclusion-terms.ts",
  "exclusions.ts",
  "child-serving.ts",
  "pantry-match.ts",
  "preferences.ts",
  "suggest-now.ts",
  "planner.ts",
  "grocery.ts",
  "wish-rules.ts",
] as const

const DIR = path.resolve(__dirname, "..")

function read(file: string): string {
  return readFileSync(path.join(DIR, file), "utf8")
}

/** コメントを除いた実コード（文書中の語を実コードと混同しないため）。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

function importsOf(source: string): string[] {
  return [...codeOnly(source).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])
}

describe("検査そのものの対照（検知できることを確かめる）", () => {
  it("import の抽出は、コメント中の from を拾わず、実コードの from を拾う", () => {
    const sample = `// import x from "@/lib/supabase/server"\n/* from "ghost" */\nimport { a } from "./real"\n`
    expect(importsOf(sample)).toEqual(["./real"])
  })
})

describe.each(MODULES)("%s", (file) => {
  const source = read(file)
  const code = codeOnly(source)
  const imports = importsOf(source)

  it("旧欠陥 (d) の回帰: 削除済みの献立モジュール・DB の型・Supabase に依存しない", () => {
    const forbidden = imports.filter(
      (target) =>
        target.startsWith("@/lib/supabase") ||
        target.startsWith("@/lib/types/database") ||
        /^@\/lib\/domain\/(ranking|matching|normalize|scoring|types|index|item-category-guess|stock-form|consumption-rate)$/.test(target) ||
        target === "@/lib/domain" ||
        target.startsWith("@/app") ||
        target.startsWith("@/components"),
    )
    expect(forbidden).toEqual([])
  })

  it("依存先は、同じディレクトリの中立モジュールと日付・月齢の純関数だけ", () => {
    const allowed = new Set(["@/lib/utils/date-jst", "@/lib/domain/child-age"])
    const outside = imports.filter((target) => !target.startsWith("./") && !allowed.has(target))
    expect(outside).toEqual([])
    // カタログのデータ（食材辞書・レシピ・アレルゲン）を直接 import しない。データは引数で受け取る。
    // 例外は売場の定義（並び順と表示名の正本）だけ
    const catalogImports = imports.filter((target) => target.startsWith("./catalog"))
    expect(catalogImports.filter((target) => target !== "./catalog/sections")).toEqual([])
  })

  it("境界指令を持たない中立モジュール（use client / use server を書かない）", () => {
    expect(code).not.toMatch(/^\s*["']use (client|server)["']/m)
  })

  it("決定的: 乱数・現在時刻・環境変数を読まない", () => {
    expect(code).not.toMatch(/Math\.random\s*\(/)
    expect(code).not.toMatch(/Date\.now\s*\(/)
    expect(code).not.toMatch(/new Date\s*\(/)
    expect(code).not.toMatch(/process\.env/)
  })

  it("旧テーブル名・旧 ENUM 名を使わない", () => {
    expect(code).not.toMatch(/\b(meal_templates|meal_ingredients|meal_reactions|shopping_items|stock_items|purchase_history|eating_out_logs|item_category|meal_reaction)\b/)
  })

  it("保証や監修を装う文言を持たない（コメントを含めて検査）", () => {
    expect(source).not.toMatch(/栄養バランス|管理栄養士|監修済み|アレルゲン不使用|安全です/)
  })
})
