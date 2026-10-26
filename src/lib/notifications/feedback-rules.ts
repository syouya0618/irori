/**
 * 要望の知らせ（feedback_notifications）の**判断規則**。副作用を持たぬ純関数だけを置く。
 *
 * 予定通知の `delivery-rules.ts` と同じ理由で独立させてある: 送る直前の問い直しを
 * `vi.useFakeTimers()` なしに 1 点ずつ撃てる形にするため。
 *
 * ⚠️ 中立モジュール。`"use client"` も `"use server"` も持たせてはならぬ。
 */

import {
  FEEDBACK_STATUS_LABELS,
  parseFeedbackStatus,
} from "@/lib/domain/feedback"
import { DELIVERY_GRACE_MS, type NotificationPayload } from "./delivery-rules"

/** skip の理由。**DB の chk_feedback_notifications_skip_reason と対で維持すること。** */
export type FeedbackSkipReason = "expired" | "gone" | "revoked" | "superseded"

/** キューの 1 行（判断に要る列だけ）。 */
export interface PendingFeedbackNotification {
  id: string
  event_id: string
  recipient_id: string
  audience: string
  subscription_id: string | null
  scheduled_at: string
}

/** 判断の材料になる履歴（DB の現在値）。 */
export interface FeedbackEventSnapshot {
  id: string
  feedback_id: string
  kind: string
  to_status: string | null
}

/** 受信者が**今**受け取ってよいかの材料。 */
export interface FeedbackRecipientSnapshot {
  isApproved: boolean
  householdId: string | null
  isOperator: boolean
}

export type FeedbackDecision =
  | { action: "send" }
  | { action: "wait" }
  | { action: "skip"; reason: FeedbackSkipReason }

/**
 * 積んだ時点の意図を、送る時点の真実と突き合わせる。
 *
 * 判断順（先に来たものが勝つ）:
 *   1. grace 切れ・壊れた時刻 → expired（遅れた知らせを雪崩れさせぬ。Safari の権限剥奪）
 *   2. 時刻がまだ来ておらぬ → wait
 *   3. 要望・履歴が消えた → revoked
 *   4. 受信者が承認を失った・世帯を離れた → revoked
 *   5. 宛先の資格が崩れた → revoked
 *      - operator 宛: 「新しい要望」の知らせで、受信者が**今も**運用者であること
 *      - submitter 宛: 状態変更・返信の知らせで、受信者が**その要望の投稿者**であること
 *   6. 状態変更の知らせで、要望の**今の状態**がその変更の行き先と違う → superseded
 *   7. それ以外 → send
 *
 * ⚠️ 5 を「積んだ時に確かめたから」と省くな。運用者を名簿から外した直後の知らせが
 * 外した相手へ飛ぶ（中身を載せぬとはいえ、要望が届いたことは伝わる）。
 *
 * ⚠️ 6 を省くな。「反映済み」を確定した直後に理由付きで差し戻すと、確定の知らせ
 * （「本番の irori に反映されました」）がまだ積まれたまま残る。送る直前に今の状態を
 * 見ねば、画面からは反映済みが消えておるのに端末には「反映されました」と出る
 * （未確認の段階で反映を告げるのと同じ嘘になる）。新しい方の知らせは別の行として送られる。
 */
export function classifyPendingFeedbackNotification(input: {
  row: PendingFeedbackNotification
  event: FeedbackEventSnapshot | undefined
  /** 要望の投稿者（要望が消えておれば undefined） */
  submitterId: string | undefined
  /** 要望の今の状態（要望が消えておれば undefined） */
  currentStatus: string | undefined
  recipient: FeedbackRecipientSnapshot | undefined
  now: Date
}): FeedbackDecision {
  const { row, event, submitterId, currentStatus, recipient, now } = input

  const scheduledMs = Date.parse(row.scheduled_at)
  if (Number.isNaN(scheduledMs)) return { action: "skip", reason: "expired" }
  if (scheduledMs <= now.getTime() - DELIVERY_GRACE_MS) {
    return { action: "skip", reason: "expired" }
  }
  if (scheduledMs > now.getTime()) return { action: "wait" }

  if (event === undefined || submitterId === undefined) {
    return { action: "skip", reason: "revoked" }
  }
  if (!recipient || !recipient.isApproved || recipient.householdId === null) {
    return { action: "skip", reason: "revoked" }
  }

  if (row.audience === "operator") {
    if (event.kind !== "submitted" || !recipient.isOperator) {
      return { action: "skip", reason: "revoked" }
    }
    return { action: "send" }
  }
  if (row.audience === "submitter") {
    if (event.kind === "submitted" || row.recipient_id !== submitterId) {
      return { action: "skip", reason: "revoked" }
    }
    // 状態変更の知らせは「今もその状態である」時だけ送る（返信だけの知らせは状態に依らぬ）。
    // 状態が読めぬ（undefined）時も送らぬ側へ倒す。
    if (event.kind === "status_changed" && currentStatus !== event.to_status) {
      return { action: "skip", reason: "superseded" }
    }
    return { action: "send" }
  }
  // 未知の宛先区分（CHECK が縛るゆえ起きぬはず）は送らぬ（fail-closed）。
  return { action: "skip", reason: "revoked" }
}

const FEEDBACK_NOTIFICATION_TITLE = "irori の要望・改善提案"

/**
 * 知らせの本文。
 *
 * ⚠️ **要望の題・本文・投稿者名を載せるな。** ロック画面は施錠されたままでも中身を映す
 * （ダイジェストが memo を載せぬのと同じ理由）。載せるのは「何が起きたか」と状態名だけ。
 * 中身はタップした先のアプリで、ログイン済みの本人だけが読む。
 *
 * 「反映されました」と書くのは **released への状態変更の時だけ**。DB は released への変更に
 * 本番確認の証拠を必ず伴わせる（chk_feedback_events_release）ゆえ、この 1 語は確認済みを意味する。
 * 送るのは要望が**今も** released の時だけ（`classifyPendingFeedbackNotification` の 6）。
 */
export function buildFeedbackNotification(
  event: FeedbackEventSnapshot,
  audience: "operator" | "submitter",
): NotificationPayload {
  const id = event.feedback_id
  const tag = `feedback:${id}`
  if (audience === "operator") {
    return {
      title: FEEDBACK_NOTIFICATION_TITLE,
      body: "新しい要望が届きました。受信箱で内容を確認してください",
      url: `/feedback/inbox/${id}`,
      tag,
    }
  }

  let body: string
  if (event.kind === "status_changed") {
    const status = parseFeedbackStatus(event.to_status)
    if (status === "released") {
      body = "お送りいただいた要望が、本番の irori に反映されました"
    } else if (status) {
      body = `お送りいただいた要望の対応状況が「${FEEDBACK_STATUS_LABELS[status]}」になりました`
    } else {
      body = "お送りいただいた要望の対応状況が更新されました"
    }
  } else {
    body = "お送りいただいた要望に返信が届きました"
  }
  return { title: FEEDBACK_NOTIFICATION_TITLE, body, url: `/feedback/${id}`, tag }
}
