/**
 * 配信ジョブ 1 周ぶんの契約（B-3）。
 *
 * fake は**実データを保持してフィルタを評価する**ゆえ、ここで見ておるのは
 * 「この列で eq しておるか」という形ではなく「他世帯に混ざったか」「行が 2 本
 * できたか」という**結果**じゃ。述語を消して書き換えるだけでは緑にできぬ。
 *
 * ## このテストが証明**できぬ**こと（正直に書く）
 * `claim`（`UPDATE ... WHERE sent_at IS NULL`）が二重送信を止めることは、
 * 2 接続を並行させぬ限り確かめられぬ。逐次のテストで書けるのは
 * 「claim が 0 行を返したら送らぬ」という**読み方**までじゃ
 * （`beforeExecute` で別プロセスの割り込みを模す）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import type { PushSendResult, PushTarget, VapidConfig } from "../send-push"
import { PUSH_GONE_STATUSES } from "../send-push"
import {
  createFakeNotifySupabase,
  emptyNotifyDb,
  type FakeNotifyDb,
} from "./fake-notify-db"

const H1 = "11111111-1111-1111-1111-111111111111"
const H2 = "33333333-3333-3333-3333-333333333333"
const U1 = "22222222-2222-2222-2222-222222222222"
const U2 = "88888888-8888-8888-8888-888888888888"
const U3 = "44444444-4444-4444-4444-444444444444"

// 2026-08-15T00:50:00Z = 09:50 JST。予定は 10:00 JST 開始。
// `toISOString()` で正規化しておく（ジョブが書く値と同じ表記にせねば、
// 「行が更新されたか」の assert が表記差で嘘をつく）。
const NOW = new Date("2026-08-15T00:50:00Z").toISOString()
const EVENT_START = new Date("2026-08-15T01:00:00Z").toISOString()

const VAPID: VapidConfig = {
  publicKey: "pub",
  privateKey: "priv",
  subject: "mailto:a@example.com",
}

interface SentRecord {
  target: PushTarget
  payload: unknown
}

function seed(): FakeNotifyDb {
  const db = emptyNotifyDb()
  db.profiles.push(
    { id: U1, household_id: H1 },
    { id: U2, household_id: H1 },
    { id: U3, household_id: H2 },
  )
  db.push_subscriptions.push({
    id: "sub-u1",
    user_id: U1,
    endpoint: "https://fcm.googleapis.com/u1",
    p256dh: "k1",
    auth: "a1",
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
  })
  db.calendar_events.push({
    household_id: H1,
    event_uid: "e1",
    title: "歯医者",
    is_all_day: false,
    start_date: "2026-08-15",
    start_at: EVENT_START,
  })
  db.event_reminders.push({
    household_id: H1,
    event_uid: "e1",
    remind_at: NOW,
  })
  return db
}

function run(
  db: FakeNotifyDb,
  options: {
    sent?: SentRecord[]
    result?: PushSendResult | (() => PushSendResult)
    vapid?: VapidConfig | null
    beforeExecute?: Parameters<typeof setBeforeExecute>[1]
  } = {},
) {
  const fake = createFakeNotifySupabase(db)
  if (options.beforeExecute) setBeforeExecute(fake, options.beforeExecute)
  const sendPush = vi.fn(
    async (target: PushTarget, _vapid: VapidConfig, payload: unknown) => {
      options.sent?.push({ target, payload })
      const outcome = options.result ?? { ok: true as const }
      return typeof outcome === "function" ? outcome() : outcome
    },
  )
  return {
    fake,
    sendPush,
    promise: deliverDueNotifications(fake.client, {
      now: () => new Date(NOW),
      readVapid: () => (options.vapid === undefined ? VAPID : options.vapid),
      sendPush,
    }),
  }
}

function setBeforeExecute(
  fake: ReturnType<typeof createFakeNotifySupabase>,
  hook: NonNullable<ReturnType<typeof createFakeNotifySupabase>["beforeExecute"]>,
) {
  fake.beforeExecute = hook
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("deliverDueNotifications — 展開と送信", () => {
  it("期限の来た通知を 1 通送り、行を送信済みにする", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    const { promise } = run(db, { sent })
    const result = await promise

    expect(result).toMatchObject({ scheduled: 1, sent: 1, skipped: 0, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].target.endpoint).toBe("https://fcm.googleapis.com/u1")
    expect(sent[0].payload).toMatchObject({
      title: "歯医者",
      body: "8月15日 10:00 開始",
    })

    const row = db.notification_deliveries[0]
    expect(row.sent_at).toBe(NOW)
    expect(row.skipped_at).toBeNull()
    expect(row.event_key).toBe("e1")
    // 冪等キーは購読 id の**不変コピー**（FK が SET NULL になっても動かぬ）。
    expect(row.subscription_key).toBe("sub-u1")
    expect(row.dedupe_day).toBe("2026-08-15")

    // 成功は購読の診断列へ返す（失敗カウントは畳む）。
    expect(db.push_subscriptions[0].last_success_at).toBe(NOW)
    expect(db.push_subscriptions[0].failure_count).toBe(0)
  })

  it("**世帯の全端末へ配る**（夫婦 2 人・3 台でも 1 予定 3 通）", async () => {
    const db = seed()
    db.push_subscriptions.push(
      {
        id: "sub-u1b",
        user_id: U1,
        endpoint: "https://fcm.googleapis.com/u1b",
        p256dh: "k",
        auth: "a",
        failure_count: 0,
      },
      {
        id: "sub-u2",
        user_id: U2,
        endpoint: "https://fcm.googleapis.com/u2",
        p256dh: "k",
        auth: "a",
        failure_count: 0,
      },
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(result.sent).toBe(3)
    expect(db.notification_deliveries).toHaveLength(3)
  })

  it("**世帯を跨がぬ**（他世帯の予定が混ざれば赤）", async () => {
    const db = seed()
    db.calendar_events.push({
      household_id: H2,
      event_uid: "e2",
      title: "他世帯の用事",
      is_all_day: false,
      start_date: "2026-08-15",
      start_at: EVENT_START,
    })
    db.event_reminders.push({ household_id: H2, event_uid: "e2", remind_at: NOW })
    db.push_subscriptions.push({
      id: "sub-u3",
      user_id: U3,
      endpoint: "https://fcm.googleapis.com/u3",
      p256dh: "k",
      auth: "a",
      failure_count: 0,
    })
    const sent: SentRecord[] = []
    await run(db, { sent }).promise

    const byEndpoint = new Map(
      sent.map((s) => [s.target.endpoint, s.payload as { title: string }]),
    )
    expect(byEndpoint.get("https://fcm.googleapis.com/u1")?.title).toBe("歯医者")
    expect(byEndpoint.get("https://fcm.googleapis.com/u3")?.title).toBe(
      "他世帯の用事",
    )
    expect(sent).toHaveLength(2)
  })

  it("**世帯に属さぬ購読には送らぬ**（未承認・世帯離脱は fail-closed）", async () => {
    const db = seed()
    db.profiles.push({ id: "orphan", household_id: null })
    db.push_subscriptions.push({
      id: "sub-orphan",
      user_id: "orphan",
      endpoint: "https://fcm.googleapis.com/orphan",
      p256dh: "k",
      auth: "a",
      failure_count: 0,
    })
    const sent: SentRecord[] = []
    await run(db, { sent }).promise

    expect(sent.map((s) => s.target.endpoint)).toEqual([
      "https://fcm.googleapis.com/u1",
    ])
  })

  it("終日予定（start_at = null）にも送る", async () => {
    const db = seed()
    db.calendar_events[0].start_at = null
    db.calendar_events[0].is_all_day = true
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(result.sent).toBe(1)
    expect((sent[0].payload as { body: string }).body).toBe("8月15日 終日")
  })
})

describe("grace window（期限内は送る / 期限切れは畳む — 対で固定する）", () => {
  it("14 分 59 秒の遅れなら送る（**対照**）", async () => {
    const db = seed()
    const late = new Date(Date.parse(NOW) - 14 * 60_000 - 59_000).toISOString()
    db.event_reminders[0].remind_at = late
    const result = await run(db).promise

    expect(result.sent).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it("15 分を超えた遅れは展開もされぬ（積み上がらぬ）", async () => {
    const db = seed()
    db.event_reminders[0].remind_at = new Date(
      Date.parse(NOW) - 16 * 60_000,
    ).toISOString()
    const result = await run(db).promise

    expect(result.scheduled).toBe(0)
    expect(result.sent).toBe(0)
    expect(db.notification_deliveries).toHaveLength(0)
  })

  it("**世帯が別件で回っておっても、古い通知設定は展開されぬ**（展開側の下端が単独で効く）", async () => {
    // ⚠️ この 1 本が要る理由を書き残す。上の「15 分を超えた遅れは展開もされぬ」は、
    // 世帯の**列挙**（collectHouseholdIds）と**展開**（expandDueReminders）の
    // 両方が同じ `remind_at > now - GRACE` を持つゆえ、**片方を消しても緑のまま**じゃ
    // （実測: 展開側だけ削っても 73 本すべて緑だった）。列挙は「積み残しを持つ世帯」も
    // 拾う設計ゆえ、世帯が別件で回りさえすれば古い通知設定が展開へ流れ込む。
    // ここでは在庫の予定 e1 で世帯を回しつつ、1 時間前の e2 が**行にならぬ**ことを見る。
    const db = seed()
    db.calendar_events.push({
      household_id: H1,
      event_uid: "e2",
      title: "とうに過ぎた用事",
      is_all_day: false,
      start_date: "2026-08-15",
      start_at: "2026-08-15T02:00:00Z", // 開始は未来（start_at ガードでは弾かれぬ）
    })
    db.event_reminders.push({
      household_id: H1,
      event_uid: "e2",
      remind_at: new Date(Date.parse(NOW) - 60 * 60_000).toISOString(),
    })

    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(db.notification_deliveries.map((row) => row.event_key)).toEqual(["e1"])
    expect(result.scheduled).toBe(1)
    // 展開側の下端が消えると e2 の行が生まれ、その場で expired へ落ちる。
    expect(result.skipped).toBe(0)
    expect(sent).toHaveLength(1)
  })

  it("作り置きの行が grace を過ぎておれば expired で畳む（送らぬ）", async () => {
    const db = seed()
    const old = new Date(Date.parse(NOW) - 20 * 60_000).toISOString()
    db.event_reminders[0].remind_at = old
    db.notification_deliveries.push({
      id: "d-old",
      household_id: H1,
      kind: "event",
      event_key: "e1",
      subscription_id: "sub-u1",
      subscription_key: "sub-u1",
      dedupe_day: "2026-08-15",
      scheduled_at: old,
      sent_at: null,
      skipped_at: null,
      skip_reason: null,
    })
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(db.notification_deliveries[0]).toMatchObject({
      skipped_at: NOW,
      skip_reason: "expired",
      sent_at: null,
    })
  })
})

describe("開始済みの予定には撃たぬ", () => {
  it("展開されぬ（行すら作らぬ）", async () => {
    const db = seed()
    db.calendar_events[0].start_at = "2026-08-15T00:49:00Z" // 1 分前に開始済み
    const result = await run(db).promise

    expect(result.scheduled).toBe(0)
    expect(db.notification_deliveries).toHaveLength(0)
  })

  it("作り置きの行も event_started で畳む（catch-up が「始まった後に 10 分前です」と鳴らぬ）", async () => {
    const db = seed()
    db.calendar_events[0].start_at = "2026-08-15T00:49:00Z"
    db.notification_deliveries.push({
      id: "d-started",
      household_id: H1,
      kind: "event",
      event_key: "e1",
      subscription_id: "sub-u1",
      subscription_key: "sub-u1",
      dedupe_day: "2026-08-15",
      scheduled_at: NOW,
      sent_at: null,
      skipped_at: null,
      skip_reason: null,
    })
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(db.notification_deliveries[0].skip_reason).toBe("event_started")
  })
})

describe("冪等性 — 二重通知を殺す", () => {
  it("同じ実行条件で 2 回走らせても行は 1 本・送信も 1 通", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    await run(db, { sent }).promise

    expect(db.notification_deliveries).toHaveLength(1)
    expect(sent).toHaveLength(1)
  })

  it("**23:58 の失敗を 00:04 が拾い直しても 1 通のまま**（dedupe_day が実行日由来なら 2 本になる）", async () => {
    const db = emptyNotifyDb()
    db.profiles.push({ id: U1, household_id: H1 })
    db.push_subscriptions.push({
      id: "sub-u1",
      user_id: U1,
      endpoint: "https://fcm.googleapis.com/u1",
      p256dh: "k1",
      auth: "a1",
      failure_count: 0,
    })
    // 2026-08-14T14:58:00Z = 8/14 23:58 JST、予定は 8/15 09:00 JST 開始。
    const remindAt = "2026-08-14T14:58:00Z"
    db.calendar_events.push({
      household_id: H1,
      event_uid: "e1",
      title: "夜更けの予定",
      is_all_day: false,
      start_date: "2026-08-15",
      start_at: "2026-08-15T00:00:00Z",
    })
    db.event_reminders.push({ household_id: H1, event_uid: "e1", remind_at: remindAt })

    const fake = createFakeNotifySupabase(db)
    // 1 回目（23:59 JST）: 送信に失敗させる。
    await deliverDueNotifications(fake.client, {
      now: () => new Date("2026-08-14T14:59:00Z"),
      readVapid: () => VAPID,
      sendPush: async () => ({
        ok: false,
        gone: false,
        status: 500,
        message: "boom",
      }),
    })
    expect(db.notification_deliveries).toHaveLength(1)
    expect(db.notification_deliveries[0].sent_at).toBeNull()

    // 2 回目（00:04 JST・**日を跨いだ**）: 拾い直して送る。
    const sent: SentRecord[] = []
    const result = await deliverDueNotifications(fake.client, {
      now: () => new Date("2026-08-14T15:04:00Z"),
      readVapid: () => VAPID,
      sendPush: async (target, _v, payload) => {
        sent.push({ target, payload })
        return { ok: true }
      },
    })

    // 行が 2 本になっておれば「実行日から dedupe_day を取った」証拠じゃ。
    expect(db.notification_deliveries).toHaveLength(1)
    expect(db.notification_deliveries[0].dedupe_day).toBe("2026-08-14")
    expect(sent).toHaveLength(1)
    expect(result.sent).toBe(1)
  })

  it("**claim が 0 行なら送らぬ**（別プロセスに先を越された場合）", async () => {
    const db = seed()
    const sent: SentRecord[] = []
    const { promise } = run(db, {
      sent,
      beforeExecute: (record, liveDb) => {
        // claim の直前に「別プロセスが既に送った」状態を作る。
        if (
          record.table === "notification_deliveries" &&
          record.op === "update" &&
          (record.payload as { sent_at?: string }).sent_at === NOW
        ) {
          for (const row of liveDb.notification_deliveries) {
            if (row.sent_at === null) row.sent_at = "2026-08-15T00:49:59Z"
          }
        }
      },
    })
    const result = await promise

    expect(sent).toHaveLength(0)
    expect(result.sent).toBe(0)
    expect(db.notification_deliveries[0].sent_at).toBe("2026-08-15T00:49:59Z")
  })
})

describe("予定が動いたとき", () => {
  it("**同じ日の移動は再照準する**（skip すると冪等キーが埋まったまま通知が消える）", async () => {
    const db = seed()
    db.notification_deliveries.push({
      id: "d-moved",
      household_id: H1,
      kind: "event",
      event_key: "e1",
      subscription_id: "sub-u1",
      subscription_key: "sub-u1",
      dedupe_day: "2026-08-15",
      scheduled_at: "2026-08-15T00:40:00Z", // 元の狙い
      sent_at: null,
      skipped_at: null,
      skip_reason: null,
    })
    // 通知設定は 10 分後ろへ動いた（= まだ来ておらぬ）。
    db.event_reminders[0].remind_at = "2026-08-15T00:55:00Z"
    db.calendar_events[0].start_at = "2026-08-15T01:05:00Z"

    const sent: SentRecord[] = []
    await run(db, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(db.notification_deliveries).toHaveLength(1)
    expect(db.notification_deliveries[0]).toMatchObject({
      scheduled_at: "2026-08-15T00:55:00.000Z",
      skipped_at: null,
      sent_at: null,
    })
  })

  it("通知設定が消えておれば rescheduled で畳む", async () => {
    const db = seed()
    db.event_reminders.length = 0
    db.notification_deliveries.push({
      id: "d-orphan",
      household_id: H1,
      kind: "event",
      event_key: "e1",
      subscription_id: "sub-u1",
      subscription_key: "sub-u1",
      dedupe_day: "2026-08-15",
      scheduled_at: NOW,
      sent_at: null,
      skipped_at: null,
      skip_reason: null,
    })
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(db.notification_deliveries[0].skip_reason).toBe("rescheduled")
  })
})

describe("送信の失敗", () => {
  it("410 なら購読を消し、行は 'gone' で畳む（**sent_at は立てぬ**）", async () => {
    const db = seed()
    const result = await run(db, {
      result: { ok: false, gone: true, status: 410, message: "gone" },
    }).promise

    expect(result.skipped).toBe(1)
    expect(result.sent).toBe(0)
    expect(db.push_subscriptions).toHaveLength(0)
    expect(db.notification_deliveries[0]).toMatchObject({
      sent_at: null,
      skip_reason: "gone",
      // 購読が消えても履歴は残る（FK は SET NULL）。**どの端末だったかは
      // subscription_key に残る** — CASCADE ならこの行ごと消えて 'gone' を
      // 一度も観測できぬ。
      subscription_id: null,
      subscription_key: "sub-u1",
    })
    expect(db.notification_deliveries[0].skipped_at).toBe(NOW)
  })

  it("**status が返った失敗**は claim を解いて次回へ回す（購読は消さぬ）", async () => {
    const db = seed()
    const result = await run(db, {
      result: { ok: false, gone: false, status: 500, message: "boom" },
    }).promise

    expect(result.failed).toBe(1)
    expect(db.push_subscriptions).toHaveLength(1)
    expect(db.push_subscriptions[0].failure_count).toBe(1)
    expect(db.push_subscriptions[0].last_failure_at).toBe(NOW)
    expect(db.notification_deliveries[0]).toMatchObject({
      sent_at: null,
      skipped_at: null,
    })
  })

  /**
   * ★ **届いたか分からぬ失敗は再送せぬ（at-most-once）。**
   *
   * ⚠️ **上の「status が返った失敗は再送する」と対で置いてある。片方だけにするな。**
   * 落とす側だけなら「常に落とす」実装で緑になり、再送側だけなら「常に再送する」
   * ——まさに直そうとしておる姿——で緑になる。**弁別しておるのは status の有無
   * ただ 1 つ**ゆえ、その 2 本が対を成して初めて意味を持つ。
   *
   * なぜ落とすのか: ソケットタイムアウトは「push サービスは受理したのに応答だけ
   * 落ちた」を含みうる。再送すれば同じ通知が二度鳴り、**Safari は可視通知の雪崩で
   * 権限そのものを剥奪する**（Apple 公式）—— 失うのは 1 通ではなくその端末の
   * 通知全部じゃ。
   */
  it("**status の無い失敗（ソケットタイムアウト等）は再送せぬ**（claim を握ったまま落とす）", async () => {
    const db = seed()
    const result = await run(db, {
      // `sendPushNotification` が WebPushError 以外を捕らえた時の姿そのままじゃ。
      result: { ok: false, gone: false, status: null, message: "socket timeout" },
    }).promise

    // 失敗としては数える（心拍・診断が「平穏」に見えぬため）。
    expect(result.failed).toBe(1)
    expect(result.sent).toBe(0)
    // 購読は消さぬ（破棄は 'gone' の枝ただ 1 つ）。診断には失敗として残る。
    expect(db.push_subscriptions).toHaveLength(1)
    expect(db.push_subscriptions[0].failure_count).toBe(1)
    // ★ **claim が解かれておらぬこと** ＝ 次の実行がこの行を拾わぬ。
    expect(db.notification_deliveries[0]).toMatchObject({
      sent_at: NOW,
      skipped_at: null,
      skip_reason: null,
    })
  })

  it("落とした 1 通は次の実行でも鳴らぬ（sent_at の assert が「拾われぬ」まで届いておることの証明）", async () => {
    // ⚠️ 上のテストは行の**姿**しか見ておらぬ。姿が正しくとも次の実行が
    // 拾い直せば二度鳴る（それを止めるのが claim を握ったままにする目的じゃ）。
    // ゆえに実際に 2 周目を回して 0 通を確かめる。
    const db = seed()
    const fake = createFakeNotifySupabase(db)
    await deliverDueNotifications(fake.client, {
      now: () => new Date(NOW),
      readVapid: () => VAPID,
      sendPush: async () => ({
        ok: false,
        gone: false,
        status: null,
        message: "socket timeout",
      }),
    })

    const sent: SentRecord[] = []
    const second = await deliverDueNotifications(fake.client, {
      // 5 分後。grace（15 分）の内ゆえ、拾えるなら必ず拾う時点じゃ。
      now: () => new Date("2026-08-15T00:55:00Z"),
      readVapid: () => VAPID,
      sendPush: async (target, _v, payload) => {
        sent.push({ target, payload })
        return { ok: true }
      },
    })

    expect(sent).toHaveLength(0)
    expect(second.sent).toBe(0)
    // 行は 1 本のまま（冪等キーが効いて作り直されてもおらぬ）。
    expect(db.notification_deliveries).toHaveLength(1)
    expect(db.notification_deliveries[0].sent_at).toBe(NOW)
  })

  /**
   * ★ **削除に至る status の集合を、実物の allowlist と突き合わせる（B-4）。**
   *
   * ⚠️ **この総なめが何を証明し、何を証明せぬかを正直に書く。**
   * `gone` は実物の `PUSH_GONE_STATUSES` から導いて渡しておるゆえ、これは
   * 「渡した flag が尊重された」＋「allowlist が広がっておらぬ」の 2 点じゃ。
   * **配信層が status を覗いておらぬこと**を弁別するのは、この下の
   * 「矛盾した組」2 本の方であって、この総なめではない
   * （検出器の射程を過大に語らぬ。この repo が繰り返し踏んできた誤りゆえ）。
   *
   * それでも置くのは、`send-push.test.ts` の総なめが送信層の中で閉じており、
   * 「配信層まで来て実際に行が消えた」ことを一度も見ておらぬからじゃ。
   * 見本 1 本ずつでは、列挙し忘れた status がそのまま穴になる
   * （401 だけ置いても 403/429/503 で復活した blocklist を素通しする）。
   */
  it("**購読が消える status の集合は {404, 410} ちょうど**（400..599 を配信層まで通す）", async () => {
    const deleted: number[] = []
    for (let status = 400; status <= 599; status++) {
      const db = seed()
      await run(db, {
        result: {
          ok: false,
          // 実物の allowlist を使う。ここを手書きの真理値表にすると
          // 「テストの中だけ正しい」ものになる。
          gone: PUSH_GONE_STATUSES.has(status),
          status,
          message: `swept ${status}`,
        },
      }).promise
      if (db.push_subscriptions.length === 0) deleted.push(status)
    }
    expect(deleted).toEqual([404, 410])
  })

  // 表駆動。集合テストの補集合側を「1 本ずつ読める形」でも残す
  // （失敗時にどの status で壊れたかが即座に分かる）。
  it.each([401, 403, 408, 429, 500, 502, 503])(
    "%i では購読を消さず、claim を解いて再試行へ回す",
    async (status) => {
      const db = seed()
      const result = await run(db, {
        result: { ok: false, gone: false, status, message: "transient" },
      }).promise

      expect(db.push_subscriptions).toHaveLength(1)
      expect(db.push_subscriptions[0].failure_count).toBe(1)
      expect(result.failed).toBe(1)
      expect(db.notification_deliveries[0]).toMatchObject({
        // 再試行に回す ＝ 行は未送信・未 skip のまま残らねばならぬ。
        sent_at: null,
        skipped_at: null,
        skip_reason: null,
      })
    },
  )

  /**
   * ★ **判定源は `gone` フラグただ 1 つ**（status を見ておらぬことの証明）。
   *
   * この 2 本は「矛盾した組」を故意に渡す。配信層が status を覗いておれば
   * 必ずどちらかが割れる — 送信層の allowlist が正しいことは、配信層が
   * **それに従っておること**を別に確かめねば意味を成さぬ。
   */
  it("`gone: false` なら status が 410 でも購読を消さぬ", async () => {
    const db = seed()
    await run(db, {
      result: { ok: false, gone: false, status: 410, message: "誤読の罠" },
    }).promise

    expect(db.push_subscriptions).toHaveLength(1)
    expect(db.notification_deliveries[0].skip_reason).toBeNull()
  })

  it("`gone: true` なら status が 500 でも購読を消す", async () => {
    const db = seed()
    await run(db, {
      result: { ok: false, gone: true, status: 500, message: "誤読の罠" },
    }).promise

    expect(db.push_subscriptions).toHaveLength(0)
    expect(db.notification_deliveries[0].skip_reason).toBe("gone")
  })

  it("**401 では購読を消さぬ**（VAPID 設定ミス 1 つで全端末が消し飛ぶのを止める）", async () => {
    const db = seed()
    await run(db, {
      result: { ok: false, gone: false, status: 401, message: "unauthorized" },
    }).promise

    expect(db.push_subscriptions).toHaveLength(1)
    expect(db.notification_deliveries[0].skip_reason).toBeNull()
  })
})

