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

  revalidateCalendarConsumers()
  return { error: null, count: data.length }
}
