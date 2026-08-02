import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database, GoogleSyncErrorKind } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
import {
  GoogleAuthError,
  refreshAccessToken as refreshAccessTokenImpl,
  type GoogleTokenSet,
} from "@/lib/google/oauth"
import {
  GoogleCalendarError,
  fetchAllEventPages as fetchAllEventPagesImpl,
  type GoogleEventsQuery,
  type GoogleEventsResult,
} from "@/lib/google/calendar-client"
import {
  loadGoogleTokens,
  updateGoogleAccessToken,
  type GoogleTokenOwner,
} from "@/lib/google/token-store"
import {
  diffPage,
  type GoogleRawEvent,
  type GoogleSyncContext,
} from "@/lib/domain/google-calendar-sync"

/**
 * Google カレンダー同期エンジン（計画書 §7 D-3「同期パイプライン」/ D-5）。
 *
 * 純関数コア（`@/lib/domain/google-calendar-sync`）と I/O シェル
 * （`oauth.ts` / `calendar-client.ts` / `token-store.ts`）を綴じる層じゃ。
 * ここが**唯一** `calendar_events` の google 行を書く場所である。
 *
 * ## クライアント引数を `supabase` と名付ける理由（改名するな）
 * `scripts/check-supabase-error-destructure.py`（CI の silent fail 検出ゲート）は
 * **識別子 `supabase` を含む文にしかアンカーせぬ**。`admin` / `db` へ改名すると
 * 本ファイルがゲートの走査対象から丸ごと外れ、`error` を受け取らぬクエリが
 * 無検出で入る。計画書のサンプルは `admin` と書いておるが、ゲートを優先する。
 * （渡すのは `createAdminClient()` の service role クライアントじゃ。）
 *
 * ## RLS は効かぬ = 世帯スコープはコードの責務
 * service role は BYPASSRLS ゆえ、全クエリで `household_id` を明示 `.eq()` する。
 */

// ============================================================
// 定数
// ============================================================

/**
 * 二重同期防止リースの寿命（ms）。
 *
 * **短くしてある理由**: 落ちた実行が残したリースは、期限が切れるまで次の同期を
 * 抑止する。cron は `maxDuration = 60`、ページ経路の `after()` は `maxDuration = 30`
 * ゆえ、**どの実行も 60 秒を超えて走れぬ**。120 秒はその倍で「走行中の実行を
 * 追い越さぬ」に十分であり、かつオンデマンド同期の staleness 閾値（5 分）より
 * 短いため、クラッシュしても次のページ表示までに自己回復する。
 */
export const SYNC_LEASE_MS = 120_000

/**
 * フル同期の `timeMin`（今日から何日遡るか）。
 *
 * `timeMin` は **フル同期の初回のみ**付けられる（syncToken との併用を Google が
 * 禁じておる — `calendar-client.ts` の一次情報 1）。増分同期のトークンは
 * この絞り込みを引き継ぐため、**この窓はフル同期の時点で凍る**（過去側だけ。
 * `timeMax` を付けておらぬゆえ未来側は無制限）。
 */
export const FULL_SYNC_LOOKBACK_DAYS = 90

/**
 * 1 回の `.upsert()` / `.delete().in()` に載せる最大行数。
 *
 * PostgREST は URL / body の長さに実効上限があり、初回フル同期の数千行や
 * 大量 cancelled を 1 発で撃つと 414 / 413 で落ちる。**無音で切り詰めず**
 * 分割して全件を撃つ（ページネーション則と同じ思想）。
 */
export const WRITE_CHUNK_SIZE = 500
/** DELETE は `.in()` が URL クエリに載るため upsert より小さく割る。 */
export const DELETE_CHUNK_SIZE = 200

/**
 * access token を「まだ使える」と見なす余裕（ms）。
 * 期限ちょうどで撃つと往復中に切れて 401 になるため先回りして refresh する。
 */
export const ACCESS_TOKEN_SKEW_MS = 60_000

// ============================================================
// 型
// ============================================================

/**
 * 外部 I/O の差し替え口（テスト用）。**実 Google API を呼ばずに全経路を試す**ため。
 * 既定値は実装そのものじゃ。
 */
