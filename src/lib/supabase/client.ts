import { createBrowserClient } from "@supabase/ssr"
import type { Database } from "@/lib/types/database"

export function createClient(childId?: string) {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
    // A singleton would retain the first child's headers after a switch.
    { isSingleton: !childId, global: { headers: childId ? { "x-irori-child": childId } : {} } },
  )
}
