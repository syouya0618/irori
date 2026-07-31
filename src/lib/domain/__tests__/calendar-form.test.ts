/**
 * 予定フォームの中立モジュール(calendar-form.ts)の回帰テスト。
 *
 * 固定する不変条件は 2 つ:
 * 1. 開始日を動かすと終了日・繰り返し終了日が**同差分でシフト**する(期間を保つ)。
 *    追従を止める条件（開始日が空/不正・繰り返し終了日が未入力）も固定する。
 * 2. クライアント検証(validateCalendarFormValue)とサーバー検証
 *    (validateCalendarEventInput)の文言が**文字単位で一致**する。
 *    シート側へ文言を書き写す実装に戻ったらここが赤くなる。
 */

import { describe, it, expect } from "vitest"
import {
  applyStartDateShift,
  formValueToTimestamps,
  validateCalendarFormValue,
  type CalendarEventFormValue,
} from "@/lib/domain/calendar-form"
import { validateCalendarEventInput } from "@/lib/domain/calendar-validation"

function form(o: Partial<CalendarEventFormValue> = {}): CalendarEventFormValue {
  return {
    title: "検診",
    memo: null,
    isAllDay: true,
    startDate: "2026-07-15",
    endDate: "2026-07-15",
    startTime: "09:00",
    endTime: "",
    repeat: "none",
    repeatUntil: "",
    ...o,
  }
}

describe("applyStartDateShift - 開始日の変更に終了日が追従する", () => {
  it("単日(差分0)は終了日も同じ日へ動く", () => {
    const next = applyStartDateShift(
      form({ startDate: "2026-07-15", endDate: "2026-07-15" }),
      "2026-07-20",
    )
    expect(next.startDate).toBe("2026-07-20")
    expect(next.endDate).toBe("2026-07-20")
  })

  it("複数日(差分2)は期間を保ったままシフトする", () => {
    const next = applyStartDateShift(
      form({ startDate: "2026-07-15", endDate: "2026-07-17" }),
      "2026-07-20",
    )
    expect(next.endDate).toBe("2026-07-22")
  })

  it("開始日を過去へ動かしても期間を保つ(月跨ぎ)", () => {
    const next = applyStartDateShift(
      form({ startDate: "2026-07-02", endDate: "2026-07-04" }),
      "2026-06-30",
    )
    expect(next.endDate).toBe("2026-07-02")
  })

  it("ユーザーが終了日を編集した後も追従する(表明されたのは期間ゆえ)", () => {
    // 「終了日を +2 日に編集」→「開始日を +5 日へ移動」= Google カレンダーと同じ挙動。
    // 追従を止めると endDate < startDate の不正状態が即座に復活する。
    const edited = form({ startDate: "2026-07-15", endDate: "2026-07-17" })
    const next = applyStartDateShift(edited, "2026-07-20")
    expect(next.endDate).toBe("2026-07-22")
    expect(validateCalendarFormValue(next).error).toBeNull()
  })

  it("繰り返し終了日は入力済みなら同差分でシフトする", () => {
    const next = applyStartDateShift(
      form({
        startDate: "2026-07-15",
        endDate: "2026-07-15",
        repeat: "weekly",
        repeatUntil: "2026-10-15",
      }),
      "2026-07-20",
    )
    expect(next.repeatUntil).toBe("2026-10-20")
  })

  it("繰り返し終了日が未入力なら空のまま(setRepeat の補完に委ねる)", () => {
    const next = applyStartDateShift(
      form({ repeat: "weekly", repeatUntil: "" }),
      "2026-07-20",
    )
    expect(next.repeatUntil).toBe("")
  })

  it("開始日をクリアしたときは終了日に触れない(差分が計算できないため)", () => {
    const next = applyStartDateShift(
      form({ startDate: "2026-07-15", endDate: "2026-07-17" }),
      "",
    )
    expect(next.startDate).toBe("")
    expect(next.endDate).toBe("2026-07-17")
  })

  it("開始日が空の状態から入力し直したときも終了日に触れない", () => {
    const next = applyStartDateShift(
      form({ startDate: "", endDate: "2026-07-17" }),
      "2026-07-20",
    )
    expect(next.startDate).toBe("2026-07-20")
    expect(next.endDate).toBe("2026-07-17")
  })
})

