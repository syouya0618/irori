/**
 * OAuth 接続フロー（計画書 §7 D-4）の**契約**を 1 箇所に集める。
 *
 * ここに置くのは start / callback の両ルートと設定カードが共有する定数と純関数
 * だけじゃ。fetch も DB も持たぬ（I/O は `oauth.ts` / `calendar-client.ts` の担当）。
 *
 * ## なぜ URL 組み立てをここへ出すか
 * `access_type=offline` / `prompt=consent` / スコープ 3 種は、**落とすと静かに
 * 壊れる**契約じゃ:
 * - `access_type=offline` を落とすと refresh_token が返らず、接続はできたのに
 *   翌日以降の同期が全滅する。
 * - `prompt=consent` を落とすと 2 回目以降の同意で refresh_token が返らぬ
 *   （Google は初回同意時にしか返さぬ。計画書 §D-1）。
 * - `openid email` を落とすと userinfo が引けず `google_connections.google_account_id`
 *   （Google の不変 ID = `sub`）を埋められぬ。email を同一性の鍵にすると Google 側の
 *   改名で接続が二重化する（D-1 の migration が名指ししておる契約）。
 *
 * **ただし本モジュールの単体テストを担保と見なすな。** 真の担保は
 * `src/app/api/google/oauth/start/__tests__/route.test.ts` が**実ハンドラの
 * Location ヘッダ**を解析して固定する URL 契約テストじゃ（builder を直接
 * テストしても「実際に投げた URL」の保証にはならぬ — `calendar-client.ts` が
 * `buildEventsUrl` を export せぬのと同じ理由）。
 */

/**
 * CSRF 用 state の cookie 名。
 *
 * `path` を `/api/google/oauth` に絞るため、他経路のリクエストには載らぬ。
 */
export const GOOGLE_OAUTH_STATE_COOKIE = "irori_google_oauth_state"

/** state cookie の path。start と callback の両方を含む最短の接頭辞。 */
export const GOOGLE_OAUTH_COOKIE_PATH = "/api/google/oauth"

/**
 * state の寿命（秒）。同意画面を開いたまま放置した窓を短く保つ。
 * 10 分は「同意画面で警告を 1 回タップする」実運用（計画書 §D-7 手順 3）に十分。
 */
export const GOOGLE_OAUTH_STATE_MAX_AGE_SEC = 600

/** Google の認可エンドポイント（OAuth 2.0 / OpenID Connect）。 */
export const GOOGLE_AUTHORIZE_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth"

/** カレンダー読み取り。これが欠けると同期が一切できぬ。 */
export const GOOGLE_CALENDAR_READONLY_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly"

/**
 * 要求するスコープ（**3 つとも必須**）。
 *
 * `openid` / `email` は飾りではない — これが無いと userinfo が 401/403 になり、
 * `google_account_id` を埋められぬ（`oauth.ts` の `fetchGoogleUserInfo` が
 * 「openid email スコープ不足の疑い」として落とす経路がそれじゃ）。
 */
export const GOOGLE_OAUTH_SCOPES = [
  GOOGLE_CALENDAR_READONLY_SCOPE,
  "openid",
  "email",
] as const

/** 設定画面へ戻す先。callback は必ずここへ `?google=<notice>` 付きで戻る。 */
export const SETTINGS_PATH = "/settings"

/** 設定カードへ渡す通知コード（`?google=` の値）。 */
export type GoogleConnectNotice =
  /** 接続成功（カレンダー一覧の取り込みまで完了）。 */
  | "connected"
  /** 接続は成立したがカレンダー一覧の取り込みに失敗した。 */
  | "connected_no_calendars"
  /** `calendar.readonly` が同意されなかった（チェックを外された）。 */
  | "missing_scope"
  /** refresh_token を取り逃した（計画書 §D-5）。再接続が要る。 */
  | "no_refresh_token"
  /** CSRF: state 不一致（計画書 §D-5）。 */
  | "csrf"
  /** 利用者が同意を拒否した（`error=access_denied`）。 */
  | "denied"
  /** 認可コードの交換が `invalid_grant`（期限切れ・使用済み）。 */
  | "invalid_grant"
  /** 一過性のネットワーク失敗。 */
  | "network"
  /** GOOGLE_CLIENT_ID / SECRET が未設定（デプロイ設定の誤り）。 */
  | "not_configured"
  /** DB への保存に失敗した。 */
  | "save_failed"
  /** 上記以外の失敗。 */
  | "error"

