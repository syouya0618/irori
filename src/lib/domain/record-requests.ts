import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import type { SaveOwner } from "./save-attempt"
import { isMedicalRequest } from "./medical"
import { isCustomRequest } from "./custom-records"
import { isValidYmd } from "@/lib/utils/date-jst"
export const RECORD_REQUEST_PREFIX="irori:record-request:v1:"
export type RecordRequest={schema:1;id:string;owner:SaveOwner&{childId:string};kind:"medical"|"custom"|"child";payload:Record<string,unknown>}
const key=(r:RecordRequest)=>`${RECORD_REQUEST_PREFIX}${r.owner.userId}:${r.owner.householdId}:${r.owner.childId}:${r.id}`
/** Reconstruct each supported replay body; never persist an arbitrary object graph. */
function snapshot(v: unknown): RecordRequest | null {
 if (!isRecord(v) || v.schema !== 1 || !isClientId(v.id) || !isRecord(v.owner) || !isRecord(v.payload)) return null
 const o = v.owner, p = v.payload
 if (typeof o.userId !== "string" || !o.userId || typeof o.householdId !== "string" || !o.householdId || !isClientId(o.childId) || p.childId !== o.childId) return null
 let payload: Record<string, unknown>
 if (v.kind === "medical") {
  if (!isMedicalRequest(p)) return null
  const x = p.value
  payload = { id: p.id, childId: p.childId, version: p.version, value: {
   kind: x.kind, title: x.title, dose: x.dose, status: x.status,
   scheduled_date: x.scheduled_date, completed_date: x.completed_date,
   memo: x.memo, remind: x.remind, source_key: x.source_key,
  } }
 } else if (v.kind === "custom") {
  if (!isCustomRequest(p)) return null
  payload = p.operation === "field"
   ? { operation: p.operation, id: p.id, childId: p.childId, version: p.version,
       label: p.label, type: p.type, options: [...p.options], archived: p.archived }
   : { operation: p.operation, id: p.id, childId: p.childId, version: p.version,
       fieldId: p.fieldId, value: p.value, loggedAt: p.loggedAt, memo: p.memo, voided: p.voided }
 } else if (v.kind === "child" && p.id === "" && p.version === "" && p.client_id === v.id && p.client_id === o.childId && p.household_id === o.householdId &&
  typeof p.name === "string" && p.name.trim().length > 0 && p.name.length <= 100 &&
  typeof p.birth_date === "string" && (p.birth_date === "" || isValidYmd(p.birth_date)) &&
  (p.sex === "" || p.sex === "female" || p.sex === "male")) {
  // Keep literal text/empty fields: the server, not persistence, normalizes the form.
  payload = { id: p.id, version: p.version, client_id: p.client_id, household_id: p.household_id,
   name: p.name, birth_date: p.birth_date, sex: p.sex, childId: p.childId }
 } else return null
 return { schema: 1, id: v.id, owner: { userId: o.userId, householdId: o.householdId, childId: o.childId },
  kind: v.kind as RecordRequest["kind"], payload }
}
export function listRecordRequests(owner:SaveOwner,kind?:RecordRequest["kind"]):RecordRequest[]{
 try{const out:RecordRequest[]=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(!k?.startsWith(RECORD_REQUEST_PREFIX))continue;let v:RecordRequest|null;try{v=snapshot(JSON.parse(localStorage.getItem(k)??"null"))}catch{continue}if(v&&key(v)===k&&v.owner.userId===owner.userId&&v.owner.householdId===owner.householdId&&(!owner.childId||v.owner.childId===owner.childId)&&(!kind||v.kind===kind))out.push(v)}return out}catch{return []}
}
export function storeRecordRequest(r:RecordRequest):boolean{try{const value=snapshot(r);if(!value)return false;const k=key(value);if(localStorage.getItem(k)===null)localStorage.setItem(k,JSON.stringify(value));return true}catch{return false}}
export function removeRecordRequest(r:RecordRequest){try{localStorage.removeItem(key(r))}catch{}}
/** Owner cleanup must still recognize older schema-1 bodies that cannot be replayed now. */
function envelopeOwner(v:unknown):SaveOwner|null{
 if(!isRecord(v)||v.schema!==1||!isClientId(v.id)||(v.kind!=="medical"&&v.kind!=="custom"&&v.kind!=="child")||!isRecord(v.owner)||typeof v.owner.userId!=="string"||typeof v.owner.householdId!=="string"||!isClientId(v.owner.childId)||!isRecord(v.payload)||v.payload.childId!==v.owner.childId)return null
 return {userId:v.owner.userId,householdId:v.owner.householdId,childId:v.owner.childId}
}
export function purgeOtherRecordRequests(owner:SaveOwner){try{for(const k of Object.keys(localStorage)){if(!k.startsWith(RECORD_REQUEST_PREFIX))continue;let v:SaveOwner|null;try{v=envelopeOwner(JSON.parse(localStorage.getItem(k)??"null"))}catch{continue}if(v&&(v.userId!==owner.userId||v.householdId!==owner.householdId))localStorage.removeItem(k)}}catch{}}
/** Unknown envelopes remain intact and block another create in their owner scope. */
export function unreadableRecordCount(owner:SaveOwner):number{
 try{let count=0;const prefix=`${RECORD_REQUEST_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId?`${owner.childId}:`:""}`
  for(const k of Object.keys(localStorage)){if(!k.startsWith(prefix))continue;try{const value=snapshot(JSON.parse(localStorage.getItem(k)??"null"));if(!value||key(value)!==k)count++}catch{count++}}return count
 }catch{return 1}
}
