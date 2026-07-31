import { describe, it, expect } from "vitest"
import {
  computeNextFeeding,
  findLastNursing,
  normalizeFeedingInterval,
  FEEDING_INTERVAL_MIN,
  FEEDING_INTERVAL_MAX,
  FEEDING_INTERVAL_DEFAULT,
} from "../baby-feeding-interval"
import type { BabyLogData } from "@/lib/types/baby"

function mkLog(overrides: Partial<BabyLogData>): BabyLogData {
  return {
    id: "l1",
    log_type: "feeding",
    logged_at: "2026-07-21T10:00:00+09:00",
    logged_by: "u1",
    feeding_type: "bottle",
    amount_ml: 60,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    diaper_type: null,
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

describe("computeNextFeeding", () => {
  it("最後の授乳の開始時刻＋間隔を目安時刻とし、残り分を返す", () => {
    // 10:00 授乳開始 + 180分 → 13:00 が目安。now 12:30 なら残り30分
    const now = new Date("2026-07-21T12:30:00+09:00")
    const r = computeNextFeeding("2026-07-21T10:00:00+09:00", 180, now)
    expect(new Date(r.targetIso).getTime()).toBe(
      new Date("2026-07-21T13:00:00+09:00").getTime(),
    )
    expect(r.minutesUntil).toBe(30)
  })

  it("目安時刻を過ぎていると minutesUntil は負になる", () => {
    const now = new Date("2026-07-21T13:30:00+09:00")
    const r = computeNextFeeding("2026-07-21T10:00:00+09:00", 180, now)
    expect(r.minutesUntil).toBe(-30)
  })

  it("間隔を変えると目安時刻も変わる（設定反映）", () => {
    const now = new Date("2026-07-21T10:00:00+09:00")
    const r = computeNextFeeding("2026-07-21T10:00:00+09:00", 120, now)
    expect(new Date(r.targetIso).getTime()).toBe(
      new Date("2026-07-21T12:00:00+09:00").getTime(),
    )
    expect(r.minutesUntil).toBe(120)
  })

  it("所要時間（duration）を足さず「開始 → 次の開始」で数える", () => {
    // logged_at は開始時刻セマンティクス。20分かかった授乳でも目安は開始+間隔。
    const now = new Date("2026-07-21T10:00:00+09:00")
    const r = computeNextFeeding("2026-07-21T10:00:00+09:00", 180, now)
    expect(new Date(r.targetIso).getTime()).toBe(
      new Date("2026-07-21T13:00:00+09:00").getTime(),
    )
  })
})

describe("findLastNursing", () => {
  it("授乳ログのうち最新（logged_at 最大）を返す", () => {
    const logs = [
      mkLog({ id: "a", logged_at: "2026-07-21T08:00:00+09:00" }),
      mkLog({ id: "b", logged_at: "2026-07-21T11:00:00+09:00" }),
      mkLog({ id: "c", log_type: "diaper", feeding_type: null }),
    ]
    expect(findLastNursing(logs)?.id).toBe("b")
  })

  it("搾乳（pumped）は起点にしない — 赤子に与えていないため目安をリセットしない", () => {
    const logs = [
      mkLog({ id: "breast", feeding_type: "breast", logged_at: "2026-07-21T09:00:00+09:00" }),
      mkLog({ id: "pumped", feeding_type: "pumped", logged_at: "2026-07-21T11:00:00+09:00" }),
    ]
    expect(findLastNursing(logs)?.id).toBe("breast")
  })

  it("搾乳しか無ければ null（目安を出さない）", () => {
    const logs = [
      mkLog({ id: "p1", feeding_type: "pumped", logged_at: "2026-07-21T08:00:00+09:00" }),
      mkLog({ id: "p2", feeding_type: "pumped", logged_at: "2026-07-21T11:00:00+09:00" }),
      mkLog({ id: "d", log_type: "diaper", feeding_type: null }),
    ]
    expect(findLastNursing(logs)).toBeNull()
  })

  it.each([
    ["母乳サイクル", "breast"],
    ["移行前の左", "breast_left"],
    ["移行前の右", "breast_right"],
    ["ミルク", "bottle"],
    ["離乳食", "solid"],
  ] as const)("%s は起点になる", (_label, feedingType) => {
    const logs = [mkLog({ id: "x", feeding_type: feedingType })]
    expect(findLastNursing(logs)?.id).toBe("x")
  })

  it("feeding_type が null へ退化した授乳行（#147/#158 の enum drift）も起点になる", () => {
    // 未知 ENUM 値は client 側で null へ退化する契約。ここで落とすと「実際に
    // 飲ませた記録が目安を動かさない」＝本 issue の主訴がそのまま再発する。
    // 判定は pumped 1 値の denylist ゆえ null は授乳側に残る、の固定。
    const logs = [
      mkLog({ id: "null-type", feeding_type: null, logged_at: "2026-07-21T11:00:00+09:00" }),
      mkLog({ id: "pumped", feeding_type: "pumped", logged_at: "2026-07-21T12:00:00+09:00" }),
    ]
    expect(findLastNursing(logs)?.id).toBe("null-type")
  })

  it("未知の feeding_type（DB ENUM 追加に TS 未追随）も授乳として数える", () => {
    // 搾乳だけを名指しで外す実装ゆえ、新種の授乳が無音で目安から漏れない
    const logs = [
      mkLog({
        id: "unknown",
        // @ts-expect-error DB 側にだけ存在する新 ENUM 値の再現
        feeding_type: "formula_special",
      }),
    ]
    expect(findLastNursing(logs)?.id).toBe("unknown")
  })

  it("楽観行（Z 表記）とサーバ行（+00:00 表記）が混在しても時刻順で選ぶ", () => {
    // 文字列比較だと "2026-07-21T02:00:00+00:00" > "2026-07-21T04:00:00Z" になり
    // 古い行が勝つ（辞書順 "+" < "Z"）。epoch 比較であることの固定。
    const logs = [
      mkLog({ id: "server", logged_at: "2026-07-21T02:00:00+00:00" }), // JST 11:00
      mkLog({ id: "optimistic", logged_at: "2026-07-21T04:00:00Z" }), // JST 13:00
    ]
    expect(findLastNursing(logs)?.id).toBe("optimistic")
  })

  it("授乳が1件も無ければ null", () => {
    expect(findLastNursing([])).toBeNull()
    expect(
      findLastNursing([mkLog({ log_type: "diaper", feeding_type: null })]),
    ).toBeNull()
  })
})

describe("normalizeFeedingInterval", () => {
  it.each([
    ["範囲内はそのまま", 180, 180],
    ["下限", FEEDING_INTERVAL_MIN, FEEDING_INTERVAL_MIN],
    ["上限", FEEDING_INTERVAL_MAX, FEEDING_INTERVAL_MAX],
    ["小数は round", 179.6, 180],
  ] as const)("%s", (_l, input, expected) => {
    expect(normalizeFeedingInterval(input)).toBe(expected)
  })

  it.each([
    ["下限未満は null", 10],
    ["上限超は null", 1000],
    ["NaN は null", NaN],
    ["Infinity は null", Infinity],
  ] as const)("%s", (_l, input) => {
    expect(normalizeFeedingInterval(input)).toBeNull()
  })

  it("既定値は範囲内", () => {
    expect(normalizeFeedingInterval(FEEDING_INTERVAL_DEFAULT)).toBe(
      FEEDING_INTERVAL_DEFAULT,
    )
  })
})
