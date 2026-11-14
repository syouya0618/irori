/**
 * ごみの日（予定の用途）のドメイン。境界指令を持たぬ中立モジュール
 * （Server Component / Server Action / Client Component のどこからでも値 import できる）。
 *
 * ## 2 つの軸
 * 予定の**出どころ**（`source`: native / google）と**用途**（通常 / ごみ）は別の軸じゃ。
 * 用途は `calendar_events` の列ではなく別表 `event_purposes` に持ち、予定とは**鍵**で結ぶ
 * （行 id では結ばぬ — Google の 410 完全再同期は行を DELETE→INSERT し直し、行 id が変わる）:
 *
 * | scope    | 鍵                                                                 |
 * |----------|--------------------------------------------------------------------|
 * | `event`  | `event_uid`（native は行 id、google は `calendarId|eventId`）         |
 * | `series` | native は `series_id`、google は `calendarId|recurringEventId`       |
 *
 * scope を鍵に含めるのは、native の `series_id` が初回の行の id（= その行の event_uid）と
 * 同じ値になりうるためじゃ。同じ文字列でも scope が違えば別の分類として引く。
 *
 * ## 解決の順（SQL 側 `save_event_purpose` のコメントと対）
 * event 行の用途が在ればそれ（`normal` = この回だけ通常へ戻す例外）→ series 行 → 未分類。
 *
 * ## 「未分類」と「不明」を混ぜぬ
 * 分類を読めなかった時（取得の失敗・未知の値）は `unknown` を返す。`normal` と言い換えると、
 * ごみの日を「通常の予定」と偽る。タイトルから用途を推定することもせぬ（分類は利用者の操作だけ）。
 */
import { isRecord } from "@/lib/domain/child-sharing"
import { deriveRemindAtIso } from "@/lib/domain/event-reminder"
import { isClientId } from "@/lib/utils/client-id"
import { daysBetweenYmd, isValidYmd } from "@/lib/utils/date-jst"

// ───────────────────────── 分類の行 ─────────────────────────

/** `event_purposes` の SELECT 列（下の `parseEventPurposeRow` が読む一式）。 */
export const EVENT_PURPOSE_COLUMNS =
  "id, scope, target_key, purpose, garbage_kind, remind_default, reminder_opt_out, updated_at"

export type EventPurposeScope = "event" | "series"

/**
 * 行の用途。`other` は**このアプリがまだ知らぬ値**（DB の値域が先に増えた時）。
 * 未知の値を `normal` や `null` へ寄せると、知らぬ用途の予定を通常・未分類と偽るゆえ区別して運ぶ。
 */
export type EventPurposeKind = "garbage" | "normal" | "other" | null

export interface EventPurposeRow {
  id: string
  scope: EventPurposeScope
  targetKey: string
  purpose: EventPurposeKind
  /** ごみの名称（purpose が garbage の時だけ） */
  garbageKind: string | null
  /** series だけが持つ。今後の回へ前日 20:00 の通知を既定で付けるか（未知の値は null） */
  remindDefault: "prev_day_20" | "none" | null
  /** event だけが意味を持つ。この回の通知を明示的に止めた印 */
  reminderOptOut: boolean
  updatedAt: string | null
}

/**
 * DB の 1 行を読む。形が合わぬ行・未知の scope の行は null（**その行は無いものとして扱わず**、
 * 呼び出し側は `parseEventPurposeRows` の `unreadable` で「読めぬ行が在った」ことを知る）。
 */
export function parseEventPurposeRow(value: unknown): EventPurposeRow | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || value.id.length === 0) return null
  if (value.scope !== "event" && value.scope !== "series") return null
  if (typeof value.target_key !== "string" || value.target_key.length === 0) return null
  const rawPurpose = value.purpose
  let purpose: EventPurposeKind
  if (rawPurpose === null || rawPurpose === undefined) purpose = null
  else if (rawPurpose === "garbage" || rawPurpose === "normal") purpose = rawPurpose
  else purpose = "other"
  const garbageKind =
    typeof value.garbage_kind === "string" && value.garbage_kind.trim().length > 0
      ? value.garbage_kind.trim()
      : null
  // ごみなのに名称が無い行は、ごみとして出せぬ（名称を捏造せぬ）
  if (purpose === "garbage" && garbageKind === null) purpose = "other"
  return {
    id: value.id,
    scope: value.scope,
    targetKey: value.target_key,
    purpose,
    garbageKind: purpose === "garbage" ? garbageKind : null,
    remindDefault:
      value.remind_default === "prev_day_20" || value.remind_default === "none"
        ? value.remind_default
        : null,
    reminderOptOut: value.reminder_opt_out === true,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : null,
  }
}

/** DB の行の配列を読む。配列でなければ null（= 読めなかった。空とは言わぬ）。 */
export function parseEventPurposeRows(
  data: unknown,
): { rows: EventPurposeRow[]; unreadable: number } | null {
  if (!Array.isArray(data)) return null
  const rows: EventPurposeRow[] = []
  let unreadable = 0
  for (const item of data) {
    const row = parseEventPurposeRow(item)
    if (row) rows.push(row)
    else unreadable += 1
  }
  return { rows, unreadable }
}

/**
 * 画面へ渡す分類の取得結果。`failed` は「読めなかった」— 予定は表示し続け、分類は不明として扱う
 * （未分類と偽らぬ）。Server Component から Client Component へそのまま渡せる素の値。
 */
export type EventPurposeLoad =
  | { status: "ok"; rows: EventPurposeRow[] }
  | { status: "failed" }

/** 保存結果と、同じ利用者の権限で読み戻したごみ分類の状態。 */
export interface GarbageSaveSuccess {
  status: "saved" | "replayed" | "conflict"
  /** 読み戻せない時は failed。保存自体の成否とは別に扱う。 */
  purposeLoad?: EventPurposeLoad
}

