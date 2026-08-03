import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/**
 * service role キーで動く Supabase クライアント（**RLS を完全にバイパスする**）。
 *
 * ## 呼んでよい場所（これ以外から呼ぶな）
 *
 * 1. **Google OAuth callback の書き込み**（`google_connections` / `google_tokens` は
 *    INSERT/UPDATE の RLS ポリシーも GRANT も持たぬ = service role 専用）。
 * 2. **同期エンジン**（`calendar_events` の google 行 upsert / delete、
 *    `google_calendar_subscriptions.sync_token` の読み書き）。
 * 3. **cron ハンドラ**（CRON_SECRET を検証した**後**）。
 *
 * ## 呼んではならぬ場所
 *
 * - **Server Component の描画経路**（計画書 V4 の訂正）。ページの staleness 判定は
 *   authenticated client で `google_connections` を読み、service role が要る処理は
 *   `after()` の**内側でのみ**このクライアントを生成すること。描画経路に置くと、
 *   ページを 1 枚開くたびに RLS バイパス経路が走る。
 * - **クライアントコンポーネント**。`SUPABASE_SERVICE_ROLE_KEY` は `NEXT_PUBLIC_`
 *   接頭辞を持たぬゆえバンドルへは埋まらぬが、その場合 env が undefined になって
 *   下の fail-closed で落ちる。加えて `typeof window` ガードで明示的に落とす。
 *
 * ## 呼び出し側の義務
 *
 * RLS が効かぬ以上、**世帯スコープはコードが担う**。全クエリで `household_id` /
 * `user_id` / `connection_id` を明示 `.eq()` すること（計画書 §D-8 の不変条件:
 * 「OSS 公開 × 家族専用インスタンス」はこの一点で守られておる）。
 */
export function createAdminClient(): SupabaseClient<Database> {
  // ブラウザで生成されることは設計上あり得ぬ。万一 import 境界を跨いだ場合に
  // 「env が undefined ゆえ落ちた」ではなく理由を名指しして落とす。
  if (typeof window !== "undefined") {
    throw new Error(
      "[supabase-admin] service role クライアントはサーバでのみ生成できます"
    )
  }

  // env は `?.trim()` で防御する（ペースト時の末尾改行混入が過去 4 回再発しておる）。
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

  // fail-closed: 未設定なら throw する。**anon クライアントへ黙って落とさぬ**
  // （落とすと RLS で 0 行になり「同期したのに何も入らぬ」が無音で起きる）。
  if (!url) {
    throw new Error(
      "[supabase-admin] NEXT_PUBLIC_SUPABASE_URL が未設定です"
    )
  }
  if (!serviceRoleKey) {
    throw new Error(
      "[supabase-admin] SUPABASE_SERVICE_ROLE_KEY が未設定です"
    )
  }

  return createClient<Database>(url, serviceRoleKey, {
    auth: {
      // service role は cookie セッションを持たぬ。永続化・自動更新・URL 検出は
      // 全て無効にする（サーバ環境でストレージへ触らせない）。
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  })
}
