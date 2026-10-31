"use client"
import { useEffect,useRef,useState,useTransition } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { saveCustom } from "@/app/(main)/baby/custom/actions"
import { CUSTOM_LABELS,CUSTOM_TYPES,displayCustomValue,isCustomRequest,type CustomField,type CustomRecord,type CustomRequest } from "@/lib/domain/custom-records"
import { unreadableRecordCount,listRecordRequests,removeRecordRequest,storeRecordRequest,type RecordRequest } from "@/lib/domain/record-requests"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import { newClientId } from "@/lib/utils/client-id"
import { formatJstTimeInput,formatTimeJst,jstWallClockToIso,toJstDateString } from "@/lib/utils/date-jst"
const input="mt-1 min-h-11 w-full rounded-xl border bg-background px-3",button="min-h-11 rounded-xl border px-3 disabled:opacity-50"
const wall=(iso:string)=>`${toJstDateString(iso)}T${formatJstTimeInput(iso)}`
function fromWall(v:string){return jstWallClockToIso(v.slice(0,10),v.slice(11,16))}
export function CustomView({owner,childName,fields,fieldsTruncated,records,hasMore,query,fieldFilter,page,nowIso}:{owner:SaveOwner&{childId:string};childName:string;fields:CustomField[];fieldsTruncated:boolean;records:CustomRecord[];hasMore:boolean;query:string;fieldFilter:string;page:number;nowIso:string}){
 const [formEpoch,setFormEpoch]=useState(0)
 const [storageOk,setStorageOk]=useState(true),[unreadable,setUnreadable]=useState(false)
 const router=useRouter(),alive=useRef(true),scope=useRef(owner)
 const [pending,setPending]=useState<RecordRequest[]>([]),[ready,setReady]=useState(false),[message,setMessage]=useState(""),[saving,start]=useTransition()
 const [editing,setEditing]=useState<CustomRecord|null>(null),[editingField,setEditingField]=useState<CustomField|null>(null),[type,setType]=useState<CustomField["value_type"]>("number"),[selected,setSelected]=useState(fields.find(f=>!f.archived)?.id??"")
 useEffect(()=>{alive.current=true;Promise.resolve().then(()=>{if(alive.current){setPending(listRecordRequests(scope.current,"custom"));setUnreadable(unreadableRecordCount(scope.current)>0);setReady(true)}});return()=>{alive.current=false}},[])
 function send(p:RecordRequest,retry=false){
  if(saving)return
  if(!isCustomRequest(p.payload)||p.payload.childId!==owner.childId){setMessage("端末の控えを確認できません。保存済み一覧と照合してください");return}
  const request=p.payload
  start(async()=>{try{
   if(!retry){const stored=storeRecordRequest(p);setStorageOk(stored);if(!stored)setMessage("端末に控えを残せていません。保存結果を確認するまでページを閉じないでください")}
   setPending(prev=>[p,...prev.filter(v=>v.id!==p.id)])
   const r=await saveCustom(request);if(!alive.current)return
   if(r.status){setFormEpoch(v=>v+1);removeRecordRequest(p);setPending(prev=>prev.filter(v=>v.id!==p.id));setEditing(null);setEditingField(null);if(request.operation==="field"&&!request.archived)setSelected(request.id);setMessage(r.status==="conflict"?"別の端末が更新しました。読み直した内容を確認してください":"保存しました");router.refresh()}
   else if(r.failure==="rejected"&&!retry){removeRecordRequest(p);setPending(prev=>prev.filter(v=>v.id!==p.id));setMessage(r.error)}
   else setMessage("保存結果を確認できません。同じ操作で確認し直してください")
  }catch{if(alive.current)setMessage("保存結果を確認できません。同じ操作で確認し直してください")}})
 }
 function submit(request:CustomRequest){if(!isCustomRequest(request)){setMessage("項目・値・日時を確認してください");return}send({schema:1,id:newClientId(),owner,kind:"custom",payload:request})}
 const blocked=!ready||saving||pending.length>0||unreadable
 const definition=editing?{id:editing.field_id,label:editing.field_label,value_type:editing.value_type,options:editing.field_options}:fields.find(f=>f.id===selected&&!f.archived)
 const options=definition&&Array.isArray(definition.options)?definition.options.filter((x):x is string=>typeof x==="string"):[]
 const href=(n:number)=>`/baby/custom?${new URLSearchParams({child:owner.childId,q:query,field:fieldFilter,page:String(n)})}`
 return <div className="flex flex-col gap-4 px-4 py-8"><Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link><h1 className="text-lg font-semibold">{childName||"子ども"}のカスタム記録</h1>
  {unreadable&&<p role="alert">端末の控えを読めないため、新しい保存を止めています。元の版で保存結果を確認してください。</p>}{!storageOk&&pending.length>0&&<p role="alert">控えを端末に残せていません。このページを閉じる前に保存結果を確認してください。</p>}
  {message&&<p role="status">{message}</p>}{pending.map(p=><button key={p.id} className={button} disabled={saving} onClick={()=>send(p,true)}>保存結果を同じ操作で確認</button>)}
  <form key={`${editing?.id??"new-record"}:${formEpoch}`} className="glass flex flex-col gap-3 rounded-2xl p-4" onSubmit={e=>{
   e.preventDefault();if(blocked||!definition)return
   const f=new FormData(e.currentTarget),raw=String(f.get("value")??"")
   try{submit({operation:"record",id:editing?.id??newClientId(),childId:owner.childId,version:editing?.updated_at??null,fieldId:definition.id,value:definition.value_type==="number"?Number(raw):definition.value_type==="boolean"?raw==="true":definition.value_type==="datetime"?fromWall(raw):raw,loggedAt:fromWall(String(f.get("at"))),memo:String(f.get("memo")??"").trim()||null,voided:f.get("voided")==="on"})}catch{setMessage("日時・値を確認してください")}
  }}><h2 className="font-semibold">{editing?"記録を編集":"記録を追加"}</h2>
   {editing?<p>{editing.field_label}（記録時の定義）</p>:<label>記録する項目<select className={input} value={selected} disabled={blocked} onChange={e=>setSelected(e.target.value)}><option value="">項目を選択</option>{fields.filter(f=>!f.archived).map(f=><option key={f.id} value={f.id}>{f.label}</option>)}</select></label>}
   {definition&&<label>値{definition.value_type==="boolean"?<select name="value" className={input} disabled={blocked} defaultValue={editing?.value===true?"true":"false"}><option value="true">はい</option><option value="false">いいえ</option></select>:definition.value_type==="choice"?<select key={definition.id} name="value" required className={input} disabled={blocked} defaultValue={String(editing?.value??options[0]??"")}>{options.map(v=><option key={v}>{v}</option>)}</select>:<input key={definition.id} name="value" required disabled={blocked} type={definition.value_type==="number"?"number":definition.value_type==="datetime"?"datetime-local":"text"} step={definition.value_type==="number"?"any":undefined} maxLength={1000} className={input} defaultValue={editing?definition.value_type==="datetime"?wall(String(editing.value)):String(editing.value):""}/>}</label>}
   <label>記録日時（日本時間）<input name="at" type="datetime-local" required className={input} disabled={blocked} defaultValue={wall(editing?.logged_at??nowIso)}/></label>
   <label>メモ<input name="memo" className={input} maxLength={1000} disabled={blocked} defaultValue={editing?.memo??""}/></label>
   {editing&&<label className="flex min-h-11 items-center gap-3"><input name="voided" type="checkbox" disabled={blocked} defaultChecked={editing.voided}/>誤記録として除外（履歴は残す）</label>}
   <button disabled={blocked||!definition} className={`${button} bg-primary text-primary-foreground`}>記録を保存</button>{editing&&<button type="button" className={button} onClick={()=>setEditing(null)}>編集を閉じる</button>}
  </form>
  <details className="glass rounded-2xl p-4"><summary className="min-h-11">世帯の項目を管理</summary><p className="text-sm text-muted-foreground">項目は世帯共通。型・選択肢の変更は新しい項目で行います。廃止しても過去の記録は残ります。</p>
   <form key={`${editingField?.id??"new-field"}:${formEpoch}`} className="my-3 flex flex-col gap-3" onSubmit={e=>{
    e.preventDefault();if(blocked)return;const f=new FormData(e.currentTarget)
    submit({operation:"field",id:editingField?.id??newClientId(),childId:owner.childId,version:editingField?.updated_at??null,label:String(f.get("label")??"").trim(),type:editingField?.value_type??type,options:editingField?(Array.isArray(editingField.options)?editingField.options.filter((v):v is string=>typeof v==="string"):[]):type==="choice"?String(f.get("options")??"").split(/\r?\n/).map(s=>s.trim()).filter(Boolean):[],archived:f.get("archived")==="on"})
   }}><label>項目名<input name="label" required maxLength={80} className={input} disabled={blocked} defaultValue={editingField?.label??""}/></label>
    <label>値の種類<select className={input} value={editingField?.value_type??type} disabled={blocked||!!editingField} onChange={e=>setType(e.target.value as CustomField["value_type"])}>{CUSTOM_TYPES.map(t=><option key={t} value={t}>{CUSTOM_LABELS[t]}</option>)}</select></label>
    {(editingField?.value_type??type)==="choice"&&<label>選択肢（1行に1件・最大30件）<textarea name="options" className={input} disabled={blocked||!!editingField} defaultValue={Array.isArray(editingField?.options)?editingField.options.join("\n"):""}/></label>}
    {editingField&&<label className="flex min-h-11 items-center gap-3"><input name="archived" type="checkbox" disabled={blocked} defaultChecked={editingField.archived}/>この項目を廃止</label>}
    <button disabled={blocked} className={button}>項目を保存</button>{editingField&&<button type="button" className={button} onClick={()=>setEditingField(null)}>新しい項目へ</button>}
   </form>
   {fieldsTruncated&&<p role="alert">項目一覧は最大500件です。</p>}
   <ul>{fields.map(f=><li key={f.id} className="flex items-center justify-between gap-2 border-t py-2 text-sm"><span>{f.label}・{CUSTOM_LABELS[f.value_type]}{f.archived?"（廃止）":""}</span><button className={button} disabled={blocked} onClick={()=>setEditingField(f)}>項目を編集</button></li>)}</ul>
  </details>
  <form method="get" className="flex flex-col gap-3 rounded-2xl border p-4"><input type="hidden" name="child" value={owner.childId}/><label>記録を検索<input name="q" maxLength={100} defaultValue={query} className={input}/></label><label>項目で絞り込み<select name="field" className={input} defaultValue={fieldFilter}><option value="">すべて</option>{fields.map(f=><option value={f.id} key={f.id}>{f.label}{f.archived?"（廃止）":""}</option>)}</select></label><button className={button}>検索する</button></form>
  <ul className="flex flex-col gap-3">{records.map(r=><li key={r.id} className="glass flex flex-col gap-2 rounded-2xl p-4 text-sm"><p>{toJstDateString(r.logged_at)} {formatTimeJst(r.logged_at)} {r.field_label}{r.voided?"（除外）":""}</p><p className="break-all">{r.value_type==="datetime"?`${toJstDateString(String(r.value))} ${formatTimeJst(String(r.value))}`:displayCustomValue(r.value,r.value_type)}</p>{r.memo&&<p className="whitespace-pre-wrap">{r.memo}</p>}<button className={button} disabled={blocked} onClick={()=>setEditing(r)}>記録を編集</button></li>)}</ul>
  <nav className="flex justify-between">{page>0&&<Link className="min-h-11 p-3 text-primary" href={href(page-1)}>前の100件</Link>}{hasMore&&<Link className="min-h-11 p-3 text-primary" href={href(page+1)}>次の100件</Link>}</nav>
  <form id="export" action="/api/child-records-export" method="get" className="flex flex-col gap-3 rounded-2xl border p-4"><h2 className="font-semibold">追加記録のエクスポート</h2><p className="text-sm">この子どもの睡眠・予防接種・健診・カスタム記録をJSONで書き出します。除外・廃止後の履歴も含みます。既存の育児ログ・日記は設定画面から別途取得できます。</p><input type="hidden" name="child" value={owner.childId}/><label>開始日（任意）<input name="from" type="date" className={input}/></label><label>終了日（任意）<input name="to" type="date" className={input}/></label><button className={button}>追加記録のJSONを書き出す</button><p className="text-xs text-muted-foreground">1ファイルは同一時点の記録。2万件・約3.5MBを超える場合は期間を短くしてください。部分ファイルを全件として返しません。</p></form>
 </div>
}
