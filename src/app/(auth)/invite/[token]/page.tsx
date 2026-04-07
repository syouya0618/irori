import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { InviteAcceptForm } from "./invite-accept-form"

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  // Not logged in -> redirect to login with returnTo
  if (!user) {
    redirect(`/login?returnTo=/invite/${token}`)
  }

  // Check current user's profile
  const { data: profile } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

  // Validate token
  const { data: invitation } = await supabase
    .from("invitations")
    .select("id, household_id, role, status, expires_at")
    .eq("token", token)
    .single()

  // Invalid or not found
  if (!invitation) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
            <h2 className="text-lg font-semibold text-foreground">
              無効な招待リンク
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              この招待リンクは無効です。正しいリンクを確認してください。
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Already expired
  if (new Date(invitation.expires_at) < new Date()) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
            <h2 className="text-lg font-semibold text-foreground">
              招待の有効期限切れ
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              この招待リンクの有効期限が切れています。招待者に新しいリンクを発行してもらってください。
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Already accepted
  if (invitation.status !== "pending") {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
            <h2 className="text-lg font-semibold text-foreground">
              この招待は使用済みです
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              この招待リンクはすでに使用されています。
            </p>
          </div>
        </div>
      </div>
    )
  }

  // User already belongs to a household
  if (profile?.household_id) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
            <h2 className="text-lg font-semibold text-foreground">
              すでに世帯に参加しています
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              現在の世帯を退出してから、新しい招待を受けてください。
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Fetch household name separately
  const { data: household } = await supabase
    .from("households")
    .select("name")
    .eq("id", invitation.household_id)
    .single()

  const householdName = household?.name ?? "不明な世帯"

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <InviteAcceptForm
          invitationId={invitation.id}
          householdName={householdName}
          role={invitation.role}
          userId={user.id}
        />
      </div>
    </div>
  )
}
