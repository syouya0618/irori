/**
 * 家事機能（ごみ・掃除・ごはん）の「結果不明の保存」の端末控え。世帯スコープ（子ども無し）。
 *
 * `sleep-pending.ts` を雛形にした平文 localStorage の控えじゃ。**送信キューではない** — 自動では
 * 何も送らぬ。利用者が押した一つの操作を、同じ操作 ID・同じ payload で確かめ直すためだけに残す
 * （契約の正本は `save-attempt.ts` 冒頭）。
 *
 * ## 鍵と持ち主
 * `irori:chore-request:v1:<userId>:<householdId>:<kind>:<操作ID>`。
 * - 読む時は鍵の持ち主で絞り、**中身の持ち主・種類・ID が鍵と一致すること**も確かめる（二重の防御）
 * - 持ち主交代での破棄は `CacheUserGuard` → `clearChorePendingForOtherOwner`
 * - 更新・ログアウト前の件数は `local-work.ts` → `listChorePending`
 *
 * ## 読めぬ控え
 * 壊れた JSON・未知の schema・未知の種類・持ち主の食い違いは**読まず、消さず**、件数だけ
 * `unreadable` として返す（「読めぬ」を「無い」と言い換えぬ。新しい版が書いた控えを古い版が
 * 捨てぬ）。捨てるのは利用者の明示操作（`discardUnreadableChorePending`）だけ。
 *
 * ## 操作 ID と行 ID
 * `id` は**操作**の ID（控えの鍵）。保存する行の ID は `payload` の中に、最初の操作の時点で
 * 1 回だけ作って入れる。再送は `payload` をそのまま送る。
 */
import { isRecord } from "@/lib/domain/child-sharing"
import { isClientId } from "@/lib/utils/client-id"

export const CHORE_PENDING_PREFIX = "irori:chore-request:v1:"

export const CHORE_KINDS = ["garbage", "cleaning", "meal"] as const
export type ChoreKind = (typeof CHORE_KINDS)[number]

export function isChoreKind(value: unknown): value is ChoreKind {
  return typeof value === "string" && (CHORE_KINDS as readonly string[]).includes(value)
}

/** 控えの持ち主（利用者と世帯の組）。どちらかが替われば別の持ち主。 */
export interface ChoreOwner {
  userId: string
  householdId: string
}

export type ChorePendingPhase = "sending" | "unknown"

export interface ChorePending<P extends object = Record<string, unknown>> {
  schema: 1
  /** 操作 ID（UUID）。最初の送信から結果の確定まで同じ値 */
  id: string
  owner: ChoreOwner
  kind: ChoreKind
  /** 利用者向けの短い説明（例: 「浴室の掃除を完了」）。秘密・長文を入れぬ */
  label: string
  /** Server Action へ送る値そのもの。再送はこれを**そのまま**送る */
  payload: P
  phase: ChorePendingPhase
  /** 最初の送信操作の時刻（ISO）。再送しても変えぬ */
  firstAttemptAt: string
}

export interface ChorePendingList {
  items: ChorePending[]
  /** 持ち主の鍵の下に在るが読めなんだ控えの件数（消しておらぬ） */
  unreadable: number
  /** 端末保存そのものを読めたか。false なら「控えが無い」とは言えぬ */
  storageReadable: boolean
}

/** 利用者向けの説明の上限（文字数）。 */
export const CHORE_PENDING_LABEL_MAX = 80
const LABEL_ELLIPSIS = "…"

/**
 * 説明を控えへ載せられる長さ（UTF-16 で `CHORE_PENDING_LABEL_MAX` 以内）へ切り詰める。
 *
 * 上限の検査（`snapshotChorePending`）は UTF-16 長で数える。説明を作る側は符号位置で数えるものが
 * 在り（絵文字 1 字は UTF-16 で 2）、長さの数え方の食い違いだけで保存そのものが止まっておった。
 * **送る側は必ずこれを通す** — 説明が長いことは、操作を拒む理由にならぬ。
 * 代理対の途中では切らぬ（壊れた文字を端末へ残さぬ）。空白だけの説明は空文字を返す。
 */
