import { toJstDateString } from "@/lib/utils/date-jst"
import {
  recurrenceMaxUntil,
  type RecurrenceRepeat,
} from "@/lib/domain/calendar-recurrence"

const MAX_TITLE = 200
const MAX_MEMO = 1000

/** 繰り返し種別。"none" は単発予定。 */
export type CalendarRepeat = "none" | RecurrenceRepeat

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
  repeat: CalendarRepeat
  /** repeat !== "none" のときのみ非 null(YYYY-MM-DD, inclusive)。 */
  repeatUntil: string | null
}

/**
 * 検証に失敗した入力項目。エラー文言と**同じ場所で**返すことで、
 * クライアント側が文言を再実装せずに「どの入力が悪いか」を特定できる
 * （文言とフィールドの二重真値源を作らないための設計）。
 * サーバー Action は error のみを使い field は無視する。
 */
export type CalendarEventField =
  | "title"
  | "memo"
  | "startDate"
  | "endDate"
  | "startAt"
  | "endAt"
  | "repeatUntil"

export type CalendarValidationResult =
  | { error: string; field: CalendarEventField; value: null }
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
  repeat?: CalendarRepeat
  repeatUntil?: string | null
}): CalendarValidationResult {
  const title = raw.title.trim()
  if (title.length < 1)
    return { error: "タイトルを入力してください", field: "title", value: null }
  if (title.length > MAX_TITLE)
    return {
      error: `タイトルは${MAX_TITLE}文字以内で入力してください`,
      field: "title",
      value: null,
    }

  const memo = raw.memo?.trim() || null
  if (memo && memo.length > MAX_MEMO)
    return {
      error: `メモは${MAX_MEMO}文字以内で入力してください`,
      field: "memo",
      value: null,
    }

  // 形式検証は開始/終了を個別に判定する（文言は共通のまま field だけを分ける）。
  if (!isValidYmd(raw.startDate))
    return { error: "日付の形式が不正です", field: "startDate", value: null }
  if (!isValidYmd(raw.endDate))
    return { error: "日付の形式が不正です", field: "endDate", value: null }

  // startDate/endDate は YYYY-MM-DD ゆえ辞書順 = 暦順で比較して差し支えない。
  if (raw.endDate < raw.startDate)
    return {
      error: "終了日は開始日以降にしてください",
      field: "endDate",
      value: null,
    }

  // 繰り返し検証。repeat !== "none" のとき repeatUntil 必須 + 範囲(startDate より後・
  // startDate+1年以内)。上限は generateRecurrenceDates の防御ガードと同一の
  // recurrenceMaxUntil で計算し、DB 側 materialize と不変条件を一致させる。
  const repeat: CalendarRepeat = raw.repeat ?? "none"
  let repeatUntil: string | null = null
  if (repeat !== "none") {
    if (!raw.repeatUntil)
      return {
        error: "繰り返しの終了日を入力してください",
        field: "repeatUntil",
        value: null,
      }
    if (!isValidYmd(raw.repeatUntil))
      return {
        error: "繰り返しの終了日の形式が不正です",
        field: "repeatUntil",
        value: null,
      }
    if (raw.repeatUntil <= raw.startDate)
      return {
        error: "繰り返しの終了日は開始日より後にしてください",
        field: "repeatUntil",
        value: null,
      }
    if (raw.repeatUntil > recurrenceMaxUntil(raw.startDate))
      return {
        error: "繰り返しの終了日は開始日から1年以内にしてください",
        field: "repeatUntil",
        value: null,
      }
    repeatUntil = raw.repeatUntil
  }

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
        repeat,
        repeatUntil,
      },
    }
  }

  // 時刻付き
  if (!raw.startAt)
    return { error: "開始時刻を入力してください", field: "startAt", value: null }
  // toJstDateString は不正 ISO で throw / getTime は NaN で順序判定をすり抜けるため、
  // 整合・順序の判定に入る前に必ず ISO 形式をパース検証する。
  if (!isValidIsoDateTime(raw.startAt))
    return { error: "開始時刻の形式が不正です", field: "startAt", value: null }
  if (raw.endAt && !isValidIsoDateTime(raw.endAt))
    return { error: "終了時刻の形式が不正です", field: "endAt", value: null }

  // AUDIT-069: start_date ↔ start_at の JST 暦日整合は DB CHECK 化不能
  // （AT TIME ZONE は STABLE）ゆえ書き込み側で強制する。end_at は endDate と照合。
  if (toJstDateString(raw.startAt) !== raw.startDate)
    return {
      error: "開始時刻の日付が開始日と一致しません",
      field: "startAt",
      value: null,
    }
  if (raw.endAt && toJstDateString(raw.endAt) !== raw.endDate)
    return {
      error: "終了時刻の日付が終了日と一致しません",
      field: "endAt",
      value: null,
    }

  // 順序は getTime で比較する。文字列比較だと +09:00 と Z の混在で誤判定する。
  if (raw.endAt && new Date(raw.endAt).getTime() < new Date(raw.startAt).getTime())
    return {
      error: "終了時刻は開始時刻以降にしてください",
      field: "endAt",
      value: null,
    }

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
      repeat,
      repeatUntil,
    },
  }
}
