/**
 * 配信キューを 1 周回す（B-3 の本体 ＋ B-5 の毎朝ダイジェスト）。
 *
 * 呼ぶのは `src/app/api/cron/notify/route.ts` ただ 1 つで、そこは
 * `NOTIFY_CRON_SECRET` を検証した**後**に service role クライアントを渡す
 * （`admin.ts` の契約 3）。RLS が効かぬゆえ、**世帯スコープはこのコードが担う** —
 * 全クエリに `household_id` / `user_id` の明示 `.eq()` / `.in()` を置くこと。
 * `syncAllHouseholds` が同型じゃ。
 *
 * ## 1 周の流れ
 * ```
 * 1. 対象世帯を集める（期限の来た通知設定 ∪ 積み残しの配信行 ∪ まとめの利用者）
 * 2. 世帯ごとに:
 *    a. 期限切れ掃除   scheduled_at < now - GRACE → skipped 'expired'
 *    b. 展開           通知設定 × 世帯の購読 → 配信行を INSERT ... DO NOTHING
 *                      まとめ（B-5）も**同じ形で**その日のぶんを 1 行立てる
 *    c. 裁定と送信     未送信行を今の DB と突き合わせ、claim してから送る
 * 3. 心拍を必ず書く（finally）
 * ```
 *
 * ## なぜ「積み残し」も世帯集合に入れるか
 * 期限の来た通知設定だけで世帯を選ぶと、**静かな世帯の再試行行が永久に拾われぬ**。
 * 送信に失敗した行は次の実行で拾い直す約束（キューにした理由の 1 つ）ゆえ、
 * 積み残しを持つ世帯は必ず回る側に入れる。期限切れ掃除も同じ理由で要る。
 *
 * ## ⚠️ ダイジェストを「窓一致」で選ぶな（B-5 の核）
 * 「`digest_time` が今の 5 分窓に入る利用者」で展開すると、**cron が 1 回落ちた
 * その日のダイジェストは永久に来ぬ** —— キューにした甲斐（取りこぼしは次の実行が
 * 拾う）が、まとめだけ成立しなくなる。ゆえに予定通知と**同じ形**にする:
 *   * 展開は「その JST 暦日ぶんの行を立てる」だけ（時刻が来ておるかは見ぬ）
 *   * 送るか否かは `scheduled_at <= now()` と grace が決める
 * すなわち JST 0 時を跨いだ最初の実行がその日の行を立て、以降の実行は
 * `ON CONFLICT DO NOTHING` に吸われる。**上限側の窓（「あと N 分以内なら作る」）を
 * 足すな** —— それは窓一致に別の名を付けただけじゃ。
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { todayJstString } from "@/lib/utils/date-jst"
import { parseDigestTimeHm } from "@/lib/domain/notification-digest"
import {
  DELIVERY_GRACE_MS,
  buildEventNotification,
  classifyPendingDelivery,
  dedupeDayOf,
  graceStartIso,
  isEventPending,
  type EventSnapshot,
  type NotificationPayload,
  type PendingDelivery,
  type ReminderSnapshot,
} from "./delivery-rules"
import {
  buildDigestNotification,
  classifyPendingDigest,
  digestScheduledAtForDay,
  type DigestEventSnapshot,
} from "./digest-rules"
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
/**
 * ダイジェストが読む予定の列。
 *
 * ⚠️ **`memo` を足すな。** ロック画面は施錠されたままでも中身を映すゆえ、メモを
 * 通知へ載せると通知そのものが漏洩経路になる。載せぬことを注記だけで守るのは
 * 弱いゆえ、`select` からも `DigestEventSnapshot` 型からも外してある。
 */
const DIGEST_EVENT_COLUMNS = "title, is_all_day, start_date, start_at"

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
      ...(await collectDigestHouseholdIds(supabase)),
    ]),
  ]
}

/**
 * 毎朝のまとめを有効にしておる利用者の世帯（B-5）。
 *
 * ⚠️ **時刻で絞らぬ**。「今まさに digest_time の窓に入っておる利用者」で選ぶと、
 * cron が 1 回落ちた日のダイジェストが永久に消える（この機能を窓一致で書くなという
 * 掟そのものじゃ）。有効な利用者の世帯は**毎回**回る側に入れ、その日ぶんの行が
 * 既に在るかは `ON CONFLICT DO NOTHING` に判じさせる。
 */
