import { isClientId } from "@/lib/utils/client-id"
import type { SaveOwner } from "@/lib/domain/save-attempt"

/**
 * 応答不明の作成（クイック記録・記録シート）の端末保持（2026-10-27 大型更新 A2 / AC06）。
 *
 * **送信キューではない。** ここに残すのは「押したが、保存できたか確かめられておらぬ」一つ一つの
 * 操作の送信内容で、利用者が画面から「確かめる」「同じ内容でもう一度送る」を選ぶためだけに使う。
 * 自動送信・復帰時の無人アップロード・Background Sync はせぬ（outbox 見送りを守る）。照合（読み）は
 * 画面を開いた時に自動で行ってよい — 書き込みではないため。
 *
 * 授乳タイマーは計測と送信内容を自分の端末保存（feeding-timer-storage）に持つゆえ、ここには入れぬ。
 *
 * 持ち主（userId・householdId）付き。読む時に持ち主で絞り、別の利用者・世帯の操作は見せも送りも
 * せぬ（利用者の交代では CacheUserGuard が消す）。保持は PENDING_SAVE_TTL_MS まで。
 */

/** 旧候補の配列形式。互換読みと、その操作を確定した時の削除だけに使う。 */
export const PENDING_SAVES_STORAGE_KEY = "irori:pending-saves:v1"
export const PENDING_SAVE_KEY_PREFIX = "irori:pending-saves:v2:"
export const PENDING_SAVE_SCHEMA_VERSION = 1
export const PENDING_SAVE_TTL_MS = 3 * 24 * 60 * 60 * 1000
/** 持ち主ごとの上限。新しい控えを書かずfalseを返し、未確定の古い控えを押し出さぬ。 */
export const PENDING_SAVES_MAX = 20

/** 送り直しに使う Server Action の名前（payload の形はその Action の入力そのもの） */
export type PendingSaveAction =
  | "recordFeeding"
  | "recordDiaper"
  | "recordTemperature"
  | "recordGrowth"
  | "recordMemo"

export interface PendingSave {
  schemaVersion: typeof PENDING_SAVE_SCHEMA_VERSION
  clientId: string
  owner: SaveOwner
  action: PendingSaveAction
  /** Action の入力そのもの（clientId を含む）。再送はこれを**そのまま**送る */
  payload: Record<string, unknown>
  /** 一覧に出す短い要約（例:「ミルク 160ml」）。本文・メモは入れぬ */
  summary: string
  firstAttemptAt: string
  /**
   * sending = 送信中（送る**前**に残す。応答の前に再読込・更新・ログアウトしても手がかりを失わぬ。
   * 独立レビュー 2026-10-28）。別のページ生存期間（再読込の後）で読んだ sending は結果不明と同じ
   */
  phase: "sending" | "unknown" | "conflict"
  /**
   * クイック記録の「同じ操作」の鍵（例: `feeding:bottle`）。再読込の後でも、期限内に同じ釦を
   * 押し直した時に同じ id を使うため（記録シートは持たぬ）
   */
  retryKey?: string
  /** sending を書いたページ生存期間の id（PAGE_LIFE_ID）。同じページの送信中は「確認中」に出さぬ */
  pageId?: string
  /** sending を書いた時刻（ISO）。別のタブで直近に送信中のものは「確認中」に出さぬ */
  sentAt?: string
  /**
   * 結果不明と分かった時刻（ISO）。クイック記録の押し直しの期限はここから測る（最初の押下から
   * 測ると、遅い失敗の後に「2分以内に押し直せば同じ記録」の約束が守れぬ。独立レビュー 2 周目）
   */
  unknownAt?: string
}

/** 別のタブで送信中の記録を「確認中」に出すまでの猶予（送信の最中の誤警告を出さぬ） */
export const OTHER_TAB_SENDING_GRACE_MS = 60_000