describe("formValueToTimestamps", () => {
  it("終日は start_at/end_at とも null", () => {
    expect(formValueToTimestamps(form({ isAllDay: true }))).toEqual({
      startAt: null,
      endAt: null,
    })
  })

  it("時刻ありは JST 壁時計を ISO へ変換する", () => {
    const { startAt, endAt } = formValueToTimestamps(
      form({ isAllDay: false, startTime: "14:00", endTime: "15:30" }),
    )
    expect(startAt).toBe("2026-07-15T05:00:00.000Z") // JST 14:00 = UTC 05:00
    expect(endAt).toBe("2026-07-15T06:30:00.000Z")
  })

  it("日付/時刻が空でも throw せず null を返す(RangeError で無反応にしない)", () => {
    expect(
      formValueToTimestamps(form({ isAllDay: false, startDate: "", startTime: "" })),
    ).toEqual({ startAt: null, endAt: null })
  })

  it("存在しない日付(2026-02-31)は throw せず、検証が日付不一致で弾く(無音で通さない)", () => {
    // 実測: Date は "2026-02-31" を Invalid にせず翌月へ繰り上げる。ゆえに
    // ISO は生成されるが、start_at の JST 暦日 ≠ startDate となり検証で落ちる。
    const v = form({ isAllDay: false, startDate: "2026-02-31", startTime: "09:00" })
    expect(() => formValueToTimestamps(v)).not.toThrow()
    const r = validateCalendarFormValue(v)
    expect(r.error).toBe("開始時刻の日付が開始日と一致しません")
    if (r.value === null) expect(r.field).toBe("startAt")
  })
})

describe("validateCalendarFormValue - サーバー検証と文言・判定が一致する", () => {
  it("終了日 < 開始日: 文言がサーバー検証と文字単位で一致し field は endDate", () => {
    const v = form({ startDate: "2026-07-15", endDate: "2026-07-14" })
    const client = validateCalendarFormValue(v)
    const server = validateCalendarEventInput({
      title: v.title,
      memo: v.memo,
      isAllDay: true,
      startDate: v.startDate,
      endDate: v.endDate,
    })
    expect(client.error).toBe(server.error)
    expect(client.error).toBe("終了日は開始日以降にしてください")
    expect(client.value).toBeNull()
    if (client.value === null) expect(client.field).toBe("endDate")
  })

  it("終了時刻 < 開始時刻: 文言がサーバー検証と一致し field は endAt", () => {
    const v = form({
      isAllDay: false,
      startTime: "15:00",
      endTime: "14:00",
    })
    const client = validateCalendarFormValue(v)
    const { startAt, endAt } = formValueToTimestamps(v)
    const server = validateCalendarEventInput({
      title: v.title,
      memo: v.memo,
      isAllDay: false,
      startDate: v.startDate,
      endDate: v.endDate,
      startAt,
      endAt,
    })
    expect(client.error).toBe(server.error)
    expect(client.error).toBe("終了時刻は開始時刻以降にしてください")
    if (client.value === null) expect(client.field).toBe("endAt")
  })

  it("繰り返し終了日 ≤ 開始日: 文言がサーバー検証と一致し field は repeatUntil", () => {
    const v = form({ repeat: "weekly", repeatUntil: "2026-07-15" })
    const client = validateCalendarFormValue(v)
    const server = validateCalendarEventInput({
      title: v.title,
      memo: v.memo,
      isAllDay: true,
      startDate: v.startDate,
      endDate: v.endDate,
      repeat: "weekly",
      repeatUntil: v.repeatUntil,
    })
    expect(client.error).toBe(server.error)
    expect(client.error).toBe("繰り返しの終了日は開始日より後にしてください")
    if (client.value === null) expect(client.field).toBe("repeatUntil")
  })

  it("空タイトルは field=title で弾く", () => {
    const r = validateCalendarFormValue(form({ title: "  " }))
    expect(r.error).toBe("タイトルを入力してください")
    if (r.value === null) expect(r.field).toBe("title")
  })

  it("時刻ありで開始時刻が空なら field=startAt で弾く", () => {
    const r = validateCalendarFormValue(form({ isAllDay: false, startTime: "" }))
    expect(r.error).toBe("開始時刻を入力してください")
    if (r.value === null) expect(r.field).toBe("startAt")
  })

  it("開始日が空なら field=startDate で弾く", () => {
    const r = validateCalendarFormValue(form({ startDate: "" }))
    expect(r.error).toBe("日付の形式が不正です")
    if (r.value === null) expect(r.field).toBe("startDate")
  })

  it("正常系は error なしで通す", () => {
    expect(validateCalendarFormValue(form()).error).toBeNull()
  })
})
