/**
 * `getAuthContext` の拒否理由と、Route Handler が返す HTTP status の対応（UX-03）。
 *
 * 画面側（PDF・JSON 書き出し・Google の手動同期のカード）は 401 を「セッションが
 * 切れました。ログインし直してください」と案内するゆえ、**401 はログインし直せば
 * 直る時だけ**じゃ。profiles の一過性の取得失敗（lookup-failed）まで 401 にすると、
 * 待てば直る障害で利用者をログアウトへ誘導してしまう。
 *
 * 以前は 3 本の route が同じ表を別々に持っていた（片方だけ直すと、同じ失敗で
 * 画面ごとに案内が食い違う）。`Record` にしてあるのは、理由が増えた時に tsc が
 * 割り当て漏れを止めるため。理由の union もここが正本で、`getAuthContext` が使う。
 *
 * 境界指令も server 専用の import も持たぬ中立モジュール（route のテストが
 * `@/lib/supabase/auth-context` を `vi.mock` で差し替えても、この表は消えぬ）。
 */
export type AuthDenialReason =
  | "unauthenticated"
  | "not-approved"
  | "no-household"
  | "shared-only"
  | "lookup-failed"

export const AUTH_DENIAL_HTTP_STATUS: Record<AuthDenialReason, number> = {
  unauthenticated: 401,
  "not-approved": 403,
  "no-household": 403,
  "shared-only": 403,
  "lookup-failed": 503,
}
