import { redirect } from "next/navigation"
import { createClient } from "@/lib/supabase/server"
import { VALID_PAGES, type ValidPage } from "@/lib/constants/pages"

export default async function Home() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect("/login")

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("default_page")
    .eq("id", user.id)
    .single()

  if (profileError) {
    console.error("[home] profile lookup failed", {
      message: profileError.message,
      code: profileError.code,
      details: profileError.details,
      hint: profileError.hint,
      userId: user.id,
    })
  }

  const page = VALID_PAGES.includes(profile?.default_page as ValidPage)
    ? (profile!.default_page as ValidPage)
    : "meals"

  redirect(`/${page}`)
}
