import { createClient } from "@/lib/supabase/server"
import { SettingsContent } from "./settings-content"

export default async function SettingsPage() {
  const supabase = await createClient()

  // No auth/redirect checks needed - layout handles them
  const { data: { user } } = await supabase.auth.getUser()

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, display_name, avatar_url, household_id, role")
    .eq("id", user!.id)
    .single()

  const { data: household } = await supabase
    .from("households")
    .select("id, name")
    .eq("id", profile!.household_id!)
    .single()

  return (
    <SettingsContent
      profile={{
        id: profile!.id,
        displayName: profile!.display_name,
        avatarUrl: profile!.avatar_url,
        role: profile!.role,
      }}
      household={
        household
          ? { id: household.id, name: household.name }
          : null
      }
      email={user!.email ?? ""}
    />
  )
}
