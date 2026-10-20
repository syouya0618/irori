import { describe, it, expect } from "vitest"
import {
  buildExportDocument,
  countWithinByteBudget,
  exportFilename,
  isExportPeriod,
  jsonByteLength,
  resolveExportRange,
  EXPORT_DIARIES_BYTE_BUDGET,
  EXPORT_LOGS_BYTE_BUDGET,
} from "../baby-export"
import type { BabyLogData } from "@/lib/types/baby"

const TODAY = "2026-10-19"

function log(id: string, loggedAt: string): BabyLogData {
  return {
    id,
    log_type: "diaper",
    logged_at: loggedAt,
    logged_by: "u1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: "pee",
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: loggedAt,
    updated_at: loggedAt,
  }
}

describe("resolveExportRange", () => {
  it("PDF と同じ移動窓（両端含む暦日）。all は from を持たぬ", () => {
    expect(resolveExportRange("1week", TODAY)).toEqual({ from: "2026-10-12", to: TODAY })
    expect(resolveExportRange("1month", TODAY)).toEqual({ from: "2026-09-19", to: TODAY })
    expect(resolveExportRange("3months", TODAY)).toEqual({ from: "2026-07-21", to: TODAY })
    expect(resolveExportRange("all", TODAY)).toEqual({ from: null, to: TODAY })
  })
})

describe("isExportPeriod", () => {
  it("既知の 4 値だけを通す", () => {
    expect(isExportPeriod("all")).toBe(true)
    expect(isExportPeriod("1year")).toBe(false)
    expect(isExportPeriod(null)).toBe(false)
  })
})

describe("buildExportDocument", () => {
  it("範囲・時刻の意味・単位・件数・完全性を本文に持ち、JST 暦日を各行に添える", () => {
    const doc = buildExportDocument({
      exportedAt: "2026-10-19T03:00:00.000Z",
      period: "1week",
      from: "2026-10-12",
      to: TODAY,
      household: { baby_name: "みかん", baby_birth_date: "2026-06-01" },
      members: [{ id: "u1", display_name: "はな" }],
      // UTC 10/18 15:30 = JST 10/19 00:30 → 暦日は JST で 10/19
      logs: [log("a", "2026-10-18T15:30:00+00:00"), log("b", "2026-10-18T03:00:00+00:00")],
      diaries: [{ id: "d1", diary_date: "2026-10-18", content: "散歩", updated_at: "2026-10-18T10:00:00+00:00" }],
      truncated: { logs: false, diaries: false },
    })
    expect(doc.schema_version).toBe(1)
    expect(doc.timezone).toBe("Asia/Tokyo")
    expect(doc.period).toEqual({ key: "1week", from: "2026-10-12", to: TODAY })
    expect(doc.units.amount_ml).toBe("ml")
    expect(doc.counts).toEqual({ logs: 2, diaries: 1 })
    expect(doc.complete).toBe(true)
    expect(doc.truncated_after).toBeNull()
    expect(doc.diaries_truncated_after).toBeNull()
    expect(doc.logs[0].logged_at_jst_date).toBe("2026-10-19")
    expect(doc.logs[1].logged_at_jst_date).toBe("2026-10-18")
    // 元の列は欠けぬ（null も保つ）
    expect(doc.logs[0]).toMatchObject({ id: "a", diaper_type: "pee", amount_ml: null })
  })

  it("切り詰めた時は complete=false と最後の logged_at を示す", () => {
    const doc = buildExportDocument({
      exportedAt: "2026-10-19T03:00:00.000Z",
      period: "all",
      from: null,
      to: TODAY,
      household: { baby_name: null, baby_birth_date: null },
      members: [],
      logs: [log("a", "2026-10-01T00:00:00+00:00"), log("b", "2026-10-02T00:00:00+00:00")],
      diaries: [],
      truncated: { logs: true, diaries: false },
    })
    expect(doc.complete).toBe(false)
    expect(doc.truncated_after).toBe("2026-10-02T00:00:00+00:00")
    expect(doc.diaries_truncated_after).toBeNull()
  })

  it("日記だけが切り詰められた時は記録の時刻を指さず、日記の最後の日付を示す（レビュー P3-12）", () => {
    const doc = buildExportDocument({
      exportedAt: "2026-10-19T03:00:00.000Z",
      period: "all",
      from: null,
      to: TODAY,
      household: { baby_name: null, baby_birth_date: null },
      members: [],
      logs: [log("a", "2026-10-01T00:00:00+00:00")],
      diaries: [
        { id: "d1", diary_date: "2026-10-01", content: "a", updated_at: "2026-10-01T10:00:00+00:00" },
        { id: "d2", diary_date: "2026-10-02", content: "b", updated_at: "2026-10-02T10:00:00+00:00" },
      ],
      truncated: { logs: false, diaries: true },
    })
    expect(doc.complete).toBe(false)
    expect(doc.truncated_after).toBeNull()
    expect(doc.diaries_truncated_after).toBe("2026-10-02")
  })
})

describe("応答本文のバイト予算（Vercel の応答上限 4.5MB の手前で止める）", () => {
  it("予算の合計は 4.5MB の手前（ヘッダ・包みの分を残す）", () => {
    expect(EXPORT_LOGS_BYTE_BUDGET + EXPORT_DIARIES_BYTE_BUDGET).toBeLessThan(4_500_000)
  })

  it("jsonByteLength は UTF-8 のバイト数（日本語 1 文字 = 3 bytes）で数える", () => {
    expect(jsonByteLength("a")).toBe(3) // "a" の引用符込み
    expect(jsonByteLength("あ")).toBe(5)
    expect(jsonByteLength({ memo: "あい" })).toBe(jsonByteLength({ memo: "ab" }) + 4)
  })

  it("countWithinByteBudget は予算を超えぬ件数で止め、積算を返す", () => {
    const rows = [{ m: "a" }, { m: "b" }, { m: "c" }]
    const each = jsonByteLength(rows[0]) + 1
    expect(countWithinByteBudget(rows, each * 2)).toEqual({ count: 2, used: each * 2 })
    expect(countWithinByteBudget(rows, each * 10)).toEqual({ count: 3, used: each * 3 })
    // 既に使った分を引き継ぐ
    expect(countWithinByteBudget(rows, each * 3, each * 2).count).toBe(1)
    // 1 件も入らねば 0（呼び出し側が切り詰めと判断する）
    expect(countWithinByteBudget(rows, each - 1).count).toBe(0)
  })
})

describe("exportFilename", () => {
  it("ASCII の範囲つき名", () => {
    expect(exportFilename("2026-10-12", TODAY)).toBe("uchinolog_2026-10-12_2026-10-19.json")
    expect(exportFilename(null, TODAY)).toBe("uchinolog_all_2026-10-19.json")
  })
})
