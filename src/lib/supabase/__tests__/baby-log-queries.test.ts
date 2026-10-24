/**
 * baby-log-queries（/baby の初回描画と取り直しが共有する baby_logs のクエリ）の単体テスト。
 * 窓（JST の半開区間）・今日基準と選択日基準の分離・搾乳の denylist・signal の有無を固定する。
 */
import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import {
  selectBabyLogsOfDay,
  selectBabyLogsOfWeek,
  selectGrowthLogs,
  selectLastFeedingBefore,
  selectLastNursingBefore,
} from "../baby-log-queries"

type Call = [string, ...unknown[]]

/** 呼ばれた順に (メソッド名, 引数...) を記録する chainable な偽クライアント */
function recordingClient() {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {}
  for (const name of [
    "select",
    "eq",
    "gte",
    "lt",
    "or",
    "order",
    "limit",
    "abortSignal",
    "maybeSingle",
  ]) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, ...args])
      return chain
    }
  }
  const client = {
    from: (table: string) => {
      calls.push(["from", table])
      return chain
    },
  } as unknown as SupabaseClient<Database>
  return { client, calls }
}

const HOUSEHOLD = "house-1"

describe("selectBabyLogsOfDay", () => {
  it("選択日の JST 0:00 から翌日 0:00 まで（半開区間）を新しい順に", () => {
    const { client, calls } = recordingClient()
    selectBabyLogsOfDay(client, HOUSEHOLD, "2026-07-31")
    expect(calls).toEqual([
      ["from", "baby_logs"],
      ["select", expect.any(String)],
      ["eq", "household_id", HOUSEHOLD],
      ["gte", "logged_at", "2026-07-31T00:00:00+09:00"],
      // 月末を跨いでも翌日は暦どおり（文字列の足し算ではない）
      ["lt", "logged_at", "2026-08-01T00:00:00+09:00"],
      ["order", "logged_at", { ascending: false }],
    ])
  })

  it("signal を渡した時だけ abortSignal を付ける（サーバの初回描画では付けぬ）", () => {
    const withSignal = recordingClient()
    const controller = new AbortController()
    selectBabyLogsOfDay(withSignal.client, HOUSEHOLD, "2026-07-31", controller.signal)
    expect(withSignal.calls.at(-1)).toEqual(["abortSignal", controller.signal])

    const without = recordingClient()
    selectBabyLogsOfDay(without.client, HOUSEHOLD, "2026-07-31")
    expect(without.calls.some(([name]) => name === "abortSignal")).toBe(false)
  })
})

// 5 本とも順序つきの全列で照合する（含むかだけを見ると、世帯の明示フィルタや
// log_type の条件を消しても緑のまま — RLS 単独になり二重の原則が崩れる）。
describe("selectBabyLogsOfWeek", () => {
  it("今日を含む 8 日（WEEKLY_FETCH_DAYS）を、明日の 0:00 の手前まで・世帯で絞る", () => {
    const { client, calls } = recordingClient()
    selectBabyLogsOfWeek(client, HOUSEHOLD, "2026-03-01")
    expect(calls).toEqual([
      ["from", "baby_logs"],
      ["select", expect.any(String)],
      ["eq", "household_id", HOUSEHOLD],
      ["gte", "logged_at", "2026-02-22T00:00:00+09:00"],
      ["lt", "logged_at", "2026-03-02T00:00:00+09:00"],
      ["order", "logged_at", { ascending: false }],
    ])
  })
})

describe("selectGrowthLogs", () => {
  it("成長ログを古い順に（日付窓を持たぬ）・世帯で絞る", () => {
    const { client, calls } = recordingClient()
    selectGrowthLogs(client, HOUSEHOLD)
    expect(calls).toEqual([
      ["from", "baby_logs"],
      ["select", expect.any(String)],
      ["eq", "household_id", HOUSEHOLD],
      ["eq", "log_type", "growth"],
      ["order", "logged_at", { ascending: true }],
    ])
  })
})

describe("今日より前の最後の授乳（2 本は契約が違う）", () => {
  it("最終授乳の表示用は授乳行だけ・搾乳を含む（feeding_type で絞らぬ）", () => {
    const { client, calls } = recordingClient()
    selectLastFeedingBefore(client, HOUSEHOLD, "2026-07-22")
    expect(calls).toEqual([
      ["from", "baby_logs"],
      ["select", expect.any(String)],
      ["eq", "household_id", HOUSEHOLD],
      // 消すと前日のおむつ行が「最終授乳」のフォールバックに入る
      ["eq", "log_type", "feeding"],
      ["lt", "logged_at", "2026-07-22T00:00:00+09:00"],
      ["order", "logged_at", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ])
  })

  it("目安の起点は pumped だけを名指しで除く denylist（NULL は残す三値論理の or）", () => {
    const { client, calls } = recordingClient()
    selectLastNursingBefore(client, HOUSEHOLD, "2026-07-22")
    // allowlist（in で授乳種別を列挙）へ書き換えると、新しい ENUM 値が無音で漏れる
    expect(calls).toEqual([
      ["from", "baby_logs"],
      ["select", expect.any(String)],
      ["eq", "household_id", HOUSEHOLD],
      ["eq", "log_type", "feeding"],
      ["or", "feeding_type.is.null,feeding_type.neq.pumped"],
      ["lt", "logged_at", "2026-07-22T00:00:00+09:00"],
      ["order", "logged_at", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ])
  })

  it("signal は maybeSingle の前に付く（PostgREST の builder の順序）", () => {
    const { client, calls } = recordingClient()
    const controller = new AbortController()
    selectLastNursingBefore(client, HOUSEHOLD, "2026-07-22", controller.signal)
    expect(calls.slice(-3)).toEqual([
      ["limit", 1],
      ["abortSignal", controller.signal],
      ["maybeSingle"],
    ])
  })
})
