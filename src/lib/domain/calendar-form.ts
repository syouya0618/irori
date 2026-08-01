/**
 * 予定フォームの値 ↔ 検証入力の橋渡し（**境界指令を持たない中立モジュール**）。
 *
 * `"use client"` / `"use server"` のいずれも付けず components からも import しない。
 * クライアント（シート）とサーバー Action の**双方から同じ関数**を呼ぶことで、
 * 「クライアント検証 = UX / サーバー検証 = 正しさ」の二層を保ったまま
 * 文言・判定の二重真値源を作らない。
 */

import { daysBetweenYmd, jstWallClockToIso, shiftYmd } from "@/lib/utils/date-jst"
import {
  validateCalendarEventInput,
  type CalendarRepeat,
  type CalendarValidationResult,
} from "@/lib/domain/calendar-validation"

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const HM_PATTERN = /^\d{2}:\d{2}$/

export interface CalendarEventFormValue {
  title: string
  memo: string | null
  isAllDay: boolean
  startDate: string
  endDate: string
  startTime: string // "HH:MM"(終日なら未使用)
  endTime: string
  /** 繰り返し種別(作成モードのみ有効。編集モードは常に "none")。 */
  repeat: CalendarRepeat
  /** 繰り返し終了日(YYYY-MM-DD)。repeat === "none" のときは未使用。 */
  repeatUntil: string
}

/**
 * JST 壁時計 → ISO。日付/時刻が空・不正形式のときは throw せず null を返す。
 *
 * `jstWallClockToIso` は空文字や不正日付で Invalid Date になり `.toISOString()` が
 * RangeError を投げる（イベントハンドラ内の未捕捉例外 = 無反応）。ここで null に
 * 倒すと、後段の `validateCalendarEventInput` が「日付の形式が不正です」/
 * 「開始時刻を入力してください」として**同じ文言で**弾く。
 */
function jstWallClockToIsoOrNull(dateYmd: string, timeHm: string): string | null {
  if (!YMD_PATTERN.test(dateYmd) || !HM_PATTERN.test(timeHm)) return null
  // 形式は合っていてもパース不能(Invalid Date)なら null。実測: "2026-02-31" は
  // Invalid Date にはならず翌月へ繰り上がるが、その場合は後段の検証が
  // 「開始時刻の日付が開始日と一致しません」で弾くため無音では通らない。
  if (Number.isNaN(new Date(`${dateYmd}T${timeHm}:00+09:00`).getTime())) return null
  return jstWallClockToIso(dateYmd, timeHm)
}

/**
 * フォーム値から start_at / end_at(ISO)を導出する。
 * 楽観行の生成（calendar-view）とクライアント事前検証（シート）の**両方**が
 * これを使い、送信値と検証値がずれないようにする。
 */
export function formValueToTimestamps(v: CalendarEventFormValue): {
  startAt: string | null
  endAt: string | null
} {
  if (v.isAllDay) return { startAt: null, endAt: null }
  return {
    startAt: jstWallClockToIsoOrNull(v.startDate, v.startTime),
    endAt: v.endTime ? jstWallClockToIsoOrNull(v.endDate, v.endTime) : null,
  }
}

/**
 * フォーム値をサーバーと同一の検証器へ通す。文言・判定・field はすべて
 * `validateCalendarEventInput` 側に一元化されており、ここでは再実装しない。
 */
export function validateCalendarFormValue(
  v: CalendarEventFormValue,
): CalendarValidationResult {
  const { startAt, endAt } = formValueToTimestamps(v)
  return validateCalendarEventInput({
    title: v.title,
    memo: v.memo,
    isAllDay: v.isAllDay,
    startDate: v.startDate,
    endDate: v.endDate,
    startAt,
    endAt,
    repeat: v.repeat,
    repeatUntil: v.repeat === "none" ? null : v.repeatUntil || null,
  })
}

/**
 * 開始日の変更に合わせて終了日・繰り返し終了日を**同じ日数だけシフト**する
 * （Google カレンダーと同じ「期間を保つ」挙動）。
 *
 * - 終了日: 常に追従する。終了日は空になりえない（初期値 = 開始日）ため
 *   `setRepeat` の「未入力なら補う・入力済みは尊重」は適用対象がない。ユーザーが
 *   終了日を編集して表明したのは**期間**であり、追従を止めると開始日を後ろへ
 *   動かした瞬間に「終了日 < 開始日」= 本 PR が塞ごうとしている不正状態が復活する。
 * - 繰り返し終了日: 未入力なら空のまま（`setRepeat` が種別選択時に補う責務を持つ）、
 *   入力済みなら同差分でシフトして「開始日より後」の不変条件を保つ。
 * - 開始日が空/不正形式のとき（入力途中・クリア）は差分を計算できないため
 *   依存フィールドには触れず、開始日だけを反映する。
 */
export function applyStartDateShift(
  prev: CalendarEventFormValue,
  nextStartDate: string,
): CalendarEventFormValue {
  if (!YMD_PATTERN.test(prev.startDate) || !YMD_PATTERN.test(nextStartDate)) {
    return { ...prev, startDate: nextStartDate }
  }
  const endDelta = daysBetweenYmd(prev.startDate, prev.endDate)
  const untilDelta = prev.repeatUntil
    ? daysBetweenYmd(prev.startDate, prev.repeatUntil)
    : null
  return {
    ...prev,
    startDate: nextStartDate,
    endDate: endDelta === null ? prev.endDate : shiftYmd(nextStartDate, endDelta),
    repeatUntil:
      untilDelta === null ? prev.repeatUntil : shiftYmd(nextStartDate, untilDelta),
  }
}
