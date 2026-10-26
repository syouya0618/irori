/**
 * 要望の知らせ（feedback_notifications）の配信フェーズの契約。
 *
 * `deliverDueNotifications` を**丸ごと**回して見る（cron が呼ぶのはそれ 1 本ゆえ、
 * フェーズが繋がっておらねば緑にならぬ形にする）。fake は実データを持ってフィルタを
 * 評価するゆえ、見ておるのは「誰の端末に何が届いたか」「行がどう終端したか」という結果じゃ。
 *
 * ## このテストが証明できぬこと
 * claim による二重送信の直列化は 2 接続を並べねば確かめられぬ（deliver.test.ts と同じ）。
 * ここで書けるのは「claim が 0 行なら送らぬ」という読み方まで。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import type { PushSendResult, PushTarget, VapidConfig } from "../send-push"
import {
  createFakeNotifySupabase,
  emptyNotifyDb,
  type FakeNotifyDb,
} from "./fake-notify-db"

const H1 = "11111111-1111-1111-1111-111111111111"
const H2 = "33333333-3333-3333-3333-333333333333"
const WIFE = "22222222-2222-2222-2222-222222222222"
const OPERATOR = "44444444-4444-4444-4444-444444444444"
const FEEDBACK = "f0000000-0000-4000-8000-000000000001"

const NOW = new Date("2026-10-25T12:00:00Z").toISOString()
const ONE_MIN_AGO = new Date("2026-10-25T11:59:00Z").toISOString()
const TWENTY_MIN_AGO = new Date("2026-10-25T11:40:00Z").toISOString()
const IN_ONE_MIN = new Date("2026-10-25T12:01:00Z").toISOString()

const VAPID: VapidConfig = {
  publicKey: "pub",
  privateKey: "priv",
  subject: "mailto:a@example.com",
}

/** ロック画面に出てはならぬ文字列（要望の題・本文・投稿者名）。 */
const SECRET_TITLE = "娘の体重グラフを見やすくしてほしい"
const SECRET_BODY = "夜中の授乳記録が見づらい"
const SECRET_NAME = "妻の表示名"

interface SentRecord {
  target: PushTarget
  payload: unknown
}

function subscription(id: string, userId: string, endpoint: string) {
  return {
    id,
    user_id: userId,
    endpoint,
    p256dh: "k",
    auth: "a",
    failure_count: 0,
    last_success_at: null,
    last_failure_at: null,
  }
}

function notification(
  id: string,
  over: Partial<Record<string, unknown>> & { event_id: string; recipient_id: string; audience: string; subscription_id: string | null },
) {
  return {
    id,
    subscription_key: over.subscription_id ?? "gone-key",
    scheduled_at: ONE_MIN_AGO,
    sent_at: null,
    accepted_at: null,
    skipped_at: null,
    skip_reason: null,
    created_at: ONE_MIN_AGO,
    ...over,
  }
}

/**
 * 妻（H1）が要望を送り、運用者（H2 = 別世帯）が受け取る形。
 * 運用者が別世帯に居ても届くこと自体が、専用キューにした理由の検証になる。
 */
function seed(): FakeNotifyDb {
  const db = emptyNotifyDb()
  db.profiles.push(
    { id: WIFE, household_id: H1, is_approved: true },
    { id: OPERATOR, household_id: H2, is_approved: true },
  )
  db.app_operators.push({ user_id: OPERATOR })
  db.push_subscriptions.push(
    subscription("sub-op", OPERATOR, "https://fcm.googleapis.com/op"),
    subscription("sub-wife", WIFE, "https://web.push.apple.com/wife"),
  )
  db.feedback_items.push({
    id: FEEDBACK,
    submitter_id: WIFE,
    submitter_name: SECRET_NAME,
    title: SECRET_TITLE,
    body: SECRET_BODY,
    // 状態変更の知らせは「今もその状態」の時だけ送る。既定は検討中の知らせが通る状態。
    status: "considering",
  })
  db.feedback_events.push(
    { id: "ev-submitted", feedback_id: FEEDBACK, kind: "submitted", to_status: "received" },
    { id: "ev-considering", feedback_id: FEEDBACK, kind: "status_changed", to_status: "considering" },
    { id: "ev-released", feedback_id: FEEDBACK, kind: "status_changed", to_status: "released" },
    { id: "ev-comment", feedback_id: FEEDBACK, kind: "commented", to_status: null },
  )
  return db
}

