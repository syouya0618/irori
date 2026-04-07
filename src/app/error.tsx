"use client"

import { useEffect } from "react"
import { AlertTriangle, RotateCcw } from "lucide-react"

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error("Global error:", error)
  }, [error])

  return (
    <div className="flex min-h-dvh items-center justify-center bg-gradient-to-b from-orange-50 to-amber-50 px-4">
      <div className="flex max-w-sm flex-col items-center gap-6 rounded-2xl border border-white/30 bg-white/55 p-8 text-center shadow-lg shadow-black/[0.04] backdrop-blur-[40px]">
        <div className="flex size-16 items-center justify-center rounded-full bg-amber-100">
          <AlertTriangle className="size-8 text-amber-600" />
        </div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-[oklch(0.18_0.02_50)]">
            問題が発生しました
          </h1>
          <p className="text-sm text-[oklch(0.50_0.02_50)]">
            申し訳ございません。予期しないエラーが発生しました。
          </p>
        </div>

        <button
          onClick={() => unstable_retry()}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[oklch(0.65_0.19_50)] px-6 py-3 text-sm font-semibold text-white transition-colors duration-200 hover:bg-[oklch(0.60_0.19_50)]"
        >
          <RotateCcw className="size-4" />
          もう一度試す
        </button>
      </div>
    </div>
  )
}
