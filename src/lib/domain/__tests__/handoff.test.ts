import { describe, it, expect } from "vitest"
import {
  latestSeenMark,
  readLastSeen,
  summarizeHandoff,
  writeLastSeen,
} from "../handoff"
import type { BabyLogData } from "@/lib/types/baby"

function row(o: Partial<BabyLogData> & Pick<BabyLogData, "id">): BabyLogData {
  return {
    log_type: "diaper",
    logged_at: "2026-10-27T01:00:00Z",
    logged_by: "me",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: "pee",
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-10-27T01:00:00Z",
    updated_at: "2026-10-27T01:00:00Z",
    ...o,
  }
}

const SINCE = "2026-10-27T03:00:00.000000+00:00"
const base = { userId: "me", windowStartIso: "2026-10-19T15:00:00Z", failed: false }

describe("summarizeHandoff（記録された事実だけを数える）", () => {
  it("前回の後に作られた行を、作成者がほかの方かご自身かで分け、前回より前の行の更新は誰とも言わず数える", () => {
    const s = summarizeHandoff({
      ...base,
      lastSeenAt: SINCE,
      rows: [
        row({ id: "old", created_at: "2026-10-27T01:00:00Z", updated_at: "2026-10-27T01:00:00Z" }),
        row({ id: "new-other", logged_by: "spouse", created_at: "2026-10-27T04:00:00Z", updated_at: "2026-10-27T04:00:00Z" }),
        row({ id: "new-mine", logged_by: "me", created_at: "2026-10-27T04:30:00Z", updated_at: "2026-10-27T04:30:00Z" }),
        // 前回より前に作られ、前回の後に更新（更新した人は記録に無い）
        row({ id: "edited", logged_by: "spouse", created_at: "2026-10-27T00:00:00Z", updated_at: "2026-10-27T05:00:00Z" }),
        // 同じ id は 1 回だけ数える（窓の重なり）
        row({ id: "new-other", logged_by: "spouse", created_at: "2026-10-27T04:00:00Z", updated_at: "2026-10-27T04:00:00Z" }),
      ],
    })
    expect(s).toEqual({
      status: "ok",
      since: SINCE,
      newByOthers: 1,
      newByMe: 1,
      updated: 1,
      sinceBeforeWindow: false,
    })
  })

  it("楽観行（端末の時計の created_at・logged_by は自分）は、ほかの方の新しい記録に数えぬ", () => {
    const s = summarizeHandoff({
      ...base,
      lastSeenAt: SINCE,
      rows: [row({ id: "opt", logged_by: "me", created_at: "2099-01-01T00:00:00Z" })],
    })
    expect(s).toMatchObject({ status: "ok", newByOthers: 0, newByMe: 1 })
  })

  it("前回の確認が無ければ初回（件数を出さぬ）、窓の取得に失敗しておれば失敗（0 件と言わぬ）", () => {
    expect(summarizeHandoff({ ...base, lastSeenAt: null, rows: [row({ id: "a" })] })).toEqual({
      status: "first",
    })
    expect(
      summarizeHandoff({ ...base, lastSeenAt: SINCE, rows: [], failed: true }),
    ).toEqual({ status: "failed" })
  })

  it("前回の確認が読み込んだ窓より前なら、範囲外を数えておらぬ印を立てる（全部とは言わぬ）", () => {
    const s = summarizeHandoff({ ...base, lastSeenAt: "2026-10-01T00:00:00Z", rows: [] })
    expect(s).toMatchObject({ status: "ok", sinceBeforeWindow: true })
  })
})

describe("latestSeenMark", () => {
  it("見えておる行の updated_at の最大を、表記のまま返す（マイクロ秒を落とさぬ）", () => {
    expect(
      latestSeenMark([
        row({ id: "a", updated_at: "2026-10-27T01:00:00.123456+00:00" }),
        row({ id: "b", updated_at: "2026-10-27T02:00:00.654321+00:00" }),
        row({ id: "c", updated_at: null }),
      ]),
    ).toBe("2026-10-27T02:00:00.654321+00:00")
    expect(latestSeenMark([])).toBeNull()
  })
})

describe("前回の確認の印の端末保存", () => {
  it("localStorage が無い環境（SSR・node）では投げず、初回扱い・書けぬ（false）になる", () => {
    const owner = { userId: "me", householdId: "h" }
    expect(readLastSeen(owner)).toBeNull()
    expect(writeLastSeen(owner, SINCE)).toBe(false)
  })
})
