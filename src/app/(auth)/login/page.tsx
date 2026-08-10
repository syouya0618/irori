import { Suspense } from "react"
import { Flame } from "lucide-react"
import { LoginNotice } from "./login-notice"
import { LoginForm } from "./login-form"

/**
 * ログイン画面。
 *
 * このページ自体は Server Component のまま（＝プリレンダされる `○ /login`）にし、
 * クエリを読む `LoginNotice` だけを `<Suspense>` で切り離してある。
 * `useSearchParams` はプリレンダされたルートでは「最も近い Suspense 境界まで」を
 * クライアント描画へ落とすため、境界を置かねば**画面全体が CSR に落ちる**
 * （node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md）。
 * fallback を null にしてあるのは、理由が無い通常の来訪では何も出さぬのが正しく、
 * 一瞬の空白も生じさせぬため。
 */
export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary/10">
            <Flame className="size-8 text-primary" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            うちのログ
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            夫婦の献立・買い物・暮らしをひとつに
          </p>
        </div>

        <Suspense fallback={null}>
          <LoginNotice />
        </Suspense>

        <LoginForm />

        <p className="mt-6 text-center text-xs text-muted-foreground">
          パスワード不要。メールアドレスだけでログインできます。
        </p>
      </div>
    </div>
  )
}