function run(
  db: FakeNotifyDb,
  options: {
    sent?: SentRecord[]
    result?: PushSendResult | (() => PushSendResult)
  } = {},
) {
  const fake = createFakeNotifySupabase(db)
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
      readVapid: () => VAPID,
      sendPush,
    }),
  }
}

const rowOf = (db: FakeNotifyDb, id: string) =>
  db.feedback_notifications.find((row) => row.id === id) as Record<string, unknown>

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("要望の知らせ — 送る", () => {
  it("新しい要望を別世帯の運用者の端末へ送り、受理を accepted_at に記録する", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", {
        event_id: "ev-submitted",
        recipient_id: OPERATOR,
        audience: "operator",
        subscription_id: "sub-op",
      }),
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(result).toMatchObject({ sent: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0].target.endpoint).toBe("https://fcm.googleapis.com/op")
    expect(sent[0].payload).toMatchObject({
      url: `/feedback/inbox/${FEEDBACK}`,
      tag: `feedback:${FEEDBACK}`,
    })
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: NOW, accepted_at: NOW, skipped_at: null })
    // 購読の診断は予定通知と同じ後始末で健康へ戻る
    expect(db.push_subscriptions.find((s) => s.id === "sub-op")).toMatchObject({
      last_success_at: NOW,
      failure_count: 0,
    })
  })

  it("状態変更は投稿者の端末へ、状態名だけを載せて送る", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", {
        event_id: "ev-considering",
        recipient_id: WIFE,
        audience: "submitter",
        subscription_id: "sub-wife",
      }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise

    expect(sent).toHaveLength(1)
    expect(sent[0].target.endpoint).toBe("https://web.push.apple.com/wife")
    expect(sent[0].payload).toMatchObject({
      body: expect.stringContaining("「検討中」"),
      url: `/feedback/${FEEDBACK}`,
    })
  })

  it("ロック画面へ要望の題・本文・投稿者名を載せぬ（どの種別でも）", async () => {
    const sent: SentRecord[] = []
    for (const [status, eventId] of [
      ["considering", "ev-considering"],
      ["released", "ev-released"],
    ] as const) {
      const db = seed()
      db.feedback_items[0].status = status
      db.feedback_notifications.push(
        notification("n1", { event_id: "ev-submitted", recipient_id: OPERATOR, audience: "operator", subscription_id: "sub-op" }),
        notification("n2", { event_id: eventId, recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
        notification("n3", { event_id: "ev-comment", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife", subscription_key: "k3" }),
      )
      await run(db, { sent }).promise
    }

    expect(sent).toHaveLength(6)
    const serialized = JSON.stringify(sent.map((s) => s.payload))
    for (const secret of [SECRET_TITLE, SECRET_BODY, SECRET_NAME]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it("今も反映済みの要望には「反映されました」を送る（対照）", async () => {
    const db = seed()
    db.feedback_items[0].status = "released"
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-released", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ body: expect.stringContaining("反映されました") })
  })

  it("⚠️ 確定の後に差し戻した要望へ、積み残しの「反映されました」を送らぬ（superseded）", async () => {
    const db = seed()
    // 確定（ev-released）の知らせが積まれたまま、運用者が理由付きで対応中へ戻した
    db.feedback_items[0].status = "in_progress"
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-released", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skip_reason: "superseded" })
  })

  it("周回の途中で差し戻されたら、送る直前の読み直しで止める（superseded）", async () => {
    const db = seed()
    db.feedback_items[0].status = "released"
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-released", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    const handle = run(db, { sent })
    // 周回の頭の読み込み（id, submitter_id, status）の後、送る直前の読み直し（status だけ）の
    // 手前で運用者が差し戻した、を模す。
    handle.fake.beforeExecute = (record, store) => {
      if (record.table === "feedback_items" && record.op === "select" && record.columns === "status") {
        store.feedback_items[0].status = "in_progress"
      }
    }
    await handle.promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skip_reason: "superseded" })
  })

  it("送る直前の読み直しで状態が分からねば、今回は送らず行を残す（次の周回が裁く）", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    const handle = run(db, { sent })
    // 周回の頭の読み込みの後、読み直しの手前で要望が消えた（読み直しは 0 行）
    handle.fake.beforeExecute = (record, store) => {
      if (record.table === "feedback_items" && record.op === "select" && record.columns === "status") {
        store.feedback_items.length = 0
      }
    }
    await handle.promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skipped_at: null })
  })

  it("返信だけの知らせは、状態がその後に変わっても送る（状態に依らぬ）", async () => {
    const db = seed()
    db.feedback_items[0].status = "declined"
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-comment", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(1)
  })
})

