import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get("code")
  const returnTo = searchParams.get("returnTo")

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)

    if (!error) {
      // returnTo がある場合はそちらにリダイレクト（相対パスのみ許可、open redirect防止）
      if (returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")) {
        return NextResponse.redirect(`${origin}${returnTo}`)
      }
      return NextResponse.redirect(`${origin}/`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