/** Supabase の応答（data / error）から取得結果を組む。読めぬ行が混ざっておれば全体を不明にする。 */
export function eventPurposeLoadOf(data: unknown, failed: boolean): EventPurposeLoad {
  if (failed) return { status: "failed" }
  const parsed = parseEventPurposeRows(data)
  if (!parsed || parsed.unreadable > 0) return { status: "failed" }
  return { status: "ok", rows: parsed.rows }
}

// ───────────────────────── 予定の鍵 ─────────────────────────

/**
 * 予定の SELECT に、鍵を引くための**既存列**だけを足した一式は
 * `CALENDAR_EVENT_COLUMNS_WITH_KEYS`（`calendar-event-columns.ts`）。ここはその行の形。
 * どの列も optional: 作成直後の楽観行・古い呼び出し元は鍵の列を持たぬ。
 */
export interface EventKeyFields {
  id: string
  source: string
  series_id?: string | null
  event_uid?: string | null
  google_calendar_id?: string | null
  recurring_event_id?: string | null
}

/**
 * シリーズの鍵（SQL 側 `irori_private.event_series_key` の写し。ずれれば pgTAP の F-2 / C-2 と
 * このモジュールのテストが割れる）。単発は null。
 * google 以外は native として扱う（未知の source を名指しで弾かぬ = denylist）。
 */
export function seriesKeyOf(row: EventKeyFields): string | null {
  if (row.source === "google") {
    const recurring = row.recurring_event_id
    if (typeof recurring !== "string" || recurring.length === 0) return null
    const calendar = row.google_calendar_id
    if (typeof calendar !== "string" || calendar.length === 0) return null
    return `${calendar}|${recurring}`
  }
  return typeof row.series_id === "string" && row.series_id.length > 0 ? row.series_id : null
}

/**
 * 1 回の予定の鍵（`calendar_events.event_uid`）。列を持たぬ native の行は id で代える
 * （native の event_uid は id そのもの）。google の行で列が無ければ null（鍵を推測せぬ）。
 */
export function eventKeyOf(row: EventKeyFields): string | null {
  if (typeof row.event_uid === "string" && row.event_uid.length > 0) return row.event_uid
  if (row.source === "google") return null
  return typeof row.id === "string" && row.id.length > 0 ? row.id : null
}

// ───────────────────────── 解決 ─────────────────────────

/**
 * 画面がその予定について**見ておった分類の行の版**（`event_purposes.updated_at`。行が無ければ null）。
 * 保存の要求に載せ、RPC が今の版と比べる — 違っており、かつ適用すると何かが変わる時は conflict
 * （古い画面・古い控えの再送で、家族の新しい分類と通知を黙って消さぬ）。
 * 版は**表記の文字列のまま**運ぶ（`new Date()` を通すとマイクロ秒が落ち、以後の保存が全て衝突する）。
 */
export interface EventPurposeSeen {
  /** series 行（シリーズ既定）の版。単発・未分類は null */
  series: string | null
  /** event 行（この回だけの分類・通知の明示 OFF だけの行）の版。無ければ null */
  event: string | null
}

const NOTHING_SEEN: EventPurposeSeen = { series: null, event: null }

export type ResolvedEventPurpose =
  | {
      kind: "garbage"
      /** ごみの名称（「燃えるごみ」等） */
      label: string
      /** どの行で決まったか。event = この回だけの分類（単発、またはシリーズの単回例外） */
      scope: EventPurposeScope
      /** 決めた行の id */
      purposeId: string
      /** シリーズ既定の名称（この回がシリーズ既定を持つ時。scope が event なら「例外の元」） */
      seriesLabel: string | null
      /**
       * シリーズ既定の通知の既定（シリーズ既定が在る時）。`none` = シリーズ全体の通知を明示的に
       * 止めてある。null = シリーズ既定が無い、またはこのアプリが知らぬ値
       */
      seriesRemindDefault: "prev_day_20" | "none" | null
      /** この回の通知を明示的に止めておるか */
      reminderOptOut: boolean
      seen: EventPurposeSeen
    }
  | {
      kind: "normal"
      /** シリーズ既定を「この回だけ通常へ戻して」おるか（false = 何も分類しておらぬ） */
      exception: boolean
      seriesLabel: string | null
      seriesRemindDefault: "prev_day_20" | "none" | null
      seen: EventPurposeSeen
    }
  | { kind: "unknown" }

/** `(scope, 鍵)` → 行。scope を鍵に含める（series_id == 初回行 id の衝突を分ける）。 */
export type EventPurposeIndex = ReadonlyMap<string, EventPurposeRow>

function indexKey(scope: EventPurposeScope, targetKey: string): string {
  // 区切りに NUL を使う（鍵の文字列に現れぬ）
  return `${scope}\u0000${targetKey}`
}

export function buildEventPurposeIndex(rows: readonly EventPurposeRow[]): EventPurposeIndex {
  const index = new Map<string, EventPurposeRow>()
  for (const row of rows) index.set(indexKey(row.scope, row.targetKey), row)
  return index
}

function isIndex(value: readonly EventPurposeRow[] | EventPurposeIndex): value is EventPurposeIndex {
  return value instanceof Map
}

/**
 * 予定 1 件の用途を決める。
 *
 * @param purposes 世帯の分類（行の配列か、`buildEventPurposeIndex` の索引）。**null は「読めなかった」**
 *   — `unknown` を返す（未分類と偽らぬ）
 */