export interface GoogleSyncDeps {
  /** epoch ms。`Date.now()` への暗黙依存を作らぬ。 */
  now: () => number
  fetchAllEventPages: (
    accessToken: string,
    calendarId: string,
    query: GoogleEventsQuery,
  ) => Promise<GoogleEventsResult<GoogleRawEvent>>
  refreshAccessToken: (
    refreshToken: string,
    now?: number,
  ) => Promise<GoogleTokenSet>
}

const DEFAULT_DEPS: GoogleSyncDeps = {
  now: () => Date.now(),
  fetchAllEventPages: (accessToken, calendarId, query) =>
    fetchAllEventPagesImpl<GoogleRawEvent>(accessToken, calendarId, query),
  refreshAccessToken: (refreshToken, now) =>
    refreshAccessTokenImpl(refreshToken, now),
}

export type SubscriptionSyncStatus =
  /** 差分を取り込み、`sync_token` と `last_synced_at` を前進させた。 */
  | "synced"
  /** 別実行がリースを保持中ゆえ何もしなかった（正常）。 */
  | "skipped_leased"
  /** 410 GONE。ミラーを掃除し `sync_token=NULL` にした。次回フル同期で復旧する。 */
  | "resync_required"
  /** quota / network / unknown。一過性ゆえ次回トリガで再試行する。 */
  | "failed"

export interface SubscriptionSyncOutcome {
  subscriptionId: string
  googleCalendarId: string
  status: SubscriptionSyncStatus
  upserted: number
  deleted: number
  /** D-2 が「行を作れず捨てた」件数（理由は `diffPage` が構造化ログへ出す）。 */
  skipped: number
  errorKind: GoogleSyncErrorKind | null
}

export interface ConnectionSyncOutcome {
  connectionId: string
  /** 恒久失敗で `needs_reauth` へ落としたか（UI の再連携導線の起点）。 */
  needsReauth: boolean
  subscriptions: SubscriptionSyncOutcome[]
}

export interface HouseholdSyncSummary {
  householdId: string
  connections: ConnectionSyncOutcome[]
}

// ============================================================
// 小道具
// ============================================================

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

/**
 * 1 回の同期実行で同一 `google_event_id` が複数回現れたときに**最後の状態を採る**。
 *
 * ## なぜ要るか
 * `diffPage` はページ単位の関数で、`upserts[]` と `deletes[]` を**別の配列**に
 * 割る。ゆえに diff の戻り値からは「upsert が先か delete が先か」が
 * **原理的に読めぬ**。ページ跨ぎで同じイベントが「あるページでは通常イベント・
 * 後のページでは cancelled」として届くと（走査中に Google 側で削除された等）、
 * 順序を取り違えれば**削除済みの行が復活**する。
 *
 * ゆえに重複排除は `diffPage` の**手前**、生イベント列の段階で行う。ここで潰せば
 * `upserts` と `deletes` は構成上必ず互いに素になる。
 *
 * ## id を持たぬイベントは畳まぬ
 * `id` 無しは D-2 が `missing_google_event_id` として `skipped[]` に積み、
 * 構造化ログへ出す。Map の同一スロットへ集約すると**その報告が消える**ゆえ、
 * 素通しする（同期の可視性は D-5 の要求そのものじゃ）。
 *
 * 位置は初出のまま保つ（安定した順序）。
 */
export function dedupeRawEventsLastWins(
  rawEvents: readonly GoogleRawEvent[],
): GoogleRawEvent[] {
  const indexById = new Map<string, number>()
  const out: GoogleRawEvent[] = []

  for (const raw of rawEvents) {
    const id = typeof raw.id === "string" ? raw.id.trim() : ""
    if (id.length === 0) {
      out.push(raw)
      continue
    }
    const at = indexById.get(id)
    if (at === undefined) {
      indexById.set(id, out.length)
      out.push(raw)
    } else {
      out[at] = raw
    }
  }

  return out
}

/** `GoogleAuthError` / `GoogleCalendarError` を DB の `last_error_kind` へ写す。 */
function toErrorKind(err: unknown): GoogleSyncErrorKind {
  if (err instanceof GoogleAuthError) return err.kind
  if (err instanceof GoogleCalendarError) return err.kind
  return "unknown"
}

