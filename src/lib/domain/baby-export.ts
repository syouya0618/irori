import { shiftYmd, toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

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
    complete: !input.truncated.logs && !input.truncated.diaries,
    // 記録と日記は別々に示す（日記だけが切り詰められた時に記録の時刻を指さぬ）
    truncated_after: input.truncated.logs && lastLog ? lastLog.logged_at : null,
    diaries_truncated_after:
      input.truncated.diaries && lastDiary ? lastDiary.diary_date : null,
    logs,
    diaries: input.diaries,
  }
}

/** 保存ファイル名。ASCII だけ（Content-Disposition の filename は ASCII が安全） */
export function exportFilename(from: string | null, to: string): string {
  return `uchinolog_${from ?? "all"}_${to}.json`
}