export function resolveEventPurpose(
  event: EventKeyFields,
  purposes: readonly EventPurposeRow[] | EventPurposeIndex | null,
): ResolvedEventPurpose {
  if (purposes === null) return { kind: "unknown" }
  const index = isIndex(purposes) ? purposes : buildEventPurposeIndex(purposes)

  const seriesKey = seriesKeyOf(event)
  const seriesRow = seriesKey !== null ? (index.get(indexKey("series", seriesKey)) ?? null) : null
  const seriesLabel = seriesRow?.purpose === "garbage" ? seriesRow.garbageKind : null
  const seriesRemindDefault = seriesRow?.purpose === "garbage" ? seriesRow.remindDefault : null

  const eventKey = eventKeyOf(event)
  // google の行で鍵の列が無い時は、この回の例外の有無を確かめられぬ
  if (eventKey === null && event.source === "google") return { kind: "unknown" }
  const eventRow = eventKey !== null ? (index.get(indexKey("event", eventKey)) ?? null) : null
  // 用途を持たぬ event 行（通知の明示 OFF だけ）も「見ておった行」に数える
  const seen: EventPurposeSeen = {
    series: seriesRow?.updatedAt ?? null,
    event: eventRow?.updatedAt ?? null,
  }

  if (eventRow && eventRow.purpose !== null) {
    if (eventRow.purpose === "garbage" && eventRow.garbageKind !== null) {
      return {
        kind: "garbage",
        label: eventRow.garbageKind,
        scope: "event",
        purposeId: eventRow.id,
        seriesLabel,
        seriesRemindDefault,
        reminderOptOut: eventRow.reminderOptOut,
        seen,
      }
    }
    if (eventRow.purpose === "normal") {
      return { kind: "normal", exception: true, seriesLabel, seriesRemindDefault, seen }
    }
    return { kind: "unknown" }
  }

  if (seriesRow) {
    if (seriesRow.purpose === "garbage" && seriesRow.garbageKind !== null) {
      return {
        kind: "garbage",
        label: seriesRow.garbageKind,
        scope: "series",
        purposeId: seriesRow.id,
        seriesLabel,
        seriesRemindDefault,
        reminderOptOut: eventRow?.reminderOptOut ?? false,
        seen,
      }
    }
    return { kind: "unknown" }
  }
  return { kind: "normal", exception: false, seriesLabel: null, seriesRemindDefault: null, seen }
}

/** 予定の配列へ用途を載せる（`purpose` 欄）。load が failed なら全件 `unknown`。 */
export function attachEventPurposes<T extends EventKeyFields>(
  events: readonly T[],
  load: EventPurposeLoad,
): (T & { purpose: ResolvedEventPurpose })[] {
  const index = load.status === "ok" ? buildEventPurposeIndex(load.rows) : null
  return events.map((event) => ({ ...event, purpose: resolveEventPurpose(event, index) }))
}

/** その予定がごみの日か（用途が載っておらぬ・不明・通常は false）。 */
export function garbageOf(event: {
  purpose?: ResolvedEventPurpose
}): Extract<ResolvedEventPurpose, { kind: "garbage" }> | null {
  return event.purpose?.kind === "garbage" ? event.purpose : null
}

// ───────────────────────── 名称と見た目 ─────────────────────────

/** 名称の上限（文字数。DB の `chk_event_purposes_kind_text` と同じ） */
export const GARBAGE_KIND_MAX = 20

/** 描画側（`garbage-kind-icon.tsx`）が Lucide のアイコンへ対応づける鍵。 */
export type GarbageIconKey =
  | "burnable"
  | "non-burnable"
  | "plastic"
  | "resource"
  | "bottle-can"
  | "pet-bottle"
  | "paper"
  | "bulky"
  | "generic"

export interface GarbageKindVisual {
  /** 月のマス等の狭い所に出す短い名称 */
  short: string
  icon: GarbageIconKey
  /** 色は補助（必ずアイコンと名称を併せて出す）。明暗を対で持つ */
  tone: { bg: string; text: string }
}

export interface GarbageKindPreset extends GarbageKindVisual {
  /** 保存する名称（`event_purposes.garbage_kind`） */
  label: string
}