export function clipChorePendingLabel(label: string): string {
  const trimmed = label.trim()
  if (trimmed.length <= CHORE_PENDING_LABEL_MAX) return trimmed
  let out = ""
  // 符号位置ごとに足す（for...of は代理対を 1 字として返す）
  for (const char of trimmed) {
    if (out.length + char.length > CHORE_PENDING_LABEL_MAX - LABEL_ELLIPSIS.length) break
    out += char
  }
  return `${out.trimEnd()}${LABEL_ELLIPSIS}`
}

/** 1 件の控えの上限（JSON の文字数）。端末保存の容量を食い潰さぬ。 */
export const CHORE_PENDING_MAX_CHARS = 32_000
const MAX_DEPTH = 8

/** 持ち主の ID は鍵の区切り（`:`）を含まぬこと（UUID を想定）。含めば別の持ち主の接頭辞に化けうる。 */
function isOwnerId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !value.includes(":")
}

function isOwner(value: unknown): value is ChoreOwner {
  return isRecord(value) && isOwnerId(value.userId) && isOwnerId(value.householdId)
}

function ownerPrefix(owner: ChoreOwner): string {
  return `${CHORE_PENDING_PREFIX}${owner.userId}:${owner.householdId}:`
}

function storageKey(entry: Pick<ChorePending, "id" | "owner" | "kind">): string {
  return `${ownerPrefix(entry.owner)}${entry.kind}:${entry.id}`
}

/**
 * JSON として往復できる素の値だけを写し取る（null・真偽・有限の数・文字列・配列・素の object）。
 * `undefined` の項目は落とす（JSON でも落ちる。最初の送信と再送を同じ形にするため先に落とす）。
 * 関数・Date・クラスのインスタンス等が混ざれば `INVALID`。`toJSON` のような細工は関数ゆえ弾かれる。
 */
const INVALID = Symbol("invalid")
function plainJson(value: unknown, depth: number): unknown | typeof INVALID {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID
  if (depth >= MAX_DEPTH) return INVALID
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      const copied = plainJson(item, depth + 1)
      if (copied === INVALID) return INVALID
      out.push(copied)
    }
    return out
  }
  if (typeof value !== "object") return INVALID
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return INVALID
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    const copied = plainJson(item, depth + 1)
    if (copied === INVALID) return INVALID
    out[key] = copied
  }
  return out
}

/**
 * 控えを、文書化した項目だけで組み直す（任意の object graph・余分な項目を端末へ残さぬ）。
 * 形が合わねば null。**送信にもこの戻り値の `payload` を使うこと** — 最初の送信と、端末から
 * 復元した再送とが同じ内容になる。
 */
export function snapshotChorePending(value: unknown): ChorePending | null {
  if (!isRecord(value) || value.schema !== 1 || !isClientId(value.id) || !isOwner(value.owner)) return null
  if (!isChoreKind(value.kind)) return null
  if (typeof value.label !== "string") return null
  const label = value.label.trim()
  if (label.length === 0 || label.length > CHORE_PENDING_LABEL_MAX) return null
  if (value.phase !== "sending" && value.phase !== "unknown") return null
  if (typeof value.firstAttemptAt !== "string" || Number.isNaN(Date.parse(value.firstAttemptAt))) return null
  if (!isRecord(value.payload)) return null
  const payload = plainJson(value.payload, 0)
  if (payload === INVALID || !isRecord(payload)) return null
  return {
    schema: 1,
    id: value.id,
    owner: { userId: value.owner.userId, householdId: value.owner.householdId },
    kind: value.kind,
    label,
    payload,
    phase: value.phase,
    firstAttemptAt: value.firstAttemptAt,
  }
}

/** 保存された文字列を読む。鍵と中身（持ち主・種類・ID）が食い違えば読まぬ。 */
function parse(raw: string | null, key: string): ChorePending | null {
  if (raw === null) return null
  try {
    const entry = snapshotChorePending(JSON.parse(raw) as unknown)
    return entry && storageKey(entry) === key ? entry : null
  } catch {
    return null
  }
}

/** 接頭辞に合う鍵を列挙する（走査中に消しても添字がずれぬよう先に集める）。 */
function keysWithPrefix(prefix: string): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key !== null && key.startsWith(prefix)) keys.push(key)
  }
  return keys
}

/** 鍵の `<kind>` 部分。 */
function kindOfKey(key: string, prefix: string): string {
  const rest = key.slice(prefix.length)
  const end = rest.indexOf(":")
  return end === -1 ? rest : rest.slice(0, end)
}

