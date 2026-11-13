import type { ReactNode } from "react"
import { getAuthContext } from "@/lib/supabase/auth-context"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { ChoresHeader } from "@/components/chores/shared/chores-header"
import { KeepLastGood } from "@/components/chores/shared/keep-last-good"
import { CleaningView } from "@/components/chores/cleaning/cleaning-view"
import {
  CLEANING_LOG_COLUMNS,
  CLEANING_LOG_LIMIT,
  CLEANING_ROUTINE_COLUMNS,
  CLEANING_ROUTINE_LIMIT,
  parseCleaningLog,
  parseCleaningMarksRow,
  parseCleaningRoutine,
} from "@/lib/domain/cleaning"
import type { CleaningLog, CleaningMarks, CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import { todayJstString } from "@/lib/utils/date-jst"

/**
 * 掃除ルーティーン（/chores/cleaning）。
 *
 * 定義（cleaning_routines）と、有効な履歴の要約（cleaning_log_marks = 前回実施日・最後に閉じた回）
 * をサーバーで読み、期限の計算は画面（純関数）が行う。前回実施日の写しはどこにも持たぬ。
 *
 * 読めなかった時の倒し方:
 * - 定義・要約が読めぬ → 画面全体の失敗（`KeepLastGood` へ理由を渡す）。「項目なし」「未記録」と
 *   偽らぬ。初回の表示なら error boundary、表示済みの画面の取り直し（定期・復帰時）なら直前の
 *   内容を保って「更新できませんでした」を出す。**ここから throw せぬこと** — 取り直しの失敗で
 *   error boundary が画面を置き換え、入力中のフォームが消える
 * - 履歴の一覧だけ読めぬ → 旗を渡し、履歴の区画だけ「読み込めませんでした」にする
 *   （期限の計算は要約で足りるゆえ、画面全体は倒さぬ）
 *
 * 履歴の一覧は世帯全体の直近 `CLEANING_LOG_LIMIT` 件だけじゃ（年 1 回の項目の前回の記録は、ここに
 * 入っておらぬことがある）。打ち切った時は旗（`historyTruncated`）を渡し、項目の詳細がその項目の
 * 続きを `loadCleaningHistory` で読み足す（外れた記録にも訂正・取り消しの釦が出る）。
 *
 * 認証・承認・世帯は (main)/layout が遷移で受ける。子ども閲覧招待（viewer）は layout が
 * /shared へ送り、RLS も SELECT を返さぬ。
 */
export default async function CleaningPage() {
  const { context } = await getAuthContext()
  if (!context) return null
  const { supabase, userId, householdId } = context
  const today = todayJstString()
  const scope = `cleaning:${userId}:${householdId}`

  const [
    { data: routineRows, error: routinesError },
    { data: markRows, error: marksError },
    { data: logRows, error: logsError },
  ] = await Promise.all([
    supabase
      .from("cleaning_routines")
      .select(CLEANING_ROUTINE_COLUMNS)
      .eq("household_id", householdId)
      .order("archived", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CLEANING_ROUTINE_LIMIT + 1),
    supabase.rpc("cleaning_log_marks", {}),
    supabase
      .from("cleaning_logs")
      .select(CLEANING_LOG_COLUMNS)
      .eq("household_id", householdId)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(CLEANING_LOG_LIMIT + 1),
  ])

  if (routinesError) {
    logSupabaseError("cleaning", "routines lookup failed", routinesError, { userId })
    return <CleaningShell scope={scope} failure="掃除の項目を取得できませんでした" />
  }
  if (marksError) {
    logSupabaseError("cleaning", "marks lookup failed", marksError, { userId })
    return <CleaningShell scope={scope} failure="掃除の履歴の要約を取得できませんでした" />
  }
  if (logsError) logSupabaseError("cleaning", "logs lookup failed", logsError, { userId })

  const routines: CleaningRoutine[] = []
  let unreadableRoutines = 0
  const allRoutineRows = routineRows ?? []
  for (const row of allRoutineRows.slice(0, CLEANING_ROUTINE_LIMIT)) {
    const routine = parseCleaningRoutine(row)
    if (routine) routines.push(routine)
    else unreadableRoutines += 1
  }

  const marks: Record<string, CleaningMarks> = {}
  for (const row of markRows ?? []) {
    const parsed = parseCleaningMarksRow(row)
    // 読めぬ要約を「履歴なし」と見なすと、実施済みの項目が「未記録」に化ける
    if (!parsed) return <CleaningShell scope={scope} failure="掃除の履歴の要約を読み取れませんでした" />
    marks[parsed.routineId] = parsed.marks
  }

  const logs: CleaningLog[] = []
  const allLogRows = logsError ? [] : (logRows ?? [])
  for (const row of allLogRows.slice(0, CLEANING_LOG_LIMIT)) {
    const log = parseCleaningLog(row)
    if (log) logs.push(log)
  }

  return (
    <CleaningShell scope={scope}>
      <CleaningView
        // 持ち主（利用者・世帯）が替われば、画面の状態と保存の手順ごと作り直す
        key={`${userId}:${householdId}`}
        owner={{ userId, householdId }}
        today={today}
        routines={routines}
        marks={marks}
        logs={logs}
        unreadableRoutines={unreadableRoutines}
        routinesTruncated={allRoutineRows.length > CLEANING_ROUTINE_LIMIT}
        historyFailed={Boolean(logsError)}
        historyTruncated={allLogRows.length > CLEANING_LOG_LIMIT}
      />
    </CleaningShell>
  )
}

/**
 * 画面の殻。読めた時も読めなんだ時も同じ形で返す（`KeepLastGood` が同じ位置に居続けることで、
 * 取り直しの失敗の間も直前の内容と入力中の state が残る）。
 */
function CleaningShell({ scope, failure, children }: { scope: string; failure?: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 px-4 pt-12 pb-8">
      <ChoresHeader title="掃除" description="今日・今週やることと、前回からの日数が分かります。" />
      <KeepLastGood scope={scope} failure={failure}>
        {children}
      </KeepLastGood>
    </div>
  )
}
