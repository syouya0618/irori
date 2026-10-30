/**
 * 入力の下書きの端末保存（2026-10-27 大型更新 テーマ B）。日記・長文メモ・予定フォームが共有する。
 *
 * **端末下書きはバックアップではない。** この端末のこのブラウザにだけ残り、ブラウザのデータ消去・
 * 別端末・別ブラウザでは戻らぬ。家族とも共有されぬ。勝手にクラウドへ送らぬ。保持は
 * DRAFT_TTL_MS（7 日）で、過ぎたものは読む時に捨てる（画面と docs/DESIGN_SYSTEM.md に明記）。
 *
 * 鍵は持ち主（userId・householdId）と対象（種別・id または日付）から作る。読む時は保存された
 * 持ち主・対象・schemaVersion を**中身でも**確かめ直す — 鍵の取り違え・手で弄られた値・旧版の形で、
 * 別の対象や別の利用者の本文を復元せぬため。
 *
 * localStorage が使えぬ環境（プライベートモード・容量不足・SSR）でも投げぬ。書けなんだ時は
 * 理由つきで `ok: false` を返す — 呼び出し側は「下書き保存済み」と表示してはならぬ。
 */

export const DRAFT_SCHEMA_VERSION = 1
export const DRAFT_KEY_PREFIX = "irori:draft:v1:"
/** 下書きの保持期間。過ぎたものは読む時に捨てる */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 端末の容量を食い潰さぬための 1 件の上限（文字数。日記 5000 字 + 余白） */
export const DRAFT_MAX_CHARS = 20_000

export interface DraftOwner {
  childId?: string
  userId: string
  householdId: string
}

/**
 * 下書きの対象。id を持つ既存の対象（予定の編集・育児ログのメモ編集）は id、日付で決まる対象
 * （その日の日記）は date、新規作成は kind だけ（＋任意の scope）で表す。
 */
export type DraftTarget =
  | { kind: "diary"; date: string }
  | { kind: "calendar-event"; id: string }
  | { kind: "calendar-event-new"; scope?: string }
  | { kind: "baby-log-memo"; id: string }
  | { kind: "baby-log-new"; scope?: string }

export interface DraftRecord<T> {
  schemaVersion: typeof DRAFT_SCHEMA_VERSION
  owner: DraftOwner
  target: DraftTarget
  /**
   * 下書きを始めた時点のサーバの版（updated_at の表記のまま。行が無い新規なら null）。
   * 復元した時、今のサーバの版と違えば衝突として示し、元の版を書き換えて自動で上書きせぬ。
   */
  baseVersion: string | null
  content: T
  createdAt: string
  updatedAt: string
}

export type DraftWriteResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "quota" | "too-large" | "unknown" }

export type DraftReadResult<T> =
  | { status: "none" }
  | { status: "found"; draft: DraftRecord<T> }
  /** 期限切れ・壊れた JSON・旧版の形・持ち主や対象の不一致。読んだ時に消してある */
  | { status: "discarded"; reason: "expired" | "corrupt" | "old-schema" | "mismatch" }
  | { status: "unavailable" }

function targetKey(target: DraftTarget): string {
  switch (target.kind) {
    case "diary":
      return `diary:${target.date}`
    case "calendar-event":
    case "baby-log-memo":
      return `${target.kind}:${target.id}`
    case "calendar-event-new":
    case "baby-log-new":
      return `${target.kind}:${target.scope ?? ""}`
  }
}

export function draftStorageKey(owner: DraftOwner, target: DraftTarget): string {
  return `${DRAFT_KEY_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId ? `child:${owner.childId}:` : ""}${targetKey(target)}`
}

function sameOwner(a: unknown, b: DraftOwner): boolean {
  if (typeof a !== "object" || a === null) return false
  const o = a as Record<string, unknown>
  return o.userId === b.userId && o.householdId === b.householdId && o.childId === b.childId
}

function sameTarget(a: unknown, b: DraftTarget): boolean {
  if (typeof a !== "object" || a === null) return false
  try {
    return targetKey(a as DraftTarget) === targetKey(b) && (a as DraftTarget).kind === b.kind
  } catch {
    return false
  }
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === "QuotaExceededError" || err.name === "NS_ERROR_DOM_QUOTA_REACHED")
  )
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // 消せぬ環境では残っていても読む時に捨てられる
  }
}

/**
 * 下書きを読む。`isContent` は本文の形の検証（呼び出し側の型）。形が合わねば捨てる。
 */
export function readDraft<T>(
  owner: DraftOwner,
  target: DraftTarget,
  isContent: (value: unknown) => value is T,
  nowMs: number = Date.now(),
): DraftReadResult<T> {
  const key = draftStorageKey(owner, target)
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return { status: "unavailable" }
  }
  if (raw === null) return { status: "none" }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safeRemove(key)
    return { status: "discarded", reason: "corrupt" }
  }
  if (typeof parsed !== "object" || parsed === null) {
    safeRemove(key)
    return { status: "discarded", reason: "corrupt" }
  }
  const rec = parsed as Record<string, unknown>
  if (rec.schemaVersion !== DRAFT_SCHEMA_VERSION) {
    safeRemove(key)
    return { status: "discarded", reason: "old-schema" }
  }
  if (!sameOwner(rec.owner, owner) || !sameTarget(rec.target, target)) {
    safeRemove(key)
    return { status: "discarded", reason: "mismatch" }
  }
  const updatedAtMs = typeof rec.updatedAt === "string" ? new Date(rec.updatedAt).getTime() : NaN
  if (Number.isNaN(updatedAtMs) || typeof rec.createdAt !== "string") {
    safeRemove(key)
    return { status: "discarded", reason: "corrupt" }
  }
  if (nowMs - updatedAtMs > DRAFT_TTL_MS) {
    safeRemove(key)
    return { status: "discarded", reason: "expired" }
  }
  if (!(rec.baseVersion === null || typeof rec.baseVersion === "string") || !isContent(rec.content)) {
    safeRemove(key)
    return { status: "discarded", reason: "corrupt" }
  }
  return { status: "found", draft: rec as unknown as DraftRecord<T> }
}

