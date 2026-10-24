/**
 * PostgREST / Realtime が返した timestamptz の**表記のまま**運ぶ値の形を検査する。
 *
 * 楽観的排他の版（`updated_at`）や keyset の cursor（`logged_at`）は、DB の値と
 * 文字列のまま `.eq()` / `.lt()` で照合する。`new Date()` を通すとマイクロ秒が
 * ミリ秒へ丸まり、版の照合が二度と一致せず（以後の保存がすべて衝突する）、cursor は
 * 同じ行を引き直す。ゆえにここでは形だけを確かめ、値は書き換えぬ。
 *
 * 受ける表記:
 * - PostgREST: `2026-07-22T03:00:00.123456+00:00`
 * - Realtime: 空白区切り・`+00` 短縮（`2026-07-22 03:00:00.123456+00`）
 * - `Z` 終端
 * いずれも Postgres が timestamptz として等価に比較する。
 *
 * 境界指令を持たぬ中立モジュール。Server Action・Server Component・Client の
 * どこから値 import してもよい。
 */
const TIMESTAMPTZ_TEXT_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/

export function isTimestamptzText(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMPTZ_TEXT_RE.test(value)
}

/**
 * 版を送らぬ・形の合わぬ保存（デプロイを跨いだ古い PWA バンドル等）を、無条件の上書きへ
 * 倒さずに止めた時の文言。日記・予定・育児ログの楽観的排他で共有する。
 */
export const STALE_SCREEN_SAVE_ERROR =
  "画面が古いため保存できませんでした。再読み込みしてからもう一度お試しください。"
