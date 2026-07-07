/**
 * 招待の入力（フル招待リンク or 生トークン）から token を抽出する。
 *
 * `/setup` の「招待コードで参加」逸路や、貼り付け経由の受諾で使う。
 * 受け付ける形:
 * - `https://example.com/invite/<token>`（クエリ・ハッシュ・末尾スラッシュ許容）
 * - `/invite/<token>`
 * - `<token>` 単体（URL でない ＝ 空白・スラッシュ・クエリ記号を含まない）
 *
 * 抽出できなければ `null`（呼び出し側でエラー表示する）。
 * `"use server"` ファイルは async 関数しか export できないため、
 * この同期ヘルパーは別モジュールに置き、action からは import して使う。
 */
export function extractInviteToken(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // URL（絶対/相対）に `/invite/<token>` が含まれる場合はその segment を取る。
  // `[^/?#\s]+` により末尾スラッシュ・クエリ・ハッシュの手前で止まる。
  const match = trimmed.match(/\/invite\/([^/?#\s]+)/)
  if (match) {
    return match[1] ? match[1] : null
  }

  // URL でない生トークン（スラッシュ・空白・クエリ記号を含まない）はそのまま。
  if (!/[\s/?#]/.test(trimmed)) {
    return trimmed
  }

  return null
}
