import { describe, it, expect } from "vitest"
import {
  describeStale,
  initialFreshness,
  markFreshness,
  staleRanges,
} from "../freshness"

// JST 12:00 / 12:30 / 13:00
const T0 = Date.parse("2026-10-27T03:00:00Z")
const T1 = Date.parse("2026-10-27T03:30:00Z")
const T2 = Date.parse("2026-10-27T04:00:00Z")

describe("範囲ごとの最新の確認（C1）", () => {
  it("週だけ取れても日次は「最新」にならぬ（範囲を混ぜぬ）", () => {
    let f = initialFreshness({}, T0)
    f = markFreshness(f, "logs", false, T1)
    f = markFreshness(f, "weekly", true, T1)
    expect(staleRanges(f)).toEqual(["logs"])
    expect(describeStale(f, staleRanges(f))).toBe(
      "最新を確認できません: この日の記録（最終確認 12:00）",
    )
    // 失敗の後に成功すれば癒える
    f = markFreshness(f, "logs", true, T2)
    expect(staleRanges(f)).toEqual([])
    expect(describeStale(f, staleRanges(f))).toBeNull()
  })

  it("初回の取得に失敗した範囲は「まだ読み込めていません」（最終確認の時刻を作らぬ）", () => {
    const f = initialFreshness({ weekly: true }, T0)
    expect(staleRanges(f)).toEqual(["weekly"])
    expect(describeStale(f, ["weekly"])).toBe(
      "最新を確認できません: 週間（直近8日）（まだ読み込めていません）",
    )
  })

  it("最終確認の時刻が違う範囲は分けて書き、除いた範囲は出さぬ", () => {
    let f = initialFreshness({}, T0)
    f = markFreshness(f, "growth", true, T1)
    f = markFreshness(f, "growth", false, T2)
    f = markFreshness(f, "logs", false, T2)
    expect(describeStale(f, staleRanges(f))).toBe(
      "最新を確認できません: この日の記録（最終確認 12:00）、成長の記録（最終確認 12:30）",
    )
    expect(staleRanges(f, ["logs"])).toEqual(["growth"])
  })

  it("同じ結果の反映は同じ参照を返す（無駄な再描画をせぬ）", () => {
    const f = initialFreshness({}, T0)
    const failed = markFreshness(f, "logs", false, T1)
    expect(markFreshness(failed, "logs", false, T2)).toBe(failed)
  })
})