describe("要望の知らせ — 送る直前の問い直し（fail-closed）", () => {
  it("運用者の名簿から外れた相手へは送らず revoked で畳む", async () => {
    const db = seed()
    db.app_operators.length = 0
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-submitted", recipient_id: OPERATOR, audience: "operator", subscription_id: "sub-op" }),
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise

    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skip_reason: "revoked" })
  })

  it("承認を失った・世帯を離れた受信者へは送らぬ", async () => {
    for (const profile of [
      { id: WIFE, household_id: H1, is_approved: false },
      { id: WIFE, household_id: null, is_approved: true },
    ]) {
      const db = seed()
      db.profiles.splice(0, 1, profile)
      db.feedback_notifications.push(
        notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
      )
      const sent: SentRecord[] = []
      await run(db, { sent }).promise
      expect(sent).toHaveLength(0)
      expect(rowOf(db, "n1").skip_reason).toBe("revoked")
    }
  })

  it("投稿者宛の行が投稿者でない相手を指しておれば送らぬ（他人の要望の更新を漏らさぬ）", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: OPERATOR, audience: "submitter", subscription_id: "sub-op" }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1").skip_reason).toBe("revoked")
  })

  it("運用者宛の行が「新しい要望」以外を指しておれば送らぬ", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: OPERATOR, audience: "operator", subscription_id: "sub-op" }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1").skip_reason).toBe("revoked")
  })

  it("要望が消えておれば送らぬ", async () => {
    const db = seed()
    db.feedback_items.length = 0
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1").skip_reason).toBe("revoked")
  })

  it("grace を過ぎた行は送らずに expired で畳む", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", {
        event_id: "ev-considering", recipient_id: WIFE, audience: "submitter",
        subscription_id: "sub-wife", scheduled_at: TWENTY_MIN_AGO,
      }),
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(result.skipped).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({ skip_reason: "expired", sent_at: null })
  })

  it("時刻がまだ来ておらぬ行は触らぬ", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", {
        event_id: "ev-considering", recipient_id: WIFE, audience: "submitter",
        subscription_id: "sub-wife", scheduled_at: IN_ONE_MIN,
      }),
    )
    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skipped_at: null })
  })

  it("allowlist 外の宛先は claim せず、数えるだけ", async () => {
    const db = seed()
    db.push_subscriptions.push(subscription("sub-bad", WIFE, "https://attacker.example/x"))
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-bad" }),
    )
    const sent: SentRecord[] = []
    const result = await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
    expect(result.rejectedEndpoints).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, skipped_at: null })
  })

  it("claim を別プロセスに取られたら送らぬ", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const sent: SentRecord[] = []
    const handle = run(db, { sent })
    handle.fake.beforeExecute = (record, store) => {
      if (
        record.table === "feedback_notifications" &&
        record.op === "update" &&
        (record.payload as Record<string, unknown>).sent_at === NOW
      ) {
        // 別プロセスが一瞬先に claim した
        const row = store.feedback_notifications.find((r) => r.id === "n1")
        if (row) row.sent_at = "2026-10-25T11:59:59.000Z"
      }
    }
    await handle.promise
    expect(sent).toHaveLength(0)
  })
})

