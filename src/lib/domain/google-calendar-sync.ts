import { shiftYmd, toJstDateString } from "@/lib/utils/date-jst"

/**
 * Google Calendar API v3 `events.list` の生イベントを `calendar_events` の
 * google 行へ変換する**純関数コア**（計画書 §D-3「純関数コア」）。
 *
 * **境界指令を持たない中立モジュール**である（`"use client"` も `"use server"` も
 * 付けてはならない）。前者は Server Component からの値 import を client reference
 * へ化けさせ（`tsc` も `next build` も通ったまま実行時に壊れる）、後者は非関数
 * export を禁じてビルドを壊す。`calendar-event-columns.ts` と同じ理由じゃ。
 *
 * **I/O を一切持たない**: `fetch` を呼ばず、Supabase を触らず、`Date.now()` にも
 * 暗黙依存しない（`synced_at` のような「今」を要する列は I/O シェル側 = D-3 の責務）。
 *
 * 型の対応: 返す行の `subscription_id` / `source_user_id` / `location` /
 * `html_link` / `recurring_event_id` / `google_updated` 列は **D-1 の ALTER で
 * 追加される前提**であり、本 PR では型の上でのみ存在する。D-1 で
 * `src/lib/types/database.ts` の `calendar_events` 定義へ同じ列を足し、
 * この `GoogleCalendarEventRow` と突き合わせること（reconciliation 義務）。
 */

// ============================================================
// Google 側の生イベント（我々が読む部分だけを型にする）
// ============================================================

/** Google の `start` / `end`。all-day は `date`、時刻付きは `dateTime` が入る。 */
export interface GoogleEventDateTime {
  /** all-day: "YYYY-MM-DD"。Google の `end.date` は**排他的**。 */
  date?: string | null
  /** 時刻付き: ISO 8601（"2026-07-08T10:00:00+09:00" 等）。 */
  dateTime?: string | null
  timeZone?: string | null
}

/**
 * `events.list` の 1 件。Google は将来フィールドを増やすため、
 * **未知フィールドで落ちない**よう全て optional にしてある。
 */
export interface GoogleRawEvent {
  id?: string | null
  /** "confirmed" | "tentative" | "cancelled"（未知値もありうる）。 */
  status?: string | null
  summary?: string | null
  description?: string | null
  location?: string | null
  htmlLink?: string | null
  recurringEventId?: string | null
  /** イベントの最終更新（ISO 8601）。 */
  updated?: string | null
  etag?: string | null
  iCalUID?: string | null
  start?: GoogleEventDateTime | null
  end?: GoogleEventDateTime | null
}

// ============================================================
// 行に焼き込むが Google からは来ない値
// ============================================================

/**
 * 行の生成に必要だが Google の生イベントには含まれない値。
 *
 * **全キーを必須にし、省略可能な値は `?:` ではなく `| null` で表す**。
 * `?:` にすると呼び出し側が渡し忘れてもコンパイルが通り、`subscription_id` が
 * 無音で NULL に落ちる（購読解除時のミラー掃除が効かなくなる）。
 */
export interface GoogleSyncContext {
  householdId: string
  /** 購読中の Google カレンダー ID（`google_calendar_id` 列）。 */
  googleCalendarId: string
  /** 由来の購読。V9 により FK は ON DELETE SET NULL ゆえ null を取りうる。 */
  subscriptionId: string | null
  /** 接続した配偶者（`source_user_id`）。プロフィール削除で null になりうる。 */
  sourceUserId: string | null
}

/**
 * `calendar_events` へ upsert する google 行。
 *
 * `created_by` は含めない（migration のコメントどおり google 行は NULL）。
 * `synced_at` も含めない（「今」は純関数の外＝ I/O シェルが埋める）。
 */
export interface GoogleCalendarEventRow {
  household_id: string
  title: string
  memo: string | null
  is_all_day: boolean
  /** JST 暦日バケット（YYYY-MM-DD）。 */
  start_date: string
  /** JST 暦日バケット（YYYY-MM-DD、**包含的**）。 */
  end_date: string
  start_at: string | null
  end_at: string | null
  source: "google"
  google_event_id: string
  google_calendar_id: string
  etag: string | null
  ical_uid: string | null
  subscription_id: string | null
  source_user_id: string | null
  location: string | null
  html_link: string | null
  recurring_event_id: string | null
  google_updated: string | null
}

// ============================================================
// 分類結果
// ============================================================

/**
 * 行を作れなかった理由。**機械可読な code** にして I/O シェル（D-3）が
 * 集計・アラートできるようにする（文言に依存させない）。
 */
