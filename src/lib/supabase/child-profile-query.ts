import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

export function selectChildProfile(client: SupabaseClient<Database>, householdId: string, childId?: string) {
  return childId
    ? client.from("children").select("baby_name:name, baby_birth_date:birth_date").eq("household_id", householdId).eq("id", childId).single()
    : client.from("households").select("baby_name, baby_birth_date").eq("id", householdId).single()
}
