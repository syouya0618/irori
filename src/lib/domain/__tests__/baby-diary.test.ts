import { describe, it, expect } from "vitest"
import {
  groupMemoLogsByDate,
  formatDiaryDateHeading,
  DIARY_PAGE_SIZE,
} from "../baby-diary"
import type { BabyLogData } from "@/lib/types/baby"

function memoLog(
  overrides: Partial<BabyLogData> & Pick<BabyLogData, "id" | "logged_at">,
): BabyLogData {
  return {
    log_type: "memo",
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    diaper_type: null,
    ended_at: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: "メモ本文",
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

describe("formatDiaryDateHeading", () => {
  it("ISO タイムスタンプを JST の日本語日付見出しに整形する", () => {
    const label = formatDiaryDateHeading("2026-07-22T10:00:00+09:00")
    expect(label).toContain("2026年")
    expect(label).toContain("7月22日")
  })

  it("UTC 深夜でも JST 日付で見出しを出す（日跨ぎの罠回避）", () => {
    // UTC 2026-07-21T20:00Z = JST 2026-07-22T05:00 → JST では 22 日
    const label = formatDiaryDateHeading("2026-07-21T20:00:00Z")
    expect(label).toContain("7月22日")
  })
})

describe("groupMemoLogsByDate", () => {
  it("同一 JST 日付のログを1グループにまとめる", () => {
    const groups = groupMemoLogsByDate([
      memoLog({ id: "a", logged_at: "2026-07-22T15:00:00+09:00" }),
      memoLog({ id: "b", logged_at: "2026-07-22T09:00:00+09:00" }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].date).toBe("2026-07-22")
    expect(groups[0].logs.map((l) => l.id)).toEqual(["a", "b"])
  })

  it("日付降順（入力順）でグループを返し、グループ内も入力順を保つ", () => {
    const groups = groupMemoLogsByDate([
      memoLog({ id: "d1-late", logged_at: "2026-07-22T20:00:00+09:00" }),
      memoLog({ id: "d1-early", logged_at: "2026-07-22T08:00:00+09:00" }),
      memoLog({ id: "d0", logged_at: "2026-07-21T12:00:00+09:00" }),
    ])
    expect(groups.map((g) => g.date)).toEqual(["2026-07-22", "2026-07-21"])
    expect(groups[0].logs.map((l) => l.id)).toEqual(["d1-late", "d1-early"])
    expect(groups[1].logs.map((l) => l.id)).toEqual(["d0"])
  })

  it("メモの改行を保持する（グルーピングは本文を書き換えない）", () => {
    const groups = groupMemoLogsByDate([
      memoLog({ id: "a", logged_at: "2026-07-22T10:00:00+09:00", memo: "1行目\n2行目" }),
    ])
    expect(groups[0].logs[0].memo).toBe("1行目\n2行目")
  })

  it("空配列は空グループを返す", () => {
    expect(groupMemoLogsByDate([])).toEqual([])
  })

  it("JST 日跨ぎを日付境界で分割する", () => {
    // UTC で連続だが JST では 07-22 / 07-21 に跨る 2 件
    const groups = groupMemoLogsByDate([
      memoLog({ id: "late", logged_at: "2026-07-21T16:00:00Z" }), // JST 07-22 01:00
      memoLog({ id: "early", logged_at: "2026-07-21T10:00:00Z" }), // JST 07-21 19:00
    ])
    expect(groups.map((g) => g.date)).toEqual(["2026-07-22", "2026-07-21"])
  })
})

describe("DIARY_PAGE_SIZE", () => {
  it("1ページ 50 件", () => {
    expect(DIARY_PAGE_SIZE).toBe(50)
  })
})
