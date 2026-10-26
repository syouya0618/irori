import { describe, it, expect } from "vitest"
import {
  jstDateTimeToIso,
  moveLogTimeToJstDate,
  validateLogTime,
  FUTURE_LOG_TIME_ERROR,
  INVALID_LOG_TIME_ERROR,
} from "../baby-log-time"

describe("moveLogTimeToJstDate（編集で日付だけを変えた時の記録時刻）", () => {
  it("JST の時・分・秒・ミリ秒を保ったまま前日へ動かす", () => {
    // JST 7/19 00:10:31.123 → JST 7/18 00:10:31.123
    expect(moveLogTimeToJstDate("2026-07-18T15:10:31.123Z", "2026-07-18")).toBe(
      "2026-07-17T15:10:31.123Z",
    )
  })

  it("JST 23:59:59.500 も秒を落とさず前日の 23:59:59.500 になる", () => {
    expect(moveLogTimeToJstDate("2026-07-19T14:59:59.500Z", "2026-07-18")).toBe(
      "2026-07-18T14:59:59.500Z",
    )
  })

  it("後の日へも動かせる（日数の差は符号つき・複数日）", () => {
    // JST 7/18 00:10:31.123 → JST 7/20 00:10:31.123
    expect(moveLogTimeToJstDate("2026-07-17T15:10:31.123Z", "2026-07-20")).toBe(
      "2026-07-19T15:10:31.123Z",
    )
  })

  it("月を跨ぐ（JST 3/1 00:00:30 → 2/28 00:00:30）", () => {
    expect(moveLogTimeToJstDate("2026-02-28T15:00:30.000Z", "2026-02-28")).toBe(
      "2026-02-27T15:00:30.000Z",
    )
  })

  it("PostgREST の表記（マイクロ秒・+00:00）を受け、ミリ秒までを保つ", () => {
    expect(
      moveLogTimeToJstDate("2026-07-18T15:10:31.123456+00:00", "2026-07-18"),
    ).toBe("2026-07-17T15:10:31.123Z")
  })

  it("同じ日なら同じ瞬間（表記だけ ISO に揃う）", () => {
    expect(moveLogTimeToJstDate("2026-07-18T15:10:31.123Z", "2026-07-19")).toBe(
      "2026-07-18T15:10:31.123Z",
    )
  })

  it("不正な記録時刻・実在しない日付は null（黙って今の時刻へ倒さぬ）", () => {
    expect(moveLogTimeToJstDate("not-a-date", "2026-07-18")).toBeNull()
    expect(moveLogTimeToJstDate("2026-07-18T15:10:31.123Z", "2026-02-30")).toBeNull()
    expect(moveLogTimeToJstDate("2026-07-18T15:10:31.123Z", "")).toBeNull()
  })
})

describe("jstDateTimeToIso", () => {
  it("JST 日付 + HH:mm を UTC ISO へ（+09:00 明示・UTC 罠回避）", () => {
    // JST 20:00 = UTC 11:00
    expect(jstDateTimeToIso("2026-07-09", "20:00")).toBe(
      "2026-07-09T11:00:00.000Z",
    )
  })

  it("JST 0 時境界: 00:00 は前日 UTC 15:00 の ISO を返す", () => {
    expect(jstDateTimeToIso("2026-07-09", "00:00")).toBe(
      "2026-07-08T15:00:00.000Z",
    )
  })

  it("空文字・不正フォーマットは null（<input type=time> 空値の防御）", () => {
    expect(jstDateTimeToIso("2026-07-09", "")).toBeNull()
    expect(jstDateTimeToIso("2026-07-09", "9:5")).toBeNull()
    expect(jstDateTimeToIso("2026-07-09", "25:00")).toBeNull()
    expect(jstDateTimeToIso("2026-07-09", "abc")).toBeNull()
  })
})

describe("validateLogTime", () => {
  const now = new Date("2026-07-09T00:00:00Z") // JST 09:00

  it("過去・現在は妥当（null）", () => {
    expect(validateLogTime("2026-07-08T23:00:00Z", now)).toBeNull()
    expect(validateLogTime("2026-07-09T00:00:00Z", now)).toBeNull()
  })

  it("+5 分ちょうどは許容（時計ずれ）", () => {
    expect(validateLogTime("2026-07-09T00:05:00Z", now)).toBeNull()
  })

  it("+5 分超の未来は拒否（日本語メッセージ）", () => {
    expect(validateLogTime("2026-07-09T00:06:00Z", now)).toBe(
      FUTURE_LOG_TIME_ERROR,
    )
  })

  it("不正 ISO は拒否（日本語メッセージ）", () => {
    expect(validateLogTime("not-a-date", now)).toBe(INVALID_LOG_TIME_ERROR)
  })

  it("JST 0 時境界でも epoch 比較で正しく判定", () => {
    // now = JST 2026-07-09 00:30（UTC 前日 15:30）
    const midnightNow = new Date("2026-07-08T15:30:00Z")
    // JST 00:00（過去）は妥当
    expect(validateLogTime("2026-07-08T15:00:00Z", midnightNow)).toBeNull()
    // JST 01:00（未来）は拒否
    expect(validateLogTime("2026-07-08T16:00:00Z", midnightNow)).toBe(
      FUTURE_LOG_TIME_ERROR,
    )
  })
})
