import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { SharedSignOut } from "@/components/sharing/shared-sign-out"
import { CacheUserGuard } from "@/components/common/cache-user-guard"
export default async function SharedLayout({ children }: { children: React.ReactNode }) {
  const client=await createClient()
  const userId=await getVerifiedUserId(client,"shared-layout")
  if(!userId) redirect("/login")
  const { data:profile,error }=await client.from("profiles").select("household_id,is_approved").eq("id",userId).single()
  if(error || !profile) throw new Error("プロフィールを確認できませんでした")
  if(!profile.is_approved) redirect("/pending-approval")
  return <><CacheUserGuard userId={userId} householdId={profile.household_id ?? "shared-only"}/>{children}<SharedSignOut/></>
}
