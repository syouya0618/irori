import { computeNextFeeding, normalizeFeedingInterval } from "@/lib/domain/baby-feeding-interval"
import { formatJstTimeInput } from "@/lib/utils/date-jst"
import { isWithinGrace, type NotificationPayload } from "./delivery-rules"

export const FEEDING_REMINDER_OPTIONS = [5, 10, 15, 30] as const
export const FEEDING_REMINDER_DEFAULT = 15

export function isFeedingReminderMinutes(value: unknown): value is number {
  return typeof value === "number" && FEEDING_REMINDER_OPTIONS.some((m) => m === value)
}

/** 画面と同じ開始時刻の計算。配送が目安を過ぎたら送らない。 */
export function dueFeedingReminder(loggedAt: string, interval: number, lead: unknown, now: Date) {
  if (!isFeedingReminderMinutes(lead) || normalizeFeedingInterval(interval) !== interval ||
      !Number.isFinite(Date.parse(loggedAt)) || !Number.isFinite(now.getTime())) return null
  const { targetIso } = computeNextFeeding(loggedAt, interval, now)
  const targetMs = Date.parse(targetIso)
  const scheduledAt = new Date(targetMs - lead * 60_000).toISOString()
  if (!isWithinGrace(scheduledAt, now) || now.getTime() >= targetMs) return null
  return {
    targetIso, scheduledAt,
    // 圏外から戻った端末へ古い目安を雪崩れさせない。目安までの残時間も超えない。
    ttlSeconds: Math.max(1, Math.min(300, Math.floor((targetMs - now.getTime()) / 1000))),
  }
}

export function buildFeedingNotification(loggedAt: string, targetIso: string, childId?: string): NotificationPayload {
  return {
    title: "うちのログ",
    body: `次の授乳の目安 ${formatJstTimeInput(targetIso)}\n前回の授乳は${formatJstTimeInput(loggedAt)}開始です。そろそろ次の授乳時間です。赤ちゃんの様子に合わせてください。`,
    url: childId ? `/baby?child=${encodeURIComponent(childId)}` : "/baby",
    // 端末に残った前の授乳通知を置き換える（受理済みPushの取消しは保証できない）。
    tag: childId ? `feeding:${childId}` : "feeding",
  }
}
