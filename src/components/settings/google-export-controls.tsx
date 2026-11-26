"use client"

import { useState, useRef, useEffect, useEffectEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import type { GoogleExportStatus } from "@/lib/google/export-sync"

import type { Json } from "@/lib/types/database"

function describeConflict(doc: Json) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "予定なし（削除）"
  const timing = doc.timing
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) return String(doc.title ?? "")
  const at = (v: Json | undefined) => typeof v === "string" ? new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }) : ""
  const rule = doc.rule
  const recurrence = rule && typeof rule === "object" && !Array.isArray(rule) && Array.isArray(rule.lines)
    ? " · 繰り返し " + rule.lines.join(" / ") + " (" + rule.startZone + " / " + rule.endZone + ")" : ""
  return String(doc.title ?? "") + " · " + (timing.start ? timing.start + " 〜 " + timing.end : at(timing.startAt) + " 〜 " + at(timing.endAt)) + recurrence
}

const ERROR_MESSAGES: Record<string, string> = {
  partial: "一部の予定を反映しました。残りは次の同期で反映します。",
  permission: "共有の権限がありません。Google の同意画面で再接続してください。",
  provisioning: "専用カレンダーを作成できたか確認中です。重複作成は行いません。再確認してください。",
  unavailable: "専用カレンダーを確認できません。Google 側で削除・変更されていないか確認してください。",
  limit: "共有対象が上限を超えています。予定の変更は行っていません。",
  failed: "共有を完了できませんでした。通信状況を確認して再試行してください。",
}

