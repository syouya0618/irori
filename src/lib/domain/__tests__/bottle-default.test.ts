/**
 * いつものミルク量の契約（src/lib/domain/bottle-default.ts）。
 *
 * 範囲（1〜999 の整数）は DB CHECK chk_bottle_default_ml・Server Action・量のシートの三者の
 * ミラーゆえ、境界の内外を対で固定する。読み方（decodeBottleDefault）は SSR と画面の取り直しが
 * 共有する唯一の規則で、「未設定」と「取得失敗」を取り違えぬことが要じゃ。
 */
import { describe, it, expect } from "vitest"
import {
  BOTTLE_DEFAULT_MAX_ML,
  BOTTLE_DEFAULT_MIN_ML,
  decodeBottleDefault,
  formatBottleAmount,
  isBottleDefaultMl,
} from "../bottle-default"

describe("isBottleDefaultMl（DB CHECK chk_bottle_default_ml のミラー）", () => {
  it("1〜999 の整数を受ける（境界を含む）", () => {
    expect(BOTTLE_DEFAULT_MIN_ML).toBe(1)
    expect(BOTTLE_DEFAULT_MAX_ML).toBe(999)
    for (const ok of [1, 120, 160, 999]) expect(isBottleDefaultMl(ok)).toBe(true)
  })

  it("範囲外・小数・数でない値は拒む（0 は「いつもの量」にならぬ）", () => {
    for (const ng of [0, -1, 1000, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isBottleDefaultMl(ng)).toBe(false)
    }
    for (const ng of ["120", null, undefined, {}, true]) {
      expect(isBottleDefaultMl(ng)).toBe(false)
    }
  })
})

describe("decodeBottleDefault（未設定と取得失敗を分ける唯一の規則）", () => {
  it("列が null の行は未設定", () => {
    expect(decodeBottleDefault({ data: { bottle_default_ml: null }, error: null })).toEqual({
      status: "unset",
    })
  })

  it("1〜999 の整数は決まっている量", () => {
    expect(decodeBottleDefault({ data: { bottle_default_ml: 120 }, error: null })).toEqual({
      status: "set",
      amountMl: 120,
    })
  })

  it("error があれば取得失敗（行が付いておっても信じぬ）", () => {
    expect(
      decodeBottleDefault({
        data: { bottle_default_ml: 120 },
        error: { message: "column does not exist", code: "42703" },
      }),
    ).toEqual({ status: "error" })
  })

  it("行が無い（RLS で見えぬ・session 切れの anon の 0 行）は未設定ではなく取得失敗", () => {
    // 未設定と読むと、決めてある量を知らぬまま設定し直させ、家族の量を上書きさせる
    expect(decodeBottleDefault({ data: null, error: null })).toEqual({ status: "error" })
  })

  it("列が欠けた応答・範囲外の値は取得失敗（量を出さぬ）", () => {
    for (const value of [undefined, 0, 1000, 12.5, "120"]) {
      expect(
        decodeBottleDefault({ data: { bottle_default_ml: value }, error: null }),
      ).toEqual({ status: "error" })
    }
  })
})

describe("formatBottleAmount", () => {
  it("タイムラインの要約（`${amount_ml}ml`）と同じ表記", () => {
    expect(formatBottleAmount(120)).toBe("120ml")
  })
})