// ============================================================
// V9: ミラー掃除
// ============================================================

/**
 * 購読解除・接続削除の後に、**もう誰も購読しておらぬ**カレンダーのミラーを消す。
 *
 * ## V9【データ消失シェイプ】
 * 夫婦が同一の共有 Google カレンダーを各自トグル ON にすると、`connection_id` は
 * 別でも `calendar_events` の行は `(household_id, google_calendar_id,
 * google_event_id)` で **1 行に収斂**する。片方の解除で無条件に消すと
 * **もう片方の予定まで消え**、増分同期は削除を検知せぬため 410 か再連携まで
 * **永久に復活せぬ**。ゆえに「他に選択中の購読が無い場合にのみ」消す。
 *
 * ## `.eq("source", "google")` は外すな
 * `calendar_events` は native と google の統合テーブルで、`chk_calendar_google_meta`
 * は**選言**（`source='native' OR (google 列が両方 NOT NULL)`）ゆえ、native 行が
 * `google_calendar_id` を持つことを DB は禁じておらぬ。source を外すと手入力の
 * 予定を巻き込む。
 */
export async function cleanupMirrorForUnsubscribedCalendar(
  supabase: SupabaseClient<Database>,
  householdId: string,
  googleCalendarId: string,
): Promise<{ deleted: boolean }> {
  const { data: stillSelected, error: selectError } = await supabase
    .from("google_calendar_subscriptions")
    // 秘密列（sync_token / sync_lease_until）を引かぬよう列を明示する。
    .select("id")
    .eq("household_id", householdId)
    .eq("google_calendar_id", googleCalendarId)
    .eq("is_selected", true)
    .limit(1)

  if (selectError) {
    logSupabaseError(
      "google-sync",
      "購読の残存確認に失敗",
      selectError,
      { householdId, googleCalendarId },
    )
    // fail-closed: 分からぬときは**消さぬ**（消しすぎは永久に戻らぬ）。
    throw new Error("[google-sync] 購読の残存確認に失敗しました")
  }

  if (stillSelected !== null && stillSelected.length > 0) {
    // 二重購読中。もう一方がまだ選択しておるゆえ消してはならぬ。
    return { deleted: false }
  }

  const { error: deleteError } = await supabase
    .from("calendar_events")
    .delete()
    .eq("household_id", householdId)
    .eq("google_calendar_id", googleCalendarId)
    // native 行を絶対に巻き込まぬ（上の注記を見よ）。
    .eq("source", "google")

  if (deleteError) {
    logSupabaseError(
      "google-sync",
      "ミラーの掃除に失敗",
      deleteError,
      { householdId, googleCalendarId },
    )
    throw new Error("[google-sync] ミラーの掃除に失敗しました")
  }

  return { deleted: true }
}

// ============================================================
// 書き込み
// ============================================================

/**
 * google 行を upsert する。
 *
 * `onConflict` は `20260709000002_calendar_events.sql` の
 * `idx_calendar_events_google_unique`（**通常** UNIQUE index）を指す。partial index
 * だと PostgREST の `on_conflict` が列名しか出せず 42P10 で落ちるため、あちらは
 * CHECK と組み合わせて意図的に通常 index にしてある。
 * 実 DB での解決可否は `supabase/tests/google_sync_upsert_conflict.sql` が固定する。
 *
 * `synced_at` は**全行に**足す。`.upsert(rows[])` は全行が同一のキー集合を持つ
 * ことが成立条件で、一部にだけ足すと列がずれて落ちる。
 */
async function upsertGoogleRows(
  supabase: SupabaseClient<Database>,
  diffUpserts: ReturnType<typeof diffPage>["upserts"],
  syncedAt: string,
  scope: { householdId: string; googleCalendarId: string },
): Promise<number> {
  let written = 0
  for (const rows of chunk(diffUpserts, WRITE_CHUNK_SIZE)) {
    const payload = rows.map((row) => ({ ...row, synced_at: syncedAt }))
    const { error } = await supabase
      .from("calendar_events")
      .upsert(payload, {
        onConflict: "household_id,google_calendar_id,google_event_id",
      })
    if (error) {
      logSupabaseError("google-sync", "google 行の upsert に失敗", error, {
        ...scope,
        rows: payload.length,
      })
      throw new Error("[google-sync] google 行の upsert に失敗しました")
    }
    written += payload.length
  }
  return written
}

