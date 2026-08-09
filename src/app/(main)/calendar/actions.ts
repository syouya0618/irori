"use server"

import { randomUUID } from "node:crypto"
import { revalidatePath } from "next/cache"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  validateCalendarEventInput,
  type CalendarRepeat,
} from "@/lib/domain/calendar-validation"
import { generateRecurrenceDates } from "@/lib/domain/calendar-recurrence"
import { latestIsoTimestamp } from "@/lib/domain/google-sync-signal"
import {
  isReminderChoice,
  reminderChoiceToPayload,
  type ReminderChoice,
} from "@/lib/domain/event-reminder"
import {
  daysBetweenYmd,
  shiftYmd,
  formatTimeJst,
  jstWallClockToIso,
} from "@/lib/utils/date-jst"

/**
 * `calendar_events` を書き換えた後に呼ぶ。**この表を読むページを全て**無効化する。
 *
 * `/calendar` だけを無効化しておると、`/meals` の「今日・明日の予定」カードが
 * 最大 10 秒古いまま残る。原因は 3 つが重なるためじゃ:
 *
 * 1. カードのデータは `meals/page.tsx` がサーバで `calendar_events` を引いて
 *    `initialEvents` として渡す = **`/meals` の RSC ペイロードに乗っておる**
 * 2. `next.config.ts` の `staleTimes.dynamic: 10` により、10 秒以内の
 *    クライアント遷移は取得済みペイロードを再利用する
 * 3. カードの復帰時 refetch は `visibilitychange`/`focus` 契機ゆえ、
 *    BottomNav の遷移（同一ドキュメント内）では**発火せず自己修復もせぬ**
 *
 * `revalidatePath` は Client Cache を purge する（同梱 docs
 * `04-functions/revalidatePath.md`: "This will purge the Client Cache, and
 * invalidate all cached data for revalidation on the next page visit."）ゆえ、
 * ここで `/meals` も無効化すれば `staleTimes` を迂回できる。
 *
 * **呼び出し側に 5 箇所へ素で書かせぬのは、6 箇所目を足す者が忘れるからじゃ。**
 * 表と読者の対応はこの 1 箇所に閉じておく（`calendar_events` を読むページを
 * 増やしたら、ここへ足せば全経路に効く）。
 */
function revalidateCalendarConsumers() {
  revalidatePath("/calendar")
  revalidatePath("/meals")
}

export interface CalendarEventActionInput {
  title: string
  memo?: string | null
  isAllDay: boolean
  startDate: string // YYYY-MM-DD (JST)
  endDate: string // YYYY-MM-DD (JST, inclusive)
  startAt?: string | null // ISO(timed のみ)
  endAt?: string | null
  /** 繰り返し種別。既定 "none"(単発)。update では無視される。 */
  repeat?: CalendarRepeat
  /** repeat !== "none" のときの終了日(YYYY-MM-DD, inclusive)。 */
  repeatUntil?: string | null
}

export async function createCalendarEvent(input: CalendarEventActionInput) {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, userId, householdId } = result.context

  // 繰り返しは materialize 展開して一括挿入する分岐へ。
  if (v.value.repeat !== "none" && v.value.repeatUntil) {
    return createCalendarEventSeries({
      supabase,
      userId,
      householdId,
      value: v.value,
      repeat: v.value.repeat,
      repeatUntil: v.value.repeatUntil,
    })
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      household_id: householdId,
      title: v.value.title,
      memo: v.value.memo,
      is_all_day: v.value.isAllDay,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
      start_at: v.value.startAt,
      end_at: v.value.endAt,
      source: "native",
      created_by: userId,
    })
    .select("id")
    .single()

  // error と「行なし」を分離: logSupabaseError は非 null の PostgrestError を要求
  // するため error! を渡さない。
  if (error) {
    logSupabaseError("calendar", "create failed", error, { userId, householdId })
    return { error: "予定の作成に失敗しました。もう一度お試しください。" }
  }
  if (!data) {
    console.error("[calendar] create returned no row", { userId, householdId })
    return { error: "予定の作成に失敗しました。もう一度お試しください。" }
  }

  revalidateCalendarConsumers()
  return { error: null, eventId: data.id }
}

