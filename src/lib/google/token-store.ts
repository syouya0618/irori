import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"

/**
 * `google_tokens` の読み書き（計画書 §D-3「I/O シェル」）。
 *
 * ## 前提: **RLS は効かぬ**
 * `google_tokens` は RLS 有効かつポリシー 0 本 = deny-all で、GRANT も剥がして
 * ある。触れるのは service role（`createAdminClient()`）だけじゃ。裏を返せば
 * **行スコープを守るのはコードの責務**であり、DB は何も守ってくれぬ。
 * ゆえに本モジュールの全 API は `connection_id` / `household_id` / `user_id` の
 * 3 点セット（`GoogleTokenOwner`）を必須で受け取り、`google_connections` 側で
 * 所有を照合してからでなければトークンに触れぬ。
 *
 * ## Supabase の error は plain object
 * `class Error` を継承せぬため `String(err)` は `[object Object]` になる。
 * 全クエリで `error` を destructure し、`logSupabaseError` で
 * `{ message, code, details, hint, status }` を構造化ログへ落とす。
 *
 * ## 機密の扱い
 * `refresh_token` / `access_token` の**値は一切ログに出さぬ**。出すのは
 * connection_id / household_id と、値の有無・長さといったメタ情報だけじゃ。
 *
 * ## 命名の理由
 * クライアント引数を `supabase` と名付けてあるのは
 * `scripts/check-supabase-error-destructure.py`（CI の silent fail 検出ゲート）が
 * **識別子 `supabase` を含む文にしかアンカーせぬ**ためじゃ。`admin` や `db` に
 * 改名すると、最も守られるべきこのファイルがゲートの走査対象から丸ごと外れる。
 */

type GoogleTokensInsert = Database["public"]["Tables"]["google_tokens"]["Insert"]

/**
 * トークン行のスコープ。**3 点とも必須**（`?:` にすると渡し忘れがコンパイルを
 * 通り、世帯を跨いだ読み書きが無音で成立する）。
 */
export interface GoogleTokenOwner {
  connectionId: string
  householdId: string
  userId: string
}

export interface GoogleTokenRow {
  connectionId: string
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: string | null
  /** 実際に同意されたスコープ（`calendar.readonly` 欠落の検知用）。 */
  scope: string | null
}

/** 初回接続時に保存する一式。`refreshToken` は NOT NULL ゆえ必須。 */
export interface GoogleTokenSaveInput {
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: string | null
  scope: string | null
}

/**
 * refresh 後に更新する一式。
 *
 * **`refreshToken` を持たぬのは意図じゃ。** Google の refresh 応答には
 * `refresh_token` が含まれぬため、共通の upsert で書くと NOT NULL 違反か、
 * 空値での上書き（接続の恒久破壊。再連携するまで同期が二度と動かぬ）になる。
 * 型の上で書けなくしてある。
 */
export interface GoogleAccessTokenUpdateInput {
  accessToken: string
  accessTokenExpiresAt: string | null
  /** Google は refresh 応答にも scope を載せる。null なら既存を据え置く。 */
  scope: string | null
}

/**
 * 接続が本当にこの世帯・この利用者のものかを DB で照合する。
 *
 * 一致せねば throw する（fail-loud）。**戻り値で握り潰さぬ**のは、
 * 不一致が「0 行更新でも error: null」の形で無音の no-op になるのを防ぐためじゃ。
 */
async function requireConnectionOwner(
  supabase: SupabaseClient<Database>,
  owner: GoogleTokenOwner
): Promise<void> {
  const { data, error } = await supabase
    .from("google_connections")
    .select("id")
    .eq("id", owner.connectionId)
    .eq("household_id", owner.householdId)
    .eq("user_id", owner.userId)
    .maybeSingle()

  if (error) {
    logSupabaseError(
      "google-token-store",
      "接続の所有照合に失敗",
      error,
      { connectionId: owner.connectionId, householdId: owner.householdId }
    )
    throw new Error("[google-token-store] 接続の所有照合に失敗しました")
  }
  if (data === null) {
    console.error("[google-token-store] 接続が世帯・利用者と一致しません", {
      connectionId: owner.connectionId,
      householdId: owner.householdId,
      userId: owner.userId,
    })
    throw new Error("[google-token-store] 接続が見つかりません")
  }
}

/**
 * トークン行を読む。行が無ければ `null`（初回接続前）。
 *
 * `.maybeSingle()` の `error` は必ず受け取る（受け取らねば失敗が
 * `data: null` に化けて「トークンが無い」と誤読される）。
 */
