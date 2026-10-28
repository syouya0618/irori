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
  sameCalendarEventContent,
  type CalendarEventEditableValue,
} from "@/lib/domain/calendar-event-conflict"
import { isClientId } from "@/lib/utils/client-id"
import { failureKindOfDbError, type CreateFailureKind } from "@/lib/domain/save-attempt"
import {
  isTimestamptzText,
  STALE_SCREEN_SAVE_ERROR,
} from "@/lib/domain/timestamptz-text"
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
 * `/calendar` だけを無効化しておると、`/baby`（BabyDashboard）の
 * 「今日・明日の予定」カードが最大 10 秒古いまま残る。原因は 3 つが重なるためじゃ:
 *
 * 1. カードのデータは `baby/page.tsx` がサーバで `calendar_events` を引いて
 *    `initialEvents` として渡す = **`/baby` の RSC ペイロードに乗っておる**
 * 2. `next.config.ts` の `staleTimes.dynamic: 10` により、10 秒以内の
 *    クライアント遷移は取得済みペイロードを再利用する
 * 3. カードの復帰時 refetch は `visibilitychange`/`focus` 契機ゆえ、
 *    BottomNav の遷移（同一ドキュメント内）では**発火せず自己修復もせぬ**
 *
 * `revalidatePath` は Client Cache を purge する（同梱 docs
 * `04-functions/revalidatePath.md`: "This will purge the Client Cache, and
 * invalidate all cached data for revalidation on the next page visit."）ゆえ、
 * ここで `/baby` も無効化すれば `staleTimes` を迂回できる。
 *
 * **呼び出し側に 5 箇所へ素で書かせぬのは、6 箇所目を足す者が忘れるからじゃ。**
 * 表と読者の対応はこの 1 箇所に閉じておく（`calendar_events` を読むページを
 * 増やしたら、ここへ足せば全経路に効く）。
 */
function revalidateCalendarConsumers() {
  revalidatePath("/calendar")
  revalidatePath("/baby")
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
  /**
   * 冪等 id（UUID。2026-10-27 大型更新 A4 / AC28）。作成の操作ごとにクライアントが 1 回だけ作り、
   * 結果が分からぬ再送でも同じ値を送る。単発は予定の主キー、繰返しは series_id と初回の行の
   * 主キーに使う — 応答だけを失った作成を押し直しても、主キー重複で二重にならぬ。
   * 省略時は従来どおり（サーバが採番。再送の吸収は効かぬ）。update では無視される。
   */
  clientId?: string
}

const CREATE_CLIENT_ID_ERROR =
  "予定の識別子が不正です。画面を再読み込みしてからもう一度お試しください。"
const CREATE_REPLAY_MISMATCH_ERROR =
  "この予定は少し前に別の内容で作成済みです。予定の一覧で確かめてください。"
const CREATE_FAILED_ERROR = "予定の作成に失敗しました。もう一度お試しください。"
const CREATE_SERIES_FAILED_ERROR = "繰り返し予定の作成に失敗しました。もう一度お試しください。"
// 同じ冪等 id のシリーズが在るが、今の回の並びが送った内容と違う（一部の回の削除・別の頻度や終了日）。
// 「別の内容で作成済み」とは限らぬゆえ、事実だけを言う
const CREATE_SERIES_CHANGED_ERROR =
  "この繰り返し予定は少し前に作成済みですが、今の回の並びが送った内容と違います（一部の回の削除・別の頻度や終了日など）。予定の一覧で確かめてください。"

/**
 * 作成の結果。失敗は `failure`（`@/lib/domain/save-attempt` の CreateFailureKind）で分類する:
 * rejected = 予定は作られておらぬ / unknown = 作られたかもしれぬ（同じ clientId でだけ送り直す）/
 * conflict = 同じ id で別の内容が作成済み。`replayed` は応答を失った前回の作成が成立しておった。
 * 「reject（例外）＝ サーバに未到達」とは決めつけぬ（応答だけが失われた形と区別できぬ）。
 */
