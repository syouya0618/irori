"use client"
import { useEffect,useRef,useState,useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { saveMedical } from "@/app/(main)/baby/medical/actions"
import { isMedicalRequest,MEDICAL_SOURCES,type MedicalRecord,type MedicalRequest } from "@/lib/domain/medical"
import { unreadableRecordCount,listRecordRequests,storeRecordRequest,removeRecordRequest,type RecordRequest } from "@/lib/domain/record-requests"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import { newClientId } from "@/lib/utils/client-id"
const input="mt-1 min-h-11 w-full rounded-xl border bg-background px-3"
export function MedicalView({owner,childName,records,truncated}:{owner:SaveOwner&{childId:string};childName:string;records:MedicalRecord[];truncated:boolean}){
 const [formEpoch,setFormEpoch]=useState(0)
 const [storageOk,setStorageOk]=useState(true),[unreadable,setUnreadable]=useState(false)
 const router=useRouter(),alive=useRef(true),[editing,setEditing]=useState<MedicalRecord|null>(null)
 const [pending,setPending]=useState<RecordRequest[]>([]),[ready,setReady]=useState(false),[message,setMessage]=useState("")
 const [saving,start]=useTransition(),[query,setQuery]=useState("")
 const scope=useRef(owner)
 useEffect(()=>{alive.current=true;Promise.resolve().then(()=>{if(alive.current){setPending(listRecordRequests(scope.current,"medical"));setUnreadable(unreadableRecordCount(scope.current)>0);setReady(true)}});return()=>{alive.current=false}},[])
 function send(p:RecordRequest,retry=false){
  if(saving)return
  if(!isMedicalRequest(p.payload)||p.payload.childId!==owner.childId){setMessage("端末の控えを確認できません。保存済みの記録と照合してください");return}
  const request=p.payload
  start(async()=>{try{
   if(!retry){const stored=storeRecordRequest(p);setStorageOk(stored);if(!stored)setMessage("端末に控えを残せていません。結果を確認するまでページを閉じないでください")}
   setPending(prev=>[p,...prev.filter(v=>v.id!==p.id)])
   const r=await saveMedical(request);if(!alive.current)return
   if(r.status){setFormEpoch(v=>v+1);removeRecordRequest(p);setPending(prev=>prev.filter(v=>v.id!==p.id));setEditing(null);setMessage(r.status==="conflict"?"別の端末が更新しました。読み直した内容を確認してください":"保存しました");router.refresh()}
   else if(r.failure==="rejected"&&!retry){removeRecordRequest(p);setPending(prev=>prev.filter(v=>v.id!==p.id));setMessage(r.error)}
   else setMessage("保存結果を確認できません。同じ操作で確認し直してください")
  }catch{if(alive.current)setMessage("保存結果を確認できません。同じ操作で確認し直してください")}})
 }
 const blocked=!ready||saving||pending.length>0||unreadable
 return <div className="flex flex-col gap-4 px-4 py-8"><Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link><h1 className="text-lg font-semibold">{childName||"子ども"}の予防接種・健診</h1>
  <p className="text-sm text-muted-foreground">日程・接種の要否は医療機関や自治体へ確認してください。自動で接種時期や健康状態を判定しません。</p>
  <details className="rounded-xl border p-3"><summary className="min-h-11">公式資料・版と確認日</summary>{Object.values(MEDICAL_SOURCES).map(s=><p key={s.key} className="py-2 text-sm"><a className="underline" href={s.documentUrl} target="_blank" rel="noreferrer">{s.title}</a>（{s.version}）</p>)}</details>
  {unreadable&&<p role="alert">端末の控えを読めないため、新しい保存を止めています。元の版で保存結果を確認してください。</p>}{!storageOk&&pending.length>0&&<p role="alert">控えを端末に残せていません。このページを閉じる前に保存結果を確認してください。</p>}
  {message&&<p role="status">{message}</p>}{pending.map(p=><button key={p.id} disabled={saving} className="min-h-11 rounded-xl border px-3" onClick={()=>send(p,true)}>保存結果を同じ操作で確認</button>)}
  <form key={`${editing?.id??"new"}:${formEpoch}`} className="glass flex flex-col gap-3 rounded-2xl p-4" onSubmit={e=>{
   e.preventDefault();if(blocked)return
   const f=new FormData(e.currentTarget),kind=f.get("kind")==="checkup"?"checkup":"vaccination",status=String(f.get("status")) as MedicalRecord["status"]
   const request:MedicalRequest={id:editing?.id??newClientId(),childId:owner.childId,version:editing?.updated_at??null,value:{kind,title:String(f.get("title")??"").trim(),dose:kind==="vaccination"&&f.get("dose")?Number(f.get("dose")):null,status,scheduled_date:String(f.get("date")),completed_date:status==="completed"?String(f.get("completed")):null,memo:String(f.get("memo")??"").trim()||null,remind:f.get("remind")==="on",source_key:MEDICAL_SOURCES[kind].key}}
   if(!isMedicalRequest(request)){setMessage("日付・回数・入力内容を確認してください");return}
   send({schema:1,id:newClientId(),owner,kind:"medical",payload:request})
  }}><h2 className="font-semibold">{editing?"記録を編集":"予定・実績を追加"}</h2>
   <label>種別<select name="kind" defaultValue={editing?.kind??"vaccination"} className={input} disabled={blocked}><option value="vaccination">予防接種</option><option value="checkup">乳幼児健診</option></select></label>
   <label>名称<input name="title" required maxLength={100} defaultValue={editing?.title??""} disabled={blocked} className={input}/></label>
   <label>接種回数（健診は空欄）<input name="dose" type="number" min={1} max={30} defaultValue={editing?.dose??""} disabled={blocked} className={input}/></label>
   <label>予定日<input name="date" type="date" required defaultValue={editing?.scheduled_date??""} disabled={blocked} className={input}/></label>
   <label>状態<select name="status" defaultValue={editing?.status??"planned"} disabled={blocked} className={input}><option value="planned">予定</option><option value="completed">完了</option><option value="cancelled">取消（履歴を残す）</option></select></label>
   <label>実施日（完了時は必須）<input name="completed" type="date" defaultValue={editing?.completed_date??""} disabled={blocked} className={input}/></label>
   <label>メモ<input name="memo" maxLength={1000} defaultValue={editing?.memo??""} disabled={blocked} className={input}/></label>
   <label className="flex min-h-11 items-center gap-3"><input name="remind" type="checkbox" defaultChecked={editing?.remind??false} disabled={blocked}/>予定日の前日20時に世帯へ通知</label>
   <button disabled={blocked} className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground disabled:opacity-50">保存する</button>
   {editing&&<button type="button" className="min-h-11 rounded-xl border" onClick={()=>setEditing(null)}>編集を閉じる</button>}
  </form>
  <label>名称・メモで検索<input className={input} value={query} onChange={e=>setQuery(e.target.value)}/></label>
  {truncated&&<p role="alert">直近500件のみの表示・検索です。全件の取得には追加記録のエクスポートを利用してください。</p>}
  <ul className="flex flex-col gap-3">{records.filter(r=>`${r.title} ${r.memo??""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map(r=><li key={r.id} className="glass flex flex-col gap-2 rounded-2xl p-4"><p>{r.scheduled_date} {r.title}{r.dose?` ${r.dose}回目`:""}</p><p className="text-sm">{r.status==="completed"?`完了 ${r.completed_date}`:r.status==="cancelled"?"取消":"予定"}</p>{r.memo&&<p className="whitespace-pre-wrap text-sm">{r.memo}</p>}<p className="text-xs text-muted-foreground">出典: {MEDICAL_SOURCES[r.kind].key===r.source_key?`${MEDICAL_SOURCES[r.kind].title}（${MEDICAL_SOURCES[r.kind].version}）`:`${r.source_key}（この版では資料を特定できません）`}</p><button disabled={blocked} className="min-h-11 rounded-xl border" onClick={()=>setEditing(r)}>予定・実績を編集</button></li>)}</ul>
 </div>
}
