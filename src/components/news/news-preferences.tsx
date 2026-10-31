"use client"
import { useState,useTransition } from "react"
import { useRouter } from "next/navigation"
import { NEWS_REGIONS } from "@/lib/domain/regional-news"
import { saveNewsPreferences } from "@/app/(main)/news/actions"
export function NewsPreferences({region,enabled,version}:{region:string|null;enabled:boolean;version:string|null}){
 const router=useRouter(),[message,setMessage]=useState(""),[pending,start]=useTransition()
 return <form className="glass flex flex-col gap-3 rounded-2xl p-4" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget),next=String(f.get("region")??"")||null,wanted=f.get("enabled")==="on";start(async()=>{try{const r=await saveNewsPreferences(next,wanted,version);setMessage(r.status==="conflict"?"別の画面で設定が変わりました。読み直した設定を確認してください":r.status?"保存しました":r.error??"保存できませんでした");if(r.status)router.refresh()}catch{setMessage("保存結果を確認できませんでした。再読み込みで設定を確認してください")}})}}>
  <label>ニュースの地域<select name="region" defaultValue={region??""} disabled={pending} className="mt-1 min-h-11 w-full rounded-xl border bg-background px-3"><option value="">未設定</option>{NEWS_REGIONS.map(r=><option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
  <label className="flex min-h-11 items-center gap-3"><input name="enabled" type="checkbox" defaultChecked={enabled} disabled={pending}/>新着がある朝8時に通知する</label>
  <p className="text-xs text-muted-foreground">地域は任意・本人だけの設定です。公式RSSを確認済みの地域のみ対応しています。通知をOFFにしても一覧は読めます。端末のPush許可も必要です。</p>
  <button disabled={pending} className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground">ニュース設定を保存</button>{message&&<p role="status">{message}</p>}
 </form>
}
