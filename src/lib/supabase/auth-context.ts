import { createClient } from "@/lib/supabase/server"

export type AuthContext = {
  supabase: Awaited<ReturnType<typeof createClient>>
  userId: string
  householdId: string
}

export async function getAuthContext(): Promise<
  { error: string; context: null } | { error: null; context: AuthContext }
> {
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
}
