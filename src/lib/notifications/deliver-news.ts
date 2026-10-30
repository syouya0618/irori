import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { NEWS_REGIONS,newsWindow } from "@/lib/domain/regional-news"
import { fetchNewsFeed } from "@/lib/news/rss"
import { isAllowedPushEndpoint } from "@/lib/domain/push-endpoint"
import { isProvenNotDelivered,type PushSendOptions,type PushSendResult,type PushTarget,type VapidConfig } from "./send-push"
import type { FeedbackPhaseDeps,FeedbackPhaseCounters } from "./deliver-feedback"
import { isRecord } from "@/lib/domain/child-sharing"
type Client=SupabaseClient<Database>
export type NewsDeps=Omit<FeedbackPhaseDeps,"sendPush">&{sendPush:(target:PushTarget,vapid:VapidConfig,payload:unknown,options?:PushSendOptions)=>Promise<PushSendResult>;fetchFeed?:typeof fetchNewsFeed}
/** Last cron phase: bounded official RSS reads, then the existing Push transport/subscription settlement. */
export async function deliverRegionalNews(db:Client,deps:NewsDeps,counters:FeedbackPhaseCounters&{scheduled:number}):Promise<void>{
 const window=newsWindow(deps.now);if(!window)return
 const nowIso=deps.now.toISOString(),day=new Date(deps.now.getTime()+9*3600000).toISOString().slice(0,10),started=performance.now()
 let configured=false
 await Promise.all(NEWS_REGIONS.map(async region=>{
  try{
   // Global existence check for this public source; never pass user attributes to a feed.
   const {data:pref,error:pe}=await db.from("news_preferences").select("user_id").eq("region_key",region.key).limit(1)
   if(pe)throw new Error("preference lookup failed");if(!pref?.length)return;configured=true
   const {data:claimed,error:ce}=await db.rpc("claim_news_source",{p_region:region.key,p_now:nowIso});if(ce)throw new Error("source claim failed");if(!claimed)return
   const articles=await (deps.fetchFeed??fetchNewsFeed)(region,deps.now)
   if(articles.length){const {error}=await db.from("news_articles").upsert(articles,{onConflict:"region_key,id",ignoreDuplicates:true});if(error)throw new Error("article persistence failed")}
   const {error:se}=await db.from("news_source_runs").update({last_success_at:nowIso}).eq("region_key",region.key);if(se)throw new Error("source receipt failed")
  }catch{counters.failed++;console.error("[cron-notify] news source phase failed",{source:region.key})}
 }))
 if(window!=="deliver"||!configured)return
 const {data:prepared,error:qe}=await db.rpc("prepare_news_deliveries",{p_now:nowIso});if(qe)throw new Error("news queue preparation failed");counters.scheduled+=prepared??0
 const {data:rows,error:re}=await db.from("news_deliveries").select("id,recipient_id,subscription_id,article_ids,day").eq("day",day).is("sent_at",null).is("skipped_at",null).order("id").limit(200)
 if(re)throw new Error("news queue read failed");if(!rows?.length)return
 const {rows:subscriptions,error:se}=await deps.loadSubscriptions(db,[...new Set(rows.map(r=>r.recipient_id))]);if(se)throw new Error("news subscription read failed")
 const targets=new Map(subscriptions.map(s=>[s.id,s]))
 for(const row of rows){
  if(performance.now()-started>15000)break // preserve runtime budget; remaining rows are picked up by the next cron tick
  const target=row.subscription_id?targets.get(row.subscription_id):null
  if(!target||target.user_id!==row.recipient_id)continue
  if(!isAllowedPushEndpoint(target.endpoint)){counters.rejectedEndpoints++;continue}
  const attemptedAt=new Date(deps.now.getTime()+performance.now()-started)
  const {data:claim,error:ce}=await db.rpc("claim_news_delivery",{p_id:row.id,p_now:attemptedAt.toISOString()})
  if(ce){counters.failed++;continue}if(!isRecord(claim)||claim.id!==row.id)continue
  // Payload is deliberately generic: no child name, birth date, region or headline on the lock screen.
  const remaining=Math.max(1,Math.floor((Date.parse(`${day}T08:15:00+09:00` )-attemptedAt.getTime())/1000))
  const result=await deps.sendPush({endpoint:target.endpoint,p256dh:target.p256dh,auth:target.auth},deps.vapid,{title:"地域の子育てニュース",body:"新しい情報があります。アプリで確認できます。",url:"/news",tag:`news:${day}`},{ttlSeconds:remaining})
  if(result.ok){counters.sent++;const {error}=await db.from("news_deliveries").update({accepted_at:nowIso}).eq("id",row.id);if(error)counters.failed++}
  else if(result.gone){counters.skipped++;const {error}=await db.from("news_deliveries").update({skipped_at:nowIso}).eq("id",row.id);if(error)counters.failed++}
  else{counters.failed++;if(isProvenNotDelivered(result)){const {error}=await db.from("news_deliveries").update({sent_at:null}).eq("id",row.id);if(error)counters.failed++}}
  await deps.settleSubscription(db,target,result,nowIso,{phase:"news"})
 }
}
