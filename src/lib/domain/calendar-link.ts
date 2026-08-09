/**
 * `/calendar?date=YYYY-MM-DD` の**契約**（B-6）。書く側と読む側を 1 つに閉じる。
 *
 * **なぜ 1 モジュールか**: `?date=` を書くのは配信ジョブ（`delivery-rules.ts` /
 * `digest-rules.ts` の push ペイロード）で、読むのは Server Component
 * （`calendar/page.tsx`）じゃ。2 箇所に散らせば必ずずれる —— しかも
 * ずれ方が「通知は届くが着地日が違う」ゆえ、**誰も気付かぬ**。
 * ここに閉じておけば `roundTrip` を 1 本のテストで縛れる。
 *
 * ⚠️ このファイルは Server Component / Server Action / cron / Client Component の
 * いずれからも import されうる**中立モジュール**じゃ。`"use client"` も
 * `"use server"` も持たせてはならぬ（持たせた瞬間、Server 側の値 import が
 * client reference に化けて `tsc` も `next build` も緑のまま実行時に壊れる）。
 */

import { monthFirstOf } from "@/lib/domain/calendar-grid"
import { isValidYmd, todayJstString } from "@/lib/utils/date-jst"

/** カレンダーの着地日を運ぶクエリ名。**書く側と読む側で共有する唯一の綴り**じゃ。 */
export const CALENDAR_DATE_PARAM = "date"

/** `?date=` を持たぬ素の着地先（日付が定まらぬときの退化先）。 */
export const CALENDAR_PATH = "/calendar"

/**
 * 通知の着地先 URL を組む。
 *
 * 妥当な "YYYY-MM-DD" でなければ**素の `/calendar`** へ倒す。ここで壊れた値を
 * そのまま載せても `resolveCalendarDateView` が今日へ倒すゆえ画面は死なぬが、
 * 「在りもせぬ日付を指す URL」を通知に埋めておく理由が無い（配信ログや
 * 端末の通知履歴に残るのは実在する日付だけでよい）。
 */
export function calendarUrlForDate(ymd: string | null | undefined): string {
  if (!isValidYmd(ymd)) return CALENDAR_PATH
  return `${CALENDAR_PATH}?${CALENDAR_DATE_PARAM}=${ymd}`
}

/** Next.js の `searchParams`（await 済み）。 */
export type CalendarSearchParams = {
  [key: string]: string | string[] | undefined
}

/** `/calendar` が最初に描く状態。選択日と、それを含む月グリッドは**常に同じ月**。 */
export interface CalendarDateView {
  /** アジェンダが開く日（"YYYY-MM-DD"）。 */
  selectedDate: string
  /** 月グリッドの基準（"YYYY-MM-01"）。**必ず `selectedDate` から導く。** */
  monthFirst: string
}

/**
 * `?date=` から「最初に描く日と月」を決める。**この 2 つを 1 つの関数で返すのが要点じゃ。**
 *
 * 別々に決めると、選択日だけを `?date=` から取り、月を「今月」のまま残す実装が
 * 通ってしまう —— 7/31 の夜に届いた「前日20時」の通知を叩くと、**8 月の日を
 * 7 月のグリッドで選んだ**状態になり、月グリッドのどのセルも光らぬまま
 * 「8月1日 の予定」が出る（月跨ぎの通知はまさにこれを踏む）。
 * ゆえに `monthFirst` はここで `monthFirstOf(selectedDate)` から導き、
 * 呼び出し側に月を決める自由を残さぬ。
 *
 * **クエリ名も呼び出し側に決めさせぬ。** `searchParams` 全体を受け取り、
 * `CALENDAR_DATE_PARAM` を**この関数が**引く。値 1 つだけ渡す形にすると、書く側は
 * 定数を使うのに読む側（page）は `searchParams.date` とリテラルで書く、という
 * **片側だけの契約**になる —— 定数を改名しても全テストが緑のまま、通知の着地は
 * 全件今日へ戻る（往復テストも定数で取り出すなら、その不一致を原理的に検出できぬ）。
 *
 * 検証は `isValidYmd`（PR #199 で確立した唯一の実装）に委ねる。形式だけの正規表現では
 * `2026-02-30` が通り、`Date.UTC` が 3/2 へ繰り上げて**静かに違う日**を開く。
 *
 * @param searchParams Next.js の `searchParams`（await 済み。`?date=a&date=b` は配列）
 * @param now          今日の判定基準（テストのため注入可能。既定は実時刻）
 */
export function resolveCalendarDateView(
  searchParams: CalendarSearchParams | undefined,
  now: Date = new Date(),
): CalendarDateView {
  const dateParam = searchParams?.[CALENDAR_DATE_PARAM]
  // `?date=a&date=b` は配列、`?date=` は空文字。どちらも文字列以外／不正として
  // 今日へ倒す（`settings/page.tsx` の `?google=` と同じ narrowing じゃ）。
  const raw = typeof dateParam === "string" ? dateParam : null
  const selectedDate = isValidYmd(raw) ? raw : todayJstString(now)
  return { selectedDate, monthFirst: monthFirstOf(selectedDate) }
}