/**
 * 持ち主の控えを読む。`kind` を渡せばその種類だけ（別の種類の読めぬ控えは数えぬ = ごはんの
 * 壊れた控えが掃除を塞がぬ）。渡さねば全種類（未知の種類の鍵は `unreadable` に数える）。
 */
export function listChorePending(owner: ChoreOwner, kind?: ChoreKind): ChorePendingList {
  const result: ChorePendingList = { items: [], unreadable: 0, storageReadable: true }
  if (!isOwner(owner)) return result
  try {
    const prefix = ownerPrefix(owner)
    for (const key of keysWithPrefix(prefix)) {
      if (kind !== undefined && kindOfKey(key, prefix) !== kind) continue
      const entry = parse(localStorage.getItem(key), key)
      if (entry) result.items.push(entry)
      else result.unreadable += 1
    }
  } catch {
    return { items: [], unreadable: 0, storageReadable: false }
  }
  result.items.sort((a, b) => a.firstAttemptAt.localeCompare(b.firstAttemptAt) || a.id.localeCompare(b.id))
  return result
}

/** 持ち主の、読める控えの件数（読めぬ控えの有無は `listChorePending` の `unreadable` を見よ）。 */
export function countChorePending(owner: ChoreOwner): number {
  return listChorePending(owner).items.length
}

/**
 * 控えを書く。戻り値は端末へ残せたか。
 *
 * - 同じ操作 ID の控えが既に在れば、**payload・説明・最初の時刻は最初のまま**にし、phase だけ進める
 *   （結果不明の間に内容を差し替えぬ）
 * - 同じ鍵に読めぬ値が在れば上書きせぬ（false）
 * - `onlyExisting` が true なら、鍵が既に消えていれば書かぬ（確定して消した控えを、遅れて届いた
 *   失敗が蘇らせぬ）
 */
export function putChorePending(entry: ChorePending, onlyExisting = false): boolean {
  const clean = snapshotChorePending(entry)
  if (!clean) return false
  const key = storageKey(clean)
  try {
    const raw = localStorage.getItem(key)
    let next = clean
    if (raw === null) {
      if (onlyExisting) return false
    } else {
      const existing = parse(raw, key)
      if (!existing) return false
      next = { ...existing, phase: clean.phase }
    }
    const text = JSON.stringify(next)
    if (text.length > CHORE_PENDING_MAX_CHARS) return false
    localStorage.setItem(key, text)
    return true
  } catch {
    return false
  }
}

export function removeChorePending(entry: Pick<ChorePending, "id" | "owner" | "kind">): void {
  if (!isOwner(entry.owner) || !isChoreKind(entry.kind) || !isClientId(entry.id)) return
  try {
    localStorage.removeItem(storageKey(entry))
  } catch {
    /* 消せなんだ控えは次に開いた時に同じ操作 ID で確かめ直せる */
  }
}

/** 今の持ち主**以外**の控えをすべて消す（利用者・世帯の交代。`CacheUserGuard` から呼ぶ）。 */
export function clearChorePendingForOtherOwner(owner: ChoreOwner): void {
  try {
    const mine = isOwner(owner) ? ownerPrefix(owner) : null
    for (const key of keysWithPrefix(CHORE_PENDING_PREFIX)) {
      if (mine === null || !key.startsWith(mine)) localStorage.removeItem(key)
    }
  } catch {
    /* 端末保存を触れぬ環境。読む側も持ち主で絞るゆえ、残っても別の持ち主には出ぬ */
  }
}

/**
 * 持ち主の**読めぬ**控えを捨てる（利用者の明示操作からだけ呼ぶ）。戻り値は捨てた件数。
 * 読める控えには触れぬ。
 */
export function discardUnreadableChorePending(owner: ChoreOwner, kind?: ChoreKind): number {
  if (!isOwner(owner)) return 0
  let removed = 0
  try {
    const prefix = ownerPrefix(owner)
    for (const key of keysWithPrefix(prefix)) {
      if (kind !== undefined && kindOfKey(key, prefix) !== kind) continue
      if (parse(localStorage.getItem(key), key)) continue
      localStorage.removeItem(key)
      removed += 1
    }
  } catch {
    /* 触れぬ環境では何も捨てられぬ */
  }
  return removed
}
