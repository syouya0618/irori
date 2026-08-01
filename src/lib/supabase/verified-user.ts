import type { AuthError } from "@supabase/supabase-js"
import { logSupabaseError } from "@/lib/supabase/log-error"

/**
 * リクエストの認証判定を行う**唯一の源**。
 *
 * ⚠️ **ルーティング判定（未認証なら /login へ送る類）は必ずこれを使うこと。**
 * proxy とページで別々の検証方法を使ってはならない。
 *
 * なぜ単一化するか（2026-07-29 のレビューで発見した回帰）:
 *   proxy が `getClaims()`、ページが `getUser()` という混在状態にすると、
 *   **両者の判定が食い違う瞬間に無限リダイレクトになる**。
 *     1. proxy: 認証済み・承認済みと判定して通す
 *     2. ページ: 未認証と判定して /login へ redirect
 *     3. proxy: 承認済みが public route に来た → / へ redirect
 *     4. → 1 へ戻る（ブラウザは ERR_TOO_MANY_REDIRECTS で停止＝アプリ操作不能）
 *   食い違いは机上の空論ではない。`signOut()` は scope 既定が 'global' ゆえ
 *   **片方の端末でログアウトすると他端末のトークンはサーバ側で失効するが署名と exp は有効**
 *   なままで、ローカル検証（getClaims）は通り Auth サーバ問い合わせ（getUser）は落ちる。
 *   GoTrue の障害・ネットワーク不調でも同じ状態になる。復旧はトークンが期限切れになるまで
 *   （既定 TTL 3600 秒）待つしかない。
 *
 * 検証方式に getClaims を選ぶ理由:
 *   `getUser()` は JWT ごとに必ず Auth サーバへ往復する（実測 16.55ms）。`getClaims()` は
 *   非対称鍵（ES256）なら JWKS を使いローカルの WebCrypto で検証して完結する（0.14ms）。
 *   proxy は静的アセット以外の全リクエストを通るため、この差が体感の支配項になる。
 *   対称鍵・WebCrypto 不在・kid 不一致の場合は getClaims が内部で getUser へ
 *   フォールバックしてサーバ検証するため、**安全性が落ちることはない**（落ちるのは速度だけ）。
 *
 * 失うもの: サーバ側の失効確認。ログアウト・端末紛失の反映がアクセストークン TTL
 *   （既定 3600 秒）ぶん遅れる。承認取り消しは proxy が毎回 DB の is_approved を読むため
 *   即時に効き、世帯分離も RLS が JWT の sub で毎回評価する。より短い失効を求めるなら
 *   Supabase 側の JWT expiry を短縮する（例 900 秒）。proxy の検証コストは変わらない。
 *
 * 高感度で低頻度な操作（招待受諾・世帯作成など Server Action 側）は `getUser()` を
 *   残してよい。それらは失敗時に redirect せず `{ error }` を返すだけなので、
 *   判定が食い違ってもループを生まない。
 *
 * ⚠️ fail-closed を崩すな: 署名不正・期限切れ・JWKS 取得失敗・sub 欠落・想定外の戻り値・
 *   例外、いずれも null（＝未認証）を返す。不変条件は __tests__/verified-user.test.ts が固定する。
 */

/**
 * `getClaims()` を持つ Supabase クライアントの最小形。
 * proxy の `createServerClient` とページの `createClient` の双方を受けるため、
 * 具体型ではなく必要な口だけを構造的に要求する。
 */
export interface ClaimsCapableClient {
  auth: {
    getClaims: () => Promise<{
      data: { claims: { sub?: unknown; email?: unknown } } | null
      error: AuthError | null
    }>
  }
}

/** 検証済みの本人情報。email は表示用（JWT の claim 由来ゆえ追加の往復は不要）。 */
export interface VerifiedUser {
  userId: string
  email: string | null
}

/**
 * 検証済みの claims を返す。判定不能は null（fail-closed）。
 * ルーティング判定に使うのは userId のみ。email は画面表示用の付随情報で、
 * 認可の根拠には使わないこと。
 */
export async function getVerifiedUser(
  supabase: ClaimsCapableClient,
  scope: string,
): Promise<VerifiedUser | null> {
  try {
    const { data, error } = await supabase.auth.getClaims()
    if (error) {
      // セッション無しは { data: null, error: null } で来るためログしない。
      // ここに来るのは署名不正・期限切れ・JWKS 取得失敗など本物の異常のみ。
      logSupabaseError(scope, "getClaims failed", error, {})
    }
    const sub = data?.claims?.sub
    if (typeof sub !== "string" || sub.length === 0) return null
    const email = data?.claims?.email
    return { userId: sub, email: typeof email === "string" ? email : null }
  } catch (err) {
    // getClaims は AuthError 以外の例外（WebCrypto の失敗等）を再 throw する。
    // 握り潰さず記録し、未認証へ倒す。
    console.error(`[${scope}] getClaims が例外を投げました`, {
      message: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** ルーティング判定用の薄いラッパ（大半の呼び出し元はこれで足りる）。 */
export async function getVerifiedUserId(
  supabase: ClaimsCapableClient,
  scope: string,
): Promise<string | null> {
  return (await getVerifiedUser(supabase, scope))?.userId ?? null
}
