import {
  fetchWithTimeout,
  readJsonSafe,
  summarizeErrorBody,
} from "@/lib/google/fetch-with-timeout"

/**
 * Google OAuth 2.0 の I/O シェル（計画書 §D-3）。
 *
 * ここは **fetch を持つ層**であり、純関数コア（`src/lib/domain/google-calendar-sync.ts`）
 * には依存せぬ。逆に純関数コアもここへは依存せぬ（I/O と純粋の境界を跨がせない）。
 *
 * ## 機密の扱い
 * `code` / `client_secret` / `refresh_token` / `access_token` は**一切ログに出さぬ**。
 * 出すのは HTTP status と Google が返した `error` / `error_description` だけじゃ。
 */

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
/** OpenID Connect の userinfo。`sub`（不変 ID）と `email` を得るには `openid email` スコープが要る。 */
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

/**
 * 恒久失敗と一過性失敗を呼び出し側が区別するための種別。
 *
 * - `invalid_grant`: refresh token が失効・取消された（**恒久**）。
 *   呼び出し側は `google_connections.connection_status='needs_reauth'` へ遷移させ、
 *   設定カードに再連携導線を出すこと（計画書 §D-5）。**握り潰すな。**
 * - `network`: 接続断 / timeout（**一過性**）。次回トリガで自動回復するため
 *   再接続導線は出さぬ。
 * - `unknown`: 上記以外（`invalid_client`、5xx、想定外 body など）。
 *
 * この 3 値はいずれも `google_connections.last_error_kind` の CHECK
 * （`'invalid_grant' | 'gone' | 'quota' | 'network' | 'unknown'`）に含まれるゆえ、
 * **そのまま DB へ書ける**。
 */
export type GoogleAuthErrorKind = "invalid_grant" | "network" | "unknown"

export class GoogleAuthError extends Error {
  readonly kind: GoogleAuthErrorKind
  /** HTTP status（ネットワーク層の失敗では null）。 */
  readonly status: number | null
  /** Google が返した `error` / `error_description` の要約（機密は含まぬ）。 */
  readonly googleError: string | null

  constructor(
    kind: GoogleAuthErrorKind,
    message: string,
    options: { status?: number | null; googleError?: string | null } = {}
  ) {
    super(message)
    this.name = "GoogleAuthError"
    this.kind = kind
    this.status = options.status ?? null
    this.googleError = options.googleError ?? null
  }
}

/**
 * トークンエンドポイントの応答を我々の語彙へ写したもの。
 *
 * **`refreshToken` は初回の同意時にしか返らぬ**（refresh grant の応答には含まれぬ）。
 * ゆえに `null` を「取り消し」と解釈して既存値を上書きしてはならぬ
 * （`google_tokens.refresh_token` は NOT NULL であり、上書きは接続の恒久破壊になる）。
 * 書き込み経路は `token-store.ts` で `saveGoogleTokens`（初回）と
 * `updateGoogleAccessToken`（更新）に**分離**してある。
 */
export interface GoogleTokenSet {
  accessToken: string
  /** 初回同意でのみ返る。refresh 応答では null。 */
  refreshToken: string | null
  /** `expires_in`（秒）から導出した ISO 8601（UTC）。求まらねば null。 */
  accessTokenExpiresAt: string | null
  /** 実際に同意されたスコープ（`calendar.readonly` 欠落の検知用）。 */
  scope: string | null
}

export interface GoogleUserInfo {
  /** Google アカウントの不変 ID（`google_connections.google_account_id`）。 */
  sub: string
  email: string
}

/** OAuth クライアント資格情報。未設定は**デプロイ設定の誤り**ゆえ fail-closed で throw する。 */
function readOAuthCredentials(): { clientId: string; clientSecret: string } {
  // env は `?.trim()` で防御（末尾改行混入の再発防止）。
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
  // `GoogleAuthError` にはせぬ: これは「再連携すれば直る」性質の失敗ではなく
  // 500 相当の設定ミスじゃ。kind を発明して UI の再連携導線へ流すと誤誘導になる。
  if (!clientId) {
    throw new Error("[google-oauth] GOOGLE_CLIENT_ID が未設定です")
  }
  if (!clientSecret) {
    throw new Error("[google-oauth] GOOGLE_CLIENT_SECRET が未設定です")
  }
  return { clientId, clientSecret }
}

