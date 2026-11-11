/**
 * 家事ハブの要約の読み取り（`loadChoresHubSummary`）の契約。
 *
 * - 3 枠（ごみ・掃除・ごはん）は枠ごとに独立。どれか 1 つの失敗（error・例外・読めぬ行）で
 *   ほかの枠を倒さぬ。throw せぬ
 * - 失敗は failed（「ありません」「0 件」「未定」と言い換えぬ）
 * - 全クエリを世帯で絞る（RLS と二重）。読むだけ（書込の経路を持たぬ）
 *
 * 各機能の読み取り・文の組み立ては本物を通す（mock せぬ）。差し替えるのは Supabase の応答だけ。
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Database } from "@/lib/types/database"
import { CHORES_HUB_FAILED_TEXT } from "@/lib/domain/chores-hub"
import { entryRow, groceryRow } from "@/lib/meals/server/__tests__/fake-dinner-db"
import { loadChoresHubSummary } from "../chores-hub-query"

const HOUSE = "aa200000-0000-4000-8000-000000000001"
// 2026-11-11 は水曜（週は 11-09 月曜〜11-15 日曜）
const TODAY = "2026-11-11"
const GARBAGE_EVENT = "bb200000-0000-4000-8000-000000000001"
const ROUTINE_TODAY = "cc200000-0000-4000-8000-000000000001"
const ROUTINE_OVERDUE = "cc200000-0000-4000-8000-000000000002"
const VERSION = "2026-11-01T00:00:00.000000+00:00"

interface Query {
  /** 表の名前。RPC は `rpc:<name>` */
  target: string
  eq: Record<string, unknown>
  calls: string[]
}
type Result = { data: unknown; error: unknown }
type Handler = (q: Query) => Result | Promise<Result>

/** どのメソッドも自分を返し、await で handler の結果へ解決する代役。書込のメソッドを呼べば throw する。 */
function makeSupabase(handler: Handler) {
  const queries: Query[] = []
  const WRITES = new Set(["insert", "update", "upsert", "delete"])
  const chainOf = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled?: (v: Result) => unknown, onRejected?: (e: unknown) => unknown) =>
              Promise.resolve()
                .then(() => handler(q))
                .then(onFulfilled, onRejected)
          }
          if (typeof prop !== "string") return undefined
          return (...args: unknown[]) => {
            if (WRITES.has(prop)) throw new Error(`ハブの要約が書込を呼んだ: ${q.target}.${prop}`)
            q.calls.push(prop)
            if (prop === "eq") q.eq[String(args[0])] = args[1]
            return chainOf(q)
          }
        },
      },
    )
  const start = (target: string) => {
    const q: Query = { target, eq: {}, calls: [] }
    queries.push(q)
    return chainOf(q)
  }
  const client = {
    from: (table: string) => start(table),
    rpc: (name: string) => start(`rpc:${name}`),
  } as unknown as SupabaseClient<Database>
  return { client, queries }
}

const ok = (data: unknown): Result => ({ data, error: null })
const fail = (): Result => ({ data: null, error: { message: "permission denied", code: "42501", details: "", hint: "" } })

/** 3 枠とも読める世帯の応答（ごみ: 明日プラスチック / 掃除: 今日 1・超過 1 / ごはん: 確定 1 品・買う物 1 件） */
const healthy: Handler = (q) => {
  switch (q.target) {
    case "event_purposes":
      return ok([
        {
          id: "dd200000-0000-4000-8000-000000000001",
          scope: "event",
          target_key: GARBAGE_EVENT,
          purpose: "garbage",
          garbage_kind: "プラスチック",
          remind_default: null,
          reminder_opt_out: false,
          updated_at: VERSION,
        },
      ])
    case "calendar_events":
      return ok([
        {
          id: GARBAGE_EVENT,
          title: "収集",
          is_all_day: true,
          start_date: "2026-11-12",
          end_date: "2026-11-12",
          start_at: null,
          source: "native",
          series_id: null,
          medical_record_id: null,
          event_uid: GARBAGE_EVENT,
          google_calendar_id: null,
          recurring_event_id: null,
        },
      ])
    case "event_reminders":
      return ok([])
    case "cleaning_routines":
      return ok([
        routineRow(ROUTINE_TODAY, "2026-11-11"), // 毎週水曜 → 今日
        routineRow(ROUTINE_OVERDUE, "2026-11-09"), // 毎週月曜（過ぎた）→ 期限超過
      ])
    case "rpc:cleaning_log_marks":
      return ok([])
    case "dinner_plan_state":
      return ok({ household_id: HOUSE, revision: 3, grocery_revision: 3 })
    case "dinner_plan_entries":
      return ok([entryRow(HOUSE, { plan_date: TODAY, status: "confirmed" })])
    case "grocery_items":
      return ok([groceryRow(HOUSE, { name: "豚こま切れ肉", required_quantity: 200, unit: "g" })])
    default:
      throw new Error(`想定外の読み取り: ${q.target}`)
  }
}