describe("心拍", () => {
  it("送るものが無くとも必ず書かれる（**故障と無風を分ける唯一の手段**）", async () => {
    const db = emptyNotifyDb()
    const result = await run(db).promise

    expect(result.sent).toBe(0)
    expect(db.notification_heartbeat).toEqual([
      {
        id: 1,
        ran_at: NOW,
        sent_count: 0,
        skipped_count: 0,
        failed_count: 0,
      },
    ])
  })

  it("1 行のまま更新される（2 行に増えぬ）", async () => {
    const db = seed()
    await run(db).promise
    await run(db).promise

    expect(db.notification_heartbeat).toHaveLength(1)
    expect(db.notification_heartbeat[0].sent_count).toBe(0) // 2 周目は送るものが無い
  })

  it("VAPID 未設定なら throw し、**心拍には failed を残す**", async () => {
    const db = seed()
    await expect(run(db, { vapid: null }).promise).rejects.toThrow(/VAPID/)

    expect(db.notification_deliveries).toHaveLength(0)
    expect(db.notification_heartbeat[0]).toMatchObject({
      ran_at: NOW,
      failed_count: 1,
    })
  })

  it("送信が例外を投げても実行は完走し、心拍に failed が残る", async () => {
    const db = seed()
    const fake = createFakeNotifySupabase(db)
    const result = await deliverDueNotifications(fake.client, {
      now: () => new Date(NOW),
      readVapid: () => VAPID,
      // `sendPushNotification` は結果を返す契約じゃが、想定外の例外は起こりうる。
      // 1 世帯の事故で全体を止めぬこと（syncAllHouseholds と同じ扱い）を固定する。
      sendPush: async () => {
        throw new Error("送信層が壊れた")
      },
    })

    expect(result.failed).toBe(1)
    expect(db.notification_heartbeat[0]).toMatchObject({
      ran_at: NOW,
      failed_count: 1,
    })
    // ⚠️ **at-most-once の割り切りがそのまま出る**: claim 済みの行は claim された
    // まま残り、この 1 通は永久に送られぬ。二重に鳴らすよりましと判断した結果じゃ。
    expect(db.notification_deliveries[0].sent_at).toBe(NOW)
  })

  it("世帯の列挙で落ちても心拍だけは残り、**failed が 1 以上になる**", async () => {
    const db = seed()
    const fake = createFakeNotifySupabase(db)
    fake.failOn("event_reminders", "select", { message: "boom", code: "XX000" })

    // 対象世帯の列挙で落ちるゆえ、全体が throw する（心拍は finally が書く）。
    await expect(
      deliverDueNotifications(fake.client, {
        now: () => new Date(NOW),
        readVapid: () => VAPID,
        sendPush: async () => ({ ok: true }),
      }),
    ).rejects.toThrow()
    // ⚠️ **`ran_at` だけを見てはならぬ。** ran_at だけの assert は、
    // `failed_count: 0` で書かれる（＝恒久的な全面停止が「平穏」に見える）
    // 欠落を素通しする — 実際にこの形で欠落しておったのを敵対レビューが拾った。
    // runbook の一次監視は ran_at の鮮度ゆえ、failed が 0 のままなら
    // 「5 分ごとに走っておるが 1 通も届かぬ」状態が永久に緑になる。
    expect(db.notification_heartbeat[0]).toMatchObject({
      ran_at: NOW,
      sent_count: 0,
      failed_count: 1,
    })
    // 対照は上の「送るものが無くとも必ず書かれる」が持つ（`failed_count: 0` を
    // 完全一致で見ておる）。下駄を「常に 1」へ緩めると**あちらが赤くなる** —
    // 実測で確認済みゆえ、ここに同じ assert を重ねはせぬ。
  })

  it("**列挙以外の想定外の throw でも failed が残る**（数え上げが allowlist へ退化せぬ）", async () => {
    const db = seed()
    const fake = createFakeNotifySupabase(db)

    // ⚠️ このテストが守っておるのは「どこで throw しても数える」という**形**じゃ。
    // 数え上げを「世帯の列挙」だけ try/catch で包む書き方（＝ throw 箇所の
    // allowlist）に戻すと、この経路が素通りして `failed_count: 0` になる。
    // `readVapid` は `null` を返す契約じゃが、env 読取が例外を投げる改修は
    // いつでも起こりうる — そのとき無音で監視が盲になってはならぬ。
    await expect(
      deliverDueNotifications(fake.client, {
        now: () => new Date(NOW),
        readVapid: () => {
          throw new Error("env 読取が壊れた")
        },
        sendPush: async () => ({ ok: true }),
      }),
    ).rejects.toThrow(/env 読取/)

    expect(db.notification_heartbeat[0]).toMatchObject({
      ran_at: NOW,
      failed_count: 1,
    })
  })
})
