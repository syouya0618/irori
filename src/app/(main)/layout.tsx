import { redirect } from "next/navigation"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { BottomNav } from "@/components/common/bottom-nav"
import { CacheUserGuard } from "@/components/common/cache-user-guard"
import { OnboardingTour } from "@/components/common/onboarding-tour"

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
    // 一過性の DB エラーは「世帯なし」ではない。redirect すると**世帯が在るのに
    // /setup（世帯作成画面）へ飛ばされ**、利用者が世帯を二重に作りかねない。
    // 判定不能は誘導せず error boundary へ倒す（再試行ボタンで自己回復する）。
    //
    // ⚠️ この throw を受けるのは `(main)/error.tsx` ではなく **`app/error.tsx`** じゃ。
    // Next 公式 docs 原文（node_modules/next/dist/docs/01-app/03-api-reference/
    // 03-file-conventions/error.md:96）:
    //   "It does **not** wrap the `layout.js` or `template.js` above it in the
    //    same segment."
    // ゆえに同一セグメントの error.tsx は自分の layout の throw を捕まえられぬ。
    if (reason === "lookup-failed") {
      throw new Error("プロフィールの取得に失敗しました")
    }
    // 遷移先は proxy の分岐と一致させる（層をまたぐ判定の食い違いは無限
    // リダイレクトを生む）。proxy も未承認を /pending-approval へ送る。
    if (reason === "not-approved") redirect("/pending-approval")
    redirect(reason === "no-household" ? "/setup" : "/login")
  }

  return (
    <div className="min-h-dvh bg-background">
      {/* 別ユーザーログイン時に前ユーザーの世帯キャッシュ (SW) を破棄 */}
      <CacheUserGuard userId={context.userId} />
      <main className="mx-auto max-w-lg pb-20">{children}</main>
      <BottomNav />
      {/* 初回ユーザーに使い方ツアーを表示（既読は localStorage 判定・自己 gating） */}
      <OnboardingTour />
    </div>
  )
}
