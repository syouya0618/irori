"use client"

import { useState } from "react"
import { toast } from "sonner"
import { FileDown, Download, Loader2 } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { segmentCn } from "@/lib/utils/segment-cn"

const PERIOD_OPTIONS = [
  { value: "1week", label: "1週間" },
  { value: "1month", label: "1ヶ月" },
  { value: "3months", label: "3ヶ月" },
] as const

export function ExportCard() {
  const [period, setPeriod] = useState("1week")
  const [isDownloading, setIsDownloading] = useState(false)

  const handleDownload = async () => {
    setIsDownloading(true)
    try {
      const res = await fetch(`/api/baby-report?period=${period}`)
      if (!res.ok) throw new Error()
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `baby-log.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error("ダウンロードに失敗しました")
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileDown size={18} />
          記録エクスポート
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-xs text-muted-foreground">
          小児科受診用のPDFレポートを生成します。
        </p>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPeriod(opt.value)}
              className={segmentCn(period === opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="lg"
          onClick={handleDownload}
          disabled={isDownloading}
          className="cursor-pointer"
        >
          {isDownloading ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <Download size={16} />
          )}
          PDFをダウンロード
        </Button>
      </CardContent>
    </Card>
  )
}
