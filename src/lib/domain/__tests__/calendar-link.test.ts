/**
 * `/calendar?date=` の契約（B-6）。**書く側と読む側を同じ文脈で縛る。**
 *
 * ## なぜ「日」と「月」を 1 つの関数で見るか
 * 欠陥は「選択日を渡し忘れた」ことではなく、**選択日だけ動かして月を今月に
 * 残す**ことじゃった（PR #163 が既知の制限として残した宿題）。日と月を
 * 別々に決める実装は、日を assert するだけのテストを全部緑で通り抜ける ——
 * 7/31 に届いた通知を叩くと 7 月のグリッドに「8月1日 の予定」が並ぶ。
 * ゆえに `resolveCalendarDateView` が両方を返し、ここで**対で**固定する。
 *
 * ## 時計を注入する
 * 「今日へ倒れる」を実時刻で見ると、月末 23:59 に走った日だけ落ちる類の
 * flake になる。`now` を注入して 1 点で撃つ。
 */

import { describe, it, expect } from "vitest"
import {
  CALENDAR_DATE_PARAM,
  CALENDAR_PATH,
  calendarUrlForDate,
  resolveCalendarDateView,
} from "@/lib/domain/calendar-link"
import { todayJstString } from "@/lib/utils/date-jst"

// JST では 2026-08-08（UTC+9 で日を跨ぐ手前に置き、TZ 依存を露わにする）
const NOW = new Date("2026-08-08T03:00:00.000Z")
const TODAY = "2026-08-08"
const THIS_MONTH = "2026-08-01"

describe("resolveCalendarDateView — ?date= の解釈", () => {
  it("時計の注入が効いておる（この前提が崩れると以下の期待値が意味を失う）", () => {
    expect(todayJstString(NOW)).toBe(TODAY)
  })

  it("`?date=2026-09-01` は 9 月を開く（**月跨ぎ**。日だけ動かす実装では割れる）", () => {
    expect(resolveCalendarDateView("2026-09-01", NOW)).toEqual({
      selectedDate: "2026-09-01",
      monthFirst: "2026-09-01",
    })
  })

  it("月末→翌月頭（7/31 に届く「前日20時」の通知）でも月が追随する", () => {
    // 通知を出す側の日（7/31）とは無関係に、着地は指された日の月で開く。
    expect(
      resolveCalendarDateView("2026-08-01", new Date("2026-07-31T11:00:00.000Z")),
    ).toEqual({ selectedDate: "2026-08-01", monthFirst: "2026-08-01" })
  })

  it("同じ月の別の日はその日を選び、月は動かさぬ", () => {
    expect(resolveCalendarDateView("2026-08-20", NOW)).toEqual({
      selectedDate: "2026-08-20",
      monthFirst: THIS_MONTH,
    })
  })

  it("date 無し（undefined）なら従来どおり今日", () => {
    expect(resolveCalendarDateView(undefined, NOW)).toEqual({
      selectedDate: TODAY,
      monthFirst: THIS_MONTH,
    })
  })

  // 不正入力は**今日へ倒す**。ここを緩めると `2026-02-30` が Date.UTC で 3/2 へ
  // 繰り上がり、静かに違う日を開く（PR #199 で弾いた型の事故）。
  it.each([
    ["実在せぬ日", "2026-02-30"],
    ["実在せぬ月", "2026-13-01"],
    ["日付でない文字列", "abc"],
    ["空文字", ""],
    ["区切り違い", "2026/09/01"],
    ["前後に空白", " 2026-09-01 "],
    ["時刻付き", "2026-09-01T00:00:00Z"],
  ])("不正な date（%s）は今日へ倒れる", (_label, raw) => {
    expect(resolveCalendarDateView(raw, NOW)).toEqual({
      selectedDate: TODAY,
      monthFirst: THIS_MONTH,
    })
  })

  it("`?date=a&date=b`（配列）も今日へ倒れる（先頭を拾って信じたりせぬ）", () => {
    expect(resolveCalendarDateView(["2026-09-01", "2026-10-01"], NOW)).toEqual({
      selectedDate: TODAY,
      monthFirst: THIS_MONTH,
    })
  })
})

describe("calendarUrlForDate — 通知が運ぶ着地先", () => {
  it("妥当な日付はクエリに載る", () => {
    expect(calendarUrlForDate("2026-09-01")).toBe("/calendar?date=2026-09-01")
  })

  it("クエリ名と経路は定数と一致する（綴りを 2 箇所に持たぬ）", () => {
    const url = new URL(calendarUrlForDate("2026-09-01"), "https://example.test")
    expect(url.pathname).toBe(CALENDAR_PATH)
    expect(url.searchParams.get(CALENDAR_DATE_PARAM)).toBe("2026-09-01")
  })

  it.each([
    ["実在せぬ日", "2026-02-30"],
    ["日付でない文字列", "abc"],
    ["空文字", ""],
    ["null", null],
    ["undefined", undefined],
  ])("不正な日付（%s）は素の /calendar へ倒す", (_label, raw) => {
    expect(calendarUrlForDate(raw)).toBe(CALENDAR_PATH)
  })

  it("**往復が閉じておる**: 書いた URL を読み直すと同じ日が出る", () => {
    // 2028 は閏年（2026-02-29 は実在せぬゆえここへ混ぜてはならぬ）。
    for (const day of ["2026-01-01", "2028-02-29", "2026-09-01", "2026-12-31"]) {
      const url = new URL(calendarUrlForDate(day), "https://example.test")
      const param = url.searchParams.get(CALENDAR_DATE_PARAM) ?? undefined
      expect(resolveCalendarDateView(param, NOW)).toEqual({
        selectedDate: day,
        monthFirst: `${day.slice(0, 7)}-01`,
      })
    }
  })
})
