import Link from "next/link"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { newsRegion, newsSource, newsSources, relevantNews, canonicalNewsUrl } from "@/lib/domain/regional-news"
import { ageMonthsAt } from "@/lib/domain/child-age"
import { toJstDateString, todayJstString } from "@/lib/utils/date-jst"
import { NewsPreferences } from "@/components/news/news-preferences"
import { NewsRefresh } from "@/components/news/news-refresh"

type SourceStatus = { source_key: string; last_success_at: string | null; last_error_at: string | null; claimed_at: string | null }
function parseStatuses(value: unknown): SourceStatus[] {
  if (!Array.isArray(value)) throw new Error("配信元の取得状況を確認できませんでした")
  const statuses = value.filter((s): s is SourceStatus => typeof s === "object" && s !== null && typeof s.source_key === "string" && [s.last_success_at, s.last_error_at, s.claimed_at].every(v => v === null || (typeof v === "string" && Number.isFinite(Date.parse(v)))))
  if (statuses.length !== value.length) throw new Error("配信元の取得状況を確認できませんでした")
  return statuses
}
const formatTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(value))

export default async function NewsPage({ searchParams }: { searchParams: Promise<{ all?: string }> }) {
  const auth = await getAuthContext()
  if (auth.error !== null) throw new Error(auth.error)
  const { supabase, userId, householdId } = auth.context
  const all = (await searchParams).all === "1", now = new Date(), today = todayJstString(now)
  const [{ data: pref, error: pe }, { data: children, error: ce }] = await Promise.all([
    supabase.from("news_preferences").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("children").select("birth_date").eq("household_id", householdId),
  ])
  if (pe || ce) throw new Error("ニュース設定を取得できませんでした")
  const region = newsRegion(pref?.region_key)
  const months = (children ?? []).map(c => ageMonthsAt(c.birth_date, today)).filter((m): m is number => m !== null)
  const read = async () => {
    if (!region) return { articles: [], statuses: [] }
    const [{ data, error }, { data: status, error: se }] = await Promise.all([
      supabase.from("news_articles").select("*").eq("region_key", region.key).or(`published_at.is.null,published_at.lte.${now.toISOString()}`).order("published_at", { ascending: false, nullsFirst: false }).order("id").limit(100),
      supabase.rpc("news_source_statuses"),
    ])
    if (error || se) throw new Error("ニュースを取得できませんでした")
    return { articles: data ?? [], statuses: parseStatuses(status) }
  }
  const { articles, statuses } = await read()
  const visible = all || !months.length ? articles : articles.filter(a => relevantNews(a, months))
  const sources = region ? newsSources(region.key) : []
  const failed = sources.filter(source => { const s = statuses.find(s => s.source_key === source.key); return s?.last_error_at && (!s.last_success_at || s.last_error_at > s.last_success_at) }).length
  const succeeded = statuses.some(s => s.last_success_at)
  return <div className="flex flex-col gap-4 px-4 py-8">
    <Link href="/baby" className="flex min-h-11 items-center text-primary">育児へ戻る</Link>
    <h1 className="text-lg font-semibold">地域の子育てニュース</h1>
    <NewsPreferences region={pref?.region_key ?? null} enabled={pref?.enabled ?? false} version={pref?.updated_at ?? null} />
    <Link href="/settings#settings-notification" className="min-h-11 py-3 text-sm text-primary">端末の通知設定</Link>
    {region && <>
      <h2 className="font-semibold">{region.label}の記事</h2>
      <NewsRefresh key={region.key} />
      {failed > 0 && <p role="alert">{failed === sources.length ? "すべての配信元で取得に失敗しました。" : "一部の配信元で取得に失敗しました。"}取得済みの記事は引き続き読めます。</p>}
      <ul className="text-xs text-muted-foreground" aria-label="配信元の取得状況">{sources.map(source => {
        const s = statuses.find(s => s.source_key === source.key)
        const running = s?.claimed_at && Date.parse(s.claimed_at) > now.getTime() - 30_000 && (!s.last_success_at || s.claimed_at > s.last_success_at) && (!s.last_error_at || s.claimed_at > s.last_error_at)
        return <li key={source.key} className="py-2"><a className="underline" href={source.feed} target="_blank" rel="noreferrer">{source.publisher}</a>：{running ? "取得中。少し待って一覧を読み直してください。" : s?.last_success_at ? `最終成功 ${formatTime(s.last_success_at)}（日本時間）` : "未取得。記事を更新して確認できます。"}{s?.last_success_at && Date.parse(s.last_success_at) < now.getTime() - 25 * 3600000 ? " 古いキャッシュです。公式サイトも確認してください。" : ""}</li>
      })}</ul>
      <Link className="min-h-11 py-3 text-sm text-primary" href={all ? "/news" : "/news?all=1"}>{all ? "子どもの年齢に合わせて表示" : "年齢の絞り込みを外す"}</Link>
      <p className="text-xs text-muted-foreground">取得済みの最新100件。掲載日は開催日ではありません。年齢は見出しの語句からの目安です。年齢が不明な記事や子どもの年齢が未設定の場合は絞り込みません。対象年齢・日程は必ず原文を確認してください。子どもの情報を配信元やAIへ送信しません。</p>
      {!visible.length && succeeded && <p>{articles.length ? "この年齢に合う記事はありません。絞り込みを外して確認できます。" : "取得できましたが、掲載記事はありません。"}</p>}
      <ul className="flex flex-col gap-3">{visible.filter(a => canonicalNewsUrl(a.url, region) !== null).map(a => <li key={a.id} className="glass rounded-2xl p-4">
        <p className="mb-2 text-xs text-muted-foreground">{a.published_at ? `掲載日 ${toJstDateString(a.published_at)}` : "掲載日不明（新着通知の対象外）"}・{newsSource(a.source_key)?.publisher ?? region.publisher}</p>
        {a.ai_summary && <p className="mb-2 text-sm">要点（AI補助）: {a.ai_summary}</p>}
        <a href={a.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center break-words text-sm underline">{a.title}</a>
      </li>)}</ul>
    </>}
  </div>
}
