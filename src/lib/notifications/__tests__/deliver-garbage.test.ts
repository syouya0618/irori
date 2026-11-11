/**
 * ごみの日の前日通知が、**既存の予定通知の経路**で配られることの契約（家事機能 A: A-08 / A-09、V-A）。
 *
 * ごみの分類は配信に新しい種別・新しい表・新しい cron を足さぬ。分類の保存（`save_event_purpose`）は
 * 既存の `event_reminders` に `prev_day_20` の行を 1 つ書くだけで、以降は予定通知と同じ道を通る。
 * ここでは「ごみの日（終日・前日 20:00 JST）」の形の予定で、既存の配信の規則を確かめ直す:
 *
 * - 同じ回は 1 端末 1 通（次の周回で重ねて送らぬ・通知設定が二重でも 1 通）
 * - 予定の日付の変更・削除・通知の OFF の後に、古い予約を送らぬ
 * - Google の完全再同期の窓（予定の行が一時的に無い）で送らず、通知設定も消さぬ
 * - 通知から対象の日のカレンダーへ移れる
 *
 * fake は実データを保持してフィルタを評価する（`fake-notify-db.ts`）。配信のコードは変えておらぬ。
 * `event_reminders` の 1 予定 1 行（`uq_event_reminders_event`）と、分類の保存が既存の通知時刻を
 * 上書きせぬことは pgTAP（`supabase/tests/event_purposes.sql` の B-8 / D-3）が持つ。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import type { PushTarget, VapidConfig } from "../send-push"
import { createFakeNotifySupabase, emptyNotifyDb, type FakeNotifyDb } from "./fake-notify-db"

const H1 = "11111111-1111-1111-1111-111111111111"
const H2 = "33333333-3333-3333-3333-333333333333"
const U1 = "22222222-2222-2222-2222-222222222222"
const U2 = "88888888-8888-8888-8888-888888888888"
const U3 = "44444444-4444-4444-4444-444444444444"

/** 収集日（JST）と、その前日 20:00 JST（= 11:00 UTC）。 */
const COLLECTION_DAY = "2026-11-12"
const REMIND_AT = new Date("2026-11-11T11:00:00Z").toISOString()
/** cron の周回（5 分おき）。20:02 JST と 20:07 JST。 */
const TICK_1 = new Date("2026-11-11T11:02:00Z").toISOString()
const TICK_2 = new Date("2026-11-11T11:07:00Z").toISOString()

const NATIVE_UID = "aaaaaaaa-0000-4000-8000-000000000001"
const GOOGLE_UID = "synthetic-cal@example.invalid|rec_20261112"

const VAPID: VapidConfig = { publicKey: "pub", privateKey: "priv", subject: "mailto:a@example.com" }

interface SentRecord {
  target: PushTarget
  payload: unknown
}

function subscription(id: string, userId: string) {
  return {
    id,
    user_id: userId,
    endpoint: `https://fcm.googleapis.com/${id}`,
    p256dh: "k",
    auth: "a",
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
  }
}

/** ごみの日にした終日の予定（native）と、分類の保存が書いた前日通知。 */
function seed(): FakeNotifyDb {
  const db = emptyNotifyDb()
  db.profiles.push({ id: U1, household_id: H1 }, { id: U2, household_id: H1 }, { id: U3, household_id: H2 })
  db.push_subscriptions.push(subscription("sub-u1", U1))
  db.calendar_events.push({
    household_id: H1,
    event_uid: NATIVE_UID,
    title: "燃えるごみ",
    is_all_day: true,
    start_date: COLLECTION_DAY,
    start_at: null,
  })
  db.event_reminders.push({ household_id: H1, event_uid: NATIVE_UID, remind_at: REMIND_AT })
  return db
}

