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
    expect(log.duration_sec).toBeNull()
    expect(log.memo).toBeNull()
  })

  it("feeding: durationSec は秒精度を保持し duration_min は round で導出する", () => {
    const log = buildOptimisticLog({
      id: "f2",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "breast_left",
      durationSec: 160, // 2:40
    })
    expect(log.duration_sec).toBe(160)
    // サーバの recordFeeding と同じ round(160/60)=3 を共有
    expect(log.duration_min).toBe(3)
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

  it("breast: 左右の吸わせ回数を反映する（母乳サイクル行）", () => {
    const log = buildOptimisticLog({
      id: "b1",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 1,
      durationSec: 900,
    })
    expect(log.feeding_type).toBe("breast")
    expect(log.breast_left_count).toBe(2)
    expect(log.breast_right_count).toBe(1)
    expect(log.duration_sec).toBe(900)
    // サイクル行は amount_ml を持たない（DB chk_amount_ml と同じ契約）
    expect(log.amount_ml).toBeNull()
  })

  it("breast: 片側 0 も falsy に潰さず 0 を保持する", () => {
    // 「左2・右0」の 0 が null に化けると DB の chk_breast_counts_required
    // （左右とも NOT NULL）に弾かれ、楽観 append と DB 実体が乖離する
    const log = buildOptimisticLog({
      id: "b2",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "breast",
      breastLeftCount: 2,
      breastRightCount: 0,
    })
    expect(log.breast_left_count).toBe(2)
    expect(log.breast_right_count).toBe(0)
  })

  it("breast 以外の行では左右回数は null（未指定時の既定）", () => {
    const log = buildOptimisticLog({
      id: "b3",
      logType: "feeding",
      loggedBy: "u1",
      feedingType: "bottle",
      amountMl: 120,
    })
    expect(log.breast_left_count).toBeNull()
    expect(log.breast_right_count).toBeNull()
  })
})
