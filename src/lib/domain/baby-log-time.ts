import {
  daysBetweenYmd,
  isFutureIso,
  isValidYmd,
  toJstDateString,
} from "@/lib/utils/date-jst"

/**
 * baby ログの記録時刻（logged_at）の検証・変換を担う純関数群。
 * 記録時刻の編集/新規作成時の時刻指定で、クライアント（編集シート）と
 * サーバ（Server Action）が同一判定を共有するために切り出す。
 */

export const FUTURE_LOG_TIME_ERROR = "未来の時刻は記録できません"
export const INVALID_LOG_TIME_ERROR = "時刻を入力してください"

// 00:00〜23:59 のみ許容（"25:00" 等の範囲外を先に弾く）。
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * JST 日付("YYYY-MM-DD") + "HH:mm" を UTC の ISO 8601 へ変換する。
 * <input type="time"> が空/範囲外/不正日付を返した場合は null（呼び出し側でエラー表示）。
 * jstWallClockToIso と同じく +09:00 を明示構築し new Date('YYYY-MM-DD') の UTC 罠を回避する。
 * toISOString は不正 Date で throw するため、getTime() の NaN 判定で先に潰してから返す。
 */
export function jstDateTimeToIso(
  dateYmd: string,
  timeHm: string,
): string | null {
  if (!HHMM_RE.test(timeHm)) return null
  const d = new Date(`${dateYmd}T${timeHm}:00+09:00`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * 既存の記録時刻(ISO)を、JST の時・分・秒・ミリ秒を保ったまま別の JST 暦日へ動かす。
 * 編集で**日付だけ**を変えた時に使う — jstDateTimeToIso で組み直すと HH:mm 丸めで秒が
 * 無言に落ち、同じ分の記録の並びも崩れる（時刻を触らぬ編集で秒を保つ既存契約の日付版）。
 * JST は DST が無く 1 日が常に 24h ゆえ、暦日の差 × 24h の加算で壁時計が保たれる。
 * 記録時刻・日付が不正なら null（呼び出し側でエラー表示。黙って今の時刻へ倒さぬ）。
 * マイクロ秒は Date の精度（ミリ秒）までになる。
 */
export function moveLogTimeToJstDate(
  iso: string,
  dateYmd: string,
): string | null {
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms) || !isValidYmd(dateYmd)) return null
  const days = daysBetweenYmd(toJstDateString(iso), dateYmd)
  if (days === null) return null
  return new Date(ms + days * 86_400_000).toISOString()
}

/**
 * 記録時刻(ISO)を検証する。クライアント検証とサーバ Action の両方で使い判定を一致させる。
 * 不正 ISO・未来(+5 分の時計ずれ許容を超える)を日本語メッセージで拒否。妥当なら null。
 */
export function validateLogTime(iso: string, now?: Date): string | null {
  if (Number.isNaN(new Date(iso).getTime())) return INVALID_LOG_TIME_ERROR
  if (isFutureIso(iso, 5, now)) return FUTURE_LOG_TIME_ERROR
  return null
}
