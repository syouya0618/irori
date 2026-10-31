"use server"
import { revalidatePath } from "next/cache"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { newsRegion } from "@/lib/domain/regional-news"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import { isRecord } from "@/lib/domain/child-sharing"
export async function saveNewsPreferences(region:string|null,enabled:boolean,version:string|null){
 if((region!==null&&!newsRegion(region))||typeof enabled!=="boolean"||(enabled&&region===null)||(version!==null&&!isTimestamptzText(version)))return {error:"地域と通知設定を確認してください"}
 const auth=await getAuthContext();if(auth.error!==null)return {error:auth.error}
 const {data,error}=await auth.context.supabase.rpc("save_news_preferences",{p_region:region,p_enabled:enabled,p_version:version})
 if(error||!isRecord(data)||!["saved","replayed","conflict"].includes(String(data.status)))return {error:"保存結果を確認できませんでした。再読み込みで設定を確認してください"}
 revalidatePath("/news")
 return {status:String(data.status)}
}
