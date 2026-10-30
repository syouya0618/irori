import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import type { SaveOwner } from "./save-attempt"
export const RECORD_REQUEST_PREFIX="irori:record-request:v1:"
export type RecordRequest={schema:1;id:string;owner:SaveOwner&{childId:string};kind:"medical"|"custom";payload:Record<string,unknown>}
const key=(r:RecordRequest)=>`${RECORD_REQUEST_PREFIX}${r.owner.userId}:${r.owner.householdId}:${r.owner.childId}:${r.id}`
function parsed(v:unknown):v is RecordRequest{return isRecord(v)&&v.schema===1&&isClientId(v.id)&&(v.kind==="medical"||v.kind==="custom")&&isRecord(v.owner)&&typeof v.owner.userId==="string"&&typeof v.owner.householdId==="string"&&isClientId(v.owner.childId)&&isRecord(v.payload)&&v.payload.childId===v.owner.childId}
export function listRecordRequests(owner:SaveOwner,kind?:RecordRequest["kind"]):RecordRequest[]{
 try{const out:RecordRequest[]=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(!k?.startsWith(RECORD_REQUEST_PREFIX))continue;let v:unknown;try{v=JSON.parse(localStorage.getItem(k)??"null")}catch{continue}if(parsed(v)&&v.owner.userId===owner.userId&&v.owner.householdId===owner.householdId&&(!owner.childId||v.owner.childId===owner.childId)&&(!kind||v.kind===kind))out.push(v)}return out}catch{return []}
}
export function storeRecordRequest(r:RecordRequest):boolean{try{if(!parsed(r))return false;const k=key(r);if(localStorage.getItem(k)===null)localStorage.setItem(k,JSON.stringify(r));return true}catch{return false}}
export function removeRecordRequest(r:RecordRequest){try{localStorage.removeItem(key(r))}catch{}}
export function purgeOtherRecordRequests(owner:SaveOwner){try{for(const k of Object.keys(localStorage)){if(!k.startsWith(RECORD_REQUEST_PREFIX))continue;let v:unknown;try{v=JSON.parse(localStorage.getItem(k)??"null")}catch{continue}if(parsed(v)&&(v.owner.userId!==owner.userId||v.owner.householdId!==owner.householdId))localStorage.removeItem(k)}}catch{}}
