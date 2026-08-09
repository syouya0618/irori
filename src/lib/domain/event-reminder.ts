/**
 * 予定への通知設定（B-2）の語彙と導出。
 *
 * **なぜ中立モジュールか**: この定数と型は Server Component（`calendar/page.tsx`）・
 * Server Action（`calendar/actions.ts`）・Client Component（フォームシート）の
 * 三方から使う。`"use client"` を持つファイルに置いて Server 側から**値として**
 * import すると Next.js が client reference へ差し替え、`tsc --noEmit` も
 * `next build` も緑のまま実行時に壊れる（`calendar-event-columns.ts` と同じ理由）。
 *
 * **remind_at の導出は SQL 側が正本**じゃ（`20260808100002_event_reminders.sql` の
 * `derive_event_remind_at()`）。ここの {@link deriveRemindAtIso} は**画面に出す予告**
 * 専用の写しで、書き込みには一切使わぬ（クライアントが送った remind_at は BEFORE
 * トリガが無条件に捨てる）。両者がずれれば「予告と実際の通知時刻が違う」という嘘に
 * なるため、vitest（`__tests__/event-reminder.test.ts`）と pgTAP
 * （`supabase/tests/event_reminders_grants_rls.sql` の D 群）は**同じ 3 例・同じ期待値**
 * を持つ。片方の実装を触れば片方が赤くなる。
 */

import { jstWallClockToIso, shiftYmd, formatJstTimeInput } from "@/lib/utils/date-jst"

/** UI が提示する「N 分前」の集合。**B-5 の設定カードもこの配列を使うこと。** */
export const EVENT_REMINDER_MINUTES = [10, 30, 60] as const

/** 通知設定の選択肢。`m<分>` は remind_kind='minutes'、`prev_day_20` は前日 20 時。 */
export type ReminderChoice = "none" | "m10" | "m30" | "m60" | "prev_day_20"

/** `m<分>` → 分。`none` / `prev_day_20` は持たぬ。 */
const MINUTES_BY_CHOICE: Record<"m10" | "m30" | "m60", number> = {
  m10: 10,
  m30: 30,
  m60: 60,
}

/** Select の選択肢（base-ui Select の `items` = ラベル解決に使う）。 */
export const REMINDER_OPTIONS: { value: ReminderChoice; label: string }[] = [
  { value: "none", label: "なし" },
  { value: "m10", label: "10分前" },
  { value: "m30", label: "30分前" },
  { value: "m60", label: "1時間前" },
  { value: "prev_day_20", label: "前日20時" },
]

/**
 * DB へ書く形。`none` は「行を消す」を意味するため null を返す。
 *
 * `remind_at` は**返さぬ**。BEFORE トリガが導出する唯一の真値ゆえ、送っても捨てられる
 * どころか列 GRANT が無く 42501 で落ちる（migration の核 ④）。
 */
export function reminderChoiceToPayload(
  choice: ReminderChoice,
): { remind_kind: "minutes" | "prev_day_20"; remind_minutes_before: number | null } | null {
  if (choice === "none") return null
  if (choice === "prev_day_20") {
    return { remind_kind: "prev_day_20", remind_minutes_before: null }
  }
  return { remind_kind: "minutes", remind_minutes_before: MINUTES_BY_CHOICE[choice] }
}

/**
 * 画面に出せる通知設定の状態。
 *
 * `unsupported` を持つのは**嘘を吐かぬため**じゃ。`remind_kind` は TEXT + CHECK ゆえ
 * 将来 migration で値が増えうる。増えた値をこの端末が知らぬとき「なし」と表示すると、
 * 利用者は**設定済みの通知を無いものと思って上書き**する。ゆえに未知は未知として
 * 出し、Select を操作不能にする（CLAUDE.md「未知値で落とさず退化させる」の適用）。
 */
export type ReminderState =
  | { status: "loading" }
  | { status: "ready"; choice: ReminderChoice }
  | { status: "unsupported" }

/** DB の行（無ければ null）から画面の状態へ。 */
export function reminderRowToState(
  row: { remind_kind: string; remind_minutes_before: number | null } | null,
): ReminderState {
  if (row === null) return { status: "ready", choice: "none" }
  if (row.remind_kind === "prev_day_20") {
    return { status: "ready", choice: "prev_day_20" }
  }
  if (row.remind_kind === "minutes") {
    const choice = minutesToChoice(row.remind_minutes_before)
    // 'minutes' でも提示外の分数（B-5 が別の値を書いた等）は変更させぬ。
    // 「なし」へ丸めると利用者が気付かず消してしまう。
    return choice === null ? { status: "unsupported" } : { status: "ready", choice }
  }
  return { status: "unsupported" }
}

/**
 * Server Action の入力検証。**Server Action の引数は外部入力**ゆえ、型注釈を
 * 信用せず実行時に確かめる（型は網の目を通り抜ける）。
 */