/**
 * cancelled を消す。
 *
 * **`household_id` + `google_calendar_id` でスコープする**のは、増分同期の
 * cancelled が「どのカレンダーの id か」を検査せずに届くためじゃ（D-3 の申し送り）。
 * `source='google'` も外すな（上の V9 の注記と同じ理由）。
 */
async function deleteGoogleRows(
  supabase: SupabaseClient<Database>,
  householdId: string,
  googleCalendarId: string,
  googleEventIds: readonly string[],
): Promise<number> {
  let removed = 0
  for (const ids of chunk(googleEventIds, DELETE_CHUNK_SIZE)) {
    const { error } = await supabase
      .from("calendar_events")
      .delete()
      .eq("household_id", householdId)
      .eq("google_calendar_id", googleCalendarId)
      .eq("source", "google")
      .in("google_event_id", ids)
    if (error) {
      logSupabaseError("google-sync", "cancelled の削除に失敗", error, {
        householdId,
        googleCalendarId,
        ids: ids.length,
      })
      throw new Error("[google-sync] cancelled の削除に失敗しました")
    }
    removed += ids.length
  }
  return removed
}

/**
 * 410 GONE の復旧手順: `sync_token` を落とし、この購読のミラーを掃除する。
 *
 * **`last_synced_at` は前進させぬ**。前進させると `maybeScheduleSync` の staleness
 * ゲート（5 分）が復旧を抑止し、利用者は**空のカレンダー**を cron まで見続ける。
 */
async function resetForFullResync(
  supabase: SupabaseClient<Database>,
  subscriptionId: string,
  householdId: string,
): Promise<void> {
  const { error: tokenError } = await supabase
    .from("google_calendar_subscriptions")
    .update({ sync_token: null })
    .eq("id", subscriptionId)
    .eq("household_id", householdId)
  if (tokenError) {
    logSupabaseError("google-sync", "sync_token の破棄に失敗", tokenError, {
      subscriptionId,
      householdId,
    })
    throw new Error("[google-sync] sync_token の破棄に失敗しました")
  }

  // 計画書 §D-3「410 フル再同期」の指定どおり subscription_id で掃除する
  // （`source='google'` は V4 の防御。統合テーブルゆえ native を巻き込まぬ）。
  // household_id も明示する: service role は RLS を迂回するゆえ、世帯スコープは
  // コードが担う（`admin.ts` の呼び出し側の義務）。
  const { error: deleteError } = await supabase
    .from("calendar_events")
    .delete()
    .eq("household_id", householdId)
    .eq("subscription_id", subscriptionId)
    .eq("source", "google")
  if (deleteError) {
    logSupabaseError("google-sync", "410 のミラー掃除に失敗", deleteError, {
      subscriptionId,
      householdId,
    })
    throw new Error("[google-sync] 410 のミラー掃除に失敗しました")
  }
}

// ============================================================
// 購読 1 件の同期
// ============================================================

interface SubscriptionRow {
  id: string
  google_calendar_id: string
  sync_token: string | null
}

interface SubscriptionSyncArgs {
  supabase: SupabaseClient<Database>
  deps: GoogleSyncDeps
  subscription: SubscriptionRow
  householdId: string
  sourceUserId: string
  /** access token を取り出す / 取り直す。connection 内で共有する。 */
  tokens: AccessTokenSession
}

