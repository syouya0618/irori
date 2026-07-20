import { describe, it, expect } from "vitest"
import {
  deriveDashboardSummary,
  mergeDateNavLogs,
} from "../baby-dashboard-summary"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * B-01（日跨ぎアクティブ睡眠の袋小路）: activeSleep 導出の純関数テスト。
 *
 * 従来の BabyDashboard 内 useMemo は「選択日の logs」のみから activeSleep を
 * 導出していたため、前夜開始・未終了の睡眠（logged_at が前日）は翌日 UI で
 * 検出されず、終了不能かつ新規開始は 23505 で拒否される袋小路になっていた。
 * サーバフォールバック（未終了睡眠クエリ結果）で補完されることを固定する。
 */

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
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
    memo: null,
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

// 前夜 21:00 開始・未終了の睡眠（選択日 = 翌日 2026-07-18 の logs には現れない）
const crossMidnightSleep = makeLog({
  id: "sleep-cross-midnight",
  log_type: "sleep",
  logged_at: "2026-07-17T21:00:00+09:00",
  ended_at: null,
})

describe("deriveDashboardSummary / activeSleep フォールバック (B-01)", () => {
  it("logs に未終了睡眠が無く fallback に有る場合、activeSleep=fallback（日跨ぎ袋小路の解消）", () => {
    const logs = [
      makeLog({
        id: "feed-1",
        log_type: "feeding",
        logged_at: "2026-07-18T07:00:00+09:00",
        feeding_type: "breast_left",
      }),
    ]

    const { activeSleep } = deriveDashboardSummary(logs, crossMidnightSleep)

    expect(activeSleep).toEqual(crossMidnightSleep)
  })

  it("logs に未終了睡眠が有る場合はローカル導出が優先（fallback は使わない）", () => {
    const localActive = makeLog({
      id: "sleep-today",
      log_type: "sleep",
      logged_at: "2026-07-18T13:00:00+09:00",
      ended_at: null,
    })

    const { activeSleep } = deriveDashboardSummary(
      [localActive],
      crossMidnightSleep,
    )

    expect(activeSleep).toEqual(localActive)
  })

  it("logs にも fallback にも未終了睡眠が無ければ activeSleep=null", () => {
    const completedSleep = makeLog({
      id: "sleep-done",
      log_type: "sleep",
      logged_at: "2026-07-18T09:00:00+09:00",
      ended_at: "2026-07-18T10:30:00+09:00",
    })

    const { activeSleep } = deriveDashboardSummary([completedSleep], null)

    expect(activeSleep).toBeNull()
  })

  it("忠実抽出の回帰: lastFeeding / derivedLastSleepEndedAt は降順 logs の先頭一致（最新）を返す", () => {
    // logs は logged_at 降順前提（サーバクエリ・Realtime 挿入とも降順維持）
    const logs = [
      makeLog({
        id: "feed-new",
        log_type: "feeding",
        logged_at: "2026-07-18T12:00:00+09:00",
        feeding_type: "bottle",
      }),
      makeLog({
        id: "sleep-new",
        log_type: "sleep",
        logged_at: "2026-07-18T09:00:00+09:00",
        ended_at: "2026-07-18T11:00:00+09:00",
      }),
      makeLog({
        id: "feed-old",
        log_type: "feeding",
        logged_at: "2026-07-18T06:00:00+09:00",
        feeding_type: "breast_right",
      }),
      makeLog({
        id: "sleep-old",
        log_type: "sleep",
        logged_at: "2026-07-18T01:00:00+09:00",
        ended_at: "2026-07-18T05:00:00+09:00",
      }),
    ]

    const { lastFeeding, derivedLastSleepEndedAt, activeSleep } =
      deriveDashboardSummary(logs, null)

    expect(lastFeeding?.id).toBe("feed-new")
    expect(derivedLastSleepEndedAt).toBe("2026-07-18T11:00:00+09:00")
    expect(activeSleep).toBeNull()
  })

  it("logs が空でも fallback があれば activeSleep=fallback、他フィールドは初期値", () => {
    const result = deriveDashboardSummary([], crossMidnightSleep)

    expect(result.activeSleep).toEqual(crossMidnightSleep)
    expect(result.lastFeeding).toBeNull()
    expect(result.derivedLastSleepEndedAt).toBeNull()
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
