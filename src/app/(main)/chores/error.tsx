"use client"

import { useEffect } from "react"
import { ListChecks } from "lucide-react"
import { ErrorView } from "@/components/common/error-view"

/**
 * 家事（/chores とその下位）の error boundary。
 * 再試行の prop は `retry`（Next 16.3 で `unstable_retry` から改名。error-boundaries.test.tsx が固定）。
 */
export default function ChoresError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error("Chores error:", error)
  }, [error])

  return (
    <ErrorView
      icon={ListChecks}
      title="家事の読み込みに失敗しました"
      message="通信状況を確認して、もう一度お試しください。登録した内容が消えたわけではありません。"
      onRetry={retry}
    />
  )
}
