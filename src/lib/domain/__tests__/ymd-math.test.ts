import { describe, it, expect } from "vitest"
import {
  addMonthsClamped,
  addYearsClamped,
  compareYmd,
  daysInMonthOf,
  weekEndSunday,
  weekdayOfYmd,
} from "../ymd-math"
import { daysBetweenYmd, shiftYmd, weekStartMonday } from "@/lib/utils/date-jst"

/** 実在せぬ日・形式違い・型違い。どの関数も null を返す（黙って繰り上げぬ）。 */
const INVALID_YMD = ["2026-02-30", "2025-02-29", "2026-13-01", "2026-00-10", "2026-1-5", "20260105", "garbage", ""]

describe("compareYmd", () => {
  it.each([
    ["2026-11-10", "2026-11-11", -1],
    ["2026-11-11", "2026-11-11", 0],
    ["2026-11-12", "2026-11-11", 1],
    // 年跨ぎ・月跨ぎ
    ["2025-12-31", "2026-01-01", -1],
    ["2026-10-01", "2026-09-30", 1],
  ] as const)("%s と %s → %i", (a, b, expected) => {
    expect(compareYmd(a, b)).toBe(expected)
  })

  it("不正な日付は「同じ日」にも「前」にもせず null", () => {
    for (const bad of INVALID_YMD) {
      expect(compareYmd(bad, "2026-11-11"), bad).toBeNull()
      expect(compareYmd("2026-11-11", bad), bad).toBeNull()
    }
  })
})

describe("weekdayOfYmd（0 = 日曜）", () => {
  it.each([
    ["2026-11-15", 0], // 日
    ["2026-11-09", 1], // 月
    ["2026-11-11", 3], // 水
    ["2026-11-14", 6], // 土
    ["2024-02-29", 4], // 閏日は木曜
    ["2027-01-01", 5], // 年跨ぎ（金）
    ["0001-01-01", 1], // 100 年未満を 1900 年代へ読み替えぬ
  ] as const)("%s → %i", (ymd, expected) => {
    expect(weekdayOfYmd(ymd)).toBe(expected)
  })

  it("既存の weekStartMonday と同じ暦で数える（月曜からの日数が一致する）", () => {
    for (let i = 0; i < 400; i++) {
      const ymd = shiftYmd("2026-01-01", i)
      const weekday = weekdayOfYmd(ymd)
      expect(weekday, ymd).not.toBeNull()
      expect(shiftYmd(weekStartMonday(ymd)!, (weekday! + 6) % 7), ymd).toBe(ymd)
    }
  })

  it("不正な日付は null（対照: 実在日は数値）", () => {
    for (const bad of INVALID_YMD) expect(weekdayOfYmd(bad), bad).toBeNull()
    expect(weekdayOfYmd("2026-02-28")).toBe(6)
  })
})

describe("daysInMonthOf", () => {
  it.each([
    [2026, 1, 31],
    [2026, 2, 28],
    [2024, 2, 29],
    [1900, 2, 28], // 100 で割れる年は平年
    [2000, 2, 29], // 400 で割れる年は閏年
    [2026, 4, 30],
    [2026, 12, 31],
  ])("%i 年 %i 月 → %i 日", (year, month, expected) => {
    expect(daysInMonthOf(year, month)).toBe(expected)
  })

  it("範囲外・非整数は null", () => {
    expect(daysInMonthOf(2026, 0)).toBeNull()
    expect(daysInMonthOf(2026, 13)).toBeNull()
    expect(daysInMonthOf(2026, 1.5)).toBeNull()
    expect(daysInMonthOf(0, 1)).toBeNull()
    expect(daysInMonthOf(10000, 1)).toBeNull()
    expect(daysInMonthOf(Number.NaN, 1)).toBeNull()
  })
})

describe("addMonthsClamped", () => {
  it("存在しない日は月末へ寄せる（1/31 → 2/28）", () => {
    expect(addMonthsClamped("2026-01-31", 1)).toBe("2026-02-28")
    expect(addMonthsClamped("2024-01-31", 1)).toBe("2024-02-29")
    expect(addMonthsClamped("2026-03-31", 1)).toBe("2026-04-30")
  })

  it("anchorDay を渡すと元の基準日を保つ（1/31 → 2/28 → 3/31。ずれ続けぬ）", () => {
    const feb = addMonthsClamped("2026-01-31", 1, 31)
    expect(feb).toBe("2026-02-28")
    const mar = addMonthsClamped(feb!, 1, 31)
    expect(mar).toBe("2026-03-31")
    expect(addMonthsClamped(mar!, 1, 31)).toBe("2026-04-30")
    expect(addMonthsClamped("2026-04-30", 1, 31)).toBe("2026-05-31")
  })

  it("対照: anchorDay を渡さねば寄せた日が次の起点になる（2/28 → 3/28）", () => {
    expect(addMonthsClamped("2026-02-28", 1)).toBe("2026-03-28")
  })

  it("年を跨ぐ・過去へ戻る", () => {
    expect(addMonthsClamped("2026-12-15", 1)).toBe("2027-01-15")
    expect(addMonthsClamped("2026-11-30", 3)).toBe("2027-02-28")
    expect(addMonthsClamped("2026-01-15", -1)).toBe("2025-12-15")
    expect(addMonthsClamped("2026-01-31", -2)).toBe("2025-11-30")
    expect(addMonthsClamped("2026-03-31", -25)).toBe("2024-02-29")
    expect(addMonthsClamped("2026-05-10", 0)).toBe("2026-05-10")
    expect(addMonthsClamped("2024-02-29", 12)).toBe("2025-02-28")
  })

  it("月を 30 日へ換算せぬ（対照: 30 日後とは別の日になる）", () => {
    expect(addMonthsClamped("2026-01-15", 1)).toBe("2026-02-15")
    expect(shiftYmd("2026-01-15", 30)).toBe("2026-02-14")
    expect(daysBetweenYmd("2026-01-15", addMonthsClamped("2026-01-15", 1)!)).toBe(31)
  })

  it("不正な入力は null", () => {
    for (const bad of INVALID_YMD) expect(addMonthsClamped(bad, 1), bad).toBeNull()
    expect(addMonthsClamped("2026-01-31", 1.5)).toBeNull()
    expect(addMonthsClamped("2026-01-31", Number.NaN)).toBeNull()
    expect(addMonthsClamped("2026-01-31", 1, 0)).toBeNull()
    expect(addMonthsClamped("2026-01-31", 1, 32)).toBeNull()
    expect(addMonthsClamped("2026-01-31", 1, 30.5)).toBeNull()
    // 結果が 0001〜9999 年の外
    expect(addMonthsClamped("9999-12-01", 1)).toBeNull()
    expect(addMonthsClamped("0001-01-01", -1)).toBeNull()
  })
})

