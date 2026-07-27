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
  getFeedingTypeLabel,
} from "@/lib/utils/baby-log-labels"

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
