import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"
import {
  aggregateFeedings,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
} from "@/lib/domain/baby-log-aggregation"
import { generateBabyReport } from "@/lib/pdf/baby-report"

/**
 * PDF 生成は DB 2 クエリ + pdfmake のフォント埋め込み + レイアウトを直列で行うため、
 * Vercel の既定タイムアウト（設定しなければプラットフォーム既定に委ねられる）を
 * 超えて無言で中断されうる。同じ理由で `receipt-ocr/route.ts` も 30 を明示している。
 * 「複数の重い処理を呼ぶ Route Handler には maxDuration を明示する」の適用。
 */
export const maxDuration = 30

const VALID_PERIODS = ["1week", "1month", "3months"] as const
type ValidPeriod = (typeof VALID_PERIODS)[number]

/**
 * baby_logs の取得上限。3ヶ月 × 1日50件でも 4500 件ゆえ通常は到達しないが、
 * 到達した場合に**無音で切り詰めない**ことがこの定数の存在理由じゃ。
 *
 * 実際には `LOG_FETCH_LIMIT + 1` 件を要求する。ちょうど上限件数だった場合と
 * 「上限で切り詰められた」場合を `length >= LIMIT` では弁別できぬため
 * （ちょうど 5000 件のデータが偽陽性になる）、1 件多く引いて溢れたかを見る。
 */
const LOG_FETCH_LIMIT = 5000

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
    return new Response("Unauthorized", { status: 401 })
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

  // データ取得（並列）
  const [{ data: household, error: householdError }, { data: logs, error: logsError }] =
    await Promise.all([
      supabase
        .from("households")
        .select("baby_name, baby_birth_date")
        .eq("id", householdId)
        .single(),
      // 期間窓は logged_at のみで決まる（全 log_type が単一時刻の点イベント）。
      supabase
        .from("baby_logs")
        .select(
          "log_type, logged_at, feeding_type, amount_ml, diaper_type, temperature, weight_g, height_cm",
        )
        .eq("household_id", householdId)
        .gte("logged_at", `${startDate}T00:00:00+09:00`)
        .lt("logged_at", `${shiftYmd(endDate, 1)}T00:00:00+09:00`)
        .order("logged_at", { ascending: true })
        .limit(LOG_FETCH_LIMIT + 1),
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
  if (logsError) {
    logSupabaseError("baby-report", "baby_logs lookup failed", logsError, {
      householdId,
      period,
      startDate,
      endDate,
    })
  }

  if (householdError || logsError) {
    return new Response("Data fetch failed", { status: 500 })
  }

  const babyName = household?.baby_name || "未設定"
  const birthDate = household?.baby_birth_date || null
  const age = birthDate ? calculateAge(birthDate, today) : "---"

  // 上限到達の検知（fail-loud）。1 件多く引いてあるため、溢れていれば確実に切り詰め。
  const fetched = logs ?? []
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
      // クライアントが「全件ではない」旨を即座に警告できるようにする。
      // 200 で返す以上、ヘッダが無ければ利用者は切り詰めに気づけない。
      ...(truncated ? { "X-Report-Truncated": "1" } : {}),
    },
  })
}
