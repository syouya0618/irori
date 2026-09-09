/**
 * formatElapsedMinutes の負値ガード回帰テスト（B-10 / H2-05）。
 *
 * useNow(60_000) の stale now × 記録直後の Realtime INSERT が重なると、
 * まだ更新されていない now を基準に minutesBetween が負の経過分を返しうる。
 * 負値がそのまま「-3分」のように表示されるのを防ぐため、
 * formatElapsedMinutes の入口で 0 未満を 0 にクランプする。
 */

import { describe, it, expect } from "vitest"
import {
  formatElapsedMinutes,
  formatBreastCounts,
  formatBreastSideBreakdown,
  formatBreastStartSide,
  formatDiaperSummary,
  getBreastStartSideLabel,
  getFeedingTypeLabel,
  getPoopAmountLabel,
} from "@/lib/utils/baby-log-labels"

describe("うんちの量（poop_amount）の表示", () => {
  it("small / large を 少量 / 大量 に写す", () => {
    expect(getPoopAmountLabel("small")).toBe("少量")
    expect(getPoopAmountLabel("large")).toBe("大量")
  })

  it("null・未知値（将来の DB 値）は null へ退化させ画面を倒さない", () => {
    expect(getPoopAmountLabel(null)).toBeNull()
    expect(getPoopAmountLabel(undefined)).toBeNull()
    expect(getPoopAmountLabel("medium")).toBeNull()
  })

  it("formatDiaperSummary: うんち（大量）/ 両方（少量）、量なしは種別のみ", () => {
    expect(formatDiaperSummary("poop", "large")).toBe("うんち（大量）")
    expect(formatDiaperSummary("both", "small")).toBe("両方（少量）")
    expect(formatDiaperSummary("poop", null)).toBe("うんち")
    expect(formatDiaperSummary("both", "weird")).toBe("両方")
  })

  it("formatDiaperSummary: pee 行は量が来ても描かない（契約のミラー）", () => {
    expect(formatDiaperSummary("pee", "large")).toBe("おしっこ")
  })
})

describe("母乳サイクルの開始側（breast_start_side）の表示", () => {
  it("left / right を 左 / 右 に写し、不明・未知値は null", () => {
    expect(getBreastStartSideLabel("left")).toBe("左")
    expect(getBreastStartSideLabel("right")).toBe("右")
    expect(getBreastStartSideLabel(null)).toBeNull()
    expect(getBreastStartSideLabel("both")).toBeNull()
  })

  it("formatBreastStartSide: （左から）/（右から）、不明は空文字", () => {
    expect(formatBreastStartSide("left")).toBe("（左から）")
    expect(formatBreastStartSide("right")).toBe("（右から）")
    expect(formatBreastStartSide(null)).toBe("")
    expect(formatBreastStartSide(undefined)).toBe("")
  })
})

describe("formatElapsedMinutes: 負値ガード", () => {
  it("負の分は 0分 にクランプされる（stale now による負値の表示崩れ防止）", () => {
    expect(formatElapsedMinutes(-3)).toBe("0分")
  })

  it("大きな負値も 0分 にクランプされる", () => {
    expect(formatElapsedMinutes(-120)).toBe("0分")
  })

  it("0分 はそのまま 0分", () => {
    expect(formatElapsedMinutes(0)).toBe("0分")
  })

  it("59分 は時間繰り上げしない", () => {
    expect(formatElapsedMinutes(59)).toBe("59分")
  })

  it("60分 は 1時間 ちょうど", () => {
    expect(formatElapsedMinutes(60)).toBe("1時間")
  })

  it("61分 は 1時間1分", () => {
    expect(formatElapsedMinutes(61)).toBe("1時間1分")
  })
})

/**
 * 母乳サイクル行（feeding_type='breast'）の表示ヘルパ。
 *
 * サイクル行は「1回の授乳で左右を何回ずつ吸わせたか」を1行に持つ。片側しか
 * 吸わせなかった回（左2・右0 等）が「右0」と表示されるのは情報量ゼロの雑音ゆえ、
 * 0 の側は省略する。両側 0（＝DB CHECK では起こらない）と null は空文字に退化させ、
 * 呼び出し側が「表示するものが無い」を空判定できるようにする。
 */
describe("formatBreastCounts", () => {
  it("左右とも 1 以上なら「左2・右1」の形で並べる", () => {
    expect(formatBreastCounts(2, 1)).toBe("左2・右1")
  })

  it("右が 0 なら右側を省略する（左2右0 → 左2）", () => {
    expect(formatBreastCounts(2, 0)).toBe("左2")
  })

  it("左が 0 なら左側を省略する（左0右3 → 右3）", () => {
    expect(formatBreastCounts(0, 3)).toBe("右3")
  })

  it("null は 0 と同じ扱いで省略する（左2・右null → 左2）", () => {
    expect(formatBreastCounts(2, null)).toBe("左2")
  })

  it("null 側が左でも同様に省略する（左null・右2 → 右2）", () => {
    expect(formatBreastCounts(null, 2)).toBe("右2")
  })

  it("両方 0 なら空文字（表示するものが無い）", () => {
    expect(formatBreastCounts(0, 0)).toBe("")
  })

  it("両方 null なら空文字（breast 以外の行を渡しても壊れない）", () => {
    expect(formatBreastCounts(null, null)).toBe("")
  })
})

describe("getFeedingTypeLabel: breast（母乳サイクル）", () => {
  it("breast は「母乳」", () => {
    expect(getFeedingTypeLabel("breast")).toBe("母乳")
  })

  it("過去データの片側行ラベルは変えない（breast_left=左 / breast_right=右）", () => {
    expect(getFeedingTypeLabel("breast_left")).toBe("左")
    expect(getFeedingTypeLabel("breast_right")).toBe("右")
  })
})

describe("formatBreastSideBreakdown（左右別の回数+時間表示）", () => {
  it("両側あり: 左2回7分30秒・右1回5分", () => {
    expect(formatBreastSideBreakdown(2, 1, 450, 300)).toBe(
      "左2回7分30秒・右1回5分",
    )
  })

  it("回数のみの側（0秒）は時間を省略する", () => {
    expect(formatBreastSideBreakdown(1, 1, 0, 300)).toBe("左1回・右1回5分")
  })

  it("片側 0回0秒はその側ごと省略する", () => {
    expect(formatBreastSideBreakdown(2, 0, 600, 0)).toBe("左2回10分")
  })

  it("回数 0 だが時間がある側は時間だけ出す（防御: 通常は発生しない組合せ）", () => {
    expect(formatBreastSideBreakdown(0, 1, 120, 300)).toBe("左2分・右1回5分")
  })

  it("null は 0 として扱う（旧行の混在防御）", () => {
    expect(formatBreastSideBreakdown(null, 1, null, 300)).toBe("右1回5分")
  })
})
