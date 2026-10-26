/**
 * 要望の知らせ（feedback_notifications）を 1 周送る。`deliverDueNotifications` の
 * **別フェーズ**として cron（/api/cron/notify）から呼ばれる。
 *
 * ## なぜ notification_deliveries に相乗りせぬか
 * あちらの錨は**世帯**で、SELECT は世帯全員に開いておる。要望の知らせは受信者ごとで、
 * 運用者は投稿者と別の世帯に居りうる。ゆえに専用キュー（受信者 × 端末・API ロールには
 * deny-all）を持ち、ここで送る。積むのは要望の RPC（20261025200001）で、Server Action は
 * service role を一切使わぬ。
 *
 * ## 送信の作法は予定通知と共有する
 * claim（sent_at への条件付き UPDATE）→ allowlist → 送信 → 結果ごとの後始末、の順と
 * at-most-once の割り切りは `claimAndSend`（deliver.ts）と同じじゃ。購読側の後始末
 * （診断列・404/410 の購読削除）は deliver.ts の `settleSubscriptionAfterSend` を
 * **注入して**同じ実装を使う（分ければ必ず片方だけが直る）。`push_subscriptions` の秘密列を
 * 読む型の迂回も deliver.ts の 1 ファイルに閉じたまま、ここへは関数として渡す。
 *
 * ## service role ゆえ、スコープはこのコードが担う
 * RLS は効かぬ。行は id で引き、受信者の資格（承認・世帯・運用者・投稿者）は送る直前に
 * 引き直して `classifyPendingFeedbackNotification` に裁かせる。
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { isAllowedPushEndpoint } from "@/lib/domain/push-endpoint"
import { graceStartIso } from "./delivery-rules"
import {
  buildFeedbackNotification,
  classifyPendingFeedbackNotification,
  type FeedbackEventSnapshot,
  type FeedbackRecipientSnapshot,
  type FeedbackSkipReason,
  type PendingFeedbackNotification,
} from "./feedback-rules"
import {
  isProvenNotDelivered,
  type PushSendResult,
  type PushTarget,
  type VapidConfig,
} from "./send-push"

type Client = SupabaseClient<Database>

/** 送信に要る購読（秘密列を含む。service role でのみ読める）。 */
export interface FeedbackSubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  failure_count: number
}

export interface FeedbackPhaseCounters {
  sent: number
  skipped: number
  failed: number
  rejectedEndpoints: number
}

export interface FeedbackPhaseDeps {
  now: Date
  vapid: VapidConfig
  sendPush: (
    target: PushTarget,
    vapid: VapidConfig,
    payload: unknown,
  ) => Promise<PushSendResult>
  /** deliver.ts の型の迂回（`push_subscriptions` の秘密列を user_id で引く）。 */
  loadSubscriptions: (
    supabase: Client,
    userIds: string[],
  ) => Promise<{ rows: FeedbackSubscriptionRow[]; error: unknown }>
  /** deliver.ts の購読側の後始末（成功・失敗の診断、404/410 の購読削除）。 */
  settleSubscription: (
    supabase: Client,
    target: FeedbackSubscriptionRow,
    result: PushSendResult,
    nowIso: string,
    logContext: Record<string, unknown>,
  ) => Promise<void>
}

/** 1 周で裁く行の上限。超えた分は次の実行が拾う（キューにした甲斐）。 */
const FEEDBACK_BATCH_LIMIT = 200

const PENDING_COLUMNS =
  "id, event_id, recipient_id, audience, subscription_id, scheduled_at"

