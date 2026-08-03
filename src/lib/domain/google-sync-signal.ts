/**
 * V7 の「同期完了シグナル」を扱う純関数（`google_connections.last_synced_at`）。
 *
 * **境界指令を持たぬ中立モジュール**である（`"use client"` も `"use server"` も
 * 付けてはならぬ）。Server Component / Server Action / client hook の三方から
 * import されるためじゃ。`sync-trigger.ts` に置いておくと `next/server` と
 * `createAdminClient` を巻き込むため、値だけをここへ分けてある。
 */

/**
 * ISO 文字列の最大値（null は「まだ無い」ゆえ最小として扱う）。
 *
 * 辞書順ではなく `Date.parse` で比べる: `last_synced_at` は PostgREST 越しに
 * `+00:00` 表記でも `Z` 表記でも来うるため、文字列比較では「同じ時刻の別表記」が
 * 誤って前進と見なされる。
 */
export function latestIsoTimestamp(
  values: readonly (string | null)[],
): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value === null) continue
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) continue
    if (ms > bestMs) {
      bestMs = ms
      best = value
    }
  }
  return best
}

/**
 * ポーリングの基準値から前進したか。
 *
 * `baseline === null`（一度も同期しておらぬ）なら、値が入った時点で前進じゃ。
 * 解釈不能な値は「前進しておらぬ」側へ倒す（誤 refetch より無反応を選ぶ。
 * 見逃しは次の可視化復帰（`useVisibilityRefetch`）が拾う）。
 */
export function hasSyncAdvanced(
  baseline: string | null,
  current: string | null,
): boolean {
  if (current === null) return false
  const currentMs = Date.parse(current)
  if (!Number.isFinite(currentMs)) return false
  if (baseline === null) return true
  const baselineMs = Date.parse(baseline)
  if (!Number.isFinite(baselineMs)) return true
  return currentMs > baselineMs
}
