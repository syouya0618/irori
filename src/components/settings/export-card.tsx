"use client"

import Link from "next/link"
import { useChildScope } from "@/components/baby/child-scope"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { FileDown, Download, FileJson, FileSpreadsheet, Loader2, X } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { segmentCn } from "@/lib/utils/segment-cn"
import { EXPORT_CONSISTENCY_NOTE } from "@/lib/domain/baby-export"
import {
  recordClientFailure,
  type DiagnosticFailureKind,
} from "@/lib/diagnostics/diagnostic-summary"

const PERIOD_OPTIONS = [
  { value: "1week", label: "1週間" },
  { value: "1month", label: "1ヶ月" },
  { value: "3months", label: "3ヶ月" },
  // 全期間は JSON / CSV（持ち出し・バックアップ）だけ。PDF は受診用の短い期間に限る
  { value: "all", label: "全期間" },
] as const

type Period = (typeof PERIOD_OPTIONS)[number]["value"]
type Kind = "pdf" | "json" | "csv-logs" | "csv-diaries"

/**
 * 1 回の取得（本文の読み込みまで）の期限。サーバの maxDuration（30 秒）に通信の往復を足した値。
 * 超えたら取り消し、ファイルは保存せぬ（待ち続けさせぬ）。
 */
export const EXPORT_TIMEOUT_MS = 45_000

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

export const EXPORT_CANCELED_MESSAGE = "書き出しを取り消しました。ファイルは保存していません"
export const EXPORT_TIMEOUT_MESSAGE =
  "時間内に終わらなかったため取り消しました。ファイルは保存していません。期間を短くするか、時間をおいてお試しください"

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
  // iOS Safari は click の直後に revoke すると保存が始まらぬことがある（未実機確認）ゆえ、少し待って畳む
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const NOUNS: Record<Kind, string> = {
  pdf: "PDF",
  json: "JSON",
  "csv-logs": "記録の CSV",
  "csv-diaries": "日記の CSV",
}

/** 続きの位置（分割回収）。最初の部分で決まった範囲を固定して運ぶ */
interface ExportChain {
  kind: Exclude<Kind, "pdf">
  period: Period
  from: string
  to: string
  /** 次に取る部分の番号 */
  nextPart: number
  logsAfter: string | null
  diariesAfter: string | null
}

/** 直近の書き出しの結果（範囲・取得時刻・件数・続きの有無を画面に残す） */
interface ExportOutcome {
  noun: string
  part: number
  from: string
  to: string
  fetchedAt: string | null
  logs: number | null
  diaries: number | null
  hasMore: boolean
}

function baseQuery(kind: Exclude<Kind, "pdf">, period: Period): URLSearchParams {
  const params = new URLSearchParams({ period })
  if (kind === "csv-logs") {
    params.set("format", "csv")
    params.set("table", "logs")
  } else if (kind === "csv-diaries") {
    params.set("format", "csv")
    params.set("table", "diaries")
  }
  return params
}

function urlFor(kind: Kind, period: Period, chain: ExportChain | null): string {
  if (kind === "pdf") return `/api/baby-report?period=${period}`
  const params = baseQuery(kind, period)
  if (chain) {
    params.set("from", chain.from)
    params.set("to", chain.to)
    params.set("part", String(chain.nextPart))
    if (chain.logsAfter !== null) params.set("logs_after", chain.logsAfter)
    if (chain.diariesAfter !== null) params.set("diaries_after", chain.diariesAfter)
  }
  return `/api/baby-export?${params.toString()}`
}

function decodeHeader(res: Response, name: string): string | null {
  const raw = res.headers.get(name)
  if (raw === null) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return null
  }
}

function countHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name)
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : null
}

const JST_TIME = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

function rangeLabel(from: string, to: string): string {
  return from === "all" ? `最初の記録〜${to}` : `${from}〜${to}`
}

