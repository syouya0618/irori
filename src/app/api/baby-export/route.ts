import type { PostgrestError } from "@supabase/supabase-js"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
// 拒否理由 → HTTP status は PDF・Google 同期と同じ 1 表（401 はログインし直せば直る時だけ）
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { jstDayStartIso, todayJstString, shiftYmd } from "@/lib/utils/date-jst"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import {
  buildExportDocument,
  countWithinByteBudget,
  exportFilename,
  isExportPeriod,
  resolveExportRange,
  EXPORT_DIARIES_BYTE_BUDGET,
  EXPORT_LOGS_BYTE_BUDGET,
  type ExportDiaryRow,
} from "@/lib/domain/baby-export"
import type { BabyLogData } from "@/lib/types/baby"
import {
  withBabyLogKeyset,
  type BabyLogKeysetCursor,
} from "@/lib/domain/baby-log-keyset"

/**
 * 育児ログ・日記の機械可読エクスポート（JSON。機能 D）。
 *
 * 認可は PDF（/api/baby-report）と同じ: getAuthContext（未認証 401 / 未承認・世帯なし 403 /
 * 一過性の取得失敗 503）と RLS。世帯の境界は RLS と `household_id` の明示フィルタの二重。
 * 取得は keyset のページ取得（PostgREST の max_rows を跨ぐ）。上限（件数、または応答本文の
 * バイト予算 — Vercel の応答上限 4.5MB の手前）に達したら `complete: false` を本文と
 * ヘッダ（X-Export-Truncated）の両方で示し、全件と偽らぬ。本文は compact JSON
 * （整形の空白で予算を食わぬ）。
 *
 * 公開 URL の発行・自動送信・取り込み（復元）はしない。応答は no-store（個人データ）。
 */
export const maxDuration = 30

/** 1 要求で引く行数の上限（PostgREST の max_rows と同じ。超えて要求しても黙って丸められる） */
const PAGE_SIZE = 1000
/**
 * 含める記録の件数上限。実際にはバイト予算（EXPORT_LOGS_BYTE_BUDGET）が先に効く
 * （1 行 300〜400 bytes なら 8,000〜10,000 行）。件数は暴走の歯止めとして残す
 */
const LOG_FETCH_LIMIT = 20_000
const DIARY_FETCH_LIMIT = 5_000

type PagedResult<T> =
  | { rows: T[]; error: null; truncated: boolean }
  | { rows: T[]; error: PostgrestError; page: number }