export type GoogleSyncSkipReason =
  /** `id` が無い＝ `chk_calendar_google_meta` を満たせない。 */
  | "missing_google_event_id"
  /** ctx の `googleCalendarId` が空＝同上（かつ UNIQUE 冪等キーが崩れる）。 */
  | "missing_google_calendar_id"
  /** `start` そのものが無い（cancelled 以外で来たら異常）。 */
  | "missing_start"
  /** `start.date` / `start.dateTime` が不正で JST 暦日を求められない。 */
  | "invalid_start"

export type ClassifiedGoogleEvent =
  | { op: "delete"; googleEventId: string }
  | { op: "upsert"; event: GoogleCalendarEventRow }
  /**
   * 行を作らず捨てる。**黙って落とさない**ため理由を必ず伴う
   * （`diffPage` が `skipped[]` へ集約し、構造化ログも出す）。
   */
  | { op: "skip"; reason: GoogleSyncSkipReason; googleEventId: string | null }

export type NormalizeResult =
  | { ok: true; row: GoogleCalendarEventRow }
  | { ok: false; reason: GoogleSyncSkipReason }

export interface GoogleSyncSkip {
  googleEventId: string | null
  reason: GoogleSyncSkipReason
}

export interface GoogleSyncDiff {
  upserts: GoogleCalendarEventRow[]
  /** 削除すべき `google_event_id` の一覧。 */
  deletes: string[]
  skipped: GoogleSyncSkip[]
}

// ============================================================
// 文字列の正規化（DB CHECK と同じ不変条件をここで満たす）
// ============================================================

/** `chk_calendar_title`: `char_length(btrim(title)) BETWEEN 1 AND 200`。 */
export const MAX_TITLE_CHARS = 200
/** `chk_calendar_memo`: `char_length(memo) <= 1000`。 */
export const MAX_MEMO_CHARS = 1000
/** `summary` 欠落・空白のみのときのタイトル。 */
export const UNTITLED_TITLE = "(無題)"

/**
 * **コードポイント単位**で切り詰める。`String.prototype.slice` を使わない理由は
 * 2 つあり、重いのは後者じゃ:
 *  1. Postgres の `char_length` は文字数（コードポイント）で数えるのに対し JS の
 *     `.length` は UTF-16 コードユニットで数える。
 *  2. `.slice` は**サロゲートペアを割る**ことがあり、孤立サロゲートは UTF-8 へ
 *     符号化できない。JSON 経由で Postgres へ渡すと text/jsonb が拒否する。
 *     絵文字 1 個で upsert バッチ全体が落ちる。
 */
function truncateByCodePoints(text: string, maxChars: number): string {
  const codePoints = Array.from(text)
  if (codePoints.length <= maxChars) return text
  // 先頭は btrim 済みで非空白ゆえ、trimEnd 後も必ず 1 文字以上残る。
  return codePoints.slice(0, maxChars).join("").trimEnd()
}

/**
 * `summary` を `chk_calendar_title` を満たすタイトルへ正規化する。
 * 欠落・空白のみ → `(無題)` / 200 文字超 → 切り詰め（判定は btrim 後の長さ）。
 */
export function normalizeTitle(summary: string | null | undefined): string {
  const trimmed = (summary ?? "").trim()
  if (trimmed.length === 0) return UNTITLED_TITLE
  return truncateByCodePoints(trimmed, MAX_TITLE_CHARS)
}

/**
 * `description` を `memo` へ正規化する（列は増やさない — 計画書 §D-2）。
 * 空文字・空白のみ → null / 1000 文字超 → 切り詰め。
 */
export function normalizeMemo(description: string | null | undefined): string | null {
  const trimmed = (description ?? "").trim()
  if (trimmed.length === 0) return null
  return truncateByCodePoints(trimmed, MAX_MEMO_CHARS)
}

/** 任意テキスト列（location 等）: trim して空なら null。長さ CHECK は無い。 */
function optionalText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim()
  return trimmed.length === 0 ? null : trimmed
}

// ============================================================
// 日付・時刻のガード
// ============================================================

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * "YYYY-MM-DD" として妥当かを厳格判定する。
 *
 * **これを怠ると同期全体が落ちる**: `shiftYmd("garbage", -1)` は
 * `Number("garbage")=NaN` → Invalid Date → `.toISOString()` が **RangeError を
 * throw** し、生イベント 1 件で `diffPage` ごと死ぬ。正規表現だけでは
 * "2026-02-30" を通してしまうため、UTC で往復させて実在日も確かめる
 * （`new Date("YYYY-MM-DD")` の UTC 罠に触れぬよう、**日付演算には使わず
 * 妥当性判定にのみ**用い、オフセットも明示している）。
 */
