import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { BottomNav } from "@/components/common/bottom-nav"

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // 世帯が未設定なら /setup へ
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

  if (profileError) {
    console.error("[main-layout] profile lookup failed", {
      message: profileError.message,
      code: profileError.code,
      details: profileError.details,
      hint: profileError.hint,
      userId: user.id,
    })
  }

  if (!profile?.household_id) {
    redirect("/setup")
  }

  return (
    <div className="min-h-dvh bg-background">
      <main className="mx-auto max-w-lg pb-20">{children}</main>
      <BottomNav />
    </div>
  )
}
