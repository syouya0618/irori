import { describe, it, expect } from "vitest"
import {
  computeNextPumping,
  findLastPumped,
  normalizePumpingInterval,
  PUMPING_INTERVAL_MIN,
  PUMPING_INTERVAL_MAX,
  PUMPING_INTERVAL_DEFAULT,
} from "../baby-pumping"
import type { BabyLogData } from "@/lib/types/baby"

function mkLog(overrides: Partial<BabyLogData>): BabyLogData {
  return {
    id: "l1",
    log_type: "feeding",
    logged_at: "2026-07-21T10:00:00+09:00",
    logged_by: "u1",
    feeding_type: "pumped",
    amount_ml: 60,
    breast_left_count: null,
    breast_right_count: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-07-21T10:00:00+09:00",
    ...overrides,
  }
}

describe("computeNextPumping", () => {
  it("最後の搾乳＋間隔を目安時刻とし、残り分を返す", () => {
    // 10:00 搾乳 + 180分 → 13:00 が目安。now 12:30 なら残り30分
    const now = new Date("2026-07-21T12:30:00+09:00")
    const r = computeNextPumping("2026-07-21T10:00:00+09:00", 180, now)
    expect(new Date(r.targetIso).getTime()).toBe(
      new Date("2026-07-21T13:00:00+09:00").getTime(),
    )
    expect(r.minutesUntil).toBe(30)
  })

  it("目安時刻を過ぎていると minutesUntil は負になる", () => {
    const now = new Date("2026-07-21T13:30:00+09:00")
    const r = computeNextPumping("2026-07-21T10:00:00+09:00", 180, now)
    expect(r.minutesUntil).toBe(-30)
  })

  it("間隔を変えると目安時刻も変わる（設定反映）", () => {
    const now = new Date("2026-07-21T10:00:00+09:00")
    const r = computeNextPumping("2026-07-21T10:00:00+09:00", 120, now)
    expect(new Date(r.targetIso).getTime()).toBe(
      new Date("2026-07-21T12:00:00+09:00").getTime(),
    )
    expect(r.minutesUntil).toBe(120)
  })
})

describe("findLastPumped", () => {
  it("搾乳ログのうち最新（logged_at 最大）を返す", () => {
    const logs = [
      mkLog({ id: "a", logged_at: "2026-07-21T08:00:00+09:00" }),
      mkLog({ id: "b", logged_at: "2026-07-21T11:00:00+09:00" }),
      mkLog({ id: "c", feeding_type: "bottle" }), // 搾乳でない
    ]
    expect(findLastPumped(logs)?.id).toBe("b")
  })

  it("搾乳ログが無ければ null", () => {
    const logs = [
      mkLog({ feeding_type: "bottle" }),
      mkLog({ feeding_type: "breast_left", log_type: "feeding" }),
      mkLog({ log_type: "diaper", feeding_type: null }),
    ]
    expect(findLastPumped(logs)).toBeNull()
  })
})

describe("normalizePumpingInterval", () => {
  it.each([
    ["範囲内はそのまま", 180, 180],
    ["下限", PUMPING_INTERVAL_MIN, PUMPING_INTERVAL_MIN],
    ["上限", PUMPING_INTERVAL_MAX, PUMPING_INTERVAL_MAX],
    ["小数は round", 179.6, 180],
  ] as const)("%s", (_l, input, expected) => {
    expect(normalizePumpingInterval(input)).toBe(expected)
  })

  it.each([
    ["下限未満は null", 10],
    ["上限超は null", 1000],
    ["NaN は null", NaN],
    ["Infinity は null", Infinity],
  ] as const)("%s", (_l, input) => {
    expect(normalizePumpingInterval(input)).toBeNull()
  })

  it("既定値は範囲内", () => {
    expect(normalizePumpingInterval(PUMPING_INTERVAL_DEFAULT)).toBe(
      PUMPING_INTERVAL_DEFAULT,
    )
  })
})