/** 名称のプリセット。自治体ごとに呼び名が違うゆえ、どれにも当たらねば自由入力（1〜20 文字）。 */
export const GARBAGE_KIND_PRESETS: readonly GarbageKindPreset[] = [
  {
    label: "燃えるごみ",
    short: "燃える",
    icon: "burnable",
    tone: { bg: "bg-orange-100 dark:bg-orange-900/40", text: "text-orange-700 dark:text-orange-300" },
  },
  {
    label: "燃えないごみ",
    // 月のマス（390px 幅で 1 マス約 48px）に、アイコンと並べて収まる 3 文字以内にする
    short: "不燃",
    icon: "non-burnable",
    tone: { bg: "bg-slate-100 dark:bg-slate-800", text: "text-slate-700 dark:text-slate-300" },
  },
  {
    label: "プラスチック",
    short: "プラ",
    icon: "plastic",
    tone: { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-300" },
  },
  {
    label: "資源",
    short: "資源",
    icon: "resource",
    tone: { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-300" },
  },
  {
    label: "びん・缶",
    short: "びん缶",
    icon: "bottle-can",
    tone: { bg: "bg-teal-100 dark:bg-teal-900/40", text: "text-teal-700 dark:text-teal-300" },
  },
  {
    label: "ペットボトル",
    short: "ペット",
    icon: "pet-bottle",
    tone: { bg: "bg-cyan-100 dark:bg-cyan-900/40", text: "text-cyan-700 dark:text-cyan-300" },
  },
  {
    label: "古紙",
    short: "古紙",
    icon: "paper",
    tone: { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-300" },
  },
  {
    label: "粗大ごみ",
    short: "粗大",
    icon: "bulky",
    tone: { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-300" },
  },
]

/** プリセットに無い名称（自由入力・将来の値）の退化形。 */
const GENERIC_TONE = {
  bg: "bg-gray-100 dark:bg-gray-800",
  text: "text-gray-700 dark:text-gray-300",
} as const

/**
 * 短い名称の文字数（自由入力の名称を月のマスへ出す時）。マスは狭い（390px 幅で約 48px）ゆえ、
 * アイコン（10px）と並べて切れずに収まる 3 文字にする。正確な名称はマスの読み上げと一覧が運ぶ。
 */
export const GARBAGE_SHORT_LABEL_CHARS = 3
const SHORT_LABEL_CHARS = GARBAGE_SHORT_LABEL_CHARS

function codePoints(text: string): string[] {
  return Array.from(text)
}

/**
 * 名称を検証して整える（前後の空白を除き、1〜20 文字）。合わねば null。
 * 文字数は DB の `char_length` と同じく符号点で数える。制御文字（改行・タブ等）を含む名称は拒む。
 */
export function normalizeGarbageKind(input: unknown): string | null {
  if (typeof input !== "string") return null
  const trimmed = input.trim()
  if (trimmed.length === 0) return null
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  const length = codePoints(trimmed).length
  return length >= 1 && length <= GARBAGE_KIND_MAX ? trimmed : null
}

/** 名称 → 見た目。プリセットに無い名称（未知の値を含む）は汎用の見た目へ退化する。 */
export function garbageKindVisual(label: string | null | undefined): GarbageKindVisual {
  const name = typeof label === "string" ? label.trim() : ""
  const preset = GARBAGE_KIND_PRESETS.find((p) => p.label === name)
  if (preset) return { short: preset.short, icon: preset.icon, tone: preset.tone }
  return {
    short: name.length > 0 ? codePoints(name).slice(0, SHORT_LABEL_CHARS).join("") : "ごみ",
    icon: "generic",
    tone: GENERIC_TONE,
  }
}

/** 読み上げ・一覧に出す種別の文（色やアイコンが見えずとも種別が分かる）。 */
export function garbageAriaLabel(labels: readonly string[]): string {
  const unique = Array.from(new Set(labels.filter((l) => l.length > 0)))
  return unique.length > 0 ? `ごみ（${unique.join("、")}）` : "ごみ"
}

// ───────────────────────── 分類の操作 ─────────────────────────

export const GARBAGE_SCOPES = ["event", "series"] as const
export const GARBAGE_ACTIONS = ["garbage", "normal", "clear"] as const
export type GarbageAction = (typeof GARBAGE_ACTIONS)[number]

/**
 * 今回の保存で通知をどう扱うか（フォームに明示して選ばせる）。
 * - `prev_day_20` … 通知が未設定の回へ前日 20:00 を足す。**設定済みの回は変えぬ**
 * - `off` … 通知を止める（event はその回、series は今日以降の全ての回）
 * - `keep` … 通知設定に触れぬ
 */
export const GARBAGE_REMINDERS = ["prev_day_20", "off", "keep"] as const
export type GarbageReminderChoice = (typeof GARBAGE_REMINDERS)[number]

/** 新しくごみに分類する時の初期選択（前日 20:00）。 */
export const GARBAGE_DEFAULT_REMINDER: GarbageReminderChoice = "prev_day_20"

/** Server Action `submitGarbageRequest` の入力（端末の控えにもこの形のまま残す）。 */
export type GarbageRequest =
  | {
      op: "save"
      /** 操作の起点にした予定の行 id。鍵はサーバが引く（クライアントは鍵も世帯も送らぬ） */
      eventId: string
      scope: EventPurposeScope
      action: GarbageAction
      /** action が garbage の時だけ（整えた名称）。それ以外は null */
      garbageKind: string | null
      reminder: GarbageReminderChoice
      /**
       * 画面がこの操作を組んだ時に見ておった分類の行の版（フォームを開いた時点で固定する）。
       * RPC は今の版と違い、かつ適用すると何かが変わる時に conflict を返す。端末の控えにも
       * このまま残るゆえ、後からの「同じ操作で確認」が家族の新しい分類を消さぬ
       */
      seen: EventPurposeSeen
    }
  | {
      op: "delete-orphan"
      /** 予定が見つからぬ分類の行 id */
      purposeId: string
    }

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value)
}

/** `updated_at` の表記（PostgREST の timestamptz。秒の小数は 0〜6 桁）。DB へ渡す前に形を確かめる */
const VERSION_SHAPE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

function isSeenVersion(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && VERSION_SHAPE.test(value))
}

function isEventPurposeSeen(value: unknown): value is EventPurposeSeen {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isSeenVersion(value.series) &&
    isSeenVersion(value.event)
  )
}

/**
 * 入力の型ガード（画面・Server Action・端末の控えの復元の 3 箇所が同じものを通す）。
 * DB の RPC の検証（22023）と同じ契約の写し。**余分な項目（household_id 等）を持つ値は拒む**
 * — 送った覚えの無い項目を黙って捨てて通さぬ。
 */
export function isGarbageRequest(value: unknown): value is GarbageRequest {
  if (!isRecord(value)) return false
  if (value.op === "delete-orphan") {
    return Object.keys(value).length === 2 && isClientId(value.purposeId)
  }
  if (value.op !== "save") return false
  if (Object.keys(value).length !== 7) return false
  // 見ておった版を持たぬ要求は通さぬ（版なしで送れば、古い控えの再送が家族の変更を上書きする）
  if (!isEventPurposeSeen(value.seen)) return false
  if (!isClientId(value.eventId)) return false
  if (!isOneOf(value.scope, GARBAGE_SCOPES)) return false
  if (!isOneOf(value.action, GARBAGE_ACTIONS)) return false
  if (!isOneOf(value.reminder, GARBAGE_REMINDERS)) return false
  if (value.action === "normal" && value.scope !== "event") return false
  if (value.action === "clear" && value.reminder === "prev_day_20") return false
  if (value.action === "garbage") {
    return typeof value.garbageKind === "string" && normalizeGarbageKind(value.garbageKind) === value.garbageKind
  }
  return value.garbageKind === null
}

