/**
 * SSR直後に同じ育児ログをもう一度取得しないための、リクエスト単位の鮮度判定。
 *
 * - 完全なSSR結果が届いて10秒以内ならマウント時の重複refetchだけ省く。
 * - Realtimeの初回SUBSCRIBEDでは必ず再取得する。SSR→購読成立の隙間の
 *   配偶者の変更を拾う役割はそちらが持つ（この処理は触れない）。
 * - 戻る/進むで古いRSC payloadを再利用した時、取得に失敗した時、端末時計の
 *   ずれ・値の欠落を検出した時は従来どおりマウントで再取得する。
 * - 日付の許容窓は既存のNext dynamic staleTimes=10秒を拡大しない。
 */
export const INITIAL_BABY_SNAPSHOT_FRESH_MS = 10_000

export function shouldResyncBabyOnMount(
  snapshotAtMs: number | null | undefined,
  nowMs: number,
  initialReadFailed: boolean,
): boolean {
  if (initialReadFailed || snapshotAtMs == null) return true
  if (!Number.isFinite(snapshotAtMs) || !Number.isFinite(nowMs)) return true
  const ageMs = nowMs - snapshotAtMs
  return ageMs < 0 || ageMs > INITIAL_BABY_SNAPSHOT_FRESH_MS
}
