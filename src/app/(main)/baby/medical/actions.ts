"use server"
import { revalidatePath } from "next/cache"
import { getBabyAuthContext } from "@/lib/supabase/child-context"
import { isMedicalRequest,medicalJson,type MedicalRequest } from "@/lib/domain/medical"
import { isRecord } from "@/lib/domain/child-sharing"
import { failureKindOfDbError } from "@/lib/domain/save-attempt"
export async function saveMedical(request:MedicalRequest){
 if(!isMedicalRequest(request))return {error:"日付・回数・入力内容を確認してください",failure:"rejected" as const}
 const auth=await getBabyAuthContext(request.childId);if(auth.error!==null)return {error:auth.error,failure:"rejected" as const}
 const {data,error}=await auth.context.supabase.rpc("save_medical_record",{p_id:request.id,p_child:request.childId,p_version:request.version,p_value:medicalJson(request.value)})
 if(error)return {error:"保存できませんでした。入力・日付・権限を確認してください",failure:failureKindOfDbError(error)}
 if(!isRecord(data)||!["saved","replayed","conflict"].includes(String(data.status))||!isRecord(data.record)||data.record.child_id!==request.childId)return {error:"保存結果を確認できませんでした",failure:"unknown" as const}
 revalidatePath("/baby/medical");revalidatePath("/calendar");revalidatePath("/baby")
 return {status:String(data.status)}
}