/**
 * このページ生存期間の id（モジュールの読み込みごと）。sending の記録が「いま送っておる最中」か
 * 「前のページ（再読込の前）の送信の名残 = 結果不明」かを分ける。
 */
export const PAGE_LIFE_ID: string =
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`

/** 同じタブ内の変更を知らせる DOM イベント名（storage イベントは他のタブにしか届かぬ） */
export const PENDING_SAVES_CHANGED_EVENT = "irori:pending-saves-changed"

/**
 * **安全の判定**: 先の送信がサーバで成立しておりうる（= 控えと id を捨ててはならぬ）か。このページで
 * いま送っておる最中のもの以外は全て「成立しておりうる」— 別のタブ・再読込の前の送信中を含む。
 * 猶予（表示の都合）をここへ持ち込まぬ（独立レビュー 3 周目 G1: 持ち込むと、再読込の直後の拒否で
 * 先の控えを捨て、次の押下が新しい id になって二重記録しうる）。
 */
export function mayHaveLanded(p: PendingSave): boolean {
  return !(p.phase === "sending" && p.pageId === PAGE_LIFE_ID)
}

/**
 * **表示の判定**: 「確認中」として利用者に見せる記録か。安全の判定に加え、別のタブで直近
 * （OTHER_TAB_SENDING_GRACE_MS 以内）に送信中のものは伏せる（送信の最中の誤警告を出さぬ）。猶予を
 * 過ぎても sending のままなら、そのタブが閉じられた・再読込された = 結果不明として出す。
 *
 * 時刻は `{ nowMs }` で渡す（位置引数の数にせぬ）: `array.filter(isAwaitingConfirmation)` と書くと
 * filter が添字を第 2 引数に渡し、時刻が 0 になって猶予の後も伏せたままになった（独立レビュー 3 周目
 * F1）。オブジェクトにしておけば、その書き方は型検査で落ちる。
 */
export function isAwaitingConfirmation(
  p: PendingSave,
  { nowMs = Date.now() }: { nowMs?: number } = {},
): boolean {
  if (!mayHaveLanded(p)) return false
  if (p.phase !== "sending") return true
  const sent = p.sentAt ? new Date(p.sentAt).getTime() : NaN
  return Number.isNaN(sent) || nowMs - sent >= OTHER_TAB_SENDING_GRACE_MS
}

/**
 * 表示の猶予が切れる最も早い時刻（epoch ms）。伏せておる控えがあれば、その時に一覧を読み直すため。
 * 無ければ null。
 */
export function nextVisibilityChangeAt(list: readonly PendingSave[], nowMs: number = Date.now()): number | null {
  let next: number | null = null
  for (const p of list) {
    if (!mayHaveLanded(p) || p.phase !== "sending" || !p.sentAt) continue
    const at = new Date(p.sentAt).getTime() + OTHER_TAB_SENDING_GRACE_MS
    if (Number.isNaN(at) || at <= nowMs) continue
    if (next === null || at < next) next = at
  }
  return next
}

const ACTIONS: readonly PendingSaveAction[] = [
  "recordFeeding",
  "recordDiaper",
  "recordTemperature",
  "recordGrowth",
  "recordMemo",
]

function parseOne(value: unknown): PendingSave | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== PENDING_SAVE_SCHEMA_VERSION) return null
  if (typeof v.clientId !== "string" || !isClientId(v.clientId)) return null
  const owner = v.owner as Record<string, unknown> | null
  if (typeof owner !== "object" || owner === null) return null
  if (typeof owner.userId !== "string" || typeof owner.householdId !== "string") return null
  if (!ACTIONS.includes(v.action as PendingSaveAction)) return null
  const payload = v.payload as Record<string, unknown> | null
  if (typeof payload !== "object" || payload === null) return null
  // 送信内容の id と記録の id は同じでなければならぬ（食い違えば別の操作の内容を送りうる）
  if (payload.clientId !== v.clientId) return null
  if (owner.childId !== undefined && (typeof owner.childId !== "string" || !isClientId(owner.childId) || payload.childId !== owner.childId)) return null
  if (typeof v.summary !== "string") return null
  if (typeof v.firstAttemptAt !== "string" || Number.isNaN(new Date(v.firstAttemptAt).getTime())) {
    return null
  }
  if (v.phase !== "sending" && v.phase !== "unknown" && v.phase !== "conflict") return null
  return {
    schemaVersion: PENDING_SAVE_SCHEMA_VERSION,
    clientId: v.clientId,
    owner: { userId: owner.userId, householdId: owner.householdId, ...(typeof owner.childId === "string" ? { childId: owner.childId } : {}) },
    action: v.action as PendingSaveAction,
    payload,
    summary: v.summary,
    firstAttemptAt: v.firstAttemptAt,
    phase: v.phase,
    ...(typeof v.retryKey === "string" ? { retryKey: v.retryKey } : {}),
    ...(typeof v.pageId === "string" ? { pageId: v.pageId } : {}),
    ...(typeof v.sentAt === "string" ? { sentAt: v.sentAt } : {}),
    ...(typeof v.unknownAt === "string" ? { unknownAt: v.unknownAt } : {}),
  }
}

export function pendingSaveKey(owner: SaveOwner, clientId: string): string {
  return `${PENDING_SAVE_KEY_PREFIX}${owner.userId}:${owner.householdId}:${clientId}`
}

export function isPendingSaveStorageKey(key: string | null): boolean {
  return key === null || key === PENDING_SAVES_STORAGE_KEY || key.startsWith(PENDING_SAVE_KEY_PREFIX)
}

function storedKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(PENDING_SAVE_KEY_PREFIX)) keys.push(key)
  }
  return keys
}

function readLegacy(): unknown[] {
  const raw = localStorage.getItem(PENDING_SAVES_STORAGE_KEY)
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function readAll(nowMs: number): PendingSave[] | null {
  try {
    const all = new Map<string, PendingSave>()
    for (const value of readLegacy()) {
      const entry = parseOne(value)
      if (entry) all.set(pendingSaveKey(entry.owner, entry.clientId), entry)
    }
    for (const key of storedKeys()) {
      const raw = localStorage.getItem(key)
      if (raw === null) continue
      let value: unknown
      try { value = JSON.parse(raw) } catch { continue }
      const entry = parseOne(value)
      // 鍵と持ち主・idが合わぬ値や、将来の版は読み飛ばす。他の控えには触れぬ。
      if (entry && pendingSaveKey(entry.owner, entry.clientId) === key) all.set(key, entry)
    }
    return [...all.values()]
      .filter((p) => nowMs - new Date(p.firstAttemptAt).getTime() <= PENDING_SAVE_TTL_MS)
      .sort((a, b) => a.firstAttemptAt.localeCompare(b.firstAttemptAt) || a.clientId.localeCompare(b.clientId))
  } catch {
    return null
  }
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PENDING_SAVES_CHANGED_EVENT))
}

function writeOne(entry: PendingSave): boolean {
  try {
    localStorage.setItem(pendingSaveKey(entry.owner, entry.clientId), JSON.stringify(entry))
    notify()
    return true
  } catch (err) {
    console.warn("[pending-saves] 端末保存に失敗", {
      message: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

function owns(p: PendingSave, owner: SaveOwner): boolean {
  return p.owner.userId === owner.userId && p.owner.householdId === owner.householdId && p.owner.childId === owner.childId
}

/** 今の持ち主の、期限内の応答不明の操作（古い順）。 */
export function listPendingSaves(owner: SaveOwner, nowMs: number = Date.now()): PendingSave[] {
  return (readAll(nowMs) ?? []).filter((p) => owns(p, owner))
}

/**
 * 応答不明の操作を残す（同じ clientId は置き換え）。書けなんだら false — 呼び出し側は
 * 「この端末に残した」とは言わぬ（画面を閉じると確かめる手がかりが消える、と伝える）。
 */
export function putPendingSave(entry: PendingSave, nowMs: number = Date.now()): boolean {
  const all = readAll(nowMs)
  if (all === null) return false
  if (!parseOne(entry)) return false
  const existing = all.find((p) => p.clientId === entry.clientId && owns(p, entry.owner))
  if (!existing && all.filter((p) => owns(p, entry.owner)).length >= PENDING_SAVES_MAX) return false
  // 同じ操作（同じ id）の控えが既に在れば、送信内容（payload・要約・最初の押下・鍵）は最初のまま
  // 保ち、状態だけを進める。結果不明の間に直した内容で送っても、先に保存されたかもしれぬのは最初の
  // 内容ゆえ、送り直し・照合は最初の内容で行う（独立レビュー 2 周目。後の内容は同じ id ゆえ、先が
  // 成立しておればサーバが conflict で止める）
  const merged: PendingSave = existing
    ? {
        ...entry,
        action: existing.action,
        payload: existing.payload,
        summary: existing.summary,
        firstAttemptAt: existing.firstAttemptAt,
        ...(existing.retryKey !== undefined ? { retryKey: existing.retryKey } : {}),
        // 結果不明と分かった時刻は、新しく分かった時だけ進める
        ...(entry.unknownAt === undefined && existing.unknownAt !== undefined
          ? { unknownAt: existing.unknownAt }
          : {}),
      }
    : entry
  // 作成ごとに1鍵。別タブのread→writeが重なっても、他の作成の控えを書き戻したり消したりせぬ。
  return writeOne(merged)
}

/** 確定（成功・照合で見つかった）・利用者の明示の取り下げで、その操作だけを消す。 */
export function removePendingSave(clientId: string, nowMs: number = Date.now()): void {
  const all = readAll(nowMs)
  if (all === null) return
  try {
    for (const entry of all.filter((p) => p.clientId === clientId)) {
      localStorage.removeItem(pendingSaveKey(entry.owner, entry.clientId))
    }
    // v1の控えも確定したIDだけを除く。現在の作成はv2へしか書かぬため、他IDの新しい控えに触れぬ。
    const legacy = readLegacy()
    const remaining = legacy.filter((value) => parseOne(value)?.clientId !== clientId)
    if (remaining.length !== legacy.length) {
      if (remaining.length === 0) localStorage.removeItem(PENDING_SAVES_STORAGE_KEY)
      else localStorage.setItem(PENDING_SAVES_STORAGE_KEY, JSON.stringify(remaining))
    }
    notify()
  } catch {
    // 読み書きできぬ時は他の控えを消す方へ倒さぬ。
  }
}

/** 今の持ち主以外の操作を消す（利用者・世帯の交代。前の利用者の操作を送らぬ・見せぬ）。 */
export function purgePendingSavesNotOwnedBy(owner: SaveOwner): void {
  try {
    const mine = `${PENDING_SAVE_KEY_PREFIX}${owner.userId}:${owner.householdId}:`
    for (const key of storedKeys()) {
      if (!key.startsWith(mine)) localStorage.removeItem(key)
    }
    const legacy = readLegacy()
    const remaining = legacy.filter((value) => {
      const entry = parseOne(value)
      return entry !== null && owns(entry, owner)
    })
    if (remaining.length !== legacy.length) {
      if (remaining.length === 0) localStorage.removeItem(PENDING_SAVES_STORAGE_KEY)
      else localStorage.setItem(PENDING_SAVES_STORAGE_KEY, JSON.stringify(remaining))
    }
    notify()
  } catch {
    // 保存領域が読めぬ時も、読む側の持ち主判定は必ず効く。
  }
}

export function countHouseholdPendingSaves(owner: SaveOwner, nowMs: number = Date.now()): number {
  return (readAll(nowMs) ?? []).filter(p => p.owner.userId === owner.userId && p.owner.householdId === owner.householdId).length
}
