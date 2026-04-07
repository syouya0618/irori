import Link from "next/link"
import { Home, SearchX } from "lucide-react"

export default function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-orange-50 to-amber-50 px-4">
      <div className="glass flex max-w-sm flex-col items-center gap-6 rounded-2xl p-8 text-center shadow-lg shadow-black/[0.04]">
        <div className="flex size-16 items-center justify-center rounded-full bg-primary/10">
          <SearchX className="size-8 text-primary" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-foreground">
            ページが見つかりません
          </h1>
          <p className="text-sm text-muted-foreground">
            お探しのページは存在しないか、移動した可能性があります。
          </p>
        </div>

        <Link
          href="/meals"
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-colors duration-200 hover:bg-primary/90"
        >
          <Home className="size-4" />
          ホームに戻る
        </Link>
      </div>
    </div>
  )
}