// ───────────────────────── 収集日と整理 ─────────────────────────

/** 今日から見た収集日の近さ（「今日」「明日」「あさって」「N日後」）。過去・不正は null。 */
export function collectionDayRelativeLabel(ymd: string, today: string): string | null {
  if (!isValidYmd(ymd) || !isValidYmd(today)) return null
  const days = daysBetweenYmd(today, ymd)
  if (days === null || days < 0) return null
  if (days === 0) return "今日"
  if (days === 1) return "明日"
  if (days === 2) return "あさって"
  return `${days}日後`
}

export interface GarbageCollection<T> {
  event: T
  /** 収集日（今日より前に始まった複数日の予定は今日） */
  date: string
  label: string
  scope: EventPurposeScope
}

/**
 * 今日以降の収集日を近い順に並べる（同じ日は終日 → 開始時刻 → 名称）。
 * ごみに解決できた予定だけを載せる（不明・通常は載せぬ）。
 */
export function upcomingGarbageCollections<
  T extends EventKeyFields & {
    start_date: string
    end_date: string
    is_all_day: boolean
    start_at: string | null
    purpose?: ResolvedEventPurpose
  },
>(events: readonly T[], today: string, limit?: number): GarbageCollection<T>[] {
  const list: GarbageCollection<T>[] = []
  for (const event of events) {
    const garbage = garbageOf(event)
    if (!garbage) continue
    if (!isValidYmd(event.start_date) || !isValidYmd(event.end_date)) continue
    if (event.end_date < today) continue
    list.push({
      event,
      date: event.start_date < today ? today : event.start_date,
      label: garbage.label,
      scope: garbage.scope,
    })
  }
  list.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.event.is_all_day !== b.event.is_all_day) return a.event.is_all_day ? -1 : 1
    const at = a.event.start_at ?? ""
    const bt = b.event.start_at ?? ""
    if (at !== bt) return at < bt ? -1 : 1
    return a.label.localeCompare(b.label, "ja")
  })
  return limit === undefined ? list : list.slice(0, Math.max(0, limit))
}

/**
 * 予定が見つからぬ分類（孤児）を探す。`events` は**その鍵を持つ予定を世帯の全期間から引いた結果**で
 * あること（月の窓だけを渡すと、窓の外に予定が在る分類を孤児と誤る）。
 *
 * 用途を持たぬ行（通知の明示 OFF だけの行）は対象にせぬ。孤児は「消してよい」ではない —
 * Google の同期中は予定が一時的に消える。画面は「予定が見つかりません（同期中の可能性があります）」
 * と出し、整理は利用者の操作に任せる。
 */
export function findOrphanPurposes(
  rows: readonly EventPurposeRow[],
  events: readonly EventKeyFields[],
): EventPurposeRow[] {
  const eventKeys = new Set<string>()
  const seriesKeys = new Set<string>()
  for (const event of events) {
    const eventKey = eventKeyOf(event)
    if (eventKey !== null) eventKeys.add(eventKey)
    const seriesKey = seriesKeyOf(event)
    if (seriesKey !== null) seriesKeys.add(seriesKey)
  }
  return rows.filter((row) => {
    if (row.purpose === null) return false
    return row.scope === "event" ? !eventKeys.has(row.targetKey) : !seriesKeys.has(row.targetKey)
  })
}

// ───────────────────────── 操作の文言 ─────────────────────────

/**
 * 用途の載っておらぬ予定（楽観行・分類の無い世帯）は「何も分類しておらぬ通常の予定」として扱う。
 * 見ておった版は「行なし」— 実際には家族が分類しておれば、保存は RPC が conflict で止める。
 */
export const UNCLASSIFIED_PURPOSE: ResolvedEventPurpose = {
  kind: "normal",
  exception: false,
  seriesLabel: null,
  seriesRemindDefault: null,
  seen: NOTHING_SEEN,
}

function requestSubject(title: string | null): string {
  const name = codePoints((title ?? "").trim()).slice(0, 24).join("")
  return name.length > 0 ? `「${name}」` : "予定"
}

/** 端末の控え・確認の一覧に出す操作の説明（`chore-pending` の label。80 文字以内に収める）。 */
export function garbageRequestLabel(request: GarbageRequest, title: string | null): string {
  if (request.op === "delete-orphan") return "予定が見つからない分類を整理"
  const subject = requestSubject(title)
  const range = request.scope === "series" ? "（シリーズ全体）" : ""
  if (request.action === "garbage") {
    return `${subject}をごみの日（${request.garbageKind ?? ""}）にする${range}`
  }
  if (request.action === "normal") return `${subject}をこの回だけ通常の予定に戻す`
  return `${subject}のごみの分類を解除${range}`
}

/**
 * 「この回の通知だけ止める」の控えの説明。要求の形は「この回だけの分類の解除 + 通知を止める」と
 * 同じ（`event` / `clear` / `off`）ゆえ、`garbageRequestLabel` では「分類を解除」と出てしまう —
 * 分類は変えぬ操作じゃから、フォームがこちらを使う。
 */
export function garbageMuteLabel(title: string | null): string {
  return `${requestSubject(title)}のこの回の通知を止める`
}

