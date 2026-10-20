"use client"

import { useState } from "react"
import { toast } from "sonner"
import { FileDown, Download, FileJson, Loader2 } from "lucide-react"
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
  // 全期間は JSON（持ち出し・バックアップ）だけ。PDF は受診用の短い期間に限る
  { value: "all", label: "全期間" },
] as const

type Period = (typeof PERIOD_OPTIONS)[number]["value"]
type Kind = "pdf" | "json"

/**
 * route に届かなんだ応答の振り分け。
 *
 * - `"unauthenticated"`: route 自身の 401。route は 401 を**未認証の時だけ**返す
 *   （profiles の一過性の取得失敗は 503、未承認・世帯なしは 403 — UX-03）
 * - `"redirected"`: proxy の 307。`redirect: "manual"` では opaqueredirect（status 0）
 *   として届き、環境によっては 3xx のまま見える。proxy は未認証なら /login へ、
 *   未承認**または profiles の一過性の取得失敗**なら /pending-approval へ送るゆえ、
 *   ここでは原因を断定できぬ（N1）。再読み込みすれば proxy が正しい画面へ振り分ける
 */
type GateOutcome = "unauthenticated" | "redirected" | null

function gateOutcome(res: Response): GateOutcome {
  if (res.status === 401) return "unauthenticated"
  if (
    res.type === "opaqueredirect" ||
    res.status === 0 ||
    (res.status >= 300 && res.status < 400)
  ) {
    return "redirected"
  }
  return null
}

const GATE_MESSAGES: Record<Exclude<GateOutcome, null>, string> = {
  unauthenticated: "セッションが切れました。ログインし直してください",
  redirected: "ログイン状態を確認できませんでした。画面を再読み込みしてください",
}

/**
 * 401 / 3xx 以外の失敗 → 利用者の次の一手が分かる文言。status は報告できるよう残す。
 * - 403: route が未承認・世帯なしと判定した（ログインし直しても直らぬ）
 * - 5xx: サーバ側の障害（一過性の取得失敗は 503）。待てば直る側じゃ
 */
function downloadFailureMessage(status: number, noun: string): string {
  if (status === 403) {
    return `このアカウントでは ${noun} を出力できません（承認されていないか、世帯に参加していません）`
  }
  if (status >= 500) {
    return `ダウンロードに失敗しました。時間をおいてもう一度お試しください（HTTP ${status}）`
  }
  return `ダウンロードに失敗しました（HTTP ${status}）`
}

/** `Content-Disposition: attachment; filename="x"` から保存名を取る（無ければ既定） */
function filenameFrom(res: Response, fallback: string): string {
  const header = res.headers.get("content-disposition") ?? ""
  const match = /filename="([^"]+)"/.exec(header)
  return match ? match[1] : fallback
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 記録の持ち出し（機能 D）。
 * - PDF: 小児科受診用の集計（既存）
 * - JSON: 全項目の機械可読な書き出し（バックアップ・表計算や他アプリでの利用）。
 *   件数を本文から読んで表示し、上限で切り詰められた時は全件でないことを伝える
 */
