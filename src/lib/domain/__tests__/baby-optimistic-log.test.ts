import { describe, it, expect, vi, afterEach } from "vitest"
import { buildOptimisticLog } from "../baby-optimistic-log"

describe("buildOptimisticLog (B-03)", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("feeding: 指定フィールドを埋め、未指定は null にする", () => {
    const log = buildOptimisticLog({
      id: "f1",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "bottle",
      amountMl: 120,
    })
    expect(log.id).toBe("f1")
    expect(log.log_type).toBe("feeding")
    expect(log.logged_by).toBe("u1")
    expect(log.feeding_type).toBe("bottle")
    expect(log.amount_ml).toBe(120)
    // 未指定は全て null
    expect(log.diaper_type).toBeNull()
    expect(log.ended_at).toBeNull()
    expect(log.temperature).toBeNull()
    expect(log.weight_g).toBeNull()
    expect(log.height_cm).toBeNull()
    expect(log.duration_min).toBeNull()
    expect(log.memo).toBeNull()
  })

  it("diaper: diaper_type を埋める", () => {
    const log = buildOptimisticLog({
      id: "d1",
      logType: "diaper",
      loggedBy: "u1",
      diaperType: "poop",
    })
    expect(log.log_type).toBe("diaper")
    expect(log.diaper_type).toBe("poop")
    expect(log.feeding_type).toBeNull()
  })

  it("sleep: ended_at 未指定はアクティブ睡眠（null）", () => {
    const log = buildOptimisticLog({
      id: "s1",
      logType: "sleep",
      loggedBy: "u1",
    })
    expect(log.log_type).toBe("sleep")
    expect(log.ended_at).toBeNull()
  })

  it("logged_at 未指定時は呼び出し時刻を使う", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-19T05:00:00Z"))
    const log = buildOptimisticLog({
      id: "m1",
      logType: "memo",
      loggedBy: "u1",
      memo: "hi",
    })
    expect(log.logged_at).toBe("2026-07-19T05:00:00.000Z")
    expect(log.created_at).toBe("2026-07-19T05:00:00.000Z")
    expect(log.memo).toBe("hi")
  })

  it("logged_at を明示したらそれを使う", () => {
    const log = buildOptimisticLog({
      id: "t1",
      logType: "temperature",
      loggedBy: "u1",
      loggedAt: "2026-07-18T22:00:00+09:00",
      temperature: 36.7,
    })
    expect(log.logged_at).toBe("2026-07-18T22:00:00+09:00")
    expect(log.temperature).toBe(36.7)
  })

  it("amountMl=0 の falsy 値も null に潰さず 0 を保持する", () => {
    const log = buildOptimisticLog({
      id: "z1",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "bottle",
      amountMl: 0,
    })
    expect(log.amount_ml).toBe(0)
  })
})