export function isReminderChoice(value: unknown): value is ReminderChoice {
  return (
    typeof value === "string" &&
    REMINDER_OPTIONS.some((o) => o.value === value)
  )
}

/** 分 → 選択肢。提示していない分数は null（呼び出し側が退化を決める）。 */
export function minutesToChoice(minutes: number | null): ReminderChoice | null {
  if (minutes === null) return null
  const hit = (Object.keys(MINUTES_BY_CHOICE) as ("m10" | "m30" | "m60")[]).find(
    (k) => MINUTES_BY_CHOICE[k] === minutes,
  )
  return hit ?? null
}

/**
 * 新規予定の既定値。`notification_preferences.event_default_minutes` から引く。
 *
 * 提示外の分数（NULL 以外で 10/30/60 でない値）は「なし」へ倒す。ここは
 * {@link reminderRowToState} と違い**まだ何も設定されておらぬ**場面ゆえ、
 * 「なし」に倒しても消える設定が無い。B-5 の設定カードは
 * {@link EVENT_REMINDER_MINUTES} からのみ選ばせること。
 */
export function defaultReminderChoice(
  eventDefaultMinutes: number | null | undefined,
): ReminderChoice {
  if (eventDefaultMinutes === null || eventDefaultMinutes === undefined) return "none"
  return minutesToChoice(eventDefaultMinutes) ?? "none"
}

/** 通知の宛先。単発は予定 1 件、繰り返しはシリーズ全体。 */
export type ReminderTarget = { eventId: string } | { seriesId: string }

/**
 * 予定の作成結果から「通知をどこへ付けるか」を決める。
 *
 * **なぜ関数に切り出すか**: 単発と繰り返しは `handleSubmit` の別々の分岐に居るが、
 * 宛先の決め方は 1 つの規則であるべきじゃ。加えて base-ui の Select は jsdom で
 * `fireEvent` から選択できぬ（option は描画されるが `onValueChange` が発火せぬ。実測）
 * ため、「繰り返しを選んでから保存する」経路を UI から駆動できぬ。規則をここへ出せば
 * 両分岐が**同じ 1 行**を呼ぶ形になり、単発側の結線テストが繰り返し側の結線も担保する。
 *
 * 繰り返しで id 配列ではなく `seriesId` を返すのは、最大 400 件の UUID が
 * PostgREST の URL に載らぬためじゃ（解決はサーバ側の `.eq("series_id", …)` で済む）。
 *
 * 失敗時と id 不明時は null = **宛先の無い通知を作らぬ**。
 */
export function reminderTargetFromCreateResult(result: {
  error: string | null
  eventId?: string
  seriesId?: string
}): ReminderTarget | null {
  if (result.error !== null) return null
  // 単発を優先する（両方が入ることは無いが、規則は決定的にしておく）。
  if (result.eventId) return { eventId: result.eventId }
  if (result.seriesId) return { seriesId: result.seriesId }
  return null
}

/**
 * 通知が飛ぶ時刻（ISO）。**表示専用**（SQL の `derive_event_remind_at()` の写し）。
 *
 * - `minutes`: 時刻付き予定なら `startAt` から逆算。終日なら `startDate` の 00:00 JST から
 * - `prev_day_20`: `startDate` の前日 20:00 JST
 *
 * 起点が欠けている（時刻ありなのに startAt が null 等）ときは終日と同じ 00:00 JST を
 * 起点にする — SQL 側の `v_is_all_day OR v_start_at IS NULL` と同じ分岐じゃ。
 */
export function deriveRemindAtIso(
  event: { isAllDay: boolean; startDate: string; startAt: string | null },
  choice: ReminderChoice,
): string | null {
  if (choice === "none") return null
  if (!event.startDate) return null

  if (choice === "prev_day_20") {
    return jstWallClockToIso(shiftYmd(event.startDate, -1), "20:00")
  }

  const baseIso =
    event.isAllDay || !event.startAt
      ? jstWallClockToIso(event.startDate, "00:00")
      : event.startAt

  const base = new Date(baseIso).getTime()
  if (Number.isNaN(base)) return null
  return new Date(base - MINUTES_BY_CHOICE[choice] * 60_000).toISOString()
}

/**
 * 通知時刻の予告ラベル（"8月14日 23:30"）。
 *
 * 時刻は `formatJstTimeInput`（hourCycle=h23 固定）で取る。`formatTimeJst` は ICU 既定
 * ゆえ深夜 0 時を "24:00" と出しうる — 「30分前」で日を跨いだ通知はまさに深夜 0 時台に
 * 落ちるため、ここは踏みやすい（CLAUDE.md の既知の罠）。
 */
export function formatRemindAtLabel(iso: string): string | null {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return null
  // 日付も JST で取る必要がある（UTC の日にちを使うと 9 時間ずれる）。
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(t)
  const [, m, d] = ymd.split("-").map(Number)
  return `${m}月${d}日 ${formatJstTimeInput(iso)}`
}
