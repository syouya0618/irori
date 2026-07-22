import { describe, it, expect } from "vitest"
import {
  DIARY_PAGE_SIZE,
  formatDiaryDateHeadingFromYmd,
} from "../baby-diary"

describe("formatDiaryDateHeadingFromYmd（YYYY-MM-DD → 日本語日付見出し）", () => {
  it("JST 暦日をそのまま見出しにする（UTC 罠を踏まない）", () => {
    // new Date('YYYY-MM-DD') の UTC パースだと TZ 環境次第で日がずれうる形式だが、
    // +09:00 明示構築のためどの TZ 環境でも同じ見出しになる。
    expect(formatDiaryDateHeadingFromYmd("2026-07-22")).toBe(
      "2026年7月22日(水)",
    )
    expect(formatDiaryDateHeadingFromYmd("2026-01-01")).toBe(
      "2026年1月1日(木)",
    )
  })

  it("月末・閏日も正しく整形する", () => {
    expect(formatDiaryDateHeadingFromYmd("2026-02-28")).toBe(
      "2026年2月28日(土)",
    )
    expect(formatDiaryDateHeadingFromYmd("2028-02-29")).toBe(
      "2028年2月29日(火)",
    )
  })
})

describe("DIARY_PAGE_SIZE", () => {
  it("サーバ初回とクライアント追ページで共有する定数（正の整数）", () => {
    expect(Number.isInteger(DIARY_PAGE_SIZE)).toBe(true)
    expect(DIARY_PAGE_SIZE).toBeGreaterThan(0)
  })
})
