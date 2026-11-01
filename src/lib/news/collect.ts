import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { NEWS_REGIONS, newsSources, newsWindow } from "@/lib/domain/regional-news"
import { enrichNewsArticles } from "./ai"
import { fetchNewsFeed } from "./rss"

/** Shared public cache only. No Push, household attributes or GET-side effects. */
export async function collectRegionNews(db:SupabaseClient<Database>,regionKey:string,now:Date,fetchFeed=fetchNewsFeed,signal?:AbortSignal){
 const stamp=now.toISOString(),deadline=signal??AbortSignal.timeout(8000)
 const results=await Promise.all(newsSources(regionKey).map(async source=>{
  let claimed=false
  try{
   const claim=await db.rpc("claim_news_source",{p_region:source.key,p_now:stamp}).abortSignal(deadline)
   if(claim.error)throw new Error("claim failed")
   if(!claim.data)return {state:"cooldown",count:0}
   claimed=true
   const raw=await fetchFeed(source,now,undefined,deadline)
   const articles=await enrichNewsArticles(db,raw,{now,signal:deadline})
   if(articles.length){const {error}=await db.from("news_articles").upsert(articles,{onConflict:"region_key,id",ignoreDuplicates:true}).abortSignal(deadline);if(error)throw new Error("persist failed")}
   const receipt=await db.from("news_source_runs").update({last_success_at:stamp,last_error_at:null}).eq("source_key",source.key).eq("claimed_at",stamp).abortSignal(deadline)
   if(receipt.error)throw new Error("receipt failed")
   return {state:"updated",count:articles.length}
  }catch{
   if(claimed)await db.from("news_source_runs").update({last_error_at:stamp}).eq("source_key",source.key).eq("claimed_at",stamp).abortSignal(deadline)
   return {state:"failed",count:0}
  }
 }))
 const failed=results.filter(r=>r.state==="failed").length,updated=results.filter(r=>r.state==="updated").length
 return {status:failed?(updated?"partial":"failed"):updated?"updated":"cooldown",fetched:results.reduce((n,r)=>n+r.count,0),failed} as const
}

export async function collectConfiguredNews(db:SupabaseClient<Database>,now:Date,fetchFeed=fetchNewsFeed){
 if(!newsWindow(now))return {configured:false,failed:0}
 const deadline=AbortSignal.timeout(8000)
 // All five fixed sources run concurrently, each with the same five-second fetch ceiling.
 const outcomes=await Promise.all(NEWS_REGIONS.map(async region=>{
  const {data,error}=await db.from("news_preferences").select("user_id").eq("region_key",region.key).limit(1).abortSignal(deadline)
  if(error)return {configured:false,failed:1}
  if(!data?.length)return {configured:false,failed:0}
  return {configured:true,...await collectRegionNews(db,region.key,now,fetchFeed,deadline)}
 }))
 return {configured:outcomes.some(o=>o.configured),failed:outcomes.reduce((n,o)=>n+o.failed,0)}
}
