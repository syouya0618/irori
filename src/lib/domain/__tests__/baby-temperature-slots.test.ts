/**
 * 朝/夜の体温スロット（訴え③）の純関数テスト。
 *
 * 固定する契約:
 * - 境界は**両側を対で**置く（11:59/12:00・00:00/23:59・37.4/37.5）。片側だけでは
 *   `<` と `<=` を取り違えても通ってしまう
 * - 同枠の主表示は**その枠の最新**。比較は epoch（文字列比較では割れる）
 * - JST 判定（UTC 罠）・不正行の無視
 */

import { describe, it, expect } from "vitest"
import {
  TEMPERATURE_SLOT_BOUNDARY_HOUR,
  FEVER_THRESHOLD_C,
  assignTemperatureSlot,
  buildDailyTemperature,
  isFeverTemperature,
} from "../baby-temperature-slots"
import type { BabyLogData } from "@/lib/types/baby"

const YMD = "2026-04-16"

const baseLog = {
  logged_by: "user-1",
  feeding_type: null,
  amount_ml: null,
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
  created_at: "2026-04-16T00:00:00+09:00",
} satisfies Omit<BabyLogData, "id" | "log_type" | "logged_at">

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return { ...baseLog, ...overrides }
}

/** 体温行のショートハンド（JST 壁時計 + 気温を渡す） */
function temp(id: string, jstTime: string, temperature: number): BabyLogData {
  return makeLog({
    id,
    log_type: "temperature",
    logged_at: `${YMD}T${jstTime}+09:00`,
    temperature,
  })
}

describe("定数", () => {
  it("境界は 12 時・発熱閾値は 37.5℃", () => {
    expect(TEMPERATURE_SLOT_BOUNDARY_HOUR).toBe(12)
    expect(FEVER_THRESHOLD_C).toBe(37.5)
  })
})

describe("assignTemperatureSlot / 境界は両側を対で固定する", () => {
  it("11:59 JST は朝、12:00 JST は夜（境界のズレを検出する対）", () => {
    expect(assignTemperatureSlot(`${YMD}T11:59:00+09:00`)).toBe("morning")
    expect(assignTemperatureSlot(`${YMD}T12:00:00+09:00`)).toBe("night")
  })

  it("00:00 JST は朝、23:59 JST は夜（1 日の両端を対で固定する）", () => {
    // 深夜 0 時は朝枠に属する、という製品判断をここで固定する。
    // 実装が hourCycle 無指定のフォーマッタへ退行すると "24:00" → 24 >= 12 で
    // 夜へ落ちうるため、契約として明示しておく。
    expect(assignTemperatureSlot(`${YMD}T00:00:00+09:00`)).toBe("morning")
    expect(assignTemperatureSlot(`${YMD}T23:59:00+09:00`)).toBe("night")
  })

  it("UTC 表記（Z 終端）でも JST の時刻で振り分ける", () => {
    // UTC 03:00 = JST 12:00 → 夜。UTC 02:59 = JST 11:59 → 朝。
    expect(assignTemperatureSlot(`${YMD}T02:59:00.000Z`)).toBe("morning")
    expect(assignTemperatureSlot(`${YMD}T03:00:00.000Z`)).toBe("night")
  })

  it("不正な ISO は throw せず morning へ倒す", () => {
    expect(() => assignTemperatureSlot("not-a-date")).not.toThrow()
    expect(assignTemperatureSlot("not-a-date")).toBe("morning")
  })
})

describe("buildDailyTemperature / 基本形", () => {
  it("朝と夜が 1 件ずつなら両方が主表示・追加件数は 0", () => {
    const result = buildDailyTemperature(
      [temp("t-am", "07:12:00", 36.7), temp("t-pm", "19:30:00", 36.9)],
      YMD,
    )

    expect(result.morning).toEqual({
      id: "t-am",
      temperature: 36.7,
      loggedAt: `${YMD}T07:12:00+09:00`,
    })
    expect(result.night).toEqual({
      id: "t-pm",
      temperature: 36.9,
      loggedAt: `${YMD}T19:30:00+09:00`,
    })
    expect(result.morningExtra).toBe(0)
    expect(result.nightExtra).toBe(0)
  })

  it("体温ログが無ければ両枠 null・追加件数 0（空状態）", () => {
    const result = buildDailyTemperature([], YMD)
    expect(result).toEqual({
      morning: null,
      night: null,
      morningExtra: 0,
      nightExtra: 0,
    })
  })
})

describe("buildDailyTemperature / 同枠に複数", () => {
  it("同枠の最新が主表示になり extra が残りの件数を数える", () => {
    const result = buildDailyTemperature(
      [
        temp("t-am-1", "06:00:00", 36.5),
        temp("t-am-3", "10:00:00", 37.8), // 朝の最新
        temp("t-am-2", "08:00:00", 37.1),
        temp("t-pm-1", "20:00:00", 38.0), // 夜の最新
        temp("t-pm-2", "13:00:00", 37.2),
      ],
      YMD,
    )

    expect(result.morning?.id).toBe("t-am-3")
    expect(result.morning?.temperature).toBe(37.8)
    expect(result.morningExtra).toBe(2)

    expect(result.night?.id).toBe("t-pm-1")
    expect(result.night?.temperature).toBe(38.0)
    expect(result.nightExtra).toBe(1)
  })

  it("入力順が logged_at 順でなくても最新が選ばれる", () => {
    const result = buildDailyTemperature(
      [temp("t-late", "11:00:00", 37.0), temp("t-early", "05:00:00", 36.4)],
      YMD,
    )
    expect(result.morning?.id).toBe("t-late")
  })
})

