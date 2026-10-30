"use server"
import { revalidatePath } from "next/cache"
import { getBabyAuthContext } from "@/lib/supabase/child-context"
import { isSleepRequest,parseSleepOutcome,type SleepRequest } from "@/lib/domain/sleep"
import { failureKindOfDbError } from "@/lib/domain/save-attempt"
export async function saveSleep(request:SleepRequest) {
 if(!isSleepRequest(request))return {error:"睡眠の入力を確認してください",failure:"rejected" as const}
 const auth=await getBabyAuthContext(request.childId)
 if(auth.error!==null)return {error:auth.error,failure:"rejected" as const}
 const call=async()=>{
  if(request.kind==="start"){
   const {data,error}=await auth.context.supabase.rpc("start_sleep",{p_id:request.id,p_child:request.childId,p_start:request.start??null,p_end:request.end??null,p_memo:request.memo??null});return {data,error}
  }
  if(request.kind==="stop"){
   const {data,error}=await auth.context.supabase.rpc("stop_sleep",{p_id:request.id,p_child:request.childId,p_version:request.version,p_stop_id:request.stopId,p_end:request.end??null});return {data,error}
  }
  const {data,error}=await auth.context.supabase.rpc("edit_sleep",{p_id:request.id,p_child:request.childId,p_version:request.version,p_start:request.start,p_end:request.end,p_memo:request.memo??null,p_voided:request.voided});return {data,error}
 }
 const {data,error}=await call()
 if(error)return {error:"睡眠を保存できませんでした。重なり・時刻・閲覧権限を確認してください",failure:failureKindOfDbError(error)}
 const parsed=parseSleepOutcome(data)
 if(!parsed||parsed.session.child_id!==request.childId)return {error:"保存結果を確認できませんでした",failure:"unknown" as const}
 revalidatePath("/baby/sleep")
 return {result:parsed}
}
