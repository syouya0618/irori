"use client"

import { useSearchParams } from "next/navigation"
import { AlertCircle } from "lucide-react"
import { messageForAuthErrorReason } from "@/lib/auth/auth-error-messages"

/**
 * リンクを踏んだ側の失敗理由を表示する。
 *
 * `auth/callback` は交換に失敗すると `/login?error=<reason>` へ飛ばす。
 * **かつてこのクエリは誰も読んでおらず**、利用者から見れば「リンクを踏むと
 * 無言でログイン画面に戻る」だけじゃった（2026-08-10 に実際に起きた）。
 *
 * ⚠️ 文言は必ず `messageForAuthErrorReason` の表から引く。クエリの値をそのまま
 * 描画すると、URL に書かれた任意の文章を画面に出す装置になる。未知の値は
 * null を返し、**何も出さぬ**のが正しい（偽の指示を出すより無言の方がまし）。
 *
 * `useSearchParams` はプリレンダされたルートでは「最も近い Suspense 境界まで」を
 * クライアント描画へ落とすため、`page.tsx` 側で `<Suspense>` に包んである
 * （node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-search-params.md）。
 * ゆえにこの断片だけが CSR になり、ページ本体はプリレンダのまま保たれる。
 */
export function LoginNotice() {
  const message = messageForAuthErrorReason(useSearchParams().get("error"))
  if (!message) return null

  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-foreground"
    >
      <AlertCircle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <p>{message}</p>
    </div>
  )
}
