import { cache } from "react"
import { createClient } from "@/lib/supabase/server"

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  householdId: string
}

// React.cache() で同一リクエスト内の重複呼び出しをメモ化する。
// page.tsx と内部で呼ばれる Server Function の両方から呼ばれても、
// auth.getUser() と profiles クエリは1回のみ実行される。
export const getAuthContext = cache(
  async (): Promise<
    { error: string; context: null } | { error: null; context: AuthContext }
  > => {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { error: "認証されていません", context: null }

    const { data: profile } = await supabase
      .from("profiles")
      .select("household_id")
      .eq("id", user.id)
      .single()

    if (!profile?.household_id) return { error: "世帯が設定されていません", context: null }

    return { error: null, context: { supabase, userId: user.id, householdId: profile.household_id } }
  },
)
