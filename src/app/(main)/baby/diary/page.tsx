import Link from "next/link"
import { ArrowLeft } from "lucide-react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BabyDiaryView } from "@/components/baby/baby-diary-view"
import { DIARY_PAGE_SIZE } from "@/lib/domain/baby-diary"

// 日記一覧で取得するカラム（BabyDiaryData と対応・baby-diary-view.tsx と一致させる）。
const BABY_DIARY_COLUMNS = "id, diary_date, content, updated_at"

export default async function BabyDiaryPage() {
  const result = await getAuthContext()
  if (result.error !== null) return null
  const { supabase, householdId } = result.context

  // 育児日記（1日1本）を日付降順で1ページ目のみ取得。
  // ページネーション掟: diary_date は UNIQUE(household_id, diary_date) ゆえ
  // 世帯内で一意 — order("diary_date", desc) だけで全順序が決定化される。
  // 追ページはクライアント側（BabyDiaryView）が受領件数をオフセットに range で
  // 取得し、終端は「返却0件」でのみ判定する。
  const { data: diaries, error: diariesError } = await supabase
    .from("baby_diaries")
    .select(BABY_DIARY_COLUMNS)
    .eq("household_id", householdId)
    .order("diary_date", { ascending: false })
    .range(0, DIARY_PAGE_SIZE - 1)

  if (diariesError) {
    logSupabaseError("baby", "diaries lookup failed", diariesError, {
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
        <h1 className="text-lg font-semibold">育児日記</h1>
      </div>

      <BabyDiaryView initialDiaries={diaries ?? []} householdId={householdId} />
    </div>
  )
}
