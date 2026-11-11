import type { SupabaseClient } from "@supabase/supabase-js"
import {
  cleaningHubLine,
  failedHubLine,
  garbageHubLine,
  mealsHubLine,
  type ChoresHubLine,
  type ChoresHubSummary,
} from "@/lib/domain/chores-hub"
import {
  CLEANING_ROUTINE_COLUMNS,
  CLEANING_ROUTINE_LIMIT,
  parseCleaningMarksRow,
  parseCleaningRoutine,
} from "@/lib/domain/cleaning"
import type { CleaningMarks, CleaningRoutine } from "@/lib/domain/cleaning-schedule"
import { loadMealContext } from "@/lib/meals/server/context"
import { buildTonightSummary } from "@/lib/meals/server/plan-views"
import { loadGarbagePage } from "@/lib/supabase/garbage-overview-query"
import { logSupabaseError } from "@/lib/supabase/log-error"
import type { Database } from "@/lib/types/database"

/**
 * 家事ハブ（/chores）の「今日の要約」の読み取り。
 *
 * **サーバー専用**（Server Component から呼ぶ）。献立の読み取り（`@/lib/meals/server/*`）が食材辞書と
 * レシピのカタログを import するゆえ、Client Component・育児トップ（/baby）・(main)/layout から
 * 値 import せぬこと（`src/lib/domain/__tests__/chores-bundle-boundary.test.ts` が import の到達で守る）。
 *
 * ## 契約
 * - 3 つの枠（ごみ・掃除・ごはん）を並列に読み、**枠ごとに**結果を返す。どれか 1 つの失敗（error・
 *   例外・読めぬ行）でほかの枠を倒さぬ。**throw せぬ**
 * - 失敗は `{ status: "failed" }`。「ありません」「0 件」「未定」と言い換えぬ
 * - 各機能の既存の読み取りを使う（ごみ = `loadGarbagePage`、ごはん = `loadMealContext` +
 *   `buildTonightSummary`、掃除 = 掃除の画面と同じ列・同じ RPC `cleaning_log_marks`）。ハブと各画面で
 *   数え方が食い違わぬ
 * - 世帯 ID は呼び出し側が `getAuthContext()` から得た値を渡す（クライアントの入力を渡さぬ）。
 *   RLS が最終の門だが、全クエリを世帯で絞る
 */

type HubSupabase = SupabaseClient<Database>

/** 例外を、その枠の失敗として返す（ほかの枠へ波及させぬ）。 */
async function guarded(
  part: "garbage" | "cleaning" | "meals",
  householdId: string,
  load: () => Promise<ChoresHubLine>,
): Promise<ChoresHubLine> {
  try {
    return await load()
  } catch (err) {
    // 家庭の入力（料理名・食材名）を載せうる本文は出さぬ
    console.error("[chores-hub] summary lookup threw", {
      part,
      householdId,
      name: err instanceof Error ? err.name : typeof err,
    })
    return failedHubLine(part)
  }
}

async function loadGarbageLine(supabase: HubSupabase, householdId: string, today: string): Promise<ChoresHubLine> {
  return garbageHubLine(await loadGarbagePage(supabase, householdId, today))
}

async function loadCleaningLine(supabase: HubSupabase, householdId: string, today: string): Promise<ChoresHubLine> {
  const [{ data: routineRows, error: routinesError }, { data: markRows, error: marksError }] = await Promise.all([
    supabase
      .from("cleaning_routines")
      .select(CLEANING_ROUTINE_COLUMNS)
      .eq("household_id", householdId)
      .eq("archived", false)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(CLEANING_ROUTINE_LIMIT + 1),
    // 世帯は RPC が auth.uid() から導く（引数で受けぬ）
    supabase.rpc("cleaning_log_marks", {}),
  ])
  if (routinesError) {
    logSupabaseError("chores-hub", "cleaning routines lookup failed", routinesError, { householdId })
    return failedHubLine("cleaning")
  }
  if (marksError) {
    logSupabaseError("chores-hub", "cleaning marks lookup failed", marksError, { householdId })
    return failedHubLine("cleaning")
  }
  // error が無いのに配列でない = 「0 件」ではなく「読めておらぬ」
  if (!Array.isArray(routineRows) || !Array.isArray(markRows)) {
    console.error("[chores-hub] cleaning lookup returned a non-array", { householdId })
    return failedHubLine("cleaning")
  }

  const routines: CleaningRoutine[] = []
  let unreadableRoutines = 0
  for (const row of routineRows.slice(0, CLEANING_ROUTINE_LIMIT)) {
    const routine = parseCleaningRoutine(row)
    if (routine) routines.push(routine)
    else unreadableRoutines += 1
  }

  const marks: Record<string, CleaningMarks> = {}
  for (const row of markRows) {
    const parsed = parseCleaningMarksRow(row)
    // 読めぬ要約を「履歴なし」と見なすと、実施済みの項目が期限超過に化ける（掃除の画面と同じ倒し方）
    if (!parsed) {
      console.error("[chores-hub] cleaning marks row could not be read", { householdId })
      return failedHubLine("cleaning")
    }
    marks[parsed.routineId] = parsed.marks
  }

  return cleaningHubLine({
    routines,
    marks,
    today,
    unreadableRoutines,
    truncated: routineRows.length > CLEANING_ROUTINE_LIMIT,
  })
}

async function loadMealsLine(supabase: HubSupabase, householdId: string, today: string): Promise<ChoresHubLine> {
  const loaded = await loadMealContext(supabase, householdId, {
    include: ["plan", "grocery"],
    planRange: { from: today, to: today },
    today,
  })
  if (!loaded.ok) return failedHubLine("meals")
  return mealsHubLine(buildTonightSummary(loaded.context), {
    plan: loaded.context.unreadable.plan ?? 0,
    grocery: loaded.context.unreadable.grocery ?? 0,
  })
}

/**
 * 家事ハブの 3 枠の要約を読む。
 *
 * @param today JST の今日（"YYYY-MM-DD"）。3 枠で同じ日を使う（日付の境で食い違わせぬ）
 */
export async function loadChoresHubSummary(
  supabase: HubSupabase,
  householdId: string,
  today: string,
): Promise<ChoresHubSummary> {
  const [garbage, cleaning, meals] = await Promise.all([
    guarded("garbage", householdId, () => loadGarbageLine(supabase, householdId, today)),
    guarded("cleaning", householdId, () => loadCleaningLine(supabase, householdId, today)),
    guarded("meals", householdId, () => loadMealsLine(supabase, householdId, today)),
  ])
  return { garbage, cleaning, meals }
}
