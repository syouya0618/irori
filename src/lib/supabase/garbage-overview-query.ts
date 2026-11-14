import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import {
  buildGarbageOverview,
  eventKeyOf,
  GARBAGE_CANDIDATE_LIMIT,
  GARBAGE_EVENT_COLUMNS,
  parseGarbageEventRow,
  purposeLookupKey,
  seriesKeyOf,
  suggestGarbageCandidates,
  type GarbageCandidate,
  type EventPurposeRow,
  type GarbageEventRow,
  type GarbageOverview,
} from "@/lib/domain/garbage"
import { fetchEventPurposeLoad } from "@/lib/supabase/event-purpose-query"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * ごみの画面（/chores/garbage）の読み取り。Server Component から呼ぶ（境界指令を持たぬ中立モジュール）。
 *
 * ## 読むもの（世帯で絞る。RLS と二重）
 * 1. 分類（`event_purposes`）— 世帯ぶん一括
 * 2. 今日から `GARBAGE_WINDOW_DAYS` 日ぶんの予定 — 次の収集日の元
 * 3. 期間内に回が見つからなんだ分類について、**鍵で**予定を 1 件ずつ引く（全期間）。月 1 回・年数回の
 *    収集や、過ぎた予定の分類を「予定が見つからぬ」と誤らぬため
 * 4. 並べる収集日の通知設定（`event_reminders`）
 *
 * ## 偽らぬための規則
 * - 分類を読めなんだら `purposes: "failed"`（画面は「ありません」と言わず失敗を出す）
 * - 鍵で引く問い合わせが失敗した・上限で引かなんだ分類は `unchecked`（「予定が見つからぬ」とは言わぬ）
 * - 通知設定を読めなんだら `reminders.status: "failed"`（「通知なし」と言わぬ）
 *
 * 分類の行を**消す・直す処理はここに無い**（読むだけ）。孤児の整理は利用者の操作（RPC が
 * もう一度「予定が 1 つも無い」ことを確かめる）。
 */

/** 次の収集日を探す期間（今日を含む日数）。月 1 回の収集の次の回が入る長さ */
export const GARBAGE_WINDOW_DAYS = 62
/** 画面に並べる収集日の上限 */
export const GARBAGE_COLLECTION_LIMIT = 20
/** 期間内の予定の取得上限（PostgREST の既定の上限と同じ。届いたら「全部ではない」として扱う） */
const WINDOW_ROW_LIMIT = 1000
/** 鍵で引くシリーズの数の上限（超えた分は unchecked） */
const SERIES_LOOKUP_LIMIT = 40
/** `.in("event_uid", …)` に載せる鍵の数（Google の鍵は長いゆえ小さく割る） */
const EVENT_KEY_CHUNK = 20

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface GarbageReminderRow {
  remind_kind: string
  remind_minutes_before: number | null
  /**
   * 通知の時刻（DB が導出した `remind_at`）が、サーバがこの画面を組んだ時点でもう過ぎておるか。
   * 過ぎた時刻の通知は、これからは配信されぬ（配信は直近の窓に在るものだけを送る）。画面は
   * 「通知します」と言わず、過ぎておることを言う。時刻を読めなんだ行は false（言い切らぬ）
   */
  passed: boolean
}

export interface GarbagePageData {
  /** サーバが組んだ時点の JST の今日 */
  today: string
  windowDays: number
  /** 分類を読めたか。failed の時 `overview` は空（「分類が無い」ではない） */
  purposes: "ok" | "failed"
  /**
   * 今後の予定を読めたか。
   * - `failed` … 読めなんだ（次の収集日を出せぬ）
   * - `truncated` … 上限まで読んだ（期間の後ろの収集日が欠けておるかもしれぬ）
   */
  events: "ok" | "failed" | "truncated"
  overview: GarbageOverview
  /**
   * 既存予定からの未分類候補（読み取り専用。期間内の予定の題から推したもの）。
   * 分類か予定を読めなんだ時は空（「候補が無い」とは言わぬ — 画面は候補の欄を出さぬ）
   */
  candidates?: GarbageCandidate[]
  /** 候補が上限（`GARBAGE_CANDIDATE_LIMIT`）を超えて在った（近い順に上限まで載せた） */
  candidatesMore?: boolean
  /** 並べた収集日の通知設定（鍵 = event_uid）。行が無い鍵 = 通知なし */
  reminders:
    | { status: "ok"; byEventKey: Record<string, GarbageReminderRow> }
    | { status: "failed" }
}

