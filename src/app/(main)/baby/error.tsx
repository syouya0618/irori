"use client"

import { useEffect } from "react"
import { Baby } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

export default function BabyError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error("Baby log error:", error)
  }, [error])

  return (
    <ErrorView
      icon={Baby}
      title="育児ログの読み込みに失敗しました"
      message="通信状況を確認して、もう一度お試しください。"
      onRetry={unstable_retry}
    />
  )
}
