import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { getChildContext } from "@/lib/supabase/child-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabySearchForm } from "@/components/baby/baby-search-form"
import { BabySearchResults } from "@/components/baby/baby-search-results"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import {
  SEARCH_PAGE_SIZE,
  logTypeFor,
  parseBabySearchParams,
  toIlikePattern,
  type SearchParamsInput,
} from "@/lib/domain/baby-search"
import { withBabyLogKeyset } from "@/lib/domain/baby-log-keyset"
import { recorderLabelFor, shouldShowRecorder } from "@/lib/domain/recorder-label"
import { jstDayStartIso, shiftYmd, todayJstString } from "@/lib/utils/date-jst"
import type { BabyDiaryData, BabyLogData } from "@/lib/types/baby"

/**
 * 記録を探す（機能 B）。世帯の全履歴（baby_logs のメモ・baby_diaries の本文）を条件で探し、
 * 日付ごとにまとめて、その日の画面（/baby?date=）へ飛べる。
 *
 * - 検索は DB 側（PostgREST）。読み込み済みの一日分を手元で絞るのではない
 * - 世帯の境界は RLS と `household_id` の明示フィルタの二重
 * - 件数は `count: "exact"` で別に数え、ページは (logged_at, id) の keyset で送る
 *   （全件を毎回クライアントへ取らぬ。offset だと取得中の追記で行がずれる）
 * - ILIKE のパターンは escape する（`%` `_` を文字どおりに探す）
 */
export default async function BabySearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>
}) {
  const { supabase, householdId } = await getChildContext()

  const today = todayJstString()
  const query = parseBabySearchParams(await searchParams, today)
  const logType = logTypeFor(query.kind)
  const wantLogs = query.kind !== "diary"
  const wantDiaries = query.kind === "all" || query.kind === "diary"
  const pattern = query.q ? toIlikePattern(query.q) : null

  // ── 記録（baby_logs） ──
  const fromIso = query.from ? jstDayStartIso(query.from) : null
  const toExclusiveIso = query.to ? jstDayStartIso(shiftYmd(query.to, 1)) : null

  function logsBase<Q extends {
    eq(c: string, v: string): Q
    gte(c: string, v: string): Q
    lt(c: string, v: string): Q
    ilike(c: string, v: string): Q
  }>(q: Q): Q {
    let next = q.eq("household_id", householdId)
    if (logType) next = next.eq("log_type", logType)
    if (fromIso) next = next.gte("logged_at", fromIso)
    if (toExclusiveIso) next = next.lt("logged_at", toExclusiveIso)
    if (pattern) next = next.ilike("memo", pattern)
    return next
  }

  function diariesBase<Q extends {
    eq(c: string, v: string): Q
    gte(c: string, v: string): Q
    lte(c: string, v: string): Q
    ilike(c: string, v: string): Q
  }>(q: Q): Q {
    let next = q.eq("household_id", householdId)
    if (query.from) next = next.gte("diary_date", query.from)
    if (query.to) next = next.lte("diary_date", query.to)
    if (pattern) next = next.ilike("content", pattern)
    return next
  }

  const [logsRes, logsCountRes, diariesRes, diariesCountRes, membersRes] = await Promise.all([
    wantLogs
      ? // 新しい順ゆえ「この行より古い」側（keyset の規則は baby-log-keyset が正本）
        withBabyLogKeyset(
          logsBase(supabase.from("baby_logs").select(BABY_LOG_COLUMNS)),
          query.before,
          "desc",
        )
          .order("logged_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(SEARCH_PAGE_SIZE + 1)
      : Promise.resolve({ data: [] as BabyLogData[], error: null }),
    wantLogs
      ? logsBase(supabase.from("baby_logs").select("id", { count: "exact", head: true }))
      : Promise.resolve({ count: 0, error: null }),
    wantDiaries
      ? (query.beforeDate
          ? diariesBase(
              supabase.from("baby_diaries").select("id, diary_date, content, updated_at"),
            ).lt("diary_date", query.beforeDate)
          : diariesBase(
              supabase.from("baby_diaries").select("id, diary_date, content, updated_at"),
            )
        )
          .order("diary_date", { ascending: false })
          .limit(SEARCH_PAGE_SIZE + 1)
      : Promise.resolve({ data: [] as BabyDiaryData[], error: null }),
    wantDiaries
      ? diariesBase(supabase.from("baby_diaries").select("id", { count: "exact", head: true }))
      : Promise.resolve({ count: 0, error: null }),
    supabase.from("profiles").select("id, display_name").eq("household_id", householdId),
  ])

  const context = { householdId, kind: query.kind, hasQuery: query.q !== "" }
  if (logsRes.error) logSupabaseError("baby-search", "logs search failed", logsRes.error, context)
  if (logsCountRes.error) {
    logSupabaseError("baby-search", "logs count failed", logsCountRes.error, context)
  }
  if (diariesRes.error) {
    logSupabaseError("baby-search", "diaries search failed", diariesRes.error, context)
  }
  if (diariesCountRes.error) {
    logSupabaseError("baby-search", "diaries count failed", diariesCountRes.error, context)
  }
  if (membersRes.error) {
    logSupabaseError("baby-search", "members lookup failed", membersRes.error, context)
  }

  const logRows = (logsRes.data ?? []) as BabyLogData[]
  const logs = logRows.slice(0, SEARCH_PAGE_SIZE)
  const nextLogsCursor =
    logRows.length > SEARCH_PAGE_SIZE
      ? { loggedAt: logs[logs.length - 1].logged_at, id: logs[logs.length - 1].id }
      : null
  const diaryRows = (diariesRes.data ?? []) as BabyDiaryData[]
  const diaries = diaryRows.slice(0, SEARCH_PAGE_SIZE)
  const nextDiaryDate =
    diaryRows.length > SEARCH_PAGE_SIZE ? diaries[diaries.length - 1].diary_date : null

  const members = (membersRes.data ?? []).map((m) => ({
    id: m.id,
    displayName: m.display_name ?? "",
  }))
  const recorder = shouldShowRecorder(members)
    ? (loggedBy: string) => recorderLabelFor(members, loggedBy)
    : null

  return (
    <div className="flex flex-col gap-4 px-4 pt-12 pb-8">
      <div className="flex items-center gap-3">
        <Link
          href="/baby"
          aria-label="育児ログに戻る"
          className="glass flex size-11 shrink-0 items-center justify-center rounded-2xl shadow-lg shadow-black/[0.04] text-muted-foreground transition-colors duration-200 hover:text-foreground"
        >
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-lg font-semibold">記録を探す</h1>
      </div>

      <BabySearchForm query={query} today={today} />

      <BabySearchResults
        query={query}
        logs={logs}
        logsTotal={logsCountRes.error ? null : (logsCountRes.count ?? null)}
        nextLogsCursor={nextLogsCursor}
        diaries={diaries}
        diariesTotal={diariesCountRes.error ? null : (diariesCountRes.count ?? null)}
        nextDiaryDate={nextDiaryDate}
        recorderLabelFor={recorder}
        failed={{
          logs: wantLogs && !!logsRes.error,
          diaries: wantDiaries && !!diariesRes.error,
        }}
      />
    </div>
  )
}
