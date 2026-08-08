/**
 * 配信キューを 1 周回す（B-3 の本体）。
 *
 * 呼ぶのは `src/app/api/cron/notify/route.ts` ただ 1 つで、そこは
 * `NOTIFY_CRON_SECRET` を検証した**後**に service role クライアントを渡す
 * （`admin.ts` の契約 3）。RLS が効かぬゆえ、**世帯スコープはこのコードが担う** —
 * 全クエリに `household_id` / `user_id` の明示 `.eq()` / `.in()` を置くこと。
 * `syncAllHouseholds` が同型じゃ。
 *
 * ## 1 周の流れ
 * ```
 * 1. 対象世帯を集める（期限の来た通知設定 ∪ 積み残しの配信行）
 * 2. 世帯ごとに:
 *    a. 期限切れ掃除   scheduled_at < now - GRACE → skipped 'expired'
 *    b. 展開           通知設定 × 世帯の購読 → 配信行を INSERT ... DO NOTHING
 *    c. 裁定と送信     未送信行を今の DB と突き合わせ、claim してから送る
 * 3. 心拍を必ず書く（finally）
 * ```
 *
 * ## なぜ「積み残し」も世帯集合に入れるか
 * 期限の来た通知設定だけで世帯を選ぶと、**静かな世帯の再試行行が永久に拾われぬ**。
 * 送信に失敗した行は次の実行で拾い直す約束（キューにした理由の 1 つ）ゆえ、
 * 積み残しを持つ世帯は必ず回る側に入れる。期限切れ掃除も同じ理由で要る。
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  DELIVERY_GRACE_MS,
  buildEventNotification,
  classifyPendingDelivery,
  dedupeDayOf,
  graceStartIso,
  isEventPending,
  type EventSnapshot,
  type PendingDelivery,
  type ReminderSnapshot,
} from "./delivery-rules"
import {
  isProvenNotDelivered,
  readVapidConfig,
  sendPushNotification,
  type PushSendResult,
  type PushTarget,
  type VapidConfig,
} from "./send-push"

export interface DeliveryRunResult {
  ranAt: string
  /** 展開でキューへ差し出した行数（重複は UNIQUE が吸うゆえ、送信数とは一致せぬ）。 */
  scheduled: number
  sent: number
  skipped: number
  /**
   * 失敗の数。**「届かなかった通知の数」ではない** — 実行そのものが起てぬとき
   * （VAPID 未設定・世帯の列挙に失敗）も 1 と数える。0 のままにすると
   * 「壊れておる」と「送るものが無かった」が心拍の上で同じ顔になり、
   * この表の存在理由が消える。
   */
  failed: number
}

/** テストから差し替える境界（時刻と外向きの送信）。 */
export interface DeliveryDeps {
  now: () => Date
  readVapid: () => VapidConfig | null
  sendPush: (
    target: PushTarget,
    vapid: VapidConfig,
    payload: unknown,
  ) => Promise<PushSendResult>
}

interface SubscriptionRow {
  id: string
  user_id: string
  endpoint: string
  p256dh: string
  auth: string
  failure_count: number
}

/**
 * `push_subscriptions` の診断列（B-1 の migration が「配信ジョブ (B-3) が更新する」と
 * 明記しておる 3 列）。
 */
interface PushSubscriptionDiagnostics {
  last_success_at?: string | null
  last_failure_at?: string | null
  failure_count?: number
}

/**
 * ⚠️ **ここだけが `Database` 型を意図的に迂回する。理由を残す。**
 *
 * B-1 は `push_subscriptions` の `Row` から `endpoint / p256dh / auth` を、
 * `Insert / Update` から**全列**を外しておる（`database.ts` の注記）。それは
 * 「authenticated の経路が `select("*")` を書いて 42501 で落ちる」のを**型で**
 * 止めるための防御で、外してはならぬ。
 *
 * 一方この 3 列は service role でのみ読め、送信にはそれしか要らぬ。B-1 の注記も
 * 「送信で必要になるのは配信ジョブ（B-3・service role）だけ」と名指ししておる。
 * ゆえに**型を緩めるのではなく、この 1 ファイルの 2 関数へ迂回を封じ込める**。
 * grep するならこのコメントが目印じゃ。
 */
