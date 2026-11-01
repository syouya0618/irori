import { expect,it,vi } from "vitest"
import { collectRegionNews } from "../collect"
import { NEWS_SOURCES } from "@/lib/domain/regional-news"
import { parseNewsFeed } from "../rss"
import { createFakeNotifySupabase,emptyNotifyDb } from "@/lib/notifications/__tests__/fake-notify-db"
const now=new Date("2026-11-01T01:00:00Z")
it("independent leases keep two sources available when the third fails, without Push",async()=>{
 const state=emptyNotifyDb(),fake=createFakeNotifySupabase(state)
 const claims=new Set<string>()
 Object.assign(fake.client,{rpc:vi.fn((_name:string,args:{p_region:string})=>{const fresh=!claims.has(args.p_region);claims.add(args.p_region);const p=Promise.resolve({data:fresh,error:null});return Object.assign(p,{abortSignal:()=>p})})})
 const fetchFeed=vi.fn(async(source:Parameters<typeof parseNewsFeed>[1])=>{
  if(source.key==="kakegawa-facilities")throw new Error("synthetic outage")
  return parseNewsFeed('<rss><channel><item><title>synthetic article</title><link>https://www.city.kakegawa.shizuoka.jp/kakekko/synthetic/a.html?utm_source=test</link><pubDate>2026-10-31T01:00:00Z</pubDate></item></channel></rss>',source,now)
 })
 const result=await collectRegionNews(fake.client,"kakegawa",now,fetchFeed)
 expect(result.status).toBe("partial");expect(result.failed).toBe(1);expect(fetchFeed).toHaveBeenCalledTimes(3)
 expect(state.news_articles).toHaveLength(1);expect(state.news_deliveries).toHaveLength(0)
 expect((await collectRegionNews(fake.client,"kakegawa",now,fetchFeed)).status).toBe("cooldown")
 expect(fetchFeed).toHaveBeenCalledTimes(3)
})
it("all official Kakegawa sources share regional URL identity but retain provenance",()=>{
 const rows=NEWS_SOURCES.filter(s=>s.region_key==="kakegawa").map(s=>parseNewsFeed('<rss><channel><item><title>synthetic old article</title><link>https://www.city.kakegawa.shizuoka.jp/kakekko/synthetic/a.html</link><pubDate>2020-01-01T00:00:00Z</pubDate></item></channel></rss>',s,now)[0])
 expect(new Set(rows.map(r=>r.id)).size).toBe(1);expect(new Set(rows.map(r=>r.source_key)).size).toBe(3)
 expect(rows.every(r=>r.region_key==="kakegawa"&&r.published_at==="2020-01-01T00:00:00.000Z")).toBe(true)
})
