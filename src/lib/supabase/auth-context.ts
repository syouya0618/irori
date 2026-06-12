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
    const { data: { user } } = await supabase.auth.getUser()
    if (!user)
      return { error: "認証されていません", reason: "unauthenticated", context: null }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("household_id")
      .eq("id", user.id)
      .single()

    if (profileError) {
      logSupabaseError("auth-context", "profile lookup failed", profileError, {
        userId: user.id,
      })
    }

    if (!profile?.household_id)
      return { error: "世帯が設定されていません", reason: "no-household", context: null }

    return { error: null, reason: null, context: { supabase, userId: user.id, householdId: profile.household_id } }
  },
)
