import { cache } from "react"
import { cookies } from "next/headers"
import { getAuthContext } from "./auth-context"
import { createClient } from "./server"
import { isClientId } from "@/lib/utils/client-id"
import { redirect } from "next/navigation"

export const getChildContext = cache(async (requestedId?: string) => {
  const auth = await getAuthContext()
  if (auth.error !== null) {
    // Pages and layouts render concurrently. Match MainLayout's navigation for
    // expected denials instead of racing its redirect with a page error.
    if (auth.reason === "no-household") redirect("/setup")
    if (auth.reason === "unauthenticated") redirect("/login")
    if (auth.reason === "not-approved") redirect("/pending-approval")
    if (auth.reason === "shared-only") redirect("/shared")
    throw new Error(auth.error)
  }
  const { data: children, error } = await auth.context.supabase.from("children")
    .select("*").eq("household_id", auth.context.householdId).order("created_at")
  if (error || !children?.length) throw new Error("子どもの情報を取得できませんでした")
  const selected = requestedId ?? (await cookies()).get("irori-child")?.value
  const child = children.find(c => c.id === selected) ?? (requestedId ? undefined : children.find(c => c.is_legacy))
  if (!child) throw new Error("子どもの情報を取得できませんでした")
  return { ...auth.context, supabase: await createClient(child.id), child, children }
})

/** Omission always means the migrated legacy child, never the mutable selection cookie. */
export async function getBabyAuthContext(childId?: string) {
  const auth = await getAuthContext()
  if (auth.error !== null || childId === undefined) return auth
  if (!isClientId(childId)) return { error: "子どもの指定が不正です", reason: "no-household" as const, context: null }
  return { ...auth, context: { ...auth.context, supabase: await createClient(childId) } }
}