async function collectDigestHouseholdIds(supabase: Client): Promise<string[]> {
  const { data: prefs, error: prefsError } = await supabase
    .from("notification_preferences")
    .select("user_id")
    .not("digest_time", "is", null)
  if (prefsError) {
    logSupabaseError(
      "cron-notify",
      "対象世帯（まとめの設定）の取得に失敗",
      prefsError,
    )
    throw new Error("[cron-notify] 対象世帯の取得に失敗しました")
  }
  const userIds = (prefs ?? []).map((row) => row.user_id)
  if (userIds.length === 0) return []

  const { data: members, error: memberError } = await supabase
    .from("profiles")
    .select("household_id")
    .in("id", userIds)
  if (memberError) {
    logSupabaseError(
      "cron-notify",
      "対象世帯（まとめの利用者）の取得に失敗",
      memberError,
    )
    throw new Error("[cron-notify] 対象世帯の取得に失敗しました")
  }
  // ⚠️ `profiles.household_id` は **nullable** じゃ（未承認・世帯離脱の利用者は
  // NULL）。落とさねば `.eq("household_id", null)` の空回りが世帯 1 件ぶんの
  // 無駄な周回として毎回走る。
  return (members ?? [])
    .map((row) => row.household_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
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

  // まとめの時刻は**利用者ごと**（世帯ではない）。展開にも裁定にも要るゆえ
  // 1 度だけ引いて回す。
  const digestTimes = await loadDigestTimes(supabase, subscriptions)

  // ── b. 展開 ───────────────────────────────────────────────
  await expandDueReminders(
    supabase,
    householdId,
    now,
    subscriptions,
    counters,
  )
  await expandDigests(
    supabase,
    householdId,
    now,
    subscriptions,
    digestTimes,
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
    digestTimes,
    counters,
  )
}

/**
 * 世帯の購読者について、今の `digest_time` を引く（無効・不正な値は持たぬ）。
 *
 * 購読を持たぬ利用者は問い合わせぬ —— 送り先が無い者の設定を引いても使い道が
 * 無いゆえ。返り値は `user_id → "HH:MM"`（**JST 壁時計**。`notification-digest.ts`
 * の契約を見よ）。
 */
async function loadDigestTimes(
  supabase: Client,
  subscriptions: SubscriptionRow[],
): Promise<Map<string, string>> {
  const userIds = [...new Set(subscriptions.map((row) => row.user_id))]
  if (userIds.length === 0) return new Map()

  const { data, error } = await supabase
    .from("notification_preferences")
    .select("user_id, digest_time")
    .in("user_id", userIds)
  if (error) {
    logSupabaseError("cron-notify", "まとめの設定の取得に失敗", error)
    throw new Error("[cron-notify] まとめの設定の取得に失敗しました")
  }

  const times = new Map<string, string>()
  for (const row of data ?? []) {
    // Postgres の TIME は "07:00:00" で返る。**正規化を省くな** —— 素の値を
    // 持ち回すと画面（"07:00"）と食い違い、変更の検出（reaim）が毎回発火して
    // 送信が永久に先送りされる。
    const hm = parseDigestTimeHm(row.digest_time)
    if (hm !== null) times.set(row.user_id, hm)
  }
  return times
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

/**
 * その JST 暦日の予定（ダイジェスト用）。
 *
 * 「今日の予定」は**またがる予定も含む**（`start_date <= day <= end_date`）。
 * 索引 `idx_calendar_events_household_range` がこの形に合わせて在る。
 */
async function loadDigestEvents(
  supabase: Client,
  householdId: string,
  day: string,
): Promise<DigestEventSnapshot[]> {
  const { data, error } = await supabase
    .from("calendar_events")
    .select(DIGEST_EVENT_COLUMNS)
    .eq("household_id", householdId)
    .lte("start_date", day)
    .gte("end_date", day)
  if (error) {
    logSupabaseError("cron-notify", "まとめ対象の予定の取得に失敗", error, {
      householdId,
    })
    throw new Error("[cron-notify] まとめ対象の予定の取得に失敗しました")
  }
  return (data ?? []) as unknown as DigestEventSnapshot[]
}

/**
 * 毎朝のまとめ（B-5）を、その JST 暦日ぶん 1 行だけ立てる。
 *
 * ## この関数が守っておる 4 つのこと
 *
 * 1. **窓一致にせぬ**。時刻が来たかは一切見ず、「その日の行が在るか」だけを
 *    `ON CONFLICT DO NOTHING` に判じさせる。ゆえに JST 0 時を跨いだ最初の実行が
 *    行を立て、cron が digest_time の瞬間に落ちても行は既に在る ＝ 次の実行が
 *    `scheduled_at <= now()` で拾う（catch-up が予定通知と共用になる）。
 * 2. **0 件の日は行を作らぬ**。空のまとめは通知の価値を薄め、Safari では
 *    権限そのものを失わせる。
 * 3. **望みの無い行を作らぬ**。grace を過ぎた時刻（cron が何時間も止まった後の
 *    復帰）は、作れば即 `expired` になるだけじゃ。予定通知の展開が
 *    `remind_at > graceStart` で締めておるのと同じ**下限**を置く
 *    （⚠️ 上限を足せば窓一致に戻る。足すな）。
 * 4. **既に立っておる行の狙いを毎回揃える**（{@link realignDigestAims}）。
 *    `ON CONFLICT DO NOTHING` は行を**触らぬ**ゆえ、設定が変わっても upsert では
 *    狙いが動かぬ。裁定側（`classifyPendingDigest` の reaim）だけでは
 *    **前方向（早める）の変更を救えぬ** —— 理由は下の関数に書いた。
 */
async function expandDigests(
  supabase: Client,
  householdId: string,
  now: Date,
  subscriptions: SubscriptionRow[],
  digestTimes: Map<string, string>,
  counters: Counters,
): Promise<void> {
  if (digestTimes.size === 0) return
  const targets = subscriptions.filter((row) => digestTimes.has(row.user_id))
  if (targets.length === 0) return

  // dedupe_day も scheduled_at の起点も**JST 暦日**じゃ（UTC で取ると 9 時間ぶん
  // 別の日の行を立てる）。
  const day = todayJstString(now)
  const graceStartMs = now.getTime() - DELIVERY_GRACE_MS

  // 「今の設定が指す狙い」を利用者ぶん求める。**望みの在るものだけ**を残す
  // （上の 3 と同じ下限。行の作成と付け替えで別の物差しを使えば必ずずれる）。
  const aims: { subscriptionId: string; scheduledAt: string }[] = []
  for (const subscription of targets) {
    const time = digestTimes.get(subscription.user_id) as string
    const scheduledAt = digestScheduledAtForDay(day, time)
    if (scheduledAt === null) continue
    const scheduledMs = Date.parse(scheduledAt)
    if (Number.isNaN(scheduledMs) || scheduledMs <= graceStartMs) continue
    aims.push({ subscriptionId: subscription.id, scheduledAt })
  }
  if (aims.length === 0) return

  // ⚠️ **予定の件数を見る前に付け替える。** 予定が 0 件の日は下で return するが、
  // 狙いだけは今の設定に揃えておく —— 日中に予定が入り直したとき、行が旧い狙いの
  // まま眠っておれば前方向の変更がそこで死ぬ。
  await realignDigestAims(supabase, householdId, day, aims)

  const events = await loadDigestEvents(supabase, householdId, day)
  if (events.length === 0) return

  const rows = aims.map((aim) => ({
    household_id: householdId,
    kind: "digest",
    // ⚠️ **明示的に null を置く。** 冪等キーは
    // `UNIQUE NULLS NOT DISTINCT (kind, event_key, subscription_key, dedupe_day)`
    // ゆえ、この NULL 同士が衝突することが「1 日 1 通」を成り立たせておる。
    event_key: null,
    subscription_id: aim.subscriptionId,
    subscription_key: aim.subscriptionId,
    dedupe_day: day,
    scheduled_at: aim.scheduledAt,
  }))
  // （`aims` が空なら上で返しておるゆえ、ここに 0 行の枝は無い。）

  const { error: insertError } = await supabase
    .from("notification_deliveries")
    .upsert(rows, {
      onConflict: "kind,event_key,subscription_key,dedupe_day",
      ignoreDuplicates: true,
    })
  if (insertError) {
    logSupabaseError("cron-notify", "まとめの配信行の作成に失敗", insertError, {
      householdId,
    })
    throw new Error("[cron-notify] まとめの配信行の作成に失敗しました")
  }
  counters.scheduled += rows.length
}

/**
 * ★ その日の**未終端**のダイジェスト行の狙いを、今の設定へ揃える。
 *
 * ## なぜ裁定側の reaim だけでは足りぬのか（前方向の変更が消える機構）
 * 裁定（`processPending`）は `scheduled_at <= now()` で行を拾う。ゆえに主が同じ日の
 * うちに時刻を**早めた**とき、行は旧い（遅い）狙いを持ったまま**裁定の視界に
 * 入らぬ**:
 *   1. 新しい時刻（06:30）が来ても行は選ばれぬ → その時刻には鳴らぬ
 *   2. 旧い時刻（07:00）が来て初めて `classifyPendingDigest` が reaim するが、
 *      そのとき新しい時刻は必ず過去 → 狙いは過去へ動く
 *   3. 次の実行の期限切れ掃除が `scheduled_at < now-GRACE` で `expired` にする
 * → **その日のまとめは新旧どちらの時刻にも来ぬ**。しかも冪等キー
 * （kind, event_key, subscription_key, dedupe_day）は終端行が握ったままゆえ、
 * 同じ日に何度設定し直しても `DO NOTHING` に吸われて戻らぬ。選択肢は 30 分刻み
 * ゆえ、前方向の変更は**必ず** grace（15 分）より深く過去へ落ちる ＝ 例外ではなく
 * 既定の挙動じゃった。ここで「時刻が来る前に」付け替えることで、あとは通常の
 * 送信経路（`scheduled_at <= now` → send）に乗る。
 *
 * ## ⚠️ 裁定側のクエリを未来の行まで広げて解くな
 * `.lte("scheduled_at", now)` を外せば reaim は撃てるようになるが、**まだ時の
 * 来ておらぬ行が毎 tick 裁定へ流れ込む** —— 未来の行に対して裁定が返せる答えは
 * `wait` だけゆえ、引き直す意味が無い。「裁定＝時が来た行」という意味も失う。
 * 付け替えは展開の仕事じゃ。
 *
 * ## ⚠️ 望みの無い時刻へは付け替えぬ（この下限を消すな）
 * 呼び手が `aims` から grace 外の狙いを落としてある。付け替えてしまえばその行は
 * 次の掃除で `expired` になり、**行を殺すだけ**で誰も救われぬ。生かしておけば
 * 「05:00（もう過ぎた）に変え、思い直して 08:00 にした」日でも、後の付け替えで
 * その日のまとめはまだ届く。旧い狙いのまま鳴ってしまう心配は無い —
 * 旧い時刻が来た瞬間に `classifyPendingDigest` が reaim → 掃除が畳む（fail-closed）。
 *
 * 0 行は正常（狙いが既に合っておる・その日の行がまだ無い）ゆえ**行数は見ぬ**。
 * 失敗しても throw せぬ: 付け替えは次の tick が撃ち直せるが、ここで throw すると
 * 世帯の予定通知の送信まで 1 周ぶん止まる（裁定側の reaim と同じ扱いじゃ）。
 */
async function realignDigestAims(
  supabase: Client,
  householdId: string,
  day: string,
  aims: { subscriptionId: string; scheduledAt: string }[],
): Promise<void> {
  for (const aim of aims) {
    const { error } = await supabase
      .from("notification_deliveries")
      .update({ scheduled_at: aim.scheduledAt })
      .eq("household_id", householdId)
      .eq("kind", "digest")
      // 冪等キーと**同じ列**で絞る（subscription_id は失効で NULL になりうる）。
      .eq("subscription_key", aim.subscriptionId)
      .eq("dedupe_day", day)
      // 送った行・畳んだ行は歴史じゃ。触れば「いつ鳴らす予定だったか」が消える。
      .is("sent_at", null)
      .is("skipped_at", null)
      // 既に狙いが合っておる行は触らぬ（timestamptz ゆえ比較は瞬間で行われる）。
      .neq("scheduled_at", aim.scheduledAt)
      .select("id")
    if (error) {
      logSupabaseError("cron-notify", "まとめの狙いの付け替えに失敗", error, {
        householdId,
      })
    }
  }
}

async function processPending(
  supabase: Client,
  householdId: string,
  now: Date,
  vapid: VapidConfig,
  deps: DeliveryDeps,
  subscriptions: SubscriptionRow[],
  digestTimes: Map<string, string>,
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

  // ダイジェスト行（B-5）は**その日の予定の集合**を材料にする。行の dedupe_day が
  // そのまま対象日ゆえ、日ごとに 1 度だけ引く（通常は 1 日ぶんしか無い）。
  const digestEventsByDay = new Map<string, DigestEventSnapshot[]>()
  for (const day of new Set(
    pending.filter((row) => row.kind === "digest").map((row) => row.dedupe_day),
  )) {
    digestEventsByDay.set(day, await loadDigestEvents(supabase, householdId, day))
  }

  for (const row of pending) {
    const delivery = row as PendingDelivery
    // 未知の kind は触らぬ（allowlist）。将来 3 つ目の kind を足したとき、
    // 判断材料を持たぬまま送ってしまうより「据え置いて grace が畳む」方が安全じゃ。
    if (row.kind !== "event" && row.kind !== "digest") continue

    // ダイジェストの宛先が失われた行（購読が失効し SET NULL になった等）は
    // **触らぬ**。送れる見込みは無いが、'rescheduled'（＝主が設定を消した）と
    // 記録するのは嘘じゃ。予定通知と同じく、期限切れ掃除が grace の後に
    // `expired` として畳む。
    const subscriptionOfRow = delivery.subscription_id
      ? subscriptionById.get(delivery.subscription_id)
      : undefined
    if (row.kind === "digest" && !subscriptionOfRow) continue

    const digestEvents = digestEventsByDay.get(delivery.dedupe_day) ?? []
    const decision =
      row.kind === "digest"
        ? classifyPendingDigest({
            delivery,
            // ⚠️ **展開時の値を持ち回さず、今の設定を引き直す。** 主が朝の時刻を
            // 07:00 → 08:00 へ変えた日に、07:00 の行をそのまま鳴らしては嘘になる。
            // しかも同じ冪等キーの行はもう作れぬゆえ、08:00 のぶんは永久に来ぬ。
            digestTime: subscriptionOfRow
              ? (digestTimes.get(subscriptionOfRow.user_id) ?? null)
              : null,
            eventCount: digestEvents.length,
            now,
          })
        : classifyPendingDelivery({
            delivery,
            reminder:
              delivery.event_key === null
                ? undefined
                : reminders.get(delivery.event_key),
            event:
              delivery.event_key === null
                ? undefined
                : events.get(delivery.event_key),
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

    // 本文の組み立て。`null` は「送る材料が無い」＝ 触らず据え置く
    // （classify が既に弾いておるが、型のためと二重の守りのために置く）。
    const payload = buildPayload(
      row.kind,
      delivery,
      events,
      digestEvents,
    )
    if (payload === null) continue

    await claimAndSend(
      supabase,
      delivery,
      payload,
      subscriptionById,
      nowIso,
      vapid,
      deps,
      counters,
      householdId,
    )
  }
}

/** 行の種別ごとに通知の中身を組む。送る材料が無ければ null。 */
function buildPayload(
  kind: string,
  delivery: PendingDelivery,
  events: Map<string, EventSnapshot>,
  digestEvents: DigestEventSnapshot[],
): NotificationPayload | null {
  if (kind === "digest") {
    return buildDigestNotification(delivery.dedupe_day, digestEvents)
  }
  const event =
    delivery.event_key === null ? undefined : events.get(delivery.event_key)
  return event ? buildEventNotification(event) : null
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
  /**
   * 送る中身。**予定通知とダイジェストで共有する** —— claim・410 の掃除・
   * 再試行の作法は種別に依らぬゆえ、ここで分岐を作らせぬ
   * （分ければ必ず片方だけが直る）。
   */
  payload: NotificationPayload,
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
    payload,
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
