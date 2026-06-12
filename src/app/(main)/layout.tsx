import { redirect } from "next/navigation"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { BottomNav } from "@/components/common/bottom-nav"
import { CacheUserGuard } from "@/components/common/cache-user-guard"

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // getAuthContext は React.cache() 済み — 同一リクエスト内で page 側の呼び出し
  // と dedupe され、auth.getUser() + profiles クエリは 1 回に畳まれる
  // (従来は layout 独自に getUser + profiles を発行し、page と二重だった)
  const { context, reason } = await getAuthContext()

  if (!context) {
    redirect(reason === "no-household" ? "/setup" : "/login")
  }

  return (
    <div className="min-h-dvh bg-background">
      {/* 別ユーザーログイン時に前ユーザーの世帯キャッシュ (SW) を破棄 */}
      <CacheUserGuard userId={context.userId} />
      <main className="mx-auto max-w-lg pb-20">{children}</main>
      <BottomNav />
    </div>
  )
}
