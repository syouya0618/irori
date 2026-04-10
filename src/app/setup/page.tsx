import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { SetupForm } from "./setup-form"

export default async function SetupPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect("/login")
  }

  // Check if user already has a household
  const { data: profile } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", user.id)
    .single()

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
      </div>
    </div>
  )
}
