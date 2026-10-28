/**
 * ログインメールの再送の間隔と、送信の期限（2026-10-27 大型更新 E3）。純粋な部分。
 *
 * - 送った（または結果が分からぬ）後は、同じ端末からの再送を一定の間あけさせる。実運用の
 *   送信回数の上限（Supabase の設定）は**推測せぬ** — ここの 60 秒は押し直しの連打を止める
 *   だけの端末側の間隔で、上限に当たらぬ保証ではない（上限の文言は auth-error-messages.ts）
 * - 送信は期限を持つ。`signInWithOtp` は AbortSignal を受けぬゆえ、期限との競争で待つのを
 *   やめる（要求そのものは取り消せぬ — 届いておればメールは出る。ゆえに結果不明として扱う）
 * - 端末に残すのは「最後に送った時刻」だけ（メールアドレスは保存せぬ）
 */

export const RESEND_COOLDOWN_SEC = 60
export const SIGN_IN_TIMEOUT_MS = 15_000
export const LAST_SEND_STORAGE_KEY = "irori:login-last-send:v1"

/** 次に送れるまでの残り秒（0 なら送れる）。時計が戻った時は待たせぬ */
export function cooldownRemainingSec(lastSentAtMs: number | null, nowMs: number): number {
  if (lastSentAtMs === null) return 0
  const elapsed = nowMs - lastSentAtMs
  if (elapsed < 0) return 0
  return Math.max(0, Math.ceil((RESEND_COOLDOWN_SEC * 1000 - elapsed) / 1000))
}

export function readLastSendAt(): number | null {
  try {
    const raw = sessionStorage.getItem(LAST_SEND_STORAGE_KEY)
    if (raw === null) return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function writeLastSendAt(ms: number): void {
  try {
    sessionStorage.setItem(LAST_SEND_STORAGE_KEY, String(ms))
  } catch {
    // 保存できぬ端末でも、画面の中では間隔を持つ
  }
}

export type TimedResult<T> = { kind: "done"; value: T } | { kind: "timeout" }

/** promise と期限の競争。期限が先なら timeout（promise は止められぬ — 結果は不明） */
export function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<TimedResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ kind: "timeout" }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve({ kind: "done", value })
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}
