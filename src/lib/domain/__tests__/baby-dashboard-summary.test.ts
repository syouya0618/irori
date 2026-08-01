import { describe, it, expect } from "vitest"
import {
  deriveDashboardSummary,
  mergeDateNavLogs,
} from "../baby-dashboard-summary"
import type { BabyLogData } from "@/lib/types/baby"

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
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
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

describe("deriveDashboardSummary / lastFeeding の忠実抽出", () => {
  it("降順 logs では lastFeeding（logged_at 比較）が最新の授乳行", () => {
    // 降順入力では素直に「最新」で一致する（順序非依存化は P2 の describe で固定）
    const logs = [
      makeLog({
        id: "feed-new",
        log_type: "feeding",
        logged_at: "2026-07-18T12:00:00+09:00",
        feeding_type: "bottle",
      }),
      makeLog({
        id: "feed-old",
        log_type: "feeding",
        logged_at: "2026-07-18T06:00:00+09:00",
        feeding_type: "breast_right",
      }),
    ]

    expect(deriveDashboardSummary(logs).lastFeeding?.id).toBe("feed-new")
  })

  it("logs が空で fallback も無ければ lastFeeding=null", () => {
    expect(deriveDashboardSummary([]).lastFeeding).toBeNull()
  })
})

describe("deriveDashboardSummary / lastFeeding の順序非依存（批判レビュー P2）", () => {
  it("楽観 prepend で降順が崩れた logs でも、lastFeeding は logged_at が最新の授乳行", () => {
    // タイマーの楽観 append は loggedAt=開始時刻（過去）の行を無条件で先頭 prepend する。
    // 先頭一致だと「タイマー中に記録したミルク」より古いサイクル行を最終授乳に選んでしまう。
    const logs = [
      makeLog({
        id: "feed-cycle-optimistic",
        log_type: "feeding",
        logged_at: "2026-07-18T12:00:00+09:00", // サイクル開始（prepend されて先頭に居る）
        feeding_type: "breast",
      }),
      makeLog({
        id: "feed-milk",
        log_type: "feeding",
        logged_at: "2026-07-18T12:10:00+09:00", // タイマー走行中に記録されたミルク（より新しい）
        feeding_type: "bottle",
      }),
    ]

    const { lastFeeding } = deriveDashboardSummary(logs)

    expect(lastFeeding?.id).toBe("feed-milk")
  })

  it("ISO 表記が混在（'Z' と '+00:00'）しても文字列でなく時刻で比較する", () => {
    // 楽観行は toISOString() の "Z"、サーバ行は "+00:00"。文字列比較は 'Z'(0x5A) > '5'(0x35)
    // ゆえ古い "Z" 行が新しい "+00:00" 行に勝ってしまう。epoch 比較のみが正しい。
    const logs = [
      makeLog({
        id: "older-z",
        log_type: "feeding",
        logged_at: "2026-07-18T03:00:00.000Z",
        feeding_type: "breast",
      }),
      makeLog({
        id: "newer-offset",
        log_type: "feeding",
        logged_at: "2026-07-18T03:10:00.123456+00:00",
        feeding_type: "bottle",
      }),
    ]

    expect(deriveDashboardSummary(logs).lastFeeding?.id).toBe("newer-offset")
  })
})

describe("deriveDashboardSummary / lastFeeding フォールバック（批判レビュー P3）", () => {
  // 深夜跨ぎサイクル: 開始時刻セマンティクスにより前日行になり、当日窓の logs に現れない
  const prevDayFeeding = makeLog({
    id: "feed-prev-day",
    log_type: "feeding",
    logged_at: "2026-07-17T23:50:00+09:00",
    feeding_type: "breast",
  })

  it("選択日の logs に授乳が無ければ fallback を使う（深夜跨ぎ直後の「---」防止）", () => {
    const { lastFeeding } = deriveDashboardSummary([], prevDayFeeding)

    expect(lastFeeding?.id).toBe("feed-prev-day")
  })

  it("logs に授乳が有ればローカル導出が優先（fallback は使わない）", () => {
    const logs = [
      makeLog({
        id: "feed-today",
        log_type: "feeding",
        logged_at: "2026-07-18T07:00:00+09:00",
        feeding_type: "breast",
      }),
    ]

    expect(
      deriveDashboardSummary(logs, prevDayFeeding).lastFeeding?.id,
    ).toBe("feed-today")
  })

  it("fallback 未指定（従来呼び出し）は従来どおり null", () => {
    expect(deriveDashboardSummary([]).lastFeeding).toBeNull()
  })
})

describe("mergeDateNavLogs / 日付ナビ refetch の dedupe マージ (B-08)", () => {
  const SELECTED = "2026-07-18"

  const fetchedRow = makeLog({
    id: "server-1",
    log_type: "feeding",
    logged_at: "2026-07-18T08:00:00+09:00",
    feeding_type: "bottle",
  })

  it("干渉が無ければ fetched をそのまま返す（＝置換であって削除でない）", () => {
    // prev は遷移前の旧選択日の行。全置換の従来挙動どおり落とす。
    const prev = [
      makeLog({
        id: "old-date-1",
        log_type: "diaper",
        logged_at: "2026-07-17T20:00:00+09:00",
        diaper_type: "pee",
      }),
    ]
    const fetched = [fetchedRow]

    const result = mergeDateNavLogs(prev, fetched, SELECTED)

    // 保持行ゼロ時は fetched 配列そのものを返す（余計な再生成なし＝ setLogs(data) と等価）
    expect(result).toBe(fetched)
    expect(result).toEqual([fetchedRow])
  })

  it("in-flight 中に Realtime で先着した選択日の行（fetched に無い）は保持される", () => {
    const realtimeRow = makeLog({
      id: "realtime-1",
      log_type: "diaper",
      logged_at: "2026-07-18T08:30:00+09:00",
      diaper_type: "poop",
    })
    // prev = fetch 発行後・解決前に Realtime INSERT で前置きされた選択日の行
    const prev = [realtimeRow]

    const result = mergeDateNavLogs(prev, [fetchedRow], SELECTED)

    expect(result.map((l) => l.id)).toContain("realtime-1")
    expect(result.map((l) => l.id)).toContain("server-1")
    // 既存 Realtime INSERT の [newLog, ...prev] 前置き規約に合わせ保持行を前に置く
    expect(result[0].id).toBe("realtime-1")
  })

  it("fetched に既に含まれる行は重複させない（id dedupe）", () => {
    // Realtime 行が fetch にも入っている（クエリが INSERT コミット後に走った）ケース
    const prev = [fetchedRow]

    const result = mergeDateNavLogs(prev, [fetchedRow], SELECTED)

    expect(result).toEqual([fetchedRow])
    expect(result.filter((l) => l.id === "server-1")).toHaveLength(1)
  })

  it("選択日に属さない prev 行（旧日付の Realtime 残存等）は保持しない", () => {
    // 選択日 = 2026-07-18。prev に前日の行があっても救済対象外。
    const prev = [
      makeLog({
        id: "yesterday-realtime",
        log_type: "feeding",
        logged_at: "2026-07-17T23:00:00+09:00",
        feeding_type: "breast_left",
      }),
    ]

    const result = mergeDateNavLogs(prev, [fetchedRow], SELECTED)

    expect(result.map((l) => l.id)).not.toContain("yesterday-realtime")
    expect(result).toEqual([fetchedRow])
  })
})