export function ExportCard() {
  const [period, setPeriod] = useState<Period>("1week")
  const [downloading, setDownloading] = useState<Kind | null>(null)
  const pdfUnavailable = period === "all"

  const handleDownload = async (kind: Kind) => {
    const noun = kind === "pdf" ? "PDF" : "JSON"
    const url =
      kind === "pdf"
        ? `/api/baby-report?period=${period}`
        : `/api/baby-export?period=${period}`
    setDownloading(kind)
    try {
      // ⚠️ 307 を追わせぬ。追うと login 画面の HTML を 200 で受け、それを
      // baby-log.pdf として保存してしまう（受診当日に開けぬファイルが黙って渡る）。
      const res = await fetch(url, { redirect: "manual" })
      const gate = gateOutcome(res)
      if (gate !== null) {
        console.error("[export-card] 認証・承認の門で route に届きませんでした", {
          kind,
          gate,
          status: res.status,
          type: res.type,
          period,
        })
        toast.error(GATE_MESSAGES[gate])
        return
      }
      if (!res.ok) {
        // status を握り潰さない。小児科の受診当日に失敗した時、セッション切れ（上で
        // 再ログインを促した）と 500 / 503（サーバ側の DB エラー・一過性の障害）では
        // 利用者の次の一手が全く違う。
        console.error("[export-card] route の取得に失敗しました", {
          kind,
          status: res.status,
          statusText: res.statusText,
          period,
        })
        toast.error(downloadFailureMessage(res.status, noun))
        return
      }
      const contentType = res.headers.get("content-type") ?? ""
      if (kind === "pdf") {
        // 保存してよいのは PDF だけじゃ。200 でも中身が HTML 等なら、それは
        // レポートではない（壊れたファイルを渡すより、失敗と言う方がましじゃ）。
        if (!contentType.includes("application/pdf")) {
          console.error("[export-card] baby-report が PDF 以外を返しました", {
            kind,
            status: res.status,
            contentType,
            period,
          })
          toast.error("ダウンロードに失敗しました（PDF を受け取れませんでした）")
          return
        }
        saveBlob(await res.blob(), filenameFrom(res, "baby-log.pdf"))
        // サーバが上限で切り詰めた場合は成功トーストではなく警告を出す
        // （PDF 本文にも同じ警告が刷り込まれている）。
        if (res.headers.get("X-Report-Truncated") === "1") {
          toast.warning(
            "記録が多いため、一部のみのレポートです（全件ではありません）",
          )
        }
        return
      }

      if (!contentType.includes("application/json")) {
        console.error("[export-card] baby-export が JSON 以外を返しました", {
          kind,
          status: res.status,
          contentType,
          period,
        })
        toast.error("ダウンロードに失敗しました（JSON を受け取れませんでした）")
        return
      }
      // 本文を一度読んで形を確かめ、件数を利用者に見せる（取りこぼしを隠さぬ）
      const text = await res.text()
      let counts: { logs: number; diaries: number } | null = null
      try {
        const parsed = JSON.parse(text) as { counts?: { logs?: number; diaries?: number } }
        if (
          typeof parsed.counts?.logs === "number" &&
          typeof parsed.counts?.diaries === "number"
        ) {
          counts = { logs: parsed.counts.logs, diaries: parsed.counts.diaries }
        }
      } catch (err) {
        console.error("[export-card] baby-export の本文を JSON として読めませんでした", {
          kind,
          period,
          message: err instanceof Error ? err.message : String(err),
        })
        toast.error("ダウンロードに失敗しました（JSON を読み取れませんでした）")
        return
      }
      saveBlob(
        new Blob([text], { type: "application/json" }),
        filenameFrom(res, "uchinolog.json"),
      )
      if (res.headers.get("X-Export-Truncated") === "1") {
        toast.warning(
          "記録が多いため、一部のみの書き出しです（全件ではありません）",
        )
        return
      }
      toast.success(
        counts
          ? `記録 ${counts.logs} 件・日記 ${counts.diaries} 件を書き出しました`
          : "書き出しました",
      )
    } catch (err) {
      // bind の無い `catch {}` は真因を完全に消す。通信断・CORS・blob 失敗の
      // いずれかを後から切り分けられるよう、必ず構造化して残す。
      console.error("[export-card] ダウンロードで例外", {
        kind,
        message: err instanceof Error ? err.message : String(err),
        period,
      })
      toast.error("ダウンロードに失敗しました")
    } finally {
      setDownloading(null)
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
          小児科受診用の PDF と、バックアップや表計算で使える JSON（全項目・機械可読）を書き出します。
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
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => handleDownload("pdf")}
            disabled={downloading !== null || pdfUnavailable}
            className="cursor-pointer"
          >
            {downloading === "pdf" ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Download size={16} />
            )}
            PDFをダウンロード
          </Button>
          {pdfUnavailable && (
            <p className="text-xs text-muted-foreground">
              PDF は 3ヶ月までです。全期間は JSON で書き出せます
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => handleDownload("json")}
            disabled={downloading !== null}
            className="cursor-pointer"
          >
            {downloading === "json" ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <FileJson size={16} />
            )}
            JSONをダウンロード
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
