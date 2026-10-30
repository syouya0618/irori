import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

// Browser-only instances have immutable narrowing headers. Never reuse them across SSR requests.
const scopedClients = new Map<string, SupabaseClient<Database>>()
export function createClient(childId?: string) {
  if (typeof window !== "undefined" && childId && scopedClients.has(childId)) return scopedClients.get(childId)!
  const client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
    // A singleton would retain the first child's headers after a switch.
    { isSingleton: !childId, global: { headers: childId ? { "x-irori-child": childId } : {} } },
  )
  if (typeof window !== "undefined" && childId) scopedClients.set(childId,client)
  return client
}
