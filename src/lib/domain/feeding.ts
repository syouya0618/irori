/**
 * 授乳タイマーの記録時間 (duration_min) を DB CHECK 制約の範囲へ
 * クランプする純関数。
 *
 * DB 側 CHECK 制約 (`20260411000003_phase3_1_constraints.sql`):
 *   duration_min IS NULL OR (log_type='feeding' AND duration_min BETWEEN 0 AND 180)
 *
 * 下限 1 はアプリ側の意図（0 分授乳を記録しない）、上限 180 は DB 制約。
 * Flutter 原典 (`baby_feeding_timer.dart:209` の `elapsedMin.clamp(1, 180)`) に
 * 忠実移植。走行中のライブタイマーは上限を持たず 3h 超が現実的に到達するため、
 * 181 分以上を DB CHECK 違反で記録失敗（タイマー恒久スタック）させず、
 * 180 で記録する救済。
 */

export const FEEDING_DURATION_MIN = 1
export const FEEDING_DURATION_MAX = 180

// 秒精度で保存する授乳時間（duration_sec）の範囲。分の上限 180 分と同値（180×60）。
export const FEEDING_DURATION_SEC_MIN = 1
export const FEEDING_DURATION_SEC_MAX = FEEDING_DURATION_MAX * 60 // 10800

/**
 * 経過分を [FEEDING_DURATION_MIN, FEEDING_DURATION_MAX] にクランプする。
 *
 * NaN / ±Infinity の防御は defense-in-depth（現状の唯一の呼出元は有限値を渡すが、
 * simplify 等で削るな）。Math.min/Math.max は NaN を伝播させるため、非有限な
 * durationMin がそのまま Server Action の wire に乗ると、DB CHECK を誤って
 * すり抜け（`IS NULL` 分岐で「duration の無い授乳行」を誤記録）たり、記録失敗させたり
 * しうる（sagyo_hyojun PR #8 learning）。ゆえに非有限値は最保守の下限へ倒す
 *（低値が最大値に化ける事故を避けるため床側）。
 */
export function clampFeedingDuration(elapsedMinutes: number): number {
  if (!Number.isFinite(elapsedMinutes)) return FEEDING_DURATION_MIN
  return Math.min(
    FEEDING_DURATION_MAX,
    Math.max(FEEDING_DURATION_MIN, Math.round(elapsedMinutes)),
  )
}

/**
 * 経過秒を [FEEDING_DURATION_SEC_MIN, FEEDING_DURATION_SEC_MAX] にクランプする。
 * clampFeedingDuration の秒精度版。非有限値の防御方針（最保守の下限へ倒す）も同じ。
 */
export function clampFeedingDurationSec(elapsedSeconds: number): number {
  if (!Number.isFinite(elapsedSeconds)) return FEEDING_DURATION_SEC_MIN
  return Math.min(
    FEEDING_DURATION_SEC_MAX,
    Math.max(FEEDING_DURATION_SEC_MIN, Math.round(elapsedSeconds)),
  )
}

/**
 * 母乳サイクルの左右別秒を DB CHECK（chk_breast_side_sec_total）が受理する形へ
 * 正規化する純関数。**合計を clamp してはならない** — duration_sec は常に
 * 「左右の和」で導出され（等式 CHECK）、合計側を丸めると和と食い違って記録が
 * 恒久失敗する（走行中タイマーは上限を持たず 3h 超が現実的に到達する —
 * clampFeedingDurationSec の docstring 参照）。ゆえに clamp は**側ごと**に行う:
 *
 * - 非有限値・負数は 0 へ（NaN が wire に乗って CHECK をすり抜けない）
 * - 合計が FEEDING_DURATION_SEC_MAX を超えたら側ごとに比例縮小し、丸め残差を
 *   大きい側へ寄せて**和を厳密に上限へ一致**させる
 * - 合計 0 は現在側へ 1 秒（即停止でも記録が通る下端救済 —
 *   clampFeedingDurationSec の下限 1 と同方針。タイマー恒久スタックの防止）
 */
