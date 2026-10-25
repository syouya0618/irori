"use client"

import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { LucideIcon } from "lucide-react"

interface ErrorViewProps {
  icon: LucideIcon
  title: string
  message: string
  onRetry: () => void
  minHeight?: string
  /** 見出しの段。ページ全体を占めるルートの境界は h1、区画の境界は h2（既定） */
  heading?: "h1" | "h2"
}

/**
 * エラー状態の共通表示（各 error.tsx が使う）。
 *
 * アイコンの丸は `bg-primary/10 text-primary`（ログイン・世帯作成・404 と同じ語彙）。
 * 以前の `bg-amber-100 text-amber-600` はダーク用の指定が無く、夜間に明るい円だけが
 * 浮いて見えた。primary はテーマごとに値を持つため追従する。
 */
export function ErrorView({
  icon: Icon,
  title,
  message,
  onRetry,
  minHeight = "50dvh",
  heading: Heading = "h2",
}: ErrorViewProps) {
  return (
    <div
      className="flex items-center justify-center px-4"
      style={{ minHeight }}
    >
      <div className="glass flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl p-8 text-center shadow-lg shadow-black/[0.04]">
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10">
          <Icon className="size-7 text-primary" aria-hidden="true" />
        </div>
        <div className="space-y-2">
          <Heading className="text-lg font-bold text-foreground">{title}</Heading>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <Button onClick={onRetry} className="min-h-11 gap-2">
          <RotateCcw className="size-4" aria-hidden="true" />
          もう一度試す
        </Button>
      </div>
    </div>
  )
}
