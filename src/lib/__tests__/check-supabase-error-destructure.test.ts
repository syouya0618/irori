import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/**
 * scripts/check-supabase-error-destructure.py の検出ロジックを fixture で検証する。
 *
 * 一時ディレクトリに .ts fixture を書き出し、スクリプトに位置引数として渡して
 * exit code と出力を assert する。Issue #14 推奨3 の再発防止ゲートが
 * (a) multi-row 単文 (b) Promise.all 要素単位 (c) `.single()` 回帰
 * の各観点で正しく動くことを担保する。
 *
 * スクリプトは line-based ヒューリスティックゆえ完全な AST 解析ではないが、
 * 回帰防止の最低ラインを担保する。
 */

const SCRIPT = path.resolve(
  __dirname,
  "../../../scripts/check-supabase-error-destructure.py",
)

type RunResult = { status: number; stdout: string; stderr: string }

function runScript(scanPath: string, strict: boolean): RunResult {
  const args = [SCRIPT, scanPath]
  if (strict) args.push("--strict")
  try {
    const stdout = execFileSync("python3", args, { encoding: "utf-8" })
    return { status: 0, stdout, stderr: "" }
  } catch (e) {
    // execFileSync は非 0 exit で throw する。code/stdout/stderr を取り出す。
    const err = e as {
      status?: number
      stdout?: Buffer | string
      stderr?: Buffer | string
    }
    return {
      status: err.status ?? -1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    }
  }
}