export type CreateCalendarEventResult =
  | { error: string; failure?: CreateFailureKind; eventId?: undefined; seriesId?: undefined }
  | {
      error: null
      eventId: string
      updatedAt: string | null
      replayed?: true
      seriesId?: undefined
      failure?: undefined
    }
  | {
      error: null
      seriesId: string
      count: number
      replayed?: true
      eventId?: undefined
      failure?: undefined
    }

export async function createCalendarEvent(
  input: CalendarEventActionInput,
): Promise<CreateCalendarEventResult> {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error, failure: "rejected" }
  const clientId = input.clientId
  if (clientId !== undefined && !isClientId(clientId)) {
    return { error: CREATE_CLIENT_ID_ERROR, failure: "rejected" }
  }

  const result = await getAuthContext()
  if (result.error !== null) return { error: result.error, failure: "rejected" }
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
      clientId,
    })
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .insert({
      ...(clientId !== undefined && { id: clientId }),
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
    // updated_at は作成直後の楽観行に版を持たせるため（無いと直後の編集が古い画面扱いになる）
    .select("id, updated_at")
    .single()

  // error と「行なし」を分離: logSupabaseError は非 null の PostgrestError を要求
  // するため error! を渡さない。
  if (error) {
    if (error.code === "23505" && clientId !== undefined) {
      return replayCreatedEvent(supabase, householdId, clientId, v.value)
    }
    logSupabaseError("calendar", "create failed", error, { userId, householdId })
    return { error: CREATE_FAILED_ERROR, failure: failureKindOfDbError(error) }
  }
  if (!data) {
    console.error("[calendar] create returned no row", { userId, householdId })
    return { error: CREATE_FAILED_ERROR, failure: "unknown" }
  }

  revalidateCalendarConsumers()
  return {
    error: null,
    eventId: data.id,
    updatedAt: isTimestamptzText(data.updated_at) ? data.updated_at : null,
  }
}

/**
 * 単発の作成の主キー重複（23505）: 応答を失った前回の作成の再送か。同じ世帯に同じ id の
 * **単発の** native 予定が在り、内容も同じなら作成済みとして成功（replayed）を返す。内容が違えば
 * 衝突。世帯に見えぬ（別世帯の id の流用）なら、この id では作れぬ（rejected）。
 */
async function replayCreatedEvent(
  supabase: AuthContext["supabase"],
  householdId: string,
  clientId: string,
  value: CalendarEventEditableValue,
): Promise<CreateCalendarEventResult> {
  const { data: existing, error } = await supabase
    .from("calendar_events")
    .select("id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source, series_id, updated_at")
    .eq("id", clientId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (error) {
    logSupabaseError("calendar", "create replay re-read failed", error, { householdId, clientId })
    return { error: CREATE_FAILED_ERROR, failure: "unknown" }
  }
  if (!existing) {
    console.warn("[calendar] create: 自世帯に無い id の主キー重複", { householdId, clientId })
    return { error: CREATE_FAILED_ERROR, failure: "rejected" }
  }
  if (
    existing.source !== "native" ||
    existing.series_id !== null ||
    !sameCalendarEventContent(existing, value)
  ) {
    console.warn("[calendar] create: 同じ冪等 id に別の内容の再試行", { householdId, clientId })
    return { error: CREATE_REPLAY_MISMATCH_ERROR, failure: "conflict" }
  }
  console.info("[calendar] create: 再試行を既存の予定として受理", { householdId, clientId })
  revalidateCalendarConsumers()
  return {
    error: null,
    eventId: existing.id,
    updatedAt: isTimestamptzText(existing.updated_at) ? existing.updated_at : null,
    replayed: true,
  }
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
  clientId: string | undefined
}): Promise<CreateCalendarEventResult> {
  const { supabase, userId, householdId, value, repeat, repeatUntil, clientId } = args

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
    return {
      error: "繰り返し予定の生成に失敗しました。設定を確認してください。",
      failure: "rejected",
    }
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

  // 冪等 id があれば series_id と**初回の行の主キー**に使う（2026-10-27 A4）。series_id には一意
  // 制約が無いゆえ、それだけでは再送が N 行を二重に入れる。初回の行の主キーを決めれば、単一の
  // 一括 INSERT（原子的）が主キー重複で丸ごと落ち、半端なシリーズも二重のシリーズも作らぬ
  // （並んで届いた再送も、片方は主キー重複で落ちる）
  const seriesId = clientId ?? randomUUID()
  const rows = dates.map((date, index) => {
    const endDate = spanDays === 0 ? date : shiftYmd(date, spanDays)
    const startAt =
      !value.isAllDay && startTime ? jstWallClockToIso(date, startTime) : null
    const endAt =
      !value.isAllDay && endTime ? jstWallClockToIso(endDate, endTime) : null
    return {
      // **全行に id を持たせる**（鍵の集合を揃える）。supabase-js の配列 insert は全行の鍵の和集合を
      // 列に載せ、ある行に無い鍵を DEFAULT ではなく NULL で入れる（postgrest-js insert の
      // defaultToNull 既定）。初回の行だけに id を足すと 2 行目以降が id NULL の 23502 で落ちる
      // （v7 の回帰。e2e calendar.spec の毎週×3 が 0 件になった）
      id: index === 0 && clientId !== undefined ? clientId : randomUUID(),
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

  // 初回の回だけが消された後の再送（独立レビュー F4）: 初回の行の主キーはもう重ならぬゆえ、主キーの
  // 守りだけでは残りの回を丸ごと二重に入れる。同じシリーズの行が世帯に残っておれば、入れずに照合へ
  // 回す（全行が残る普通の再送は replayed、回が欠けておれば conflict）。全ての回が消されておれば
  // 作り直す — 残る行が無く二重にはならぬ（利用者の明示の送り直し）。この読みと INSERT の間に並んで
  // 届いた再送は、初回の行の主キーで片方が落ちる
  if (clientId !== undefined) {
    const { data: survivors, error: survivorsError } = await supabase
      .from("calendar_events")
      .select("id")
      .eq("household_id", householdId)
      .eq("series_id", clientId)
      .limit(1)
    if (survivorsError) {
      logSupabaseError("calendar", "create series pre-check failed", survivorsError, {
        householdId,
        clientId,
      })
      // この要求は何も書いておらぬが、先の送信が成立しておりうる。同じ id でだけ送り直させる
      return { error: CREATE_SERIES_FAILED_ERROR, failure: "unknown" }
    }
    if (survivors && survivors.length > 0) {
      return replayCreatedSeries(supabase, householdId, clientId, rows[0], dates)
    }
  }

  const { data, error } = await supabase
    .from("calendar_events")
    .insert(rows)
    .select("id")

  if (error) {
    if (error.code === "23505" && clientId !== undefined) {
      return replayCreatedSeries(supabase, householdId, clientId, rows[0], dates)
    }
    logSupabaseError("calendar", "create series failed", error, {
      userId,
      householdId,
      count: rows.length,
    })
    return { error: CREATE_SERIES_FAILED_ERROR, failure: failureKindOfDbError(error) }
  }
  if (!data || data.length === 0) {
    console.error("[calendar] create series returned no rows", {
      userId,
      householdId,
    })
    return { error: CREATE_SERIES_FAILED_ERROR, failure: "unknown" }
  }

  revalidateCalendarConsumers()
  return { error: null, seriesId, count: data.length }
}

/**
 * 繰返し作成の再送の照合（主キー重複、または同じシリーズの行が世帯に残っておった時）。初回の行
 * （id = clientId）が同じ世帯に在り、同じシリーズ（series_id = clientId）で内容も同じで、今の開催日の
 * 並びが今回作ろうとした並びと一致する時だけ、前回の一括作成が成立しておった（replayed）とする。
 * 初回の行が消されておる・並びが違う時は conflict（二重にも成功にもせぬ）。初回の行もシリーズの行も
 * 世帯に無い主キー重複は、別世帯の id ゆえ rejected。
 */
async function replayCreatedSeries(
  supabase: AuthContext["supabase"],
  householdId: string,
  clientId: string,
  first: {
    title: string
    memo: string | null
    is_all_day: boolean
    start_date: string
    end_date: string
    start_at: string | null
    end_at: string | null
  },
  /** 今回の送信が作ろうとした全開催日（初回の行だけでなく、頻度・終了日の違いも照合する） */
  requestedDates: string[],
): Promise<CreateCalendarEventResult> {
  const { data: existing, error } = await supabase
    .from("calendar_events")
    .select("id, title, memo, is_all_day, start_date, end_date, start_at, end_at, source, series_id")
    .eq("id", clientId)
    .eq("household_id", householdId)
    .maybeSingle()
  if (error) {
    logSupabaseError("calendar", "create series replay re-read failed", error, { householdId, clientId })
    return { error: CREATE_SERIES_FAILED_ERROR, failure: "unknown" }
  }
  // 今のシリーズの開催日（世帯で絞る）。初回の行の有無と並びの照合の両方に使う
  const { data: seriesRows, error: seriesError } = await supabase
    .from("calendar_events")
    .select("start_date")
    .eq("household_id", householdId)
    .eq("series_id", clientId)
  if (seriesError) {
    logSupabaseError("calendar", "create series replay series re-read failed", seriesError, {
      householdId,
      clientId,
    })
    return { error: CREATE_SERIES_FAILED_ERROR, failure: "unknown" }
  }
  const storedDates = (seriesRows ?? []).map((r) => r.start_date as string).sort()
  if (!existing) {
    if (storedDates.length === 0) {
      console.warn("[calendar] create series: 自世帯に無い id の主キー重複", { householdId, clientId })
      return { error: CREATE_SERIES_FAILED_ERROR, failure: "rejected" }
    }
    // 初回の回だけが消された後の再送（独立レビュー F4）。残りの回を二重に作らぬ
    console.warn("[calendar] create series: 初回の回が消されたシリーズへの再試行", {
      householdId,
      clientId,
      stored: storedDates.length,
    })
    return { error: CREATE_SERIES_CHANGED_ERROR, failure: "conflict" }
  }
  const same =
    existing.source === "native" &&
    existing.series_id === clientId &&
    sameCalendarEventContent(existing, {
      title: first.title,
      memo: first.memo,
      isAllDay: first.is_all_day,
      startDate: first.start_date,
      endDate: first.end_date,
      startAt: first.start_at,
      endAt: first.end_at,
    })
  if (!same) {
    console.warn("[calendar] create series: 同じ冪等 id に別の内容の再試行", { householdId, clientId })
    return { error: CREATE_REPLAY_MISMATCH_ERROR, failure: "conflict" }
  }
  // 初回の行が同じでも、頻度・終了日を変えた再送は別の内容（独立レビュー 2026-10-28 の指摘）。
  // 今のシリーズの開催日の並びが、今回作ろうとした並びと完全に一致する時だけ「成立済み」とする。
  // 家族が一部の回を消していた等で一致せぬ時も、成功とは言わず衝突として確かめさせる（安全側）
  const wanted = [...requestedDates].sort()
  if (
    storedDates.length !== wanted.length ||
    storedDates.some((d, i) => d !== wanted[i])
  ) {
    console.warn("[calendar] create series: 同じ冪等 id で開催日の並びが違う再試行", {
      householdId,
      clientId,
      stored: storedDates.length,
      requested: wanted.length,
    })
    return { error: CREATE_SERIES_CHANGED_ERROR, failure: "conflict" }
  }
  console.info("[calendar] create series: 再試行を既存のシリーズとして受理", { householdId, clientId })
  revalidateCalendarConsumers()
  return { error: null, seriesId: clientId, count: storedDates.length, replayed: true }
}

export type UpdateCalendarEventResult =
  | { error: null; updatedAt: string | null; conflict?: undefined }
  /**
   * `conflict: true` は「画面の予定が古い」（別の端末が先に更新・削除した）。
   * 呼び出し側は手元の楽観行を捨てて取り直す。読み直し自体の失敗や同期予定は
   * conflict を付けぬ（衝突と断定できぬ・取り直しても直らぬ）。
   */
  | { error: string; updatedAt?: undefined; conflict?: true }

/**
 * 予定を 1 件更新する。`updated_at` を版にした楽観的排他（育児日記 P1-06 と同じ契約）。
 *
 * `expectedUpdatedAt` は編集シートを開いた時点で見ていた版（PostgREST が返した表記の
 * まま。`Date` に通すとマイクロ秒が落ちて二度と一致せぬ）。版の一致を UPDATE の条件に
 * し、0 行なら読み直して次のどれかを返す:
 * - 中身が今回と同じ: 応答だけを失った自分の保存の再試行。成功（冪等）
 * - 中身が違う: 別の端末（家族またはご自身）が先に更新した。上書きせず衝突
 * - 行が無い: 他端末で削除されたか、権限が無い。衝突（取り直せば画面から消える）
 * - 同期予定: 編集できぬ（source='native' 以外）
 *
 * 版を送らぬ呼び出し（デプロイを跨いだ古いバンドル）を無条件の上書きへ倒さぬ。
 */
export async function updateCalendarEvent(
  input: CalendarEventActionInput & { id: string; expectedUpdatedAt: string },
): Promise<UpdateCalendarEventResult> {
  const v = validateCalendarEventInput(input)
  if (v.error !== null) return { error: v.error }
  if (!isTimestamptzText(input.expectedUpdatedAt)) {
    return { error: STALE_SCREEN_SAVE_ERROR }
  }

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
    .eq("updated_at", input.expectedUpdatedAt)
    .select("id, updated_at")

  if (error) {
    logSupabaseError("calendar", "update failed", error, { id: input.id, householdId })
    return { error: "予定の更新に失敗しました。もう一度お試しください。" }
  }
  const saved = data?.[0]
  if (saved) {
    revalidateCalendarConsumers()
    return {
      error: null,
      updatedAt: isTimestamptzText(saved.updated_at) ? saved.updated_at : null,
    }
  }

  // 0 行: 版が合わぬか、行が無いか、同期予定か。読み直して見分ける（世帯で絞る）。
  const { data: current, error: rereadError } = await supabase
    .from("calendar_events")
    .select("title, memo, is_all_day, start_date, end_date, start_at, end_at, source, updated_at")
    .eq("id", input.id)
    .eq("household_id", householdId)
    .maybeSingle()
  if (rereadError) {
    logSupabaseError("calendar", "update conflict re-read failed", rereadError, {
      id: input.id,
      householdId,
    })
    return {
      error:
        "予定を更新できたか確かめられませんでした。画面を更新して予定を確かめてください。",
    }
  }
  if (!current) {
    return {
      error: "この予定は見つかりませんでした（他の端末で削除されたか、権限がありません）。",
      conflict: true,
    }
  }
  if (current.source !== "native") {
    return { error: "この予定は編集できません（同期予定か、権限がありません）。" }
  }
  if (sameCalendarEventContent(current, v.value)) {
    revalidateCalendarConsumers()
    return {
      error: null,
      updatedAt: isTimestamptzText(current.updated_at) ? current.updated_at : null,
    }
  }
  // 書いた人は断定しない（応答を失った自分の別端末の保存も同じ形で衝突する）
  return {
    error:
      "この予定は別の端末で先に更新されていました（家族またはご自身）。最新の内容を確かめてから、もう一度編集してください。",
    conflict: true,
  }
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
