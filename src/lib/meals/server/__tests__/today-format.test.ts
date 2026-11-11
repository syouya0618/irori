import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { DISH_ROLE_LABELS } from "../../catalog"
import { MAX_PLAN_DAYS, MIN_PLAN_DAYS } from "../../planner"
import { UNIT_LABELS } from "../../units"
import {
  DISH_ROLE_LABELS_JA,
  PLAN_ORIGIN_LABELS,
  QUANTITY_UNKNOWN_LABEL,
  SUFFICIENCY_LABELS,
  dishRoleLabel,
  formatDaysLeft,
  formatMealDate,
  formatMealDateShort,
  formatMealDateWithRelative,
  formatMinutes,
  formatQuantityJa,
  formatServings,
  relativeDayLabel,
  unitLabel,
} from "../format"
import {
  FEEDBACK_WINDOW_DAYS,
  MEAL_RANGE_MAX_DAYS,
  MEAL_RANGE_MIN_DAYS,
  daysBefore,
  daysFrom,
  feedbackWindowStart,
  isWithinRange,
  mealDateRange,
  mealRangeFromToday,
  mealToday,
  weekdayLabel,
} from "../today"

describe("mealToday（JST の今日）", () => {
  it("UTC では前日でも、JST の暦日を返す", () => {
    // 2026-11-10T15:30Z = JST 2026-11-11 00:30
    expect(mealToday(new Date("2026-11-10T15:30:00Z"))).toBe("2026-11-11")
  })

  it("対照: JST でも同じ日のうちは日付が進まない", () => {
    expect(mealToday(new Date("2026-11-10T14:59:00Z"))).toBe("2026-11-10")
  })
})

describe("mealDateRange", () => {
  it("開始日から n 日ぶん（両端を含む）。月・年をまたぐ", () => {
    expect(mealDateRange("2026-12-29", 7)).toEqual({
      from: "2026-12-29",
      to: "2027-01-04",
      dates: ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-04"],
    })
    expect(mealDateRange("2028-02-28", 2)?.dates).toEqual(["2028-02-28", "2028-02-29"])
    expect(mealDateRange("2026-11-11", 1)).toEqual({ from: "2026-11-11", to: "2026-11-11", dates: ["2026-11-11"] })
  })

  it("不正な開始日・1〜7 の整数でない日数は null（黙って丸めない）", () => {
    expect(mealDateRange("2026-02-30", 3)).toBeNull()
    expect(mealDateRange("2026/11/11", 3)).toBeNull()
    for (const days of [0, 8, 1.5, -1, Number.NaN]) expect(mealDateRange("2026-11-11", days)).toBeNull()
  })

  it("日数の範囲は献立の計算（planner）と同じ", () => {
    expect([MEAL_RANGE_MIN_DAYS, MEAL_RANGE_MAX_DAYS]).toEqual([MIN_PLAN_DAYS, MAX_PLAN_DAYS])
  })

  it("mealRangeFromToday は渡した今日から数える", () => {
    expect(mealRangeFromToday(3, "2026-11-11")).toEqual({
      from: "2026-11-11",
      to: "2026-11-13",
      dates: ["2026-11-11", "2026-11-12", "2026-11-13"],
    })
  })
})

describe("daysBefore / feedbackWindowStart / isWithinRange / daysFrom", () => {
  it("食後評価は今日から 180 日前まで遡る（暦日で数える）", () => {
    expect(FEEDBACK_WINDOW_DAYS).toBe(180)
    expect(feedbackWindowStart("2026-11-11")).toBe("2026-05-15")
    expect(daysFrom("2026-05-15", "2026-11-11")).toBe(180)
  })

  it("不正な入力は null / false", () => {
    expect(daysBefore("2026-11-31", 1)).toBeNull()
    expect(daysBefore("2026-11-11", -1)).toBeNull()
    expect(daysBefore("2026-11-11", 0.5)).toBeNull()
    expect(feedbackWindowStart("today")).toBeNull()
    expect(daysFrom("2026-11-11", "x")).toBeNull()
    expect(isWithinRange("x", "2026-11-11", "2026-11-12")).toBe(false)
  })

  it("範囲は両端を含む", () => {
    expect(isWithinRange("2026-11-11", "2026-11-11", "2026-11-13")).toBe(true)
    expect(isWithinRange("2026-11-13", "2026-11-11", "2026-11-13")).toBe(true)
    expect(isWithinRange("2026-11-14", "2026-11-11", "2026-11-13")).toBe(false)
    expect(isWithinRange("2026-11-10", "2026-11-11", "2026-11-13")).toBe(false)
  })
})

