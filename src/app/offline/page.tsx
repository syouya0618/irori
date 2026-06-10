import type { Metadata } from "next"
import Link from "next/link"
import { WifiOff, UtensilsCrossed } from "lucide-react"
import { ReloadButton } from "./reload-button"

export const metadata: Metadata = {
  title: "オフライン | うちのログ",
}

/**
 * オフラインフォールバックページ
 *
 * Service Worker (public/sw.js) が install 時に precache し、
 * 未キャッシュページへのオフラインアクセス時に表示する。
 * データ取得なしの静的ページ (個人データゼロ) のため、proxy.ts の matcher から除外して
 * 未認証でも取得できるようにしている。
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div className="glass flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl p-8 text-center shadow-lg shadow-black/[0.04]">
        <div className="flex size-16 items-center justify-center rounded-full bg-amber-100">
          <WifiOff className="size-8 text-amber-600" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">オフラインです</h1>
          <p className="text-sm text-muted-foreground">
            インターネットに接続できません。
            接続が回復したら、再読み込みしてください。
            一度表示したページはオフラインでも閲覧できます。
          </p>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <ReloadButton />
          <Link
            href="/meals"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <UtensilsCrossed className="size-4" />
            献立ページへ
          </Link>
        </div>
      </div>
    </div>
  )
}
