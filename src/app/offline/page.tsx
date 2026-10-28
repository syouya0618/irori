import type { Metadata } from "next"
import Link from "next/link"
import { WifiOff, Baby } from "lucide-react"
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
    <div className="bg-hearth flex min-h-dvh items-center justify-center px-4">
      <div className="glass flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl p-8 text-center shadow-lg shadow-black/[0.04]">
        <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
          <WifiOff className="size-8 text-primary" aria-hidden="true" />
        </div>

        <div className="space-y-3">
          <h1 className="text-2xl font-bold text-foreground">オフラインです</h1>
          <p className="text-sm text-muted-foreground">
            インターネットに接続できません。接続が回復したら、再読み込みしてください。
          </p>
          {/* 戻れる範囲と、できぬことを分けて正直に書く（sw.js の APP_PAGES・持ち主付きの保存・
              件数の上限が実際の範囲。「一度表示したページは全て見られる」とは約束せぬ） */}
          <div className="space-y-1 rounded-xl bg-muted/50 p-3 text-left text-sm">
            <p className="font-medium text-foreground">見られることがあるもの</p>
            <p className="text-muted-foreground">
              育児・カレンダー・設定のうち、この端末で最近開いた画面を、その時点の内容で表示できることがあります。開いた後の記録や家族の変更は出ません。
            </p>
          </div>
          <div className="space-y-1 rounded-xl bg-muted/50 p-3 text-left text-sm">
            <p className="font-medium text-foreground">オフラインの間にできないこと</p>
            <p className="text-muted-foreground">
              記録の保存、家族との共有、新しい内容の読み込み。ログアウトや権限の変更も、つながるまでこの端末には反映されません。
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <ReloadButton />
          <Link
            href="/baby"
            className="inline-flex min-h-11 items-center gap-2 rounded-lg px-6 py-3 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:text-foreground"
          >
            <Baby className="size-4" />
            育児ページへ
          </Link>
        </div>
      </div>
    </div>
  )
}
