"use client"

import { useState, useRef } from "react"
import { Button } from "@/components/ui/button"
import { ChevronDown, ChevronUp, Loader2 } from "lucide-react"
import type { GoogleExportStatus } from "@/lib/google/export-sync"

const ERROR_MESSAGES: Record<string, string> = {
  partial: "一部の予定を反映しました。残りは次の同期で反映します。",
  permission: "共有の権限がありません。Google の同意画面で再接続してください。",
  provisioning: "専用カレンダーを作成できたか確認中です。重複作成は行いません。再確認してください。",
  unavailable: "専用カレンダーを確認できません。Google 側で削除・変更されていないか確認してください。",
  limit: "共有対象が上限を超えています。予定の変更は行っていません。",
  failed: "共有を完了できませんでした。通信状況を確認して再試行してください。",
}

export function GoogleExportControls({ connectionId }: { connectionId: string }) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState<GoogleExportStatus | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  async function perform(action?: "enable" | "sync" | "stop") {
    if (running.current) return
    running.current = true
    setWorking(true)
    setError(null)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 55_000)
    try {
      const response = await fetch(action ? "/api/google/export" : "/api/google/export?connectionId=" + encodeURIComponent(connectionId), {
        ...(action ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connectionId, action }) } : {}),
        redirect: "manual", cache: "no-store", signal: controller.signal,
      })
      if (!response.ok) throw new Error("request failed")
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

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <button type="button" aria-expanded={expanded} className="flex min-h-11 items-center justify-between gap-2 text-left text-sm font-semibold"
        onClick={() => { setExpanded(!expanded); if (!expanded) void perform() }}>
        irori の予定を Google に共有
        {expanded ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>
      {expanded && (
        <>
          <p className="text-sm text-muted-foreground">接続した本人の Google アカウントに「irori 家族の予定」という専用カレンダーを作成します。通常の家族予定の名前と日時を過去90日・今後365日分まで共有します（最大500件）。メモ・子どもに紐づく予定・医療記録は共有しません。</p>
          <p className="text-sm text-muted-foreground">予定の追加・訂正・削除は irori で行ってください。個人の Google カレンダーは変更しません。共有する家族は各自の Google アカウントで設定してください。</p>
          {working && <p role="status" className="flex items-center gap-2 text-sm"><Loader2 className="animate-spin" size={16} aria-hidden="true" />確認・処理中…</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {status && (
            <>
              <p role="status" className="text-sm font-medium">{status.enabled ? "共有中" : "共有停止中"}{status.busy ? "（別の処理が実行中）" : ""}</p>
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
        </>
      )}
    </section>
  )
}
