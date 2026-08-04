import { NextResponse, type NextRequest } from "next/server"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { getAppOrigin } from "@/lib/utils/app-origin"
import { createAdminClient } from "@/lib/supabase/admin"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { saveGoogleTokens } from "@/lib/google/token-store"
import {
  GoogleAuthError,
  exchangeCodeForTokens,
  fetchGoogleUserInfo,
} from "@/lib/google/oauth"
import { fetchCalendarList } from "@/lib/google/calendar-client"
import {
  GOOGLE_OAUTH_STATE_COOKIE,
  type GoogleConnectNotice,
  googleOAuthRedirectUri,
  hasCalendarReadonlyScope,
  isValidOAuthState,
  oauthStateCookieOptions,
  settingsNoticeUrl,
} from "@/lib/google/oauth-connect"

/**
 * `GET /api/google/oauth/callback` — Google からの戻り（計画書 §7 D-4 / §D-5）。
 *
 * ## 握り潰し禁止（計画書 §D-5）
 * 全ての失敗経路は `?google=<notice>` として**必ず UI へ露出**する。silent な
 * 「何も起きなかった」は作らぬ。対応表は `GoogleConnectNotice` を見よ。
 *
 * ## 書き込み順序と「片方だけ書けた」状態の設計
 * `google_tokens.connection_id` は `google_connections(id)` への FK ゆえ、
 * **接続行が先**という順序は動かせぬ。ゆえに「接続はあるがトークンが無い」窓が
 * 原理的に存在する。これを無害化するため:
 *
 *   ① 接続行を **`connection_status='needs_reauth'` で** upsert する
 *   ② トークンを保存する
 *   ③ スコープを検査する（`calendar.readonly` 欠落なら ④ へ進まぬ）
 *   ④ ここで初めて `'active'` へ昇格させる
 *
 * どこで落ちても残るのは「再連携バナーが出ている接続」= **目に見えて自己回復
 * 可能な状態**だけになる。逆順（先に active）だと「トークンが無いのに健康に
 * 見える接続」が残り、同期が静かに失敗し続ける。
 *
 * **代償を正直に書く**: 健全な接続を再連携している最中に ② が落ちると、実際には
 * 古い refresh token がまだ効くのに UI が誤って「再連携が必要です」と促す。
 * これは誤警報にすぎず、再接続すれば消える。既存トークンを壊さぬ
 * （`saveGoogleTokens` は upsert ゆえ、失敗時は旧値が残る）ため回復可能じゃ。
 * 「補償トランザクションで接続行を DELETE する」案は採らぬ — 再連携の失敗で
 * **既に動いていた接続を消す**ことになり、はるかに重い損失になる。
 *
 * ## service role を使う理由
 * `google_connections` / `google_tokens` は INSERT/UPDATE の RLS ポリシーも GRANT も
 * 持たぬ設計（D-1 の migration）ゆえ、書けるのは service role だけじゃ。RLS が
 * 効かぬ以上、**世帯スコープはコードが担う**（全クエリで household_id / user_id を
 * 明示 `.eq()` する）。
 */
