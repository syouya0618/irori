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
  encodeLogsAfter,
  exportFilename,
  isExportPeriod,
  parseDiariesAfter,
  parseLogsAfter,
  parsePinnedRange,
  resolveExportRange,
  EXPORT_DIARIES_BYTE_BUDGET,
  EXPORT_LOGS_BYTE_BUDGET,
  type ExportDiaryRow,
  type ExportPartInfo,
} from "@/lib/domain/baby-export"
import { diariesToCsv, logsToCsv } from "@/lib/domain/baby-export-csv"
import type { BabyLogData } from "@/lib/types/baby"
import {
  withBabyLogKeyset,
  type BabyLogKeysetCursor,
} from "@/lib/domain/baby-log-keyset"

/**
 * 育児ログ・日記の機械可読エクスポート（JSON / CSV。機能 D・2026-10-27 大型更新 E2）。
 *
 * 認可は PDF（/api/baby-report）と同じ: getAuthContext（未認証 401 / 未承認・世帯なし 403 /
 * 一過性の取得失敗 503）と RLS。世帯の境界は RLS と `household_id` の明示フィルタの二重。
 * 取得は keyset のページ取得（PostgREST の max_rows を跨ぐ）。上限（件数、または応答本文の
 * バイト予算 — Vercel の応答上限 4.5MB の手前）に達したら `complete: false` を本文と
 * ヘッダ（X-Export-Truncated）の両方で示し、全件と偽らぬ。本文は compact JSON
 * （整形の空白で予算を食わぬ）。
 *
 * ## 分割回収（E2）
 * 上限に達した時は、続きの位置（`next.logs_after` / `next.diaries_after`、ヘッダ
 * `X-Export-Next-Logs-After` / `X-Export-Next-Diaries-After`）を返す。続きの要求は
 * `logs_after` / `diaries_after` と、最初に決まった範囲 `from` / `to` を**そのまま**送る
 * （続きの時に「今日」を引き直さぬ）。無制限のメモリや max_rows の引き上げでは解かぬ —
 * 1 回の応答は従来どおり予算の内に収め、利用者が「続きを書き出す」で次の部分を取る。
 * 各部分は別の問い合わせゆえ、同時点の snapshot ではない（本文の consistency_note）。
 *
 * ## CSV
 * `format=csv&table=logs|diaries`（1 ファイル = 1 表）。セルの規則は baby-export-csv.ts。
 *
 * 公開 URL の発行・自動送信・取り込み（復元）はしない。応答は no-store（個人データ）。
 */
export const maxDuration = 30

/** 1 要求で引く行数の上限（PostgREST の max_rows と同じ。超えて要求しても黙って丸められる） */
const PAGE_SIZE = 1000
/**
 * 1 回の書き出しに含める記録の件数上限。実際にはバイト予算（EXPORT_LOGS_BYTE_BUDGET）が先に効く
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
  startAfter: BabyLogKeysetCursor | null,
): Promise<PagedResult<BabyLogData>> {
  const rows: BabyLogData[] = []
  // keyset 条件（引用符・マイクロ秒を保つ規則）は @/lib/domain/baby-log-keyset が正本
  let cursor: BabyLogKeysetCursor | null = startAfter
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
  startAfter: string | null,
): Promise<PagedResult<ExportDiaryRow>> {
  const rows: ExportDiaryRow[] = []
  // diary_date は世帯内で一意（UNIQUE）ゆえ、日付だけの keyset で全順序になる
  let after: string | null = startAfter
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

/** この表は取り終えておる（続きの要求で "end" が来た・CSV の別の表） */
function emptyDone<T>(): PagedResult<T> {
  return { rows: [], error: null, truncated: false }
}

