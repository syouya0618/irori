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
      if (!res.ok) {
        // status を握り潰さない。小児科の受診当日に失敗した時、401（セッション切れ）
        // と 500（サーバ側の DB エラー）では利用者の次の一手が全く違う。
        console.error("[export-card] baby-report の取得に失敗しました", {
          status: res.status,
          statusText: res.statusText,
          period,
        })
        toast.error(`ダウンロードに失敗しました（HTTP ${res.status}）`)
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `baby-log.pdf`
      a.click()
      URL.revokeObjectURL(url)

      // サーバが上限で切り詰めた場合は成功トーストではなく警告を出す
      // （PDF 本文にも同じ警告が刷り込まれている）。
      if (res.headers.get("X-Report-Truncated") === "1") {
        toast.warning(
          "記録が多いため、一部のみのレポートです（全件ではありません）",
        )
      }
    } catch (err) {
      // bind の無い `catch {}` は真因を完全に消す。通信断・CORS・blob 失敗の
      // いずれかを後から切り分けられるよう、必ず構造化して残す。
      console.error("[export-card] baby-report のダウンロードで例外", {
        message: err instanceof Error ? err.message : String(err),
        period,
      })
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
