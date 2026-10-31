import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/**
 * Client refresh query for the selected child's usual amount. Omitting childId retains
 * the legacy household path for compatibility. SSR reuses getChildContext's row and
 * shares decodeBottleDefault, so it needs no second read of the same child.
 */
export function selectBottleDefault(
  supabase: SupabaseClient<Database>,
  householdId: string,
  signal?: AbortSignal,
  childId?: string,
) {
  const query = supabase
    .from(childId ? "children" : "households")
    .select("bottle_default_ml")
    .eq("id", childId ?? householdId)
  return (signal ? query.abortSignal(signal) : query).maybeSingle()
}