function isValidYmd(value: string | null | undefined): value is string {
  if (typeof value !== "string" || !YMD_RE.test(value)) return false
  const probe = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(probe.getTime())) return false
  return probe.toISOString().slice(0, 10) === value
}

/**
 * 時刻付き ISO 8601 として妥当かを判定する（`calendar-validation.ts` と同一規約）。
 * `toJstDateString` は不正 ISO で **RangeError を throw** するため、その前段ガード。
 */
function isValidIsoDateTime(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    !Number.isNaN(new Date(value).getTime())
  )
}

/** 妥当な ISO を UTC 正規形へ揃える（"+09:00" 表記と "Z" 表記の二重真値源を作らない）。 */
function toIsoUtc(iso: string): string {
  return new Date(iso).toISOString()
}

// ============================================================
// normalizeEvent
// ============================================================

/**
 * 生イベント 1 件を `calendar_events` の google 行へ正規化する。
 *
 * **`status === 'cancelled'` をここへ渡してはならない**（cancelled は
 * `start`/`end` を欠くことがあり "missing_start" で捨てられる）。振り分けは
 * `classifyEvent` の責務じゃ。
 *
 * DB CHECK との対応:
 * - `chk_calendar_title` / `chk_calendar_memo` → `normalizeTitle` / `normalizeMemo`
 * - `chk_calendar_date_order` → `end_date < start_date` は `start_date` へ丸める
 * - `chk_calendar_all_day` → all-day は `start_at`/`end_at` を NULL、時刻付きは
 *   `start_at` 必須（求まらぬなら行を作らず skip）
 * - `chk_calendar_time_order` → 逆転した `end_at` は **null に落とす**
 * - `chk_calendar_google_meta` → `google_event_id`/`google_calendar_id` 両方必須
 */
export function normalizeEvent(
  raw: GoogleRawEvent,
  ctx: GoogleSyncContext
): NormalizeResult {
  const googleEventId = optionalText(raw.id)
  if (!googleEventId) return { ok: false, reason: "missing_google_event_id" }

  const googleCalendarId = optionalText(ctx.googleCalendarId)
  if (!googleCalendarId) return { ok: false, reason: "missing_google_calendar_id" }

  const start = raw.start
  if (!start) return { ok: false, reason: "missing_start" }
  // 型述語での絞り込みを確実にするため、判定対象は必ず const へ落としてから渡す。
  const endDateRaw = raw.end?.date
  const endDateTimeRaw = raw.end?.dateTime
  const updatedRaw = raw.updated

  const common = {
    household_id: ctx.householdId,
    title: normalizeTitle(raw.summary),
    memo: normalizeMemo(raw.description),
    source: "google" as const,
    google_event_id: googleEventId,
    google_calendar_id: googleCalendarId,
    etag: optionalText(raw.etag),
    ical_uid: optionalText(raw.iCalUID),
    subscription_id: ctx.subscriptionId,
    source_user_id: ctx.sourceUserId,
    location: optionalText(raw.location),
    html_link: optionalText(raw.htmlLink),
    recurring_event_id: optionalText(raw.recurringEventId),
    // メタ情報ゆえ不正値では行を捨てず null へ退化させる。
    google_updated: isValidIsoDateTime(updatedRaw) ? toIsoUtc(updatedRaw) : null,
  }

  // ---- all-day -------------------------------------------------
  // 判別は `start.date` の有無で行う（Google は date と dateTime を排他で返す）。
  if (start.date != null) {
    const startDate = start.date
    if (!isValidYmd(startDate)) return { ok: false, reason: "invalid_start" }

    // 罠1: Google の `end.date` は**排他的**（1 日イベントは start=07-08, end=07-09）。
    // 本テーブルの `end_date` は**包含的**ゆえ 1 日戻す。
    // `new Date` での日付演算は UTC 罠ゆえ禁止 → shiftYmd（Date.UTC ベース）に委譲。
    // end が無い/不正なら「終了日不明」として単日へ退化させる（捏造しない）。
    const rawEndDate = isValidYmd(endDateRaw) ? shiftYmd(endDateRaw, -1) : startDate
    // 罠5: `end.date === start.date` のような不正入力では -1 で逆転する。
    // YYYY-MM-DD は辞書順 = 暦順ゆえ文字列比較で判定できる。
    const endDate = rawEndDate < startDate ? startDate : rawEndDate

    return {
      ok: true,
      row: {
        ...common,
        is_all_day: true,
        start_date: startDate,
        end_date: endDate,
        start_at: null,
        end_at: null,
      },
    }
  }

  // ---- 時刻付き -------------------------------------------------
  const startDateTimeRaw = start.dateTime
  if (!isValidIsoDateTime(startDateTimeRaw)) {
    return { ok: false, reason: "invalid_start" }
  }
  const startAt = toIsoUtc(startDateTimeRaw)
  // 罠2: `dateTime` を string slice で日付化しない。"2026-07-08T16:30:00Z" は
  // JST では 2026-07-09 じゃ。JST 暦日は必ず toJstDateString で求める。
  const startDate = toJstDateString(startAt)

  // 罠7: `end_at < start_at` は **null へ落とす**（`start_at` へ丸めない）。
  // 丸めると Google に無い「0 分の予定」という事実を捏造することになる。列は
  // nullable ゆえ「終了不明」を表現でき、かつ end_date も start_date へ戻るため
  // 壊れた終端が月グリッドの範囲クエリへ漏れ出さない。
  const endCandidate = isValidIsoDateTime(endDateTimeRaw)
    ? toIsoUtc(endDateTimeRaw)
    : null
  const endAt =
    endCandidate !== null &&
    new Date(endCandidate).getTime() >= new Date(startAt).getTime()
      ? endCandidate
      : null

  // 終端が 00:00 ちょうどの予定（23:00→翌 00:00）は end_date が翌日になる。
  // これは native 経路（calendar-validation の toJstDateString(endAt) === endDate）
  // と同一の振る舞いゆえ、ここで 1 日引くと同期と手入力が食い違う。意図的に揃える。
  const rawEndDate = endAt !== null ? toJstDateString(endAt) : startDate
  const endDate = rawEndDate < startDate ? startDate : rawEndDate

  return {
    ok: true,
    row: {
      ...common,
      is_all_day: false,
      start_date: startDate,
      end_date: endDate,
      start_at: startAt,
      end_at: endAt,
    },
  }
}