describe("要望の知らせ — 送信の結果（届いたと偽らぬ）", () => {
  it("404/410 は行を gone で畳んでから購読を消す（予定通知と同じ後始末）", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const result = await run(db, {
      result: { ok: false, gone: true, status: 410, message: "Gone" },
    }).promise

    expect(result.skipped).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({
      sent_at: null,
      accepted_at: null,
      skip_reason: "gone",
      // 購読の削除で FK の SET NULL が効く（履歴は残る）
      subscription_id: null,
    })
    expect(db.push_subscriptions.some((s) => s.id === "sub-wife")).toBe(false)
  })

  it("届いておらぬと証明できる失敗（status あり）は claim を解き、次の実行で再送する", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    const first = await run(db, {
      result: { ok: false, gone: false, status: 500, message: "boom" },
    }).promise
    expect(first.failed).toBe(1)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: null, accepted_at: null, skipped_at: null })
    expect(db.push_subscriptions.find((s) => s.id === "sub-wife")).toMatchObject({
      failure_count: 1,
      last_failure_at: NOW,
    })

    const sent: SentRecord[] = []
    const second = await run(db, { sent }).promise
    expect(second.sent).toBe(1)
    expect(sent).toHaveLength(1)
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: NOW, accepted_at: NOW })
  })

  it("結果の分からぬ失敗（status なし）は再送せず、受理も記録せぬ（＝結果不明）", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-considering", recipient_id: WIFE, audience: "submitter", subscription_id: "sub-wife" }),
    )
    await run(db, {
      result: { ok: false, gone: false, status: null, message: "socket timeout" },
    }).promise
    // sent_at は claim の印として残り、accepted_at は立たぬ → 画面は「結果不明」
    expect(rowOf(db, "n1")).toMatchObject({ sent_at: NOW, accepted_at: null, skipped_at: null })

    const sent: SentRecord[] = []
    await run(db, { sent }).promise
    expect(sent).toHaveLength(0)
  })
})

describe("要望の知らせ — 予定通知との独立", () => {
  it("要望のフェーズが落ちても予定の通知は送られ、失敗は心拍に残る", async () => {
    const db = seed()
    const H_EVENT = H1
    const EVENT_START = new Date("2026-10-25T12:10:00Z").toISOString()
    db.calendar_events.push({
      household_id: H_EVENT,
      event_uid: "e1",
      title: "健診",
      is_all_day: false,
      start_date: "2026-10-25",
      start_at: EVENT_START,
    })
    db.event_reminders.push({ household_id: H_EVENT, event_uid: "e1", remind_at: NOW })
    const sent: SentRecord[] = []
    const handle = run(db, { sent })
    handle.fake.failOn("feedback_notifications", "update", { message: "boom", code: "XX000" })
    const result = await handle.promise

    expect(sent.map((s) => s.target.endpoint)).toEqual(["https://web.push.apple.com/wife"])
    expect(result.failed).toBe(1)
    expect(db.notification_heartbeat[0]).toMatchObject({ failed_count: 1, sent_count: 1 })
  })

  it("予定通知の世帯の列挙が落ちても要望の知らせは送り、実行は失敗として残す", async () => {
    const db = seed()
    db.feedback_notifications.push(
      notification("n1", { event_id: "ev-submitted", recipient_id: OPERATOR, audience: "operator", subscription_id: "sub-op" }),
    )
    const sent: SentRecord[] = []
    const handle = run(db, { sent })
    // 予定通知の世帯の列挙（event_reminders の SELECT）だけを落とす
    handle.fake.failOn("event_reminders", "select", { message: "boom", code: "XX000" })
    await expect(handle.promise).rejects.toThrow()

    expect(sent.map((s) => s.target.endpoint)).toEqual(["https://fcm.googleapis.com/op"])
    // 列挙の失敗は握り潰さぬ（心拍に failed が残る）
    expect(db.notification_heartbeat[0]).toMatchObject({ sent_count: 1 })
    expect(Number(db.notification_heartbeat[0].failed_count)).toBeGreaterThanOrEqual(1)
  })

  it("要望の知らせが 1 件も無い周回は失敗を数えぬ（平穏を壊れと見せぬ）", async () => {
    const db = seed()
    const result = await run(db).promise
    expect(result).toMatchObject({ sent: 0, skipped: 0, failed: 0 })
  })
})
