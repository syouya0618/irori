"use client"

import { useEffect } from "react"
import { UtensilsCrossed } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

export default function MealsError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error("Meals error:", error)
  }, [error])

  return (
    <ErrorView
      icon={UtensilsCrossed}
      title="献立の読み込みに失敗しました"
      message="通信状況を確認して、もう一度お試しください。"
      onRetry={unstable_retry}
    />
  )
}
