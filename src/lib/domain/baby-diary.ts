import { toJstDateString } from "@/lib/utils/date-jst"
import type { BabyLogData } from "@/lib/types/baby"

/**
 * 日記一覧の1ページあたりの取得件数。サーバ初回取得（page.tsx）とクライアントの
 * 「もっと見る」追ページ取得（baby-diary-view.tsx）で同一値を使う。
 */
export const DIARY_PAGE_SIZE = 50

/** 1日分の日記グループ（JST 日付でまとめたメモログ） */
export interface DiaryDateGroup {
  /** JST の "YYYY-MM-DD"（グルーピングのキー・安定した識別子） */
  date: string
  /** 表示用の日本語見出し（例: "2026年7月22日(火)"） */
  label: string
  /** その日のメモログ（入力順を保持 = logged_at 降順・id 昇順） */
  logs: BabyLogData[]
}

// JST の日付見出しフォーマッター（モジュールスコープで1回だけ生成）。
// 例: "2026年7月22日(火)"。ISO タイムスタンプ（logged_at）から生成するため
// date-only パースの UTC 罠には触れない。
const JST_DATE_HEADING_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
})

/**
 * ISO 8601 タイムスタンプから JST の日付見出し（"YYYY年M月D日(曜)"）を返す。
 */
export function formatDiaryDateHeading(iso: string): string {
  return JST_DATE_HEADING_FORMATTER.format(new Date(iso))
}

/**
 * メモログを JST 日付でグルーピングする。
 *
 * 入力 `logs` は logged_at 降順・id を最終ソートキーとした全順序で並んでいる前提
 * （サーバ・クライアントとも同一の order 句で取得する）。この全順序を保つため、
 * Map の挿入順（= 最初に現れた日付順 = 日付降順）でグループを返し、各グループ内も
 * 入力順（= その日の新しい順）を保持する。
 *
 * @returns 日付降順のグループ配列。各グループ内のログは新しい順。
 */
export function groupMemoLogsByDate(logs: BabyLogData[]): DiaryDateGroup[] {
  const groups = new Map<string, DiaryDateGroup>()
  for (const log of logs) {
    const date = toJstDateString(log.logged_at)
    const existing = groups.get(date)
    if (existing) {
      existing.logs.push(log)
    } else {
      groups.set(date, {
        date,
        label: formatDiaryDateHeading(log.logged_at),
        logs: [log],
      })
    }
  }
  return [...groups.values()]
}