/** `expires_in`（秒）を ISO 8601 へ。`now` はテスト注入用（`date-jst.ts` と同規約）。 */
function toExpiresAt(expiresIn: unknown, now: number): string | null {
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null
  return new Date(now + expiresIn * 1000).toISOString()
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** トークンエンドポイントを叩き、失敗を `GoogleAuthError` へ写す共通経路。 */
async function requestToken(
  body: URLSearchParams,
  scope: string,
  now: number
): Promise<GoogleTokenSet> {
  const outcome = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })

  if (!outcome.ok) {
    // timeout も接続断も一過性ゆえ `network`。`AbortError` だけを見ると
    // undici の `TypeError: fetch failed`（DNS/接続失敗）が `unknown` へ落ちる。
    console.error(`[${scope}] トークン要求がネットワーク層で失敗`, {
      aborted: outcome.aborted,
      message: outcome.message,
    })
    throw new GoogleAuthError("network", "Google への接続に失敗しました")
  }

  const { response } = outcome
  const payload = await readJsonSafe(response)

  if (!response.ok) {
    const record = (payload ?? {}) as Record<string, unknown>
    const googleError = summarizeErrorBody(payload)
    // `invalid_grant` = refresh token の失効/取消。恒久失敗ゆえ型で区別する。
    const kind: GoogleAuthErrorKind =
      record.error === "invalid_grant" ? "invalid_grant" : "unknown"
    // 機密（code / client_secret / token）は載せぬ。status と Google のエラー記述のみ。
    console.error(`[${scope}] トークン要求が失敗`, {
      status: response.status,
      kind,
      googleError,
    })
    throw new GoogleAuthError(kind, "Google のトークン要求に失敗しました", {
      status: response.status,
      googleError,
    })
  }

  const record = (payload ?? {}) as Record<string, unknown>
  const accessToken = asStringOrNull(record.access_token)
  if (accessToken === null) {
    console.error(`[${scope}] 応答に access_token が無い`, {
      status: response.status,
      keys: Object.keys(record).join(","),
    })
    throw new GoogleAuthError("unknown", "Google の応答に access_token がありません", {
      status: response.status,
    })
  }

  return {
    accessToken,
    refreshToken: asStringOrNull(record.refresh_token),
    accessTokenExpiresAt: toExpiresAt(record.expires_in, now),
    scope: asStringOrNull(record.scope),
  }
}

/**
 * 認可コードをトークンへ交換する（OAuth callback から呼ぶ）。
 *
 * `redirectUri` は authorize 時と**完全一致**していなければ Google が
 * `redirect_uri_mismatch` を返す（kind は `unknown`）。
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  now: number = Date.now()
): Promise<GoogleTokenSet> {
  const { clientId, clientSecret } = readOAuthCredentials()
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  })
  return requestToken(body, "google-oauth:exchange", now)
}

/**
 * refresh token から access token を取り直す。
 *
 * **返る `refreshToken` は通常 null**（Google は refresh 応答に refresh_token を
 * 含めぬ）。呼び出し側は既存の `google_tokens.refresh_token` を上書きせぬこと。
 */
export async function refreshAccessToken(
  refreshToken: string,
  now: number = Date.now()
): Promise<GoogleTokenSet> {
  const { clientId, clientSecret } = readOAuthCredentials()
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  })
  return requestToken(body, "google-oauth:refresh", now)
}

/**
 * userinfo から Google アカウントの不変 ID（`sub`）と `email` を得る。
 *
 * **スコープに `openid email` が要る**（`calendar.readonly` だけでは 401/403 になる）。
 * D-1 の migration が `google_connections.google_account_id` のコメントで名指しして
 * おる契約じゃ。取れぬ構成にするなら primary カレンダーの id を代替に使うこと。
 */
export async function fetchGoogleUserInfo(
  accessToken: string
): Promise<GoogleUserInfo> {
  const outcome = await fetchWithTimeout(GOOGLE_USERINFO_ENDPOINT, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!outcome.ok) {
    console.error("[google-oauth:userinfo] ネットワーク層で失敗", {
      aborted: outcome.aborted,
      message: outcome.message,
    })
    throw new GoogleAuthError("network", "Google への接続に失敗しました")
  }

  const { response } = outcome
  const payload = await readJsonSafe(response)

  if (!response.ok) {
    const googleError = summarizeErrorBody(payload)
    console.error("[google-oauth:userinfo] 取得に失敗", {
      status: response.status,
      googleError,
    })
    throw new GoogleAuthError("unknown", "Google のユーザー情報取得に失敗しました", {
      status: response.status,
      googleError,
    })
  }

  const record = (payload ?? {}) as Record<string, unknown>
  const sub = asStringOrNull(record.sub)
  const email = asStringOrNull(record.email)
  // `google_account_id` / `google_email` は共に NOT NULL。欠けたまま進むと
  // INSERT が落ちるか、空文字が CHECK に弾かれる。ここで理由を名指しして落とす。
  if (sub === null || email === null) {
    console.error("[google-oauth:userinfo] 応答に sub / email が無い", {
      hasSub: sub !== null,
      hasEmail: email !== null,
      // スコープ不足（`openid email` 欠落）が最も疑わしい。
      hint: "OAuth スコープに openid email が含まれているか確認",
    })
    throw new GoogleAuthError(
      "unknown",
      "Google のユーザー情報に sub / email がありません（openid email スコープ不足の疑い）",
      { status: response.status }
    )
  }

  return { sub, email }
}