describe("buildDailyTemperature / 表記混在でも epoch で最新を選ぶ", () => {
  it('楽観 append 行（"Z" 終端）とサーバ行（"+00:00"）が混在しても実時刻順で選ぶ', () => {
    // これは**辞書順と実時刻順が食い違う**ペアじゃ（検出力のある組み合わせ）:
    //   サーバ行     "2026-04-16T09:00:00+09:00" = JST 09:00
    //   楽観 append  "2026-04-16T01:00:00.000Z"  = JST 10:00（こちらが後）
    // 文字列比較では "…T09…" > "…T01…" ゆえサーバ行を選んでしまう（誤り）。
    // epoch 比較なら楽観 append 行を選ぶ（正しい）。
    const serverRow = makeLog({
      id: "server-row",
      log_type: "temperature",
      logged_at: `${YMD}T09:00:00+09:00`,
      temperature: 36.6,
    })
    const optimisticRow = makeLog({
      id: "optimistic-row",
      log_type: "temperature",
      logged_at: `${YMD}T01:00:00.000Z`,
      temperature: 37.4,
    })

    // 辞書順の前提そのものを固定する（このペアが検出力を持つことの担保）
    expect(serverRow.logged_at > optimisticRow.logged_at).toBe(true)

    const result = buildDailyTemperature([serverRow, optimisticRow], YMD)

    expect(result.morning?.id).toBe("optimistic-row")
    expect(result.morning?.temperature).toBe(37.4)
    expect(result.morningExtra).toBe(1)
    expect(result.night).toBeNull()
  })

  it("夜枠でも同じく epoch で選ぶ（朝枠と対にし、片方だけの退行を検出する）", () => {
    // 朝枠だけに検出力のある対を置くと、**夜枠の比較だけ**を文字列比較へ
    // 退行させた変更が緑のまま通ってしまう。ゆえに夜枠にも同型の対を置く:
    //   サーバ行     "2026-04-16T21:00:00+09:00" = JST 21:00
    //   楽観 append  "2026-04-16T13:00:00.000Z"  = JST 22:00（こちらが後）
    const serverRow = makeLog({
      id: "server-night",
      log_type: "temperature",
      logged_at: `${YMD}T21:00:00+09:00`,
      temperature: 36.6,
    })
    const optimisticRow = makeLog({
      id: "optimistic-night",
      log_type: "temperature",
      logged_at: `${YMD}T13:00:00.000Z`,
      temperature: 37.9,
    })

    expect(serverRow.logged_at > optimisticRow.logged_at).toBe(true)

    const result = buildDailyTemperature([serverRow, optimisticRow], YMD)

    expect(result.night?.id).toBe("optimistic-night")
    expect(result.night?.temperature).toBe(37.9)
    expect(result.nightExtra).toBe(1)
    expect(result.morning).toBeNull()
  })
})

describe("buildDailyTemperature / 無視すべき行", () => {
  it("log_type が temperature でない行は無視する", () => {
    const result = buildDailyTemperature(
      [
        makeLog({
          id: "feeding",
          log_type: "feeding",
          logged_at: `${YMD}T07:00:00+09:00`,
          feeding_type: "bottle",
          // 授乳行に体温が入っていても拾ってはならぬ
          temperature: 36.8,
        }),
        makeLog({
          id: "growth",
          log_type: "growth",
          logged_at: `${YMD}T19:00:00+09:00`,
          weight_g: 4500,
        }),
      ],
      YMD,
    )
    expect(result.morning).toBeNull()
    expect(result.night).toBeNull()
    expect(result.morningExtra).toBe(0)
    expect(result.nightExtra).toBe(0)
  })

  it("temperature が null の体温行は無視する", () => {
    const result = buildDailyTemperature(
      [
        makeLog({
          id: "t-null",
          log_type: "temperature",
          logged_at: `${YMD}T07:00:00+09:00`,
          temperature: null,
        }),
        temp("t-ok", "08:00:00", 36.6),
      ],
      YMD,
    )
    expect(result.morning?.id).toBe("t-ok")
    expect(result.morningExtra).toBe(0)
  })

  it("別日の体温行は無視する（JST 暦日で判定・UTC 罠を踏まぬ）", () => {
    // UTC 15:00 = JST 翌日 00:00 ゆえ、ymd=2026-04-16 の集計には入らない。
    const nextDayInJst = makeLog({
      id: "t-next-day",
      log_type: "temperature",
      logged_at: `${YMD}T15:00:00.000Z`,
      temperature: 38.5,
    })
    const result = buildDailyTemperature(
      [nextDayInJst, temp("t-today", "07:00:00", 36.6)],
      YMD,
    )
    expect(result.morning?.id).toBe("t-today")
    expect(result.morningExtra).toBe(0)
    expect(result.night).toBeNull()
  })

  it("不正な ISO の行は throw せず無視する", () => {
    const broken = makeLog({
      id: "t-broken",
      log_type: "temperature",
      logged_at: "not-a-date",
      temperature: 36.6,
    })
    expect(() => buildDailyTemperature([broken], YMD)).not.toThrow()
    expect(buildDailyTemperature([broken], YMD).morning).toBeNull()
  })
})

describe("isFeverTemperature / 閾値は両側を対で固定する", () => {
  it("37.5 は発熱・37.4 は発熱でない（>= と > の取り違えを検出する対）", () => {
    expect(isFeverTemperature(37.5)).toBe(true)
    expect(isFeverTemperature(37.4)).toBe(false)
  })

  it("平熱と高熱", () => {
    expect(isFeverTemperature(36.5)).toBe(false)
    expect(isFeverTemperature(39.0)).toBe(true)
  })
})
