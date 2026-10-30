import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { SharedInvite } from "@/components/sharing/shared-view"
export const dynamic = "force-dynamic"
export default async function SharedInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!/^[a-f0-9]{64}$/.test(token)) return <p>無効な招待です</p>
  const client = await createClient()
  if (!await getVerifiedUserId(client,"shared-invite-page")) redirect(`/login?returnTo=/invite/${token}/shared`)
  return <SharedInvite token={token} />
}
