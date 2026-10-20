/**
 * 授乳タイマーの端末保存（localStorage）の読み書き。
 *
 * タイマー本体（feeding-timer.tsx）と、ダッシュボードの「計測中」チップの両方が同じ
 * 保存を読むため、鍵・形・妥当性判定をここに一本化する。localStorage が使えぬ環境
 * （プライベートモード・容量不足・SSR）では読みは null、書きは false を返し、投げぬ。
 *
 * 保存の形（TimerState）は旧版との互換を保つ: counts / 左右秒 / 開始側 / 利用者 / 冪等 id
 * はいずれも後から足した optional で、欠けておれば復元側が退化させる。
 */

export const FEEDING_TIMER_STORAGE_KEY = "irori:feeding-timer"

/** これより古い開始時刻のタイマーは「停め忘れ」とみなす（無言では捨てぬ。P3-08） */
export const MAX_TIMER_AGE_MS = 2 * 60 * 60 * 1000

export type PersistedBreastSide = "breast_left" | "breast_right"

export interface PersistedTimerState {
  startedAt: string // ISO
  /** 現在吸わせている側。旧形式から復元できるようキー名は据え置く */
  feedingType: PersistedBreastSide
  leftCount?: number
  rightCount?: number
  leftSec?: number
  rightSec?: number
  sideSince?: string
  startSide?: PersistedBreastSide
  /**
   * 計測を始めた利用者（P3-08）。別の利用者でログインした端末では復元せず捨てる
   * （前の家族の授乳を別の名義で記録せぬ）。旧形式には無い（= 持ち主不明として受理）。
   */
  userId?: string
  /**
   * この計測の記録に使う冪等 id（P2-08）。停止→応答喪失→再停止で同じ id を送り、
   * サーバが主キー重複を「既に記録済み」として同じ id を返す。タイマー開始時に 1 回だけ作る。
   */
  clientId?: string
}

export function readPersistedTimer(): PersistedTimerState | null {
  try {
    const raw = localStorage.getItem(FEEDING_TIMER_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const state = parsed as Partial<PersistedTimerState>
    if (typeof state.startedAt !== "string") return null
    if (Number.isNaN(new Date(state.startedAt).getTime())) return null
    if (state.feedingType !== "breast_left" && state.feedingType !== "breast_right") {
      return null
    }
    return state as PersistedTimerState
  } catch {
    return null
  }
}

export function writePersistedTimer(state: PersistedTimerState): boolean {
  try {
    localStorage.setItem(FEEDING_TIMER_STORAGE_KEY, JSON.stringify(state))
    return true
  } catch (err) {
    // 容量不足・プライベートモード等。計測は画面上では続くが、リロードで消える。
    // 投げると停止ボタンの経路ごと落ちるゆえ握り、呼び出し側が利用者へ知らせる。
    console.warn("[feeding-timer] localStorage への保存に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

export function clearPersistedTimer(): void {
  try {
    localStorage.removeItem(FEEDING_TIMER_STORAGE_KEY)
  } catch {
    // 読めぬ・消せぬ環境では残っていても害は無い（復元時に捨てられる）
  }
}

/** 開始から MAX_TIMER_AGE_MS を超えたか。時計が戻って開始が未来の計測は stale ではない。 */
export function isTimerStale(startedAtIso: string, nowMs: number): boolean {
  const started = new Date(startedAtIso).getTime()
  if (Number.isNaN(started)) return true
  return nowMs - started >= MAX_TIMER_AGE_MS
}

/**
 * 保存されたタイマーが今の利用者のものか。userId を持たぬ旧形式は持ち主不明ゆえ
 * 受理する（捨てると、更新直後の 1 回だけ計測が消える）。
 */
export function belongsToUser(
  state: PersistedTimerState,
  userId: string,
): boolean {
  return state.userId === undefined || state.userId === userId
}