/**
 * OAuth の redirect URI。**専用 env を増やさず `getAppOrigin()` から導出する**
 * （計画書 §D-8）。GCP の「承認済みリダイレクト URI」にはこの形で登録すること。
 */
export function googleOAuthRedirectUri(origin: string): string {
  return `${origin}/api/google/oauth/callback`
}

/** `/settings?google=<notice>` の絶対 URL。 */
export function settingsNoticeUrl(
  origin: string,
  notice: GoogleConnectNotice,
): string {
  const url = new URL(SETTINGS_PATH, origin)
  url.searchParams.set("google", notice)
  return url.toString()
}

/**
 * 暗号論的乱数の state を作る（32 バイト = 256 bit を hex 化）。
 *
 * Web Crypto を使うのは Node / Edge のどちらのランタイムでも同じ経路で動くため。
 * `Math.random()` は予測可能ゆえ CSRF トークンに使ってはならぬ。
 */
export function createOAuthState(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/**
 * state の照合。
 *
 * **`??  ""` 等で空へ正規化してから比較してはならぬ** — cookie 無し（undefined）と
 * クエリ無し（null）が「空文字 === 空文字」で一致し、**CSRF 検査が素通りする**。
 * ゆえに「両方とも非空の文字列であること」を先に要求する。
 *
 * 定数時間比較は不要じゃ: state はリクエストごとの使い捨て nonce であり、
 * 攻撃者が同じ値へ何度も測定を重ねられる秘密ではない。
 */
export function isValidOAuthState(
  cookieValue: string | null | undefined,
  queryValue: string | null | undefined,
): boolean {
  if (typeof cookieValue !== "string" || cookieValue.length === 0) return false
  if (typeof queryValue !== "string" || queryValue.length === 0) return false
  return cookieValue === queryValue
}

/**
 * 同意されたスコープに `calendar.readonly` が含まれるか。
 *
 * Google は空白区切りで返す。**部分文字列一致で判定してはならぬ** —
 * 将来 `.../calendar.readonly.something` のような別スコープが増えたときに
 * 誤って「含まれる」と判定するため、分割して完全一致を見る。
 */
export function hasCalendarReadonlyScope(
  scope: string | null | undefined,
): boolean {
  if (typeof scope !== "string" || scope.length === 0) return false
  return scope
    .split(/\s+/)
    .some((granted) => granted === GOOGLE_CALENDAR_READONLY_SCOPE)
}

/**
 * Google の同意画面 URL を組み立てる。
 *
 * `access_type=offline` + `prompt=consent` は**必ず両方**付ける（片方だけでは
 * refresh_token を取り逃す。上のモジュール注記を見よ）。
 */
export function buildGoogleAuthorizeUrl(params: {
  clientId: string
  redirectUri: string
  state: string
}): string {
  const url = new URL(GOOGLE_AUTHORIZE_ENDPOINT)
  url.searchParams.set("client_id", params.clientId)
  url.searchParams.set("redirect_uri", params.redirectUri)
  url.searchParams.set("response_type", "code")
  // 空白区切り（RFC 6749 §3.3）。URLSearchParams が `+` へエンコードする。
  url.searchParams.set("scope", GOOGLE_OAUTH_SCOPES.join(" "))
  // refresh_token を得る条件その 1。落とすと翌日以降の同期が全滅する。
  url.searchParams.set("access_type", "offline")
  // その 2。落とすと 2 回目以降の同意で refresh_token が返らぬ。
  url.searchParams.set("prompt", "consent")
  url.searchParams.set("state", params.state)
  // 既に別スコープを持つアカウントで、今回の同意分だけに縮まぬようにする。
  url.searchParams.set("include_granted_scopes", "true")
  return url.toString()
}

/** state cookie の属性。start（発行）と callback（破棄）で同じ値を使う。 */
export function oauthStateCookieOptions(origin: string): {
  httpOnly: true
  secure: boolean
  sameSite: "lax"
  path: string
  maxAge: number
} {
  return {
    httpOnly: true,
    // **`true` 固定にしてはならぬ**: `http://localhost:3000` では cookie が
    // そもそも保存されず、callback が毎回 `?google=csrf` を返して
    // 計画書 §D-7 の手動スモークが一歩も進まなくなる。origin から導出する。
    secure: origin.startsWith("https://"),
    // `strict` は不可。Google からの戻りは**クロスサイト起点のトップレベル遷移**
    // ゆえ strict では cookie が送られず、必ず csrf 判定になる。
    sameSite: "lax",
    path: GOOGLE_OAUTH_COOKIE_PATH,
    maxAge: GOOGLE_OAUTH_STATE_MAX_AGE_SEC,
  }
}
