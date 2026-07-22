import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDiaryView } from "@/components/baby/baby-diary-view"
import { DIARY_PAGE_SIZE } from "@/lib/domain/baby-diary"

// 日記一覧で取得するカラム（BabyLogData と対応）。
const BABY_LOG_COLUMNS =
  "id, log_type, logged_at, logged_by, feeding_type, amount_ml, diaper_type, ended_at, temperature, weight_g, height_cm, duration_min, duration_sec, memo, created_at"

export default async function BabyDiaryPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, householdId, userId } = result.context

  // メモログを JST 日付降順で1ページ目のみ取得。
  // ページネーション掟: order は logged_at 降順 + id を最終ソートキー（一意）にして
  // 全順序を決定化する。追ページはクライアント側（BabyDiaryView）が受領件数を
  // オフセットに range で取得し、終端は「返却0件」でのみ判定する。
  const { data: logs, error: logsError } = await supabase
    .from("baby_logs")
    .select(BABY_LOG_COLUMNS)
    .eq("household_id", householdId)
    .eq("log_type", "memo")
    .order("logged_at", { ascending: false })
    .order("id")
    .range(0, DIARY_PAGE_SIZE - 1)

  if (logsError) {
    logSupabaseError("baby", "diary logs lookup failed", logsError, {
      householdId,
    })
  }

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
        <h1 className="text-lg font-semibold">日記</h1>
      </div>

      <BabyDiaryView
        initialLogs={logs ?? []}
        householdId={householdId}
        userId={userId}
      />
    </div>
  )
}