export function GoogleExportControls({ connectionId }: { connectionId: string }) {
  const router = useRouter()
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [disconnected, setDisconnected] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<GoogleExportStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  async function perform(action?: "enable" | "sync" | "stop" | "resolve", conflictId?: string, choice?: "google" | "local") {
    if (running.current) return
    running.current = true
    setWorking(true)
    setError(null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)
    try {
      const response = await fetch(action ? "/api/google/export" : "/api/google/export?connectionId=" + encodeURIComponent(connectionId), {
        ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId, action, conflictId, choice }) } : {}),
        redirect: "manual", cache: "no-store", signal: controller.signal,
      })
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null
        if (payload?.code === "sharing_not_ready" && typeof payload.error === "string") {
          setStatus(null)
          setError(payload.error)
          return
        }
        throw new Error("request failed")
      }
      const result = await response.json() as { status?: GoogleExportStatus }
      if (!result.status || typeof result.status.enabled !== "boolean" || typeof result.status.permission !== "boolean") throw new Error("invalid response")
      setStatus(result.status)
    } catch {
      // The request may have landed. Do not claim success or allow an immediate blind mutation.
      setStatus(null)
      setError("結果を確認できませんでした。状態を再取得してください。")
    } finally {
      clearTimeout(timeout)
      setWorking(false)
      running.current = false
    }
  }

  const refresh = useEffectEvent(() => { void perform() })
  useEffect(() => {
    if (!expanded || !status?.enabled || (!status.busy && !status.pending && status.lastError !== "partial")) return
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") refresh() }, 5000)
    return () => window.clearInterval(timer)
  }, [expanded,status?.enabled,status?.busy,status?.pending,status?.lastError])

  async function disconnect() {
    if (running.current || !confirmDisconnect) return
    running.current = true
    setWorking(true)
    setError(null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      const response = await fetch("/api/google/export", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }), redirect: "manual", cache: "no-store",
        signal: controller.signal,
      })
      if (response.status === 503) {
        const payload = await response.json().catch(() => null) as { code?: unknown; error?: unknown } | null
        if (payload?.code === "sharing_not_ready" && typeof payload.error === "string") {
          setStatus(null)
          setError(payload.error)
          return
        }
        throw new Error("request failed")
      }
      if (response.status === 409) {
        setError("同期中です。少し時間をおいて再試行してください。")
        return
      }
      if (!response.ok) throw new Error("request failed")
      const result = await response.json() as { ok?: boolean }
      if (result.ok !== true) throw new Error("invalid response")
      setDisconnected(true)
      router.refresh()
    } catch {
      setError("解除結果を確認できませんでした。画面を再読み込みしてください。")
      setStatus(null)
      router.refresh()
    } finally {
      clearTimeout(timeout)
      setConfirmDisconnect(false)
      setWorking(false)
      running.current = false
    }
  }

  if (disconnected) return <p role="status" className="text-sm">接続を解除しました。</p>

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <button type="button" aria-expanded={expanded} className="flex min-h-11 items-center justify-between gap-2 text-left text-sm font-semibold"
        onClick={() => { setExpanded(!expanded); if (!expanded) void perform() }}>
        Google と家族予定を同期
        {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {expanded && (
        <>
          <p className="text-sm text-muted-foreground">接続した本人の Google アカウントに「irori 家族の予定」という専用カレンダーを作成します。共有する内容は通常の家族予定の名前・日時・繰り返し規則です。メモ・子どもに紐づく予定・医療記録は共有しません。</p>
          <p className="text-sm text-muted-foreground">専用カレンダーで追加・編集・削除すると、irori と共有中の家族の専用カレンダーにも反映します。個人カレンダーは読み取り専用です。夫婦それぞれのアカウントで開始してください。</p>
          {working && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} aria-hidden="true" />確認・処理中…</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {status && (
            <>
              <p role="status" className="text-sm font-medium">{!status.enabled ? "同期停止中" : !status.permission ? "再認証が必要" : status.conflicts?.length ? "競合あり" : status.busy ? "同期中" : status.lastError === "failed" ? "通信または同期に失敗" : status.pending || !status.lastSyncedAt || status.lastError ? "未同期" : "同期済み"}</p>
              {status.retiring && <p role="status">繰り返しの個別回を確認中です。Google 側にシリーズが残っているため、全件の削除は未完了です。</p>}
              {status.conflicts?.map(conflict => (
                <div key={conflict.id} className="grid gap-2 rounded-md border p-3">
                  <p>変更が競合しています。反映する内容を選んでください。</p>
                  {(["local","google"] as const).map(side => (
                    <div key={side} className="text-sm">
                      <p>{side === "local" ? "irori" : "Google"} · {side === "google" && conflict.protected ? "内容を確認できません" : describeConflict(conflict[side])}</p>
                      {!conflict.protected && !(conflict.legacy_missing && side === "google") && <Button variant="outline" disabled={working || status.busy} onClick={() => void perform("resolve",conflict.id,side)}>
                        {conflict.legacy_missing ? "新しい Google 予定として送る" : side === "local" ? "irori の内容を採用" : "Google の内容を採用"}
                      </Button>}
                    </div>
                  ))}
                  {conflict.legacy_missing && <p>旧版のコピーは完全取得と個別照会の両方で見つかりませんでした。この予定を改めて共有する場合は選択してください。</p>}
                  {conflict.protected && <p>予定の内容または編集権限を確認できません。元予定を確認した後、もう一度同期してください。</p>}
                </div>
              ))}
              {status.lastSyncedAt && <p className="text-xs text-muted-foreground">最終完了: {new Date(status.lastSyncedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}</p>}
              {status.lastError && <p role="alert" className="text-sm text-muted-foreground">{ERROR_MESSAGES[status.lastError] ?? "共有の状態を確認してください。"}</p>}
              {!status.permission && (
                <a href="/api/google/oauth/start?mode=share" className="touch-target inline-flex self-start items-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors duration-200 hover:bg-primary-hover">Google の共有権限を許可</a>
              )}
              <div className="flex flex-wrap gap-2">
                {status.permission && !status.enabled && <Button type="button" disabled={working || status.busy} onClick={() => void perform("enable")}>{status.provisioning ? "専用カレンダーを再確認" : "共有を開始"}</Button>}
                {status.permission && status.enabled && <Button type="button" variant="outline" disabled={working || status.busy} onClick={() => void perform("sync")}>共有を今すぐ更新</Button>}
                {status.enabled && <Button type="button" variant="outline" disabled={working || status.busy} onClick={() => void perform("stop")}>共有を停止（コピーは残す）</Button>}
              </div>
              <p className="text-xs text-muted-foreground">共有停止後は新しい反映を行いません。既に Google にコピーした予定は残ります。Google の初回同意だけは Google の公式画面で行います。</p>
            </>
          )}
          <Button type="button" variant="ghost" className="self-start" disabled={working} onClick={() => void perform()}>状態を再取得</Button>
          {status && <div className="flex flex-col gap-2 border-t border-border pt-3">
            {confirmDisconnect ? (
              <>
                <p className="text-sm">この Google アカウントとの接続を解除します。irori に保存した接続情報と、他の家族が共有していない取り込み予定を削除します。Google 側の予定とコピー済みカレンダーは残ります。同じ Google アカウントで再接続すると専用カレンダーを再利用します。</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="destructive" disabled={working} onClick={() => void disconnect()}>接続解除を確定</Button>
                  <Button type="button" variant="outline" disabled={working} onClick={() => setConfirmDisconnect(false)}>キャンセル</Button>
                </div>
              </>
            ) : <Button type="button" variant="outline" className="self-start" disabled={working} onClick={() => setConfirmDisconnect(true)}>iroriとの接続を解除</Button>}
          </div>}
        </>
      )}
    </section>
  )
}
