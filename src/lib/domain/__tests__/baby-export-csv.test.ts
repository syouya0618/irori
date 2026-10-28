/**
 * CSV のセル（E2・AC23 の unit 層）。危険なセルと安全なセルを対にして固定する。
 */
import { describe, it, expect } from "vitest"
import {
  buildCsv,
  csvNumberCell,
  csvTextCell,
  CSV_BOM,
  diariesToCsv,
  jstDateTimeText,
  logsToCsv,
} from "../baby-export-csv"
import type { BabyLogData } from "@/lib/types/baby"

/** 表計算の解釈をまねる最小の RFC 4180 読み取り（テストの検証用） */
function parseCsv(text: string): string[][] {
  const body = text.startsWith(CSV_BOM) ? text.slice(1) : text
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ",") {
      row.push(cell)
      cell = ""
    } else if (ch === "\r" && body[i + 1] === "\n") {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
      i++
    } else cell += ch
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

describe("csvTextCell（式の注入を無効化）", () => {
  it.each([
    ["=1+1", `"'=1+1"`],
    ["+81 90", `"'+81 90"`],
    ["-5ml", `"'-5ml"`],
    ["@SUM(A1)", `"'@SUM(A1)"`],
    ["\tタブ", `"'\tタブ"`],
    ["\r改行", `"'\r改行"`],
    ["\n改行", `"'\n改行"`],
    ["＝全角", `"'＝全角"`],
    ["＋全角", `"'＋全角"`],
    ["－全角", `"'－全角"`],
    ["＠全角", `"'＠全角"`],
  ])("危険な先頭 %j は ' を付ける", (input, expected) => {
    expect(csvTextCell(input)).toBe(expected)
  })

  it.each([
    ["ミルク 160ml", `"ミルク 160ml"`],
    ["途中の = は触らぬ", `"途中の = は触らぬ"`],
    ["", `""`],
  ])("対照: 安全な %j はそのまま（囲むだけ）", (input, expected) => {
    expect(csvTextCell(input)).toBe(expected)
  })

  it("引用符は二重にし、カンマ・改行は 1 セルに収める（区切りを差し込ませぬ）", () => {
    const value = 'a","=cmd()\r\nb,c'
    const csv = buildCsv(["メモ"], [[{ text: value }]])
    const parsed = parseCsv(csv)
    expect(parsed).toEqual([["メモ"], [value]])
  })

  it("null は空欄", () => {
    expect(csvTextCell(null)).toBe("")
  })
})

describe("csvNumberCell（数値は数値のまま）", () => {
  it("数値は引用符も ' も付けぬ", () => {
    expect(csvNumberCell(160)).toBe("160")
    expect(csvNumberCell(36.8)).toBe("36.8")
    expect(csvNumberCell(0)).toBe("0")
  })
  it("null・NaN・無限は空欄", () => {
    expect(csvNumberCell(null)).toBe("")
    expect(csvNumberCell(Number.NaN)).toBe("")
    expect(csvNumberCell(Number.POSITIVE_INFINITY)).toBe("")
  })
})

describe("buildCsv", () => {
  it("UTF-8 の BOM で始まり、行末は CRLF", () => {
    const csv = buildCsv(["日付"], [[{ text: "2026-10-27" }]])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.endsWith("\r\n")).toBe(true)
    expect(csv.slice(1)).toBe('"日付"\r\n"2026-10-27"\r\n')
  })
})

describe("logsToCsv / diariesToCsv", () => {
  const log: BabyLogData = {
    id: "00000000-0000-4000-8000-000000000001",
    log_type: "feeding",
    logged_at: "2026-10-26T15:30:00.123456+00:00",
    logged_by: "user-1",
    feeding_type: "breast",
    amount_ml: null,
    breast_left_count: 1,
    breast_right_count: 1,
    breast_left_sec: 300,
    breast_right_sec: 240,
    breast_start_side: "left",
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: 9,
    duration_sec: 540,
    memo: "=危険\n2行目",
    created_at: "2026-10-26T15:39:00+00:00",
    updated_at: "2026-10-26T15:39:00.654321+00:00",
  }

  it("記録 1 行: 時刻の表記はそのまま・JST の日時・左右秒と合計は数値・メモは式を無効化", () => {
    const rows = parseCsv(logsToCsv([log], new Map([["user-1", "はな"]])))
    expect(rows).toHaveLength(2)
    const header = rows[0]
    const row = Object.fromEntries(header.map((h, i) => [h, rows[1][i]]))
    expect(row["日時(UTC ISO)"]).toBe("2026-10-26T15:30:00.123456+00:00")
    expect(row["日時(JST)"]).toBe("2026-10-27 00:30")
    expect(row["左の秒"]).toBe("300")
    expect(row["右の秒"]).toBe("240")
    expect(row["合計の秒"]).toBe("540")
    expect(row["メモ"]).toBe("'=危険\n2行目")
    expect(row["記録した人"]).toBe("はな")
    expect(row["更新(UTC ISO)"]).toBe("2026-10-26T15:39:00.654321+00:00")
  })

  it("数値の列は引用符なし（表計算が数値として読む）", () => {
    const csv = logsToCsv([log], new Map())
    expect(csv).toContain(",300,240,1,1,")
  })

  it("名前の分からぬ記録者は id のまま（空欄にして誰の記録か消さぬ）", () => {
    const rows = parseCsv(logsToCsv([log], new Map()))
    expect(rows[1]).toContain("user-1")
  })

  it("日記: 本文の改行・式を 1 セルに保つ", () => {
    const rows = parseCsv(
      diariesToCsv([{ id: "d1", diary_date: "2026-10-27", content: "+1 した\n夜泣き", updated_at: "x" }]),
    )
    expect(rows[1]).toEqual(["2026-10-27", "'+1 した\n夜泣き", "x", "d1"])
  })

  it("jstDateTimeText は日付を跨ぐ UTC を JST の日付で出す", () => {
    expect(jstDateTimeText("2026-10-26T15:00:00Z")).toBe("2026-10-27 00:00")
  })
})
