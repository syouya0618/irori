"use client"

import { useState,useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { createChildShare,revokeChildShare } from "@/app/(main)/children/sharing/actions"
import { parseShareList } from "@/lib/domain/child-sharing"
import type { Database,Json } from "@/lib/types/database"
export function ShareManager({ childrenList,initialShares }: { childrenList: Database["public"]["Tables"]["children"]["Row"][];initialShares: Json }) {
  const [pending,start] = useTransition()
  const [message,setMessage] = useState("")
  const [path,setPath] = useState("")
  const router = useRouter()
  const shares = parseShareList(initialShares)
  return <div className="flex flex-col gap-4 px-4 pt-8 pb-8"><Link href="/children" className="flex min-h-11 items-center text-primary">子どもの管理へ</Link>
    <h1 className="text-lg font-semibold">子どもの閲覧共有</h1>
    <p className="text-sm text-muted-foreground">世帯オーナーが情報の範囲を指定します。1つの招待を受けられるのは1人です。記録の変更権限は付きません。</p>
    <form className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" onSubmit={e => {
      e.preventDefault();setPath("");const form = new FormData(e.currentTarget)
      start(async () => { try {
        const until = String(form.get("until") ?? "");if (until) form.set("until",new Date(until).toISOString())
        const result = await createChildShare(form);setMessage(result.error ?? "閲覧招待を作成しました")
        if (result.path) { setPath(window.location.origin+result.path);router.refresh() }
      } catch { setMessage("招待の作成結果を確認できませんでした。一覧を再読み込みして確認してください") } })
    }}>
      <label>共有する子ども<select name="child_id" className="mt-1 min-h-11 w-full rounded-xl border px-3">{childrenList.map(c => <option key={c.id} value={c.id}>{c.name || "名前未設定"}</option>)}</select></label>
      <fieldset className="flex flex-col gap-1"><legend className="mb-1 font-medium">閲覧を許可する情報</legend>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="daily" defaultChecked/>授乳・おむつ・睡眠</label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="diary"/>育児日記</label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="health"/>体温・成長・予防接種・健診</label>
        <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="custom"/>カスタム記録</label>
      </fieldset>
      <label>閲覧の期限（任意・空欄は期限なし）<input name="until" type="datetime-local" className="mt-1 min-h-11 w-full rounded-xl border px-3"/></label>
      <p className="text-xs text-muted-foreground">招待を受ける期限は最大7日です。一時的な保育者には閲覧の期限も指定してください。</p>
      <button disabled={pending} className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground">{pending ? "処理中" : "閲覧招待を作成する"}</button>
    </form>
    {message && <p role="status" className="text-sm">{message}</p>}
    {path && <label className="text-sm">閲覧招待リンク<input readOnly value={path} onFocus={e=>e.currentTarget.select()} className="mt-1 min-h-11 w-full rounded-xl border px-3"/></label>}
    <h2 className="font-semibold">現在と過去の共有</h2>
    {shares === null && <p role="alert">共有一覧を読み取れませんでした</p>}
    {shares?.length === 0 && <p className="text-sm">共有はまだありません</p>}
    {shares?.map(s => <section key={s.id} className="glass flex flex-col gap-2 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">
      <h3 className="font-semibold">{s.child_name || "名前未設定"}</h3>
      <p className="text-sm">{s.revoked_at ? "取消済み" : s.accepted ? `閲覧者: ${s.viewer_name || "名前未設定"}` : "招待の受諾待ち"}</p>
      <p className="text-sm">{[s.allow_daily && "日常",s.allow_diary && "日記",s.allow_health && "健康",s.allow_custom && "カスタム"].filter(Boolean).join("・")}</p>
      <p className="text-sm">期限: {s.expires_at ? new Date(s.expires_at).toLocaleString("ja-JP") : "期限なし"}</p>
      {!s.revoked_at && <button disabled={pending} className="min-h-11 rounded-xl border px-4 text-destructive" onClick={()=>start(async()=> { try {const r=await revokeChildShare(s.id);setMessage(r.error ?? "共有を取り消しました");if(!r.error)router.refresh()}catch{setMessage("取消を確認できませんでした。再読み込みして状態を確認してください")} })}>共有を取り消す</button>}
    </section>)}
    <p className="text-xs text-muted-foreground">閲覧者が以前に保存した内容の遠隔消去はできません。不要な共有は取り消してください。</p>
  </div>
}