async function syncSubscription({
  supabase,
  deps,
  subscription,
  householdId,
  sourceUserId,
  tokens,
}: SubscriptionSyncArgs): Promise<SubscriptionSyncOutcome> {
  const outcome: SubscriptionSyncOutcome = {
    subscriptionId: subscription.id,
    googleCalendarId: subscription.google_calendar_id,
    status: "failed",
    upserted: 0,
    deleted: 0,
    skipped: 0,
    errorKind: null,
  }

  const nowMs = deps.now()
  const nowIso = new Date(nowMs).toISOString()
  const leaseUntil = new Date(nowMs + SYNC_LEASE_MS).toISOString()

  // ── atomic リース（計画書 §D-3「二重同期防止」）─────────────────
  // READ COMMITTED 下で 2 つ目の UPDATE は EvalPlanQual により述語を再評価し、
  // 0 行で弾かれる。`.or(...)` を外すと常に 1 行更新され、**二重同期が素通り**する。
  const { data: leased, error: leaseError } = await supabase
    .from("google_calendar_subscriptions")
    .update({ sync_lease_until: leaseUntil })
    .eq("id", subscription.id)
    .eq("household_id", householdId)
    .or(`sync_lease_until.is.null,sync_lease_until.lt.${nowIso}`)
    .select("id")

  if (leaseError) {
    logSupabaseError("google-sync", "リースの取得に失敗", leaseError, {
      subscriptionId: subscription.id,
      householdId,
    })
    outcome.errorKind = "unknown"
    return outcome
  }
  if (leased === null || leased.length === 0) {
    // 別実行が進行中。**エラーではない**（cron とページ経路が重なる正常形）。
    outcome.status = "skipped_leased"
    return outcome
  }

  try {
    const query: GoogleEventsQuery =
      subscription.sync_token !== null
        ? { mode: "incremental", syncToken: subscription.sync_token }
        : {
            mode: "full",
            timeMin: new Date(
              nowMs - FULL_SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
            ).toISOString(),
          }

    let result: GoogleEventsResult<GoogleRawEvent>
    try {
      result = await deps.fetchAllEventPages(
        await tokens.get(),
        subscription.google_calendar_id,
        query,
      )
    } catch (err) {
      // D-3 の契約: **401 は kind ではなく status で来る**（kind を増やすと
      // `last_error_kind` の CHECK に無い値になり書き込みが落ちるため）。
      // refresh して **1 回だけ**やり直す。2 度目の 401 はそのまま失敗させる。
      if (err instanceof GoogleCalendarError && err.status === 401) {
        console.warn("[google-sync] 401 ゆえ access token を取り直して 1 回再試行", {
          subscriptionId: subscription.id,
          householdId,
        })
        result = await deps.fetchAllEventPages(
          await tokens.refresh(),
          subscription.google_calendar_id,
          query,
        )
      } else {
        throw err
      }
    }

    const ctx: GoogleSyncContext = {
      householdId,
      googleCalendarId: subscription.google_calendar_id,
      subscriptionId: subscription.id,
      sourceUserId,
    }
    // 実行全体で last-wins に潰してから diff を取る（`dedupeRawEventsLastWins`
    // の注記を見よ）。ここを外すと同一イベントが upsert と delete の両方に載る。
    const diff = diffPage(dedupeRawEventsLastWins(result.events), ctx)

    const syncedAt = new Date(deps.now()).toISOString()

    // ── 実行順の契約: upsert が先、delete が後 ──────────────────
    // 上の重複排除により両集合は互いに素ゆえ、順序を違えても**この実装では**
    // 結果は変わらぬ。それでも順序を固定するのは多層防御じゃ: 将来この関数から
    // 重複排除を落とした者が現れた時、逆順だと「Google で消したはずの予定が
    // 復活し、増分同期ゆえ二度と消えぬ」という戻らぬ事故になる。
    // `__tests__/sync.test.ts` の順序契約テストがこの並びを固定しておる。
    outcome.upserted = await upsertGoogleRows(supabase, diff.upserts, syncedAt, {
      householdId,
      googleCalendarId: subscription.google_calendar_id,
    })
    outcome.deleted = await deleteGoogleRows(
      supabase,
      householdId,
      subscription.google_calendar_id,
      diff.deletes,
    )
    outcome.skipped = diff.skipped.length

    // D-3 の契約: **nextSyncToken が null なら既存を据え置く**。NULL を書くと
    // 以後永久にフル同期へ退化し、増分同期が静かに死ぬ。
    const patch: Database["public"]["Tables"]["google_calendar_subscriptions"]["Update"] =
      { last_synced_at: syncedAt }
    if (result.nextSyncToken !== null) {
      patch.sync_token = result.nextSyncToken
    } else {
      console.warn("[google-sync] 最終ページに nextSyncToken が無い（既存を据え置く）", {
        subscriptionId: subscription.id,
        householdId,
      })
    }

    const { error: patchError } = await supabase
      .from("google_calendar_subscriptions")
      .update(patch)
      .eq("id", subscription.id)
      .eq("household_id", householdId)
    if (patchError) {
      logSupabaseError("google-sync", "同期状態の保存に失敗", patchError, {
        subscriptionId: subscription.id,
        householdId,
      })
      throw new Error("[google-sync] 同期状態の保存に失敗しました")
    }

    outcome.status = "synced"
    return outcome
  } catch (err) {
    const kind = toErrorKind(err)
    outcome.errorKind = kind
    console.error("[google-sync] 購読の同期に失敗", {
      subscriptionId: subscription.id,
      householdId,
      googleCalendarId: subscription.google_calendar_id,
      kind,
      message: err instanceof Error ? err.message : String(err),
      status: err instanceof GoogleCalendarError ? err.status : null,
    })

    if (err instanceof GoogleCalendarError && err.kind === "gone") {
      // 410: syncToken 失効。**この経路を実装せぬと失効後に静かに同期が止まる。**
      await resetForFullResync(supabase, subscription.id, householdId)
      outcome.status = "resync_required"
      return outcome
    }
    // invalid_grant は呼び出し側（syncConnection）が needs_reauth へ遷移させる。
    if (err instanceof GoogleAuthError && err.kind === "invalid_grant") {
      throw err
    }
    return outcome
  } finally {
    // ── リース解放（**失敗時は解放せぬ** = 一過性失敗のバックオフ）──────
    //
    // 無条件に解放すると、Google 側の障害・429 の最中に `/calendar` を開く
    // たび新しい `fetchAllEventPages` が飛ぶ。失敗時は `last_synced_at` を
    // 前進させぬ設計（410 の復旧を抑止せぬため）ゆえ staleness ゲートが
    // 毎回 true を返し、**レート制限中に再試行を撃ち続ける**古典的な形になる。
    // リースを握ったままにすれば、次の実行は `skipped_leased` で静かに諦め、
    // SYNC_LEASE_MS（120 秒）ぶんのバックオフが只で手に入る。
    //
    // 410（`resync_required`）は**解放する**: ミラーを掃除した直後ゆえ
    // カレンダーが空になっており、フル同期での復旧を 2 分待たせたくない。
    //
    // `.eq("sync_lease_until", leaseUntil)` を必ず付ける。付けねば、自分の
    // リースが失効した後に**別実行が取り直したリースを消して**しまい、
    // 二重同期防止そのものが壊れる。
    if (outcome.status !== "failed") {
      const { error: releaseError } = await supabase
        .from("google_calendar_subscriptions")
        .update({ sync_lease_until: null })
        .eq("id", subscription.id)
        .eq("household_id", householdId)
        .eq("sync_lease_until", leaseUntil)
      if (releaseError) {
        // 解放に失敗しても最長 SYNC_LEASE_MS で自然に失効する。同期結果は覆さぬ。
        logSupabaseError("google-sync", "リースの解放に失敗", releaseError, {
          subscriptionId: subscription.id,
          householdId,
        })
      }
    }
  }
}

