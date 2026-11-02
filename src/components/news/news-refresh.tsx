"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { refreshNews } from "@/app/(main)/news/actions"

const messages = {
  updated: "配信元の確認が終わりました。取得済みの記事を表示しています。",
  partial: "一部の配信元を取得できませんでした。取得できた記事を表示しています。",
  failed: "配信元を取得できませんでした。時間をおいて再度お試しください。",
  cooldown: "取得中、または直前に確認済みです。少し時間をおいて一覧を読み直してください。",
}
export function NewsRefresh() {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [message, setMessage] = useState("")
  return <div className="flex flex-col gap-2">
    <button className="min-h-11 rounded-xl border px-4 text-sm" disabled={pending} onClick={() => {
      setMessage("")
      start(async () => {
        try {
          const result = await refreshNews()
          setMessage("error" in result ? result.error ?? "取得できませんでした" : result.status === "updated" && result.fetched === 0 ? "新着記事はありません。取得済みの記事を表示しています。" : messages[result.status])
          router.refresh()
        } catch { setMessage("取得結果を確認できませんでした。一覧を読み直してください。") }
      })
    }}>{pending ? "配信元を確認中…" : "配信元から記事を更新"}</button>
    <p className="text-xs text-muted-foreground">更新は地域の利用者間で共有され、続けて実行できません。この操作では通知を送りません。</p>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>
}
