/**
 * formatElapsedMinutes の負値ガード回帰テスト（B-10 / H2-05）。
 *
 * useNow(60_000) の stale now × 記録直後の Realtime INSERT が重なると、
 * まだ更新されていない now を基準に minutesBetween が負の経過分を返しうる。
 * 負値がそのまま「-3分」のように表示されるのを防ぐため、
 * formatElapsedMinutes の入口で 0 未満を 0 にクランプする。
 */

import { describe, it, expect } from "vitest"
import { formatElapsedMinutes } from "@/lib/utils/baby-log-labels"

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
