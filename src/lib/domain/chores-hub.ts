/**
 * 家事ハブ（/chores）の「今日の要約」の文を組む純関数（中立モジュール）。
 *
 * 境界指令を持たぬ。Supabase もカタログも値 import せぬ（型だけ）ゆえ、どこから import しても
 * 献立のカタログを bundle へ連れて来ぬ。読み取りは `@/lib/supabase/chores-hub-query`（サーバー専用）。
 *
 * ## 偽らぬための規則
 * - 読めなかった枠は `failed`。「ありません」「0 件」「未定」と言い換えぬ（画面はその枠だけ
 *   「読み込めませんでした」と出し、ほかの枠はそのまま出す）
 * - 行は読めたが一部を解釈できなんだ時は、読めた分の要約に「表示できない◯◯が n 件」と添える
 *   （黙って少なく数えぬ）
 * - 文だけを返す（ハブのカードは全体がリンクゆえ、ボタン・リンクを中へ入れられぬ）
 */
import { collectionDayRelativeLabel } from "@/lib/domain/garbage"
import {
  bucketOf,
  EMPTY_CLEANING_MARKS,
  formatYmdJa,
  routineStatusFromMarks,
  type CleaningMarks,
  type CleaningRoutine,
} from "@/lib/domain/cleaning-schedule"
import type { TonightSummary } from "@/lib/meals/server/plan-views"
import type { GarbagePageData } from "@/lib/supabase/garbage-overview-query"

/** 1 枠の要約。`failed` は「読めなかった」（空・0 件とは別）。 */
export type ChoresHubLine =
  | { status: "ok"; text: string; /** 読めた分に添える注記（読めぬ行・上限） */ note?: string }
  | { status: "failed"; text: string }

export interface ChoresHubSummary {
  garbage: ChoresHubLine
  cleaning: ChoresHubLine
  meals: ChoresHubLine
}

export const CHORES_HUB_FAILED_TEXT = {
  garbage: "次の収集日を読み込めませんでした。",
  cleaning: "掃除の予定を読み込めませんでした。",
  meals: "今夜の献立と買い物を読み込めませんでした。",
} as const

export function failedHubLine(part: keyof typeof CHORES_HUB_FAILED_TEXT): ChoresHubLine {
  return { status: "failed", text: CHORES_HUB_FAILED_TEXT[part] }
}

// ───────────────────────── ごみ ─────────────────────────

/** 同じ日に並べる名称の上限（残りは件数で言う）。 */
const GARBAGE_LABEL_PREVIEW = 3

/**
 * 次の収集日と名称。ごみの画面（`loadGarbagePage`）と同じ読み取り結果から組むゆえ、
 * ハブとごみの画面で「次の収集日」が食い違わぬ。
 */
export function garbageHubLine(data: GarbagePageData): ChoresHubLine {
  // 分類・今後の予定のどちらかを読めねば、次の収集日は言えぬ（truncated は近い順に読めておる）
  if (data.purposes === "failed" || data.events === "failed") return failedHubLine("garbage")
  const { overview } = data
  if (overview.entries.length === 0) return { status: "ok", text: "ごみの日はまだ登録されていません。" }
  const first = overview.collections[0]
  if (first === undefined) {
    return { status: "ok", text: `今日から${data.windowDays}日のあいだに、収集日はありません。` }
  }
  const labels: string[] = []
  for (const collection of overview.collections) {
    if (collection.date !== first.date) break
    if (!labels.includes(collection.label)) labels.push(collection.label)
  }
  const shown = labels.slice(0, GARBAGE_LABEL_PREVIEW).join("・")
  const rest = labels.length - GARBAGE_LABEL_PREVIEW
  const names = rest > 0 ? `${shown}・ほか${rest}種類` : shown
  const relative = collectionDayRelativeLabel(first.date, data.today)
  // 「11月14日（土）」。今日と年が違えば年つき。読めぬ日付は表記のまま（捏造せぬ）
  const dayJa = formatYmdJa(first.date, data.today) ?? first.date
  const day = relative === null ? dayJa : `${relative} ${dayJa}`
  return { status: "ok", text: `次の収集日は${day}、${names}です。` }
}

// ───────────────────────── 掃除 ─────────────────────────

