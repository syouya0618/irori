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

/** Explicit authenticated POST action; the source lease is shared across all readers. */
export async function refreshNews(){
 const auth=await getAuthContext();if(auth.error!==null)return {error:auth.error}
 const {data:pref,error}=await auth.context.supabase.from("news_preferences").select("region_key").eq("user_id",auth.context.userId).maybeSingle()
 const region=newsRegion(pref?.region_key)
 if(error||!region)return {error:"先に地域を保存してください"}
 try{
  const {createAdminClient}=await import("@/lib/supabase/admin")
  const {collectRegionNews}=await import("@/lib/news/collect")
  const result=await collectRegionNews(createAdminClient(),region.key,new Date())
  revalidatePath("/news")
  return {status:result.status,fetched:result.fetched}
 }catch{return {error:"更新を開始できませんでした。しばらくして再度お試しください"}}
}
