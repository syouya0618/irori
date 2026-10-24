import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { getLogSummary } from "../baby-log-summary"
import type { BabyLogData } from "@/lib/types/baby"

function log(overrides: Partial<BabyLogData> & Pick<BabyLogData, "log_type">): BabyLogData {
  return {
    id: "l1",
    logged_at: "2026-10-19T03:00:00+00:00",
    logged_by: "u1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-10-19T03:00:00+00:00",
    ...overrides,
  }
}

describe("getLogSummary（タイムラインと検索結果が共有する 1 行の要約）", () => {
  it("中立モジュール（境界指令なし）に置かれておる — Server Component からも値として呼べる", () => {
    const source = readFileSync(path.join(__dirname, "../baby-log-summary.ts"), "utf8")
    const head = source.replace(/\/\*[\s\S]*?\*\//g, "").trimStart()
    expect(head.startsWith('"use client"')).toBe(false)
    expect(head.startsWith('"use server"')).toBe(false)
  })

  it("種別ごとの退化形: 値の無い行は種別名だけ", () => {
    expect(getLogSummary(log({ log_type: "feeding" }))).toBe("授乳")
    expect(getLogSummary(log({ log_type: "diaper" }))).toBe("おむつ")
    expect(getLogSummary(log({ log_type: "temperature" }))).toBe("体温")
    expect(getLogSummary(log({ log_type: "growth" }))).toBe("成長記録")
    expect(getLogSummary(log({ log_type: "memo" }))).toBe("メモ")
    expect(getLogSummary(log({ log_type: "sleep" }))).toBe("睡眠")
  })

  it("値を持つ行", () => {
    expect(getLogSummary(log({ log_type: "temperature", temperature: 37.2 }))).toBe("37.2℃")
    expect(getLogSummary(log({ log_type: "growth", weight_g: 5200, height_cm: 60 }))).toBe(
      "5200g / 60cm",
    )
    expect(getLogSummary(log({ log_type: "memo", memo: "あ".repeat(30) }))).toBe(
      "あ".repeat(20),
    )
  })
})
