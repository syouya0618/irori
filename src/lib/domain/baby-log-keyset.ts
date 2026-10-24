/**
 * baby_logs を `(logged_at, id)` の全順序でページ送りする keyset 条件。
 * PDF（/api/baby-report・昇順）・JSON 書き出し（/api/baby-export・昇順）・
 * 記録の検索（/baby/search・降順）が共有する唯一の実装じゃ。
 *
 * offset（range）にせぬのは、取得の最中に家族が記録を足し・消し・時刻を直すと
 * 行がずれて**欠落や重複**が起きるためじゃ。id は主キーゆえ `(logged_at, id)` は全順序。
 *
 * 守る規則（3 か所で別々に書くと、片方だけ直した時に食い違う）:
 * - cursor の logged_at は PostgREST が返した文字列を**そのまま**使う。DB は
 *   マイクロ秒まで持つゆえ、`Date` に通して ms へ丸めると eq が外れ、比較が同じ行を
 *   引き直す（PDF の回数が二重に数えられる）。
 * - 値は二重引用符で囲む。PostgREST の docs は論理木の値に含まれる `,` `.` `:` `(` `)` を
 *   予約文字とし、引用符で囲めと定めておる（timestamptz は `.` と `:` を含む）。
 *   ISO 表記の timestamptz と uuid は `"` も `\` も含まぬゆえ、囲むだけで足りる
 *   （URL から来る cursor は呼び出し側が形を検査してから渡すこと）。
 *
 * 境界指令を持たぬ中立モジュール（Server Component と Route Handler の両方から値 import する）。
 */

export interface BabyLogKeysetCursor {
  /** PostgREST が返した logged_at の表記のまま */
  loggedAt: string
  id: string
}

/** `asc` は「この行より後（新しい側）」、`desc` は「この行より前（古い側）」 */
export type KeysetDirection = "asc" | "desc"

export function babyLogKeysetFilter(
  cursor: BabyLogKeysetCursor,
  direction: KeysetDirection,
): string {
  const op = direction === "asc" ? "gt" : "lt"
  const at = `"${cursor.loggedAt}"`
  const id = `"${cursor.id}"`
  return `logged_at.${op}.${at},and(logged_at.eq.${at},id.${op}.${id})`
}

/** cursor が無ければ（最初のページ）そのまま返す */
export function withBabyLogKeyset<Q extends { or(filters: string): Q }>(
  query: Q,
  cursor: BabyLogKeysetCursor | null,
  direction: KeysetDirection,
): Q {
  return cursor === null ? query : query.or(babyLogKeysetFilter(cursor, direction))
}
