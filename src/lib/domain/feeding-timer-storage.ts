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
  childId?: string
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
  /** 計測を始めた世帯（2026-10-27）。別世帯へ切り替えた端末では復元せぬ。旧形式には無い。 */
  householdId?: string
  /**
   * 「停止して記録」/「記録する」を押した時に固定した送信内容（2026-10-27 大型更新 A2）。
   * 結果が不明な間（応答の喪失・通信断）は、再送も再読込後の照合もこの内容をそのまま使う —
   * 押し直しのたびに開始時刻・経過秒を作り直すと、同じ id に別の内容を送ってサーバの照合に
   * 拒まれる（監査 F01）。成功の確定・確認済みの破棄で計測ごと消える。
   */
  submission?: PersistedFeedingSubmission
}

/**
 * 固定した授乳の送信内容。`payload` は recordFeeding の入力そのもの（clientId を含む）。
 * phase は端末に残す時点の状態: sending のまま再読込されたものは unknown として扱う。
 */
export interface PersistedFeedingSubmission {
  firstAttemptAt: string
  phase: "sending" | "unknown" | "conflict"
  payload: PersistedFeedingPayload
}

export interface PersistedFeedingPayload {
  childId?: string
  feedingType: "breast"
  breastLeftCount: number
  breastRightCount: number
  breastStartSide: "left" | "right" | null
  breastLeftSec?: number
  breastRightSec?: number
  durationSec?: number
  /**
   * 開始時刻。タイマーは開始時刻、手動記録は押した時刻をサーバの時計で推定した値（2026-10-28 N3）。
   * **無い**のは、手動記録で押した時刻をサーバの時計で推定できなかった時 — サーバが受け取った時刻
   * （DB の now()）で記録する。無いことも送信内容の一部として固定する（再送で後から時刻を足すと、
   * 先の送信が届いておった時に同じ id・別の内容となり照合に拒まれる）。
   */
  loggedAt?: string
  clientId: string
}