/**
 * その日の予定の「前日 20:00（JST）」が、もう過ぎておるか。過ぎた時刻の通知は配信されぬ
 * （配信は `remind_at` が直近の窓に在るものだけを送る）。予定のシートの通知の欄と同じ基準
 * （許容 0 分）。日付が不正なら null（どちらとも言わぬ）。
 */
export function prevDayReminderPassed(startDate: string, now: Date): boolean | null {
  if (!isValidYmd(startDate)) return null
  const iso = deriveRemindAtIso({ isAllDay: true, startDate, startAt: null }, "prev_day_20")
  if (iso === null) return null
  const at = new Date(iso).getTime()
  const nowMs = now.getTime()
  if (Number.isNaN(at) || Number.isNaN(nowMs)) return null
  return at <= nowMs
}

/**
 * 今回の保存で通知がどうなるかの説明（フォームに常に出す。利用者が保存の前に読める）。
 * SQL 側 `save_event_purpose` の p_reminder の振る舞いの写し。
 *
 * @param prevDayPassed 起点の回の前日 20:00 がもう過ぎておるか（`prevDayReminderPassed`）。
 *   過ぎておれば「通知します」と言わず、届かぬことを言う（設定の行は入るが、配信はされぬ）
 */
export function garbageReminderEffect(
  reminder: GarbageReminderChoice,
  scope: EventPurposeScope,
  prevDayPassed: boolean = false,
): string {
  if (reminder === "prev_day_20") {
    if (scope === "series") {
      return (
        "今日以降のすべての回と、これから追加される回に、前日 20:00 の通知を付けます。すでに通知を設定している回の時刻と、個別に通知を止めた回は変えません。" +
        (prevDayPassed
          ? "この回は前日 20:00 をすでに過ぎているため、この回の通知は届きません（次の回から届きます）。"
          : "前日 20:00 をすでに過ぎている回には届きません。")
      )
    }
    return prevDayPassed
      ? "この予定の前日 20:00 はすでに過ぎているため、これから通知は届きません。すでに通知を設定している場合は、その時刻のまま変えません。"
      : "この予定の前日 20:00 に通知します。すでに通知を設定している場合は、その時刻のまま変えません。"
  }
  if (reminder === "off") {
    return scope === "series"
      ? "今日以降のすべての回の通知を止めます（個別に設定した通知も消えます）。これから追加される回にも付けません。"
      : "この予定の通知を止めます。"
  }
  return "通知の設定は今のまま変えません。"
}

/** 「この回の通知だけ止める」で何が起きるかの説明（分類は変えぬことを言う）。 */
export const GARBAGE_MUTE_EFFECT =
  "この回の通知だけを止めます。ごみの日の分類は変えません。あとでシリーズ全体の通知を付け直しても、この回には付けません（戻すには、カレンダーでこの予定を開いて通知を選びます）。"

// ───────────────────────── ごみの画面（/chores/garbage）の組み立て ─────────────────────────

/** ごみの画面が読む予定の列（`CALENDAR_EVENT_COLUMNS_WITH_KEYS` の部分集合。既存の列だけ）。 */
export const GARBAGE_EVENT_COLUMNS =
  "id, title, is_all_day, start_date, end_date, start_at, source, series_id, medical_record_id, event_uid, google_calendar_id, recurring_event_id"

export interface GarbageEventRow extends EventKeyFields {
  title: string
  is_all_day: boolean
  start_date: string
  end_date: string
  start_at: string | null
  series_id: string | null
  medical_record_id?: string | null
}

/** DB の 1 行を予定として読む。形が合わねば null（呼び出し側は「読めなかった」として扱う）。 */
export function parseGarbageEventRow(value: unknown): GarbageEventRow | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== "string" || value.id.length === 0) return null
  if (typeof value.title !== "string") return null
  if (typeof value.is_all_day !== "boolean") return null
  if (!isValidYmd(value.start_date as string) || !isValidYmd(value.end_date as string)) return null
  if (typeof value.source !== "string") return null
  const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
  return {
    id: value.id,
    title: value.title,
    is_all_day: value.is_all_day,
    start_date: value.start_date as string,
    end_date: value.end_date as string,
    start_at: text(value.start_at),
    source: value.source,
    series_id: text(value.series_id),
    medical_record_id: text(value.medical_record_id),
    event_uid: text(value.event_uid),
    google_calendar_id: text(value.google_calendar_id),
    recurring_event_id: text(value.recurring_event_id),
  }
}

/** 画面へ渡す予定の要約（Server → Client。素の値だけ）。 */
export interface GarbageEventSummary {
  id: string
  title: string
  source: string
  /** その予定が繰り返し（シリーズ）の 1 回か */
  isSeries: boolean
  is_all_day: boolean
  start_date: string
  end_date: string
  start_at: string | null
  /** 通知設定を引く鍵（event_uid）。google の行で列を読めなんだ時は null */
  eventKey: string | null
}

function summarize(event: GarbageEventRow): GarbageEventSummary {
  return {
    id: event.id,
    title: event.title,
    source: event.source,
    isSeries: seriesKeyOf(event) !== null,
    is_all_day: event.is_all_day,
    start_date: event.start_date,
    end_date: event.end_date,
    start_at: event.start_at,
    eventKey: eventKeyOf(event),
  }
}

/** 既存カレンダー予定から提案する、ごみ分類の候補。推測だけでは保存しない。 */
export interface GarbageCandidate {
  event: GarbageEventSummary
  current: Extract<ResolvedEventPurpose, { kind: "normal" }>
  /** 題から推した名称（プリセットの名称）。表示と一括分類の初期選択だけに使い、保存は利用者の確認の後 */
  suggestedKind: string | null
}

/** 候補を探す期間内の上限（近い順）。超えた分は「ほかにも在る」と言う */
export const GARBAGE_CANDIDATE_LIMIT = 20

