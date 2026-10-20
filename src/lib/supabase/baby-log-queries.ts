import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import { BABY_LOG_COLUMNS } from "@/lib/domain/baby-log-columns"
import { WEEKLY_FETCH_DAYS } from "@/lib/domain/baby-weekly-summary"
import { jstDayStartIso, shiftYmd } from "@/lib/utils/date-jst"

/**
 * 育児ログ画面（/baby）が読む baby_logs のクエリ群。サーバの初回描画（`baby/page.tsx`）と、
 * 画面復帰・再接続の取り直し（`baby-dashboard.tsx` の resyncLogs）・日付ナビの取得が
 * **同じ窓・同じ条件**で読むための唯一の組み立て場所じゃ。
 *
 * 以前は同じクエリが SSR と resync と日付ナビに 2〜3 部ずつ書かれ、「理由は page.tsx の
 * 同クエリのコメント参照」で結ばれていた。片方だけ直すと、初回描画と取り直しで
 * 「最終授乳」「次の授乳の目安」が食い違う（どちらの画面にもエラーは出ない）。
 *
 * - 日境界は JST（`jstDayStartIso`）。窓は半開区間 [開始, 翌日 0:00)
 * - 週窓・成長・前日までの授乳は**今日**基準、選択日の窓だけが選択日基準
 * - `signal` は client の取り直し用（次の取り直し・unmount で古い要求を捨てる）。
 *   サーバでは渡さぬ
 *
 * 境界指令を持たぬ中立モジュール（Server Component と Client Component の両方から値 import する）。
 */

type Client = SupabaseClient<Database>

function withSignal<Q extends { abortSignal(signal: AbortSignal): Q }>(
  query: Q,
  signal: AbortSignal | undefined,
): Q {
  return signal ? query.abortSignal(signal) : query
}

/** 選択日（JST 暦日）の記録。新しい順 */
export function selectBabyLogsOfDay(
  supabase: Client,
  householdId: string,
  dateYmd: string,
  signal?: AbortSignal,
) {
  return withSignal(
    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .gte("logged_at", jstDayStartIso(dateYmd))
      .lt("logged_at", jstDayStartIso(shiftYmd(dateYmd, 1)))
      .order("logged_at", { ascending: false }),
    signal,
  )
}

/**
 * 週間サマリーの取得窓（今日を含む WEEKLY_FETCH_DAYS 日）。新しい順。
 * 表示は末尾 7 日、平均は先頭 7 日（＝昨日まで）に使う。窓を 7 日に戻すと平均が
 * 今日を含んでしまい、朝ほど過小に出る。
 */
export function selectBabyLogsOfWeek(
  supabase: Client,
  householdId: string,
  todayYmd: string,
  signal?: AbortSignal,
) {
  return withSignal(
    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .gte("logged_at", jstDayStartIso(shiftYmd(todayYmd, -(WEEKLY_FETCH_DAYS - 1))))
      .lt("logged_at", jstDayStartIso(shiftYmd(todayYmd, 1)))
      .order("logged_at", { ascending: false }),
    signal,
  )
}

/** 成長曲線用: 成長ログを古い順に全件（低頻度データ・1000 未満想定、順序を昇順で決定化） */
export function selectGrowthLogs(
  supabase: Client,
  householdId: string,
  signal?: AbortSignal,
) {
  return withSignal(
    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .eq("log_type", "growth")
      .order("logged_at", { ascending: true }),
    signal,
  )
}

/**
 * 今日より前の最後の授乳（最終授乳の表示のフォールバック）。搾乳を**含む**契約。
 *
 * logged_at の開始時刻セマンティクスにより、深夜を跨いだサイクルは前日行に
 * なって今日窓の logs に現れない。当日にまだ授乳が無い間「最終授乳 ---」へ
 * 落ちないよう、別クエリで取ってフォールバックとして渡す。
 */
export function selectLastFeedingBefore(
  supabase: Client,
  householdId: string,
  todayYmd: string,
  signal?: AbortSignal,
) {
  return withSignal(
    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .eq("log_type", "feeding")
      .lt("logged_at", jstDayStartIso(todayYmd))
      .order("logged_at", { ascending: false })
      .limit(1),
    signal,
  ).maybeSingle()
}

/**
 * 今日より前の最後の「授乳」（搾乳を除く）。次の授乳の目安の起点フォールバック。
 * 上の selectLastFeedingBefore（最終授乳表示用）と分けているのは、あちらが搾乳を
 * 含む契約だから — 流用すると「搾乳しただけで目安が飛ぶ」が残る。
 *
 * 除外は **pumped 1 値の denylist** で書く（CLAUDE.md「enum drift 防御」。allowlist で
 * 列挙すると DB 側 ENUM に新しい授乳種別が増えたとき、その授乳が無音で目安から漏れる）。
 *
 * `.neq` 単体ではなく `.or(is.null, neq)` にするのは SQL の三値論理のため:
 * `feeding_type <> 'pumped'` は feeding_type IS NULL の行を**落とす**（実測:
 * 3 行の probe で neq は NULL 行を捨て、or は残した）。現状 feeding 行の
 * feeding_type は CHECK `chk_feeding`（log_type <> 'feeding' OR feeding_type
 * IS NOT NULL・実 DB で存在を確認）により NULL になり得ぬが、その CHECK が
 * 緩んだ瞬間に「授乳を記録しても目安が動かない」が無音で復活する結合になる。
 * 搾乳と確定しておらぬ行は授乳として数える向き（目安が早まる方が安全）へ倒す。
 */
export function selectLastNursingBefore(
  supabase: Client,
  householdId: string,
  todayYmd: string,
  signal?: AbortSignal,
) {
  return withSignal(
    supabase
      .from("baby_logs")
      .select(BABY_LOG_COLUMNS)
      .eq("household_id", householdId)
      .eq("log_type", "feeding")
      .or("feeding_type.is.null,feeding_type.neq.pumped")
      .lt("logged_at", jstDayStartIso(todayYmd))
      .order("logged_at", { ascending: false })
      .limit(1),
    signal,
  ).maybeSingle()
}
