import { describe, it, expect } from "vitest"
import { isTimestamptzText } from "../timestamptz-text"

describe("isTimestamptzText", () => {
  it.each([
    ["PostgREST の表記", "2026-07-22T03:00:00.123456+00:00"],
    ["Realtime の空白区切り・+00 短縮", "2026-07-22 03:00:00.123456+00"],
    ["秒未満なし・Z 終端", "2026-07-22T03:00:00Z"],
    ["JST オフセット", "2026-07-22T12:00:00.5+09:00"],
    ["コロン無しのオフセット", "2026-07-22T03:00:00+0000"],
  ])("受ける: %s", (_name, value) => {
    expect(isTimestamptzText(value)).toBe(true)
  })

  it.each([
    ["日付だけ", "2026-07-22"],
    ["オフセット無し（TZ を推測させぬ）", "2026-07-22T03:00:00.123456"],
    ["秒未満が 7 桁（Postgres はマイクロ秒まで）", "2026-07-22T03:00:00.1234567+00:00"],
    ["空文字", ""],
    ["数値", 1753153200000],
    ["null", null],
    ["undefined", undefined],
    ["PostgREST の論理木を壊しうる文字", '2026-07-22T03:00:00+00:00",id.gt.x'],
  ])("拒む: %s", (_name, value) => {
    expect(isTimestamptzText(value)).toBe(false)
  })
})
