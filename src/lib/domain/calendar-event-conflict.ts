import type { ValidatedCalendarInput } from "@/lib/domain/calendar-validation"

/**
 * 予定の更新の楽観的排他（`updated_at` を版にする。育児日記 P1-06 と同じ契約）で、
 * 版が合わなかった時に「既に成立した自分の保存の再試行」か「別の端末の更新」かを
 * 見分けるための純関数。
 *
 * 版が合わぬ = 誰かが先に UPDATE した（trigger `trg_calendar_events_updated_at` が
 * UPDATE ごとに版を進める）。ただし応答だけを失った自分の保存を押し直した場合も
 * 版は進んでおる。その時は DB の中身が今送った中身と同じゆえ、衝突ではなく
 * 既に成立した保存として成功を返してよい（冪等）。家族が偶然同じ中身を書いた
 * 場合も、守るべき中身は同じゆえ失うものは無い。
 *
 * 比べるのは利用者が編集できる列だけ。時刻は表記が揺れる（"Z" と "+00:00"、
 * 秒未満の桁）ため epoch で比べる。
 */
export type CalendarEventEditableValue = Pick<
  ValidatedCalendarInput,
  "title" | "memo" | "isAllDay" | "startDate" | "endDate" | "startAt" | "endAt"
>

export interface CalendarEventStoredContent {
  title: string
  memo: string | null
  is_all_day: boolean
  start_date: string
  end_date: string
  start_at: string | null
  end_at: string | null
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  const ta = new Date(a).getTime()
  const tb = new Date(b).getTime()
  return !Number.isNaN(ta) && ta === tb
}

export function sameCalendarEventContent(
  stored: CalendarEventStoredContent,
  sent: CalendarEventEditableValue,
): boolean {
  return (
    stored.title === sent.title &&
    (stored.memo ?? null) === (sent.memo ?? null) &&
    stored.is_all_day === sent.isAllDay &&
    stored.start_date === sent.startDate &&
    stored.end_date === sent.endDate &&
    sameInstant(stored.start_at, sent.startAt) &&
    sameInstant(stored.end_at, sent.endAt)
  )
}
