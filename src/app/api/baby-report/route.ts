import type { PostgrestError } from "@supabase/supabase-js"
import { getAuthContext, type AuthContext } from "@/lib/supabase/auth-context"
// 401 はログインし直せば直る時だけ（受診当日に待てば直る障害でログアウトへ誘導せぬ）
import { AUTH_DENIAL_HTTP_STATUS } from "@/lib/auth/auth-denial-status"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { jstDayStartIso, todayJstString, shiftYmd } from "@/lib/utils/date-jst"
import {
  aggregateFeedings,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
  type AggregationLogInput,
} from "@/lib/domain/baby-log-aggregation"
import { generateBabyReport } from "@/lib/pdf/baby-report"
import {
  withBabyLogKeyset,
  type BabyLogKeysetCursor,
} from "@/lib/domain/baby-log-keyset"

/**
 * PDF 生成は DB クエリ（baby_logs はページ取得ゆえ最大 6 往復）+ pdfmake のフォント
 * 埋め込み + レイアウトを直列で行うため、Vercel の既定タイムアウト（設定しなければ
 * プラットフォーム既定に委ねられる）を超えて無言で中断されうる。ゆえに 30 を明示する。
 * 「複数の重い処理を呼ぶ Route Handler には maxDuration を明示する」の適用。
 */
export const maxDuration = 30

const VALID_PERIODS = ["1week", "1month", "3months"] as const
type ValidPeriod = (typeof VALID_PERIODS)[number]

/**
 * baby_logs の取得上限。3ヶ月 × 1日50件でも 4500 件ゆえ通常は到達しないが、
 * 到達した場合に**無音で切り詰めない**ことがこの定数の存在理由じゃ。
 *
 * 実際には累計 `LOG_FETCH_LIMIT + 1` 件まで引く。ちょうど上限件数だった場合と
 * 「上限で切り詰められた」場合を `length >= LIMIT` では弁別できぬため
 * （ちょうど 5000 件のデータが偽陽性になる）、1 件多く引いて溢れたかを見る。
 */
const LOG_FETCH_LIMIT = 5000

/**
 * 1 要求で引く行数の上限。PostgREST は 1 応答を db-max-rows（supabase/config.toml と
 * hosted の既定で 1000）で**黙って**丸める。かつては `.limit(5001)` の単発で引いており、
 * 実際には最古の 1000 行しか返らず、昇順ゆえ**受診直前の数週間が欠けた**上、
 * `length > 5000` の検知も構造上発火せなんだ（P1-07）。
 *
 * ⚠️ max_rows を引き上げて直してはならぬ（全 API の防御を緩めることになる）。
 */
const PAGE_SIZE = 1000

// id は集計には使わぬが、ページの cursor（logged_at, id）に要る。
const LOG_COLUMNS =
  "id, log_type, logged_at, feeding_type, amount_ml, diaper_type, temperature, weight_g, height_cm"

type ReportLogRow = AggregationLogInput & { id: string }

type ReportLogsResult =
  | { rows: ReportLogRow[]; error: null }
  | { rows: ReportLogRow[]; error: PostgrestError; page: number }

/**
 * 期間内の baby_logs を (logged_at, id) 昇順のページ取得で集める。
 * keyset 条件（引用符・マイクロ秒を保つ規則）は `@/lib/domain/baby-log-keyset` が正本。
 *
 * 終端は**返却 0 件でのみ**判定する。短いページを終端と見なすと、max_rows が
 * PAGE_SIZE より小さい環境（設定の変更・プラン差）でまた無音に切り詰める。
 * 累計が `LOG_FETCH_LIMIT + 1` に届いたら打ち切り、呼び出し側の truncated 経路へ流す。
 * どのページでも error が出たら、それまでの行は使わせず error を返す（部分 PDF を作らぬ）。
 */
