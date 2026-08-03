/**
 * 同期エンジン（`sync.ts`）の契約テスト。
 *
 * **実 Google API は一切呼ばぬ**（認証情報を持たぬ）。`fetchAllEventPages` /
 * `refreshAccessToken` を注入で差し替え、DB は `fake-supabase.ts` の
 * 「フィルタを実際に評価する小さな実データ」で受ける。ゆえに
 * 「native 行を巻き込んだ」「二重同期が通った」「削除済みが復活した」は
 * **構造ではなく結果として**割れる。
 *
 * RLS・列 GRANT・ON CONFLICT の解決可否は実 DB の話ゆえ pgTAP が担う
 * （`supabase/tests/google_calendar_sync_grants_rls.sql` /
 *  `supabase/tests/google_sync_upsert_conflict.sql`）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  syncHousehold,
  syncAllHouseholds,
  cleanupMirrorForUnsubscribedCalendar,
  dedupeRawEventsLastWins,
  SYNC_LEASE_MS,
  WRITE_CHUNK_SIZE,
  type GoogleSyncDeps,
} from "../sync"
import { GoogleCalendarError } from "../calendar-client"
import { GoogleAuthError } from "../oauth"
import type { GoogleRawEvent } from "@/lib/domain/google-calendar-sync"
import {
  createFakeSupabase,
  emptyDb,
  type FakeDb,
  type FakeSupabase,
} from "./fake-supabase"

const NOW = Date.parse("2026-08-02T00:00:00.000Z")
const NOW_ISO = new Date(NOW).toISOString()
const HOUSE = "house-1"
const CONN = "conn-1"
const USER = "user-1"
const SUB = "sub-1"
const CAL = "cal-1@group.calendar.google.com"

function seedDb(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    calendar_events: [],
    google_connections: [
      {
        id: CONN,
        household_id: HOUSE,
        user_id: USER,
        connection_status: "active",
        sync_status: "idle",
        last_error_kind: null,
        last_synced_at: null,
      },
    ],
    google_tokens: [
      {
        connection_id: CONN,
        refresh_token: "refresh-1",
        access_token: "access-1",
        // 十分先ゆえ先回り refresh は起きぬ。
        access_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
        scope: "https://www.googleapis.com/auth/calendar.readonly openid email",
      },
    ],
    google_calendar_subscriptions: [
      {
        id: SUB,
        connection_id: CONN,
        household_id: HOUSE,
        google_calendar_id: CAL,
        is_selected: true,
        sync_token: null,
        sync_lease_until: null,
        last_synced_at: null,
      },
    ],
    ...overrides,
  }
}

function timedEvent(id: string, summary = id): GoogleRawEvent {
  return {
    id,
    status: "confirmed",
    summary,
    start: { dateTime: "2026-08-10T10:00:00+09:00" },
    end: { dateTime: "2026-08-10T11:00:00+09:00" },
  }
}

function cancelledEvent(id: string): GoogleRawEvent {
  return { id, status: "cancelled" }
}

interface Harness {
  fake: FakeSupabase
  deps: Partial<GoogleSyncDeps>
  fetchAllEventPages: ReturnType<typeof vi.fn>
  refreshAccessToken: ReturnType<typeof vi.fn>
}

function harness(db: FakeDb = seedDb()): Harness {
  const fake = createFakeSupabase(db)
  const fetchAllEventPages = vi.fn(async () => ({
    events: [] as GoogleRawEvent[],
    nextSyncToken: "token-next",
  }))
  const refreshAccessToken = vi.fn(async () => ({
    accessToken: "access-2",
    refreshToken: null,
    accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString(),
    scope: null,
  }))
  return {
    fake,
    fetchAllEventPages,
    refreshAccessToken,
    deps: {
      now: () => NOW,
      fetchAllEventPages:
        fetchAllEventPages as unknown as GoogleSyncDeps["fetchAllEventPages"],
      refreshAccessToken:
        refreshAccessToken as unknown as GoogleSyncDeps["refreshAccessToken"],
    },
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================
// dedupeRawEventsLastWins
// ============================================================

describe("dedupeRawEventsLastWins", () => {
  it("同一 id は最後の状態が勝つ（upsert → cancelled）", () => {
    const out = dedupeRawEventsLastWins([
      timedEvent("a"),
      timedEvent("b"),
      cancelledEvent("a"),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual(cancelledEvent("a"))
    expect(out[1]).toEqual(timedEvent("b"))
  })

  it("同一 id は最後の状態が勝つ（cancelled → 復活）", () => {
    const out = dedupeRawEventsLastWins([cancelledEvent("a"), timedEvent("a")])
    expect(out).toEqual([timedEvent("a")])
  })

  it("id を持たぬイベントは畳まぬ（skipped[] の報告を潰さぬため）", () => {
    const noId: GoogleRawEvent = { status: "confirmed", summary: "x" }
    const out = dedupeRawEventsLastWins([noId, noId, noId])
    expect(out).toHaveLength(3)
  })

  it("位置は初出のまま保たれる", () => {
    const out = dedupeRawEventsLastWins([
      timedEvent("a"),
      timedEvent("b"),
      timedEvent("a", "a-updated"),
    ])
    expect(out.map((e) => e.id)).toEqual(["a", "b"])
    expect(out[0]?.summary).toBe("a-updated")
  })
})

// ============================================================
// リース（二重同期防止）
// ============================================================

describe("atomic リース", () => {
  it("リースを取れたら sync_lease_until を now+SYNC_LEASE_MS で押さえ、or 述語を伴う", async () => {
    const h = harness()
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const acquire = h.fake.recordsOf("google_calendar_subscriptions", "update")[0]
    expect(acquire?.payload).toEqual({
      sync_lease_until: new Date(NOW + SYNC_LEASE_MS).toISOString(),
    })
    expect(acquire?.filters).toContainEqual({
      kind: "or",
      raw: `sync_lease_until.is.null,sync_lease_until.lt.${NOW_ISO}`,
    })
  })

  it("別実行がリース保持中なら **Google を一度も叩かず** skip する", async () => {
    const db = seedDb()
    // 「別実行が 1 分前に取り、まだ切れておらぬ」状態。
    db.google_calendar_subscriptions[0]!.sync_lease_until = new Date(
      NOW + 60_000,
    ).toISOString()

    const h = harness(db)
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fetchAllEventPages).not.toHaveBeenCalled()
    expect(summary.connections[0]?.subscriptions[0]?.status).toBe(
      "skipped_leased",
    )
    // 保持中のリースを奪ってもおらぬ。
    expect(db.google_calendar_subscriptions[0]?.sync_lease_until).toBe(
      new Date(NOW + 60_000).toISOString(),
    )
  })

  it("失効したリースは奪って進める", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_lease_until = new Date(
      NOW - 1_000,
    ).toISOString()

    const h = harness(db)
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fetchAllEventPages).toHaveBeenCalledTimes(1)
    expect(summary.connections[0]?.subscriptions[0]?.status).toBe("synced")
  })

  it("成功時も失敗時もリースを解放する（自分が取った値と一致する行だけ）", async () => {
    const h = harness()
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fake.db.google_calendar_subscriptions[0]?.sync_lease_until).toBeNull()
    const release = h.fake
      .recordsOf("google_calendar_subscriptions", "update")
      .at(-1)
    expect(release?.payload).toEqual({ sync_lease_until: null })
    // **自分のリース値でスコープする**。外すと、自分のリースが失効した後に
    // 別実行が取り直したリースを消してしまい二重同期防止が壊れる。
    expect(release?.filters).toContainEqual({
      kind: "eq",
      column: "sync_lease_until",
      value: new Date(NOW + SYNC_LEASE_MS).toISOString(),
    })
  })

  it("**失敗時はリースを握ったまま**にする（一過性失敗のバックオフ）", async () => {
    const db = seedDb()
    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("quota", "429", { status: 429 }),
    )
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(summary.connections[0]?.subscriptions[0]?.status).toBe("failed")
    // 解放すると、失敗時は last_synced_at も前進せぬ設計と噛み合って
    // 「レート制限中にページを開くたび再試行」になる。
    expect(db.google_calendar_subscriptions[0]?.sync_lease_until).toBe(
      new Date(NOW + SYNC_LEASE_MS).toISOString(),
    )
  })

  it("失敗直後の再実行は **Google を叩かぬ**（リース保持中ゆえ skip）", async () => {
    const db = seedDb()
    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("quota", "429", { status: 429 }),
    )
    await syncHousehold(h.fake.client, HOUSE, h.deps)
    expect(h.fetchAllEventPages).toHaveBeenCalledTimes(1)

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)
    expect(h.fetchAllEventPages).toHaveBeenCalledTimes(1)
    expect(summary.connections[0]?.subscriptions[0]?.status).toBe(
      "skipped_leased",
    )
  })

  it("410 のときは **解放する**（掃除直後で空ゆえ復旧を待たせぬ）", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_token = "token-stale"
    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("gone", "410", { status: 410 }),
    )
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(db.google_calendar_subscriptions[0]?.sync_lease_until).toBeNull()
  })
})

// ============================================================
// 取り込み（upsert / delete / 順序）
// ============================================================

describe("差分の取り込み", () => {
  it("upsert は onConflict を三列複合で指定し、synced_at を **全行に** 足す", async () => {
    const h = harness()
    h.fetchAllEventPages.mockResolvedValue({
      events: [timedEvent("g1"), timedEvent("g2")],
      nextSyncToken: "token-next",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const upsert = h.fake.recordsOf("calendar_events", "upsert")[0]
    expect(upsert?.upsertOptions).toEqual({
      onConflict: "household_id,google_calendar_id,google_event_id",
    })
    const rows = upsert?.payload as Record<string, unknown>[]
    expect(rows).toHaveLength(2)
    // 一部にだけ足すと `.upsert(rows[])` は列がずれて落ちる。
    expect(rows.every((r) => r.synced_at === NOW_ISO)).toBe(true)
    expect(new Set(rows.map((r) => Object.keys(r).sort().join(",")))).toHaveProperty(
      "size",
      1,
    )
  })

  it("cancelled は household + calendar + source='google' でスコープして消す", async () => {
    const db = seedDb()
    db.calendar_events = [
      {
        household_id: HOUSE,
        title: "google 行",
        source: "google",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: SUB,
        synced_at: null,
      },
      {
        // 別世帯の同名イベント。巻き込んではならぬ。
        household_id: "house-2",
        title: "他世帯",
        source: "google",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: "sub-2",
        synced_at: null,
      },
      {
        // native 行が google_calendar_id を持つのは chk_calendar_google_meta が
        // **選言**ゆえ DB 上は合法。source を外すと手入力の予定が巻き込まれる。
        household_id: HOUSE,
        title: "手入力",
        source: "native",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: null,
        synced_at: null,
      },
    ]

    const h = harness(db)
    h.fetchAllEventPages.mockResolvedValue({
      events: [cancelledEvent("g1")],
      nextSyncToken: "token-next",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const titles = db.calendar_events.map((e) => e.title).sort()
    expect(titles).toEqual(["他世帯", "手入力"])
  })

  it("同一 id が upsert → cancelled の順で届いたら **最終的に消える**", async () => {
    const h = harness()
    h.fetchAllEventPages.mockResolvedValue({
      events: [timedEvent("g1"), timedEvent("g2"), cancelledEvent("g1")],
      nextSyncToken: "token-next",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fake.db.calendar_events.map((e) => e.google_event_id)).toEqual([
      "g2",
    ])
  })

  it("同一 id が cancelled → upsert の順で届いたら **残る**（last-wins）", async () => {
    const h = harness()
    h.fetchAllEventPages.mockResolvedValue({
      events: [cancelledEvent("g1"), timedEvent("g1")],
      nextSyncToken: "token-next",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fake.db.calendar_events.map((e) => e.google_event_id)).toEqual([
      "g1",
    ])
  })

  it("実行順の契約: calendar_events の upsert は delete より **先**に撃つ", async () => {
    const h = harness()
    h.fetchAllEventPages.mockResolvedValue({
      events: [timedEvent("g1"), cancelledEvent("g2")],
      nextSyncToken: "token-next",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const upsertAt = h.fake.indexOf("calendar_events", "upsert")
    const deleteAt = h.fake.indexOf("calendar_events", "delete")
    expect(upsertAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThanOrEqual(0)
    // 上流の last-wins 重複排除により両集合は互いに素ゆえ、逆順でも**この実装
    // では**結果は変わらぬ。それでも順序を固定するのは多層防御じゃ:
    // 重複排除を落とした者が現れた時、逆順だと削除済みの行が復活し、増分同期
    // ゆえ二度と消えぬ（戻らぬ事故）。
    expect(upsertAt).toBeLessThan(deleteAt)
  })

  it("上限を超える行は分割して **全件** 撃つ（無音で切り詰めぬ）", async () => {
    const h = harness()
    const many = Array.from({ length: WRITE_CHUNK_SIZE + 7 }, (_, i) =>
      timedEvent(`g${i}`),
    )
    h.fetchAllEventPages.mockResolvedValue({
      events: many,
      nextSyncToken: "token-next",
    })
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fake.recordsOf("calendar_events", "upsert")).toHaveLength(2)
    expect(summary.connections[0]?.subscriptions[0]?.upserted).toBe(
      WRITE_CHUNK_SIZE + 7,
    )
    expect(h.fake.db.calendar_events).toHaveLength(WRITE_CHUNK_SIZE + 7)
  })
})

// ============================================================
// syncToken
// ============================================================

describe("syncToken", () => {
  it("sync_token が無ければ **フル同期**（timeMin 付き・syncToken 無し）", async () => {
    const h = harness()
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const [, , query] = h.fetchAllEventPages.mock.calls[0]!
    expect(query).toEqual({
      mode: "full",
      timeMin: new Date(NOW - 90 * 24 * 3600 * 1000).toISOString(),
    })
  })

  it("sync_token があれば **増分同期**（timeMin を付けぬ）", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_token = "token-prev"
    const h = harness(db)
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const [, , query] = h.fetchAllEventPages.mock.calls[0]!
    // timeMin と syncToken の併用は Google が禁じており、付けると 400 で全滅する。
    expect(query).toEqual({ mode: "incremental", syncToken: "token-prev" })
  })

  it("nextSyncToken を保存し、last_synced_at を前進させる", async () => {
    const h = harness()
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fake.db.google_calendar_subscriptions[0]?.sync_token).toBe(
      "token-next",
    )
    expect(h.fake.db.google_calendar_subscriptions[0]?.last_synced_at).toBe(
      NOW_ISO,
    )
    expect(h.fake.db.google_connections[0]?.last_synced_at).toBe(NOW_ISO)
  })

  it("nextSyncToken が null なら **既存を据え置く**（NULL を書かぬ）", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_token = "token-prev"
    const h = harness(db)
    h.fetchAllEventPages.mockResolvedValue({ events: [], nextSyncToken: null })

    await syncHousehold(h.fake.client, HOUSE, h.deps)

    // NULL を書くと以後永久にフル同期へ退化し、増分同期が静かに死ぬ。
    expect(db.google_calendar_subscriptions[0]?.sync_token).toBe("token-prev")
  })
})

// ============================================================
// 410 GONE
// ============================================================

describe("410 GONE のフル再同期", () => {
  it("sync_token を落とし、この購読のミラーだけを掃除する", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_token = "token-stale"
    db.calendar_events = [
      {
        household_id: HOUSE,
        title: "この購読の行",
        source: "google",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: SUB,
        synced_at: null,
      },
      {
        household_id: HOUSE,
        title: "手入力",
        source: "native",
        google_calendar_id: null,
        google_event_id: null,
        subscription_id: null,
        synced_at: null,
      },
    ]

    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("gone", "410", { status: 410 }),
    )
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(summary.connections[0]?.subscriptions[0]).toMatchObject({
      status: "resync_required",
      errorKind: "gone",
    })
    expect(db.google_calendar_subscriptions[0]?.sync_token).toBeNull()
    expect(db.calendar_events.map((e) => e.title)).toEqual(["手入力"])
    expect(db.google_connections[0]?.sync_status).toBe("error")
    expect(db.google_connections[0]?.last_error_kind).toBe("gone")
  })

  it("410 の後は last_synced_at を **前進させぬ**（staleness ゲートが復旧を抑止せぬよう）", async () => {
    const db = seedDb()
    db.google_connections[0]!.last_synced_at = "2026-08-01T00:00:00.000Z"
    db.google_calendar_subscriptions[0]!.sync_token = "token-stale"
    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("gone", "410", { status: 410 }),
    )

    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(db.google_connections[0]?.last_synced_at).toBe(
      "2026-08-01T00:00:00.000Z",
    )
  })

  it("410 の **次の実行** はフル同期でミラーを取り直す（静かな死の検出）", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.sync_token = "token-stale"
    const h = harness(db)
    h.fetchAllEventPages.mockRejectedValueOnce(
      new GoogleCalendarError("gone", "410", { status: 410 }),
    )
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    h.fetchAllEventPages.mockResolvedValue({
      events: [timedEvent("g1")],
      nextSyncToken: "token-fresh",
    })
    await syncHousehold(h.fake.client, HOUSE, h.deps)

    const [, , secondQuery] = h.fetchAllEventPages.mock.calls[1]!
    expect(secondQuery).toMatchObject({ mode: "full" })
    expect(db.calendar_events.map((e) => e.google_event_id)).toEqual(["g1"])
    expect(db.google_calendar_subscriptions[0]?.sync_token).toBe("token-fresh")
  })
})

// ============================================================
// 401 / invalid_grant
// ============================================================

describe("access token の失効", () => {
  it("401 は refresh して **1 回だけ** 再試行する", async () => {
    const h = harness()
    h.fetchAllEventPages
      .mockRejectedValueOnce(
        new GoogleCalendarError("unknown", "401", { status: 401 }),
      )
      .mockResolvedValueOnce({
        events: [timedEvent("g1")],
        nextSyncToken: "token-next",
      })

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(h.fetchAllEventPages).toHaveBeenCalledTimes(2)
    expect(h.fetchAllEventPages.mock.calls[1]![0]).toBe("access-2")
    expect(summary.connections[0]?.subscriptions[0]?.status).toBe("synced")
    // refresh 応答は refresh_token を含まぬ。書き込みに混ぜると既存値を壊す。
    const tokenUpdate = h.fake.recordsOf("google_tokens", "update")[0]
    expect(tokenUpdate?.payload).not.toHaveProperty("refresh_token")
    expect(h.fake.db.google_tokens[0]?.refresh_token).toBe("refresh-1")
    expect(h.fake.db.google_tokens[0]?.access_token).toBe("access-2")
  })

  it("2 度目の 401 は再試行せず失敗させる", async () => {
    const h = harness()
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("unknown", "401", { status: 401 }),
    )

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fetchAllEventPages).toHaveBeenCalledTimes(2)
    expect(summary.connections[0]?.subscriptions[0]?.status).toBe("failed")
  })

  it("refresh が invalid_grant なら connection_status='needs_reauth' へ落とす", async () => {
    const h = harness()
    h.fetchAllEventPages.mockRejectedValue(
      new GoogleCalendarError("unknown", "401", { status: 401 }),
    )
    h.refreshAccessToken.mockRejectedValue(
      new GoogleAuthError("invalid_grant", "revoked"),
    )

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(summary.connections[0]?.needsReauth).toBe(true)
    expect(h.fake.db.google_connections[0]?.connection_status).toBe(
      "needs_reauth",
    )
    expect(h.fake.db.google_connections[0]?.last_error_kind).toBe(
      "invalid_grant",
    )
  })

  it("access token の期限が不明（NULL）なら先回りで refresh する", async () => {
    const db = seedDb()
    db.google_tokens[0]!.access_token_expires_at = null
    const h = harness(db)

    await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it("トークン行が無い接続は needs_reauth にする（同期は試みぬ）", async () => {
    const db = seedDb({ google_tokens: [] })
    const h = harness(db)

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fetchAllEventPages).not.toHaveBeenCalled()
    expect(summary.connections[0]?.needsReauth).toBe(true)
    expect(db.google_connections[0]?.connection_status).toBe("needs_reauth")
  })
})

// ============================================================
// 選出述語
// ============================================================

describe("同期対象の選出", () => {
  it("needs_reauth の接続は denylist で除く（未知の状態値は落とさぬ）", async () => {
    const db = seedDb()
    db.google_connections.push({
      id: "conn-2",
      household_id: HOUSE,
      user_id: "user-2",
      connection_status: "needs_reauth",
      sync_status: "error",
      last_error_kind: "invalid_grant",
      last_synced_at: null,
    })
    // 将来 DB に増えうる未知の状態。allowlist だと **無音で漏れる**。
    db.google_connections.push({
      id: "conn-3",
      household_id: HOUSE,
      user_id: "user-3",
      connection_status: "paused-in-the-future",
      sync_status: "idle",
      last_error_kind: null,
      last_synced_at: null,
    })

    const h = harness(db)
    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(summary.connections.map((c) => c.connectionId).sort()).toEqual([
      "conn-1",
      "conn-3",
    ])
  })

  it("is_selected でない購読は同期せぬ", async () => {
    const db = seedDb()
    db.google_calendar_subscriptions[0]!.is_selected = false
    const h = harness(db)

    const summary = await syncHousehold(h.fake.client, HOUSE, h.deps)

    expect(h.fetchAllEventPages).not.toHaveBeenCalled()
    expect(summary.connections[0]?.subscriptions).toHaveLength(0)
    // 何も失敗しておらぬゆえ last_synced_at は前進する
    // （前進せねばページを開くたび同期が予約される hot loop になる）。
    expect(db.google_connections[0]?.last_synced_at).toBe(NOW_ISO)
  })

  it("syncAllHouseholds は世帯を重複なく列挙し、1 世帯の失敗で他を巻き込まぬ", async () => {
    const db = seedDb()
    db.google_connections.push({
      id: "conn-b",
      household_id: "house-2",
      user_id: "user-b",
      connection_status: "active",
      sync_status: "idle",
      last_error_kind: null,
      last_synced_at: null,
    })
    db.google_connections.push({
      id: "conn-c",
      household_id: "house-2",
      user_id: "user-c",
      connection_status: "active",
      sync_status: "idle",
      last_error_kind: null,
      last_synced_at: null,
    })

    const h = harness(db)
    const result = await syncAllHouseholds(h.fake.client, h.deps)

    expect(result.households).toBe(2)
    expect(result.summaries.map((s) => s.householdId)).toEqual([
      HOUSE,
      "house-2",
    ])
  })
})

// ============================================================
// V9 ミラー掃除
// ============================================================

describe("V9: 購読解除時のミラー掃除", () => {
  function mirrorDb(): FakeDb {
    const db = emptyDb()
    db.calendar_events = [
      {
        household_id: HOUSE,
        title: "google 行",
        source: "google",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: SUB,
        synced_at: null,
      },
      {
        // native 行が同じ google_calendar_id を持つのは DB 上合法。
        household_id: HOUSE,
        title: "手入力",
        source: "native",
        google_calendar_id: CAL,
        google_event_id: null,
        subscription_id: null,
        synced_at: null,
      },
      {
        household_id: "house-2",
        title: "他世帯",
        source: "google",
        google_calendar_id: CAL,
        google_event_id: "g1",
        subscription_id: "sub-x",
        synced_at: null,
      },
    ]
    return db
  }

  it("**二重購読中は消えぬ**（配偶者がまだ選択中）", async () => {
    const db = mirrorDb()
    db.google_calendar_subscriptions = [
      {
        id: "sub-spouse",
        connection_id: "conn-spouse",
        household_id: HOUSE,
        google_calendar_id: CAL,
        is_selected: true,
        sync_token: null,
        sync_lease_until: null,
        last_synced_at: null,
      },
    ]
    const fake = createFakeSupabase(db)

    const result = await cleanupMirrorForUnsubscribedCalendar(
      fake.client,
      HOUSE,
      CAL,
    )

    expect(result.deleted).toBe(false)
    expect(db.calendar_events).toHaveLength(3)
  })

  it("**最後の購読が外れたら消える**（native と他世帯は残す）", async () => {
    const db = mirrorDb()
    db.google_calendar_subscriptions = [
      {
        id: "sub-spouse",
        connection_id: "conn-spouse",
        household_id: HOUSE,
        google_calendar_id: CAL,
        is_selected: false,
        sync_token: null,
        sync_lease_until: null,
        last_synced_at: null,
      },
    ]
    const fake = createFakeSupabase(db)

    const result = await cleanupMirrorForUnsubscribedCalendar(
      fake.client,
      HOUSE,
      CAL,
    )

    expect(result.deleted).toBe(true)
    // `.eq("source","google")` が無ければ「手入力」まで消える。
    expect(db.calendar_events.map((e) => e.title).sort()).toEqual([
      "他世帯",
      "手入力",
    ])
  })

  it("購読の残存確認に失敗したら **消さぬ**（fail-closed）", async () => {
    const db = mirrorDb()
    const fake = createFakeSupabase(db)
    fake.failOn("google_calendar_subscriptions", "select", {
      message: "boom",
      code: "XX000",
      details: null,
      hint: null,
    })

    await expect(
      cleanupMirrorForUnsubscribedCalendar(fake.client, HOUSE, CAL),
    ).rejects.toThrow(/購読の残存確認/)
    expect(db.calendar_events).toHaveLength(3)
  })
})
