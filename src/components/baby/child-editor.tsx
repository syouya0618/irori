"use client"
import { useEffect,useRef,useState,useTransition } from "react"
import { useRouter } from "next/navigation"
import { saveChild } from "@/app/(main)/children/actions"
import type { Database } from "@/lib/types/database"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import { isClientId } from "@/lib/utils/client-id"
import { unreadableRecordCount,listRecordRequests,storeRecordRequest,removeRecordRequest,type RecordRequest } from "@/lib/domain/record-requests"
type Child=Database["public"]["Tables"]["children"]["Row"]
export function ChildEditor({child,owner,createId}:{child?:Child;owner?:SaveOwner;createId?:string}){
 const [storageOk,setStorageOk]=useState(true),[unreadable,setUnreadable]=useState(false)
 const router=useRouter(),alive=useRef(true),scope=useRef(owner)
 const [version,setVersion]=useState(child?.updated_at??""),[saving,start]=useTransition(),[message,setMessage]=useState(""),[pending,setPending]=useState<RecordRequest[]>([]),[ready,setReady]=useState(!!child),[epoch,setEpoch]=useState(0)
 useEffect(()=>{alive.current=true;Promise.resolve().then(()=>{if(alive.current){if(scope.current){setPending(listRecordRequests(scope.current,"child"));setUnreadable(unreadableRecordCount(scope.current)>0)}setReady(true)}});return()=>{alive.current=false}},[])
 function send(form:FormData,entry?:RecordRequest,retry=false){
  start(async()=>{try{
   if(entry){if(!retry){const stored=storeRecordRequest(entry);setStorageOk(stored);if(!stored)setMessage("端末に控えを残せていません。結果確認までページを閉じないでください")}setPending(prev=>[entry,...prev.filter(p=>p.id!==entry.id)])}
   const result=await saveChild(form);if(!alive.current)return
   if(result.success||result.conflict){if(entry){removeRecordRequest(entry);setPending(prev=>prev.filter(p=>p.id!==entry.id))}if(result.updatedAt)setVersion(result.updatedAt);if(!child)setEpoch(v=>v+1);setMessage(result.conflict?result.error??"最新情報を確認してください":"保存しました");router.refresh()}
   else if(result.failure==="rejected"&&!retry){if(entry){removeRecordRequest(entry);setPending(prev=>prev.filter(p=>p.id!==entry.id))}setMessage(result.error??"入力を確認してください")}
   else setMessage(result.error??"保存結果を確認できませんでした。同じ操作で確認してください")
  }catch{if(alive.current)setMessage("保存結果を確認できませんでした。同じ操作で確認してください")}})
 }
 function retry(entry:RecordRequest){
  if(!owner||entry.owner.userId!==owner.userId||entry.owner.householdId!==owner.householdId||!isClientId(entry.payload.client_id)||entry.payload.childId!==entry.payload.client_id){setMessage("端末の控えを確認できません。一覧と照合してください");return}
  const form=new FormData();for(const [k,v]of Object.entries(entry.payload))if(typeof v==="string")form.set(k,v);send(form,entry,true)
 }
 const blocked=!ready||saving||(!child&&(pending.length>0||unreadable))
 return <section className="glass flex flex-col gap-3 rounded-2xl p-4 shadow-lg shadow-black/[0.04]"><h2 className="font-semibold">{child?"子どもの編集":"子どもの追加"}</h2>
  {!child&&unreadable&&<p role="alert">端末の控えを読めないため、新しい追加を止めています。元の版で保存結果を確認してください。</p>}
  {!storageOk&&pending.length>0&&<p role="alert">控えを端末に残せていません。このページを閉じる前に保存結果を確認してください。</p>}
  {!child&&pending.map(p=><button key={p.id} disabled={saving} className="min-h-11 rounded-xl border px-3" onClick={()=>retry(p)}>子どもの追加を同じ操作で確認</button>)}
  <form key={epoch} className="flex flex-col gap-3" onSubmit={e=>{
   e.preventDefault();if(blocked)return;const data=new FormData(e.currentTarget)
   if(child){send(data);return}if(!owner||!isClientId(createId)){setMessage("画面を再読み込みしてください");return}
   data.set("childId",createId)
   const payload:Record<string,unknown>={...Object.fromEntries(data.entries()),childId:createId}
   send(data,{schema:1,id:createId,owner:{...owner,childId:createId},kind:"child",payload})
  }}>
   <input type="hidden" name="id" value={child?.id??""}/><input type="hidden" name="version" value={child?version:""}/><input type="hidden" name="client_id" value={createId??""}/><input type="hidden" name="household_id" value={owner?.householdId??child?.household_id??""}/>
   <label>呼び名<input disabled={blocked} name="name" required maxLength={100} defaultValue={child?.name} className="mt-1 min-h-11 w-full rounded-xl border px-3"/></label>
   <label>生年月日（任意）<input disabled={blocked} name="birth_date" type="date" defaultValue={child?.birth_date??""} className="mt-1 min-h-11 w-full rounded-xl border px-3"/></label>
   <label>成長基準で使う性別（任意）<select disabled={blocked} name="sex" defaultValue={child?.sex??""} className="mt-1 min-h-11 w-full rounded-xl border bg-background px-3"><option value="">未設定</option><option value="female">女児</option><option value="male">男児</option></select></label>
   <button disabled={blocked} className="min-h-11 rounded-xl bg-primary px-4 text-primary-foreground">{saving?"保存中":"保存する"}</button>
  </form>{message&&<p role="status">{message}</p>}
 </section>
}
