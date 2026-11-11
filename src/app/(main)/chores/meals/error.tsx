"use client"

import { useEffect } from "react"
import { CookingPot } from "lucide-react"

import { ErrorView } from "@/components/common/error-view"

/**
 * ごはん（/chores/meals とその下位の page）の error boundary。layout の内側に出るので、
 * 見出しと切替は残る（別の画面へ移れる）。
 *
 * 再試行の prop は `retry`（Next 16.3 で `unstable_retry` から改名。
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md`）。
 * `retry` は境界の子を取り直して描き直す（`reset` は取り直さない別物）。
 */
export default function MealsError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  useEffect(() => {
    console.error("Meals error:", error)
  }, [error])

  return (
    <ErrorView
      icon={CookingPot}
      title="ごはんの読み込みに失敗しました"
      message="通信状況を確認して、もう一度お試しください。登録した食材や献立が消えたわけではありません。"
      onRetry={retry}
      minHeight="40dvh"
    />
  )
}
