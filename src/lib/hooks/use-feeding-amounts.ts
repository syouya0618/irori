"use client"

import { useEffect, useState } from "react"
import { createClient } from "@/lib/supabase/client"

type Amounts = { scope: string; status: "loading" | "ready" | "error"; values: number[] }

/** DB-confirmed, personal MRU. Never optimistically remember an attempted save. */
export function useFeedingAmounts(open: boolean, userId: string, householdId: string | undefined, type: string, childId?: string) {
  const scope = `${userId}:${householdId}:${childId}:${type}`
  const enabled = open && !!householdId && ["bottle", "pumped", "solid"].includes(type)
  const [result, setResult] = useState<Amounts>({ scope: "", status: "loading", values: [] })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let disposed = false
    const timeout = setTimeout(() => {
      controller.abort()
      if (!disposed) setResult({ scope, status: "error", values: [] })
    }, 8_000)
    void (async () => {
      try {
        const supabase = createClient(childId)
        const { data: claims, error: authError } = await supabase.auth.getClaims()
        if (controller.signal.aborted) return
        if (authError || claims?.claims.sub !== userId) throw new Error("session unavailable")
        const { data, error } = await supabase.from("feeding_amount_history")
          .select("amount_ml")
          .eq("user_id", userId).eq("household_id", householdId!).eq("feeding_type", type)
          .order("use_order", { ascending: false }).limit(5).abortSignal(controller.signal)
        if (disposed || controller.signal.aborted) return
        if (error || !data || data.some((row) => !Number.isInteger(row.amount_ml) || row.amount_ml < 0 || row.amount_ml > 999)) {
          throw new Error("amount history unavailable")
        }
        setResult({ scope, status: "ready", values: data.map((row) => row.amount_ml) })
      } catch {
        if (!disposed && !controller.signal.aborted) setResult({ scope, status: "error", values: [] })
      } finally { clearTimeout(timeout) }
    })()
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [enabled, scope, userId, householdId, type, childId])
  if (!enabled) return { status: "ready" as const, values: [] }
  return result.scope === scope ? result : { status: "loading" as const, values: [] }
}