// ============================================================
// access token セッション
// ============================================================

/**
 * 1 接続ぶんの access token を持ち回す。
 * `get()` は必要なら先回りで refresh し、`refresh()` は強制的に取り直す。
 */
interface AccessTokenSession {
  get: () => Promise<string>
  refresh: () => Promise<string>
}

function createAccessTokenSession(args: {
  supabase: SupabaseClient<Database>
  deps: GoogleSyncDeps
  owner: GoogleTokenOwner
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: string | null
}): AccessTokenSession {
  let accessToken = args.accessToken
  let expiresAtMs = args.accessTokenExpiresAt
    ? Date.parse(args.accessTokenExpiresAt)
    : Number.NaN

  const refresh = async (): Promise<string> => {
    const set = await args.deps.refreshAccessToken(
      args.refreshToken,
      args.deps.now(),
    )
    // **refresh_token は書かぬ**（Google は refresh 応答に含めぬゆえ、共通の
    // upsert で書くと既存値を壊す）。token-store 側で型として塞いである。
    await updateGoogleAccessToken(args.supabase, args.owner, {
      accessToken: set.accessToken,
      accessTokenExpiresAt: set.accessTokenExpiresAt,
      scope: set.scope,
    })
    accessToken = set.accessToken
    expiresAtMs = set.accessTokenExpiresAt
      ? Date.parse(set.accessTokenExpiresAt)
      : Number.NaN
    return set.accessToken
  }

  const get = async (): Promise<string> => {
    // 期限不明（NaN）も「切れておる」側へ倒す。`NaN` の比較は常に false ゆえ
    // `expiresAtMs - now > SKEW` に頼ると**期限不明が有効扱い**に化ける。
    const fresh =
      accessToken !== null &&
      Number.isFinite(expiresAtMs) &&
      expiresAtMs - args.deps.now() > ACCESS_TOKEN_SKEW_MS
    if (fresh && accessToken !== null) return accessToken
    return refresh()
  }

  return { get, refresh }
}

