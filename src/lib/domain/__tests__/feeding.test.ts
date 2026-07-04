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
  FEEDING_DURATION_MIN,
  FEEDING_DURATION_MAX,
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