/**
 * 収集日らしい題。「プラ」は「プラン」「プライベート」等と紛れぬよう、後ろに片仮名が続かぬ時だけ。
 * びん・缶はどちらの順・区切り（・／、と 等）・表記（ビン・カン・瓶）も拾う。
 */
const CANDIDATE_TITLE =
  /ごみ|ゴミ|可燃|不燃|資源|古紙|ペットボトル|プラスチック|プラ(?![ァ-ヶー])|(?:びん|ビン|瓶)\s*[・･/／、,，&＆と]?\s*(?:缶|カン|かん)|(?:缶|カン)\s*[・･/／、,，&＆と]?\s*(?:びん|ビン|瓶)|空き(?:缶|かん|びん|ビン|瓶)/

/** 収集日ではない家事・用事（ごみ箱の掃除・袋の買い物・当番・ごみ拾い・見学・分別の調べもの）。 */
const NOT_COLLECTION_TITLE =
  /(?:ごみ|ゴミ)\s*(?:箱|ばこ|袋|ぶくろ)|当番|拾い|ひろい|見学|分別\s*(?:を|の)?\s*(?:調べ|確認|方法|表)|買う|買い物|購入|掃除|そうじ|洗う|あらう/

/** 題 → 名称のプリセット（当たる規則がちょうど 1 つの時だけ推す）。 */
const CANDIDATE_KIND_RULES: readonly (readonly [RegExp, string])[] = [
  [/燃えない|燃やせない|不燃/, "燃えないごみ"],
  [/燃える|燃やす|燃やせる|可燃/, "燃えるごみ"],
  [/ペットボトル/, "ペットボトル"],
  [/プラスチック|プラ(?![ァ-ヶー])/, "プラスチック"],
  [/(?:びん|ビン|瓶)[\s\S]*?(?:缶|カン|かん)|(?:缶|カン)[\s\S]*?(?:びん|ビン|瓶)|空き(?:缶|かん|びん|ビン|瓶)/, "びん・缶"],
  [/古紙|新聞|雑誌|段ボール|ダンボール/, "古紙"],
  [/粗大/, "粗大ごみ"],
  [/資源/, "資源"],
]

/** 予定の題が、ごみの収集日の候補に見えるか（読み取り専用の推定。これだけでは何も保存せぬ）。 */
export function looksLikeGarbageCollection(title: string): boolean {
  const text = title.trim()
  return CANDIDATE_TITLE.test(text) && !NOT_COLLECTION_TITLE.test(text)
}

/**
 * 題から推した名称のプリセット。当たらねば null。複数の種類に当たる題（「資源ごみ（びん・缶・ペットボトル）」等）も
 * null — 狭い名称を初期選択にして、まとめての分類で確かめずに保存させぬ。
 */
export function suggestGarbageKind(title: string): string | null {
  const text = title.trim()
  const matched = CANDIDATE_KIND_RULES.filter(([pattern]) => pattern.test(text))
  return matched.length === 1 ? matched[0][1] : null
}

/**
 * 直近の予定から候補を探す（読み取り専用）。Google再同期でも同じ繰り返しは1候補に畳む。
 * 「ごみ箱を洗う」等の家事は除外。種別は推定表示のみで、分類RPCへは利用者の選択が必要。
 *
 * 分類・通知の明示 OFF の行が在る予定は候補にせぬ（利用者が既に判断した予定。見るのは期間内の回とシリーズの既定だけ。
 * 繰り返しは、期間内のどれか 1 回にでも行が在れば、そのシリーズごと出さぬ）。
 */
export function suggestGarbageCandidates(
  events: readonly GarbageEventRow[],
  purposeRows: readonly EventPurposeRow[],
  limit = GARBAGE_CANDIDATE_LIMIT,
): GarbageCandidate[] {
  const index = buildEventPurposeIndex(purposeRows)
  const result: GarbageCandidate[] = []
  const seen = new Set<string>()
  const sorted = [...events].sort((a, b) =>
    a.start_date === b.start_date ? a.id.localeCompare(b.id) : a.start_date.localeCompare(b.start_date)
  )
  const resolved = sorted.map((event) => ({ event, purpose: resolveEventPurpose(event, index) }))
  // 分類の行（シリーズの既定・どれか 1 回の行）が在るシリーズ
  const touchedSeries = new Set<string>()
  for (const { event, purpose } of resolved) {
    const seriesKey = seriesKeyOf(event)
    if (seriesKey === null) continue
    if (purpose.kind !== "normal" || purpose.exception || purpose.seen.series !== null || purpose.seen.event !== null) {
      touchedSeries.add(seriesKey)
    }
  }
  for (const { event, purpose } of resolved) {
    if (result.length >= Math.max(0, limit)) break
    if (event.medical_record_id) continue
    if (!looksLikeGarbageCollection(event.title)) continue
    if (purpose.kind !== "normal" || purpose.exception) continue
    if (purpose.seen.series !== null || purpose.seen.event !== null) continue
    const seriesKey = seriesKeyOf(event)
    if (seriesKey !== null && touchedSeries.has(seriesKey)) continue
    const eventKey = eventKeyOf(event)
    if (eventKey === null) continue
    const groupKey = seriesKey ? `series:\u0000${seriesKey}` : `event:\u0000${eventKey}`
    if (seen.has(groupKey)) continue
    seen.add(groupKey)
    result.push({ event: summarize(event), current: purpose, suggestedKind: suggestGarbageKind(event.title) })
  }
  return result
}

/** 次の収集日の 1 行。 */
export interface GarbageCollectionView {
  event: GarbageEventSummary
  /** 収集日（今日より前に始まった複数日の予定は今日） */
  date: string
  label: string
  /** どの分類で決まったか（series = シリーズ既定 / event = この回だけ） */
  scope: EventPurposeScope
  purpose: ResolvedEventPurpose
}