export interface CleaningHubInput {
  /** 読めた定義（アーカイブ済みを含んでよい — ここで除く） */
  routines: readonly CleaningRoutine[]
  /** 有効な履歴の要約（routine id → marks）。行の無い routine は履歴なし */
  marks: Readonly<Record<string, CleaningMarks>>
  today: string
  /** 形を読めなんだ定義の数 */
  unreadableRoutines: number
  /** 取得の上限に届いた（全部は数えられておらぬ） */
  truncated: boolean
}

export interface CleaningHubCounts {
  /** 今日が期限 */
  today: number
  /** 明日から今週の日曜までが期限 */
  thisWeek: number
  /** 期限を過ぎておる */
  overdue: number
  /** 稼働中（アーカイブ・休止でない）の項目の数 */
  active: number
}

/** 掃除の画面（`CleaningView`）と同じ区分（`bucketOf`）で数える。アーカイブ済みは数えぬ。 */
export function countCleaningBuckets(input: Pick<CleaningHubInput, "routines" | "marks" | "today">): CleaningHubCounts {
  const counts: CleaningHubCounts = { today: 0, thisWeek: 0, overdue: 0, active: 0 }
  for (const routine of input.routines) {
    if (routine.archived) continue
    const status = routineStatusFromMarks(routine, input.marks[routine.id] ?? EMPTY_CLEANING_MARKS, input.today)
    const bucket = bucketOf(status, input.today)
    if (bucket !== "paused") counts.active += 1
    if (bucket === "today") counts.today += 1
    else if (bucket === "this_week") counts.thisWeek += 1
    else if (bucket === "overdue") counts.overdue += 1
  }
  return counts
}

/** 今日・今週の件数と期限超過の件数。 */
export function cleaningHubLine(input: CleaningHubInput): ChoresHubLine {
  const counts = countCleaningBuckets(input)
  const total = input.routines.filter((routine) => !routine.archived).length
  const notes: string[] = []
  if (input.unreadableRoutines > 0) notes.push(`表示できない項目が${input.unreadableRoutines}件あります`)
  if (input.truncated) notes.push("項目が多いため、一部は数えられていません")
  const note = notes.length > 0 ? `${notes.join("。")}。` : undefined

  let text: string
  if (total === 0) {
    // 読めぬ項目が在る時に「まだありません」と言わぬ
    text = input.unreadableRoutines > 0 ? "表示できる掃除の項目がありません。" : "掃除の項目はまだありません。"
  } else if (counts.today + counts.thisWeek + counts.overdue === 0) {
    text = "今日・今週が期限の掃除はありません。"
  } else {
    text = `今日 ${counts.today}件・今週のこり ${counts.thisWeek}件・期限超過 ${counts.overdue}件`
  }
  return note === undefined ? { status: "ok", text } : { status: "ok", text, note }
}

// ───────────────────────── ごはん ─────────────────────────

/** 要約に名前を出す料理の数（残りは品数で言う）。 */
const DISH_PREVIEW = 2

/** 今夜の献立と、まだ買うものの件数。 */
export function mealsHubLine(
  summary: TonightSummary,
  unreadable: { plan: number; grocery: number } = { plan: 0, grocery: 0 },
): ChoresHubLine {
  const { dinner } = summary
  let tonight: string
  if (dinner.state === "none" || dinner.dishes.length === 0) {
    // 読めぬ献立の行が在る時に「未定」と言わぬ
    tonight = unreadable.plan > 0 ? "今夜の献立は表示できません" : "今夜の献立は未定"
  } else {
    const titles = dinner.dishes.slice(0, DISH_PREVIEW).map((dish) => dish.title)
    const rest = dinner.dishes.length - DISH_PREVIEW
    const names = rest > 0 ? `${titles.join("、")}、ほか${rest}品` : titles.join("、")
    tonight = `今夜: ${names}（${dinner.stateLabel}）`
  }
  const toBuy = summary.toBuyCount > 0 ? `まだ買うもの ${summary.toBuyCount}件` : "まだ買うものはありません"

  const notes: string[] = []
  if (unreadable.plan > 0) notes.push(`表示できない献立の記録が${unreadable.plan}件あります`)
  if (unreadable.grocery > 0) notes.push(`表示できない買い物の項目が${unreadable.grocery}件あります`)
  const text = `${tonight}・${toBuy}`
  return notes.length === 0 ? { status: "ok", text } : { status: "ok", text, note: `${notes.join("。")}。` }
}
