/**
 * `maybeScheduleSync`（D-4 オンデマンドトリガ）の契約テスト。
 *
 * `after()` と service role クライアントは注入で差し替える。**既定の `schedule`
 * が `after()` を呼ぶこと**自体はここでは検証できぬ（リクエストスコープの外で
 * 呼ぶと Next が throw する）。既定値の正しさは `src/lib/google/sync-trigger.ts`
 * の import と、`/calendar` がビルド出力で `ƒ`（動的）であることで担保する
 * ——静的ページで `after` を使うとコールバックが**ビルド時**に走る、と
 * 同梱 docs が明記しておるゆえ。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { maybeScheduleSync, SYNC_STALE_MS } from "../sync-trigger"
import { createFakeSupabase, emptyDb, type FakeDb } from "./fake-supabase"

const NOW = Date.parse("2026-08-02T00:00:00.000Z")
const HOUSE = "house-1"

function db(
  connections: Array<{
    id: string
    connection_status: string
    last_synced_at: string | null
    household_id?: string
  }>,
): FakeDb {
  const base = emptyDb()
  base.google_connections = connections.map((c) => ({
    id: c.id,
    household_id: c.household_id ?? HOUSE,
    user_id: "user-1",
    connection_status: c.connection_status,
    sync_status: "idle",
    last_error_kind: null,
    last_synced_at: c.last_synced_at,
  }))
  return base
}

function deps() {
  const scheduled: Array<() => Promise<void>> = []
  const runSync = vi.fn(async () => {})
  return {
    scheduled,
    runSync,
    overrides: {
      now: () => NOW,
      schedule: (task: () => Promise<void>) => {
        scheduled.push(task)
      },
      runSync,
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("maybeScheduleSync", () => {
  it("接続が無ければ予約せぬ", async () => {
    const fake = createFakeSupabase(db([]))
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result).toEqual({
      syncScheduled: false,
      lastSyncedAt: null,
      hasConnection: false,
    })
    expect(d.scheduled).toHaveLength(0)
  })

  it("一度も同期しておらぬ接続があれば予約する", async () => {
    const fake = createFakeSupabase(
      db([{ id: "c1", connection_status: "active", last_synced_at: null }]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result.syncScheduled).toBe(true)
    expect(result.hasConnection).toBe(true)
    expect(d.scheduled).toHaveLength(1)
  })

  it("直近に同期済みなら予約せぬ（描画のたびに走らせぬ）", async () => {
    const fake = createFakeSupabase(
      db([
        {
          id: "c1",
          connection_status: "active",
          last_synced_at: new Date(NOW - 60_000).toISOString(),
        },
      ]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result.syncScheduled).toBe(false)
    expect(result.lastSyncedAt).toBe(new Date(NOW - 60_000).toISOString())
    expect(d.scheduled).toHaveLength(0)
  })

  it("stale 閾値を超えたら予約する", async () => {
    const stale = new Date(NOW - SYNC_STALE_MS - 1).toISOString()
    const fake = createFakeSupabase(
      db([{ id: "c1", connection_status: "active", last_synced_at: stale }]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result.syncScheduled).toBe(true)
  })

  it("needs_reauth だけなら予約せぬ（Google へ無駄な往復を撃たぬ）", async () => {
    const fake = createFakeSupabase(
      db([
        { id: "c1", connection_status: "needs_reauth", last_synced_at: null },
      ]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result).toMatchObject({ syncScheduled: false, hasConnection: true })
  })

  it("未知の状態値は denylist ゆえ同期対象に残る", async () => {
    const fake = createFakeSupabase(
      db([
        {
          id: "c1",
          connection_status: "paused-in-the-future",
          last_synced_at: null,
        },
      ]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result.syncScheduled).toBe(true)
  })

  it("lastSyncedAt は世帯内で最新のものを返す", async () => {
    const older = new Date(NOW - 3 * SYNC_STALE_MS).toISOString()
    const newer = new Date(NOW - 2 * SYNC_STALE_MS).toISOString()
    const fake = createFakeSupabase(
      db([
        { id: "c1", connection_status: "active", last_synced_at: older },
        { id: "c2", connection_status: "active", last_synced_at: newer },
      ]),
    )
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result.lastSyncedAt).toBe(newer)
  })

  it("接続の取得に失敗してもページを倒さぬ（予約せず false）", async () => {
    const fake = createFakeSupabase(db([]))
    fake.failOn("google_connections", "select", {
      message: "boom",
      code: "XX000",
      details: null,
      hint: null,
    })
    const d = deps()
    const result = await maybeScheduleSync(fake.client, HOUSE, d.overrides)

    expect(result).toEqual({
      syncScheduled: false,
      lastSyncedAt: null,
      hasConnection: false,
    })
    expect(console.error).toHaveBeenCalled()
  })

  it("背景同期が落ちても reject させず、構造化ログへ落とす", async () => {
    const fake = createFakeSupabase(
      db([{ id: "c1", connection_status: "active", last_synced_at: null }]),
    )
    const d = deps()
    d.runSync.mockRejectedValueOnce(new Error("boom"))

    await maybeScheduleSync(fake.client, HOUSE, d.overrides)
    await expect(d.scheduled[0]!()).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      "[google-sync-trigger] 背景同期に失敗",
      expect.objectContaining({ householdId: HOUSE, message: "boom" }),
    )
  })

  it("予約したタスクは当該世帯だけを同期する", async () => {
    const fake = createFakeSupabase(
      db([{ id: "c1", connection_status: "active", last_synced_at: null }]),
    )
    const d = deps()
    await maybeScheduleSync(fake.client, HOUSE, d.overrides)
    await d.scheduled[0]!()

    expect(d.runSync).toHaveBeenCalledWith(HOUSE)
  })
})
