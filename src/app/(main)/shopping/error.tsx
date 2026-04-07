"use client"

import { useEffect } from "react"
import { ShoppingCart } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

export default function ShoppingError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error("Shopping error:", error)
  }, [error])

  return (
    <ErrorView
      icon={ShoppingCart}
      title="買い物リストの読み込みに失敗しました"
      message="通信状況を確認して、もう一度お試しください。"
      onRetry={unstable_retry}
    />
  )
}