export async function deliverFeedbackNotifications(
  supabase: Client,
  deps: FeedbackPhaseDeps,
  counters: FeedbackPhaseCounters,
): Promise<void> {
  const nowIso = deps.now.toISOString()

  // ── a. 期限切れ掃除（送らずに畳む。予定通知と同じ grace）──────────────
  const { data: expired, error: expireError } = await supabase
    .from("feedback_notifications")
    .update({ skipped_at: nowIso, skip_reason: "expired" })
    .is("sent_at", null)
    .is("skipped_at", null)
    .lt("scheduled_at", graceStartIso(deps.now))
    .select("id")
  if (expireError) {
    logSupabaseError("cron-notify", "要望の知らせの期限切れ掃除に失敗", expireError)
    throw new Error("[cron-notify] 要望の知らせの期限切れ掃除に失敗しました")
  }
  counters.skipped += expired?.length ?? 0

  // ── b. 時の来た未送信行 ─────────────────────────────────────
  const { data: pendingData, error: pendingError } = await supabase
    .from("feedback_notifications")
    .select(PENDING_COLUMNS)
    .is("sent_at", null)
    .is("skipped_at", null)
    .lte("scheduled_at", nowIso)
    .order("scheduled_at")
    .limit(FEEDBACK_BATCH_LIMIT)
  if (pendingError) {
    logSupabaseError("cron-notify", "要望の知らせの未送信行の取得に失敗", pendingError)
    throw new Error("[cron-notify] 要望の知らせの未送信行の取得に失敗しました")
  }
  const pending = (pendingData ?? []) as PendingFeedbackNotification[]
  if (pending.length === 0) return

  // ── c. 判断の材料を今の DB から引き直す ─────────────────────────
  const events = await loadEvents(supabase, unique(pending.map((row) => row.event_id)))
  const items = await loadItems(
    supabase,
    unique([...events.values()].map((event) => event.feedback_id)),
  )
  const recipientIds = unique(pending.map((row) => row.recipient_id))
  const recipients = await loadRecipients(supabase, recipientIds)
  const { rows: subscriptionRows, error: subscriptionError } =
    await deps.loadSubscriptions(supabase, recipientIds)
  if (subscriptionError) {
    logSupabaseError(
      "cron-notify",
      "要望の知らせの購読の取得に失敗",
      subscriptionError as Parameters<typeof logSupabaseError>[2],
    )
    throw new Error("[cron-notify] 要望の知らせの購読の取得に失敗しました")
  }
  const subscriptionById = new Map(subscriptionRows.map((row) => [row.id, row]))

  // ── d. 裁定と送信 ─────────────────────────────────────────
  for (const row of pending) {
    const event = events.get(row.event_id)
    const item = event ? items.get(event.feedback_id) : undefined
    const decision = classifyPendingFeedbackNotification({
      row,
      event,
      submitterId: item?.submitterId,
      currentStatus: item?.status,
      recipient: recipients.get(row.recipient_id),
      now: deps.now,
    })
    if (decision.action === "wait") continue
    if (decision.action === "skip") {
      if (await markSkipped(supabase, row.id, nowIso, decision.reason)) {
        counters.skipped += 1
      }
      continue
    }

    // 宛先を失った行（購読の失効で SET NULL・取得の後に消えた）は触らぬ。
    // 送れる見込みは無いが 'revoked'（資格を失った）と書くのは嘘じゃ。grace の後に
    // 期限切れ掃除が expired で畳む（予定通知の宛先を失った行と同じ扱い）。
    const target = row.subscription_id
      ? subscriptionById.get(row.subscription_id)
      : undefined
    if (!target || !event) continue
    // 端末の持ち主が受信者でなくなった（共用端末の持ち主交代は行ごと付け替わるゆえ
    // 通常は起きぬ）。他人の端末へは送らぬ。
    if (target.user_id !== row.recipient_id) {
      if (await markSkipped(supabase, row.id, nowIso, "revoked")) counters.skipped += 1
      continue
    }
    // 状態変更の知らせは、送る**直前**にもう一度今の状態を確かめる。周回の頭で読んだ状態の
    // 後に運用者が差し戻しておれば（送信は 1 通あたり最大 10 秒かかりうる）、古い
    // 「反映されました」が飛ぶ。claim から送信までの隙間は at-most-once の設計上残るが、
    // 窓をこの 1 往復まで狭める。読めなければ今回は送らず、次の周回へ回す（fail-closed）。
    if (event.kind === "status_changed") {
      const freshness = await checkStatusStillCurrent(supabase, event)
      if (freshness === "unknown") continue
      if (freshness === "superseded") {
        if (await markSkipped(supabase, row.id, nowIso, "superseded")) counters.skipped += 1
        continue
      }
    }

    await claimAndSend(
      supabase,
      row,
      buildFeedbackNotification(event, row.audience === "operator" ? "operator" : "submitter"),
      target,
      nowIso,
      deps,
      counters,
    )
  }
}

