/**
 * 毎朝ダイジェスト（B-5）の語彙。
 *
 * ここで固定するのは 2 つじゃ:
 *   1. **画面と Server Action が同じ集合を見ておる**こと（別々に書けば必ずずれ、
 *      「選べるのに保存できぬ」という最も気付きにくい壊れ方をする）
 *   2. **DB の TIME（"07:00:00"）を画面の値（"07:00"）へ戻せる**こと —— これを
 *      落とすと保存済みの設定が空欄に見え、主は「保存できておらぬ」と誤解する
 */

import { describe, it, expect } from "vitest"
import {
  DIGEST_TIME_NONE,
  DIGEST_TIME_OPTIONS,
  DIGEST_TIME_SLOTS,
  isDigestTimeSlot,
  parseDigestTimeHm,
} from "../notification-digest"

describe("選択肢（30 分刻み）", () => {
  it("00:00 から 23:30 までの 48 個で、重複が無い", () => {
    expect(DIGEST_TIME_SLOTS).toHaveLength(48)
    expect(DIGEST_TIME_SLOTS[0]).toBe("00:00")
    expect(DIGEST_TIME_SLOTS[1]).toBe("00:30")
    expect(DIGEST_TIME_SLOTS.at(-1)).toBe("23:30")
    expect(new Set(DIGEST_TIME_SLOTS).size).toBe(48)
  })

  it("全て HH:MM（0 埋め）で、そのまま parse を通る", () => {
    for (const slot of DIGEST_TIME_SLOTS) {
      expect(slot).toMatch(/^\d{2}:(00|30)$/)
      expect(parseDigestTimeHm(slot)).toBe(slot)
    }
  })

  it("Select の選択肢は「送らない」+ 全スロット（画面と検証が同じ配列を見る）", () => {
    expect(DIGEST_TIME_OPTIONS[0]).toEqual({
      value: DIGEST_TIME_NONE,
      label: "送らない",
    })
    expect(DIGEST_TIME_OPTIONS).toHaveLength(DIGEST_TIME_SLOTS.length + 1)
    // 画面に出る値は全て Server Action が受け付ける（逆も然り）。
    for (const option of DIGEST_TIME_OPTIONS.slice(1)) {
      expect(isDigestTimeSlot(option.value)).toBe(true)
    }
  })
})

describe("isDigestTimeSlot — Server Action の allowlist", () => {
  it("刻みに乗った値だけを通す", () => {
    expect(isDigestTimeSlot("07:00")).toBe(true)
    expect(isDigestTimeSlot("07:30")).toBe(true)
  })

  it("刻みを外れた値・別物は通さぬ", () => {
    expect(isDigestTimeSlot("07:13")).toBe(false)
    expect(isDigestTimeSlot("07:00:00")).toBe(false)
    expect(isDigestTimeSlot(DIGEST_TIME_NONE)).toBe(false)
    expect(isDigestTimeSlot(null)).toBe(false)
    expect(isDigestTimeSlot(700)).toBe(false)
  })
})

describe("parseDigestTimeHm — DB の TIME を画面の値へ戻す", () => {
  it("Postgres が返す 秒つきの TIME を HH:MM にする", () => {
    // ⚠️ **この 1 行が落ちると、保存済みの設定が画面から消える。**
    expect(parseDigestTimeHm("07:00:00")).toBe("07:00")
    expect(parseDigestTimeHm("23:30:00")).toBe("23:30")
    expect(parseDigestTimeHm("07:00:00.123456")).toBe("07:00")
  })

  it("1 桁の時も 0 埋めして返す", () => {
    expect(parseDigestTimeHm("7:05")).toBe("07:05")
  })

  it("刻みに乗らぬ時刻も**捨てぬ**（画面が嘘をつかぬため）", () => {
    // SQL から直に入った値。捨てて null にすると、配信は 07:13 に鳴るのに
    // 画面は「送らない」と表示する ＝ 画面が嘘をつく。
    expect(parseDigestTimeHm("07:13")).toBe("07:13")
  })

  it("読めぬ値は null（fail-closed）", () => {
    expect(parseDigestTimeHm(null)).toBeNull()
    expect(parseDigestTimeHm(undefined)).toBeNull()
    expect(parseDigestTimeHm("")).toBeNull()
    expect(parseDigestTimeHm("なし")).toBeNull()
    expect(parseDigestTimeHm("24:00")).toBeNull()
    expect(parseDigestTimeHm("07:60")).toBeNull()
    expect(parseDigestTimeHm("-1:00")).toBeNull()
    expect(parseDigestTimeHm(700)).toBeNull()
  })
})