/**
 * formatTimeJst の "HH:MM" を再構成に使う前の正規化。ICU の h24 既定環境では
 * JST 深夜0時台が "24:00"(や "24:mm")として出力されうる。これを
 * jstWallClockToIso にそのまま渡すと `Date("…T24:00:00+09:00")` が翌日 0 時へ
 * 正規化され(環境により Invalid Date)、意図の「当日 0 時」から日がずれる。
 * "24:" を "00:" に畳めば、抽出元 ISO の JST 日付が validation で開催日(startDate)
 * と一致保証されるため、この "00:" と開催日 date の組で正しい当日 0 時になる。
 */
function normalizeJstMidnight(timeHm: string): string {
  return timeHm.replace(/^24:/, "00:")
}

/**
 * 繰り返し予定を materialize(全開催日を物理行へ展開)して**単一の .insert([...])**
 * で原子的に一括挿入する。行ごとのループ insert は部分失敗で半端シリーズを残すため
 * 禁止(このヘルパは 1 回の insert のみ)。全行に共通の series_id を採番して束ねる。
 */
async function createCalendarEventSeries(args: {
  supabase: AuthContext["supabase"]
  userId: string
  householdId: string
  value: {
    title: string
    memo: string | null
    isAllDay: boolean
    startDate: string
    endDate: string
    startAt: string | null
    endAt: string | null
  }
  repeat: Exclude<CalendarRepeat, "none">
  repeatUntil: string
}) {
  const { supabase, userId, householdId, value, repeat, repeatUntil } = args

  let dates: string[]
  try {
    dates = generateRecurrenceDates(value.startDate, repeat, repeatUntil)
  } catch (e) {
    // 防御ガード(範囲外・生成数上限)は validation で弾かれるはずだが、二重防御。
    console.error("[calendar] recurrence generation failed", {
      message: e instanceof Error ? e.message : String(e),
      startDate: value.startDate,
      repeat,
      repeatUntil,
      householdId,
    })
    return { error: "繰り返し予定の生成に失敗しました。設定を確認してください。" }
  }

  // 複数日 span は開始↔終了の日数差を各開催日で維持する(daysBetweenYmd は
  // validation 済みの YYYY-MM-DD ゆえ null にならないが ?? 0 で保険)。
  const spanDays = daysBetweenYmd(value.startDate, value.endDate) ?? 0
  // 時刻付きは元の JST 壁時計時刻(HH:MM)を各開催日へ再適用して start_at/end_at を
  // 再構成する(既存フォーム→action の jstWallClockToIso 流儀に従う)。
  const startTime = value.startAt
    ? normalizeJstMidnight(formatTimeJst(value.startAt))
    : null
  const endTime = value.endAt
    ? normalizeJstMidnight(formatTimeJst(value.endAt))
    : null

  const seriesId = randomUUID()
  const rows = dates.map((date) => {
    const endDate = spanDays === 0 ? date : shiftYmd(date, spanDays)
    const startAt =
      !value.isAllDay && startTime ? jstWallClockToIso(date, startTime) : null
    const endAt =
      !value.isAllDay && endTime ? jstWallClockToIso(endDate, endTime) : null
    return {
      household_id: householdId,
      title: value.title,
      memo: value.memo,
      is_all_day: value.isAllDay,
      start_date: date,
      end_date: endDate,
      start_at: startAt,
      end_at: endAt,
      source: "native" as const,
      series_id: seriesId,
      created_by: userId,
    }
  })

  const { data, error } = await supabase
    .from("calendar_events")
    .insert(rows)
    .select("id")

  if (error) {
    logSupabaseError("calendar", "create series failed", error, {
      userId,
      householdId,
      count: rows.length,
    })
    return { error: "繰り返し予定の作成に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    console.error("[calendar] create series returned no rows", {
      userId,
      householdId,
    })
    return { error: "繰り返し予定の作成に失敗しました。もう一度お試しください。" }
  }

  revalidateCalendarConsumers()
  return { error: null, seriesId, count: data.length }
}

