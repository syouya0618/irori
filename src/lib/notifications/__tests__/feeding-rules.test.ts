import { describe, expect, it } from "vitest"
import { dueFeedingReminder, buildFeedingNotification, isFeedingReminderMinutes } from "../feeding-rules"
import { findLastNursing } from "@/lib/domain/baby-feeding-interval"

const log = "2026-10-29T18:30:00+09:00"
const now = new Date("2026-10-29T21:15:00+09:00")
describe("授乳の通知目安", () => {
  it("18:30開始、180分、15分前は21:15（終了時刻を足さない）", () => {
    expect(dueFeedingReminder(log, 180, 15, now)).toEqual({
      scheduledAt: "2026-10-29T12:15:00.000Z", targetIso: "2026-10-29T12:30:00.000Z", ttlSeconds: 300,
    })
  })
  it("19:00の新しい記録で旧21:15はもう期限に達していない", () => {
    expect(dueFeedingReminder("2026-10-29T19:00:00+09:00", 180, 15, now)).toBeNull()
  })
  it("23:30開始は翌02:30目安、02:15通知", () => {
    const due = dueFeedingReminder("2026-10-29T23:30:00+09:00", 180, 15, new Date("2026-10-30T02:15:00+09:00"))
    expect(due?.targetIso).toBe("2026-10-29T17:30:00.000Z")
    expect(due?.scheduledAt).toBe("2026-10-29T17:15:00.000Z")
  })
  it.each([null, undefined, 0, 6, 14, 15.5, 60, NaN, "15"])("OFF/不正値 %s は送らない", (lead) => {
    expect(dueFeedingReminder(log, 180, lead, now)).toBeNull()
  })
  it.each([5, 10, 15, 30])("許可した %i 分前だけを受け付ける", (lead) => expect(isFeedingReminderMinutes(lead)).toBe(true))
  it("grace下端と目安以後を除き、TTLを残時間まで縮める", () => {
    expect(dueFeedingReminder(log, 180, 30, now)).toBeNull()
    expect(dueFeedingReminder(log, 180, 15, new Date("2026-10-29T21:30:00+09:00"))).toBeNull()
    expect(dueFeedingReminder(log, 180, 5, new Date("2026-10-29T21:29:30+09:00"))?.ttlSeconds).toBe(30)
  })
  it("間隔変更、リード変更、時刻編集へ追従する", () => {
    expect(dueFeedingReminder(log, 210, 15, now)).toBeNull()
    expect(dueFeedingReminder(log, 180, 5, now)).toBeNull()
    expect(dueFeedingReminder("2026-10-29T18:35:00+09:00", 180, 15, now)).toBeNull()
  })
  it.each(["bad", ""])("壊れた日時 %s は送らない", (at) => expect(dueFeedingReminder(at, 180, 15, now)).toBeNull())
  it("搾乳を挟んでも起点は変わらず、削除すると前の有効行へ戻る", () => {
    const logs = [
      { id: "old", log_type: "feeding" as const, feeding_type: "bottle" as const, logged_at: log },
      { id: "new", log_type: "feeding" as const, feeding_type: null, logged_at: "2026-10-29T19:00:00+09:00" },
      { id: "pump", log_type: "feeding" as const, feeding_type: "pumped" as const, logged_at: "2026-10-29T20:00:00+09:00" },
    ]
    expect(findLastNursing(logs)?.id).toBe("new")
    expect(findLastNursing(logs.filter((l) => l.id !== "new"))?.id).toBe("old")
  })
  it("ロック画面は絶対時刻・目安と開始時刻のみ、タップは/baby", () => {
    const payload = buildFeedingNotification(log, "2026-10-29T12:30:00Z")
    expect(payload).toMatchObject({ title: "うちのログ", url: "/baby", tag: "feeding" })
    expect(payload.body).toContain("次の授乳の目安 21:30")
    expect(payload.body).toContain("18:30開始")
    expect(payload.body).not.toContain("あと15分")
  })
})
