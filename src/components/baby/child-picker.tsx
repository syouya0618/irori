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

export function ChildEditor({ child }: { child?: Child }) {
  const [version,setVersion] = useState(child?.updated_at ?? "")
  const [pending, start] = useTransition()
  const [message, setMessage] = useState("")
  return <form className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" onSubmit={e => {
    e.preventDefault(); const data = new FormData(e.currentTarget)
    start(async () => { try { const { saveChild } = await import("@/app/(main)/children/actions"); const r = await saveChild(data); setMessage(r.error ?? "保存しました");if(r.updatedAt)setVersion(r.updatedAt) } catch { setMessage("保存結果を確認できませんでした。再読み込みして確認してください") } })
  }}>
    <h2 className="font-semibold">{child ? "子どもの編集" : "子どもの追加"}</h2>
    <input type="hidden" name="id" value={child?.id ?? ""} />
    <input type="hidden" name="version" value={version} />
    <label>呼び名<input name="name" required maxLength={100} defaultValue={child?.name} className="mt-1 min-h-11 w-full rounded-xl border px-3" /></label>
    <label>生年月日（任意）<input type="date" name="birth_date" defaultValue={child?.birth_date ?? ""} className="mt-1 min-h-11 w-full rounded-xl border px-3" /></label>
    <label>成長基準で使う性別（任意）<select name="sex" defaultValue={child?.sex ?? ""} className="mt-1 min-h-11 w-full rounded-xl border px-3"><option value="">未設定</option><option value="female">女児</option><option value="male">男児</option></select></label>
    <button disabled={pending} className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground">{pending ? "保存中" : "保存する"}</button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </form>
}