export async function loadGoogleTokens(
  supabase: SupabaseClient<Database>,
  owner: GoogleTokenOwner
): Promise<GoogleTokenRow | null> {
  await requireConnectionOwner(supabase, owner)

  const { data, error } = await supabase
    .from("google_tokens")
    .select("connection_id, refresh_token, access_token, access_token_expires_at, scope")
    .eq("connection_id", owner.connectionId)
    .maybeSingle()

  if (error) {
    logSupabaseError("google-token-store", "トークンの取得に失敗", error, {
      connectionId: owner.connectionId,
      householdId: owner.householdId,
    })
    throw new Error("[google-token-store] トークンの取得に失敗しました")
  }
  if (data === null) return null

  return {
    connectionId: data.connection_id,
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    accessTokenExpiresAt: data.access_token_expires_at,
    scope: data.scope,
  }
}

/**
 * 初回接続（および再連携）のトークン保存。`connection_id` で upsert する。
 *
 * **refresh token を持つ経路はここだけ**じゃ。refresh 後の更新に流用するな
 * （`GoogleAccessTokenUpdateInput` を参照）。
 */
export async function saveGoogleTokens(
  supabase: SupabaseClient<Database>,
  owner: GoogleTokenOwner,
  input: GoogleTokenSaveInput
): Promise<void> {
  await requireConnectionOwner(supabase, owner)

  if (input.refreshToken.trim().length === 0) {
    // 空の refresh token を書けば NOT NULL は通っても同期は永久に失敗する。
    // 呼び出し側（D-4 の callback）は `!tokens.refresh_token` を
    // `?google=no_refresh_token` として扱うこと（計画書 §D-5）。
    throw new Error("[google-token-store] refresh_token が空です")
  }

  const row: GoogleTokensInsert = {
    connection_id: owner.connectionId,
    refresh_token: input.refreshToken,
    access_token: input.accessToken,
    access_token_expires_at: input.accessTokenExpiresAt,
    scope: input.scope,
  }

  const { data, error } = await supabase
    .from("google_tokens")
    .upsert(row, { onConflict: "connection_id" })
    .select("connection_id")
    .maybeSingle()

  if (error) {
    logSupabaseError("google-token-store", "トークンの保存に失敗", error, {
      connectionId: owner.connectionId,
      householdId: owner.householdId,
    })
    throw new Error("[google-token-store] トークンの保存に失敗しました")
  }
  // upsert は 0 行でも error: null になりうる。行が返らねば無音の no-op ゆえ落とす。
  if (data === null) {
    console.error("[google-token-store] トークンの保存が 0 行でした", {
      connectionId: owner.connectionId,
      householdId: owner.householdId,
    })
    throw new Error("[google-token-store] トークンの保存が反映されませんでした")
  }
}

/**
 * refresh 後の access token だけを更新する（**UPDATE のみ・upsert せぬ**）。
 *
 * 書き込む列は `access_token` / `access_token_expires_at`（と scope が非 null の
 * ときのみ `scope`）に限る。**`refresh_token` を payload に含めてはならぬ** —
 * Google の refresh 応答は refresh token を返さぬため、含めれば必ず既存値を
 * 壊すことになる。
 */
export async function updateGoogleAccessToken(
  supabase: SupabaseClient<Database>,
  owner: GoogleTokenOwner,
  input: GoogleAccessTokenUpdateInput
): Promise<void> {
  await requireConnectionOwner(supabase, owner)

  const patch: Database["public"]["Tables"]["google_tokens"]["Update"] = {
    access_token: input.accessToken,
    access_token_expires_at: input.accessTokenExpiresAt,
  }
  // scope は Google が返したときだけ更新する（null で既存を消さぬ）。
  if (input.scope !== null) {
    patch.scope = input.scope
  }

  const { data, error } = await supabase
    .from("google_tokens")
    .update(patch)
    .eq("connection_id", owner.connectionId)
    .select("connection_id")
    .maybeSingle()

  if (error) {
    logSupabaseError(
      "google-token-store",
      "access token の更新に失敗",
      error,
      { connectionId: owner.connectionId, householdId: owner.householdId }
    )
    throw new Error("[google-token-store] access token の更新に失敗しました")
  }
  // `.update()` は 0 行更新でも error: null を返す。行が無いのは
  // 「トークン行がまだ無い」= 呼び出し順序の誤りゆえ fail-loud。
  if (data === null) {
    console.error("[google-token-store] access token の更新が 0 行でした", {
      connectionId: owner.connectionId,
      householdId: owner.householdId,
    })
    throw new Error("[google-token-store] 更新対象のトークン行がありません")
  }
}
