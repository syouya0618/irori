"use client"

import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"

/** /offline 用の再読み込みボタン (window 参照のため最小限の client 部品) */
export function ReloadButton() {
  return (
    <Button
      type="button"
      onClick={() => window.location.reload()}
      className="min-h-11 cursor-pointer gap-2"
    >
      <RotateCcw className="size-4" />
      再読み込み
    </Button>
  )
}
