import { describe, it, expect } from "vitest"
import { BABY_DATE_PARAM, babyDateHref, resolveBabyDate } from "../baby-link"

const TODAY = "2026-10-19"

describe("resolveBabyDate", () => {
  it("妥当な過去日はそのまま", () => {
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: "2026-10-01" }, TODAY)).toBe("2026-10-01")
  })
  it("今日は今日", () => {
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: TODAY }, TODAY)).toBe(TODAY)
  })
  it("未来・不正・実在せぬ日・配列・未指定は今日へ倒す", () => {
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: "2026-10-20" }, TODAY)).toBe(TODAY)
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: "garbage" }, TODAY)).toBe(TODAY)
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: "2026-02-30" }, TODAY)).toBe(TODAY)
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: ["2026-10-01", "2026-10-02"] }, TODAY)).toBe(TODAY)
    expect(resolveBabyDate({}, TODAY)).toBe(TODAY)
  })
})

describe("babyDateHref", () => {
  it("読む側と同じクエリ名で組む", () => {
    const href = babyDateHref("2026-10-01")
    expect(href).toBe("/baby?date=2026-10-01")
    const url = new URL(href, "http://localhost")
    expect(resolveBabyDate({ [BABY_DATE_PARAM]: url.searchParams.get(BABY_DATE_PARAM) ?? undefined }, TODAY)).toBe("2026-10-01")
  })
})
