import { describe, it, expect } from "vitest"
import {
  generateRecurrenceDates,
  recurrenceMaxUntil,
  MAX_RECURRENCE_OCCURRENCES,
} from "@/lib/domain/calendar-recurrence"

describe("generateRecurrenceDates - daily", () => {
  it("初回日を含み until を含む(inclusive)", () => {
    expect(generateRecurrenceDates("2026-07-09", "daily", "2026-07-12")).toEqual([
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
      "2026-07-12",
    ])
  })

  it("月をまたいでも連続する", () => {
    expect(generateRecurrenceDates("2026-07-30", "daily", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ])
  })

  it("うるう年 2/28→2/29→3/1 を正しく刻む", () => {
    expect(generateRecurrenceDates("2024-02-28", "daily", "2024-03-01")).toEqual([
      "2024-02-28",
      "2024-02-29",
      "2024-03-01",
    ])
  })
})

describe("generateRecurrenceDates - weekly", () => {
  it("7 日刻みで until を含めて生成する", () => {
    expect(generateRecurrenceDates("2026-07-09", "weekly", "2026-07-30")).toEqual([
      "2026-07-09",
      "2026-07-16",
      "2026-07-23",
      "2026-07-30",
    ])
  })

  it("until が次回開催日の手前なら初回のみ", () => {
    expect(generateRecurrenceDates("2026-07-09", "weekly", "2026-07-15")).toEqual([
      "2026-07-09",
    ])
  })
})

describe("generateRecurrenceDates - monthly", () => {
  it("同一日で毎月刻む", () => {
    expect(
      generateRecurrenceDates("2026-07-15", "monthly", "2026-10-15"),
    ).toEqual(["2026-07-15", "2026-08-15", "2026-09-15", "2026-10-15"])
  })

  it("存在しない月(1/31→2月)はスキップし、31日のある月だけ生成する", () => {
    expect(
      generateRecurrenceDates("2026-01-31", "monthly", "2026-05-31"),
    ).toEqual([
      "2026-01-31",
      // 2026-02-31 は存在しない → スキップ
      "2026-03-31",
      // 2026-04-31 は存在しない → スキップ
      "2026-05-31",
    ])
  })

  it("30日は2月をスキップする", () => {
    expect(
      generateRecurrenceDates("2026-01-30", "monthly", "2026-03-30"),
    ).toEqual(["2026-01-30", "2026-03-30"])
  })

  it("29日は非うるう年の2月をスキップする", () => {
    // 2025 は非うるう年 → 2/29 は存在しないのでスキップ。他の月の29日は生成する。
    expect(
      generateRecurrenceDates("2025-01-29", "monthly", "2025-04-29"),
    ).toEqual([
      "2025-01-29",
      // 2025-02-29 は存在しない → スキップ
      "2025-03-29",
      "2025-04-29",
    ])
  })

  it("29日はうるう年の2月(2/29)を生成する", () => {
    // 2024 はうるう年 → 2/29 は存在するので生成する。
    expect(
      generateRecurrenceDates("2024-01-29", "monthly", "2024-03-29"),
    ).toEqual(["2024-01-29", "2024-02-29", "2024-03-29"])
  })

  it("年境界をまたいで生成する", () => {
    expect(
      generateRecurrenceDates("2026-11-10", "monthly", "2027-02-10"),
    ).toEqual(["2026-11-10", "2026-12-10", "2027-01-10", "2027-02-10"])
  })
})

describe("generateRecurrenceDates - 防御ガード", () => {
  it("until が startDate 以前なら throw", () => {
    expect(() =>
      generateRecurrenceDates("2026-07-09", "daily", "2026-07-09"),
    ).toThrow(/開始日より後/)
    expect(() =>
      generateRecurrenceDates("2026-07-09", "daily", "2026-07-08"),
    ).toThrow(/開始日より後/)
  })

  it("until が startDate+1年を超えたら throw", () => {
    // 2026-07-09 + 1年 = 2027-07-09。1日超過で弾く。
    expect(() =>
      generateRecurrenceDates("2026-07-09", "daily", "2027-07-10"),
    ).toThrow(/1年以内/)
  })

  it("until が startDate+1年ちょうどは許可(inclusive)", () => {
    const dates = generateRecurrenceDates("2026-07-09", "monthly", "2027-07-09")
    expect(dates[0]).toBe("2026-07-09")
    expect(dates[dates.length - 1]).toBe("2027-07-09")
    expect(dates).toHaveLength(13)
  })

  it("不正な日付形式は throw", () => {
    expect(() =>
      generateRecurrenceDates("2026/07/09", "daily", "2026-07-12"),
    ).toThrow(/日付形式/)
  })

  it("daily の1年は生成数上限(400)を超えない", () => {
    const dates = generateRecurrenceDates("2026-07-09", "daily", "2027-07-09")
    // 366 日(2027-07-09 まで inclusive)以内で 400 未満。
    expect(dates.length).toBeLessThanOrEqual(MAX_RECURRENCE_OCCURRENCES)
    expect(dates.length).toBeGreaterThan(360)
  })
})

describe("recurrenceMaxUntil", () => {
  it("startDate + 1年を返す", () => {
    expect(recurrenceMaxUntil("2026-07-09")).toBe("2027-07-09")
  })

  it("2/29 起点は Date.UTC 正規化で翌年 3/1 になる", () => {
    expect(recurrenceMaxUntil("2024-02-29")).toBe("2025-03-01")
  })
})