// ============================================================
// classifyEvent
// ============================================================

/**
 * 生イベントを delete / upsert / skip へ振り分ける。
 *
 * `status === 'cancelled'` は **`normalizeEvent` を呼ばずに** delete を返す
 * （cancelled は `start`/`end` を欠くことがあり、normalize が落ちる）。
 * 増分同期では `showDeleted` に依らず cancelled が必ず届く（計画書 §D-3）。
 */
export function classifyEvent(
  raw: GoogleRawEvent,
  ctx: GoogleSyncContext
): ClassifiedGoogleEvent {
  if (raw.status === "cancelled") {
    const googleEventId = optionalText(raw.id)
    // id 無しの cancelled は消すべき行を特定できない。undefined を delete へ
    // 流すと WHERE が壊れるため skip する。
    if (!googleEventId) {
      return { op: "skip", reason: "missing_google_event_id", googleEventId: null }
    }
    return { op: "delete", googleEventId }
  }

  const result = normalizeEvent(raw, ctx)
  if (!result.ok) {
    return { op: "skip", reason: result.reason, googleEventId: optionalText(raw.id) }
  }
  return { op: "upsert", event: result.row }
}

// ============================================================
// diffPage
// ============================================================

/**
 * 1 ページ分の生イベントを upsert / delete / skip へ振り分ける。
 *
 * skip は戻り値の `skipped[]`（機械可読）と `console.warn`（構造化ログ）の
 * **両方**で報告する。黙って落とすと「同期したのに出ない」が原因不明になる。
 */
export function diffPage(
  rawEvents: readonly GoogleRawEvent[],
  ctx: GoogleSyncContext
): GoogleSyncDiff {
  const upserts: GoogleCalendarEventRow[] = []
  const deletes: string[] = []
  const skipped: GoogleSyncSkip[] = []

  for (const raw of rawEvents) {
    const classified = classifyEvent(raw, ctx)
    if (classified.op === "upsert") {
      upserts.push(classified.event)
    } else if (classified.op === "delete") {
      deletes.push(classified.googleEventId)
    } else {
      skipped.push({
        googleEventId: classified.googleEventId,
        reason: classified.reason,
      })
      console.warn("[google-calendar-sync] 生イベントを取り込めず破棄", {
        reason: classified.reason,
        googleEventId: classified.googleEventId,
        googleCalendarId: ctx.googleCalendarId,
        householdId: ctx.householdId,
        subscriptionId: ctx.subscriptionId,
      })
    }
  }

  return { upserts, deletes, skipped }
}
