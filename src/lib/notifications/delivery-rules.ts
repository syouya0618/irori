/**
 * 配信キューの**判断規則**（B-3）。副作用を持たぬ純関数だけを置く。
 *
 * ここが独立したモジュールである理由は 2 つある:
 *
 * 1. **同じ述語が 2 箇所で要る**。「まだ始まっておらぬ予定か」は
 *    (a) 通知行を作るとき（展開）と (b) 作り置きの行を送る直前（守り）の
 *    両方で評価される。2 箇所に書けば必ずずれる — B-2 の
 *    `derive_event_remind_at()` を関数 1 本に閉じたのと同じ理由じゃ。
 * 2. **時刻境界は決定的にしか検証できぬ**。実際の送信経路を通さず
 *    `vi.useFakeTimers()` で 1 点を撃てる形にしておく。
 *
 * ⚠️ このファイルは Server Component / Server Action / cron のいずれからも
 * import されうる**中立モジュール**じゃ。`"use client"` も `"use server"` も
 * 持たせてはならぬ。
 */

import { toJstDateString, formatJstTimeInput } from "@/lib/utils/date-jst"
import { calendarUrlForDate } from "@/lib/domain/calendar-link"

/**
 * grace window。**この幅を超えて遅れた通知は送らずに捨てる。**
 *
 * 15 分なのは pg_cron の粒度（5 分）の 3 倍 — 2 回連続で取りこぼしても拾えて、
 * かつ「10 分前の通知」が予定開始より後に鳴るほどには広くない、という均衡じゃ。
 * 広げるときは `PENDING_START_GUARD` の意味も併せて考えること
 * （開始済み判定が無ければ、広い grace は「始まってから 10 分前です」を生む）。
 */
export const DELIVERY_GRACE_MS = 15 * 60 * 1000

/** skip の理由。**DB の chk_notification_deliveries_skip_reason と対で維持すること。** */
export type DeliverySkipReason =
  | "expired"
  | "event_started"
  | "gone"
  | "rescheduled"

/** grace window の下端（この時刻より古い予定通知は期限切れ）。 */
export function graceStartIso(now: Date): string {
  return new Date(now.getTime() - DELIVERY_GRACE_MS).toISOString()
}

/**
 * 予定がまだ始まっておらぬか。**展開と守りの両方がこれを呼ぶ。**
 *
 * ⚠️ `startAt === null`（終日予定）は**必ず true**（＝送る）でなければならぬ。
 * ここを「開始時刻が分かるものだけ送る」に変えると、終日予定と `prev_day_20` の
 * 通知が丸ごと沈黙する — しかも DB には行が残るゆえ「送ったつもり」に見える。
 */
export function isEventPending(startAt: string | null, now: Date): boolean {
  if (startAt === null) return true
  const t = Date.parse(startAt)
  // 壊れた値は fail-closed（送らぬ）。時刻の分からぬ予定に「10 分前です」とは言えぬ。
  if (Number.isNaN(t)) return false
  return t > now.getTime()
}

/** 予定通知が grace window の中に在るか（now-GRACE < t <= now）。 */
export function isWithinGrace(scheduledAt: string, now: Date): boolean {
  const t = Date.parse(scheduledAt)
  if (Number.isNaN(t)) return false
  const nowMs = now.getTime()
  return t <= nowMs && t > nowMs - DELIVERY_GRACE_MS
}

/**
 * 冪等キーに使う JST 暦日。
 *
 * ⚠️ **引数は scheduled_at（＝通知が鳴るべき時刻）であって「今」ではない。**
 * 「今」から取ると、23:58 の通知を 00:04 の実行が拾い直したときに別の日付になり、
 * UNIQUE をすり抜けて**同じ通知が 2 回鳴る**（migration の核 ④）。
 */
export function dedupeDayOf(scheduledAt: string): string {
  return toJstDateString(scheduledAt)
}

/** 配信キューの 1 行（判断に要る列だけ）。 */
export interface PendingDelivery {
  id: string
  scheduled_at: string
  dedupe_day: string
  event_key: string | null
  subscription_id: string | null
}

/** 判断の材料になる通知設定（DB の現在値）。 */
export interface ReminderSnapshot {
  event_uid: string
  remind_at: string
}

/** 判断の材料になる予定（DB の現在値）。 */
export interface EventSnapshot {
  event_uid: string
  title: string
  is_all_day: boolean
  start_date: string
  start_at: string | null
}

export type PendingDecision =
  /** 送ってよい。 */
  | { action: "send" }
  /** 今回は触らぬ（再照準の直後など、まだ時刻が来ておらぬ）。 */
  | { action: "wait" }
  /**
   * 同じ JST 日の中で予定が動いた。**行を作り直さず狙いだけ変える。**
   * 新しい行を作ろうとしても冪等キー（日付単位）が同じゆえ `DO NOTHING` に
   * 吸われる — その状態で旧行を skip すると、**その日の通知が永久に消える**。
   */
  | { action: "reaim"; scheduledAt: string }
  | { action: "skip"; reason: DeliverySkipReason }

