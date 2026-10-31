import { getBabyAuthContext } from "@/lib/supabase/child-context"
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { isClientId } from "@/lib/utils/client-id"
import { isValidYmd } from "@/lib/utils/date-jst"
import { MEDICAL_SOURCES } from "@/lib/domain/medical"
import { isRecord } from "@/lib/domain/child-sharing"
export const maxDuration=30
const headers={"Cache-Control":"private, no-store","Vary":"Cookie","X-Content-Type-Options":"nosniff"}
export async function GET(request:Request){
 const p=new URL(request.url).searchParams,child=p.get("child"),from=p.get("from")||null,to=p.get("to")||null
 if(!isClientId(child)||(from!==null&&!isValidYmd(from))||(to!==null&&!isValidYmd(to))||(from&&to&&from>to))return Response.json({error:"子ども・日付範囲を確認してください"},{status:400,headers})
 const auth=await getBabyAuthContext(child);if(auth.error!==null)return Response.json({error:auth.error},{status:AUTH_DENIAL_HTTP_STATUS[auth.reason],headers})
 const {data,error}=await auth.context.supabase.rpc("export_child_records",{p_child:child,p_from:from,p_to:to})
 if(error)return Response.json({error:error.code==="54000"?"件数・容量の上限を超えました。期間を短くして書き出してください":"記録を取得できませんでした"},{status:error.code==="54000"?413:error.code==="42501"?403:503,headers})
 if(!isRecord(data)||data.child_id!==child||data.complete!==true)return Response.json({error:"書き出し結果を確認できませんでした"},{status:503,headers})
 const body=JSON.stringify({...data,medical_sources:MEDICAL_SOURCES})
 if(new TextEncoder().encode(body).length>3500000)return Response.json({error:"容量の上限を超えました。期間を短くしてください"},{status:413,headers})
 return new Response(body,{headers:{...headers,"Content-Type":"application/json; charset=utf-8","Content-Disposition":'attachment; filename="irori-additional-records.json"'}})
}
