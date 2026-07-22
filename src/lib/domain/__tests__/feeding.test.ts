/**
 * clampFeedingDuration の回帰テスト。
 *
 * 授乳タイマーの記録時間を DB CHECK 制約 (duration_min BETWEEN 0 AND 180) の
 * 範囲へ倒す純関数の挙動を固定する。特に NaN / ±Infinity 経路のピン留めが本命:
 * Math.min/Math.max は NaN を伝播し、durationMin:NaN → wire で null coerce →
 * DB CHECK の IS NULL 分岐をすり抜けて「duration の無い授乳行」を誤記録する
 * 事故（sagyo_hyojun PR #8 learning）の回帰防止。
 */

import { describe, it, expect } from "vitest"
import {
  clampFeedingDuration,
  clampFeedingDurationSec,
  deriveDurationMinFromSec,
  allowsDuration,
  parseFeedingDurationInput,
  FEEDING_DURATION_MIN,
  FEEDING_DURATION_MAX,
  FEEDING_DURATION_SEC_MIN,
  FEEDING_DURATION_SEC_MAX,
} from "../feeding"

describe("clampFeedingDuration: 境界クランプ", () => {
  it.each([
    ["0 → 下限 1 に倒す", 0, 1],
    ["1 → 1（下限そのまま）", 1, 1],
    ["90 → 90（範囲内素通し）", 90, 90],
    ["180 → 180（上限そのまま）", 180, 180],
    ["180.5 → round(181) → 上限 180 に倒す", 180.5, 180],
    ["181 → 上限 180 に倒す", 181, 180],
    ["2160 (36h) → 上限 180 に倒す", 2160, 180],
    ["-5 → 下限 1 に倒す", -5, 1],
  ] as const)("%s", (_label, input, expected) => {
    expect(clampFeedingDuration(input)).toBe(expected)
  })
})

describe("clampFeedingDuration: 非有限値は最保守の下限へ（NaN すり抜け防御）", () => {
  it.each([
    ["NaN → 下限 1", NaN, 1],
    ["Infinity → 下限 1", Infinity, 1],
    ["-Infinity → 下限 1", -Infinity, 1],
  ] as const)("%s", (_label, input, expected) => {
    expect(clampFeedingDuration(input)).toBe(expected)
  })
})

describe("clampFeedingDuration: 定数", () => {
  it("下限/上限定数が DB CHECK と一致する", () => {
    expect(FEEDING_DURATION_MIN).toBe(1)
    expect(FEEDING_DURATION_MAX).toBe(180)
  })
})

describe("clampFeedingDurationSec: 秒精度の境界クランプ", () => {
  it.each([
    ["0 → 下限 1 秒", 0, 1],
    ["1 → 1", 1, 1],
    ["160 (2:40) → 素通し", 160, 160],
    ["900 (15:00) → 素通し", 900, 900],
    ["10800 (180分) → 上限そのまま", 10800, 10800],
    ["10801 → 上限 10800 に倒す", 10801, 10800],
    ["-5 → 下限 1", -5, 1],
    ["NaN → 下限 1（すり抜け防御）", NaN, 1],
    ["Infinity → 下限 1", Infinity, 1],
  ] as const)("%s", (_label, input, expected) => {
    expect(clampFeedingDurationSec(input)).toBe(expected)
  })

  it("秒の定数が分定数と整合する（SEC_MAX = MAX × 60）", () => {
    expect(FEEDING_DURATION_SEC_MIN).toBe(1)
    expect(FEEDING_DURATION_SEC_MAX).toBe(FEEDING_DURATION_MAX * 60)
  })
})

describe("deriveDurationMinFromSec: 秒→分（後方互換の丸め）", () => {
  it.each([
    ["null → null（時間なし）", null, null],
    ["undefined → null", undefined, null],
    ["NaN → null", NaN, null],
    ["0 → 0", 0, 0],
    ["29 → 0（round down）", 29, 0],
    ["30 → 1（round up）", 30, 1],
    ["160 (2:40) → 3（round 2.67）", 160, 3],
    ["900 (15:00) → 15", 900, 15],
  ] as const)("%s", (_label, input, expected) => {
    expect(deriveDurationMinFromSec(input)).toBe(expected)
  })
})

describe("allowsDuration（時間を持ちうる授乳タイプ）", () => {
  it("母乳（左右）のみ true、他は false", () => {
    expect(allowsDuration("breast_left")).toBe(true)
    expect(allowsDuration("breast_right")).toBe(true)
    expect(allowsDuration("bottle")).toBe(false)
    expect(allowsDuration("solid")).toBe(false)
    expect(allowsDuration("pumped")).toBe(false)
  })
})

describe("parseFeedingDurationInput（分・秒入力 → duration_sec）", () => {
  it("両方空は null（時間なしへ戻す）でエラーなし", () => {
    expect(parseFeedingDurationInput("", "")).toEqual({
      value: null,
      error: null,
    })
    expect(parseFeedingDurationInput("  ", " ")).toEqual({
      value: null,
      error: null,
    })
  })

  it("分・秒を合算し、片方のみは 0 補完する", () => {
    expect(parseFeedingDurationInput("5", "30").value).toBe(330)
    expect(parseFeedingDurationInput("5", "").value).toBe(300)
    expect(parseFeedingDurationInput("", "45").value).toBe(45)
    expect(parseFeedingDurationInput("180", "0").value).toBe(10800)
  })

  it("0分0秒は明示エラー（消すなら空欄に誘導）", () => {
    const r = parseFeedingDurationInput("0", "0")
    expect(r.value).toBeNull()
    expect(r.error).toContain("1秒以上")
  })

  it("上限 180 分超・秒 59 超・負値・非整数・非数値はエラー", () => {
    expect(parseFeedingDurationInput("180", "1").error).toContain("最大180分")
    expect(parseFeedingDurationInput("3", "60").error).toBeTruthy()
    expect(parseFeedingDurationInput("-1", "0").error).toBeTruthy()
    expect(parseFeedingDurationInput("1.5", "0").error).toBeTruthy()
    expect(parseFeedingDurationInput("abc", "0").error).toBeTruthy()
  })
})