async function tick(db: FakeNotifyDb, now: string, sent: SentRecord[]) {
  const fake = createFakeNotifySupabase(db)
  return deliverDueNotifications(fake.client, {
    now: () => new Date(now),
    readVapid: () => VAPID,
    sendPush: vi.fn(async (target: PushTarget, _vapid: VapidConfig, payload: unknown) => {
      sent.push({ target, payload })
      return { ok: true as const }
    }),
  })
}

function pendingDelivery(over: Record<string, unknown> = {}) {
  return {
    id: "d-garbage",
    household_id: H1,
    kind: "event",
    event_key: NATIVE_UID,
    subscription_id: "sub-u1",
    subscription_key: "sub-u1",
    dedupe_day: "2026-11-11",
    scheduled_at: REMIND_AT,
    sent_at: null,
    skipped_at: null,
    skip_reason: null,
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("ごみの日の前日通知: 同じ回は 1 通", () => {
  it("前日 20:00 JST を過ぎた周回で 1 通送り、対象の日のカレンダーへ移れる", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_1, sent)

    expect(result).toMatchObject({ scheduled: 1, sent: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({
      title: "燃えるごみ",
      body: "11月12日 終日",
      // 通知から対象の日・予定へ移れる（既存の遷移先。新しい経路は足しておらぬ）
      url: `/calendar?date=${COLLECTION_DAY}`,
      tag: `event:${NATIVE_UID}`,
    })
    // 配信の種別は既存の予定通知のまま（ごみ専用の種別を作っておらぬ）
    expect(db.notification_deliveries.map((d) => d.kind)).toEqual(["event"])
    expect(db.notification_deliveries[0]).toMatchObject({ event_key: NATIVE_UID, dedupe_day: "2026-11-11" })
  })

  it("まだ前日 20:00 JST に達しておらねば送らぬ（対照）", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    await tick(db, new Date("2026-11-11T10:57:00Z").toISOString(), sent)
    expect(sent).toHaveLength(0)
    expect(db.notification_deliveries).toHaveLength(0)
  })

  it("次の周回でも同じ回を重ねて送らぬ", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    await tick(db, TICK_2, sent)
    expect(sent).toHaveLength(1)
    expect(db.notification_deliveries).toHaveLength(1)
  })

  it("世帯の全端末へ 1 通ずつ。別の世帯には送らぬ", async () => {
    const db = seed()
    db.push_subscriptions.push(subscription("sub-u2", U2), subscription("sub-u3", U3))
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    await tick(db, TICK_2, sent)
    expect(sent.map((s) => s.target.endpoint).sort()).toEqual([
      "https://fcm.googleapis.com/sub-u1",
      "https://fcm.googleapis.com/sub-u2",
    ])
  })

  it("同じ予定の通知設定が万一 2 行あっても、同じ日の配信は 1 端末 1 通に畳まれる", async () => {
    // 実 DB は 1 予定 1 行（uq_event_reminders_event）。ここは配信側の冪等の鍵
    // （kind, event_key, subscription_key, dedupe_day）が、通常の通知とごみの通知の重なりを 1 通にすることを見る
    const db = seed()
    db.event_reminders.push({
      household_id: H1,
      event_uid: NATIVE_UID,
      remind_at: new Date("2026-11-11T11:01:00Z").toISOString(),
    })
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    await tick(db, TICK_2, sent)
    expect(sent).toHaveLength(1)
    expect(db.notification_deliveries).toHaveLength(1)
  })
})