export async function updateCalendarEvent(
  input: CalendarEventActionInput & { id: string },
) {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // .update は 0 行でも error:null のため .select で行数を検証し silent fail を防ぐ。
  // source='native' 絞りで同期(google)行の改変も弾く(RLS でも弾かれるが二重防御)。
  const { data, error } = await supabase
    .from("calendar_events")
    .update({
      title: v.value.title,
      memo: v.value.memo,
      is_all_day: v.value.isAllDay,
      start_date: v.value.startDate,
      end_date: v.value.endDate,
      start_at: v.value.startAt,
      end_at: v.value.endAt,
    })
    .eq("id", input.id)
    .eq("household_id", householdId)
    .eq("source", "native")
    .select("id")

  if (error) {
    logSupabaseError("calendar", "update failed", error, { id: input.id, householdId })
    return { error: "予定の更新に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    return { error: "この予定は編集できません（同期予定か、権限がありません）。" }
  }

  revalidateCalendarConsumers()
  return { error: null }
}

export async function deleteCalendarEvent(id: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("id", id)
    .eq("household_id", householdId)
    .eq("source", "native")
    .select("id")

  if (error) {
    logSupabaseError("calendar", "delete failed", error, { id, householdId })
    return { error: "予定の削除に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    return { error: "この予定は削除できません（同期予定か、権限がありません）。" }
  }

  // 通知設定を掃除する。**予定を消した後**に撃つのが順序の要点じゃ（先に消すと
  // 予定の削除が失敗したとき通知だけ失われる）。native 行の event_uid は id そのもの。
  await cleanupRemindersFor(supabase, householdId, [id], "delete")

  revalidateCalendarConsumers()
  return { error: null }
}

/**
 * 繰り返しシリーズ全体を一括削除する。household_id / series_id / source='native'
 * の**三点 eq**で絞り(RLS の二重防御 + 他世帯・同期行の巻き込み防止)、.select("id")
 * で削除行数を検証する(0 行は silent fail を作らずエラー扱い)。
 */
export async function deleteCalendarEventSeries(seriesId: string) {
  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("calendar_events")
    .delete()
    .eq("household_id", householdId)
    .eq("series_id", seriesId)
    .eq("source", "native")
    .select("id")

  if (error) {
    logSupabaseError("calendar", "delete series failed", error, {
      seriesId,
      householdId,
    })
    return { error: "繰り返し予定の削除に失敗しました。もう一度お試しください。" }
  }
  if (!data || data.length === 0) {
    return { error: "この予定は削除できません（同期予定か、権限がありません）。" }
  }

  // native 行の event_uid = id。削除できた行だけを掃除対象にする。
  await cleanupRemindersFor(
    supabase,
    householdId,
    data.map((r) => r.id),
    "delete series",
  )

  revalidateCalendarConsumers()
  return { error: null, count: data.length }
}

// ============================================================
// 通知設定（event_reminders）
// ============================================================

/**
 * `.in()` に載せる event_uid の最大数。URL クエリに載るため小さく割る
 * （`google/sync.ts` の DELETE_CHUNK_SIZE と同じ配慮。UUID 36 文字 × 100 ≒ 4KB）。
 */
const REMINDER_UID_CHUNK_SIZE = 100

function chunkUids<T>(items: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += REMINDER_UID_CHUNK_SIZE) {
    out.push(items.slice(i, i + REMINDER_UID_CHUNK_SIZE))
  }
  return out
}

/**
 * 予定を削除した後に、その予定へ付いていた通知設定を掃除する。
 *
 * **「本物の削除」を知っておるのは削除した当人だけ**じゃ。`event_reminders` は
 * `calendar_events` へ FK を張っておらぬ（410 フル再同期が google 行を
 * DELETE→INSERT し直すため）ゆえ、配信ジョブ側で孤児を掃除させるわけにはいかぬ —
 * 410 の窓では**全ての google 予定が孤児に見える**ため、その 1 回で主の通知設定が
 * 消し飛ぶ。ゆえに掃除は削除経路が担う。
 *
 * 失敗しても**利用者の削除操作は成功として返す**。予定は既に消えており、
 * 残った孤児は構造的に不活性（配信は calendar_events を join せねば本文を
 * 組み立てられぬ）ゆえ、ここで巻き戻す先も止める理由も無い。ログは残す。
 */
async function cleanupRemindersFor(
  supabase: AuthContext["supabase"],
  householdId: string,
  eventUids: readonly string[],
  scope: string,
): Promise<void> {
  if (eventUids.length === 0) return
  for (const uids of chunkUids(eventUids)) {
    const { error } = await supabase
      .from("event_reminders")
      .delete()
      .eq("household_id", householdId)
      .in("event_uid", uids)
    if (error) {
      logSupabaseError("calendar", `${scope}: 通知設定の掃除に失敗`, error, {
        householdId,
        uids: uids.length,
      })
      return // 以降のチャンクも同じ理由で落ちる公算が高い。孤児は不活性ゆえ止めぬ。
    }
  }
}

/**
 * 予定 1 件の通知設定を読む（シートを開いた時に呼ぶ）。
 *
 * **id → event_uid の解決をサーバ側でやる**のが肝じゃ。`event_uid` は
 * `CALENDAR_EVENT_COLUMNS` に入れておらぬ（入れると migration より先にコードが
 * 出た瞬間に 4 画面が同時に落ちる）ゆえ、client は自分の予定の uid を知らぬ。
 */
export async function fetchEventReminder(eventId: string): Promise<{
  error: string | null
  row: { remind_kind: string; remind_minutes_before: number | null } | null
}> {
  if (typeof eventId !== "string" || eventId.length === 0) {
    return { error: "予定が指定されていません。", row: null }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, row: null }
  const { supabase, householdId } = result.context

  const { data: event, error: eventError } = await supabase
    .from("calendar_events")
    .select("event_uid")
    .eq("id", eventId)
    .eq("household_id", householdId)
    .maybeSingle()

  if (eventError) {
    logSupabaseError("calendar", "reminder: event uid lookup failed", eventError, {
      eventId,
      householdId,
    })
    return { error: "通知設定の取得に失敗しました。", row: null }
  }
  if (!event) {
    return { error: "予定が見つかりませんでした。", row: null }
  }

  const { data, error } = await supabase
    .from("event_reminders")
    .select("remind_kind, remind_minutes_before")
    .eq("household_id", householdId)
    .eq("event_uid", event.event_uid)
    .maybeSingle()

  if (error) {
    logSupabaseError("calendar", "reminder lookup failed", error, {
      eventId,
      householdId,
    })
    return { error: "通知設定の取得に失敗しました。", row: null }
  }

  return { error: null, row: data ?? null }
}

/**
 * 通知設定を書く（`choice="none"` は削除）。
 *
 * `source='google'` の予定にも効く — ここが本機能の眼目じゃ。`calendar_events` の
 * UPDATE ポリシーは native 限定だが、通知は**別テーブル**ゆえ google 行にも付く。
 *
 * `target` は単発（`eventId`）と繰り返しシリーズ（`seriesId`）の二形。シリーズ側で
 * id 配列を client から受けぬのは、400 件の UUID が URL に載らぬためじゃ
 * （解決はサーバ側の `.eq("series_id", …)` で済む）。
 *
 * `remind_at` は**送らぬ**。BEFORE トリガが導出する唯一の真値で、送っても列 GRANT が
 * 無く `42501` で落ちる（migration の核 ④）。
 */
export async function setEventReminder(
  target: { eventId: string } | { seriesId: string },
  choice: ReminderChoice,
): Promise<{ error: string | null; count?: number }> {
  // Server Action の引数は外部入力ゆえ実行時に検証する。
  if (!isReminderChoice(choice)) {
    return { error: "通知の設定値が不正です。" }
  }

  const isSeries = "seriesId" in target
  const key = isSeries ? target.seriesId : target.eventId
  if (typeof key !== "string" || key.length === 0) {
    return { error: "予定が指定されていません。" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error }
  const { supabase, householdId } = result.context

  // 対象予定の event_uid を解決する（世帯スコープは必ず付ける）。
  const base = supabase
    .from("calendar_events")
    .select("event_uid")
    .eq("household_id", householdId)
  const { data: events, error: lookupError } = isSeries
    ? // シリーズは native のみ（google 行に series_id は付かぬが明示して防御する）。
      await base.eq("series_id", key).eq("source", "native")
    : await base.eq("id", key)

  if (lookupError) {
    logSupabaseError("calendar", "reminder: uid lookup failed", lookupError, {
      key,
      isSeries,
      householdId,
    })
    return { error: "通知の設定に失敗しました。もう一度お試しください。" }
  }
  if (!events || events.length === 0) {
    return { error: "予定が見つかりませんでした。" }
  }

  const uids = events.map((e) => e.event_uid)
  const payload = reminderChoiceToPayload(choice)

  // 「なし」= 行を消す。
  if (payload === null) {
    for (const part of chunkUids(uids)) {
      const { error } = await supabase
        .from("event_reminders")
        .delete()
        .eq("household_id", householdId)
        .in("event_uid", part)
      if (error) {
        logSupabaseError("calendar", "reminder delete failed", error, {
          householdId,
          uids: part.length,
        })
        return { error: "通知の解除に失敗しました。もう一度お試しください。" }
      }
    }
    return { error: null, count: uids.length }
  }

  // upsert は `uq_event_reminders_event` (household_id, event_uid) を指す。
  // **index ではなく constraint** で作ってあるため PostgREST が ON CONFLICT を
  // 推論できる（partial index だと 42P10 で落ちる、という既知の罠の回避）。
  const rows = uids.map((event_uid) => ({
    event_uid,
    household_id: householdId,
    ...payload,
  }))

  for (const slice of chunkUids(rows)) {
    const { error } = await supabase
      .from("event_reminders")
      .upsert(slice, { onConflict: "household_id,event_uid" })
    if (error) {
      logSupabaseError("calendar", "reminder upsert failed", error, {
        householdId,
        rows: slice.length,
        choice,
      })
      return { error: "通知の設定に失敗しました。もう一度お試しください。" }
    }
  }

  return { error: null, count: rows.length }
}

/**
 * V7: Google 同期の完了シグナルを読む（`google_connections.last_synced_at`）。
 *
 * **Realtime を使わぬ**代わりの経路じゃ。`google_calendar_subscriptions` は
 * `sync_token` / `sync_lease_until` という秘密を持つため publication へ載せられず、
 * かつ「削除のみの同期サイクル」は `calendar_events` に INSERT/UPDATE を生まぬ
 * ため Realtime では原理的に捕まらぬ。client は `syncScheduled === true` の
 * ときだけこの値を数回ポーリングし、前進したら events を refetch する。
 *
 * `google_connections` は household RLS で SELECT 可・非機密ゆえ authenticated
 * クライアントで読む（service role を描画/操作経路に持ち込まぬ）。
 */
export async function fetchGoogleSyncSignal(): Promise<{
  lastSyncedAt: string | null
}> {
  const result = await getAuthContext()
  if (result.error !== null) return { lastSyncedAt: null }
  const { supabase, householdId } = result.context

  const { data, error } = await supabase
    .from("google_connections")
    .select("last_synced_at")
    .eq("household_id", householdId)

  if (error) {
    logSupabaseError("calendar", "google sync signal lookup failed", error, {
      householdId,
    })
    // 判定不能。null を返せば client は「前進しておらぬ」と見なして黙る
    // （ポーリングの失敗で画面を倒さぬ）。
    return { lastSyncedAt: null }
  }

  return {
    lastSyncedAt: latestIsoTimestamp((data ?? []).map((r) => r.last_synced_at)),
  }
}
