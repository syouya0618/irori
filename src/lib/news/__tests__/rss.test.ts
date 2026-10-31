import { describe,expect,it,vi } from "vitest"
import { NEWS_REGIONS,canonicalNewsUrl,newsAgeHint,newsWindow,relevantNews } from "@/lib/domain/regional-news"
import { fetchNewsFeed,parseNewsFeed,NEWS_FEED_BYTES } from "../rss"
const region=NEWS_REGIONS[0],now=new Date("2026-10-30T23:00:00Z")
const item=(title="synthetic infant news",url="https://www.city.sapporo.jp/synthetic/a.html?utm_source=fixture",date="2026-10-30T21:00:00Z")=>`<item><title>${title}</title><link>${url}</link><dc:date>${date}</dc:date></item>`
const rss=(content:string)=>`<rdf:RDF xmlns:dc="https://example.invalid/dc" xmlns:rdf="https://example.invalid/rdf">${content}</rdf:RDF>`
describe("official RSS boundaries",()=>{
 it("turns decoded tag delimiters into plain headline characters, including incomplete and nested forms",()=>{
  for(const text of ['<![CDATA[<script]]>','&lt;script','&#60;script','<![CDATA[<<script>script>alert(1)</script>]]>','&amp;lt;script']){
   const title=parseNewsFeed(rss(item(text)),region,now)[0].title
   expect(title).not.toMatch(/[<>]/)
  }
  expect(parseNewsFeed(rss(item('<![CDATA[2歳 < 3歳 / 4歳 > 3歳]]>')),region,now)[0].title).toBe('2歳 ＜ 3歳 / 4歳 ＞ 3歳')
  expect(parseNewsFeed(rss(item('子育て相談のお知らせ')),region,now)[0].title).toBe('子育て相談のお知らせ')
 })
 it("keeps source/date and deduplicates normalized URLs; never fetches an article",()=>{
  const rows=parseNewsFeed(rss(item()+item("synthetic duplicate","https://www.city.sapporo.jp/synthetic/a.html")),region,now)
  expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({region_key:"sapporo",title:"synthetic infant news",url:"https://www.city.sapporo.jp/synthetic/a.html",published_at:"2026-10-30T21:00:00.000Z"});expect(rows[0].id).toMatch(/^[a-f0-9]{64}$/)
 })
 it("discards undated, future, old, recruiting and nonofficial items",()=>{
  expect(parseNewsFeed(rss(item("synthetic missing",undefined,"")+item("synthetic future",undefined,"2026-11-01T00:00:00Z")+item("synthetic old",undefined,"2025-01-01T00:00:00Z")+item("職員募集 fixture")+item("synthetic other","https://example.invalid/unsafe")),region,now)).toEqual([])
  for(const url of ["","http://127.0.0.1/","https://www.city.sapporo.jp.example.invalid/x","https://user:pass@www.city.sapporo.jp/x","javascript:alert(1)"])expect(canonicalNewsUrl(url,region)).toBeNull()
 })
 it("rejects DTD/entity documents, malformed XML and oversized bodies",()=>{
  for(const text of ['<!DOCTYPE feed [<!ENTITY x "fixture">]><feed/>','<rss><item></rss>',"x".repeat(NEWS_FEED_BYTES+1)])expect(()=>parseNewsFeed(text,region,now)).toThrow()
 })
 it("supports RSS2, Atom and date-only Japanese source dates without inventing missing dates",()=>{
  expect(parseNewsFeed(`<rss><channel>${item()}</channel></rss>`,region,now)).toHaveLength(1)
  expect(parseNewsFeed('<feed><entry><title>synthetic atom</title><link href="https://www.city.sapporo.jp/synthetic/atom.html"/><published>2026-10-30T22:00:00Z</published></entry></feed>',region,now)).toHaveLength(1)
  expect(parseNewsFeed(rss(item("synthetic date only",undefined,"2026-10-31")),region,now)[0].published_at).toBe("2026-10-30T15:00:00.000Z")
 })
 it("fetches only the pinned source, rejects redirects/HTML and enforces a streaming byte limit",async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(rss(item()),{headers:{"content-type":"text/xml; charset=utf-8"}}))
  expect(await fetchNewsFeed(region,now,fetcher)).toHaveLength(1);expect(fetcher).toHaveBeenCalledWith(region.feed,expect.objectContaining({redirect:"error",cache:"no-store"}))
  fetcher.mockResolvedValue(new Response("<html/>",{headers:{"content-type":"text/html"}}));await expect(fetchNewsFeed(region,now,fetcher)).rejects.toThrow()
  fetcher.mockResolvedValue(new Response("x".repeat(NEWS_FEED_BYTES+1),{headers:{"content-type":"text/xml"}}));await expect(fetchNewsFeed(region,now,fetcher)).rejects.toThrow()
 })
 it("uses conservative age hints locally and respects the JST morning window",()=>{
  expect(newsAgeHint("synthetic ３歳児健診")).toEqual({min_months:36,max_months:47});expect(newsAgeHint("synthetic 1〜3歳")).toEqual({min_months:12,max_months:47})
  expect(relevantNews(newsAgeHint("synthetic 小学生"),[3,20])).toBe(false);expect(relevantNews(newsAgeHint("synthetic general"),[])).toBe(true)
  expect(newsWindow(new Date("2026-10-30T22:44:00Z"))).toBeNull();expect(newsWindow(new Date("2026-10-30T22:45:00Z"))).toBe("fetch");expect(newsWindow(now)).toBe("deliver");expect(newsWindow(new Date("2026-10-30T23:15:00Z"))).toBeNull()
 })
})
