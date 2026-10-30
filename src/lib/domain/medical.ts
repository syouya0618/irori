import type { Database,Json } from "@/lib/types/database"
import { isRecord } from "./child-sharing"
import { isClientId } from "@/lib/utils/client-id"
import { isValidYmd } from "@/lib/utils/date-jst"
import { isTimestamptzText } from "./timestamptz-text"
export type MedicalRecord=Database["public"]["Tables"]["medical_records"]["Row"]
export const MEDICAL_SOURCES={
 vaccination:{key:"jihs-2026-10-01",version:"2026-10-01",title:"国立健康危機管理研究機構 予防接種スケジュール",url:"https://id-info.jihs.go.jp/immunization/schedule/index.html"},
 checkup:{key:"cfa-checkup-2026-07-23",version:"2026-07-23 確認資料",title:"こども家庭庁 乳幼児健診",url:"https://www.cfa.go.jp/policies/boshihoken/nyuyojikenshin"},
} as const
export type MedicalValue=Pick<MedicalRecord,"kind"|"title"|"dose"|"status"|"scheduled_date"|"completed_date"|"memo"|"remind"|"source_key">
export type MedicalRequest={id:string;childId:string;version:string|null;value:MedicalValue}
export function isMedicalRequest(v:unknown):v is MedicalRequest{
 if(!isRecord(v)||!isClientId(v.id)||!isClientId(v.childId)||!(v.version===null||isTimestamptzText(v.version))||!isRecord(v.value))return false
 const x=v.value
 return (x.kind==="vaccination"||x.kind==="checkup")&&typeof x.title==="string"&&x.title.trim().length>0&&x.title.length<=100&&
  (x.dose===null||(Number.isInteger(x.dose)&&Number(x.dose)>=1&&Number(x.dose)<=30))&&(x.kind==="vaccination"||x.dose===null)&&
  ["planned","completed","cancelled"].includes(String(x.status))&&typeof x.scheduled_date==="string"&&isValidYmd(x.scheduled_date)&&
  (x.completed_date===null||(typeof x.completed_date==="string"&&isValidYmd(x.completed_date)))&&((x.status==="completed")===(x.completed_date!==null))&&
  (x.memo===null||(typeof x.memo==="string"&&x.memo.length<=1000))&&typeof x.remind==="boolean"&&x.source_key===MEDICAL_SOURCES[x.kind].key
}
export function medicalJson(v:MedicalValue):Json{return {...v}}