export async function GET(request: NextRequest) {
  // request.url の origin は loopback アクセス時に localhost へ正規化されるため
  // 使わない (issue #16)。
  const origin = getAppOrigin(request)
  const url = new URL(request.url)

  /**
   * 全ての return をこれで包む。**state cookie を毎回破棄する**のが要点じゃ
   * （成功でも失敗でも）。残すと同じ state での replay 窓が開き、10 分の
   * max-age いっぱい CSRF 検査が意味を失う。
   */
  const respond = (notice: GoogleConnectNotice): NextResponse => {
    return clearState(NextResponse.redirect(settingsNoticeUrl(origin, notice)))
  }
  const clearState = (response: NextResponse): NextResponse => {
    // 発行時と同じ属性で上書きせねばブラウザは別 cookie とみなして消さぬ。
    response.cookies.set(GOOGLE_OAUTH_STATE_COOKIE, "", {
      ...oauthStateCookieOptions(origin),
      maxAge: 0,
    })
    return response
  }

  // ── 1. CSRF: state の照合（他の何より先） ──
  // 空文字への正規化はせぬ。cookie 無しとクエリ無しが一致して素通りするため
  // （`isValidOAuthState` の注記を見よ）。
  const stateCookie = request.cookies.get(GOOGLE_OAUTH_STATE_COOKIE)?.value
  const stateParam = url.searchParams.get("state")
  if (!isValidOAuthState(stateCookie, stateParam)) {
    // state の値そのものは載せぬ（照合済みなら秘密ではないが、不一致時は
    // 攻撃者由来の任意文字列がログへ入る）。有無と長さだけ残す。
    console.error("[google-oauth-callback] state が一致しません（CSRF 防御）", {
      hasCookie: typeof stateCookie === "string" && stateCookie.length > 0,
      hasParam: typeof stateParam === "string" && stateParam.length > 0,
    })
    return respond("csrf")
  }

  // ── 2. Google 側が error を返した（同意拒否など） ──
  const errorParam = url.searchParams.get("error")
  if (errorParam !== null) {
    console.error("[google-oauth-callback] Google が error を返しました", {
      error: errorParam,
    })
    // `access_denied` = 利用者が同意しなかった。それ以外は設定不備等。
    return respond(errorParam === "access_denied" ? "denied" : "error")
  }

  const code = url.searchParams.get("code")
  if (code === null || code.length === 0) {
    console.error("[google-oauth-callback] code も error も無い応答です")
    return respond("error")
  }

  // ── 3. 認可（proxy の二層目。`start` と同じ理由） ──
  const auth = await getAuthContext()
  if (auth.error !== null) {
    console.error("[google-oauth-callback] 未認証のためログインへ戻します", {
      reason: auth.reason,
    })
    return clearState(
      NextResponse.redirect(new URL("/login", origin).toString()),
    )
  }
  const { userId, householdId } = auth.context

  // ── 4. 資格情報の存在を先に見る ──
  // `oauth.ts` は未設定を素の Error で throw する（GoogleAuthError ではない）。
  // 交換の catch で拾うと「再連携すれば直る」種別に誤分類しかねぬため、
  // ここで先に弾いて理由を名指しする。
  if (
    !process.env.GOOGLE_CLIENT_ID?.trim() ||
    !process.env.GOOGLE_CLIENT_SECRET?.trim()
  ) {
    console.error(
      "[google-oauth-callback] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が未設定です",
    )
    return respond("not_configured")
  }

  // ── 5. 認可コード → トークン ──
  let tokens
  try {
    // redirect_uri は authorize 時と**完全一致**が要る。同じ関数で組む。
    tokens = await exchangeCodeForTokens(code, googleOAuthRedirectUri(origin))
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      // `oauth.ts` が status / googleError を既に構造化ログへ落としておるが、
      // 「どの経路で起きたか」はここでしか分からぬゆえ重ねて残す。
      console.error("[google-oauth-callback] コードの交換に失敗", {
        kind: err.kind,
        status: err.status,
        googleError: err.googleError,
      })
      // ## 計画書との差異（意図的・報告済み）
      // §D-5 は `invalid_grant` に `connection_status='needs_reauth'` を割り当てて
      // おるが、あれは「（refresh 失効/取消）」と注記されたとおり**同期側の
      // refresh 経路**（D-5 の同期エンジン）の話じゃ。callback 時点の
      // invalid_grant は「認可 **コード** が期限切れ／使用済み」であり、
      //   - この同意に対応する接続行はまだ存在せぬ（`sub` が未取得ゆえ特定不能）
      //   - 利用者は別の Google アカウントで**健全に動いている接続**を
      //     持ちうる（UNIQUE は (user_id, google_account_id)）
      // ため、既存行を needs_reauth へ倒すのは**動いている接続を止める**誤操作に
      // なる。ゆえに DB は一切触らず、UI へ `?google=invalid_grant` で露出させる
      // （＝握り潰しはしておらぬ）。
      if (err.kind === "invalid_grant") return respond("invalid_grant")
      if (err.kind === "network") return respond("network")
      return respond("error")
    }
    console.error("[google-oauth-callback] コードの交換で想定外の失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return respond("error")
  }

  // ── 6. refresh_token の取り逃し（計画書 §D-5） ──
  // **ここで必ず落とす。** refresh token 無しの接続は「今日は動くが明日は死ぬ」
  // 接続じゃ。access token は 1 時間で切れ、以後の同期は永久に失敗する。
  // DB へは**まだ一行も書いておらぬ**ため、既存の健全な接続も無傷で残る。
  if (tokens.refreshToken === null) {
    console.error(
      "[google-oauth-callback] refresh_token を取り逃しました（再接続が必要）",
      {
        // 値は出さぬ。有無だけ。
        hasAccessToken: tokens.accessToken.length > 0,
        // `prompt=consent` を付けておるのに返らぬのは Google 側の状態異常ゆえ、
        // 切り分け材料としてスコープ文字列（機密ではない）を残す。
        scope: tokens.scope,
      },
    )
    return respond("no_refresh_token")
  }
  const refreshToken = tokens.refreshToken

  // ── 7. userinfo（`sub` = 不変 ID と email） ──
  let userInfo
  try {
    userInfo = await fetchGoogleUserInfo(tokens.accessToken)
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      console.error("[google-oauth-callback] userinfo の取得に失敗", {
        kind: err.kind,
        status: err.status,
        googleError: err.googleError,
        hint: "OAuth スコープに openid email が含まれているか確認",
      })
      return respond(err.kind === "network" ? "network" : "error")
    }
    console.error("[google-oauth-callback] userinfo で想定外の失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return respond("error")
  }

  // ── 8. DB 書き込み ──
  // 変数名を `supabase` にしてあるのは意図じゃ:
  // `scripts/check-supabase-error-destructure.py` は `\bsupabase\b` を含む文にしか
  // アンカーせぬ（`SUPABASE_TOKEN_RE`）。`admin` 等に改名すると、service role で
  // RLS を跨ぐ**最も守られるべきこの経路**が silent-fail 検出ゲートの走査対象から
  // 丸ごと外れる。`token-store.ts` が同じ理由で同じ名を採っておる。
  let supabase
  try {
    supabase = createAdminClient()
  } catch (err) {
    // env（SUPABASE_SERVICE_ROLE_KEY 等）未設定。fail-closed で anon へ落とさぬ。
    console.error("[google-oauth-callback] service role クライアントを作れません", {
      message: err instanceof Error ? err.message : String(err),
    })
    return respond("save_failed")
  }

  let connectionId: string
  try {
    // ① 接続行（**needs_reauth で作る**。上のモジュール注記の設計）。
    //    onConflict は D-1 の `uq_google_connections_user_account`。
    //    再連携は同じ Google アカウントの行を上書きし、重複接続を作らぬ。
    const { data: connection, error: connectionError } = await supabase
      .from("google_connections")
      .upsert(
        {
          household_id: householdId,
          user_id: userId,
          google_account_id: userInfo.sub,
          google_email: userInfo.email,
          connection_status: "needs_reauth",
          sync_status: "idle",
          last_error_kind: null,
        },
        { onConflict: "user_id,google_account_id" },
      )
      .select("id")
      .maybeSingle()

    if (connectionError) {
      logSupabaseError(
        "google-oauth-callback",
        "接続行の保存に失敗",
        connectionError,
        { householdId, userId },
      )
      return respond("save_failed")
    }
    // upsert は 0 行でも error: null を返しうる。行が返らねば無音の no-op ゆえ落とす。
    if (connection === null) {
      console.error("[google-oauth-callback] 接続行の保存が 0 行でした", {
        householdId,
        userId,
      })
      return respond("save_failed")
    }
    connectionId = connection.id

    // ② トークン（`saveGoogleTokens` は所有照合つき。失敗時は throw する）。
    await saveGoogleTokens(
      supabase,
      { connectionId, householdId, userId },
      {
        refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        scope: tokens.scope,
      },
    )
  } catch (err) {
    console.error("[google-oauth-callback] トークンの保存に失敗", {
      householdId,
      userId,
      message: err instanceof Error ? err.message : String(err),
    })
    return respond("save_failed")
  }

  // ③ スコープ検査。`calendar.readonly` が無ければ同期は一切できぬ。
  //    **`connection_status` は `needs_reauth` のまま据え置く** — 是正手段は
  //    再同意だけであり、再連携バナーがまさにその導線じゃ。
  //    `last_error_kind` には書かぬ: あれは同期の失敗種別（CHECK に
  //    'missing_scope' は無い）であって、接続時の同意不足とは別の軸じゃ。
  if (!hasCalendarReadonlyScope(tokens.scope)) {
    console.error(
      "[google-oauth-callback] calendar.readonly が同意されていません",
      { connectionId, scope: tokens.scope },
    )
    return respond("missing_scope")
  }

  // ④ ここで初めて健康な接続として昇格させる。
  const { data: activated, error: activateError } = await supabase
    .from("google_connections")
    .update({ connection_status: "active", last_error_kind: null })
    .eq("id", connectionId)
    // RLS が効かぬ経路ゆえ世帯・本人スコープをコードで明示する（admin.ts の契約）。
    .eq("household_id", householdId)
    .eq("user_id", userId)
    .select("id")
    .maybeSingle()

  if (activateError) {
    logSupabaseError(
      "google-oauth-callback",
      "接続の有効化に失敗",
      activateError,
      { connectionId, householdId, userId },
    )
    return respond("save_failed")
  }
  // `.update()` は 0 行でも error: null。行が無いのは異常ゆえ fail-loud。
  if (activated === null) {
    console.error("[google-oauth-callback] 接続の有効化が 0 行でした", {
      connectionId,
      householdId,
      userId,
    })
    return respond("save_failed")
  }

  // ⑤ カレンダー一覧の取り込み。
  //    **接続の成否とは切り離す**（独立した try/catch）— ここで失敗しても
  //    トークンは既に保存済みで接続は有効じゃ。巻き戻せば、成功した接続を
  //    一覧取得の一過性失敗で捨てることになる。
  //    `google_calendar_subscriptions` の INSERT はポリシーも GRANT も無い
  //    = service role 専用ゆえ、投入経路はここしかない（計画書 §D-7 手順 4 が
  //    「接続直後に設定へ一覧が出る」ことを要求しておる）。
  const calendarsStored = await storeCalendarList({
    supabase,
    accessToken: tokens.accessToken,
    connectionId,
    householdId,
  })

  return respond(calendarsStored ? "connected" : "connected_no_calendars")
}

