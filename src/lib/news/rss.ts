import { isValidYmd } from "@/lib/utils/date-jst"
import { createHash } from "node:crypto"
import { XmlDocument,type XmlElement } from "xmldoc"
import { canonicalNewsUrl,newsAgeHint,type NewsRegion } from "@/lib/domain/regional-news"
export const NEWS_FEED_BYTES=256000
export type ParsedNews={region_key:string;id:string;title:string;url:string;published_at:string;min_months:number|null;max_months:number|null}
/** Uses the installed mature XML parser; DTD/entities are rejected and no article body is fetched. */
export function parseNewsFeed(xml:string,region:NewsRegion,now:Date):ParsedNews[]{
 if(Buffer.byteLength(xml)>NEWS_FEED_BYTES||/<!DOCTYPE|<!ENTITY/i.test(xml)||xml.includes("\u0000"))throw new Error("unsupported feed")
 const root=new XmlDocument(xml),items:XmlElement[]=root.name==="rss"?root.childNamed("channel")?.childrenNamed("item")??[]:root.name==="rdf:RDF"||root.name==="RDF"?root.childrenNamed("item"):root.name==="feed"?root.childrenNamed("entry"):[]
 if(!["rss","rdf:RDF","RDF","feed"].includes(root.name))throw new Error("unsupported feed root")
 const out=new Map<string,ParsedNews>()
 for(const item of items.slice(0,200)){
  // A headline is text, not sanitized HTML. Character-wise conversion also handles
  // incomplete/nested tags after XML entity decoding without creating new delimiters.
  const title=(item.childNamed("title")?.val??"").replace(/[<>]/g,c=>c==="<"?"＜":"＞").replace(/\s+/g," ").trim().slice(0,250)
  if(!title||/会計年度任用職員|職員募集|採用|入札|事業者募集/.test(title))continue
  const link=root.name==="feed"?(item.childrenNamed("link").find(l=>!l.attr.rel||l.attr.rel==="alternate")?.attr.href??""):(item.childNamed("link")?.val??"")
  const url=canonicalNewsUrl(link.trim(),region),rawDate=item.childNamed("pubDate")?.val??item.childNamed("dc:date")?.val??item.childNamed("published")?.val??item.childNamed("updated")?.val
  if(!url||!rawDate||!/[0-9]{4}/.test(rawDate))continue
  const isoDay=rawDate.match(/^(\d{4}-\d{2}-\d{2})(?:T|$)/)?.[1]
  if(isoDay&&!isValidYmd(isoDay))continue
  const dateOnly=/^\d{4}-\d{2}-\d{2}$/.test(rawDate)
  if(dateOnly&&!isValidYmd(rawDate))continue
  const published=Date.parse(dateOnly?`${rawDate}T00:00:00+09:00`:rawDate)
  if(!Number.isFinite(published)||published>now.getTime()||published<now.getTime()-7*86400000)continue
  const id=createHash("sha256").update(url).digest("hex")
  if(!out.has(id))out.set(id,{region_key:region.key,id,title,url,published_at:new Date(published).toISOString(),...newsAgeHint(title)})
 }
 return [...out.values()]
}
export async function fetchNewsFeed(region:NewsRegion,now:Date,fetcher:typeof fetch=fetch):Promise<ParsedNews[]>{
 const response=await fetcher(region.feed,{redirect:"error",cache:"no-store",signal:AbortSignal.timeout(5000),headers:{Accept:"application/rss+xml, application/atom+xml, application/xml, text/xml"}})
 if(!response.ok||!/^(application\/(rss\+xml|atom\+xml|xml)|text\/xml)(;|$)/i.test(response.headers.get("content-type")??"")||Number(response.headers.get("content-length")??0)>NEWS_FEED_BYTES||!response.body)throw new Error("feed unavailable")
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>NEWS_FEED_BYTES)throw new Error("feed too large");chunks.push(value)}}finally{await reader.cancel()}
 const data=Buffer.concat(chunks);const text=new TextDecoder("utf-8",{fatal:true}).decode(data)
 if(/<\?xml[^>]*encoding\s*=\s*["'](?!utf-8["']|UTF-8["'])/i.test(text))throw new Error("unsupported encoding")
 return parseNewsFeed(text,region,now)
}