describe("addYearsClamped", () => {
  it("2/29 は平年に 2/28 へ寄せる", () => {
    expect(addYearsClamped("2024-02-29", 1)).toBe("2025-02-28")
    expect(addYearsClamped("2024-02-29", -1)).toBe("2023-02-28")
  })

  it("anchor を渡すと次の閏年に 2/29 へ戻る（2/29 → 平年 2/28 → 閏年 2/29）", () => {
    const y2025 = addYearsClamped("2024-02-29", 1, 2, 29)
    expect(y2025).toBe("2025-02-28")
    const y2026 = addYearsClamped(y2025!, 1, 2, 29)
    expect(y2026).toBe("2026-02-28")
    const y2027 = addYearsClamped(y2026!, 1, 2, 29)
    expect(y2027).toBe("2027-02-28")
    expect(addYearsClamped(y2027!, 1, 2, 29)).toBe("2028-02-29")
    expect(addYearsClamped("2025-02-28", 3, 2, 29)).toBe("2028-02-29")
  })

  it("対照: anchor を渡さねば 2/28 のまま戻らぬ", () => {
    expect(addYearsClamped("2025-02-28", 3)).toBe("2028-02-28")
  })

  it("100 で割れる年は閏年ではない（2096-02-29 + 4 年 = 2100-02-28）", () => {
    expect(addYearsClamped("2096-02-29", 4, 2, 29)).toBe("2100-02-28")
    expect(addYearsClamped("2096-02-29", 8, 2, 29)).toBe("2104-02-29")
  })

  it("年を 365 日へ換算せぬ（対照: 365 日後とは別の日になる）", () => {
    expect(addYearsClamped("2024-01-15", 1)).toBe("2025-01-15")
    expect(shiftYmd("2024-01-15", 365)).toBe("2025-01-14")
  })

  it("通常の月日はそのまま。年末も保つ", () => {
    expect(addYearsClamped("2026-12-31", 1)).toBe("2027-12-31")
    expect(addYearsClamped("2026-06-15", 0)).toBe("2026-06-15")
    // anchorMonth だけ・anchorDay だけでも使える
    expect(addYearsClamped("2026-06-15", 1, 4)).toBe("2027-04-15")
    expect(addYearsClamped("2026-06-15", 1, undefined, 31)).toBe("2027-06-30")
  })

  it("不正な入力は null", () => {
    for (const bad of INVALID_YMD) expect(addYearsClamped(bad, 1), bad).toBeNull()
    expect(addYearsClamped("2024-02-29", 0.5)).toBeNull()
    expect(addYearsClamped("2024-02-29", 1, 0, 29)).toBeNull()
    expect(addYearsClamped("2024-02-29", 1, 13, 29)).toBeNull()
    expect(addYearsClamped("2024-02-29", 1, 2, 0)).toBeNull()
    expect(addYearsClamped("2024-02-29", 1, 2, 32)).toBeNull()
    expect(addYearsClamped("9999-01-01", 1)).toBeNull()
  })
})

describe("weekEndSunday（weekStartMonday と対）", () => {
  it.each([
    ["2026-11-11", "2026-11-15"], // 水
    ["2026-11-09", "2026-11-15"], // 月（週の先頭）
    ["2026-11-15", "2026-11-15"], // 日（同じ週の末尾）
    ["2026-11-16", "2026-11-22"], // 翌週の月
    ["2026-12-30", "2027-01-03"], // 年跨ぎ
  ])("%s → %s", (ymd, expected) => {
    expect(weekEndSunday(ymd)).toBe(expected)
  })

  it("月曜から 6 日後で、曜日は日曜", () => {
    for (let i = 0; i < 60; i++) {
      const ymd = shiftYmd("2026-12-01", i)
      const sunday = weekEndSunday(ymd)!
      expect(daysBetweenYmd(weekStartMonday(ymd)!, sunday), ymd).toBe(6)
      expect(weekdayOfYmd(sunday), ymd).toBe(0)
    }
  })

  it("不正な日付は null（2026-02-30 を 3/2 の週へ繰り上げぬ）", () => {
    for (const bad of INVALID_YMD) expect(weekEndSunday(bad), bad).toBeNull()
  })
})
