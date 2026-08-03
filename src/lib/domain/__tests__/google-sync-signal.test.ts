import { describe, it, expect } from "vitest"
import {
  latestIsoTimestamp,
  hasSyncAdvanced,
} from "@/lib/domain/google-sync-signal"

describe("latestIsoTimestamp", () => {
  it("空・全 null は null", () => {
    expect(latestIsoTimestamp([])).toBeNull()
    expect(latestIsoTimestamp([null, null])).toBeNull()
  })

  it("最大値を返す", () => {
    expect(
      latestIsoTimestamp([
        "2026-08-01T00:00:00.000Z",
        null,
        "2026-08-02T00:00:00.000Z",
        "2026-07-31T23:59:59.000Z",
      ]),
    ).toBe("2026-08-02T00:00:00.000Z")
  })

  it("表記が混ざっても時刻で比べる（辞書順で判定せぬ）", () => {
    // "+00:00" 表記は辞書順だと "Z" 表記より小さいが、同時刻ゆえ前進ではない。
    expect(
      latestIsoTimestamp([
        "2026-08-02T00:00:00.000Z",
        "2026-08-02T09:00:00.000+09:00",
      ]),
    ).toBe("2026-08-02T00:00:00.000Z")
  })

  it("解釈不能な値は無視する", () => {
    expect(latestIsoTimestamp(["garbage", "2026-08-01T00:00:00.000Z"])).toBe(
      "2026-08-01T00:00:00.000Z",
    )
    expect(latestIsoTimestamp(["garbage"])).toBeNull()
  })
})

describe("hasSyncAdvanced", () => {
  it("基準が null なら値が入った時点で前進", () => {
    expect(hasSyncAdvanced(null, "2026-08-02T00:00:00.000Z")).toBe(true)
    expect(hasSyncAdvanced(null, null)).toBe(false)
  })

  it("同じ時刻の別表記は前進ではない", () => {
    expect(
      hasSyncAdvanced(
        "2026-08-02T00:00:00.000Z",
        "2026-08-02T09:00:00.000+09:00",
      ),
    ).toBe(false)
  })

  it("新しくなったときだけ true", () => {
    expect(
      hasSyncAdvanced("2026-08-02T00:00:00.000Z", "2026-08-02T00:00:01.000Z"),
    ).toBe(true)
    expect(
      hasSyncAdvanced("2026-08-02T00:00:00.000Z", "2026-08-01T00:00:00.000Z"),
    ).toBe(false)
  })

  it("解釈不能な current は前進扱いにせぬ（誤 refetch を作らぬ）", () => {
    expect(hasSyncAdvanced("2026-08-02T00:00:00.000Z", "garbage")).toBe(false)
  })
})