function routineRow(id: string, anchor: string, o: Record<string, unknown> = {}) {
  return {
    id,
    name: "掃除",
    location: null,
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: anchor,
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    archived: false,
    updated_at: VERSION,
    created_at: VERSION,
    ...o,
  }
}

/** 一部の対象だけ応答を差し替える。 */
const withOverride =
  (targets: string[], reply: Handler): Handler =>
  (q) =>
    targets.includes(q.target) ? reply(q) : healthy(q)

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  consoleError.mockRestore()
})

describe("loadChoresHubSummary", () => {
  it("3 枠を読み、各画面と同じ数え方で要約する。全クエリを世帯で絞り、書込を呼ばぬ", async () => {
    const sb = makeSupabase(healthy)
    const summary = await loadChoresHubSummary(sb.client, HOUSE, TODAY)

    expect(summary.garbage).toEqual({ status: "ok", text: "次の収集日は明日 11月12日（木）、プラスチックです。" })
    expect(summary.cleaning).toEqual({ status: "ok", text: "今日 1件・今週のこり 0件・期限超過 1件" })
    expect(summary.meals.status).toBe("ok")
    expect(summary.meals.text).toMatch(/^今夜: .+（確定）・まだ買うもの 1件$/)
    expect(consoleError).not.toHaveBeenCalled()

    // 3 機能の表をすべて読んでおる
    const targets = new Set(sb.queries.map((q) => q.target))
    for (const target of [
      "event_purposes",
      "calendar_events",
      "cleaning_routines",
      "rpc:cleaning_log_marks",
      "dinner_plan_state",
      "dinner_plan_entries",
      "grocery_items",
    ]) {
      expect(targets, target).toContain(target)
    }
    // 表の読み取りは世帯で絞る（RPC は auth.uid() から世帯を導くゆえ引数を持たぬ）
    for (const q of sb.queries) {
      if (q.target.startsWith("rpc:")) continue
      expect(q.eq.household_id, q.target).toBe(HOUSE)
    }
    // アーカイブ済みの掃除は DB の側で除く
    expect(sb.queries.find((q) => q.target === "cleaning_routines")?.eq.archived).toBe(false)
  })

  it.each([
    ["garbage", ["event_purposes"]],
    ["garbage", ["calendar_events"]],
    ["cleaning", ["cleaning_routines"]],
    ["cleaning", ["rpc:cleaning_log_marks"]],
    ["meals", ["dinner_plan_entries"]],
    ["meals", ["dinner_plan_state"]],
    ["meals", ["grocery_items"]],
  ] as const)("%s の取得（%j）が error を返しても、その枠だけ failed でほかの 2 枠は読める", async (part, targets) => {
    const sb = makeSupabase(withOverride([...targets], fail))
    const summary = await loadChoresHubSummary(sb.client, HOUSE, TODAY)

    expect(summary[part]).toEqual({ status: "failed", text: CHORES_HUB_FAILED_TEXT[part] })
    for (const other of ["garbage", "cleaning", "meals"] as const) {
      if (other === part) continue
      expect(summary[other].status, other).toBe("ok")
    }
    // 失敗は握り潰さず記録する
    expect(consoleError).toHaveBeenCalled()
  })

  it.each([
    ["garbage", ["event_purposes", "calendar_events"]],
    ["cleaning", ["cleaning_routines", "rpc:cleaning_log_marks"]],
    ["meals", ["dinner_plan_state", "dinner_plan_entries", "grocery_items"]],
  ] as const)("%s の取得が例外（fetch の reject）で落ちても throw せず、その枠だけ failed", async (part, targets) => {
    const sb = makeSupabase(withOverride([...targets], () => Promise.reject(new TypeError("fetch failed"))))
    const summary = await loadChoresHubSummary(sb.client, HOUSE, TODAY)

    expect(summary[part]).toEqual({ status: "failed", text: CHORES_HUB_FAILED_TEXT[part] })
    for (const other of ["garbage", "cleaning", "meals"] as const) {
      if (other === part) continue
      expect(summary[other].status, other).toBe("ok")
    }
  })

  it("3 枠すべての取得が落ちても throw せず、3 枠とも failed を返す", async () => {
    const sb = makeSupabase(() => Promise.reject(new Error("down")))
    await expect(loadChoresHubSummary(sb.client, HOUSE, TODAY)).resolves.toEqual({
      garbage: { status: "failed", text: CHORES_HUB_FAILED_TEXT.garbage },
      cleaning: { status: "failed", text: CHORES_HUB_FAILED_TEXT.cleaning },
      meals: { status: "failed", text: CHORES_HUB_FAILED_TEXT.meals },
    })
  })

  it("掃除: 読めぬ履歴の要約は failed（「履歴なし」と見なして期限超過と偽らぬ）。対照: 読める要約は実施済みとして数える", async () => {
    const broken = makeSupabase(
      withOverride(["rpc:cleaning_log_marks"], () => ok([{ routine_id: ROUTINE_OVERDUE, last_done_on: "not-a-date" }])),
    )
    expect((await loadChoresHubSummary(broken.client, HOUSE, TODAY)).cleaning).toEqual({
      status: "failed",
      text: CHORES_HUB_FAILED_TEXT.cleaning,
    })

    const done = makeSupabase(
      withOverride(["rpc:cleaning_log_marks"], () =>
        ok([
          { routine_id: ROUTINE_OVERDUE, last_done_on: "2026-11-09", max_occurrence: "2026-11-09", max_skip_occurrence: null },
        ]),
      ),
    )
    // 月曜の回は実施済み → 期限超過は 0
    expect((await loadChoresHubSummary(done.client, HOUSE, TODAY)).cleaning.text).toBe(
      "今日 1件・今週のこり 0件・期限超過 0件",
    )
  })

  it("掃除: 配列でない応答は failed。形を読めぬ定義は数えず、注記で件数を言う", async () => {
    const notArray = makeSupabase(withOverride(["cleaning_routines"], () => ok(null)))
    expect((await loadChoresHubSummary(notArray.client, HOUSE, TODAY)).cleaning.status).toBe("failed")

    const unreadable = makeSupabase(
      withOverride(["cleaning_routines"], () =>
        ok([routineRow(ROUTINE_TODAY, "2026-11-11"), routineRow(ROUTINE_OVERDUE, "2026-11-09", { cadence_unit: "decade" })]),
      ),
    )
    expect((await loadChoresHubSummary(unreadable.client, HOUSE, TODAY)).cleaning).toEqual({
      status: "ok",
      text: "今日 1件・今週のこり 0件・期限超過 0件",
      note: "表示できない項目が1件あります。",
    })
  })

  it("空の世帯は 3 枠とも ok で「まだ・未定」を言う（failed と取り違えぬ）", async () => {
    const sb = makeSupabase((q) => (q.calls.includes("maybeSingle") ? ok(null) : ok([])))
    expect(await loadChoresHubSummary(sb.client, HOUSE, TODAY)).toEqual({
      garbage: { status: "ok", text: "ごみの日はまだ登録されていません。" },
      cleaning: { status: "ok", text: "掃除の項目はまだありません。" },
      meals: { status: "ok", text: "今夜の献立は未定・まだ買うものはありません" },
    })
  })

  it("ごはん: 読めぬ献立の行が在れば「未定」と言わず件数を注記する", async () => {
    const sb = makeSupabase(
      withOverride(["dinner_plan_entries"], () => ok([{ ...entryRow(HOUSE, { plan_date: TODAY }), role: 42 }])),
    )
    const { meals } = await loadChoresHubSummary(sb.client, HOUSE, TODAY)
    expect(meals.status).toBe("ok")
    expect(meals.text).toContain("今夜の献立は表示できません")
    expect(meals.text).not.toContain("未定")
    expect(meals).toHaveProperty("note", "表示できない献立の記録が1件あります。")
  })
})
