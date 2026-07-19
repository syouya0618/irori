import { describe, it, expect } from "vitest"
import { validateCalendarEventInput } from "@/lib/domain/calendar-validation"

describe("validateCalendarEventInput", () => {
  it("空タイトルを弾く", () => {
    const r = validateCalendarEventInput({
      title: "  ",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
    })
    expect(r.error).toBe("タイトルを入力してください")
  })

  it("日付逆転を弾く", () => {
    const r = validateCalendarEventInput({
      title: "検診",
      isAllDay: true,
      startDate: "2026-07-10",
      endDate: "2026-07-09",
    })
    expect(r.error).toBe("終了日は開始日以降にしてください")
  })

  it("終日: 正常系は trim + start_at/end_at を null 化", () => {
    const r = validateCalendarEventInput({
      title: "  検診  ",
      memo: "  メモ  ",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T00:00:00Z", // 終日なので無視される
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({
      title: "検診",
      memo: "メモ",
      isAllDay: true,
      startAt: null,
      endAt: null,
    })
  })

  it("時刻付き: start_at 必須", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: null,
    })
    expect(r.error).toBe("開始時刻を入力してください")
  })

  it("時刻付き: 終了 < 開始 を弾く", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T04:00:00Z",
    })
    expect(r.error).toBe("終了時刻は開始時刻以降にしてください")
  })

  it("時刻付き: 正常系", () => {
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({ isAllDay: false, endAt: null })
  })

  // --- AUDIT-069: start_date ↔ start_at の JST 暦日整合（DB CHECK 化不能ゆえ
  // 書き込み側で強制）+ ISO/日付形式検証 + 順序比較の getTime 化 ---

  it("時刻付き: start_at の JST 日 ≠ startDate を弾く（日跨ぎ境界 15:30Z = JST 翌日 00:30）", () => {
    // 15:30Z は JST では翌日 2026-07-10 00:30。startDate=2026-07-09 と不整合。
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T15:30:00Z",
    })
    expect(r.error).toBe("開始時刻の日付が開始日と一致しません")
    expect(r.value).toBeNull()
  })

  it("時刻付き: end_at の JST 日 ≠ endDate を弾く", () => {
    // startAt 05:00Z = JST 14:00(07-09) ✓ / endAt 15:30Z = JST 00:30(07-10) ≠ 07-09。
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T15:30:00Z",
    })
    expect(r.error).toBe("終了時刻の日付が終了日と一致しません")
    expect(r.value).toBeNull()
  })

  it("時刻付き: 順序は getTime 比較（+09:00 と Z の混在で誤判定しない）", () => {
    // startAt 14:00+09:00 = 05:00Z / endAt 06:00Z = JST 15:00。実時刻は end > start。
    // 文字列比較だと "...06..." < "...14..." で誤って逆転扱いになる箇所。
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T14:00:00+09:00",
      endAt: "2026-07-09T06:00:00Z",
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({ isAllDay: false })
  })

  it("時刻付き: 不正な ISO の start_at は throw せず整形エラーを返す", () => {
    let r: ReturnType<typeof validateCalendarEventInput> | undefined
    expect(() => {
      r = validateCalendarEventInput({
        title: "会議",
        isAllDay: false,
        startDate: "2026-07-09",
        endDate: "2026-07-09",
        startAt: "not-an-iso",
      })
    }).not.toThrow()
    expect(r?.error).toBe("開始時刻の形式が不正です")
    expect(r?.value).toBeNull()
  })

  it("時刻付き: 多日イベント（end_at の JST 日 = endDate）は正常系", () => {
    // startAt 05:00Z = JST 14:00(07-09) / endAt 17:00Z = JST 02:00(07-10)。
    // end_at は endDate(07-10) と照合する（startDate との照合ではない）。
    const r = validateCalendarEventInput({
      title: "会議",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-10",
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T17:00:00Z",
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({
      isAllDay: false,
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T17:00:00Z",
    })
  })

  it("不正な日付形式（YYYY-MM-DD でない）を弾く", () => {
    const r = validateCalendarEventInput({
      title: "検診",
      isAllDay: true,
      startDate: "2026/07/09",
      endDate: "2026/07/09",
    })
    expect(r.error).toBe("日付の形式が不正です")
    expect(r.value).toBeNull()
  })
})