describe("曜日と日付の表記", () => {
  it("曜日は JST の暦日どおり（2026-11-11 は水曜）", () => {
    expect(weekdayLabel("2026-11-11")).toBe("水")
    expect(weekdayLabel("2026-11-15")).toBe("日")
    expect(weekdayLabel("2026-11-14")).toBe("土")
    expect(weekdayLabel("2026-02-30")).toBeNull()
  })

  it("日付の表記。不正な日付は入力のまま返す（別の日へ言い換えない）", () => {
    expect(formatMealDate("2026-11-11")).toBe("11月11日（水）")
    expect(formatMealDate("2027-01-03")).toBe("1月3日（日）")
    expect(formatMealDateShort("2026-11-11")).toBe("11/11（水）")
    expect(formatMealDate("2026-02-30")).toBe("2026-02-30")
    expect(formatMealDateShort("")).toBe("")
  })

  it("今日・明日・あさって・昨日だけ呼び方を付ける", () => {
    expect(relativeDayLabel("2026-11-11", "2026-11-11")).toBe("今日")
    expect(relativeDayLabel("2026-11-12", "2026-11-11")).toBe("明日")
    expect(relativeDayLabel("2026-11-13", "2026-11-11")).toBe("あさって")
    expect(relativeDayLabel("2026-11-10", "2026-11-11")).toBe("昨日")
    expect(relativeDayLabel("2026-11-14", "2026-11-11")).toBeNull()
    expect(relativeDayLabel("x", "2026-11-11")).toBeNull()
    expect(formatMealDateWithRelative("2026-11-12", "2026-11-11")).toBe("明日 11/12（木）")
    expect(formatMealDateWithRelative("2026-11-20", "2026-11-11")).toBe("11/20（金）")
  })

  it("残り日数: 今日まで・あと n 日・n 日超過", () => {
    expect(formatDaysLeft("2026-11-11", "2026-11-11")).toBe("今日まで")
    expect(formatDaysLeft("2026-11-14", "2026-11-11")).toBe("あと3日")
    expect(formatDaysLeft("2026-11-09", "2026-11-11")).toBe("2日超過")
    expect(formatDaysLeft("x", "2026-11-11")).toBeNull()
  })
})

describe("数量の表記（UNIT_LABELS が正本）", () => {
  it("単位の表記は units.ts の表をそのまま使う", () => {
    for (const [unit, label] of Object.entries(UNIT_LABELS)) expect(unitLabel(unit)).toBe(label)
    expect(formatQuantityJa({ amount: 300, unit: "g" })).toBe("300g")
    expect(formatQuantityJa({ amount: 1.5, unit: "tbsp" })).toBe("大さじ1と1/2")
    expect(formatQuantityJa({ amount: null, unit: "to_taste" })).toBe("適量")
  })

  it("数量が無い・量が無い・未知の単位は「数量不明」（量を捏造しない）", () => {
    expect(formatQuantityJa(null)).toBe(QUANTITY_UNKNOWN_LABEL)
    expect(formatQuantityJa(undefined)).toBe(QUANTITY_UNKNOWN_LABEL)
    expect(formatQuantityJa({ amount: null, unit: "g" })).toBe(QUANTITY_UNKNOWN_LABEL)
    expect(formatQuantityJa({ amount: 2, unit: "crate" as never })).toBe(QUANTITY_UNKNOWN_LABEL)
  })

  it("未知の単位名は入力のまま返し、空は空文字", () => {
    expect(unitLabel("crate")).toBe("crate")
    expect(unitLabel("constructor")).toBe("constructor")
    expect(unitLabel(null)).toBe("")
  })

  it("時間と人数", () => {
    expect(formatMinutes(20)).toBe("約20分")
    expect(formatMinutes(0)).toBe("時間不明")
    expect(formatMinutes(null)).toBe("時間不明")
    expect(formatServings(2)).toBe("2人分")
  })
})

describe("区分の表示名", () => {
  it("料理区分の写しは、カタログの表示名と一致する", () => {
    expect(DISH_ROLE_LABELS_JA).toEqual(DISH_ROLE_LABELS)
  })

  it("未知の区分は中立の語へ退化する", () => {
    expect(dishRoleLabel("main")).toBe("主菜")
    expect(dishRoleLabel("dessert")).toBe("料理")
    expect(dishRoleLabel("toString")).toBe("料理")
  })

  it("自動献立と生成 AI の補助を別の語で示す（C-81）", () => {
    expect(PLAN_ORIGIN_LABELS).toEqual({ auto: "自動", ai_assisted: "AI 補助", manual: "手動" })
    expect(new Set(Object.values(PLAN_ORIGIN_LABELS)).size).toBe(3)
  })

  it("充足の 3 段は別々の語（C-23）", () => {
    expect(SUFFICIENCY_LABELS).toEqual({ ready: "揃う", check: "分量要確認", buy: "買い足し" })
  })
})

describe("モジュールの境界", () => {
  const DIR = path.resolve(__dirname, "..")
  const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const importsOf = (file: string) =>
    [...codeOnly(readFileSync(path.join(DIR, file), "utf8")).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1])

  it("検査の対照: context.ts はカタログのデータを import している（抽出が働いている）", () => {
    expect(importsOf("context.ts")).toEqual(
      expect.arrayContaining(["../catalog/ingredients", "../catalog/recipes"]),
    )
  })

  it.each(["rows.ts", "today.ts", "format.ts"])(
    "%s は Client からも import できる中立モジュール（カタログのデータ・Supabase・Next・context を import しない）",
    (file) => {
      const imports = importsOf(file)
      const heavy = imports.filter(
        (target) =>
          /catalog\/(ingredients|recipes|allergens|child-guidance|index)$/.test(target) ||
          target.endsWith("/catalog") ||
          target === "./context" ||
          target.startsWith("@supabase") ||
          target.startsWith("@/lib/supabase") ||
          target.startsWith("next/"),
      )
      expect(heavy).toEqual([])
      expect(codeOnly(readFileSync(path.join(DIR, file), "utf8"))).not.toMatch(/^\s*["']use (client|server)["']/m)
    },
  )

  it.each(["rows.ts", "today.ts", "format.ts", "context.ts"])("%s は日付文字列を Date へ渡さない", (file) => {
    const code = codeOnly(readFileSync(path.join(DIR, file), "utf8"))
    expect(code).not.toMatch(/new Date\(\s*[^)\s]/)
  })
})
