import { describe, it, expect } from "vitest"
import {
  jstDateTimeToIso,
  validateLogTime,
  FUTURE_LOG_TIME_ERROR,
  INVALID_LOG_TIME_ERROR,
} from "../baby-log-time"

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
