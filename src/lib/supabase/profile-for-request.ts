import { cache } from "react"
import { createClient } from "./server"

/** Request-local only. Layout and settings read the same profile once; never cache across users. */
export const getProfileForRequest = cache(async (userId: string) => {
  const supabase = await createClient()
  return supabase
    .from("profiles")
    .select("id, household_id, is_approved, display_name, avatar_url, role, default_page")
    .eq("id", userId)
    .single()
})
