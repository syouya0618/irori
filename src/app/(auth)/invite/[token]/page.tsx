import Link from "next/link"
import { redirect } from "next/navigation"
import { Baby } from "lucide-react"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { InviteAcceptForm } from "./invite-accept-form"

function InviteError({
  title,
  description,
  showAppLink = false,
}: {
  title: string
  description: string
  /** 世帯を持つ利用者向け。行き止まりにせず自分の世帯（/baby）へ戻す導線を出す */
  showAppLink?: boolean
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="glass rounded-2xl p-6 text-center shadow-lg shadow-black/[0.04]">
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          {showAppLink && (
            // not-found.tsx と同じ素の <Link>（buttonVariants は transition-all を含む）
            <Link
              href="/baby"
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary/90"
            >
              <Baby className="size-4" />
              育児ページへ
            </Link>
          )}
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

  // proxy と同じ判定源を使う（別方式にすると食い違いで無限リダイレクトになる）
  const userId = await getVerifiedUserId(supabase, "invite")

  if (!userId) {
    redirect(`/login?returnTo=/invite/${token}`)
  }

  // profile と invitation を並列取得
  const [
    { data: profile, error: profileError },
    { data: invitations, error: invitationsError },
  ] = await Promise.all([
    supabase.from("profiles").select("household_id").eq("id", userId).single(),
    supabase.rpc("get_invitation_by_token", { invite_token: token }),
  ])

  if (profileError) {
    logSupabaseError("invite", "profile lookup failed", profileError, {
      userId,
    })
  }

  // token は secret なので構造化ログには含めない (userId のみ)。
  if (invitationsError) {
    logSupabaseError("invite", "invitation lookup failed", invitationsError, {
      userId,
    })
  }

  const invitation = invitations?.[0]

  // 世帯を持つ利用者は招待を使えぬ（accept_invitation が拒む）。ただし文言は招待先の
  // 世帯と**比べてから**決める（F2 / UX-04）。招待を受けて入った家族が別の端末や
  // チャットの履歴から同じリンクを開き直すのは普通のことで、そこへ「別の世帯に参加済み・
  // 移れません」と出せば、誤った世帯に入って戻れぬと読ませてしまう（P2-26 の逆向き）。
  // 開き直したリンクは普通「使用済み」ゆえ、期限切れ・使用済みの判定より先に見る。
  if (profile?.household_id) {
    if (invitation?.household_id === profile.household_id) {
      return (
        <InviteError
          title="この世帯にはすでに参加しています"
          description={`「${invitation.household_name}」に参加済みです。このまま使い続けられます。`}
          showAppLink
        />
      )
    }
    if (invitation) {
      return (
        <InviteError
          title="すでに世帯に参加しています"
          description="別の世帯に参加済みのため、この招待は使えません（参加する世帯はあとから移れません）。"
          showAppLink
        />
      )
    }
    // 招待が引けぬ（無効なリンク・取得失敗）時は、別の世帯かどうか分からぬ。断定せぬ。
    return (
      <InviteError
        title="すでに世帯に参加しています"
        description="世帯に参加済みのため、この招待リンクは使えません。"
        showAppLink
      />
    )
  }

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
        />
      </div>
    </div>
  )
}