/**
 * 記録の持ち出し（機能 D・2026-10-27 大型更新 E2）。
 * - PDF: 小児科受診用の集計（既存）
 * - JSON: 全項目の機械可読な書き出し（バックアップ・他アプリでの利用）
 * - CSV: 表計算向け（記録・日記で別ファイル）
 *
 * 通信は期限（45 秒・本文の読み込みまで）と取消しボタンを持ち、取消し・期限切れ・失敗を分けて伝える。
 * 取り消した後は何も保存せぬ。件数が多くて一度に入り切らぬ時は「一部」と伝え、「続きを書き出す」で
 * 同じ範囲の続きを次のファイルとして取る（全件と偽らぬ）。
 */
export function ExportCard() {
  const childScope = useChildScope()
  const [period, setPeriod] = useState<Period>("1week")
  const [downloading, setDownloading] = useState<Kind | null>(null)
  const [chain, setChain] = useState<ExportChain | null>(null)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const abortReasonRef = useRef<"user" | "timeout" | null>(null)
  const pdfUnavailable = period === "all"

  // 画面を離れたら取り消す（応答の後で保存を始めぬ）
  useEffect(() => {
    return () => {
      abortReasonRef.current = "user"
      controllerRef.current?.abort()
    }
  }, [])

  const selectPeriod = (next: Period) => {
    setPeriod(next)
    // 範囲を変えたら続きは捨てる（別の範囲の続きを混ぜぬ）
    setChain(null)
    setOutcome(null)
  }

  const cancel = () => {
    abortReasonRef.current = "user"
    controllerRef.current?.abort()
  }

  const handleDownload = async (kind: Kind, continueChain: ExportChain | null = null) => {
    const noun = NOUNS[kind]
    const baseUrl = urlFor(kind, period, continueChain)
    const url = baseUrl + (childScope ? `&child=${encodeURIComponent(childScope.id)}` : "")
    const controller = new AbortController()
    controllerRef.current = controller
    abortReasonRef.current = null
    const startedAt = Date.now()
    // AbortSignal.timeout / any は古い iOS に無いことがあるゆえ、1 つの controller と setTimeout で持つ
    const timer = setTimeout(() => {
      abortReasonRef.current = "timeout"
      controller.abort()
    }, EXPORT_TIMEOUT_MS)
    const fail = (failure: DiagnosticFailureKind) =>
      recordClientFailure({ op: "export", kind: failure, elapsedMs: Date.now() - startedAt })
    /** 取消しと期限切れを分けて伝える（どちらもファイルは保存しておらぬ） */
    const reportAbort = () => {
      if (abortReasonRef.current === "timeout") {
        console.error("[export-card] 期限切れで取り消しました", { kind, period, timeoutMs: EXPORT_TIMEOUT_MS })
        fail("timeout")
        toast.error(EXPORT_TIMEOUT_MESSAGE)
      } else {
        toast.info(EXPORT_CANCELED_MESSAGE)
      }
    }
    setDownloading(kind)
    try {
      // ⚠️ 307 を追わせぬ。追うと login 画面の HTML を 200 で受け、それを
      // baby-log.pdf として保存してしまう（受診当日に開けぬファイルが黙って渡る）。
      const res = await fetch(url, { redirect: "manual", signal: controller.signal })
      const gate = gateOutcome(res)
      if (gate !== null) {
        console.error("[export-card] 認証・承認の門で route に届きませんでした", {
          kind,
          gate,
          status: res.status,
          type: res.type,
          period,
        })
        fail("auth")
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
        fail(res.status >= 500 ? "http-5xx" : "http-4xx")
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
          fail("malformed")
          toast.error("ダウンロードに失敗しました（PDF を受け取れませんでした）")
          return
        }
        const blob = await res.blob()
        if (controller.signal.aborted) {
          reportAbort()
          return
        }
        saveBlob(blob, filenameFrom(res, "baby-log.pdf"))
        // サーバが上限で切り詰めた場合は成功トーストではなく警告を出す
        // （PDF 本文にも同じ警告が刷り込まれている）。
        if (res.headers.get("X-Report-Truncated") === "1") {
          toast.warning(
            "記録が多いため、一部のみのレポートです（全件ではありません）",
          )
        }
        return
      }

      const isCsv = kind === "csv-logs" || kind === "csv-diaries"
      const expected = isCsv ? "text/csv" : "application/json"
      if (!contentType.includes(expected)) {
        console.error("[export-card] baby-export が期待と違う形式を返しました", {
          kind,
          status: res.status,
          contentType,
          period,
        })
        fail("malformed")
        toast.error(`ダウンロードに失敗しました（${isCsv ? "CSV" : "JSON"} を受け取れませんでした）`)
        return
      }

      let blob: Blob
      let counts: { logs: number; diaries: number } | null = null
      if (isCsv) {
        // CSV は text() を通さぬ（UTF-8 の復号が先頭の BOM を落とし、Excel で文字化けする）
        blob = await res.blob()
        const logs = countHeader(res, "X-Export-Count-Logs")
        const diaries = countHeader(res, "X-Export-Count-Diaries")
        if (logs !== null && diaries !== null) counts = { logs, diaries }
      } else {
        // 本文を一度読んで形を確かめ、件数を利用者に見せる（取りこぼしを隠さぬ）
        const text = await res.text()
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
          fail("malformed")
          toast.error("ダウンロードに失敗しました（JSON を読み取れませんでした）")
          return
        }
        blob = new Blob([text], { type: "application/json" })
      }
      // 読み込みの途中で取り消された（期限切れ・取消しボタン）なら保存せぬ
      if (controller.signal.aborted) {
        reportAbort()
        return
      }
      saveBlob(blob, filenameFrom(res, isCsv ? "uchinolog.csv" : "uchinolog.json"))

      const part = continueChain?.nextPart ?? 1
      const from = res.headers.get("X-Export-From") ?? continueChain?.from ?? null
      const to = res.headers.get("X-Export-To") ?? continueChain?.to ?? null
      const truncated = res.headers.get("X-Export-Truncated") === "1"
      const nextLogs = decodeHeader(res, "X-Export-Next-Logs-After")
      const nextDiaries = decodeHeader(res, "X-Export-Next-Diaries-After")
      const canContinue = truncated && from !== null && to !== null && (nextLogs !== null || nextDiaries !== null)
      setChain(
        canContinue
          ? {
              kind,
              period,
              from,
              to,
              nextPart: part + 1,
              logsAfter: nextLogs,
              diariesAfter: nextDiaries,
            }
          : null,
      )
      setOutcome(
        from !== null && to !== null
          ? {
              noun,
              part,
              from,
              to,
              fetchedAt: res.headers.get("X-Export-Fetched-At"),
              logs: counts?.logs ?? null,
              diaries: counts?.diaries ?? null,
              hasMore: truncated,
            }
          : null,
      )
      if (truncated) {
        toast.warning(
          canContinue
            ? "記録が多いため、一部のみの書き出しです（全件ではありません）。「続きを書き出す」で残りを取れます"
            : "記録が多いため、一部のみの書き出しです（全件ではありません）",
        )
        return
      }
      const countText = isCsv
        ? kind === "csv-logs"
          ? counts && `記録 ${counts.logs} 件`
          : counts && `日記 ${counts.diaries} 件`
        : counts && `記録 ${counts.logs} 件・日記 ${counts.diaries} 件`
      const suffix = part >= 2 ? `（第${part}部で最後です）` : ""
      toast.success(countText ? `${countText}を書き出しました${suffix}` : `書き出しました${suffix}`)
    } catch (err) {
      if (controller.signal.aborted) {
        reportAbort()
        return
      }
      // bind の無い `catch {}` は真因を完全に消す。通信断・CORS・blob 失敗の
      // いずれかを後から切り分けられるよう、必ず構造化して残す。
      console.error("[export-card] ダウンロードで例外", {
        kind,
        message: err instanceof Error ? err.message : String(err),
        period,
      })
      fail("network")
      toast.error("ダウンロードに失敗しました")
    } finally {
      clearTimeout(timer)
      if (controllerRef.current === controller) controllerRef.current = null
      setDownloading(null)
    }
  }

  const buttonIcon = (kind: Kind, Icon: typeof Download) =>
    downloading === kind ? (
      <Loader2 size={16} className="animate-spin" aria-hidden="true" />
    ) : (
      <Icon size={16} aria-hidden="true" />
    )

  return (
    <Card className="glass">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileDown size={18} />
          記録エクスポート
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Link href={`/baby/custom${childScope?.id?`?child=${childScope.id}`:""}#export`} className="mb-4 flex min-h-11 items-center text-sm text-primary">睡眠・予防接種・健診・カスタム記録のJSON</Link>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          <li>PDF: 小児科の受診で見せる集計（3ヶ月まで）</li>
          <li>JSON: 全項目の機械可読な書き出し（バックアップや他のアプリ向け）</li>
          <li>
            CSV: 表計算ソフト向け（記録と日記は別のファイル）。式として動かぬよう、= + - @ で始まる文字の先頭に {"'"} を付けます
          </li>
        </ul>
        <div className="flex gap-1 rounded-xl bg-muted/50 p-1">
          {PERIOD_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => selectPeriod(opt.value)}
              disabled={downloading !== null}
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
            {buttonIcon("pdf", Download)}
            PDFをダウンロード
          </Button>
          {pdfUnavailable && (
            <p className="text-xs text-muted-foreground">
              PDF は 3ヶ月までです。全期間は JSON か CSV で書き出せます
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
            {buttonIcon("json", FileJson)}
            JSONをダウンロード
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => handleDownload("csv-logs")}
              disabled={downloading !== null}
              className="cursor-pointer"
            >
              {buttonIcon("csv-logs", FileSpreadsheet)}
              記録のCSV
            </Button>
            <Button
              type="button"
              variant="outline"
              size="lg"
              onClick={() => handleDownload("csv-diaries")}
              disabled={downloading !== null}
              className="cursor-pointer"
            >
              {buttonIcon("csv-diaries", FileSpreadsheet)}
              日記のCSV
            </Button>
          </div>
          {downloading !== null && (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              onClick={cancel}
              className="cursor-pointer"
            >
              <X size={16} aria-hidden="true" />
              書き出しを取り消す
            </Button>
          )}
        </div>

        {outcome && (
          <div
            role="status"
            aria-live="polite"
            data-testid="export-outcome"
            className="flex flex-col gap-1 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
          >
            <p className="font-medium text-foreground">
              {outcome.hasMore
                ? `${outcome.noun}の第${outcome.part}部を書き出しました（一部です。続きがあります）`
                : outcome.part >= 2
                  ? `${outcome.noun}の第${outcome.part}部で最後まで書き出しました（第1部〜第${outcome.part}部を合わせて範囲の全体です）`
                  : `${outcome.noun}を書き出しました`}
            </p>
            <p>
              範囲: {rangeLabel(outcome.from, outcome.to)}
              {outcome.fetchedAt && ` ・取得: ${JST_TIME.format(new Date(outcome.fetchedAt))}`}
            </p>
            {(outcome.logs !== null || outcome.diaries !== null) && (
              <p>
                このファイルの件数: 記録 {outcome.logs ?? "-"} 件・日記 {outcome.diaries ?? "-"} 件
              </p>
            )}
            <p>{EXPORT_CONSISTENCY_NOTE}</p>
          </div>
        )}
        {chain && (
          <Button
            type="button"
            size="lg"
            onClick={() => handleDownload(chain.kind, chain)}
            disabled={downloading !== null}
            className="cursor-pointer"
          >
            {buttonIcon(chain.kind, Download)}
            続きを書き出す（第{chain.nextPart}部）
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
