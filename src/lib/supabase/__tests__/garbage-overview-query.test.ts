/**
 * ごみの画面の読み取り（`loadGarbagePage`）と、分類の一括取得（`fetchEventPurposeLoad`）の契約。
 *
 * - どのクエリも世帯で絞る（RLS と二重）。読むだけ（書込・削除の経路を持たぬ）
 * - 「読めなかった」を「無い」と言い換えぬ: 分類の失敗 → purposes: failed / 鍵で引く問い合わせの
 *   失敗 → unchecked（孤児と言わぬ）/ 通知設定の失敗 → reminders: failed
 * - 期間内に回の無い分類は、鍵で予定を引いて「予定が見つからぬ」と誤らぬ
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@/lib/types/database"

vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

import { EVENT_PURPOSE_COLUMNS, GARBAGE_EVENT_COLUMNS } from "@/lib/domain/garbage"
import { fetchEventPurposeLoad } from "../event-purpose-query"
import { GARBAGE_WINDOW_DAYS, loadGarbagePage } from "../garbage-overview-query"
import { logSupabaseError } from "../log-error"

const HOUSE = "aa100000-0000-4000-8000-000000000001"
const TODAY = "2026-11-11"
const SERIES = "bb100000-0000-4000-8000-0000000000f0"
const E1 = "bb100000-0000-4000-8000-000000000001"
const SINGLE = "bb100000-0000-4000-8000-000000000002"

interface Query {
  table: string
  columns: string
  eq: Record<string, unknown>
  in: Record<string, unknown[]>
  gte: Record<string, unknown>
  lte: Record<string, unknown>
  order: [string, unknown] | null
  limit: number | null
  aborted: boolean
}
type Result = { data: unknown; error: unknown }

function makeSupabase(handler: (q: Query) => Result | Promise<Result>) {
  const queries: Query[] = []
  const from = (table: string) => {
    const q: Query = { table, columns: "", eq: {}, in: {}, gte: {}, lte: {}, order: null, limit: null, aborted: false }
    queries.push(q)
    const chain = {
      select: (columns: string) => ((q.columns = columns), chain),
      eq: (col: string, value: unknown) => ((q.eq[col] = value), chain),
      in: (col: string, values: unknown[]) => ((q.in[col] = values), chain),
      gte: (col: string, value: unknown) => ((q.gte[col] = value), chain),
      lte: (col: string, value: unknown) => ((q.lte[col] = value), chain),
      order: (col: string, options: unknown) => ((q.order = [col, options]), chain),
      limit: (n: number) => ((q.limit = n), chain),
      abortSignal: (signal: AbortSignal) => ((q.aborted = signal.aborted), chain),
      then: (onFulfilled?: (v: Result) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve()
          .then(() => handler(q))
          .then(onFulfilled, onRejected),
    }
    return chain
  }
  return { client: { from } as unknown as SupabaseClient<Database>, queries }
}

const purposeRaw = (o: Record<string, unknown>) => ({
  id: "dd100000-0000-4000-8000-000000000001",
  scope: "series",
  target_key: SERIES,
  purpose: "garbage",
  garbage_kind: "プラスチック",
  remind_default: "prev_day_20",
  reminder_opt_out: false,
  updated_at: "2026-11-01T00:00:00.000000+00:00",
  ...o,
})
const eventRaw = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  title: "収集",
  is_all_day: true,
  start_date: "2026-11-12",
  end_date: (o.start_date as string | undefined) ?? "2026-11-12",
  start_at: null,
  source: "native",
  series_id: null,
  medical_record_id: null,
  event_uid: id,
  google_calendar_id: null,
  recurring_event_id: null,
  ...o,
})

const isWindow = (q: Query) => q.table === "calendar_events" && "end_date" in q.gte
const isEventAnchor = (q: Query) => q.table === "calendar_events" && "event_uid" in q.in
const isSeriesAnchor = (q: Query) => q.table === "calendar_events" && q.limit === 1

beforeEach(() => vi.clearAllMocks())

describe("fetchEventPurposeLoad", () => {
  it("世帯で絞って読み、行を解釈して返す", async () => {
    const sb = makeSupabase(() => ({ data: [purposeRaw({})], error: null }))
    const load = await fetchEventPurposeLoad(sb.client, HOUSE)
    expect(load).toMatchObject({ status: "ok", rows: [{ scope: "series", targetKey: SERIES, garbageKind: "プラスチック" }] })
    expect(sb.queries).toHaveLength(1)
    expect(sb.queries[0]).toMatchObject({ table: "event_purposes", columns: EVENT_PURPOSE_COLUMNS, eq: { household_id: HOUSE } })
  })

  it("失敗・throw・読めぬ行は failed（空の ok と区別する）。throw せぬ", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(await fetchEventPurposeLoad(makeSupabase(() => ({ data: null, error: { message: "x", code: "42P01" } })).client, HOUSE)).toEqual({ status: "failed" })
    expect(await fetchEventPurposeLoad(makeSupabase(() => Promise.reject(new Error("down"))).client, HOUSE)).toEqual({ status: "failed" })
    expect(await fetchEventPurposeLoad(makeSupabase(() => ({ data: [purposeRaw({ scope: "household" })], error: null })).client, HOUSE)).toEqual({ status: "failed" })
    // 対照: 0 行は ok
    expect(await fetchEventPurposeLoad(makeSupabase(() => ({ data: [], error: null })).client, HOUSE)).toEqual({ status: "ok", rows: [] })
    expect(logSupabaseError).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it("中断（次の取り直し・離脱）は失敗として記録せぬ", async () => {
    const controller = new AbortController()
    controller.abort()
    const sb = makeSupabase(() => ({ data: null, error: { message: "AbortError", code: "" } }))
    expect(await fetchEventPurposeLoad(sb.client, HOUSE, controller.signal)).toEqual({ status: "failed" })
    expect(logSupabaseError).not.toHaveBeenCalled()
  })
})

describe("loadGarbagePage", () => {
  it("分類・期間内の予定・通知設定を読み、次の収集日と分類の一覧を組む。全クエリを世帯で絞る", async () => {
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") {
        return {
          data: [
            purposeRaw({}),
            purposeRaw({ id: "dd100000-0000-4000-8000-000000000002", scope: "event", target_key: SINGLE, garbage_kind: "古紙", remind_default: null }),
          ],
          error: null,
        }
      }
      if (isWindow(q)) return { data: [eventRaw(E1, { series_id: SERIES })], error: null }
      // 単発の分類は期間内に回が無い → 鍵で引くと、期間の先に予定が在る
      if (isEventAnchor(q)) return { data: [eventRaw(SINGLE, { start_date: "2027-03-01" })], error: null }
      if (q.table === "event_reminders") {
        return { data: [{ event_uid: E1, remind_kind: "prev_day_20", remind_minutes_before: null }], error: null }
      }
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)

    expect(data).toMatchObject({ today: TODAY, windowDays: GARBAGE_WINDOW_DAYS, purposes: "ok", events: "ok" })
    expect(data.overview.collections.map((c) => [c.date, c.label])).toEqual([["2026-11-12", "プラスチック"]])
    expect(data.overview.entries.map((e) => [e.row.garbageKind, e.state, e.nextDate])).toEqual([
      ["プラスチック", "linked", "2026-11-12"],
      // 期間内に回は無いが、予定は在る → 「見つからぬ」と言わぬ
      ["古紙", "linked", null],
    ])
    expect(data.reminders).toEqual({
      status: "ok",
      // remind_at を読めなんだ行（この mock は返しておらぬ）は「過ぎた」と言い切らぬ
      byEventKey: { [E1]: { remind_kind: "prev_day_20", remind_minutes_before: null, passed: false } },
    })
    // 通知の時刻は DB の導出値（remind_at）を読む
    expect(sb.queries.find((q) => q.table === "event_reminders")!.columns).toContain("remind_at")

    // 全クエリが世帯で絞られておる
    expect(sb.queries.length).toBeGreaterThanOrEqual(4)
    for (const q of sb.queries) expect(q.eq.household_id).toBe(HOUSE)
    // 期間: 今日以降に終わり、期間の末日までに始まる予定（既存の列だけ）
    const window = sb.queries.find(isWindow)!
    expect(window).toMatchObject({ columns: GARBAGE_EVENT_COLUMNS, gte: { end_date: TODAY }, lte: { start_date: "2027-01-11" } })
    // 期間内に見つかったシリーズは、鍵で引き直さぬ
    expect(sb.queries.filter(isSeriesAnchor)).toHaveLength(0)
    expect(sb.queries.find(isEventAnchor)!.in.event_uid).toEqual([SINGLE])
    // 通知設定は、並べる収集日の鍵だけを引く
    expect(sb.queries.find((q) => q.table === "event_reminders")!.in.event_uid).toEqual([E1])
  })

  it("分類を読めなんだら purposes: failed（空の一覧を「登録なし」として返さぬ）。以後の問い合わせをせぬ", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sb = makeSupabase((q) =>
      q.table === "event_purposes" ? { data: null, error: { message: "x", code: "42501" } } : { data: [], error: null },
    )
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.purposes).toBe("failed")
    expect(data.overview.entries).toEqual([])
    expect(sb.queries.map((q) => q.table).sort()).toEqual(["calendar_events", "event_purposes"])
    consoleError.mockRestore()
  })

  it("鍵を持つ予定が 1 つも無い分類は orphan、問い合わせが失敗した分類は unchecked（孤児と言わぬ）", async () => {
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") {
        return {
          data: [
            purposeRaw({}),
            purposeRaw({ id: "dd100000-0000-4000-8000-000000000002", scope: "event", target_key: SINGLE, garbage_kind: "古紙", remind_default: null }),
          ],
          error: null,
        }
      }
      if (isWindow(q)) return { data: [], error: null }
      if (isEventAnchor(q)) return { data: [], error: null } // 予定が無い → orphan
      if (isSeriesAnchor(q)) return { data: null, error: { message: "timeout", code: "" } } // 失敗 → unchecked
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.overview.entries.map((e) => [e.row.garbageKind, e.state])).toEqual([
      ["プラスチック", "unchecked"],
      ["古紙", "orphan"],
    ])
    // native のシリーズは series_id と source で、最後の回を 1 行だけ引く
    expect(sb.queries.find(isSeriesAnchor)).toMatchObject({
      eq: { household_id: HOUSE, source: "native", series_id: SERIES },
      limit: 1,
    })
  })

  it("Google のシリーズの鍵は calendar id と recurring id へ分けて引く", async () => {
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") {
        return { data: [purposeRaw({ target_key: "cal@example.invalid|rec_abc" })], error: null }
      }
      if (isSeriesAnchor(q)) {
        return {
          data: [
            eventRaw("cc100000-0000-4000-8000-000000000009", {
              source: "google",
              start_date: "2026-10-01",
              event_uid: "cal@example.invalid|rec_abc_1",
              google_calendar_id: "cal@example.invalid",
              recurring_event_id: "rec_abc",
            }),
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(sb.queries.find(isSeriesAnchor)).toMatchObject({
      eq: { household_id: HOUSE, source: "google", google_calendar_id: "cal@example.invalid", recurring_event_id: "rec_abc" },
    })
    // 過ぎた回しか無くても予定は在る → 孤児にせぬ
    expect(data.overview.entries[0]).toMatchObject({ state: "linked", nextDate: null, anchor: { source: "google", isSeries: true } })
  })

  it("形の分からぬシリーズの鍵は引かず unchecked にする（孤児と言わぬ）", async () => {
    const sb = makeSupabase((q) =>
      q.table === "event_purposes" ? { data: [purposeRaw({ target_key: "not-a-uuid" })], error: null } : { data: [], error: null },
    )
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.overview.entries[0].state).toBe("unchecked")
    expect(sb.queries.filter(isSeriesAnchor)).toHaveLength(0)
  })

  it("今後の予定を読めなんだら events: failed。分類は鍵で確かめて一覧に出す", async () => {
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") return { data: [purposeRaw({})], error: null }
      if (isWindow(q)) return { data: null, error: { message: "boom", code: "57014" } }
      if (isSeriesAnchor(q)) return { data: [eventRaw(E1, { series_id: SERIES })], error: null }
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.events).toBe("failed")
    expect(data.overview.collections).toEqual([])
    expect(data.overview.entries[0].state).toBe("linked")
  })

  it("読めぬ予定の行（実在せぬ日付）が混ざれば events: failed（一部だけで収集日を組まぬ）", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") return { data: [purposeRaw({})], error: null }
      if (isWindow(q)) return { data: [eventRaw(E1, { series_id: SERIES, start_date: "2026-02-30" })], error: null }
      return { data: [], error: null }
    })
    expect((await loadGarbagePage(sb.client, HOUSE, TODAY)).events).toBe("failed")
    consoleError.mockRestore()
  })

  it("通知設定を読めなんだら reminders: failed（「通知なし」と区別する）", async () => {
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") return { data: [purposeRaw({})], error: null }
      if (isWindow(q)) return { data: [eventRaw(E1, { series_id: SERIES })], error: null }
      if (q.table === "event_reminders") return { data: null, error: { message: "x", code: "42501" } }
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.reminders).toEqual({ status: "failed" })
    // 収集日そのものは出す
    expect(data.overview.collections).toHaveLength(1)
  })

  it("通知の時刻（remind_at）が画面を組んだ時点で過ぎておるかを、行ごとに返す（R09）", async () => {
    const E2 = "bb100000-0000-4000-8000-000000000003"
    const E3 = "bb100000-0000-4000-8000-000000000004"
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") return { data: [purposeRaw({})], error: null }
      if (isWindow(q)) {
        return {
          data: [
            eventRaw(E1, { series_id: SERIES, start_date: "2026-11-12" }),
            eventRaw(E2, { series_id: SERIES, start_date: "2026-11-19" }),
            eventRaw(E3, { series_id: SERIES, start_date: "2026-11-26" }),
          ],
          error: null,
        }
      }
      if (q.table === "event_reminders") {
        return {
          data: [
            // 11/12 の回の前日 20:00 JST = 11/11 11:00 UTC
            { event_uid: E1, remind_kind: "prev_day_20", remind_minutes_before: null, remind_at: "2026-11-11T11:00:00+00:00" },
            { event_uid: E2, remind_kind: "prev_day_20", remind_minutes_before: null, remind_at: "2026-11-18T11:00:00+00:00" },
            { event_uid: E3, remind_kind: "prev_day_20", remind_minutes_before: null, remind_at: "not-a-time" },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })
    // 11/11 21:00 JST（= 12:00 UTC）に画面を組んだ: 明日の回の前日 20:00 は過ぎておる
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY, new Date("2026-11-11T12:00:00.000Z"))
    expect(data.reminders).toMatchObject({
      status: "ok",
      byEventKey: {
        [E1]: { passed: true },
        [E2]: { passed: false },
        // 時刻を読めぬ行は「過ぎた」と言い切らぬ
        [E3]: { passed: false },
      },
    })
    // 境目: ちょうどの時刻から「過ぎた」（予定のシートの通知の欄と同じ基準）。1 ミリ秒前は過ぎておらぬ
    const at = await loadGarbagePage(sb.client, HOUSE, TODAY, new Date("2026-11-11T11:00:00.000Z"))
    expect(at.reminders).toMatchObject({ byEventKey: { [E1]: { passed: true } } })
    const before = await loadGarbagePage(sb.client, HOUSE, TODAY, new Date("2026-11-11T10:59:59.999Z"))
    expect(before.reminders).toMatchObject({ byEventKey: { [E1]: { passed: false } } })
  })

  it("上限まで読んだ時は truncated と告げる", async () => {
    const many = Array.from({ length: 1000 }, (_, i) =>
      eventRaw(`ee100000-0000-4000-8000-${String(i).padStart(12, "0")}`, { start_date: "2026-11-12" }),
    )
    const sb = makeSupabase((q) => {
      if (q.table === "event_purposes") return { data: [purposeRaw({})], error: null }
      if (isWindow(q)) return { data: many, error: null }
      return { data: [], error: null }
    })
    const data = await loadGarbagePage(sb.client, HOUSE, TODAY)
    expect(data.events).toBe("truncated")
    expect(sb.queries.find(isWindow)!.limit).toBe(1000)
  })
})
