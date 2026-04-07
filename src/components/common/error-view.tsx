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
}

export function ErrorView({
  icon: Icon,
  title,
  message,
  onRetry,
  minHeight = "50dvh",
}: ErrorViewProps) {
  return (
    <div
      className="flex items-center justify-center px-4"
      style={{ minHeight }}
    >
      <div className="glass flex max-w-sm flex-col items-center gap-6 rounded-2xl p-8 text-center shadow-lg shadow-black/[0.04]">
        <div className="flex size-14 items-center justify-center rounded-full bg-amber-100">
          <Icon className="size-7 text-amber-600" />
        </div>
        <div className="space-y-2">
          <h2 className="text-lg font-bold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        <Button onClick={onRetry} className="min-h-11 gap-2">
          <RotateCcw className="size-4" />
          もう一度試す
        </Button>
      </div>
    </div>
  )
}
