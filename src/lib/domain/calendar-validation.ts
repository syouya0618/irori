const MAX_TITLE = 200
const MAX_MEMO = 1000

export interface ValidatedCalendarInput {
  title: string
  memo: string | null
  isAllDay: boolean
  startDate: string
  endDate: string
  startAt: string | null
  endAt: string | null
}

export type CalendarValidationResult =
  | { error: string; value: null }
  | { error: null; value: ValidatedCalendarInput }

/**
 * 予定入力を検証・正規化する。DB CHECK 制約と同じ不変条件をクライアント側でも
 * 弾き、握り潰さず日本語メッセージで返す。
 */
export function validateCalendarEventInput(raw: {
  title: string
  memo?: string | null
  isAllDay: boolean
  startDate: string
  endDate: string
  startAt?: string | null
  endAt?: string | null
}): CalendarValidationResult {
  const title = raw.title.trim()
  if (title.length < 1) return { error: "タイトルを入力してください", value: null }
  if (title.length > MAX_TITLE)
    return {
      error: `タイトルは${MAX_TITLE}文字以内で入力してください`,
      value: null,
    }

  const memo = raw.memo?.trim() || null
  if (memo && memo.length > MAX_MEMO)
    return { error: `メモは${MAX_MEMO}文字以内で入力してください`, value: null }

  if (raw.endDate < raw.startDate)
    return { error: "終了日は開始日以降にしてください", value: null }

  if (raw.isAllDay) {
    return {
      error: null,
      value: {
        title,
        memo,
        isAllDay: true,
        startDate: raw.startDate,
        endDate: raw.endDate,
        startAt: null,
        endAt: null,
      },
    }
  }

  // 時刻付き
  if (!raw.startAt)
    return { error: "開始時刻を入力してください", value: null }
  if (raw.endAt && raw.endAt < raw.startAt)
    return { error: "終了時刻は開始時刻以降にしてください", value: null }

  return {
    error: null,
    value: {
      title,
      memo,
      isAllDay: false,
      startDate: raw.startDate,
      endDate: raw.endDate,
      startAt: raw.startAt,
      endAt: raw.endAt ?? null,
    },
  }
}