/**
 * ★ claim してから送る（deliver.ts の `claimAndSend` と同じ作法）。
 *
 *   * allowlist 外の宛先は claim せず数えるだけ（P1-03。grace の後に expired で畳まれる）
 *   * claim は `sent_at IS NULL AND skipped_at IS NULL AND subscription_id IS NOT NULL` への
 *     条件付き UPDATE。0 行なら別プロセスが先に取った → 送らぬ
 *   * 2xx → accepted_at を立てる（**端末に表示されたことまでは意味せぬ**）
 *   * 404/410 → 行を gone で畳んでから購読を消す（順序は予定通知と同じ）
 *   * それ以外 → 「届いておらぬ」と証明できる失敗（status あり）だけ claim を解いて再送へ。
 *     証明の無い失敗は claim を握ったまま落とす（at-most-once。二度鳴らさぬ）
 */
async function claimAndSend(
  supabase: Client,
  row: PendingFeedbackNotification,
  payload: ReturnType<typeof buildFeedbackNotification>,
  target: FeedbackSubscriptionRow,
  nowIso: string,
  deps: FeedbackPhaseDeps,
  counters: FeedbackPhaseCounters,
): Promise<void> {
  const logContext = { notificationId: row.id, subscriptionId: target.id }

  if (!isAllowedPushEndpoint(target.endpoint)) {
    counters.rejectedEndpoints += 1
    // ⚠️ endpoint は出さぬ（不適合でも送信能力そのもの）。識別子だけ。
    console.error("[cron-notify] allowlist 外の宛先ゆえ要望の知らせを送らぬ", logContext)
    return
  }

  const { data: claimed, error: claimError } = await supabase
    .from("feedback_notifications")
    .update({ sent_at: nowIso })
    .eq("id", row.id)
    .is("sent_at", null)
    .is("skipped_at", null)
    .not("subscription_id", "is", null)
    .select("id")
  if (claimError) {
    logSupabaseError("cron-notify", "要望の知らせの claim に失敗", claimError, logContext)
    counters.failed += 1
    return
  }
  // `.update()` は 0 行でも error: null（既知の罠）。行数で判断する。
  if (!claimed || claimed.length === 0) return

  const result = await deps.sendPush(
    { endpoint: target.endpoint, p256dh: target.p256dh, auth: target.auth },
    deps.vapid,
    payload,
  )

  if (result.ok) {
    counters.sent += 1
    const { error } = await supabase
      .from("feedback_notifications")
      .update({ accepted_at: nowIso })
      .eq("id", row.id)
      .select("id")
    if (error) {
      // 受理の記録に失敗しても送信は済んでおる。運用者の画面は「結果不明」に倒れる
      // （届いたと偽る向きには倒れぬ）。
      logSupabaseError("cron-notify", "要望の知らせの受理の記録に失敗", error, logContext)
    }
  } else if (result.gone) {
    const { error } = await supabase
      .from("feedback_notifications")
      .update({ sent_at: null, skipped_at: nowIso, skip_reason: "gone" })
      .eq("id", row.id)
      .select("id")
    if (error) {
      logSupabaseError("cron-notify", "要望の知らせの 'gone' の記録に失敗", error, logContext)
    }
    counters.skipped += 1
  } else {
    const retryable = isProvenNotDelivered(result)
    if (retryable) {
      const { error } = await supabase
        .from("feedback_notifications")
        .update({ sent_at: null })
        .eq("id", row.id)
        .select("id")
      if (error) {
        logSupabaseError("cron-notify", "要望の知らせの claim の解放に失敗", error, logContext)
      }
    }
    counters.failed += 1
    // ⚠️ endpoint とペイロードは出さぬ。status と識別子だけ。
    console.error(
      retryable
        ? "[cron-notify] 要望の知らせの送信に失敗（次の実行で再試行）"
        : "[cron-notify] 要望の知らせの送信結果が不明ゆえ再送せぬ（at-most-once）",
      { ...logContext, status: result.status, message: result.message },
    )
  }

  await deps.settleSubscription(supabase, target, result, nowIso, logContext)
}