function isNonNegativeInt(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

/**
 * 端末保存の送信内容を検証する。形が崩れたもの（手で弄られた・旧版の書きかけ）は送らず
 * 捨てる（null）— 壊れた内容を「同じ内容の再送」として送ると、サーバが拒むか、もっと悪くは
 * 別の内容で記録してしまう。捨てても計測そのものは残り、利用者は改めて記録できる。
 */
export function parsePersistedSubmission(value: unknown): PersistedFeedingSubmission | null {
  if (typeof value !== "object" || value === null) return null
  const s = value as Record<string, unknown>
  if (typeof s.firstAttemptAt !== "string" || Number.isNaN(new Date(s.firstAttemptAt).getTime())) {
    return null
  }
  if (s.phase !== "sending" && s.phase !== "unknown" && s.phase !== "conflict") return null
  const p = s.payload as Record<string, unknown> | null
  if (typeof p !== "object" || p === null) return null
  if (p.feedingType !== "breast") return null
  if (!isNonNegativeInt(p.breastLeftCount) || !isNonNegativeInt(p.breastRightCount)) return null
  if (p.breastStartSide !== "left" && p.breastStartSide !== "right" && p.breastStartSide !== null) {
    return null
  }
  const hasSides = p.breastLeftSec !== undefined || p.breastRightSec !== undefined
  if (hasSides) {
    if (!isNonNegativeInt(p.breastLeftSec) || !isNonNegativeInt(p.breastRightSec)) return null
    if (p.durationSec !== undefined) return null
  } else if (!isNonNegativeInt(p.durationSec)) {
    return null
  }
  // 無い = サーバの受信時刻で記録する送信内容（上の注記）。在るなら妥当な時刻に限る
  if (
    p.loggedAt !== undefined &&
    (typeof p.loggedAt !== "string" || Number.isNaN(new Date(p.loggedAt).getTime()))
  ) {
    return null
  }
  if (typeof p.clientId !== "string" || p.clientId.length === 0) return null
  return {
    firstAttemptAt: s.firstAttemptAt,
    phase: s.phase,
    payload: {
      feedingType: "breast",
      breastLeftCount: p.breastLeftCount,
      breastRightCount: p.breastRightCount,
      breastStartSide: p.breastStartSide,
      ...(hasSides
        ? { breastLeftSec: p.breastLeftSec as number, breastRightSec: p.breastRightSec as number }
        : { durationSec: p.durationSec as number }),
      ...(typeof p.loggedAt === "string" ? { loggedAt: p.loggedAt } : {}),
      clientId: p.clientId,
      ...(typeof p.childId === "string" ? { childId: p.childId } : {}),
    },
  }
}

export function readPersistedTimer(childId?: string): PersistedTimerState | null {
  try {
    const raw = localStorage.getItem(childId ? `${FEEDING_TIMER_STORAGE_KEY}:${childId}` : FEEDING_TIMER_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return null
    const state = parsed as Partial<PersistedTimerState>
    if (typeof state.startedAt !== "string") return null
    if (Number.isNaN(new Date(state.startedAt).getTime())) return null
    if (state.feedingType !== "breast_left" && state.feedingType !== "breast_right") {
      return null
    }
    // 送信内容は形を確かめ直したものだけを残す（崩れておれば送信内容だけ捨て、計測は残す）
    const { submission: rawSubmission, ...rest } = state
    const submission =
      rawSubmission === undefined ? null : parsePersistedSubmission(rawSubmission)
    if (rawSubmission !== undefined && submission === null) {
      console.warn("[feeding-timer] 端末保存の送信内容が壊れていたため送信内容だけ捨てた")
    }
    return {
      ...(rest as PersistedTimerState),
      ...(submission ? { submission } : {}),
    }
  } catch {
    return null
  }
}

export function writePersistedTimer(state: PersistedTimerState): boolean {
  try {
    localStorage.setItem(state.childId ? `${FEEDING_TIMER_STORAGE_KEY}:${state.childId}` : FEEDING_TIMER_STORAGE_KEY, JSON.stringify(state))
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

export function clearPersistedTimer(childId?: string): void {
  try {
    localStorage.removeItem(childId ? `${FEEDING_TIMER_STORAGE_KEY}:${childId}` : FEEDING_TIMER_STORAGE_KEY)
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

/**
 * 保存されたタイマーが今の利用者・世帯のものか（2026-10-27）。世帯を持たぬ旧形式は利用者だけで
 * 判じる（belongsToUser と同じ理由）。世帯を持つなら一致を要する — 同じ利用者が世帯を移った
 * 端末で、前の世帯の計測・送信内容を今の世帯へ記録せぬ。
 */
/**
 * ダッシュボードのチップ用の要約（シートを開く前・再読込の後）。持ち主と世帯が違う保存は null
 * （他人・別世帯の計測を見せぬ）。pendingSave は「記録を押した後、保存を確かめられておらぬ」。
 */
export function summarizePersistedTimer(
  state: PersistedTimerState | null,
  owner: { userId: string; householdId: string; childId?: string },
  nowMs: number,
): {
  startedAt: string
  side: PersistedBreastSide
  stale: boolean
  pendingSave: boolean
} | null {
  if (!state || !belongsToOwner(state, owner)) return null
  const pendingSave =
    state.submission !== undefined && state.submission.payload.clientId === state.clientId
  return {
    startedAt: state.startedAt,
    side: state.feedingType,
    // 送った後の計測は停め忘れではない（送った内容は確定済み）
    stale: !pendingSave && isTimerStale(state.startedAt, nowMs),
    pendingSave,
  }
}

export function belongsToOwner(
  state: PersistedTimerState,
  owner: { userId: string; householdId: string; childId?: string },
): boolean {
  if (!belongsToUser(state, owner.userId) || state.childId !== owner.childId) return false
  return state.householdId === undefined || state.householdId === owner.householdId
}

/** Child timers share the existing account/household cleanup boundary. */
export function purgeChildTimers(owner?: { userId: string; householdId: string }): void {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(FEEDING_TIMER_STORAGE_KEY + ":")) continue
      const state = JSON.parse(localStorage.getItem(key) ?? "null") as PersistedTimerState | null
      if (!owner || !state || state.userId !== owner.userId || state.householdId !== owner.householdId) localStorage.removeItem(key)
    }
  } catch { /* unavailable storage is reported by the existing account guard */ }
}

export function ownedChildTimerIds(owner: { userId: string; householdId: string }): string[] {
  try {
    return Object.keys(localStorage).filter(k => k.startsWith(FEEDING_TIMER_STORAGE_KEY + ":"))
      .map(k => k.slice(FEEDING_TIMER_STORAGE_KEY.length + 1))
      .filter(id => { const s = readPersistedTimer(id); return s?.userId === owner.userId && s.householdId === owner.householdId })
  } catch { return [] }
}
