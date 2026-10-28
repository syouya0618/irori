import { toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"
import type { ExportDiaryRow } from "@/lib/domain/baby-export"

/**
 * 表計算向けの CSV 書き出し（2026-10-27 大型更新 E2）。1 ファイル = 1 表（記録 / 日記）。
 *
 * ## セルの規則
 * - RFC 4180: 区切りは `,`、行末は CRLF、文字列のセルは**常に** `"` で囲み、中の `"` は `""` へ。
 *   改行・カンマを含む自由文もそのまま 1 セルに収まる（囲まぬと区切りを差し込まれて別のセルを作られる）
 * - 式の注入（CSV injection）: 文字列のセルが `=` `+` `-` `@`・タブ・CR・LF（と全角の `＝` `＋` `－` `＠`）で
 *   始まるなら先頭に `'` を付ける（OWASP「CSV Injection」の推奨。community.owasp.org/attacks/CSV_Injection を
 *   2026-10-27 に確認）。家庭の自由文（メモ・日記）が表計算で式として動かぬようにする。代償として、
 *   そのセルの中身は先頭に `'` が付いたまま見える（データを書き換えて隠すより、見える形で残す）
 * - 数値の列（量・秒・回数・体温・体重・身長）は**数値のまま**出す（`'` を付けぬ。負の値は持たぬ列）
 * - 文字化け: 先頭に UTF-8 の BOM（U+FEFF）を置く（Excel が UTF-8 と判じるため）
 *
 * OWASP 自身が「全ての表計算ソフトで安全な単一の方法は無い」と書いておる。ここで防ぐのは
 * 「開いた途端に式が動く」ことで、取り込み側のプログラムが `'` を除かずに使う場合は利用者の責任範囲
 * — 画面の説明にその旨を書く。
 */

export const CSV_BOM = String.fromCharCode(0xfeff)
const CRLF = "\r\n"

const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r", "\n", "＝", "＋", "－", "＠"])

/** 文字列のセル（式の注入を無効化し、常に引用符で囲む） */
export function csvTextCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return ""
  const text = String(value)
  const guarded = text.length > 0 && FORMULA_LEAD.has(text[0]) ? `'${text}` : text
  return `"${guarded.replace(/"/g, '""')}"`
}

/** 数値のセル（数値のまま。有限でない値・null は空欄） */
export function csvNumberCell(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return ""
  return String(value)
}

export type CsvCell = { text: string | null | undefined } | { num: number | null | undefined }

function cell(c: CsvCell): string {
  return "text" in c ? csvTextCell(c.text) : csvNumberCell(c.num)
}

/** 見出し行 + 行。見出しは日本語（固定の文字列ゆえ注入の心配は無いが同じ規則で囲む） */
export function buildCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  const lines = [headers.map((h) => csvTextCell(h)).join(",")]
  for (const row of rows) lines.push(row.map(cell).join(","))
  return CSV_BOM + lines.join(CRLF) + CRLF
}

const JST_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

/** UTC の ISO を「JST の YYYY-MM-DD HH:mm」へ（表計算で読める形。秒未満は落とす表示用の列） */
export function jstDateTimeText(iso: string): string {
  return `${toJstDateString(iso)} ${JST_TIME.format(new Date(iso))}`
}

export const LOG_CSV_HEADERS = [
  "記録ID",
  "日時(JST)",
  "日時(UTC ISO)",
  "種類",
  "授乳の種類",
  "量(ml)",
  "左の秒",
  "右の秒",
  "左の回数",
  "右の回数",
  "開始側",
  "合計の秒",
  "おむつ",
  "うんちの量",
  "体温(℃)",
  "体重(g)",
  "身長(cm)",
  "メモ",
  "記録した人",
  "作成(UTC ISO)",
  "更新(UTC ISO)",
] as const

export function logsToCsv(
  logs: readonly BabyLogData[],
  memberNames: ReadonlyMap<string, string>,
): string {
  const rows: CsvCell[][] = logs.map((l) => [
    { text: l.id },
    { text: jstDateTimeText(l.logged_at) },
    { text: l.logged_at },
    { text: l.log_type },
    { text: l.feeding_type },
    { num: l.amount_ml },
    { num: l.breast_left_sec },
    { num: l.breast_right_sec },
    { num: l.breast_left_count },
    { num: l.breast_right_count },
    { text: l.breast_start_side },
    { num: l.duration_sec },
    { text: l.diaper_type },
    { text: l.poop_amount },
    { num: l.temperature },
    { num: l.weight_g },
    { num: l.height_cm },
    { text: l.memo },
    { text: memberNames.get(l.logged_by) ?? l.logged_by },
    { text: l.created_at },
    { text: l.updated_at },
  ])
  return buildCsv(LOG_CSV_HEADERS, rows)
}

export const DIARY_CSV_HEADERS = ["日付(JST)", "本文", "更新(UTC ISO)", "日記ID"] as const

export function diariesToCsv(diaries: readonly ExportDiaryRow[]): string {
  return buildCsv(
    DIARY_CSV_HEADERS,
    diaries.map((d) => [
      { text: d.diary_date },
      { text: d.content },
      { text: d.updated_at },
      { text: d.id },
    ]),
  )
}
