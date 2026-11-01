import type { Database } from "@/lib/types/database"
import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import { isTimestamptzText } from "./timestamptz-text"
import { jstDayStartIso,shiftYmd } from "@/lib/utils/date-jst"
export type SleepSession = Database["public"]["Tables"]["sleep_sessions"]["Row"]
export const SLEEP_COLUMNS = "id,household_id,child_id,started_at,ended_at,started_by,ended_by,memo,voided,updated_at,created_at"
export type SleepRequest =
 | { kind:"start";id:string;childId:string;start?:string;end?:string;memo?:string }
 | { kind:"stop";id:string;childId:string;version:string;stopId:string;end?:string }
 | { kind:"edit";id:string;childId:string;version:string;start:string;end:string;memo?:string;voided:boolean }
export function isSleepRequest(v:unknown):v is SleepRequest {
 if(!isRecord(v)||!isClientId(v.id)||!isClientId(v.childId)) return false
 if(v.kind!=="start"&&v.kind!=="stop"&&v.kind!=="edit") return false
 if(v.memo!==undefined&&(typeof v.memo!=="string"||v.memo.length>1000)) return false
 if(v.kind!=="start"&&!isTimestamptzText(v.version)) return false
 if(v.kind==="stop"&&!isClientId(v.stopId)) return false
 if([v.start,v.end].some(x=>x!==undefined&&(typeof x!=="string"||!Number.isFinite(Date.parse(x)))))return false
 if(v.kind==="edit"&&(typeof v.start!=="string"||typeof v.end!=="string"||typeof v.voided!=="boolean"))return false
 if(v.kind==="start"&&v.end!==undefined&&v.start===undefined)return false
 return true
}
export function parseSleepOutcome(v:unknown): {status:"saved"|"replayed"|"conflict";session:SleepSession}|null {
 if(!isRecord(v)||!["saved","replayed","conflict"].includes(String(v.status))||!isRecord(v.session))return null
 const s=v.session
 if(typeof s.id!=="string"||typeof s.child_id!=="string"||typeof s.started_at!=="string"||!Number.isFinite(Date.parse(s.started_at))||!(s.ended_at===null||typeof s.ended_at==="string")||!isTimestamptzText(s.updated_at)||typeof s.voided!=="boolean")return null
 return v as {status:"saved"|"replayed"|"conflict";session:SleepSession}
}
/** Clip to JST days, union overlaps, and never count an ongoing timer as a completed duration. */
export function sleepMinutesByDay(sessions:readonly SleepSession[],firstDay:string,days:number):{date:string;minutes:number}[] {
 return Array.from({length:days},(_,i)=>{
  const date=shiftYmd(firstDay,i),from=Date.parse(jstDayStartIso(date)),to=Date.parse(jstDayStartIso(shiftYmd(date,1)))
  const spans=sessions.filter(s=>!s.voided&&s.ended_at!==null).map(s=>[Math.max(from,Date.parse(s.started_at)),Math.min(to,Date.parse(s.ended_at!))] as const).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0])
  let total=0,start=NaN,end=NaN
  for(const [a,b]of spans){if(!Number.isFinite(start)){start=a;end=b}else if(a<=end)end=Math.max(end,b);else{total+=end-start;start=a;end=b}}
  if(Number.isFinite(start))total+=end-start
  return {date,minutes:Math.round(total/60000)}
 })
}

/** Preserve the newest microsecond version when a delayed response and a fresh SSR read cross. */
export function mergeSleepSessions(server:readonly SleepSession[],local:readonly SleepSession[]):SleepSession[]{
 const stamp=(v:string)=>Date.parse(v)*1000+Number((v.match(/\.(\d+)/)?.[1]??"").padEnd(6,"0").slice(3,6))
 const map=new Map<string,SleepSession>()
 for(const row of [...server,...local]){const prior=map.get(row.id);if(!prior||stamp(row.updated_at)>=stamp(prior.updated_at))map.set(row.id,row)}
 return [...map.values()].sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at))
}
