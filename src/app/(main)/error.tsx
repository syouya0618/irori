"use client"

import { useEffect } from "react"
import { AlertTriangle } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

export default function MainError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error("Main layout error:", error)
  }, [error])

  return (
    <ErrorView
      icon={AlertTriangle}
      title="問題が発生しました"
      message="ページの読み込み中にエラーが発生しました。"
      onRetry={unstable_retry}
      minHeight="60dvh"
    />
  )
}