/**
 * 分類の一覧の 1 行。
 * - `linked` … 予定が在る（`anchor` を起点に変更・解除できる）
 * - `orphan` … その鍵を持つ予定が世帯に 1 つも見つからぬ（同期中の可能性がある。手動で整理できる）
 * - `unchecked` … 予定の有無を確かめられなんだ（「見つからぬ」とは言わぬ）
 */
export interface GarbagePurposeEntry {
  row: EventPurposeRow
  state: "linked" | "orphan" | "unchecked"
  /** 操作の起点にする予定（今後の最初の回。無ければ見つかった最後の回） */
  anchor: GarbageEventSummary | null
  /** 起点の予定の今の用途（フォームの初期値。起点が無ければ null） */
  anchorPurpose: ResolvedEventPurpose | null
  /** 次の収集日（期間内に今後の回が在る時） */
  nextDate: string | null
  /** この分類が効いておる今後の回の数（期間内） */
  upcomingCount: number
}

export interface GarbageOverview {
  collections: GarbageCollectionView[]
  /** `collections` に載せ切れなんだ収集日の数（上限で切った分） */
  moreCollections: number
  entries: GarbagePurposeEntry[]
}

/** 分類の一覧の鍵（`(scope, 鍵)`）。予定の有無を確かめられなんだ分類を名指しするのに使う。 */
export function purposeLookupKey(scope: EventPurposeScope, targetKey: string): string {
  return indexKey(scope, targetKey)
}

/**
 * ごみの画面の中身を組む純関数。
 *
 * @param rows 世帯の分類の全行
 * @param windowEvents 今日以降の一定期間の予定（今後の収集日の元）
 * @param anchorEvents 期間内に予定が見つからなんだ分類について、鍵で引いた予定（全期間。0〜1 件ずつ）
 * @param unchecked 鍵で引く問い合わせが失敗した分類（`purposeLookupKey`）。孤児とは言わぬ
 */
export function buildGarbageOverview(input: {
  rows: readonly EventPurposeRow[]
  windowEvents: readonly GarbageEventRow[]
  anchorEvents: readonly GarbageEventRow[]
  unchecked: ReadonlySet<string>
  today: string
  collectionLimit: number
}): GarbageOverview {
  const { rows, today } = input
  const index = buildEventPurposeIndex(rows)
  // 健診・予防接種の予定は分類の対象外（RPC も拒む）
  const classifiable = input.windowEvents.filter((e) => !e.medical_record_id)
  const resolved = classifiable.map((event) => ({ ...event, purpose: resolveEventPurpose(event, index) }))
  const upcoming = upcomingGarbageCollections(resolved, today)
  const collections: GarbageCollectionView[] = upcoming
    .slice(0, Math.max(0, input.collectionLimit))
    .map((c) => ({
      event: summarize(c.event),
      date: c.date,
      label: c.label,
      scope: c.scope,
      purpose: c.event.purpose,
    }))

  // 期間内の今後の回を、分類の鍵ごとに集める（start_date の昇順で渡される前提に頼らず並べ直す）
  const future = resolved
    .filter((e) => e.end_date >= today)
    .sort((a, b) => (a.start_date === b.start_date ? 0 : a.start_date < b.start_date ? -1 : 1))
  const anchors = input.anchorEvents.filter((e) => !e.medical_record_id)

  const entries: GarbagePurposeEntry[] = []
  for (const row of rows) {
    // 用途を持たぬ行（通知の明示 OFF だけ）は分類ではない
    if (row.purpose === null) continue
    const matches = (event: GarbageEventRow) =>
      row.scope === "event" ? eventKeyOf(event) === row.targetKey : seriesKeyOf(event) === row.targetKey
    // 鍵が合う今後の回（操作の起点にできる。この回だけ別の分類にした回も含む）
    const upcomingMatches = future.filter(matches)
    // そのうち、**この行の分類が実際に効いておる回**。シリーズ既定の行では、この回だけ通常へ
    // 戻した回・この回だけ別の名称にした回を数えぬ（収集の無い日を「次の収集日」と告げぬ）
    const inEffect =
      row.scope === "series"
        ? upcomingMatches.filter(
            (e) => e.purpose.kind === "garbage" && e.purpose.scope === "series" && e.purpose.purposeId === row.id,
          )
        : upcomingMatches
    // 起点は、分類が効いておる回を優先する（無ければシリーズのどの回でもよい）
    const anchor = inEffect[0] ?? upcomingMatches[0] ?? anchors.find(matches) ?? null
    const next = inEffect[0] ?? null
    entries.push({
      row,
      state: anchor
        ? "linked"
        : input.unchecked.has(indexKey(row.scope, row.targetKey))
          ? "unchecked"
          : "orphan",
      anchor: anchor ? summarize(anchor) : null,
      anchorPurpose: anchor ? resolveEventPurpose(anchor, index) : null,
      nextDate: next ? (next.start_date < today ? today : next.start_date) : null,
      upcomingCount: inEffect.length,
    })
  }
  // シリーズ既定 → この回だけ、次の収集日の近い順（無いものは後ろ）、名称
  entries.sort((a, b) => {
    if (a.row.scope !== b.row.scope) return a.row.scope === "series" ? -1 : 1
    const an = a.nextDate ?? "9999-12-31"
    const bn = b.nextDate ?? "9999-12-31"
    if (an !== bn) return an < bn ? -1 : 1
    return (a.row.garbageKind ?? "").localeCompare(b.row.garbageKind ?? "", "ja") || a.row.id.localeCompare(b.row.id)
  })
  return {
    collections,
    moreCollections: Math.max(0, upcoming.length - collections.length),
    entries,
  }
}
