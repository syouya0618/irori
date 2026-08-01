import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { getVerifiedUserId } from "@/lib/supabase/verified-user"
import { SetupForm } from "./setup-form"
import { JoinByInviteForm } from "./join-by-invite-form"

export default async function SetupPage() {
  const supabase = await createClient()
  // proxy と同じ判定源を使う（別方式にすると食い違いで無限リダイレクトになる）
  const userId = await getVerifiedUserId(supabase, "setup")

  if (!userId) {
    redirect("/login")
  }

  // Check if user already has a household
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", userId)
    .single()

  if (profileError) {
    logSupabaseError("setup", "profile lookup failed", profileError, {
      userId,
    })
  }

  if (profile?.household_id) {
    redirect("/meals")
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            世帯をつくる
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            まずは世帯名を決めましょう
          </p>
        </div>

        <SetupForm />

        <div className="my-6 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-xs text-muted-foreground">または</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <JoinByInviteForm />
      </div>
    </div>
  )
}