const EMPTY_OVERVIEW: GarbageOverview = { collections: [], moreCollections: 0, entries: [] }

function parseEvents(data: unknown): GarbageEventRow[] | null {
  if (!Array.isArray(data)) return null
  const rows: GarbageEventRow[] = []
  for (const item of data) {
    const row = parseGarbageEventRow(item)
    if (!row) return null
    rows.push(row)
  }
  return rows
}

export async function loadGarbagePage(
  supabase: SupabaseClient<Database>,
  householdId: string,
  today: string,
  /** 通知の時刻が過ぎたかを判じる基準（既定はサーバの今）。テストから固定できる */
  now: Date = new Date(),
): Promise<GarbagePageData> {
  const windowEnd = shiftYmd(today, GARBAGE_WINDOW_DAYS - 1)
  const base = { today, windowDays: GARBAGE_WINDOW_DAYS }

  const [purposeLoad, { data: windowData, error: windowError }] = await Promise.all([
    fetchEventPurposeLoad(supabase, householdId),
    supabase
      .from("calendar_events")
      .select(GARBAGE_EVENT_COLUMNS)
      .eq("household_id", householdId)
      .gte("end_date", today) // 重なり判定: end_date >= 今日
      .lte("start_date", windowEnd) //          AND start_date <= 期間の末日
      .order("start_date")
      .limit(WINDOW_ROW_LIMIT),
  ])

  if (purposeLoad.status === "failed") {
    return {
      ...base,
      purposes: "failed",
      events: windowError ? "failed" : "ok",
      overview: EMPTY_OVERVIEW,
      reminders: { status: "ok", byEventKey: {} },
    }
  }

  let events: GarbagePageData["events"] = "ok"
  let windowEvents: GarbageEventRow[] = []
  if (windowError) {
    logSupabaseError("garbage", "upcoming events lookup failed", windowError, { householdId })
    events = "failed"
  } else {
    const parsed = parseEvents(windowData)
    if (parsed === null) {
      console.error("[garbage] upcoming events の行を読めぬ", { householdId })
      events = "failed"
    } else {
      windowEvents = parsed
      if (parsed.length >= WINDOW_ROW_LIMIT) events = "truncated"
    }
  }

  const rows = purposeLoad.rows
  const anchors = await lookupAnchors(supabase, householdId, rows, windowEvents)

  const overview = buildGarbageOverview({
    rows,
    windowEvents,
    anchorEvents: anchors.events,
    unchecked: anchors.unchecked,
    today,
    collectionLimit: GARBAGE_COLLECTION_LIMIT,
  })

  // 上限 + 1 件まで探し、上限を超えて在ったかを言えるようにする
  const found = events === "failed" ? [] : suggestGarbageCandidates(windowEvents, rows, GARBAGE_CANDIDATE_LIMIT + 1)

  return {
    ...base,
    purposes: "ok",
    events,
    overview,
    candidates: found.slice(0, GARBAGE_CANDIDATE_LIMIT),
    candidatesMore: found.length > GARBAGE_CANDIDATE_LIMIT,
    reminders: await lookupReminders(
      supabase,
      householdId,
      overview.collections.map((c) => c.event.eventKey).filter((k): k is string => k !== null),
      now,
    ),
  }
}

/**
 * 期間内に回が見つからなんだ分類の予定を、鍵で引く（全期間）。
 * 失敗した・引かなんだ分類は `unchecked` へ入れる（孤児と言わせぬ）。
 */