describe("check-supabase-error-destructure.py", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "supabase-error-check-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(name: string, content: string): void {
    const full = path.join(dir, name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, content, "utf-8")
  }

  function linesFor(stdout: string, file: string): string[] {
    return stdout.split("\n").filter((l) => l.includes(file))
  }

  it("ケース1: multi-row 単文で error 欠落を検出する (exit 1)", () => {
    write(
      "violation.ts",
      `export async function load(supabase: unknown) {
  const { data } = await supabase.from("t").select("*")
  return data
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain("violation.ts")
    expect(res.stdout).toContain('.select("*")')
  })

  it("ケース2: multi-row 単文で error 受領なら検出しない (exit 0)", () => {
    write(
      "clean.ts",
      `export async function load(supabase: unknown) {
  const { data, error } = await supabase.from("t").select("*")
  if (error) throw error
  return data
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("OK")
  })

  it("ケース3: Promise.all で第1要素のみ error 欠落 → 第1要素を検出する (exit 1)", () => {
    // 兄弟要素 (第2要素) は error を受領済み。LHS 全体には error トークンが在るが
    // 要素単位チェックにより第1要素 ({ data: a }) のみ違反として検出されること。
    write(
      "promise-all.ts",
      `export async function load(supabase: unknown) {
  const [{ data: a }, { data: b, error: bE }] = await Promise.all([supabase.from("x").select("*"), supabase.from("y").select("*")])
  return [a, b, bE]
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    const hits = linesFor(res.stdout, "promise-all.ts")
    // 1 要素のみ検出 (第2要素は error 受領済みなので報告されない)。
    expect(hits).toHaveLength(1)
  })

  it("ケース4: Promise.all で .single() 要素(error受領) と multi-row 要素(error欠落) が同居", () => {
    // multi-row 要素のみ検出され、.single() 要素は二重報告されないこと。
    write(
      "mixed.ts",
      `export async function load(supabase: unknown) {
  const [{ data: a, error: aE }, { data: b }] = await Promise.all([
    supabase.from("x").select("id").single(),
    supabase.from("y").select("id"),
  ])
  return [a, aE, b]
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    const hits = linesFor(res.stdout, "mixed.ts")
    // multi-row 要素 (.select("id") の単独行) のみ 1 件。
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('.select("id")')
    // .single() 要素は error 受領済みなので報告されない。
    expect(hits[0]).not.toContain(".single()")
  })

  it("ケース5: .single() 単文で error 欠落を検出する (pass A 回帰確認, exit 1)", () => {
    write(
      "single.ts",
      `export async function load(supabase: unknown) {
  const { data: row } = await supabase
    .from("households")
    .select("id")
    .eq("id", "h-1")
    .single()
  return row
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    expect(res.stdout).toContain("single.ts")
    expect(res.stdout).toContain(".single()")
    // pass A と pass B の二重報告を検出: 違反行はちょうど 1 件。
    expect(linesFor(res.stdout, "single.ts")).toHaveLength(1)
  })

  it("ケース6: supabase 以外の `const { data } = await fetch(...)` は誤検出しない (exit 0)", () => {
    write(
      "non-supabase.ts",
      `export async function load() {
  const res = await fetch("/api/items")
  const { data } = await res.json()
  return data
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("OK")
  })

  it("ケース7: Promise.all で全要素 error 受領なら検出しない (exit 0)", () => {
    write(
      "all-clean.ts",
      `export async function load(supabase: unknown) {
  const [{ data: a, error: aE }, { data: b, error: bE }] = await Promise.all([
    supabase.from("x").select("*"),
    supabase.from("y").select("*"),
  ])
  if (aE || bE) throw aE ?? bE
  return [a, b]
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("OK")
  })

  it("補足: --strict なしは report-only として exit 0 (フラグ区別の回帰)", () => {
    write(
      "violation.ts",
      `export async function load(supabase: unknown) {
  const { data } = await supabase.from("t").select("id")
  return data
}
`,
    )
    const res = runScript(dir, false)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("violation.ts")
  })

  // ── pass C: 書き込み (insert/update/upsert/delete) ────────────────────
  // 従来アンカーは `.single()` と `.(select|rpc)(` のみで、
  // `await supabase.from(x).delete().eq(...)` は 1 件も走査されなかった。

  it("ケース8: bare な書き込み statement を検出する（誰も error を受け取らない）", () => {
    write(
      "bare-write.ts",
      `export async function remove(supabase: unknown, id: string) {
  await supabase.from("meal_ingredients").delete().eq("meal_id", id)
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    const hits = linesFor(res.stdout, "bare-write.ts")
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain(".delete()")
  })

  it("ケース9: 改行チェーンの bare な書き込みも検出する", () => {
    write(
      "bare-write-chain.ts",
      `export async function unlink(supabase: unknown, id: string) {
  await supabase
    .from("meals")
    .update({ template_id: null })
    .eq("template_id", id)
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    expect(linesFor(res.stdout, "bare-write-chain.ts")).toHaveLength(1)
  })

  it("ケース10: 書き込みで error を受け取っていれば検出しない (exit 0)", () => {
    write(
      "write-ok.ts",
      `export async function remove(supabase: unknown, id: string) {
  const { error } = await supabase
    .from("meals")
    .delete()
    .eq("id", id)
  if (error) throw error
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("OK")
  })

  it("ケース11: 書き込みの destructure で error 欠落を検出する", () => {
    write(
      "write-no-error.ts",
      `export async function add(supabase: unknown, row: unknown) {
  const { data } = await supabase.from("stock_items").insert(row)
  return data
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    expect(linesFor(res.stdout, "write-no-error.ts")).toHaveLength(1)
  })

  it("ケース12: 書き込み + .select() の destructure は pass B が担当し二重報告しない", () => {
    write(
      "write-select.ts",
      `export async function remove(supabase: unknown, id: string) {
  const { data } = await supabase
    .from("shopping_items")
    .delete()
    .eq("id", id)
    .select("id")
  return data
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(1)
    // 違反は 1 件のみ（pass B が `.select(` 行で報告。pass C は dedup で黙る）。
    const hits = linesFor(res.stdout, "write-select.ts")
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('.select("id")')
  })

  it("ケース13: supabase ではない .delete()/.update() は誤検出しない (exit 0)", () => {
    write(
      "non-supabase-write.ts",
      `export function prune(set: Set<string>, key: string) {
  set.delete(key)
}

export async function refresh(registration: { update(): Promise<void> }) {
  await registration.update()
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    expect(res.stdout).toContain("OK")
    // 走査対象にも数えない（checked が誤検出で水増しされないこと）。
    expect(res.stdout).toContain("(write): 0")
  })

  it("ケース14: checked は走査数を pass 別に出す（アンカー全滅の偽緑を見破る）", () => {
    write(
      "counted.ts",
      `export async function mixed(supabase: unknown, id: string) {
  const { data: a, error: aE } = await supabase.from("t").select("id")
  const { data: b, error: bE } = await supabase.from("t").select("id").eq("id", id).single()
  const { error: cE } = await supabase.from("t").delete().eq("id", id)
  return [a, aE, b, bE, cE]
}
`,
    )
    const res = runScript(dir, true)
    expect(res.status).toBe(0)
    // write アンカーが死ねば "(write): 0" になり、この assert が赤くなる。
    expect(res.stdout).toMatch(/checked \(single\): [1-9]/)
    expect(res.stdout).toMatch(/\(multi-row\): [1-9]/)
    expect(res.stdout).toMatch(/\(write\): [1-9]/)
  })
})
