import { after } from "next/server"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { createAdminClient } from "@/lib/supabase/admin"
import { syncHousehold } from "@/lib/google/sync"
import { latestIsoTimestamp } from "@/lib/domain/google-sync-signal"

/**
 * オンデマンド同期のトリガ（計画書 §7 D-4「同期トリガー」）。
 *
 * ## `after()` について（同梱 docs `01-app/03-api-reference/04-functions/after.md` 実読）
 * - 「`after` is not a Request-time API and calling it does not cause a route to
 *   become dynamic. **If it's used within a static page, the callback will execute
 *   at build time**, or whenever a page is revalidated.」
 *   → 静的ページに置くとビルド時に走る。`/calendar` は `getAuthContext()` が
 *     cookie を読むため動的（build 出力で `ƒ`）じゃ。**置き先を移すときは
 *     ビルド出力で `ƒ` を確認せよ。**
 * - 「`after` will be executed even if the response didn't complete successfully.
 *   Including when an error is thrown or when `notFound` or `redirect` is called.」
 *   → ゆえに **`getAuthContext()` を通った後にのみ**呼ぶこと。手前に置くと、
 *     `/setup` へ redirect される未所属の利用者でも同期が走る。
 * - 「Server Components ... **cannot** use `cookies`, `headers` ... inside `after`」
 *   → コールバックの中で request API を触らぬ。必要な値は先に読んで閉包で渡す。
 * - 「`after` will run for the platform's default or configured max duration of
 *   your route」→ ページに `export const maxDuration = 30` を置く。
 *
 * ## V4 の訂正: 描画経路に service role を置かぬ
 * staleness 判定は **authenticated client** で `google_connections` を読む
 * （household RLS で SELECT 可・非機密）。`createAdminClient()` は
 * `after()` の**内側でのみ**生成する。
 *
 * ## V7 の訂正: Realtime を使わぬ
 * `google_calendar_subscriptions` は `sync_token` / `sync_lease_until` という秘密を
 * 持つため publication へ載せぬ。同期完了は `syncScheduled === true` のときだけ
 * client が `last_synced_at` を短間隔でポーリングし、前進したら refetch する。
 * **削除のみの同期サイクルは `calendar_events` に INSERT/UPDATE を生まぬ**ゆえ、
 * この経路が削除反映の唯一の担保じゃ。
 *
 * ## クライアント引数を `supabase` と名付ける理由
 * `scripts/check-supabase-error-destructure.py` が識別子 `supabase` にしか
 * アンカーせぬ（`sync.ts` 冒頭の注記と同じ）。改名するな。
 */

/** 前回同期からこの時間が経っていれば stale とみなす。 */
export const SYNC_STALE_MS = 5 * 60 * 1000

export interface MaybeScheduleSyncResult {
  /**
   * V7: バックグラウンド同期を予約したか。
   * client はこれが true のときだけ `last_synced_at` をポーリングする。
   */
  syncScheduled: boolean
  /** ポーリングの基準値（世帯内の接続のうち最新のもの）。接続が無ければ null。 */
  lastSyncedAt: string | null
  /** 世帯に Google 接続が 1 つでもあるか（UI の出し分け用）。 */
  hasConnection: boolean
}

export interface ScheduleSyncDeps {
  now: () => number
  /** `after()` 相当。テストでは同期実行や記録に差し替える。 */
  schedule: (task: () => Promise<void>) => void
  /** 実際の同期。既定は service role クライアントを**この中で**生成する。 */
  runSync: (householdId: string) => Promise<void>
}

const DEFAULT_DEPS: ScheduleSyncDeps = {
  now: () => Date.now(),
  schedule: (task) => {
    after(task)
  },
  runSync: async (householdId) => {
    // ここは `after()` の内側（レスポンス送出後）。描画経路には service role を
    // 一切置かぬ、という V4 の訂正はこの 1 行の位置で担保されておる。
    const supabase = createAdminClient()
    await syncHousehold(supabase, householdId)
  },
}

/**
 * カレンダーページの描画時に呼ぶ。前回同期から `SYNC_STALE_MS` 経っていれば
 * `after()` で背景同期を予約する。
 *
 * **必ず `getAuthContext()` を通った後に呼ぶこと**（上の `after` の注記）。
 */
export async function maybeScheduleSync(
  supabase: SupabaseClient<Database>,
  householdId: string,
  overrides: Partial<ScheduleSyncDeps> = {},
): Promise<MaybeScheduleSyncResult> {
  const deps: ScheduleSyncDeps = { ...DEFAULT_DEPS, ...overrides }

  const { data: connections, error } = await supabase
    .from("google_connections")
    .select("id, connection_status, last_synced_at")
    .eq("household_id", householdId)

  if (error) {
    logSupabaseError("google-sync-trigger", "接続の取得に失敗", error, {
      householdId,
    })
    // 判定不能でページを倒さぬ。同期は cron のバックストップに委ねる。
    return { syncScheduled: false, lastSyncedAt: null, hasConnection: false }
  }

  const rows = connections ?? []
  // enum drift 防御: 除外したい値だけを名指しする **denylist** で書く。
  // `=== "active"` の allowlist にすると、DB に新しい状態が増えた瞬間その接続が
  // **無音で同期対象から漏れる**（CLAUDE.md「判定の向き」）。
  const syncable = rows.filter((row) => row.connection_status !== "needs_reauth")
  const lastSyncedAt = latestIsoTimestamp(
    rows.map((row) => row.last_synced_at),
  )

  if (syncable.length === 0) {
    return { syncScheduled: false, lastSyncedAt, hasConnection: rows.length > 0 }
  }

  const now = deps.now()
  const isStale = syncable.some((row) => {
    if (row.last_synced_at === null) return true
    const ms = Date.parse(row.last_synced_at)
    // 壊れた値は「分からぬ」ゆえ stale 側へ倒す（同期を止めるより走らせる）。
    if (!Number.isFinite(ms)) return true
    return now - ms > SYNC_STALE_MS
  })

  if (!isStale) {
    return { syncScheduled: false, lastSyncedAt, hasConnection: true }
  }

  deps.schedule(async () => {
    try {
      await deps.runSync(householdId)
    } catch (err) {
      // `after()` の中の reject はレスポンスに影響せぬが、握り潰すと
      // 「同期したのに何も起きぬ」が原因不明になる。必ず構造化ログへ落とす。
      console.error("[google-sync-trigger] 背景同期に失敗", {
        householdId,
        message: err instanceof Error ? err.message : String(err),
      })
    }
  })

  return { syncScheduled: true, lastSyncedAt, hasConnection: true }
}
