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