async function fetchReportLogs(
  supabase: AuthContext["supabase"],
  householdId: string,
  fromInclusive: string,
  toExclusive: string,
): Promise<ReportLogsResult> {
  const rows: ReportLogRow[] = []
  let cursor: BabyLogKeysetCursor | null = null

  for (let page = 1; rows.length < LOG_FETCH_LIMIT + 1; page++) {
    const want = Math.min(PAGE_SIZE, LOG_FETCH_LIMIT + 1 - rows.length)
    // 期間窓は logged_at のみで決まる（全 log_type が単一時刻の点イベント）。
    const { data, error } = await withBabyLogKeyset(
      supabase
        .from("baby_logs")
        .select(LOG_COLUMNS)
        .eq("household_id", householdId)
        .gte("logged_at", fromInclusive)
        .lt("logged_at", toExclusive),
      cursor,
      "asc",
    )
      .order("logged_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(want)

    if (error) return { rows, error, page }
    if (data.length === 0) break

    rows.push(...data)
    // 型注釈は循環推論（data → cursor → withBabyLogKeyset → data）を断つためじゃ。
    const last: ReportLogRow = data[data.length - 1]
    cursor = { loggedAt: last.logged_at, id: last.id }
  }

  return { rows, error: null }
}

function getStartDate(period: ValidPeriod, today: string): string {
  switch (period) {
    case "1month":
      return shiftYmd(today, -30)
    case "3months":
      return shiftYmd(today, -90)
    default:
      return shiftYmd(today, -7)
  }
}

export async function GET(request: Request) {
  const result = await getAuthContext()
  if (result.error !== null) {
    // lookup-failed の真因は getAuthContext が構造化ログに残し済み。
    return new Response(result.error, {
      status: AUTH_DENIAL_HTTP_STATUS[result.reason],
    })
  }
  const { supabase, householdId } = result.context

  // 期間パラメータ
  const { searchParams } = new URL(request.url)
  const period = searchParams.get("period") ?? "1week"
  if (!VALID_PERIODS.includes(period as ValidPeriod)) {
    return new Response("Invalid period", { status: 400 })
  }

  const today = todayJstString()
  const startDate = getStartDate(period as ValidPeriod, today)
  const endDate = today

  // データ取得（並列）。baby_logs は max_rows を跨ぐためページ取得する（fetchReportLogs）。
  const [{ data: household, error: householdError }, logsResult] = await Promise.all([
    supabase
      .from("households")
      .select("baby_name, baby_birth_date")
      .eq("id", householdId)
      .single(),
    fetchReportLogs(
      supabase,
      householdId,
      jstDayStartIso(startDate),
      jstDayStartIso(shiftYmd(endDate, 1)),
    ),
  ])

  // Supabase の error は class Error 非継承の plain object ゆえ、`String(err)` では
  // `[object Object]` になって真因が消える。500 に潰す前に必ず構造化ログへ残す
  // （小児科の受診当日に出せなかった時、ログだけが手掛かりになる）。
  if (householdError) {
    logSupabaseError("baby-report", "household lookup failed", householdError, {
      householdId,
      period,
    })
  }
  if (logsResult.error) {
    logSupabaseError("baby-report", "baby_logs lookup failed", logsResult.error, {
      householdId,
      period,
      startDate,
      endDate,
      // 何枚目で落ちたか（途中までは引けていたか）も残す
      page: logsResult.page,
      fetchedSoFar: logsResult.rows.length,
    })
  }

  if (householdError || logsResult.error) {
    return new Response("Data fetch failed", { status: 500 })
  }

  const babyName = household?.baby_name || "未設定"
  const birthDate = household?.baby_birth_date || null
  const age = birthDate ? calculateAge(birthDate, today) : "---"

  // 上限到達の検知（fail-loud）。累計で 1 件多く引いてあるため、溢れていれば確実に切り詰め。
  const fetched = logsResult.rows
  const truncated = fetched.length > LOG_FETCH_LIMIT
  const allLogs = truncated ? fetched.slice(0, LOG_FETCH_LIMIT) : fetched

  if (truncated) {
    // 「出せた PDF が実は全件ではない」は、受診の判断材料そのものを歪める。
    // サーバログ・レスポンスヘッダ・PDF 本文の三重で分かる形にする。
    console.error("[baby-report] 取得上限に達したためレポートは全件ではありません", {
      householdId,
      period,
      startDate,
      endDate,
      limit: LOG_FETCH_LIMIT,
    })
  }
  const feedings = aggregateFeedings(allLogs, startDate, endDate)
  const diapers = aggregateDiapers(allLogs, startDate, endDate)
  const temperatures = extractTemperatures(allLogs, startDate, endDate)
  const growth = extractGrowth(allLogs, startDate, endDate)

  // PDF 生成
  const pdfBuffer = await generateBabyReport({
    babyName,
    birthDate: birthDate || "---",
    age,
    startDate,
    endDate,
    feedings,
    diapers,
    temperatures,
    growth,
    truncated,
  })

  const filename = `baby-log_${startDate}_${endDate}.pdf`
  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // 個人データ（受診用の集計）。JSON 書き出しと同じく中間キャッシュ・端末キャッシュに残さぬ
      "Cache-Control": "no-store",
      // クライアントが「全件ではない」旨を即座に警告できるようにする。
      // 200 で返す以上、ヘッダが無ければ利用者は切り詰めに気づけない。
      ...(truncated ? { "X-Report-Truncated": "1" } : {}),
    },
  })
}