async function loadSubscriptionRows(
  supabase: Client,
  memberIds: string[],
): Promise<{ rows: SubscriptionRow[]; error: unknown }> {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .in("user_id", memberIds)
  return { rows: (data ?? []) as unknown as SubscriptionRow[], error }
}

/** 同上の迂回。診断列だけを service role として書く（引数は型で縛ってある）。 */
async function updateSubscriptionDiagnostics(
  supabase: Client,
  subscriptionId: string,
  patch: PushSubscriptionDiagnostics,
) {
  return supabase
    .from("push_subscriptions")
    .update(patch as unknown as Record<string, never>)
    .eq("id", subscriptionId)
}

interface Counters {
  scheduled: number
  sent: number
  skipped: number
  failed: number
}

type Client = SupabaseClient<Database>

/** `push_subscriptions` は `select("*")` が列 GRANT で落ちる。列は必ず明示する。 */
const SUBSCRIPTION_COLUMNS = "id, user_id, endpoint, p256dh, auth, failure_count"
const DELIVERY_COLUMNS =
  "id, kind, event_key, subscription_id, subscription_key, scheduled_at, dedupe_day"
const EVENT_COLUMNS = "event_uid, title, is_all_day, start_date, start_at"

export async function deliverDueNotifications(
  supabase: Client,
  overrides: Partial<DeliveryDeps> = {},
): Promise<DeliveryRunResult> {
  const deps: DeliveryDeps = {
    now: () => new Date(),
    readVapid: readVapidConfig,
    sendPush: sendPushNotification,
    ...overrides,
  }
  const now = deps.now()
  const counters: Counters = { scheduled: 0, sent: 0, skipped: 0, failed: 0 }
  // ⚠️ **`failed` の契約を機械で守るための旗じゃ。** 下の finally を見よ。
  let completed = false

  try {
    const vapid = deps.readVapid()
    if (!vapid) {
      // fail-closed。届けられぬと分かっておる行を積んでも、grace 切れで
      // skipped になるだけで害が増える。ここで止めて心拍と 500 で知らせる。
      counters.failed += 1
      console.error("[cron-notify] VAPID env が未設定のため配信を中止", {
        hasPublic: Boolean(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
        hasPrivate: Boolean(process.env.VAPID_PRIVATE_KEY),
        hasSubject: Boolean(process.env.VAPID_SUBJECT),
      })
      throw new Error("[cron-notify] VAPID env が未設定です")
    }

    const householdIds = await collectHouseholdIds(supabase, now)
    for (const householdId of householdIds) {
      try {
        await runHousehold(supabase, householdId, now, vapid, deps, counters)
      } catch (err) {
        // 1 世帯の失敗で残りを止めぬ（syncAllHouseholds と同じ扱い）。
        counters.failed += 1
        console.error("[cron-notify] 世帯の配信に失敗（他世帯は続行）", {
          householdId,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const result: DeliveryRunResult = {
      ranAt: now.toISOString(),
      ...counters,
    }
    completed = true
    return result
  } finally {
    // ⚠️ **finally で書く。** 途中で throw しても「走ったこと」だけは残さねば、
    // 停止した配信基盤と平穏な一日が画面の上で同じに見える。
    //
    // ⚠️ **だが `ran_at` だけを残すのでは足りぬ。** 完走せずに抜けたなら
    // `failed` を最低 1 にする — さもなくば「全面停止」が
    // `sent=skipped=failed=0` の心拍として書かれ続け、runbook の一次監視
    // （「ran_at が 10 分以上前なら止まっておる」）から**永久に平穏に見える**。
    // `DeliveryRunResult.failed` の docstring が明記しておる契約はこれじゃ。
    //
    // ⚠️ **throw する箇所を名指しで包むな。** 「世帯の列挙」だけを try/catch で
    // 包むのは allowlist であり、`readVapid()` 自身の例外や、この try に後から
    // 足される throw を素通しする。旗を立てるのは「完走した」ただ 1 箇所ゆえ、
    // 数え漏れは構造的に起こらぬ。VAPID 分岐が自前で +1 しておるのは意図の記録で、
    // ここの下駄（0 のときだけ 1 にする）とは二重に数えぬ。
    if (!completed && counters.failed === 0) counters.failed = 1
    await writeHeartbeat(supabase, now, counters)
  }
}

/**
 * 対象世帯を集める。
 *
 * 世帯 id の列挙だけは横断で引く（`syncAllHouseholds` と同じ形）。以降の実務は
 * 必ず 1 世帯ずつ `.eq("household_id", …)` を置いて回る — service role は RLS を
 * 通らぬゆえ、`.eq()` の抜けがそのまま世帯越境になる。
 */
async function collectHouseholdIds(supabase: Client, now: Date): Promise<string[]> {
  const nowIso = now.toISOString()
  const graceStart = graceStartIso(now)

  const { data: dueReminders, error: reminderError } = await supabase
    .from("event_reminders")
    .select("household_id")
    .lte("remind_at", nowIso)
    .gt("remind_at", graceStart)
  if (reminderError) {
    logSupabaseError("cron-notify", "対象世帯（通知設定）の取得に失敗", reminderError)
    throw new Error("[cron-notify] 対象世帯の取得に失敗しました")
  }

  const { data: pending, error: pendingError } = await supabase
    .from("notification_deliveries")
    .select("household_id")
    .is("sent_at", null)
    .is("skipped_at", null)
  if (pendingError) {
    logSupabaseError("cron-notify", "対象世帯（積み残し）の取得に失敗", pendingError)
    throw new Error("[cron-notify] 対象世帯の取得に失敗しました")
  }

  return [
    ...new Set([
      ...(dueReminders ?? []).map((row) => row.household_id),
      ...(pending ?? []).map((row) => row.household_id),
    ]),
  ]
}

async function runHousehold(
  supabase: Client,
  householdId: string,
  now: Date,
  vapid: VapidConfig,
  deps: DeliveryDeps,
  counters: Counters,
): Promise<void> {
  const nowIso = now.toISOString()
  const graceStart = graceStartIso(now)

  // ── a. 期限切れ掃除 ────────────────────────────────────────
  // 送らずに畳む。Safari は「受け取ったのに可視通知を出さぬ」ことを許さぬゆえ、
  // 遅れた通知を後からまとめて出すと**権限ごと失う**（sw.js の注記と同根）。
  const { data: expired, error: expireError } = await supabase
    .from("notification_deliveries")
    .update({ skipped_at: nowIso, skip_reason: "expired" })
    .eq("household_id", householdId)
    .is("sent_at", null)
    .is("skipped_at", null)
    .lt("scheduled_at", graceStart)
    // `.update()` は 0 行でも error: null（既知の罠）。行数は select で数える。
    .select("id")
  if (expireError) {
    logSupabaseError("cron-notify", "期限切れの掃除に失敗", expireError, {
      householdId,
    })
    throw new Error("[cron-notify] 期限切れの掃除に失敗しました")
  }
  counters.skipped += expired?.length ?? 0

  // ── 世帯の購読（展開にも送信にも要る）────────────────────
  // **profiles 経由で世帯を辿る**（B-1 の設計）。`push_subscriptions` は
  // household_id を持たぬ — 持たせると accept_invitation 等で世帯が動いた後に
  // 旧世帯の通知が届き続ける。`household_id IS NULL`（未承認・世帯離脱）の
  // ユーザーはこの `.eq()` に掛からず、自然に fail-closed になる。
  const subscriptions = await loadSubscriptions(supabase, householdId)

  // ── b. 展開 ───────────────────────────────────────────────
  await expandDueReminders(
    supabase,
    householdId,
    now,
    subscriptions,
    counters,
  )

  // ── c. 裁定と送信 ─────────────────────────────────────────
  await processPending(
    supabase,
    householdId,
    now,
    vapid,
    deps,
    subscriptions,
    counters,
  )
}

async function loadSubscriptions(
  supabase: Client,
  householdId: string,
): Promise<SubscriptionRow[]> {
  const { data: members, error: memberError } = await supabase
    .from("profiles")
    .select("id")
    .eq("household_id", householdId)
  if (memberError) {
    logSupabaseError("cron-notify", "世帯メンバーの取得に失敗", memberError, {
      householdId,
    })
    throw new Error("[cron-notify] 世帯メンバーの取得に失敗しました")
  }
  const memberIds = (members ?? []).map((row) => row.id)
  if (memberIds.length === 0) return []

  const { rows, error } = await loadSubscriptionRows(supabase, memberIds)
  if (error) {
    logSupabaseError(
      "cron-notify",
      "購読の取得に失敗",
      error as Parameters<typeof logSupabaseError>[2],
      { householdId },
    )
    throw new Error("[cron-notify] 購読の取得に失敗しました")
  }
  return rows
}

async function loadEvents(
  supabase: Client,
  householdId: string,
  keys: string[],
): Promise<Map<string, EventSnapshot>> {
  if (keys.length === 0) return new Map()
  const { data, error } = await supabase
    .from("calendar_events")
    .select(EVENT_COLUMNS)
    .eq("household_id", householdId)
    .in("event_uid", keys)
  if (error) {
    logSupabaseError("cron-notify", "予定の取得に失敗", error, { householdId })
    throw new Error("[cron-notify] 予定の取得に失敗しました")
  }
  return new Map(
    (data ?? []).map((row) => [row.event_uid, row as EventSnapshot]),
  )
}

/**
 * 期限の来た通知設定 × 世帯の購読 → 配信行。
 *
 * `ON CONFLICT DO NOTHING` ゆえ何度走らせても増えぬ（取りこぼしの catch-up が
 * 二重通知にならぬのはこの一点による）。冪等キーは
 * `(kind, event_key, subscription_key, dedupe_day)`。
 */
async function expandDueReminders(
  supabase: Client,
  householdId: string,
  now: Date,
  subscriptions: SubscriptionRow[],
  counters: Counters,
): Promise<void> {
  if (subscriptions.length === 0) return

  const nowIso = now.toISOString()
  const { data: due, error } = await supabase
    .from("event_reminders")
    .select("event_uid, remind_at")
    .eq("household_id", householdId)
    .lte("remind_at", nowIso)
    .gt("remind_at", graceStartIso(now))
  if (error) {
    logSupabaseError("cron-notify", "期限の来た通知設定の取得に失敗", error, {
      householdId,
    })
    throw new Error("[cron-notify] 通知設定の取得に失敗しました")
  }
  if (!due || due.length === 0) return

  const events = await loadEvents(
    supabase,
    householdId,
    due.map((row) => row.event_uid),
  )

  const rows = []
  for (const reminder of due) {
    const event = events.get(reminder.event_uid)
    // 予定が無い通知設定は**構造的に不活性**（本文を組み立てられぬ）。
    // 掃除はせぬ — 410 フル再同期の窓では全 google 予定が一時的に孤児に見えるゆえ、
    // ここで消すと主の通知設定が消し飛ぶ（B-2 の核 ③）。
    if (!event) continue
    // ⚠️ **これが無いと catch-up が「始まった後に 10 分前です」と鳴る。**
    if (!isEventPending(event.start_at, now)) continue

    for (const subscription of subscriptions) {
      rows.push({
        household_id: householdId,
        kind: "event",
        event_key: reminder.event_uid,
        subscription_id: subscription.id,
        // 冪等キーは**この不変コピー**を使う（migration の核 ③）。
        subscription_key: subscription.id,
        dedupe_day: dedupeDayOf(reminder.remind_at),
        scheduled_at: reminder.remind_at,
      })
    }
  }
  if (rows.length === 0) return

  const { error: insertError } = await supabase
    .from("notification_deliveries")
    .upsert(rows, {
      onConflict: "kind,event_key,subscription_key,dedupe_day",
      ignoreDuplicates: true,
    })
  if (insertError) {
    logSupabaseError("cron-notify", "配信行の作成に失敗", insertError, {
      householdId,
    })
    throw new Error("[cron-notify] 配信行の作成に失敗しました")
  }
  counters.scheduled += rows.length
}

async function processPending(
  supabase: Client,
  householdId: string,
  now: Date,
  vapid: VapidConfig,
  deps: DeliveryDeps,
  subscriptions: SubscriptionRow[],
  counters: Counters,
): Promise<void> {
  const nowIso = now.toISOString()
  const { data: pending, error } = await supabase
    .from("notification_deliveries")
    .select(DELIVERY_COLUMNS)
    .eq("household_id", householdId)
    .is("sent_at", null)
    .is("skipped_at", null)
    .lte("scheduled_at", nowIso)
    .order("scheduled_at")
  if (error) {
    logSupabaseError("cron-notify", "未送信行の取得に失敗", error, { householdId })
    throw new Error("[cron-notify] 未送信行の取得に失敗しました")
  }
  if (!pending || pending.length === 0) return

  const eventKeys = [
    ...new Set(
      pending
        .map((row) => row.event_key)
        .filter((key): key is string => key !== null),
    ),
  ]
  // ⚠️ **通知設定は「期限の来たもの」ではなく `event_key` で引き直す。**
  // 展開用の窓（remind_at <= now）で引いた集合を流用すると、予定が 2 分後へ
  // 動いた通知設定が「消えた」と見えて rescheduled になり、しかも同じ冪等キーの
  // 行はもう作れぬゆえ**その日の通知が永久に失われる**。
  const reminders = await loadReminders(supabase, householdId, eventKeys)
  const events = await loadEvents(supabase, householdId, eventKeys)
  const subscriptionById = new Map(subscriptions.map((row) => [row.id, row]))

  for (const row of pending) {
    const delivery = row as PendingDelivery
    // B-5 のダイジェスト行はこの経路では扱わぬ（判断材料が別物）。
    if (row.kind !== "event") continue

    const decision = classifyPendingDelivery({
      delivery,
      reminder:
        delivery.event_key === null
          ? undefined
          : reminders.get(delivery.event_key),
      event:
        delivery.event_key === null ? undefined : events.get(delivery.event_key),
      now,
    })

    if (decision.action === "wait") continue

    if (decision.action === "skip") {
      const marked = await markSkipped(
        supabase,
        delivery.id,
        nowIso,
        decision.reason,
      )
      if (marked) counters.skipped += 1
      continue
    }

    if (decision.action === "reaim") {
      // 行は作り直さず狙いだけ変える。dedupe_day は同じ JST 日ゆえ動かさぬ
      // （動かすと冪等キーが変わり、二重通知の窓が開く）。
      const { error: reaimError } = await supabase
        .from("notification_deliveries")
        .update({ scheduled_at: decision.scheduledAt })
        .eq("id", delivery.id)
        .is("sent_at", null)
        .is("skipped_at", null)
        .select("id")
      if (reaimError) {
        logSupabaseError("cron-notify", "配信時刻の付け替えに失敗", reaimError, {
          householdId,
          deliveryId: delivery.id,
        })
      }
      continue
    }

    const event = events.get(delivery.event_key as string)
    if (!event) continue // classify が既に弾いておるが型のために置く

    await claimAndSend(
      supabase,
      delivery,
      event,
      subscriptionById,
      nowIso,
      vapid,
      deps,
      counters,
      householdId,
    )
  }
}

async function loadReminders(
  supabase: Client,
  householdId: string,
  keys: string[],
): Promise<Map<string, ReminderSnapshot>> {
  if (keys.length === 0) return new Map()
  const { data, error } = await supabase
    .from("event_reminders")
    .select("event_uid, remind_at")
    .eq("household_id", householdId)
    .in("event_uid", keys)
  if (error) {
    logSupabaseError("cron-notify", "通知設定の引き直しに失敗", error, {
      householdId,
    })
    throw new Error("[cron-notify] 通知設定の引き直しに失敗しました")
  }
  return new Map(
    (data ?? []).map((row) => [row.event_uid, row as ReminderSnapshot]),
  )
}

async function markSkipped(
  supabase: Client,
  deliveryId: string,
  nowIso: string,
  reason: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("notification_deliveries")
    .update({ skipped_at: nowIso, skip_reason: reason })
    .eq("id", deliveryId)
    .is("sent_at", null)
    .is("skipped_at", null)
    .select("id")
  if (error) {
    logSupabaseError("cron-notify", "skip の記録に失敗", error, {
      deliveryId,
      reason,
    })
    return false
  }
  return (data?.length ?? 0) > 0
}

/**
 * ★ claim してから送る。
 *
 * 行の**生成**は UNIQUE で冪等になるが、**送信**は排他されておらぬ。cron の
 * 重複起動（Vercel も pg_cron も公式に「同じ実行を 2 回起こしうる」と認めておる）で
 * 2 プロセスが同じ未送信行を SELECT し、両方が送る。
 * `UPDATE ... WHERE sent_at IS NULL RETURNING *` で先に claim すれば、
 * **行ロックが直列化を担う** — 2 人目の UPDATE は 0 行になり、送らずに退く。
 *
 * ⚠️ **逐次テストでは claim の有無を弁別できぬ。** 2 接続を並行させぬ限り
 * 「直列化された」ではなく「直列化される**はず**」しか書けぬゆえ、
 * この防御は単体テストの守備範囲の外に在る（承知の上で採る）。
 * 単体テストが固定できるのは「0 行なら送らぬ」という**claim の読み方**だけじゃ。
 *
 * ⚠️ **at-most-once の割り切り。** `sent_at` を claim に兼用しておるゆえ、
 * claim 後・送信前にプロセスが落ちるとその 1 通は恒久喪失する。
 * 二重に鳴らすより 1 通落とす方を選んだ（Safari の権限剥奪と、主の信頼を守るため）。
 *
 * **同じ割り切りを、送信の失敗にも通す。** 落ちるのは異常時だけ、と思うてはならぬ
 * —— ソケットタイムアウトは「push サービスは受理したのに応答だけ落ちた」を
 * 含みうる**日常の**失敗じゃ。ゆえに claim を解いて再送するのは
 * {@link isProvenNotDelivered} が真を返す失敗（status が返っておる ＝ 明示的に
 * 拒まれた）に限り、証明の無い失敗は claim を握ったまま落とす。
 * 「gone でなければ再送」に戻せば、この関数が上で宣言しておる at-most-once は
 * 嘘になる（実装とコメントが食い違っておった状態がまさにそれじゃった）。
 */
async function claimAndSend(
  supabase: Client,
  delivery: PendingDelivery,
  event: EventSnapshot,
  subscriptionById: Map<string, SubscriptionRow>,
  nowIso: string,
  vapid: VapidConfig,
  deps: DeliveryDeps,
  counters: Counters,
  householdId: string,
): Promise<void> {
  const { data: claimed, error: claimError } = await supabase
    .from("notification_deliveries")
    .update({ sent_at: nowIso })
    .eq("id", delivery.id)
    .is("sent_at", null)
    .is("skipped_at", null)
    // 購読が失効した行（SET NULL で宛先を失った行）は claim させぬ。
    .not("subscription_id", "is", null)
    .select("id")
  if (claimError) {
    logSupabaseError("cron-notify", "claim に失敗", claimError, {
      householdId,
      deliveryId: delivery.id,
    })
    counters.failed += 1
    return
  }
  // ⚠️ `.update()` は 0 行でも error: null（既知の罠）。**行数で判断する。**
  // 0 行 = 別プロセスが先に取った、または宛先を失った → 送らぬ。
  if (!claimed || claimed.length === 0) return

  const subscriptionId = delivery.subscription_id
  const target = subscriptionId ? subscriptionById.get(subscriptionId) : undefined
  if (!target) {
    // claim と読み込みの間に購読が消えた。claim を解いて次の実行へ委ねる。
    await releaseClaim(supabase, delivery.id)
    return
  }

  const result = await deps.sendPush(
    {
      endpoint: target.endpoint,
      p256dh: target.p256dh,
      auth: target.auth,
    },
    vapid,
    buildEventNotification(event),
  )

  if (result.ok) {
    counters.sent += 1
    const { error } = await updateSubscriptionDiagnostics(supabase, target.id, {
      last_success_at: nowIso,
      failure_count: 0,
    })
    if (error) {
      logSupabaseError("cron-notify", "購読の成功記録に失敗", error, {
        householdId,
      })
    }
    return
  }

  if (result.gone) {
    // 410 / 404 = push サービスが「この購読はもう無い」と宣言した。
    // **行を先に終端させてから購読を消す。** 逆順だと FK の SET NULL で
    // subscription_id が先に消え、どの端末が失効したのか追えなくなる
    // （subscription_key は残るゆえ完全には失わぬが、順序は素直な方に揃える）。
    const { error: markError } = await supabase
      .from("notification_deliveries")
      .update({ sent_at: null, skipped_at: nowIso, skip_reason: "gone" })
      .eq("id", delivery.id)
      .select("id")
    if (markError) {
      logSupabaseError("cron-notify", "'gone' の記録に失敗", markError, {
        householdId,
        deliveryId: delivery.id,
      })
    }
    const { error: deleteError } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("id", target.id)
      .select("id")
    if (deleteError) {
      logSupabaseError("cron-notify", "失効した購読の削除に失敗", deleteError, {
        householdId,
      })
    }
    counters.skipped += 1
    return
  }

  // 送信の失敗。**再送するかは「届いておらぬ」と証明できるかで決める**
  // （at-most-once。この関数の docstring が宣言しておる割り切りじゃ）。
  //   * status が返った ＝ push サービスが明示的に拒んだ ＝ 届いておらぬ証明が在る
  //     → claim を解いて次の実行へ回す
  //   * status が無い（ソケットタイムアウト等）＝ 受理されたのに応答だけ落ちた、が
  //     有りうる ＝ 証明が無い → **claim を握ったまま落とす**（再送せぬ）
  // ⚠️ 4xx を一括で「恒久」と見なして購読を消してはならぬ。401/403 は VAPID の
  // 設定ミスで全端末に一斉に出るゆえ、破棄側に入れると 1 回の事故で購読が全滅する
  // （CLAUDE.md「破棄は狭く」）。ここで判じておるのは**行の再送**であって購読の
  // 生死ではない —— 購読を消すのは上の `gone` の枝ただ 1 つじゃ。
  const retryable = isProvenNotDelivered(result)
  if (retryable) await releaseClaim(supabase, delivery.id)
  counters.failed += 1
  // ⚠️ endpoint とペイロードは出さぬ。status と世帯だけ。
  //
  // ⚠️ **落とした側は `sent_at` が立ったまま残る。** 診断の「最終配信」
  // （MAX(sent_at)）は届いておらぬ瞬間を指しうる —— それを補うのがこの
  // `counters.failed` じゃ（設定カードが「直近の配信で N 件の失敗」と並べて出す）。
  // skip_reason を新設して分ける手も在るが、CHECK の migration が要るゆえ B-3 では
  // 採らぬ（据え置きの明示記録）。
  console.error(
    retryable
      ? "[cron-notify] 送信に失敗（次の実行で再試行）"
      : "[cron-notify] 送信の結果が不明ゆえ再送せぬ（at-most-once・この 1 通は落とす）",
    {
      householdId,
      status: result.status,
      message: result.message,
    },
  )

  // PostgREST に原子的な increment は無い。読んだ値からの +1 ゆえ、実行が重なれば
  // 数え落としうる（診断用の目安であって、破棄などの判断には一切使わぬ）。
  const { error: failureError } = await updateSubscriptionDiagnostics(
    supabase,
    target.id,
    {
      last_failure_at: nowIso,
      failure_count: (target.failure_count ?? 0) + 1,
    },
  )
  if (failureError) {
    logSupabaseError("cron-notify", "購読の失敗記録に失敗", failureError, {
      householdId,
    })
  }
}

/** claim を解いて未送信へ戻す（次の実行が拾い直す）。 */
async function releaseClaim(supabase: Client, deliveryId: string): Promise<void> {
  const { error } = await supabase
    .from("notification_deliveries")
    .update({ sent_at: null })
    .eq("id", deliveryId)
    .select("id")
  if (error) {
    logSupabaseError("cron-notify", "claim の解放に失敗", error, { deliveryId })
  }
}

/**
 * 心拍。**1 行しか無い**（id = 1 は CHECK が強制する）。
 *
 * ここが失敗しても実行結果は返す — 心拍は診断であって、配信の成否ではない。
 */
async function writeHeartbeat(
  supabase: Client,
  now: Date,
  counters: Counters,
): Promise<void> {
  const { error } = await supabase.from("notification_heartbeat").upsert(
    {
      id: 1,
      ran_at: now.toISOString(),
      sent_count: counters.sent,
      skipped_count: counters.skipped,
      failed_count: counters.failed,
    },
    { onConflict: "id" },
  )
  if (error) {
    logSupabaseError("cron-notify", "心拍の記録に失敗", error)
  }
}

/** grace window の幅を外へ見せる（runbook と route のコメントが参照する）。 */
export { DELIVERY_GRACE_MS }
