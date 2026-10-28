import { isValidYmd, shiftYmd, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import type { BabyLogKeysetCursor } from "@/lib/domain/baby-log-keyset"

/**
 * 育児ログ・日記の機械可読エクスポート（機能 D）の純粋な部分。
 *
 * - 対象範囲（期間）・日時の意味（UTC ISO と JST 暦日）・単位・schema version を本文に持ち、
 *   受け取った側が前提を推測せずに済む形にする
 * - 取りこぼしは隠さぬ: 上限に達したら `complete: false` と `truncated_at` を付ける
 * - 公開 URL の発行・自動送信・取り込み（復元）はしない（指示 §8 D）
 */

export const EXPORT_SCHEMA_VERSION = 1

/**
 * 応答本文のバイト予算。Vercel Functions の応答上限は 4.5MB（超えると 500
 * FUNCTION_RESPONSE_PAYLOAD_TOO_LARGE）ゆえ、記録と日記に分けて余裕を残した予算を置き、
 * 超える分は「切り詰め」として明示する（streaming はせず、上限に当たる前に止める）。
 * 1 行 300〜400 bytes（compact JSON）なら記録 8,000〜10,000 行が入る。
 */
export const EXPORT_LOGS_BYTE_BUDGET = 3_200_000
export const EXPORT_DIARIES_BYTE_BUDGET = 800_000

const utf8 = new TextEncoder()

/** compact JSON にした時のバイト長（日本語は 1 文字 3 bytes。文字数で見積もると過小） */
export function jsonByteLength(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length
}

/**
 * 行を先頭から足していき、予算（bytes）を超えぬ件数を返す。`used` は既に積んだ分。
 * 区切りの `,` を 1 byte ずつ足す。1 件も入らねば count=0（呼び出し側が切り詰めと判断）。
 */
export function countWithinByteBudget(
  rows: readonly unknown[],
  budget: number,
  used = 0,
): { count: number; used: number } {
  let count = 0
  let total = used
  for (const row of rows) {
    const next = total + jsonByteLength(row) + 1
    if (next > budget) break
    total = next
    count++
  }
  return { count, used: total }
}

export const EXPORT_PERIODS = ["1week", "1month", "3months", "all"] as const
export type ExportPeriod = (typeof EXPORT_PERIODS)[number]

export function isExportPeriod(value: string | null): value is ExportPeriod {
  return value !== null && (EXPORT_PERIODS as readonly string[]).includes(value)
}

/**
 * 期間の境界。`from` は含む暦日（JST）、`to` は含む暦日（今日）。`all` は from が無い。
 * 1 週間 = 今日を含む直近 8 日ではなく、PDF と同じ「今日 − 7 日 〜 今日」（両端含む）。
 */
export function resolveExportRange(
  period: ExportPeriod,
  today: string,
): { from: string | null; to: string } {
  switch (period) {
    case "1week":
      return { from: shiftYmd(today, -7), to: today }
    case "1month":
      return { from: shiftYmd(today, -30), to: today }
    case "3months":
      return { from: shiftYmd(today, -90), to: today }
    case "all":
      return { from: null, to: today }
  }
}

/** 表計算や他アプリが列の意味を取り違えぬよう、数値列の単位を本文に書く */
export const EXPORT_UNITS = {
  amount_ml: "ml",
  temperature: "celsius",
  weight_g: "g",
  height_cm: "cm",
  duration_sec: "seconds",
  duration_min: "minutes (rounded from duration_sec)",
  breast_left_sec: "seconds",
  breast_right_sec: "seconds",
  breast_left_count: "count",
  breast_right_count: "count",
} as const

export interface ExportLogRow extends BabyLogData {
  /** logged_at の JST 暦日（YYYY-MM-DD）。画面の「その日の記録」と同じ区切り */
  logged_at_jst_date: string
}

export interface ExportDiaryRow {
  id: string
  diary_date: string
  content: string
  updated_at: string
}

export interface ExportDocument {
  schema_version: number
  app: "irori"
  exported_at: string
  timezone: "Asia/Tokyo"
  /** 全ての timestamp 列は UTC の ISO 8601。暦日（*_jst_date, diary_date）は JST */
  timestamps: "UTC ISO 8601; *_date fields are JST calendar days"
  period: { key: ExportPeriod; from: string | null; to: string }
  household: { baby_name: string | null; baby_birth_date: string | null }
  /** logged_by を名前へ引くための世帯員（現在の世帯員のみ。退出済みは含まれぬ） */
  members: { id: string; display_name: string }[]
  units: typeof EXPORT_UNITS
  counts: { logs: number; diaries: number }
  /** 上限に達して一部しか含まぬなら false。受け取った側が全件と誤読せぬため */
  complete: boolean
  /** 記録が切り詰められた時、ここより後（logged_at 昇順）の記録を含まぬ。記録が全件なら null */
  truncated_after: string | null
  /** 日記が切り詰められた時、ここより後（diary_date 昇順）の日記を含まぬ。日記が全件なら null */
  diaries_truncated_after: string | null
  logs: ExportLogRow[]
  diaries: ExportDiaryRow[]
  /**
   * 分割回収（2026-10-27 追加。schema_version 1 のまま足した欄）。この書き出しが何番目の続きで、
   * 続きを取るには何を送ればよいか。`next` が null なら、この範囲はここで終わり。
   */
  part: ExportPartInfo
  /** 整合性の限界（利用者・受け取った側へ。同時点の snapshot ではない） */
  consistency_note: string
}

export interface ExportPartInfo {
  /** 続きの要求か（最初の 1 回は false） */
  continuation: boolean
  /** この書き出しが始まった位置（最初は null。"end" はその表を取り終えておった） */
  logs_after: string | null
  diaries_after: string | null
  /** 続きの要求に送る値。全部取り終えたら null。表ごとに取り終えたら "end" */
  next: { logs_after: string; diaries_after: string } | null
  /**
   * 分けた書き出しの最後の部分か（next が null）。最後の部分でも、そのファイル単独では範囲の全件では
   * ないゆえ `complete` は false のまま — 全体は第 1 部から最後の部分までを合わせたもの
   */
  is_last: boolean
}

/**
 * 整合性の限界の文言（本文・画面で共有）。ページの取得は別々の問い合わせゆえ、取得の最中に家族が
 * 記録を足す・直す・消すと、その差は書き出しに入ったり入らなかったりする。keyset ゆえ取得済みの範囲の
 * 行が重複・欠落することは無いが、同時点の snapshot とは名乗らぬ。
 */
export const EXPORT_CONSISTENCY_NOTE =
  "取得の途中に追加・変更・削除された記録は、含まれないことや変更前の内容のことがあります（同じ時点の完全な写しではありません）"

/** 記録の継続位置の表記: `<logged_at の表記のまま>|<id>`（Date に通すと秒未満が落ちて同じ行を引き直す） */
export function encodeLogsAfter(cursor: BabyLogKeysetCursor): string {
  return `${cursor.loggedAt}|${cursor.id}`
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ParsedAfter<T> = { ok: true; value: T | "end" | null } | { ok: false }

/**
 * 記録の継続位置を読む。null（未指定）= 最初から。"end" = この表は取り終えた。
 * URL から来た値は PostgREST の or 条件へ入るゆえ、形を確かめて引用符を壊す文字を通さぬ。
 */
export function parseLogsAfter(raw: string | null): ParsedAfter<BabyLogKeysetCursor> {
  if (raw === null) return { ok: true, value: null }
  if (raw === "end") return { ok: true, value: "end" }
  const at = raw.lastIndexOf("|")
  if (at < 0) return { ok: false }
  const loggedAt = raw.slice(0, at)
  const id = raw.slice(at + 1)
  if (!isTimestamptzText(loggedAt) || !UUID_RE.test(id)) return { ok: false }
  return { ok: true, value: { loggedAt, id } }
}

/** 日記の継続位置（diary_date は世帯内で一意ゆえ日付だけで全順序） */
export function parseDiariesAfter(raw: string | null): ParsedAfter<string> {
  if (raw === null) return { ok: true, value: null }
  if (raw === "end") return { ok: true, value: "end" }
  return isValidYmd(raw) ? { ok: true, value: raw } : { ok: false }
}

/**
 * 続きの要求の対象範囲。最初の要求で決めた範囲を**そのまま**送らせる — 続きの時に「今日」を
 * 引き直すと、日付を跨いだ後や 1 週間の窓で範囲がずれ、行が黙って増減する。
 * `from` は "all"（下限なし）か暦日、`to` は暦日（今日より後は拒む）。
 */
export function parsePinnedRange(
  fromRaw: string | null,
  toRaw: string | null,
  today: string,
): { from: string | null; to: string } | null {
  if (!isValidYmd(toRaw) || toRaw > today) return null
  if (fromRaw === "all") return { from: null, to: toRaw }
  if (!isValidYmd(fromRaw) || fromRaw > toRaw) return null
  return { from: fromRaw, to: toRaw }
}

export interface ExportTruncation {
  logs: boolean
  diaries: boolean
}

export function buildExportDocument(input: {
  exportedAt: string
  period: ExportPeriod
  from: string | null
  to: string
  household: { baby_name: string | null; baby_birth_date: string | null }
  members: { id: string; display_name: string }[]
  logs: BabyLogData[]
  diaries: ExportDiaryRow[]
  truncated: ExportTruncation
  part?: ExportPartInfo
}): ExportDocument {
  const logs: ExportLogRow[] = input.logs.map((l) => ({
    ...l,
    logged_at_jst_date: toJstDateString(l.logged_at),
  }))
  const lastLog = logs.at(-1)
  const lastDiary = input.diaries.at(-1)
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    app: "irori",
    exported_at: input.exportedAt,
    timezone: "Asia/Tokyo",
    timestamps: "UTC ISO 8601; *_date fields are JST calendar days",
    period: { key: input.period, from: input.from, to: input.to },
    household: input.household,
    members: input.members,
    units: EXPORT_UNITS,
    counts: { logs: logs.length, diaries: input.diaries.length },
    // 続きの部分（第 2 部以降）は、そのファイル単独では範囲の全件ではない — 最後の部分でも false
    complete: !input.truncated.logs && !input.truncated.diaries && !(input.part?.continuation ?? false),
    // 記録と日記は別々に示す（日記だけが切り詰められた時に記録の時刻を指さぬ）
    truncated_after: input.truncated.logs && lastLog ? lastLog.logged_at : null,
    diaries_truncated_after:
      input.truncated.diaries && lastDiary ? lastDiary.diary_date : null,
    logs,
    diaries: input.diaries,
    part: input.part ?? {
      continuation: false,
      logs_after: null,
      diaries_after: null,
      next: null,
      is_last: true,
    },
    consistency_note: EXPORT_CONSISTENCY_NOTE,
  }
}

/**
 * 保存ファイル名。ASCII だけ（Content-Disposition の filename は ASCII が安全）。
 * 分けた書き出し（続きがある第 1 部・続きの部分）は番号を付け、全件の書き出しと取り違えぬ —
 * CSV ではファイル名が「一部」を示す唯一の印じゃ（本文は表だけ）。
 */
export function exportFilename(
  from: string | null,
  to: string,
  options: { ext?: "json" | "csv"; table?: "logs" | "diaries"; part?: number; split?: boolean } = {},
): string {
  const ext = options.ext ?? "json"
  const table = options.table ? `_${options.table}` : ""
  const partNo = options.part ?? 1
  const part = options.split || partNo >= 2 ? `_part${partNo}` : ""
  return `uchinolog${table}_${from ?? "all"}_${to}${part}.${ext}`
}