/** `google_calendar_subscriptions` の CHECK（`char_length(summary) <= 500`）。 */
const SUMMARY_MAX_LENGTH = 500
/** 同 `char_length(btrim(google_calendar_id)) BETWEEN 1 AND 1024`。 */
const CALENDAR_ID_MAX_LENGTH = 1024

/**
 * カレンダー一覧を取り込む。**失敗しても throw せず false を返す**（呼び出し側が
 * 接続そのものを巻き戻さぬため）。
 *
 * `is_selected` / `sync_token` / `sync_lease_until` を payload に**入れぬ**のが要点じゃ:
 * PostgREST の upsert は payload に在る列だけを更新するため、これらを省けば
 * 再取り込みのたびに **利用者のトグル選択と増分同期の状態が保たれる**。
 * 入れた瞬間、接続し直すたびに購読が全解除され、増分同期がフルへ退化する。
 */
async function storeCalendarList(args: {
  supabase: ReturnType<typeof createAdminClient>
  accessToken: string
  connectionId: string
  householdId: string
}): Promise<boolean> {
  const { supabase, accessToken, connectionId, householdId } = args
  try {
    const calendars = await fetchCalendarList(accessToken)

    const rows = calendars
      // DB の CHECK を跨げぬ行を先に落とす。1 件の異常で upsert 全体が
      // 落ちて「一覧が丸ごと出ない」ことを防ぐ（fail-soft）。
      .filter((calendar) => {
        const ok =
          calendar.id.trim().length > 0 &&
          calendar.id.length <= CALENDAR_ID_MAX_LENGTH
        if (!ok) {
          console.warn(
            "[google-oauth-callback] 長すぎる calendar id を破棄しました",
            { length: calendar.id.length },
          )
        }
        return ok
      })
      .map((calendar) => ({
        connection_id: connectionId,
        household_id: householdId,
        google_calendar_id: calendar.id,
        summary:
          calendar.summary === null
            ? null
            : calendar.summary.slice(0, SUMMARY_MAX_LENGTH),
      }))

    if (rows.length === 0) {
      // 「Google 側にカレンダーが 1 つも無い」は現実には起きぬ（primary が必ず
      // ある）。0 件は取得異常の徴候ゆえ残す。
      console.warn("[google-oauth-callback] 取り込めるカレンダーが 0 件でした", {
        connectionId,
        fetched: calendars.length,
      })
      return false
    }

    const { data, error } = await supabase
      .from("google_calendar_subscriptions")
      .upsert(rows, { onConflict: "connection_id,google_calendar_id" })
      .select("id")

    if (error) {
      logSupabaseError(
        "google-oauth-callback",
        "カレンダー一覧の保存に失敗",
        error,
        { connectionId, householdId, rowCount: rows.length },
      )
      return false
    }
    if (!data || data.length === 0) {
      console.error("[google-oauth-callback] カレンダー一覧の保存が 0 行でした", {
        connectionId,
        householdId,
        rowCount: rows.length,
      })
      return false
    }
    console.log("[google-oauth-callback] カレンダー一覧を取り込みました", {
      connectionId,
      stored: data.length,
    })
    return true
  } catch (err) {
    console.error("[google-oauth-callback] カレンダー一覧の取得に失敗", {
      connectionId,
      householdId,
      message: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