describe("ごみの日の前日通知: 変更・削除・OFF の後に古い予約を送らぬ", () => {
  it("収集日を別の日へ動かした後（remind_at が引き直された後）は、古い予約を畳む", async () => {
    const db = seed()
    // 予定を 11/19 へ動かした = DB のトリガが remind_at を 11/18 20:00 JST へ引き直した
    db.calendar_events[0].start_date = "2026-11-19"
    db.event_reminders[0].remind_at = new Date("2026-11-18T11:00:00Z").toISOString()
    // 動かす前の周回が作っておった未送信の予約
    db.notification_deliveries.push(pendingDelivery())
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_1, sent)

    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(db.notification_deliveries[0]).toMatchObject({ skip_reason: "rescheduled", sent_at: null })
  })

  it("動かした先の前日 20:00 JST に、新しい日付で 1 通送る", async () => {
    const db = seed()
    db.calendar_events[0].start_date = "2026-11-19"
    db.event_reminders[0].remind_at = new Date("2026-11-18T11:00:00Z").toISOString()
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent) // 元の前日には送らぬ
    expect(sent).toHaveLength(0)
    await tick(db, new Date("2026-11-18T11:02:00Z").toISOString(), sent)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ body: "11月19日 終日", url: "/calendar?date=2026-11-19" })
  })

  it("予定を削除した後は送らぬ（通知設定が残っておっても）", async () => {
    const db = seed()
    db.calendar_events.length = 0
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_1, sent)
    expect(sent).toHaveLength(0)
    expect(result.scheduled).toBe(0)
    expect(db.notification_deliveries).toHaveLength(0)
  })

  it("予定を削除した後、作り置きの予約は rescheduled で畳む", async () => {
    const db = seed()
    db.calendar_events.length = 0
    db.event_reminders.length = 0 // 削除の経路が通知設定も掃除した
    db.notification_deliveries.push(pendingDelivery())
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    expect(sent).toHaveLength(0)
    expect(db.notification_deliveries[0].skip_reason).toBe("rescheduled")
  })

  it("通知を止めた後（分類の「通知を止める」= 通知設定の行が無い）は送らぬ", async () => {
    const db = seed()
    db.event_reminders.length = 0
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_1, sent)
    expect(sent).toHaveLength(0)
    expect(result.scheduled).toBe(0)
  })

  it("通知を止める前に作られた予約も、止めた後は rescheduled で畳む", async () => {
    const db = seed()
    db.event_reminders.length = 0
    db.notification_deliveries.push(pendingDelivery())
    const sent: SentRecord[] = []
    const result = await tick(db, TICK_1, sent)
    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(db.notification_deliveries[0]).toMatchObject({ skip_reason: "rescheduled", sent_at: null })
  })
})

describe("ごみの日の前日通知: Google の予定と完全再同期の窓", () => {
  function googleSeed(): FakeNotifyDb {
    const db = emptyNotifyDb()
    db.profiles.push({ id: U1, household_id: H1 })
    db.push_subscriptions.push(subscription("sub-u1", U1))
    db.calendar_events.push({
      household_id: H1,
      event_uid: GOOGLE_UID,
      title: "資源回収",
      is_all_day: true,
      start_date: COLLECTION_DAY,
      start_at: null,
    })
    db.event_reminders.push({ household_id: H1, event_uid: GOOGLE_UID, remind_at: REMIND_AT })
    return db
  }

  it("Google 由来の予定（鍵は calendarId|eventId）も同じ経路で 1 通", async () => {
    const db = googleSeed()
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    await tick(db, TICK_2, sent)
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ title: "資源回収", tag: `event:${GOOGLE_UID}` })
  })

  it("再同期の窓（予定の行が一時的に無い）では送らず、通知設定も消さぬ。入れ直された後に 1 通送る", async () => {
    const db = googleSeed()
    const removed = db.calendar_events.splice(0, 1)
    const sent: SentRecord[] = []
    await tick(db, TICK_1, sent)
    expect(sent).toHaveLength(0)
    // 配信の側で孤児を掃除せぬ（窓の間に通知設定を失わぬ）
    expect(db.event_reminders).toHaveLength(1)

    // 同期が同じ鍵で行を入れ直した（行 id は変わるが event_uid は不変）
    db.calendar_events.push(...removed)
    await tick(db, TICK_2, sent)
    expect(sent).toHaveLength(1)
    await tick(db, new Date("2026-11-11T11:12:00Z").toISOString(), sent)
    expect(sent).toHaveLength(1)
  })
})
