import { createClient } from "@/lib/supabase/server"
import { SettingsContent } from "./settings-content"

export default async function SettingsPage() {
  const supabase = await createClient()

  // No auth/redirect checks needed - layout handles them
  const { data: { user } } = await supabase.auth.getUser()

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, household_id, role, default_page")
    .eq("id", user!.id)
    .single()

  const { data: household } = await supabase
    .from("households")
    .select("id, name")
    .eq("id", profile!.household_id!)
    .single()

  // ownerのみ: 承認待ちユーザー取得
  let pendingUsers: { id: string; display_name: string; email: string; created_at: string }[] = []
  if (profile!.role === "owner") {
    const { data } = await supabase.rpc("get_pending_approvals")
    pendingUsers = data ?? []
  }

  return (
    <SettingsContent
      profile={{
        id: profile!.id,
        displayName: profile!.display_name,
        avatarUrl: profile!.avatar_url,
        role: profile!.role,
        defaultPage: profile!.default_page ?? "meals",
      }}
      household={
        household
          ? { id: household.id, name: household.name }
          : null
      }
      email={user!.email ?? ""}
      pendingUsers={pendingUsers}
    />
  )
}
