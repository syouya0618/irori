import { shiftYmd } from "@/lib/utils/date-jst"

/**
 * 繰り返し予定の materialize(展開)を担う純関数。
 *
 * すべて "YYYY-MM-DD" 文字列演算で完結させ、`new Date("YYYY-MM-DD")` の UTC 罠を
 * 避ける(日数シフトは date-jst の shiftYmd = Date.UTC ベースに委譲)。
 * 生成日は startDate を含み until を含む(inclusive)。
 */

export type RecurrenceRepeat = "daily" | "weekly" | "monthly"

/**
 * 生成数の上限。until が startDate+1年以内に制限されるため daily でも最大 366 日で
 * あり、通常運用でこの上限には到達しない。暴走(ロジックバグ)への防御ガードとして
 * 残す — 削除禁止。
 */
export const MAX_RECURRENCE_OCCURRENCES = 400

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseYmdStrict(ymd: string): { y: number; m: number; d: number } {
  const match = YMD_RE.exec(ymd)
  if (!match) {
    throw new Error(`generateRecurrenceDates: 日付形式が不正です: ${ymd}`)
  }
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

/** y-m(1-12) の日数。Date.UTC(y, m, 0) は当月末日を返す(TZ 非依存)。 */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** 数値 y/m/d を "YYYY-MM-DD" にゼロ埋め整形する。 */
function formatYmd(y: number, m: number, d: number): string {
  const mm = String(m).padStart(2, "0")
  const dd = String(d).padStart(2, "0")
  return `${y}-${mm}-${dd}`
}

/**
 * 繰り返し終了日の許容上限 = startDate + 1年(inclusive)を YYYY-MM-DD で返す。
 * overflow(2/29 起点等)は Date.UTC が正規化する(TZ 非依存)。
 * pure 関数の防御ガードと calendar-validation の範囲チェックが**同一の不変条件**を
 * 使うための唯一の計算源。
 */
export function recurrenceMaxUntil(startDate: string): string {
  const { y, m, d } = parseYmdStrict(startDate)
  return new Date(Date.UTC(y + 1, m - 1, d)).toISOString().slice(0, 10)
}

/**
 * 繰り返し開催日の一覧を YYYY-MM-DD で返す。
 *
 * @param startDate 初回開催日(inclusive)。
 * @param repeat    毎日 / 毎週 / 毎月。
 * @param until     最終日(inclusive)。startDate より後、かつ startDate+1年以内。
 *
 * monthly は「同一の日」で刻み、存在しない月(1/31 → 2月 など)はスキップする
 * (Google カレンダー流儀)。
 *
 * 防御ガード(削除禁止):
 *  - until は startDate より後でなければ throw。
 *  - until は startDate+1年以内でなければ throw(2/29 起点の +1年は Date.UTC で
 *    正規化され 3/1 になるが、その正規化後の日付を上限とする)。
 *  - 生成数が {@link MAX_RECURRENCE_OCCURRENCES} を超えたら throw。
 */
export function generateRecurrenceDates(
  startDate: string,
  repeat: RecurrenceRepeat,
  until: string,
): string[] {
  const start = parseYmdStrict(startDate)
  parseYmdStrict(until) // 形式検証(戻り値は使わないが不正形式で throw させる)

  // 文字列は YYYY-MM-DD ゆえ辞書順 = 暦順。
  if (until <= startDate) {
    throw new Error("繰り返しの終了日は開始日より後にしてください")
  }

  // startDate + 1年。overflow(2/29 → 翌年 2/29 が無い等)は Date.UTC が正規化する。
  const maxUntil = recurrenceMaxUntil(startDate)
  if (until > maxUntil) {
    throw new Error("繰り返しの終了日は開始日から1年以内にしてください")
  }

  const dates: string[] = []

  if (repeat === "daily" || repeat === "weekly") {
    const step = repeat === "daily" ? 1 : 7
    let cursor = startDate
    while (cursor <= until) {
      dates.push(cursor)
      if (dates.length > MAX_RECURRENCE_OCCURRENCES) {
        throw new Error("繰り返しの生成数が上限を超えました")
      }
      cursor = shiftYmd(cursor, step)
    }
    return dates
  }

  // monthly: startDate の「日」を各月に適用。存在しない日はスキップする。
  for (let i = 0; ; i++) {
    const totalMonths = start.m - 1 + i
    const y = start.y + Math.floor(totalMonths / 12)
    const m = (totalMonths % 12) + 1
    // 当月 1 日が until を超えたら以降の月も全て超えるので終端。
    if (formatYmd(y, m, 1) > until) break
    if (start.d <= daysInMonth(y, m)) {
      const candidate = formatYmd(y, m, start.d)
      if (candidate <= until) {
        dates.push(candidate)
        if (dates.length > MAX_RECURRENCE_OCCURRENCES) {
          throw new Error("繰り返しの生成数が上限を超えました")
        }
      }
    }
    // 暴走防御(until <= startDate+1年 ゆえ通常 13 反復以内で break する)。
    if (i > MAX_RECURRENCE_OCCURRENCES) {
      throw new Error("繰り返しの生成数が上限を超えました")
    }
  }
  return dates
}
