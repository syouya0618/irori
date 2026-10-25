"use client"

import { useEffect } from "react"
import { AlertTriangle } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

/**
 * ルートの error boundary。(main) の layout が throw した時（lookup-failed 等）はここが受ける。
 *
 * 以前は oklch の直書き・`bg-white/55`・`backdrop-blur-[40px]` のリテラルで組んであり、
 * ダークでも画面全体が白く光った上、Chrome でぼかしが落ちる #169 の書き方を再演しておった。
 * 他の境界と同じ ErrorView（glass + トークン）で描き、殻は bg-hearth に揃える。
 * `retry` は Next 16.3 のランタイムが渡す名（`error-boundaries.test.tsx` が本物の境界で検証）。
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error("Global error:", error)
  }, [error])

  return (
    <div className="bg-hearth min-h-dvh">
      <ErrorView
        icon={AlertTriangle}
        title="問題が発生しました"
        message="申し訳ございません。予期しないエラーが発生しました。"
        onRetry={retry}
        minHeight="100dvh"
        heading="h1"
      />
    </div>
  )
}