/**
 * 作り置きの配信行を、**今の DB の姿**と突き合わせて裁定する。
 *
 * キューは「作った時点の意図」を持つが、送る時点の真実は別じゃ。予定は動くし、
 * 通知設定は消せるし、予定そのものが始まってしまう。ゆえに送る直前に必ず問い直す。
 *
 * 判断順（先に来たものが勝つ）:
 *   1. grace 切れ         → expired（送る価値が失われた。Safari の雪崩防止）
 *   2. 通知設定が無い     → rescheduled（主が「なし」に戻した／予定ごと消えた）
 *   3. 通知設定が別を指す → 同じ JST 日なら reaim・跨いだなら rescheduled
 *   4. 予定が無い         → rescheduled（本文を組み立てられぬ）
 *   5. 予定が始まった     → event_started
 *   6. 時刻がまだ来ておらぬ → wait
 *   7. それ以外           → send
 */
export function classifyPendingDelivery(input: {
  delivery: PendingDelivery
  reminder: ReminderSnapshot | undefined
  event: EventSnapshot | undefined
  now: Date
}): PendingDecision {
  const { delivery, reminder, event, now } = input

  const scheduledMs = Date.parse(delivery.scheduled_at)
  // 壊れた値は送らぬ（fail-closed）。allowlist に無い理由は作れぬゆえ expired を使う。
  if (Number.isNaN(scheduledMs)) return { action: "skip", reason: "expired" }
  if (scheduledMs <= now.getTime() - DELIVERY_GRACE_MS) {
    return { action: "skip", reason: "expired" }
  }

  if (reminder === undefined) return { action: "skip", reason: "rescheduled" }

  const remindMs = Date.parse(reminder.remind_at)
  if (Number.isNaN(remindMs)) return { action: "skip", reason: "rescheduled" }

  // ⚠️ **文字列比較で済ませるな。** DB が返す timestamptz の表記
  // （"2026-08-15T00:50:00+00:00"）と我々が書いた ISO（"...Z"）は同じ瞬間でも
  // 別の文字列じゃ。素朴に `!==` すると毎回「動いた」と誤判定して全通知が
  // reaim/rescheduled へ落ち、**1 通も鳴らぬ**。
  if (remindMs !== scheduledMs) {
    const nextIso = new Date(remindMs).toISOString()
    return dedupeDayOf(nextIso) === delivery.dedupe_day
      ? { action: "reaim", scheduledAt: nextIso }
      : // 日を跨いだ移動は冪等キーが変わる＝新しい行を作れる。旧行は畳んでよい。
        { action: "skip", reason: "rescheduled" }
  }

  if (event === undefined) return { action: "skip", reason: "rescheduled" }
  if (!isEventPending(event.start_at, now)) {
    return { action: "skip", reason: "event_started" }
  }
  if (scheduledMs > now.getTime()) return { action: "wait" }

  return { action: "send" }
}

/** push のペイロード（`public/sw.js` の `parsePushPayload` が読む形）。 */
export interface NotificationPayload {
  title: string
  body: string
  url: string
  tag: string
}

/** "2026-08-15" → "8月15日"（`new Date('YYYY-MM-DD')` の UTC 罠を踏まぬ）。 */
function formatYmdLabel(ymd: string): string {
  const [, m, d] = ymd.split("-")
  // 先頭 0 を落とす（"08" → 8）。数値化できねば素の値を返す（表示は止めぬ）。
  const month = Number(m)
  const day = Number(d)
  if (Number.isNaN(month) || Number.isNaN(day)) return ymd
  return `${month}月${day}日`
}

/**
 * 予定通知の本文を組み立てる。
 *
 * **日付を必ず入れる**のが要点じゃ。`prev_day_20` は前日に鳴るゆえ、時刻だけだと
 * 「今日の 20 時の予定」と読める。時刻は `formatJstTimeInput`（h23 固定）で取る —
 * `formatTimeJst` は ICU 既定ゆえ深夜 0 時を "24:00" と出しうる（CLAUDE.md の既知の罠）。
 *
 * `tag` は端末側で同じ通知を畳ませるための鍵。万一同じ行が 2 度届いても
 * ロック画面に 2 つ積まれぬ最後の受け皿じゃ（本命は DB の UNIQUE と claim）。
 *
 * `url` に**予定の開始日を載せる**（B-6）。素の `/calendar` だと `prev_day_20` は
 * 前日に鳴るゆえ、叩いた主は**翌日の予定を報されながら今日**を開く。日付は
 * 本文が既に語っておるのに画面が違う日を出す ＝ 通知が嘘に見える。
 */
export function buildEventNotification(event: EventSnapshot): NotificationPayload {
  const when =
    event.is_all_day || event.start_at === null
      ? `${formatYmdLabel(event.start_date)} 終日`
      : `${formatYmdLabel(event.start_date)} ${formatJstTimeInput(event.start_at)} 開始`

  return {
    title: event.title,
    body: when,
    url: calendarUrlForDate(event.start_date),
    tag: `event:${event.event_uid}`,
  }
}
