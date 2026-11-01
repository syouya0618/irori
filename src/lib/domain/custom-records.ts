import type { Database,Json } from "@/lib/types/database"
import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import { isTimestamptzText } from "./timestamptz-text"
export type CustomField=Database["public"]["Tables"]["custom_fields"]["Row"]
export type CustomRecord=Database["public"]["Tables"]["custom_records"]["Row"]
export const CUSTOM_TYPES=["number","boolean","text","datetime","choice"] as const
export const CUSTOM_LABELS={number:"数値",boolean:"はい・いいえ",text:"文字列",datetime:"日時",choice:"選択肢"} as const
export type CustomFieldRequest={operation:"field";id:string;childId:string;version:string|null;label:string;type:CustomField["value_type"];options:string[];archived:boolean}
export type CustomRecordRequest={operation:"record";id:string;childId:string;version:string|null;fieldId:string;value:Json;loggedAt:string;memo:string|null;voided:boolean}
export type CustomRequest=CustomFieldRequest|CustomRecordRequest
export function isCustomRequest(v:unknown):v is CustomRequest{
 if(!isRecord(v)||!isClientId(v.id)||!isClientId(v.childId)||!(v.version===null||isTimestamptzText(v.version)))return false
 if(v.operation==="field")return typeof v.label==="string"&&v.label.trim().length>0&&v.label.length<=80&&CUSTOM_TYPES.includes(v.type as CustomField["value_type"])&&typeof v.archived==="boolean"&&Array.isArray(v.options)&&v.options.every(s=>typeof s==="string"&&s.trim().length>0&&s.length<=80)&&new Set(v.options).size===v.options.length&&(v.type==="choice"?(v.options.length>0&&v.options.length<=30):v.options.length===0)
 return v.operation==="record"&&isClientId(v.fieldId)&&typeof v.loggedAt==="string"&&isTimestamptzText(v.loggedAt)&&typeof v.voided==="boolean"&&(v.memo===null||(typeof v.memo==="string"&&v.memo.length<=1000))&&((typeof v.value==="number"&&Number.isFinite(v.value)&&Math.abs(v.value)<=1e9)||typeof v.value==="boolean"||(typeof v.value==="string"&&v.value.length>0&&v.value.length<=1000))
}
export function displayCustomValue(value:Json,type:string):string{
 if(type==="boolean")return value===true?"はい":value===false?"いいえ":"不明"
 return typeof value==="string"||typeof value==="number"?String(value):"不明"
}
