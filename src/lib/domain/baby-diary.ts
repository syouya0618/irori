/**
 * 育児日記（baby_diaries: 1世帯・1日1本のテキスト。ぴよログ流）の表示ヘルパ。
 *
 * 旧 memo ログ由来の日記一覧（groupMemoLogsByDate）は 1日1本モデルへの移行で
 * 廃止した。タイムラインの memo ログは「メモ」（時刻付きの短い記録）として存続し、
 * 日記とは別概念（ぴよログの メモ / 日記 の区別に準拠）。
 */

import type { BabyDiaryData } from "@/lib/types/baby"

/**
 * 日記保存の衝突（P1-06: updated_at を版とする楽観的排他）。
 * `current` はサーバが読み直した最新の行。他端末で削除済みなら null。
 */
export interface BabyDiaryConflict {
  current: BabyDiaryData | null
}

/**
 * upsertBabyDiary の戻り値。衝突時は error に加えて conflict を返す
 * （呼び出し側は下書きを捨てず、current を並べて見せ、版を current へ進める）。
 * 最新行の読み直しまで失敗した時は conflict を付けない（「削除済み」と誤認させぬ）。
 */
export type UpsertBabyDiaryResult =
  | { error: null; diary: BabyDiaryData | null; conflict?: undefined }
  | { error: string; diary: null; conflict?: BabyDiaryConflict }

/**
 * 日記一覧の1ページあたりの取得件数。サーバ初回取得（diary/page.tsx）と
 * クライアントの「もっと見る」追ページ取得（baby-diary-view.tsx）で同一値を使う。
 */
export const DIARY_PAGE_SIZE = 50

// JST の日付見出しフォーマッター（モジュールスコープで1回だけ生成）。
// 例: "2026年7月22日(火)"。
const JST_DATE_HEADING_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
})

/**
 * "YYYY-MM-DD"（JST 暦日）から日付見出し（"YYYY年M月D日(曜)"）を返す。
 * `new Date('YYYY-MM-DD')` の UTC 罠を避けるため +09:00 を明示して同日の
 * JST 0 時を構築してから整形する。
 */
export function formatDiaryDateHeadingFromYmd(ymd: string): string {
  return JST_DATE_HEADING_FORMATTER.format(new Date(`${ymd}T00:00:00+09:00`))
}
