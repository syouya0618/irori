import { cache } from "react"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  householdId: string
}

// React.cache() で同一リクエスト内の重複呼び出しをメモ化する。
// (main)/layout.tsx・page.tsx・内部で呼ばれる Server Function のどこから
// 呼ばれても、auth.getUser() と profiles クエリは1回のみ実行される。
// reason は layout のリダイレクト先分岐用 (error 文字列比較を避ける)。
export const getAuthContext = cache(
  async (): Promise<
    | { error: string; reason: "unauthenticated" | "no-household"; context: null }
    | { error: null; reason: null; context: AuthContext }
  > => {
    const supabase = await createClient()

    // トークン検証は getClaims()（proxy.ts と同じ理由・同じ規約）。
    // getUser() は JWT ごとに Auth サーバへ往復するが、getClaims() は非対称鍵なら
    // ローカル WebCrypto 検証で完結する（実測 16.55ms → 0.14ms）。
    // 失効はアクセストークン TTL ぶん遅延するが、承認は proxy の DB 読みで即時に効き、
    // 世帯分離は RLS が JWT の sub で毎回評価する。詳細は proxy.ts の注記を参照。
    //
    // ⚠️ fail-closed: 判定不能（claims なし・error・sub 欠落・例外）は全て
    // "unauthenticated" へ倒す。ここが緩むと世帯データへ未認証で到達しうる。
    // 不変条件は __tests__/auth-context.test.ts が固定する。
    let userId: string | null = null
    try {
      const { data, error } = await supabase.auth.getClaims()
      if (error) {
        logSupabaseError("auth-context", "getClaims failed", error, {})
      }
      const sub = data?.claims?.sub
      userId = typeof sub === "string" && sub.length > 0 ? sub : null
    } catch (err) {
      console.error("[auth-context] getClaims が例外を投げました", {
        message: err instanceof Error ? err.message : String(err),
      })
      userId = null
    }

    if (!userId)
      return { error: "認証されていません", reason: "unauthenticated", context: null }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("household_id")
      .eq("id", userId)
      .single()

    if (profileError) {
      logSupabaseError("auth-context", "profile lookup failed", profileError, {
        userId,
      })
    }

    if (!profile?.household_id)
      return { error: "世帯が設定されていません", reason: "no-household", context: null }

    return { error: null, reason: null, context: { supabase, userId, householdId: profile.household_id } }
  },
)