/** 状態変更の知らせが、要望の**今の**状態をまだ指しておるか（送る直前の読み直し）。 */
async function checkStatusStillCurrent(
  supabase: Client,
  event: FeedbackEventSnapshot,
): Promise<"current" | "superseded" | "unknown"> {
  const { data, error } = await supabase
    .from("feedback_items")
    .select("status")
    .eq("id", event.feedback_id)
    .maybeSingle()
  if (error) {
    logSupabaseError("cron-notify", "要望の状態の読み直しに失敗", error, {
      feedbackId: event.feedback_id,
    })
    return "unknown"
  }
  // 要望が消えておれば送らぬ（次の周回の裁定が revoked で畳む）。
  if (!data) return "unknown"
  return data.status === event.to_status ? "current" : "superseded"
}

async function markSkipped(
  supabase: Client,
  id: string,
  nowIso: string,
  reason: FeedbackSkipReason,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("feedback_notifications")
    .update({ skipped_at: nowIso, skip_reason: reason })
    .eq("id", id)
    .is("sent_at", null)
    .is("skipped_at", null)
    .select("id")
  if (error) {
    logSupabaseError("cron-notify", "要望の知らせの skip の記録に失敗", error, {
      notificationId: id,
      reason,
    })
    return false
  }
  return (data?.length ?? 0) > 0
}

async function loadEvents(
  supabase: Client,
  ids: string[],
): Promise<Map<string, FeedbackEventSnapshot>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from("feedback_events")
    .select("id, feedback_id, kind, to_status")
    .in("id", ids)
  if (error) {
    logSupabaseError("cron-notify", "要望の履歴の取得に失敗", error)
    throw new Error("[cron-notify] 要望の履歴の取得に失敗しました")
  }
  return new Map((data ?? []).map((row) => [row.id, row as FeedbackEventSnapshot]))
}

/**
 * 要望の投稿者と**今の状態**。状態は「差し戻した後の古い『反映されました』」を
 * 送らぬために要る（`classifyPendingFeedbackNotification` の 6）。題・本文は読まぬ。
 */
async function loadItems(
  supabase: Client,
  feedbackIds: string[],
): Promise<Map<string, { submitterId: string; status: string }>> {
  if (feedbackIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from("feedback_items")
    .select("id, submitter_id, status")
    .in("id", feedbackIds)
  if (error) {
    logSupabaseError("cron-notify", "要望の投稿者と状態の取得に失敗", error)
    throw new Error("[cron-notify] 要望の投稿者と状態の取得に失敗しました")
  }
  return new Map(
    (data ?? []).map((row) => [row.id, { submitterId: row.submitter_id, status: row.status }]),
  )
}

/**
 * 受信者の今の資格。承認・世帯は profiles、運用者は app_operators（service role だけが読める）。
 * profiles の行が無い受信者は Map に入らぬ ＝ 資格なし（fail-closed）。
 */
async function loadRecipients(
  supabase: Client,
  userIds: string[],
): Promise<Map<string, FeedbackRecipientSnapshot>> {
  if (userIds.length === 0) return new Map()
  const { data: profiles, error: profileError } = await supabase
    .from("profiles")
    .select("id, household_id, is_approved")
    .in("id", userIds)
  if (profileError) {
    logSupabaseError("cron-notify", "要望の知らせの受信者の取得に失敗", profileError)
    throw new Error("[cron-notify] 要望の知らせの受信者の取得に失敗しました")
  }
  const { data: operators, error: operatorError } = await supabase
    .from("app_operators")
    .select("user_id")
    .in("user_id", userIds)
  if (operatorError) {
    logSupabaseError("cron-notify", "運用者の名簿の取得に失敗", operatorError)
    throw new Error("[cron-notify] 運用者の名簿の取得に失敗しました")
  }
  const operatorIds = new Set((operators ?? []).map((row) => row.user_id))
  return new Map(
    (profiles ?? []).map((row) => [
      row.id,
      {
        // `true` 以外（null・想定外）は承認済みとみなさぬ。
        isApproved: row.is_approved === true,
        householdId: row.household_id ?? null,
        isOperator: operatorIds.has(row.id),
      },
    ]),
  )
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
