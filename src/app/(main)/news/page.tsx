import Link from "next/link"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { newsRegion,relevantNews,canonicalNewsUrl } from "@/lib/domain/regional-news"
import { ageMonthsAt } from "@/lib/domain/child-age"
import { toJstDateString,todayJstString } from "@/lib/utils/date-jst"
import { NewsPreferences } from "@/components/news/news-preferences"
export default async function NewsPage({searchParams}:{searchParams:Promise<{all?:string}>}){
 const auth=await getAuthContext();if(auth.error!==null)throw new Error(auth.error)
 const {supabase,userId,householdId}=auth.context,all=(await searchParams).all==="1",now=new Date(),today=todayJstString(now)
 const [{data:pref,error:pe},{data:children,error:ce}]=await Promise.all([supabase.from("news_preferences").select("*").eq("user_id",userId).maybeSingle(),supabase.from("children").select("birth_date").eq("household_id",householdId)])
 if(pe||ce)throw new Error("ニュース設定を取得できませんでした")
 const region=newsRegion(pref?.region_key),months=(children??[]).map(c=>ageMonthsAt(c.birth_date,today)).filter((m):m is number=>m!==null)
 const read=async()=>{if(!region)return {articles:[],lastSuccess:null};const [{data,error},{data:status,error:se}]=await Promise.all([
  supabase.from("news_articles").select("*").eq("region_key",region.key).gte("published_at",new Date(now.getTime()-7*86400000).toISOString()).lte("published_at",now.toISOString()).order("published_at",{ascending:false}).order("id").limit(100),
  supabase.rpc("news_source_status"),
 ]);if(error||se)throw new Error("ニュースを取得できませんでした");return {articles:data??[],lastSuccess:typeof status==="string"?status:null}}
 const {articles,lastSuccess}=await read(),visible=all?articles:articles.filter(a=>relevantNews(a,months))
 return <main className="flex flex-col gap-4 px-4 py-8"><Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link><h1 className="text-lg font-semibold">地域の子育てニュース</h1>
  <NewsPreferences key={pref?.updated_at??"new"} region={pref?.region_key??null} enabled={pref?.enabled??false} version={pref?.updated_at??null}/>
  <Link href="/settings" className="min-h-11 py-3 text-sm text-primary">端末の通知設定</Link>
  {region&&<><p className="text-sm"><a className="underline" href={region.guide} target="_blank" rel="noreferrer">出典: {region.publisher} 公式RSS</a></p><p className="text-xs text-muted-foreground">{lastSuccess?`最終取得: ${toJstDateString(lastSuccess)}（日本時間）`:"まだ取得していません。次の朝の取得を待ってください。"}{lastSuccess&&Date.parse(lastSuccess)<now.getTime()-25*3600000?" 更新を確認できていません。自治体の公式サイトも確認してください。":""}</p>
   <Link className="min-h-11 py-3 text-sm text-primary" href={all?"/news":"/news?all=1"}>{all?"子どもの年齢に合わせて表示":"年齢の絞り込みを外す"}</Link>
   <p className="text-xs text-muted-foreground">直近7日・最新100件。年齢は見出しの語句からの目安です。対象年齢・日程は必ず自治体の本文を確認してください。子どもの情報を配信元やAIへ送信しません。</p>
   {!visible.length&&lastSuccess&&<p>この範囲に新しい記事はありません。</p>}
   <ul className="flex flex-col gap-3">{visible.filter(a=>canonicalNewsUrl(a.url,region)!==null).map(a=><li key={a.id} className="glass rounded-2xl p-4"><p className="mb-2 text-xs text-muted-foreground">{toJstDateString(a.published_at)}・{region.publisher}</p><a href={a.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center text-sm underline">{a.title}</a></li>)}</ul>
  </>}
 </main>
}
