import { beforeEach,expect,it,vi } from "vitest"
import { deliverRegionalNews,type NewsDeps } from "../deliver-news"
import { emptyNotifyDb,createFakeNotifySupabase } from "./fake-notify-db"
import type { PushSendResult } from "../send-push"
const now=new Date("2026-10-30T23:00:00Z")
beforeEach(()=>vi.restoreAllMocks())
function setup(withQueue=true){
 const db=emptyNotifyDb();db.news_preferences.push({user_id:"synthetic-user",region_key:"sapporo",enabled:true})
 const row={id:"synthetic-news",recipient_id:"synthetic-user",household_id:"synthetic-household",region_key:"sapporo",day:"2026-10-31",subscription_id:"synthetic-sub",article_ids:["synthetic-article"],sent_at:null as string|null,skipped_at:null,accepted_at:null}
 if(withQueue)db.news_deliveries.push(row)
 const fake=createFakeNotifySupabase(db),rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==="claim_news_source")return {data:true,error:null}
  if(name==="prepare_news_deliveries")return {data:0,error:null}
  if(name==="claim_news_delivery"){if(row.sent_at!==null)return {data:null,error:null};row.sent_at=String(args.p_now);return {data:{id:row.id},error:null}}
  throw new Error("unexpected synthetic RPC")
 });Object.assign(fake.client,{rpc})
 const send=vi.fn<NewsDeps["sendPush"]>().mockResolvedValue({ok:true}),fetchFeed=vi.fn<NonNullable<NewsDeps["fetchFeed"]>>().mockResolvedValue([]),settle=vi.fn()
 const target={id:"synthetic-sub",user_id:"synthetic-user",endpoint:"https://fcm.googleapis.com/synthetic-news",p256dh:"fixture-key",auth:"fixture-auth",failure_count:0}
 const deps:NewsDeps={now,vapid:{publicKey:"fixture-public",privateKey:"fixture-private",subject:"mailto:fixture@example.invalid"},sendPush:send,fetchFeed,loadSubscriptions:async()=>({rows:[target],error:null}),settleSubscription:settle}
 const counters={scheduled:0,sent:0,skipped:0,failed:0,rejectedEndpoints:0}
 return {db,row,fake,rpc,send,fetchFeed,settle,target,deps,counters,run:()=>deliverRegionalNews(fake.client,deps,counters)}
}
it("claims once, sends a generic payload and reuses existing subscription settlement",async()=>{
 const s=setup();await s.run();await s.run();expect(s.send).toHaveBeenCalledTimes(1);expect(s.counters.sent).toBe(1);expect(s.settle).toHaveBeenCalledTimes(1)
 expect(s.send.mock.calls[0][2]).toEqual({title:"地域の子育てニュース",body:"新しい情報があります。アプリで確認できます。",url:"/news",tag:"news:2026-10-31"});expect(s.send.mock.calls[0][3]?.ttlSeconds).toBeLessThanOrEqual(900)
})
it("does not send after the final server claim denies current eligibility",async()=>{
 const s=setup();s.rpc.mockImplementation(async name=>({data:name==="claim_news_delivery"?null:name==="prepare_news_deliveries"?0:true,error:null} as never));await s.run();expect(s.send).not.toHaveBeenCalled()
})
it("keeps ambiguous claims closed, while proven rejection can retry the same row",async()=>{
 for(const result of [{ok:false,gone:false,status:null,message:"fixture timeout"},{ok:false,gone:false,status:503,message:"fixture rejection"}] satisfies PushSendResult[]){
  const s=setup();s.send.mockResolvedValue(result);await s.run();s.send.mockResolvedValue({ok:true});await s.run();expect(s.send).toHaveBeenCalledTimes(result.status===null?1:2)
 }
})
it("rejects unsafe or wrong-user subscriptions before a claim",async()=>{
 const s=setup();s.target.endpoint="https://example.invalid/unsafe";await s.run();expect(s.counters.rejectedEndpoints).toBe(1);expect(s.send).not.toHaveBeenCalled();expect(s.rpc.mock.calls.some(c=>c[0]==="claim_news_delivery")).toBe(false)
 const other=setup();other.target.user_id="synthetic-other-user";await other.run();expect(other.send).not.toHaveBeenCalled()
})
it("empty articles create no notification, and source failures are counted without throwing",async()=>{
 const s=setup(false);await s.run();expect(s.send).not.toHaveBeenCalled();s.fetchFeed.mockRejectedValue(new Error("synthetic feed failure"));vi.spyOn(console,"error").mockImplementation(()=>{});await expect(s.run()).resolves.toBeUndefined();expect(s.counters.failed).toBe(1)
})
