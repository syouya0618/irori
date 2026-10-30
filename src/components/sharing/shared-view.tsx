"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { acceptChildShare } from "@/app/invite/[token]/shared/actions"
import { parseSharedSnapshot, parseShareList, type SharedSnapshot, type ShareSummary, type SharedRow } from "@/lib/domain/child-sharing"

const frame = "mx-auto flex max-w-lg flex-col gap-4 px-4 py-8"
export function SharedInvite({ token }: { token: string }) {
  const router = useRouter()
  const [pending,start] = useTransition()
  const [error,setError] = useState("")
  return <main className={frame}><h1 className="text-lg font-semibold">子どもの閲覧招待</h1>
    <p>招待者が選んだ子どもと情報だけを閲覧できます。記録の追加・編集や世帯への参加はできません。</p>
    <button className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground" disabled={pending} onClick={() => start(async () => {
      try { const result = await acceptChildShare(token); if (result.id) { router.replace(`/shared/${result.id}`); router.refresh() } else setError(result.error ?? "招待を確認できませんでした") }
      catch { setError("参加結果を確認できませんでした。同じ招待で確認し直してください") }
    })}>{pending ? "確認中" : "閲覧招待を受ける"}</button>
    {error && <p role="alert">{error}</p>}
  </main>
}
export function SharedList() {
  const content = useRef<HTMLDivElement>(null)
  const [shares,setShares] = useState<ShareSummary[] | null>(null)
  const [error,setError] = useState("")
  useEffect(() => {
    let disposed=false
    let controller: AbortController | null=null
    let lease: ReturnType<typeof setTimeout> | undefined
    let generation=0
    const clear=()=>{ if(content.current) content.current.hidden=true;generation++;controller?.abort();clearTimeout(lease);setShares(null);setError("オンラインで共有を確認してください") }
    const load=async()=>{
      if (!navigator.onLine || document.visibilityState === "hidden") { clear();return }
      const seq=++generation;const started=performance.now()
      controller?.abort();const next=new AbortController();controller=next
      const timeout=setTimeout(()=>next.abort(),8000)
      try {
        const r=await fetch("/api/shared",{cache:"no-store",redirect:"error",signal:next.signal})
        if(!r.ok) throw new Error("denied")
        const parsed=parseShareList(await r.json());if(!parsed) throw new Error("invalid")
        const remaining=15000-(performance.now()-started)
        if(disposed || seq !== generation || remaining<=0) return
        setShares(parsed);if(content.current)content.current.hidden=false;setError("");clearTimeout(lease);lease=setTimeout(clear,remaining)
      }catch{if(!disposed && seq===generation){setShares(null);setError("共有を確認できませんでした。オンラインで開き直してください")}}
      finally{clearTimeout(timeout)}
    }
    const visibility=()=>{if(document.visibilityState === "hidden") clear();else void load()}
    void load();const interval=setInterval(()=>void load(),10000)
    window.addEventListener("offline",clear);window.addEventListener("online",load);window.addEventListener("pagehide",clear);window.addEventListener("pageshow",load);document.addEventListener("visibilitychange",visibility)
    return()=>{disposed=true;generation++;controller?.abort();clearTimeout(lease);clearInterval(interval);window.removeEventListener("offline",clear);window.removeEventListener("online",load);window.removeEventListener("pagehide",clear);window.removeEventListener("pageshow",load);document.removeEventListener("visibilitychange",visibility)}
  },[])
  return <main className={frame}><h1 className="text-lg font-semibold">共有された子ども</h1>
    <p className="text-sm text-muted-foreground">閲覧専用です。オンラインで権限を確認した情報だけ表示します。</p>
    {error && <p role="alert">{error}</p>}{shares === null && !error && <p role="status">確認中</p>}
    {shares?.length === 0 && <p>有効な共有はありません。招待者へ確認してください。</p>}
    <div ref={content} hidden={shares === null} className="flex flex-col gap-3">{shares?.map(s => <Link prefetch={false} key={s.id} href={`/shared/${s.id}`} className="glass min-h-11 rounded-2xl p-4 shadow-lg shadow-black/[0.04]">{s.child_name || "名前未設定"}</Link>)}</div>

  </main>
}
const labels: Record<string,string> = { logged_at:"時刻",log_type:"記録",feeding_type:"授乳",amount_ml:"量 (ml)",diaper_type:"おむつ",duration_sec:"秒",temperature:"体温",weight_g:"体重 (g)",height_cm:"身長 (cm)",memo:"メモ",diary_date:"日付",content:"日記",feeding:"授乳",diaper:"おむつ",bottle:"ミルク",pumped:"搾乳",solid:"離乳食",breast:"母乳",pee:"おしっこ",poop:"うんち",both:"両方",growth:"成長",sleep:"睡眠",ended_at:"終了",started_at:"開始",title:"内容",status:"状態",planned:"予定",completed:"完了",dose:"回数",date:"日付",kind:"種別",vaccination:"予防接種",checkup:"健診",value:"値",label:"項目" }
function SharedRows({ title, rows }: { title: string; rows: SharedRow[] }) {
  if (!rows.length) return null
  return <section className="flex flex-col gap-2"><h2 className="font-semibold">{title}</h2>{rows.map((row,i) => <dl key={i} className="glass rounded-2xl p-4 shadow-lg shadow-black/[0.04]">{Object.entries(row).filter(([,v]) => v !== null).map(([k,v]) => <div key={k} className="flex flex-wrap gap-x-3 py-1"><dt className="text-sm text-muted-foreground">{labels[k] ?? k}</dt><dd className="break-all text-sm">{typeof v === "string" ? labels[v] ?? v : String(v)}</dd></div>)}</dl>)}</section>
}
export function SharedView({ id }: { id: string }) {
  const content = useRef<HTMLDivElement>(null)
  const [snapshot,setSnapshot] = useState<SharedSnapshot | null>(null)
  const [message,setMessage] = useState("オンラインで閲覧権限を確認中")
  useEffect(() => {
    let disposed = false
    let generation = 0
    let active: AbortController | null = null
    let lease: ReturnType<typeof setTimeout> | undefined
    const clear = () => { if(content.current) content.current.hidden=true;generation++; active?.abort(); clearTimeout(lease);setSnapshot(null);setMessage("オンラインで権限を確認するまで表示できません") }
    const load = async () => {
      if (document.visibilityState === "hidden" || !navigator.onLine) { clear();return }
      const started = performance.now()
      const seq = ++generation
      active?.abort(); const controller = new AbortController(); active = controller
      const timeout = setTimeout(() => controller.abort(),5000)
      try {
        const r = await fetch(`/api/shared/${encodeURIComponent(id)}`,{ cache:"no-store",redirect:"error",signal:controller.signal })
        if (!r.ok) throw new Error("unavailable")
        const parsed = parseSharedSnapshot(await r.json())
        if (!parsed) throw new Error("invalid")
        if (disposed || seq !== generation || controller.signal.aborted) return
        const remaining = parsed.valid_for_ms - (performance.now()-started)
        if (remaining <= 0) throw new Error("expired in transit")
        setSnapshot(parsed);if(content.current)content.current.hidden=false;setMessage("")
        clearTimeout(lease);lease = setTimeout(() => { setSnapshot(null);setMessage("閲覧権限の再確認が必要です") },remaining)
      } catch { if (!disposed && seq === generation) { setSnapshot(null);setMessage("共有は失効したか、通信を確認できませんでした") } }
      finally { clearTimeout(timeout) }
    }
    const visibility = () => { if (document.visibilityState === "hidden") clear();else void load() }
    void load()
    const interval = setInterval(() => void load(),10000)
    window.addEventListener("offline",clear);window.addEventListener("online",load);window.addEventListener("pagehide",clear);window.addEventListener("pageshow",load)
    document.addEventListener("visibilitychange",visibility)
    return () => { disposed=true;generation++;active?.abort();clearTimeout(lease);clearInterval(interval);window.removeEventListener("offline",clear);window.removeEventListener("online",load);window.removeEventListener("pagehide",clear);window.removeEventListener("pageshow",load);document.removeEventListener("visibilitychange",visibility) }
  },[id])
  return <main className={frame}><Link href="/shared" prefetch={false} className="flex min-h-11 items-center text-primary">共有の一覧</Link>
    <h1 className="text-lg font-semibold">閲覧専用</h1>
    {message && <p role="status">{message}</p>}<div ref={content} hidden={snapshot === null} className="flex flex-col gap-4">{snapshot && <><h2 className="font-semibold">{snapshot.child_name || "名前未設定"}</h2><p className="text-sm text-muted-foreground">{snapshot.window_note}</p><SharedRows title="日常の記録" rows={snapshot.daily}/><SharedRows title="健康の記録" rows={snapshot.health}/><SharedRows title="育児日記" rows={snapshot.diary}/><SharedRows title="睡眠" rows={snapshot.sleep ?? []}/><SharedRows title="予防接種・健診" rows={snapshot.medical ?? []}/><SharedRows title="カスタム記録" rows={snapshot.custom ?? []}/></>}</div>
    <p className="text-xs text-muted-foreground">取消・期限切れ後の新たな閲覧を拒否します。すでに閲覧・保存された内容の遠隔消去はできません。</p>
  </main>
}
