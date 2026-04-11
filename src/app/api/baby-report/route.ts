import { getAuthContext } from "@/lib/supabase/auth-context"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"
import {
  aggregateFeedings,
  aggregateSleep,
  aggregateDiapers,
  extractTemperatures,
  extractGrowth,
  calculateAge,
} from "@/lib/domain/baby-log-aggregation"
import { generateBabyReport } from "@/lib/pdf/baby-report"

const VALID_PERIODS = ["1week", "1month", "3months"] as const
type ValidPeriod = (typeof VALID_PERIODS)[number]

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
      supabase
        .from("baby_logs")
        .select(
          "log_type, logged_at, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm",
        )
        .eq("household_id", householdId)
        .gte("logged_at", `${startDate}T00:00:00+09:00`)
        .lt("logged_at", `${shiftYmd(endDate, 1)}T00:00:00+09:00`)
        .order("logged_at", { ascending: true })
        .limit(5000),
    ])

  if (householdError || logsError) {
    return new Response("Data fetch failed", { status: 500 })
  }

  const babyName = household?.baby_name || "未設定"
  const birthDate = household?.baby_birth_date || null
  const age = birthDate ? calculateAge(birthDate, today) : "---"

  // 純関数で集計
  const allLogs = logs ?? []
  const feedings = aggregateFeedings(allLogs, startDate, endDate)
  const sleep = aggregateSleep(allLogs, startDate, endDate)
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
    sleep,
    diapers,
    temperatures,
    growth,
  })

  const filename = `baby-log_${startDate}_${endDate}.pdf`
  return new Response(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  })
}