async function lookupAnchors(
  supabase: SupabaseClient<Database>,
  householdId: string,
  rows: readonly EventPurposeRow[],
  windowEvents: readonly GarbageEventRow[],
): Promise<{ events: GarbageEventRow[]; unchecked: Set<string> }> {
  const seenEventKeys = new Set<string>()
  const seenSeriesKeys = new Set<string>()
  for (const event of windowEvents) {
    const eventKey = eventKeyOf(event)
    if (eventKey !== null) seenEventKeys.add(eventKey)
    const seriesKey = seriesKeyOf(event)
    if (seriesKey !== null) seenSeriesKeys.add(seriesKey)
  }
  const classified = rows.filter((row) => row.purpose !== null)
  const eventKeys = classified
    .filter((row) => row.scope === "event" && !seenEventKeys.has(row.targetKey))
    .map((row) => row.targetKey)
  const seriesKeys = classified
    .filter((row) => row.scope === "series" && !seenSeriesKeys.has(row.targetKey))
    .map((row) => row.targetKey)

  const found: GarbageEventRow[] = []
  const unchecked = new Set<string>()

  // 1 回の予定の鍵: event_uid の IN で引く（鍵 1 つにつき高々 1 行）
  for (let i = 0; i < eventKeys.length; i += EVENT_KEY_CHUNK) {
    const part = eventKeys.slice(i, i + EVENT_KEY_CHUNK)
    const { data, error } = await supabase
      .from("calendar_events")
      .select(GARBAGE_EVENT_COLUMNS)
      .eq("household_id", householdId)
      .in("event_uid", part)
    const parsed = error ? null : parseEvents(data)
    if (error || parsed === null) {
      if (error) logSupabaseError("garbage", "event anchor lookup failed", error, { householdId })
      for (const key of part) unchecked.add(purposeLookupKey("event", key))
      continue
    }
    found.push(...parsed)
  }

  // シリーズの鍵: 1 シリーズにつき最後の回を 1 行だけ（全ての回を引くと上限に掛かって欠ける）
  const lookups = seriesKeys.slice(0, SERIES_LOOKUP_LIMIT)
  for (const key of seriesKeys.slice(SERIES_LOOKUP_LIMIT)) unchecked.add(purposeLookupKey("series", key))
  const results = await Promise.all(
    lookups.map(async (key) => {
      const separator = key.indexOf("|")
      if (separator === -1 && !UUID_SHAPE.test(key)) return { key, rows: null }
      const { data, error } =
        separator === -1
          ? await supabase
              .from("calendar_events")
              .select(GARBAGE_EVENT_COLUMNS)
              .eq("household_id", householdId)
              .eq("source", "native")
              .eq("series_id", key)
              .order("start_date", { ascending: false })
              .limit(1)
          : await supabase
              .from("calendar_events")
              .select(GARBAGE_EVENT_COLUMNS)
              .eq("household_id", householdId)
              .eq("source", "google")
              .eq("google_calendar_id", key.slice(0, separator))
              .eq("recurring_event_id", key.slice(separator + 1))
              .order("start_date", { ascending: false })
              .limit(1)
      if (error) {
        logSupabaseError("garbage", "series anchor lookup failed", error, { householdId })
        return { key, rows: null }
      }
      return { key, rows: parseEvents(data) }
    }),
  )
  for (const result of results) {
    if (result.rows === null) unchecked.add(purposeLookupKey("series", result.key))
    else found.push(...result.rows)
  }
  return { events: found, unchecked }
}

async function lookupReminders(
  supabase: SupabaseClient<Database>,
  householdId: string,
  eventKeys: readonly string[],
  now: Date,
): Promise<GarbagePageData["reminders"]> {
  const byEventKey: Record<string, GarbageReminderRow> = {}
  const unique = Array.from(new Set(eventKeys))
  const nowMs = now.getTime()
  for (let i = 0; i < unique.length; i += EVENT_KEY_CHUNK) {
    const { data, error } = await supabase
      .from("event_reminders")
      // remind_at は DB のトリガが導出した真値（画面側で導出し直さぬ）
      .select("event_uid, remind_kind, remind_minutes_before, remind_at")
      .eq("household_id", householdId)
      .in("event_uid", unique.slice(i, i + EVENT_KEY_CHUNK))
    if (error) {
      logSupabaseError("garbage", "reminder lookup failed", error, { householdId })
      return { status: "failed" }
    }
    for (const row of data ?? []) {
      const at = typeof row.remind_at === "string" ? new Date(row.remind_at).getTime() : Number.NaN
      byEventKey[row.event_uid] = {
        remind_kind: row.remind_kind,
        remind_minutes_before: row.remind_minutes_before,
        // 予定のシートの通知の欄と同じ基準（許容 0 分）
        passed: !Number.isNaN(at) && !Number.isNaN(nowMs) && at <= nowMs,
      }
    }
  }
  return { status: "ok", byEventKey }
}
