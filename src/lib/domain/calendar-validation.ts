import { toJstDateString } from "@/lib/utils/date-jst"

const MAX_TITLE = 200
const MAX_MEMO = 1000

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** YYYY-MM-DD 形式かを判定する（日付バケットの形式検証）。 */
function isValidYmd(s: string): boolean {
  return YMD_PATTERN.test(s)
}

/**
 * 時刻付き ISO 8601 かを判定する。date-only や不正値を弾く。
 * T を必須にしつつ +09:00 / Z / ミリ秒の各表記を Date のパースで許容する。
 * 後段の toJstDateString は不正 ISO で RangeError を throw し、getTime は NaN を
 * 返して順序判定をすり抜けるため、両者の前段ガードとして機能する。
 */
function isValidIsoDateTime(s: string): boolean {
  return s.includes("T") && !Number.isNaN(new Date(s).getTime())
}

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

  if (!isValidYmd(raw.startDate) || !isValidYmd(raw.endDate))
    return { error: "日付の形式が不正です", value: null }

  // startDate/endDate は YYYY-MM-DD ゆえ辞書順 = 暦順で比較して差し支えない。
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
  // toJstDateString は不正 ISO で throw / getTime は NaN で順序判定をすり抜けるため、
  // 整合・順序の判定に入る前に必ず ISO 形式をパース検証する。
  if (!isValidIsoDateTime(raw.startAt))
    return { error: "開始時刻の形式が不正です", value: null }
  if (raw.endAt && !isValidIsoDateTime(raw.endAt))
    return { error: "終了時刻の形式が不正です", value: null }

  // AUDIT-069: start_date ↔ start_at の JST 暦日整合は DB CHECK 化不能
  // （AT TIME ZONE は STABLE）ゆえ書き込み側で強制する。end_at は endDate と照合。
  if (toJstDateString(raw.startAt) !== raw.startDate)
    return { error: "開始時刻の日付が開始日と一致しません", value: null }
  if (raw.endAt && toJstDateString(raw.endAt) !== raw.endDate)
    return { error: "終了時刻の日付が終了日と一致しません", value: null }

  // 順序は getTime で比較する。文字列比較だと +09:00 と Z の混在で誤判定する。
  if (raw.endAt && new Date(raw.endAt).getTime() < new Date(raw.startAt).getTime())
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
