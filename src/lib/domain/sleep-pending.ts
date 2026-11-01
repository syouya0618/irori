import { isSleepRequest,type SleepRequest } from "./sleep"
import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import type { SaveOwner } from "./save-attempt"
export const SLEEP_PENDING_PREFIX="irori:sleep-request:v1:"
export type PendingSleep={schemaVersion:1;nonce:string;owner:SaveOwner;request:SleepRequest;phase:"sending"|"unknown";createdAt:string}
const key=(p:PendingSleep)=>`${SLEEP_PENDING_PREFIX}${p.owner.userId}:${p.owner.householdId}:${p.request.childId}:${p.nonce}`
function parse(raw:string):PendingSleep|null{
 try{const v:unknown=JSON.parse(raw);if(!isRecord(v)||v.schemaVersion!==1||!isClientId(v.nonce)||!isRecord(v.owner)||typeof v.owner.userId!=="string"||typeof v.owner.householdId!=="string"||!isSleepRequest(v.request)||v.owner.childId!==v.request.childId||!['sending','unknown'].includes(String(v.phase))||typeof v.createdAt!=="string")return null;return v as PendingSleep}catch{return null}
}
export function listPendingSleep(owner:SaveOwner):{items:PendingSleep[];unreadable:boolean}{
 const items:PendingSleep[]=[];let unreadable=false
 try{for(const k of Object.keys(localStorage)){
  const prefix=`${SLEEP_PENDING_PREFIX}${owner.userId}:${owner.householdId}:`
  if(!k.startsWith(prefix))continue
  const value=parse(localStorage.getItem(k)??"")
  if(!value){unreadable=true;continue}
  if(owner.childId&&value.request.childId!==owner.childId)continue
  items.push(value)
 }}catch{unreadable=true}
 return {items,unreadable}
}
export function putPendingSleep(p:PendingSleep,onlyExisting=false):boolean{
 try{if(onlyExisting&&!localStorage.getItem(key(p)))return false;localStorage.setItem(key(p),JSON.stringify(p));return true}catch{return false}
}
export function removePendingSleep(p:PendingSleep):void{try{localStorage.removeItem(key(p))}catch{/* the next mount will confirm the same id again */}}
export function purgeOtherSleepRequests(owner:SaveOwner):void{
 try{const mine=`${SLEEP_PENDING_PREFIX}${owner.userId}:${owner.householdId}:`;for(const k of Object.keys(localStorage))if(k.startsWith(SLEEP_PENDING_PREFIX)&&!k.startsWith(mine))localStorage.removeItem(k)}catch{/* account guard reports inaccessible storage */}
}