// ============================================================
// 接続 1 件の同期
// ============================================================

interface ConnectionRow {
  id: string
  household_id: string
  user_id: string
}

async function syncConnection(
  supabase: SupabaseClient<Database>,
  deps: GoogleSyncDeps,
  connection: ConnectionRow,
): Promise<ConnectionSyncOutcome> {
  const householdId = connection.household_id
  const outcome: ConnectionSyncOutcome = {
    connectionId: connection.id,
    needsReauth: false,
    subscriptions: [],
  }

  const owner: GoogleTokenOwner = {
    connectionId: connection.id,
    householdId,
    userId: connection.user_id,
  }

  try {
    const tokenRow = await loadGoogleTokens(supabase, owner)
    if (tokenRow === null) {
      // 接続はあるがトークンが無い = callback が途中で落ちた形。再連携が要る。
      console.error("[google-sync] 接続にトークン行がありません", {
        connectionId: connection.id,
        householdId,
      })
      await markConnection(supabase, connection.id, householdId, {
        connection_status: "needs_reauth",
        sync_status: "error",
        last_error_kind: "invalid_grant",
      })
      outcome.needsReauth = true
      return outcome
    }

    const tokens = createAccessTokenSession({
      supabase,
      deps,
      owner,
      refreshToken: tokenRow.refreshToken,
      accessToken: tokenRow.accessToken,
      accessTokenExpiresAt: tokenRow.accessTokenExpiresAt,
    })

    // 秘密列（sync_token）を読むため service role が要る。列は明示する。
    const { data: subscriptions, error: subError } = await supabase
      .from("google_calendar_subscriptions")
      .select("id, google_calendar_id, sync_token")
      .eq("connection_id", connection.id)
      .eq("household_id", householdId)
      .eq("is_selected", true)
      .order("id")

    if (subError) {
      logSupabaseError("google-sync", "購読一覧の取得に失敗", subError, {
        connectionId: connection.id,
        householdId,
      })
      throw new Error("[google-sync] 購読一覧の取得に失敗しました")
    }

    for (const subscription of subscriptions ?? []) {
      outcome.subscriptions.push(
        await syncSubscription({
          supabase,
          deps,
          subscription,
          householdId,
          sourceUserId: connection.user_id,
          tokens,
        }),
      )
    }

    const failed = outcome.subscriptions.filter(
      (s) => s.status === "failed" || s.status === "resync_required",
    )
    const patch: Database["public"]["Tables"]["google_connections"]["Update"] = {
      sync_status: failed.length > 0 ? "error" : "idle",
      last_error_kind: failed[0]?.errorKind ?? null,
    }
    // 失敗（410 含む）のときは **last_synced_at を前進させぬ**。前進させると
    // staleness ゲートが次のオンデマンド同期を抑止し、410 直後の「空の
    // カレンダー」が cron まで居座る。
    if (failed.length === 0) {
      patch.last_synced_at = new Date(deps.now()).toISOString()
    }
    await markConnection(supabase, connection.id, householdId, patch)

    return outcome
  } catch (err) {
    const kind = toErrorKind(err)
    console.error("[google-sync] 接続の同期に失敗", {
      connectionId: connection.id,
      householdId,
      kind,
      message: err instanceof Error ? err.message : String(err),
    })
    // invalid_grant = refresh token の失効/取消（**恒久**）。握り潰さず
    // `needs_reauth` へ遷移させ、設定カードの再連携導線へつなぐ（§D-5）。
    const needsReauth =
      err instanceof GoogleAuthError && err.kind === "invalid_grant"
    await markConnection(supabase, connection.id, householdId, {
      ...(needsReauth ? { connection_status: "needs_reauth" as const } : {}),
      sync_status: "error",
      last_error_kind: kind,
    })
    outcome.needsReauth = needsReauth
    return outcome
  }
}