async function fetchLogs(
  supabase: AuthContext["supabase"],
  householdId: string,
  fromInclusive: string | null,
  toExclusive: string,
): Promise<PagedResult<BabyLogData>> {
  const rows: BabyLogData[] = []
  // keyset 条件（引用符・マイクロ秒を保つ規則）は @/lib/domain/baby-log-keyset が正本
  let cursor: BabyLogKeysetCursor | null = null
  let usedBytes = 0
  for (let page = 1; rows.length < LOG_FETCH_LIMIT + 1; page++) {
    const want = Math.min(PAGE_SIZE, LOG_FETCH_LIMIT + 1 - rows.length)
    let base = supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .lt("logged_at", toExclusive)
    if (fromInclusive !== null) base = base.gte("logged_at", fromInclusive)
    const { data, error } = await withBabyLogKeyset(base, cursor, "asc")
      .order("logged_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(want)
    if (error) return { rows, error, page }
    // 終端は返却 0 件でのみ判定する（短いページを終端と見なすと max_rows が小さい環境で切り詰める）
    if (data.length === 0) break
    // 応答本文のバイト予算（Vercel の上限の手前）。入り切らぬ行が出たらそこで止める
    const fit = countWithinByteBudget(data, EXPORT_LOGS_BYTE_BUDGET, usedBytes)
    usedBytes = fit.used
    rows.push(...(data.slice(0, fit.count) as BabyLogData[]))
    if (fit.count < data.length) {
      return { rows, error: null, truncated: true }
    }
    const last = data[data.length - 1] as BabyLogData
    cursor = { loggedAt: last.logged_at, id: last.id }
  }
  const truncated = rows.length > LOG_FETCH_LIMIT
  return { rows: truncated ? rows.slice(0, LOG_FETCH_LIMIT) : rows, error: null, truncated }
}

async function fetchDiaries(
  supabase: AuthContext["supabase"],
  householdId: string,
  fromInclusive: string | null,
  toInclusive: string,
): Promise<PagedResult<ExportDiaryRow>> {
  const rows: ExportDiaryRow[] = []
  // diary_date は世帯内で一意（UNIQUE）ゆえ、日付だけの keyset で全順序になる
  let after: string | null = null
  let usedBytes = 0
  for (let page = 1; rows.length < DIARY_FETCH_LIMIT + 1; page++) {
    const want = Math.min(PAGE_SIZE, DIARY_FETCH_LIMIT + 1 - rows.length)
    let query = supabase
      .from("baby_diaries")
      .select("id, diary_date, content, updated_at")
      .eq("household_id", householdId)
      .lte("diary_date", toInclusive)
    if (fromInclusive !== null) query = query.gte("diary_date", fromInclusive)
    if (after !== null) query = query.gt("diary_date", after)
    const { data, error } = await query.order("diary_date", { ascending: true }).limit(want)
    if (error) return { rows, error, page }
    if (data.length === 0) break
    const fit = countWithinByteBudget(data, EXPORT_DIARIES_BYTE_BUDGET, usedBytes)
    usedBytes = fit.used
    rows.push(...(data.slice(0, fit.count) as ExportDiaryRow[]))
    if (fit.count < data.length) {
      return { rows, error: null, truncated: true }
    }
    after = (data[data.length - 1] as ExportDiaryRow).diary_date
  }
  const truncated = rows.length > DIARY_FETCH_LIMIT
  return { rows: truncated ? rows.slice(0, DIARY_FETCH_LIMIT) : rows, error: null, truncated }
}

export async function GET(request: Request) {
  const result = await getAuthContext()
  if (result.error !== null) {
    return new Response(result.error, { status: AUTH_DENIAL_HTTP_STATUS[result.reason] })
  }
  const { supabase, householdId } = result.context

  const { searchParams } = new URL(request.url)
  const periodParam = searchParams.get("period") ?? "1month"
  if (!isExportPeriod(periodParam)) {
    return new Response("Invalid period", { status: 400 })
  }
  const today = todayJstString()
  const { from, to } = resolveExportRange(periodParam, today)
  const fromInclusive = from ? jstDayStartIso(from) : null
  const toExclusive = jstDayStartIso(shiftYmd(to, 1))

  const [{ data: household, error: householdError }, { data: members, error: membersError }, logsResult, diariesResult] =
    await Promise.all([
      supabase
        .from("households")
        .select("baby_name, baby_birth_date")
        .eq("id", householdId)
        .single(),
      supabase.from("profiles").select("id, display_name").eq("household_id", householdId),
      fetchLogs(supabase, householdId, fromInclusive, toExclusive),
      fetchDiaries(supabase, householdId, from, to),
    ])

  if (householdError) {
    logSupabaseError("baby-export", "household lookup failed", householdError, {
      householdId,
      period: periodParam,
    })
  }
  if (membersError) {
    logSupabaseError("baby-export", "members lookup failed", membersError, {
      householdId,
      period: periodParam,
    })
  }
  if (logsResult.error) {
    logSupabaseError("baby-export", "baby_logs lookup failed", logsResult.error, {
      householdId,
      period: periodParam,
      page: logsResult.page,
      fetchedSoFar: logsResult.rows.length,
    })
  }
  if (diariesResult.error) {
    logSupabaseError("baby-export", "baby_diaries lookup failed", diariesResult.error, {
      householdId,
      period: periodParam,
      page: diariesResult.page,
      fetchedSoFar: diariesResult.rows.length,
    })
  }
  // 一部でも読めなかったら出さぬ（欠けた書き出しを「全件」として渡さぬ）
  if (householdError || membersError || logsResult.error || diariesResult.error) {
    return new Response("Data fetch failed", { status: 500 })
  }

  const truncated = logsResult.truncated || diariesResult.truncated
  if (truncated) {
    console.error("[baby-export] 取得上限に達したため書き出しは全件ではありません", {
      householdId,
      period: periodParam,
      logs: logsResult.rows.length,
      diaries: diariesResult.rows.length,
      logLimit: LOG_FETCH_LIMIT,
      diaryLimit: DIARY_FETCH_LIMIT,
      logBytesBudget: EXPORT_LOGS_BYTE_BUDGET,
      diaryBytesBudget: EXPORT_DIARIES_BYTE_BUDGET,
    })
  }

  const document = buildExportDocument({
    exportedAt: new Date().toISOString(),
    period: periodParam,
    from,
    to,
    household: {
      baby_name: household?.baby_name ?? null,
      baby_birth_date: household?.baby_birth_date ?? null,
    },
    members: (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name ?? "" })),
    logs: logsResult.rows,
    diaries: diariesResult.rows,
    truncated: { logs: logsResult.truncated, diaries: diariesResult.truncated },
  })

  // compact JSON（整形の空白で応答上限を食わぬ）
  return new Response(JSON.stringify(document), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(from, to)}"`,
      // 個人データ。中間キャッシュに残さぬ
      "Cache-Control": "no-store",
      ...(truncated ? { "X-Export-Truncated": "1" } : {}),
    },
  })
}
