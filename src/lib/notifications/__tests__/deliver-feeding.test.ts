import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { deliverDueNotifications } from "../deliver"
import { createFakeNotifySupabase, emptyNotifyDb } from "./fake-notify-db"

const now = new Date("2026-10-29T21:15:00+09:00")
const vapid = { publicKey: "pub", privateKey: "priv", subject: "mailto:test@example.com" }
function setup() {
  const db = emptyNotifyDb()
  db.children.push({ id: "child1", household_id: "h1", feeding_interval_min: 180 })
  db.households.push({ id: "h1", feeding_interval_min: 180 })
  db.profiles.push({ id: "u1", household_id: "h1", is_approved: true, role: "member" })
  db.notification_preferences.push({ user_id: "u1", feeding_reminder_minutes: 15 })
  db.baby_logs.push({ id: "log1", child_id: "child1", household_id: "h1", log_type: "feeding", feeding_type: "bottle", logged_at: "2026-10-29T18:30:00+09:00" })
  db.push_subscriptions.push({ id: "sub1", user_id: "u1", endpoint: "https://fcm.googleapis.com/test", p256dh: "key", auth: "auth", failure_count: 0 })
  const fake = createFakeNotifySupabase(db)
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "enqueue_feeding_delivery") {
      const id = `delivery-${args.p_subscription_id}`
      db.notification_deliveries.push({ id, household_id: args.p_household_id, kind: "feeding", event_key: args.p_log_id,
        subscription_id: args.p_subscription_id, subscription_key: args.p_subscription_id,
        scheduled_at: args.p_scheduled_at, dedupe_day: "2026-10-29", sent_at: null, skipped_at: null, skip_reason: null })
      return { data: id, error: null }
    }
    const d = db.notification_deliveries.find((d) => d.id === args.p_delivery_id)
    if (d) d.sent_at = now.toISOString()
    return { data: true, error: null }
  })
  Object.assign(fake.client, { rpc })
  const sendPush = vi.fn(async () => ({ ok: true as const }))
  return { db, fake, rpc, sendPush, run: () => deliverDueNotifications(fake.client, { now: () => now, readVapid: () => vapid, sendPush }) }
}
beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => vi.restoreAllMocks())
describe("授乳通知の実配信経路（DBの認可/競合はpgTAPと実PostgreSQLで別途検証）", () => {
  it("現在のスナップショットを最終RPCへ渡し、その後だけ送る", async () => {
    const s = setup(); const result = await s.run()
    expect(result).toMatchObject({ sent: 1, failed: 0 })
    expect(s.rpc).toHaveBeenLastCalledWith("claim_feeding_delivery", {
      p_delivery_id: "delivery-sub1", p_logged_at: "2026-10-29T18:30:00+09:00", p_interval: 180, p_lead: 15,
      p_scheduled_at: "2026-10-29T12:15:00.000Z",
    })
    expect(s.sendPush).toHaveBeenCalledWith(expect.objectContaining({ endpoint: "https://fcm.googleapis.com/test" }), vapid,
      expect.objectContaining({ url: "/baby?child=child1", body: expect.stringContaining("21:30") }), { ttlSeconds: 300 })
  })
  it.each(["off", "no-subscription", "unapproved", "new-log", "only-pump"])("%sなら送らない", async (kind) => {
    const s = setup()
    if (kind === "off") s.db.notification_preferences[0].feeding_reminder_minutes = null
    if (kind === "no-subscription") s.db.push_subscriptions.length = 0
    if (kind === "unapproved") s.db.profiles[0].is_approved = false
    if (kind === "new-log") s.db.baby_logs.push({ ...s.db.baby_logs[0], id: "log2", logged_at: "2026-10-29T19:00:00+09:00" })
    if (kind === "only-pump") s.db.baby_logs[0].feeding_type = "pumped"
    expect((await s.run()).sent).toBe(0)
    expect(s.sendPush).not.toHaveBeenCalled()
  })
  it("父母のリードが違い、対象ユーザーの複数端末へだけ送る", async () => {
    const s = setup()
    s.db.profiles.push({ id: "u2", household_id: "h1", is_approved: true, role: "member" })
    s.db.notification_preferences.push({ user_id: "u2", feeding_reminder_minutes: 5 })
    s.db.push_subscriptions.push({ ...s.db.push_subscriptions[0], id: "sub2" }, { ...s.db.push_subscriptions[0], id: "sub3", user_id: "u2" })
    expect((await s.run()).sent).toBe(2)
    expect(s.rpc.mock.calls.filter(([name]) => name === "enqueue_feeding_delivery").map(([,a]) => a.p_subscription_id)).toEqual(["sub1", "sub2"])
  })
  it("別世帯の新しい記録は起点にも本文にも混ぜない", async () => {
    const s = setup()
    s.db.baby_logs.push({ ...s.db.baby_logs[0], household_id: "h2", id: "foreign", logged_at: "2026-10-29T21:00:00+09:00" })
    expect((await s.run()).sent).toBe(1)
    expect(s.rpc.mock.calls[0][1].p_log_id).toBe("log1")
  })
  it("兄弟の新しい授乳で別の子の通知を消さない", async () => {
    const s = setup()
    s.db.children.push({ id: "child2", household_id: "h1", feeding_interval_min: 180 })
    s.db.baby_logs.push({ ...s.db.baby_logs[0], child_id: "child2", id: "sibling-new", logged_at: "2026-10-29T20:00:00+09:00" })
    expect((await s.run()).sent).toBe(1)
    expect(s.rpc.mock.calls[0][1].p_log_id).toBe("log1")
  })
  it("最終RPCが設定変更/削除/世帯変更/重複claimを拒めば送らない", async () => {
    const s = setup(); const orig = s.rpc.getMockImplementation()!
    s.rpc.mockImplementation(async (name, args) => name === "claim_feeding_delivery" ? { data: false, error: null } : orig(name, args))
    expect((await s.run()).sent).toBe(0)
    expect(s.sendPush).not.toHaveBeenCalled()
  })
  it("不明な送信結果は再送しないclaimを維持し、購読を消さない", async () => {
    const s = setup()
    s.sendPush.mockResolvedValue({ ok: false, gone: false, status: null, message: "timeout" } as never)
    expect((await s.run()).failed).toBe(1)
    expect(s.db.notification_deliveries[0].sent_at).not.toBeNull()
    expect(s.db.push_subscriptions).toHaveLength(1)
  })
  it("feedingのRPC失敗を心拍へ残す", async () => {
    const s = setup(); s.rpc.mockResolvedValue({ data: null, error: { code: "XX000" } } as never)
    expect((await s.run()).failed).toBe(1)
    expect(s.db.notification_heartbeat[0].failed_count).toBe(1)
  })
})
