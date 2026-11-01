"use client"

import { useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { selectChild } from "@/app/(main)/children/actions"
import type { Database } from "@/lib/types/database"

type Child = Database["public"]["Tables"]["children"]["Row"]
export function ChildPicker({ childrenList, selectedId }: { childrenList: Child[]; selectedId: string }) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [error, setError] = useState("")
  return <div className="flex flex-wrap items-center gap-2 px-4 pt-4">
    <label className="text-sm" htmlFor="active-child">子ども</label>
    <select id="active-child" aria-label="記録する子ども" value={selectedId} disabled={pending} className="glass min-h-11 max-w-56 rounded-xl px-3" onChange={e => {
      const id = e.target.value
      start(async () => { try { const result = await selectChild(id); setError(result.error ?? ""); if (!result.error) { router.replace("/baby"); router.refresh() } } catch { setError("切り替えを確認できませんでした。再読み込みしてください") } })
    }}>{childrenList.map(c => <option key={c.id} value={c.id}>{c.name || "名前未設定"}</option>)}</select>
    <Link href="/children" className="flex min-h-11 items-center px-3 text-sm text-primary">追加・編集</Link>
    {pending && <span role="status" className="text-sm">切り替え中</span>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>
}
