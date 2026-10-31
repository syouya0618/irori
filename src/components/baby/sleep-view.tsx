"use client"
import { useEffect,useMemo,useRef,useState,useTransition } from "react"
import { useNow } from "@/lib/hooks/use-now"
import { useServerClock } from "@/lib/hooks/use-server-clock"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { saveSleep } from "@/app/(main)/baby/sleep/actions"
import { newClientId } from "@/lib/utils/client-id"
import { mergeSleepSessions,sleepMinutesByDay,type SleepRequest,type SleepSession } from "@/lib/domain/sleep"
import { listPendingSleep,putPendingSleep,removePendingSleep,type PendingSleep } from "@/lib/domain/sleep-pending"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import type { BabyLogData } from "@/lib/types/baby"
import { formatTimeJst,formatJstTimeInput,jstWallClockToIso,shiftYmd,toJstDateString } from "@/lib/utils/date-jst"
const input="mt-1 min-h-11 w-full rounded-xl border px-3"
const button="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-50"
export function SleepView({owner,childName,initialSessions,initialActive,feedings,truncated=false}:{owner:SaveOwner&{childId:string};childName:string;initialSessions:SleepSession[];initialActive:SleepSession|null;feedings:BabyLogData[];truncated?:boolean}){
 const [formEpoch,setFormEpoch]=useState(0)
 const [storageOk,setStorageOk]=useState(true),[unreadable,setUnreadable]=useState(false)
 const router=useRouter(),alive=useRef(true)
 const [localSessions,setLocalSessions]=useState<SleepSession[]>([])
 const sessions=useMemo(()=>mergeSleepSessions([...initialSessions,...(initialActive?[initialActive]:[])],localSessions).filter(s=>s.child_id===owner.childId),[initialSessions,initialActive,localSessions,owner.childId])
 const active=sessions.find(s=>s.ended_at===null&&!s.voided)??null
 const clock=useServerClock(true)
 const [elapsed,setElapsed]=useState<{id:string;seconds:number}|null>(null)
 useEffect(()=>{const interval=setInterval(()=>{const time=clock.serverNowIso();setElapsed(active&&time?{id:active.id,seconds:Math.max(0,Math.floor((Date.parse(time)-Date.parse(active.started_at))/1000))}:null)},1000);return()=>clearInterval(interval)},[active,clock])
 const [pending,setPending]=useState<PendingSleep[]>([]),[message,setMessage]=useState("")
 const [ready,setReady]=useState(false),[saving,start]=useTransition()
 const [editing,setEditing]=useState<SleepSession|null>(null)
 const ownerRef=useRef(owner)
 useEffect(()=>{alive.current=true;Promise.resolve().then(()=>{
  if(!alive.current)return
  const result=listPendingSleep(ownerRef.current);setPending(result.items.map(p=>({...p,phase:"unknown"})))
  setUnreadable(result.unreadable);if(result.unreadable)setMessage("端末の控えをすべて読めませんでした。記録一覧で保存状況を確認してください")
  setReady(true)
 });return()=>{alive.current=false}},[])
 const now=useNow(60000)
 const today=toJstDateString(now.toISOString())
 const daily=useMemo(()=>sleepMinutesByDay(sessions,shiftYmd(today,-6),7),[sessions,today])
 const apply=(row:SleepSession)=>setLocalSessions(prev=>mergeSleepSessions(prev,[row]))
 function send(p:PendingSleep,retry=false){
  if(saving)return
  start(async()=>{
   const stored=putPendingSleep({...p,phase:"sending"},retry)
   setStorageOk(stored);if(!stored){setMessage("この端末に控えを残せていません。このページを閉じる前に保存結果を確認してください")}
   setPending(prev=>[p,...prev.filter(x=>x.nonce!==p.nonce)])
   try{
    const result=await saveSleep(p.request)
    if(!alive.current)return
    if(result.result){
     setFormEpoch(v=>v+1);apply(result.result.session);removePendingSleep(p);setPending(prev=>prev.filter(x=>x.nonce!==p.nonce));setEditing(null)
     setMessage(result.result.status==="conflict"?"別の端末の睡眠記録が先に保存されています。表示された内容を確認してください":"保存しました")
     router.refresh();return
    }
    if(result.failure==="rejected"&&!retry){removePendingSleep(p);setPending(prev=>prev.filter(x=>x.nonce!==p.nonce));setMessage(result.error);return}
    putPendingSleep({...p,phase:"unknown"},true);setPending(prev=>prev.map(x=>x.nonce===p.nonce?{...x,phase:"unknown"}:x));setMessage("保存結果を確認できません。同じ操作IDで確認し直してください")
   }catch{
    if(!alive.current)return
    putPendingSleep({...p,phase:"unknown"},true);setPending(prev=>prev.map(x=>x.nonce===p.nonce?{...x,phase:"unknown"}:x));setMessage("保存結果を確認できません。同じ操作IDで確認し直してください")
   }
  })
 }
 function begin(request:SleepRequest){const nonce=request.kind==="start"?request.id:request.kind==="stop"?request.stopId:newClientId();send({schemaVersion:1,nonce,owner,request,phase:"sending",createdAt:new Date().toISOString()})}
 const blocked=!ready||saving||pending.length>0||unreadable
 const events=[...sessions.filter(s=>!s.voided).map(s=>({id:s.id,at:s.started_at,text:`睡眠 ${formatTimeJst(s.started_at)}〜${s.ended_at?formatTimeJst(s.ended_at):"計測中"}`})),...feedings.map(f=>({id:f.id,at:f.logged_at,text:`授乳 ${formatTimeJst(f.logged_at)}${f.amount_ml!==null?`・${f.amount_ml}ml`:""}`}))].sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100)
 return <div className="flex flex-col gap-4 px-4 pt-8 pb-8"><Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link><h1 className="text-lg font-semibold">{childName||"子ども"}の睡眠</h1>
  {!storageOk&&pending.length>0&&<p role="alert" className="text-sm">控えを端末に残せていません。このページを閉じる前に保存結果を確認してください。</p>}
  {message&&<p role="status" className="text-sm">{message}</p>}
  {pending.map(p=><div key={p.nonce} className="glass flex flex-col gap-2 rounded-2xl p-4"><p className="text-sm">保存を確認中の睡眠（{p.request.kind==="stop"?"停止":p.request.kind==="edit"?"編集":"開始・追加"}）</p><button disabled={saving} className={button} onClick={()=>send(p,true)}>同じ操作を確認する</button></div>)}
  <section className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"><h2 className="font-semibold">睡眠タイマー</h2>
   <p className="text-sm">{active?`${toJstDateString(active.started_at)} ${formatTimeJst(active.started_at)}から睡眠中` : "計測していません"}</p>
   {active&&<p className="text-sm tabular-nums">{elapsed?.id===active.id?`経過 ${Math.floor(elapsed.seconds/60)}分${elapsed.seconds%60}秒`:"経過時間を確認中（時刻はサーバで確定）"}</p>}
   {active?<button disabled={blocked} className={button} onClick={()=>begin({kind:"stop",id:active.id,childId:owner.childId,version:active.updated_at,stopId:newClientId()})}>起きた・停止して記録</button>:<button disabled={blocked} className={button} onClick={()=>begin({kind:"start",id:newClientId(),childId:owner.childId})}>寝た・計測を開始</button>}
   <button disabled={saving} className="min-h-11 rounded-xl border px-4" onClick={()=>router.refresh()}>他の端末の状態を読み込む</button>
  </section>
  <form key={`${editing?.id??"new"}:${formEpoch}`} className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]" onSubmit={e=>{
   e.preventDefault();if(blocked)return
   const form=new FormData(e.currentTarget)
   try{
    const from=String(form.get("start")),to=String(form.get("end"))
    const first=jstWallClockToIso(from.slice(0,10),from.slice(11,16)),last=jstWallClockToIso(to.slice(0,10),to.slice(11,16)),memo=String(form.get("memo")??"").trim()
    begin(editing?{kind:"edit",id:editing.id,childId:owner.childId,version:editing.updated_at,start:first,end:last,memo:memo||undefined,voided:form.get("voided")==="on"}:{kind:"start",id:newClientId(),childId:owner.childId,start:first,end:last,memo:memo||undefined})
   }catch{setMessage("開始と終了の日時を確認してください")}
  }}><h2 className="font-semibold">{editing?"睡眠の編集":"過去の睡眠を追加"}</h2>
   <label>開始（日本時間）<input required disabled={blocked} name="start" type="datetime-local" className={input} defaultValue={editing?`${toJstDateString(editing.started_at)}T${formatJstTimeInput(editing.started_at)}`:""}/></label>
   <label>終了（日本時間）<input required disabled={blocked} name="end" type="datetime-local" className={input} defaultValue={editing?.ended_at?`${toJstDateString(editing.ended_at)}T${formatJstTimeInput(editing.ended_at)}`:""}/></label>
   <label>メモ（任意）<input name="memo" disabled={blocked} maxLength={1000} defaultValue={editing?.memo??""} className={input}/></label>
   {editing&&<label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="voided" defaultChecked={editing.voided}/>誤記録として集計から除く（履歴は残す）</label>}
   <button disabled={blocked} className={button}>保存する</button>{editing&&<button type="button" className="min-h-11 rounded-xl border px-4" onClick={()=>setEditing(null)}>編集を閉じる</button>}
  </form>
  <section className="glass rounded-2xl p-4 shadow-lg shadow-black/[0.04]"><h2 className="font-semibold">日別・週間の睡眠</h2><p className="my-2 text-sm">7日間の確定時間: {daily.reduce((n,d)=>n+d.minutes,0)}分（計測中は含みません）</p>{truncated&&<p role="alert" className="text-sm text-destructive">表示上限に達したため、一部の記録による集計です。</p>}<dl>{daily.map(d=><div key={d.date} className="flex justify-between py-1 text-sm"><dt>{d.date}</dt><dd>{d.minutes}分</dd></div>)}</dl></section>
  <section><h2 className="font-semibold">睡眠の記録</h2><ul className="mt-2 flex flex-col gap-2">{sessions.map(s=><li key={s.id} className="glass flex flex-col gap-2 rounded-2xl p-4 text-sm"><span>{toJstDateString(s.started_at)} {formatTimeJst(s.started_at)}〜{s.ended_at?`${toJstDateString(s.ended_at)} ${formatTimeJst(s.ended_at)}`:"計測中"}{s.voided?"（集計対象外）":""}</span><button disabled={blocked} className="min-h-11 rounded-xl border px-3" onClick={()=>setEditing(s)}>時刻・メモを編集する</button></li>)}</ul></section>
  <section><h2 className="font-semibold">授乳との時系列</h2><ul className="mt-2 flex flex-col gap-1 text-sm">{events.map(e=><li key={e.id}>{toJstDateString(e.at)} {e.text}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">表示は直近の範囲・最大100件。生活リズムの確認用で、医療判断は行いません。</p></section>
 </div>
}
