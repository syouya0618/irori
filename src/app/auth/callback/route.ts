import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getAppOrigin } from "@/lib/utils/app-origin"

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // request.url の origin は loopback アクセス時に localhost へ正規化されるため
  // 使わない (issue #16)。NEXT_PUBLIC_APP_URL → host ヘッダの順で解決する。
  const origin = getAppOrigin(request)
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
