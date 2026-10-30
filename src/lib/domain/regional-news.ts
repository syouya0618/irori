export const NEWS_REGIONS=[
 {key:"sapporo",label:"札幌市",publisher:"札幌市 子ども未来局",feed:"https://www.city.sapporo.jp/org/kodomomirai/kodomo_shinchaku.xml",origin:"https://www.city.sapporo.jp",guide:"https://www.city.sapporo.jp/koho/hp/rss/index.html"},
 {key:"yokohama",label:"横浜市",publisher:"横浜市 子育て・教育",feed:"https://www.city.yokohama.lg.jp/kosodate-kyoiku/rss_news.xml",origin:"https://www.city.yokohama.lg.jp",guide:"https://www.city.yokohama.lg.jp/aboutweb/usage/rss.html"},
] as const
export type NewsRegion=typeof NEWS_REGIONS[number]
export function newsRegion(key:unknown):NewsRegion|null{return NEWS_REGIONS.find(r=>r.key===key)??null}
export function canonicalNewsUrl(raw:string,region:NewsRegion):string|null{
 if(!raw.trim())return null
 try{const u=new URL(raw,region.feed);if(u.origin!==region.origin||u.username||u.password||u.protocol!=="https:"||u.href.length>2000)return null
 u.hash="";for(const k of [...u.searchParams.keys()])if(/^utm_/i.test(k)||k==="fbclid")u.searchParams.delete(k);return u.href}catch{return null}
}
/** Conservative headline hints, never eligibility/medical advice. Unknown targets stay unfiltered. */
export function newsAgeHint(title:string):{min_months:number|null;max_months:number|null}{
 const t=title.normalize("NFKC"),range=t.match(/(\d{1,2})\s*[〜～~−-]\s*(\d{1,2})\s*歳/),age=t.match(/(\d{1,2})\s*歳/)
 if(range){const a=Number(range[1]),b=Number(range[2]);if(a<=b&&b<18)return {min_months:a*12,max_months:(b+1)*12-1}}
 if(age&&Number(age[1])<18)return {min_months:Number(age[1])*12,max_months:Number(age[1])*12+11}
 if(/乳幼児/.test(t))return {min_months:0,max_months:71}
 if(/乳児|赤ちゃん|新生児/.test(t))return {min_months:0,max_months:11}
 if(/幼児|未就学|未就園/.test(t))return {min_months:0,max_months:71}
 if(/小学生|中学生|高校生/.test(t))return {min_months:72,max_months:215}
 return {min_months:null,max_months:null}
}
export function relevantNews(a:{min_months:number|null;max_months:number|null},months:readonly number[]):boolean{return a.min_months===null||months.some(m=>m>=a.min_months!&&m<(a.max_months??-1)+1)}
export function newsWindow(now:Date):"fetch"|"deliver"|null{
 const shifted=new Date(now.getTime()+9*3600000),minutes=shifted.getUTCHours()*60+shifted.getUTCMinutes()
 return minutes>=480&&minutes<495?"deliver":minutes>=465&&minutes<480?"fetch":null
}
