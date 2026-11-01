"use server"
import { revalidatePath } from "next/cache"
import { getBabyAuthContext } from "@/lib/supabase/child-context"
import { isCustomRequest,type CustomRequest } from "@/lib/domain/custom-records"
import { isRecord } from "@/lib/domain/child-sharing"
import { failureKindOfDbError } from "@/lib/domain/save-attempt"
export async function saveCustom(request:CustomRequest){
 if(!isCustomRequest(request))return {error:"項目・値・日時を確認してください",failure:"rejected" as const}
 const auth=await getBabyAuthContext(request.childId);if(auth.error!==null)return {error:auth.error,failure:"rejected" as const}
 const {supabase,householdId}=auth.context
 // A household definition still binds its frozen originating child before a retry after membership changes.
 const {data:child,error:ce}=await supabase.from("children").select("id").eq("id",request.childId).eq("household_id",householdId).maybeSingle()
 if(ce)return {error:"子どもの情報を確認できません",failure:"unknown" as const};if(!child)return {error:"この子どもには記録できません",failure:"rejected" as const}
 const call=async()=>{
  if(request.operation==="field"){
   const {data,error}=await supabase.rpc("save_custom_field",{p_id:request.id,p_version:request.version,p_label:request.label,p_type:request.type,p_options:request.options,p_archived:request.archived});return {data,error}
  }
  const {data,error}=await supabase.rpc("save_custom_record",{p_id:request.id,p_child:request.childId,p_version:request.version,p_field:request.fieldId,p_value:request.value,p_logged_at:request.loggedAt,p_memo:request.memo,p_voided:request.voided});return {data,error}
 }
 const {data,error}=await call()
 if(error)return {error:"保存できませんでした。値の型・廃止済み項目・閲覧権限を確認してください",failure:failureKindOfDbError(error)}
 if(!isRecord(data)||!["saved","replayed","conflict"].includes(String(data.status)))return {error:"保存結果を確認できませんでした",failure:"unknown" as const}
 revalidatePath("/baby/custom")
 return {status:String(data.status)}
}