async function markConnection(
  supabase: SupabaseClient<Database>,
  connectionId: string,
  householdId: string,
  patch: Database["public"]["Tables"]["google_connections"]["Update"],
): Promise<void> {
  const { error } = await supabase
    .from("google_connections")
    .update(patch)
    .eq("id", connectionId)
    .eq("household_id", householdId)
  if (error) {
    // ここで throw すると同期結果まで巻き戻る。状態表示の失敗は致命ではないゆえ
    // 構造化ログに残して続行する（握り潰しではない）。
    logSupabaseError("google-sync", "接続状態の更新に失敗", error, {
      connectionId,
      householdId,
    })
  }
}

// ============================================================
// 公開 API
// ============================================================

/**
 * 世帯 1 件を同期する（オンデマンド経路 / 明示トリガの入口）。
 *
 * `connection_status='needs_reauth'` の接続は**触らぬ**（refresh が必ず失敗し、
 * Google へ無駄な往復を撃つだけゆえ）。それ以外の値は未知値も含めて同期する
 * （下の `.neq(...)` の注記を見よ）。
 */
export async function syncHousehold(
  supabase: SupabaseClient<Database>,
  householdId: string,
  overrides: Partial<GoogleSyncDeps> = {},
): Promise<HouseholdSyncSummary> {
  const deps: GoogleSyncDeps = { ...DEFAULT_DEPS, ...overrides }

  const { data: connections, error } = await supabase
    .from("google_connections")
    .select("id, household_id, user_id")
    .eq("household_id", householdId)
    // enum drift 防御: 除外したい値だけを名指しする **denylist**。
    // `.eq("connection_status", "active")` の allowlist にすると、DB に新しい
    // 状態値が増えた瞬間その接続が**無音で同期対象から漏れる**（CLAUDE.md
    // 「判定の向き」）。除きたいのは「再連携が要る」接続ただ一つじゃ。
    .neq("connection_status", "needs_reauth")
    .order("id")

  if (error) {
    logSupabaseError("google-sync", "接続一覧の取得に失敗", error, {
      householdId,
    })
    throw new Error("[google-sync] 接続一覧の取得に失敗しました")
  }

  const outcomes: ConnectionSyncOutcome[] = []
  for (const connection of connections ?? []) {
    outcomes.push(await syncConnection(supabase, deps, connection))
  }

  return { householdId, connections: outcomes }
}

/**
 * 有効な接続を持つ全世帯を同期する（cron のバックストップ）。
 *
 * 1 世帯の失敗で他世帯を巻き込まぬよう、世帯ごとに catch する。
 */
export async function syncAllHouseholds(
  supabase: SupabaseClient<Database>,
  overrides: Partial<GoogleSyncDeps> = {},
): Promise<{ households: number; summaries: HouseholdSyncSummary[] }> {
  const { data: connections, error } = await supabase
    .from("google_connections")
    .select("household_id")
    // denylist（上の syncHousehold と同じ理由）。
    .neq("connection_status", "needs_reauth")

  if (error) {
    logSupabaseError("google-sync", "同期対象世帯の取得に失敗", error)
    throw new Error("[google-sync] 同期対象世帯の取得に失敗しました")
  }

  const householdIds = [
    ...new Set((connections ?? []).map((row) => row.household_id)),
  ]

  const summaries: HouseholdSyncSummary[] = []
  for (const householdId of householdIds) {
    try {
      summaries.push(await syncHousehold(supabase, householdId, overrides))
    } catch (err) {
      console.error("[google-sync] 世帯の同期に失敗（他世帯は続行）", {
        householdId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { households: householdIds.length, summaries }
}
