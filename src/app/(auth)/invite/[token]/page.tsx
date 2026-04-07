import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { InviteAcceptForm } from "./invite-accept-form"

function InviteError({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  )
}

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

  if (!user) {
    redirect(`/login?returnTo=/invite/${token}`)
  }

  // profile と invitation を並列取得
  const [{ data: profile }, { data: invitations }] = await Promise.all([
    supabase.from("profiles").select("household_id").eq("id", user.id).single(),
    supabase.rpc("get_invitation_by_token", { invite_token: token }),
  ])

  if (profile?.household_id) {
    return (
      <InviteError
        title="すでに世帯に参加しています"
        description="現在の世帯を退出してから、新しい招待を受けてください。"
      />
    )
  }

  const invitation = invitations?.[0]

  if (!invitation) {
    return (
      <InviteError
        title="無効な招待リンク"
        description="この招待リンクは無効です。正しいリンクを確認してください。"
      />
    )
  }

  if (new Date(invitation.expires_at) < new Date()) {
    return (
      <InviteError
        title="招待の有効期限切れ"
        description="この招待リンクの有効期限が切れています。招待者に新しいリンクを発行してもらってください。"
      />
    )
  }

  if (invitation.status !== "pending") {
    return (
      <InviteError
        title="この招待は使用済みです"
        description="この招待リンクはすでに使用されています。"
      />
    )
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <InviteAcceptForm
          invitationId={invitation.id}
          householdName={invitation.household_name}
          role={invitation.role}
          userId={user.id}
        />
      </div>
    </div>
  )
}