/**
 * 下書きを書く。既存の下書きがあれば createdAt を引き継ぐ。書けなんだ理由を返す（投げぬ）。
 */
export function writeDraft<T>(
  owner: DraftOwner,
  target: DraftTarget,
  baseVersion: string | null,
  content: T,
  now: Date = new Date(),
): DraftWriteResult {
  const key = draftStorageKey(owner, target)
  let createdAt = now.toISOString()
  try {
    const prev = localStorage.getItem(key)
    if (prev) {
      const p = JSON.parse(prev) as Partial<DraftRecord<T>>
      if (typeof p.createdAt === "string" && sameOwner(p.owner, owner)) createdAt = p.createdAt
    }
  } catch {
    // 読めぬ・壊れた前の下書きは引き継がぬ（上書きで直す）
  }
  const record: DraftRecord<T> = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    owner,
    target,
    baseVersion,
    content,
    createdAt,
    updatedAt: now.toISOString(),
  }
  let text: string
  try {
    text = JSON.stringify(record)
  } catch {
    return { ok: false, reason: "unknown" }
  }
  if (text.length > DRAFT_MAX_CHARS) return { ok: false, reason: "too-large" }
  try {
    localStorage.setItem(key, text)
    return { ok: true }
  } catch (err) {
    if (isQuotaError(err)) return { ok: false, reason: "quota" }
    // SecurityError（保存の無効化）・SSR の ReferenceError（localStorage が無い）
    if (
      err instanceof ReferenceError ||
      (err instanceof DOMException && err.name === "SecurityError")
    ) {
      return { ok: false, reason: "unavailable" }
    }
    return { ok: false, reason: "unknown" }
  }
}

/** 対象の下書きだけを消す（保存成功・明示の破棄）。他の対象・他の利用者の下書きには触れぬ。 */
export function discardDraft(owner: DraftOwner, target: DraftTarget): void {
  safeRemove(draftStorageKey(owner, target))
}

/** 端末の下書きの鍵を列挙する（読めぬ環境では空）。 */
function listDraftKeys(): string[] {
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(DRAFT_KEY_PREFIX)) keys.push(k)
    }
  } catch {
    return []
  }
  return keys
}

/**
 * 今の持ち主以外の下書きを消す（利用者・世帯の交代。CacheUserGuard が呼ぶ）。前の利用者の本文を
 * 今の利用者へ見せぬ・送らぬための掃除。今の持ち主の下書きは残す。
 */
export function purgeDraftsNotOwnedBy(owner: DraftOwner): number {
  const mine = `${DRAFT_KEY_PREFIX}${owner.userId}:${owner.householdId}:`
  let removed = 0
  for (const k of listDraftKeys()) {
    if (!k.startsWith(mine)) {
      safeRemove(k)
      removed++
    }
  }
  return removed
}

/** 今の持ち主の、期限内の下書きの件数（ログアウト・更新の前の案内に使う。本文は読まぬ）。 */
export function countOwnedDrafts(owner: DraftOwner, nowMs: number = Date.now()): number {
  const mine = `${DRAFT_KEY_PREFIX}${owner.userId}:${owner.householdId}:`
  let count = 0
  for (const k of listDraftKeys()) {
    if (!k.startsWith(mine)) continue
    try {
      const raw = localStorage.getItem(k)
      if (!raw) continue
      const rec = JSON.parse(raw) as Partial<DraftRecord<unknown>>
      const t = typeof rec.updatedAt === "string" ? new Date(rec.updatedAt).getTime() : NaN
      if (!Number.isNaN(t) && nowMs - t <= DRAFT_TTL_MS) count++
    } catch {
      // 壊れた下書きは数えぬ（読む時に捨てる）
    }
  }
  return count
}

/** 利用者向けの保持期間の文言（UI と文書で同じ表現を使う）。 */
export const DRAFT_RETENTION_NOTE =
  "下書きはこの端末のこのブラウザにだけ7日間残ります（バックアップではなく、家族とも共有されません）"

/** 書けなんだ時の利用者向けの文言。「下書き保存済み」とは言わぬ。 */
export function draftWriteFailureMessage(reason: Exclude<DraftWriteResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "quota":
      return "端末の空きが足りず、下書きを残せませんでした。閉じると入力が消えます"
    case "too-large":
      return "長すぎて下書きを残せませんでした。閉じると入力が消えます"
    default:
      return "この端末では下書きを残せません（プライベートブラウズ等）。閉じると入力が消えます"
  }
}