function headerValue(value: string): string {
  // ヘッダは ASCII に限る（表記のまま運ぶ値を壊さぬよう URI 符号化）
  return encodeURIComponent(value)
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
  const format = searchParams.get("format") ?? "json"
  if (format !== "json" && format !== "csv") {
    return new Response("Invalid format", { status: 400 })
  }
  const tableParam = searchParams.get("table")
  if (format === "csv" && tableParam !== "logs" && tableParam !== "diaries") {
    return new Response("Invalid table", { status: 400 })
  }
  const table = format === "csv" ? (tableParam as "logs" | "diaries") : null

  const logsAfterParsed = parseLogsAfter(searchParams.get("logs_after"))
  const diariesAfterParsed = parseDiariesAfter(searchParams.get("diaries_after"))
  if (!logsAfterParsed.ok || !diariesAfterParsed.ok) {
    return new Response("Invalid cursor", { status: 400 })
  }
  const continuation =
    searchParams.has("logs_after") || searchParams.has("diaries_after")
  const partRaw = Number(searchParams.get("part") ?? "1")
  const part = Number.isInteger(partRaw) && partRaw >= 1 && partRaw <= 9999 ? partRaw : 1

  const today = todayJstString()
  let from: string | null
  let to: string
  if (continuation) {
    // 続きは最初に決まった範囲を固定して送らせる（「今日」を引き直さぬ）
    const pinned = parsePinnedRange(searchParams.get("from"), searchParams.get("to"), today)
    if (pinned === null) return new Response("Invalid range", { status: 400 })
    from = pinned.from
    to = pinned.to
  } else {
    ;({ from, to } = resolveExportRange(periodParam, today))
  }
  const fromInclusive = from ? jstDayStartIso(from) : null
  const toExclusive = jstDayStartIso(shiftYmd(to, 1))

  const logsAfter = logsAfterParsed.value
  const diariesAfter = diariesAfterParsed.value
  const wantLogs = table === null || table === "logs"
  const wantDiaries = table === null || table === "diaries"
  const wantHousehold = format === "json"
  const wantMembers = format === "json" || table === "logs"

  const [householdResult, membersResult, logsResult, diariesResult] = await Promise.all([
    wantHousehold
      ? supabase
          .from("households")
          .select("baby_name, baby_birth_date")
          .eq("id", householdId)
          .single()
      : Promise.resolve({ data: null, error: null }),
    wantMembers
      ? supabase.from("profiles").select("id, display_name").eq("household_id", householdId)
      : Promise.resolve({ data: [], error: null }),
    wantLogs && logsAfter !== "end"
      ? fetchLogs(supabase, householdId, fromInclusive, toExclusive, logsAfter)
      : Promise.resolve(emptyDone<BabyLogData>()),
    wantDiaries && diariesAfter !== "end"
      ? fetchDiaries(supabase, householdId, from, to, diariesAfter)
      : Promise.resolve(emptyDone<ExportDiaryRow>()),
  ])
  const { data: household, error: householdError } = householdResult
  const { data: members, error: membersError } = membersResult

  const logContext = { householdId, period: periodParam, format, table, continuation, part }
  if (householdError) {
    logSupabaseError("baby-export", "household lookup failed", householdError, logContext)
  }
  if (membersError) {
    logSupabaseError("baby-export", "members lookup failed", membersError, logContext)
  }
  if (logsResult.error) {
    logSupabaseError("baby-export", "baby_logs lookup failed", logsResult.error, {
      ...logContext,
      page: logsResult.page,
      fetchedSoFar: logsResult.rows.length,
    })
  }
  if (diariesResult.error) {
    logSupabaseError("baby-export", "baby_diaries lookup failed", diariesResult.error, {
      ...logContext,
      page: diariesResult.page,
      fetchedSoFar: diariesResult.rows.length,
    })
  }
  // 一部でも読めなかったら出さぬ（欠けた書き出しを「全件」として渡さぬ）
  if (householdError || membersError || logsResult.error || diariesResult.error) {
    return new Response("Data fetch failed", { status: 500 })
  }

  // 1 行だけで予算を超えた（進めぬ）。同じ位置の続きを返すと永久に回るゆえ失敗とする
  if (
    (logsResult.truncated && logsResult.rows.length === 0) ||
    (diariesResult.truncated && diariesResult.rows.length === 0)
  ) {
    console.error("[baby-export] 1 件が応答の予算を超えるため書き出せません", logContext)
    return new Response("Row too large", { status: 500 })
  }

  const truncated = logsResult.truncated || diariesResult.truncated
  // 続きの位置は「この部分に実際に含めた最後の行」（予算でページの途中で止まることがある）
  const lastLog = logsResult.rows.at(-1)
  const lastDiary = diariesResult.rows.at(-1)
  const nextLogs = logsResult.truncated && lastLog
    ? encodeLogsAfter({ loggedAt: lastLog.logged_at, id: lastLog.id })
    : "end"
  const nextDiaries = diariesResult.truncated && lastDiary ? lastDiary.diary_date : "end"
  const partInfo: ExportPartInfo = {
    continuation,
    logs_after:
      logsAfter === null ? null : logsAfter === "end" ? "end" : encodeLogsAfter(logsAfter),
    diaries_after: diariesAfter,
    next: truncated ? { logs_after: nextLogs, diaries_after: nextDiaries } : null,
    is_last: !truncated,
  }
  // 分けた書き出し（続きがある・続きの部分）か。ファイル名に部の番号を付ける（CSV ではこれが唯一の印）
  const split = truncated || continuation

  if (truncated) {
    console.error("[baby-export] 取得上限に達したため、この書き出しは一部です（続きあり）", {
      ...logContext,
      logs: logsResult.rows.length,
      diaries: diariesResult.rows.length,
      logLimit: LOG_FETCH_LIMIT,
      diaryLimit: DIARY_FETCH_LIMIT,
      logBytesBudget: EXPORT_LOGS_BYTE_BUDGET,
      diaryBytesBudget: EXPORT_DIARIES_BYTE_BUDGET,
    })
  }

  const exportedAt = new Date().toISOString()
  const commonHeaders: Record<string, string> = {
    // 個人データ。中間キャッシュに残さぬ
    "Cache-Control": "no-store",
    "X-Export-From": from ?? "all",
    "X-Export-To": to,
    "X-Export-Fetched-At": exportedAt,
    "X-Export-Count-Logs": String(logsResult.rows.length),
    "X-Export-Count-Diaries": String(diariesResult.rows.length),
    ...(truncated
      ? {
          "X-Export-Truncated": "1",
          "X-Export-Next-Logs-After": headerValue(nextLogs),
          "X-Export-Next-Diaries-After": headerValue(nextDiaries),
        }
      : {}),
  }
  const memberRows = (members ?? []) as { id: string; display_name: string | null }[]

  if (format === "csv") {
    const csv =
      table === "logs"
        ? logsToCsv(
            logsResult.rows,
            new Map(memberRows.map((m) => [m.id, m.display_name ?? ""])),
          )
        : diariesToCsv(diariesResult.rows)
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename(from, to, { ext: "csv", table: table ?? "logs", part, split })}"`,
        ...commonHeaders,
      },
    })
  }

  const document = buildExportDocument({
    exportedAt,
    period: periodParam,
    from,
    to,
    household: {
      baby_name: household?.baby_name ?? null,
      baby_birth_date: household?.baby_birth_date ?? null,
    },
    members: memberRows.map((m) => ({ id: m.id, display_name: m.display_name ?? "" })),
    logs: logsResult.rows,
    diaries: diariesResult.rows,
    truncated: { logs: logsResult.truncated, diaries: diariesResult.truncated },
    part: partInfo,
  })

  // compact JSON（整形の空白で応答上限を食わぬ）
  return new Response(JSON.stringify(document), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFilename(from, to, { part, split })}"`,
      ...commonHeaders,
    },
  })
}