export function resolveBreastSideSeconds(
  leftSec: number,
  rightSec: number,
  currentSide: "breast_left" | "breast_right",
): { leftSec: number; rightSec: number } {
  const sanitize = (v: number) =>
    Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0
  let left = sanitize(leftSec)
  let right = sanitize(rightSec)
  const total = left + right
  if (total < 1) {
    return currentSide === "breast_left"
      ? { leftSec: 1, rightSec: 0 }
      : { leftSec: 0, rightSec: 1 }
  }
  if (total > FEEDING_DURATION_SEC_MAX) {
    // 小さい側を floor で比例縮小し、残差を大きい側へ（和 = 上限 を厳密に保つ）
    if (left >= right) {
      right = Math.floor((right * FEEDING_DURATION_SEC_MAX) / total)
      left = FEEDING_DURATION_SEC_MAX - right
    } else {
      left = Math.floor((left * FEEDING_DURATION_SEC_MAX) / total)
      right = FEEDING_DURATION_SEC_MAX - left
    }
  }
  return { leftSec: left, rightSec: right }
}

/**
 * duration_sec から後方互換の duration_min（分丸め）を導出する単一の源。
 * サーバの記録（recordFeeding）と楽観 append（buildOptimisticLog）で共有し、
 * 両列の drift を防ぐ。null は「時間なしの授乳」を意味し duration_min も null。
 */
export function deriveDurationMinFromSec(
  durationSec: number | null | undefined,
): number | null {
  if (durationSec == null || !Number.isFinite(durationSec)) return null
  return Math.round(durationSec / 60)
}

/**
 * 授乳時間（duration）を持ちうる授乳タイプか（タイマー計測の対象 = 母乳のみ）。
 *
 * 引数は `FeedingType` ではなく**手書きの union** にしてある（enum drift 検出器）。
 * DB の feeding_type に値が増えたら tsc がここで落ち、「その新種別は時間を持つのか」を
 * 明示的に決めさせる。`FeedingType` へ広げると新値が黙って false に落ちるため広げるな。
 */
export function allowsDuration(type: "breast" | "breast_left" | "breast_right" | "bottle" | "solid" | "pumped"): boolean {
  // 'breast' はサイクル行（タイマー計測の本体）、breast_left/right は移行前の片側行
  return type === "breast" || type === "breast_left" || type === "breast_right"
}

/**
 * 編集シートの「時間（分・秒）」入力から duration_sec を組み立てる純関数。
 *
 * - 両方空 = null（時間なしの授乳へ戻す）。片方のみの入力は 0 補完。
 * - 数値でない・負・秒 59 超・合計が範囲外（1〜10800 秒 = 最大180分）はエラー。
 * - 合計 0 秒は「0 分授乳を記録しない」アプリ側の意図（clampFeedingDuration と同じ）に
 *   反するためエラーとし、時間を消したい場合は両方空にするよう促す。
 *
 * クライアント（編集シート）とテストで共有し、サーバ（updateLog）は組み立て後の
 * duration_sec を FEEDING_DURATION_SEC_MIN..MAX で再検証する（判定の二重防御）。
 */
export function parseFeedingDurationInput(
  minStr: string,
  secStr: string,
): { value: number | null; error: string | null } {
  const minTrim = minStr.trim()
  const secTrim = secStr.trim()
  if (minTrim === "" && secTrim === "") return { value: null, error: null }

  const min = minTrim === "" ? 0 : Number(minTrim)
  const sec = secTrim === "" ? 0 : Number(secTrim)
  if (!Number.isInteger(min) || !Number.isInteger(sec)) {
    return { value: null, error: "時間は整数で入力してください" }
  }
  if (min < 0 || sec < 0 || sec > 59) {
    return { value: null, error: "時間は 分0〜180・秒0〜59 で入力してください" }
  }
  const total = min * 60 + sec
  if (total === 0) {
    return {
      value: null,
      error: "時間は1秒以上で入力してください（時間なしにする場合は両方空欄に）",
    }
  }
  if (total > FEEDING_DURATION_SEC_MAX) {
    return { value: null, error: "時間は最大180分です" }
  }
  return { value: total, error: null }
}
