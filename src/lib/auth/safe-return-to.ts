/**
 * ログイン後の戻り先として受け入れてよい値だけを通す（open redirect 防止）。
 *
 * ⚠️ **この規則を呼び出し側へ複製してはならぬ。** 認証の着地点は増えていく
 * （`/auth/callback`・`/auth/confirm`・今後の何か）。各々が自前で判定を持つと、
 * **片方だけ緩んだ時に誰も気づかぬ** —— そして緩んだ方は「ログイン直後に
 * 任意の外部サイトへ飛ばせる」入口になる。
 *
 * 弾く形は二つある。`//evil.example.com` は**スキーム相対 URL**で、`startsWith("/")`
 * だけの判定を素通りしながらブラウザには別オリジンとして解釈される —— ここが
 * この関数の存在理由じゃ。
 */
export function safeReturnTo(returnTo: string | null | undefined): string | null {
  if (!returnTo) return null
  if (!returnTo.startsWith("/")) return null
  if (returnTo.startsWith("//")) return null
  // `/\evil.example.com` を別オリジンとして解釈するブラウザがあるため塞ぐ
  if (returnTo.startsWith("/\\")) return null
  return returnTo
}
