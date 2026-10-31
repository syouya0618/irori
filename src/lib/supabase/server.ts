import { cache } from "react"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import type { Database } from "@/lib/types/database"

async function makeClient(childId?: string) {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
    {
      global: { headers: childId ? { "x-irori-child": childId } : {} },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // Server Component からの呼び出し時は無視。
            // proxy がセッションをリフレッシュするので問題ない。
          }
        },
      },
    }
  )
}

/** React.cache is request-local in RSC; never a process-wide SDK singleton. Child headers remain immutable. */
export const createClient = cache(makeClient)
