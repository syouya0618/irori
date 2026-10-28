import { isClientId } from "@/lib/utils/client-id"
import { isReminderChoice, type ReminderChoice } from "@/lib/domain/event-reminder"
import type { CalendarEventFormValue } from "@/lib/domain/calendar-form"
import type { SaveOwner } from "@/lib/domain/save-attempt"
import { OTHER_TAB_SENDING_GRACE_MS, PAGE_LIFE_ID } from "@/lib/domain/pending-saves-storage"
import { discardDraft } from "@/lib/domain/draft-storage"

/**
 * 予定の作成の控え（2026-10-28 v9 / AC28）。送った作成ごと（冪等 id ごと）に 1 つ、端末に残す。
 *
 * **送信キューではない。** 残すのは「押したが、保存できたか確かめられておらぬ」作成の送信内容で、
 * 利用者が画面から「同じ内容でもう一度送る」「確認をやめる」を選ぶためだけに使う。自動送信はせぬ。
 *
 * v8 は予定の新規の下書きの 1 枠に送った作成も入れておったゆえ、2 件目の作成・破棄・成功が先の
 * 作成の唯一の手がかりを消し（P-B）、結果不明の後の拒否で「保存できなかった」に貼り替えた（T2）。
 * ここでは:
 * - **作成ごとに別の鍵**（`<prefix><userId>:<householdId>:<clientId>`）。1 本の配列を読んで書き戻さぬ
 *   — 2 つのタブが同時に書いても、互いの控えを後勝ちで消さぬ。消すのは自分の鍵だけ
 * - **送信内容（payload）は凍結**。最初に書いた内容から変えぬ（同じ id の送り直しは同じ内容だけ）
 * - **状態は単調**: 一度でも結果が分からなかった（例外・分類なしの失敗・送信中に画面が落ちた）作成は、
 *   後の送り直しがログイン切れ等で拒まれても「保存されておらぬ」へ戻さぬ（mayHaveLanded は戻らぬ）。
 *   拒否を「行は無い」と言えるのは、その id の送信が 1 度きりで、それが拒まれた時だけ
 * - 消すのは: 確定（成功・replayed・conflict = 行は在ると分かった）、利用者の明示の取り下げ、
 *   期限（CALENDAR_CREATE_TTL_MS）、持ち主の交代（CacheUserGuard）だけ
 *
 * 持ち主（userId・householdId）付き。読む時も持ち主・形・`payload.clientId === clientId` を確かめ、
 * 別の利用者・世帯の控えは見せも送りもせぬ。
 */

export const CALENDAR_CREATE_KEY_PREFIX = "irori:calendar-create:v1:"
export const CALENDAR_CREATE_SCHEMA_VERSION = 1
/** 保持期間（予定の下書きと同じ 7 日）。過ぎた控えは読む時に捨てる */
export const CALENDAR_CREATE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 持ち主ごとの上限。越えた新しい控えは端末に書かぬ（古い控えを押し出して消さぬ） */
export const CALENDAR_CREATES_MAX = 20
/** 同じタブの変更を知らせる DOM イベント名（storage イベントは他のタブにしか届かぬ） */
export const CALENDAR_CREATES_CHANGED_EVENT = "irori:calendar-creates-changed"

/** createCalendarEvent の入力そのもの（再送はこれを**そのまま**送る） */
export interface CalendarCreatePayload {
  title: string
  memo: string | null
  isAllDay: boolean
  startDate: string
  endDate: string
  startAt: string | null
  endAt: string | null
  repeat?: "daily" | "weekly" | "monthly"
  repeatUntil?: string
  clientId: string
}

/**
 * sending = 送信中（送る**前**に書く）/ unknown = 保存されたかもしれぬ /
 * rejected = 1 度きりの送信をサーバが保存の前に拒んだ（行は無い。入力を直して送り直せる）
 */
export type CalendarCreateStatus = "sending" | "unknown" | "rejected"

export interface CalendarPendingCreate {
  schemaVersion: typeof CALENDAR_CREATE_SCHEMA_VERSION
  owner: SaveOwner
  clientId: string
  payload: CalendarCreatePayload
  /** 「入力に戻る」（rejected の時だけ）でフォームへ戻す値 */
  formValue: CalendarEventFormValue
  /** 作成の後に付ける通知（押した時点の選択） */
  reminderChoice: ReminderChoice
  status: CalendarCreateStatus
  /** 一度でも結果が分からなかったか。真になったら確定まで戻さぬ */
  mayHaveLanded: boolean
  /** 最後に状態を書いたページ生存期間（PAGE_LIFE_ID） */
  pageId: string
  /** 最後の送信を始めた時刻（ISO） */
  sentAt: string
  firstAttemptAt: string
  /** 最後の拒否のサーバの文言（秘密・本文は入れぬ） */
  lastError?: string
}

export type CalendarCreateWrite = { entry: CalendarPendingCreate; persisted: boolean }

export function calendarCreateKey(owner: SaveOwner, clientId: string): string {
  return `${CALENDAR_CREATE_KEY_PREFIX}${owner.userId}:${owner.householdId}:${clientId}`
}

function ownerPrefix(owner: SaveOwner): string {
  return `${CALENDAR_CREATE_KEY_PREFIX}${owner.userId}:${owner.householdId}:`
}

const YMD = /^\d{4}-\d{2}-\d{2}$/
const REPEATS = ["daily", "weekly", "monthly"] as const

function isPayload(v: unknown, clientId: string): v is CalendarCreatePayload {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    o.clientId === clientId &&
    typeof o.title === "string" &&
    (o.memo === null || typeof o.memo === "string") &&
    typeof o.isAllDay === "boolean" &&
    typeof o.startDate === "string" &&
    YMD.test(o.startDate) &&
    typeof o.endDate === "string" &&
    YMD.test(o.endDate) &&
    (o.startAt === null || typeof o.startAt === "string") &&
    (o.endAt === null || typeof o.endAt === "string") &&
    (o.repeat === undefined ||
      (REPEATS.includes(o.repeat as (typeof REPEATS)[number]) && typeof o.repeatUntil === "string")) &&
    (o.repeat !== undefined || o.repeatUntil === undefined)
  )
}

function isFormValue(v: unknown): v is CalendarEventFormValue {
  if (typeof v !== "object" || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.title === "string" &&
    (o.memo === null || typeof o.memo === "string") &&
    typeof o.isAllDay === "boolean" &&
    typeof o.startDate === "string" &&
    typeof o.endDate === "string" &&
    typeof o.startTime === "string" &&
    typeof o.endTime === "string" &&
    (o.repeat === "none" || REPEATS.includes(o.repeat as (typeof REPEATS)[number])) &&
    typeof o.repeatUntil === "string"
  )
}

function isIso(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(new Date(v).getTime())
}

/** 端末から読んだ値を検証する。持ち主・鍵の id・形が合わねば null（読む側は捨てる）。 */
export function parseCalendarPendingCreate(
  value: unknown,
  owner: SaveOwner,
  clientId: string,
): CalendarPendingCreate | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  if (v.schemaVersion !== CALENDAR_CREATE_SCHEMA_VERSION) return null
  if (v.clientId !== clientId || !isClientId(v.clientId)) return null
  const o = v.owner as Record<string, unknown> | null
  if (typeof o !== "object" || o === null || o.userId !== owner.userId || o.householdId !== owner.householdId) {
    return null
  }
  if (!isPayload(v.payload, clientId) || !isFormValue(v.formValue)) return null
  if (!isReminderChoice(v.reminderChoice)) return null
  if (v.status !== "sending" && v.status !== "unknown" && v.status !== "rejected") return null
  if (typeof v.mayHaveLanded !== "boolean" || typeof v.pageId !== "string") return null
  if (!isIso(v.sentAt) || !isIso(v.firstAttemptAt)) return null
  // 結果が分からなかった作成を「拒否（行は無い）」として持つ形は作らぬ（単調の規則の裏の検証）
  if (v.status === "rejected" && v.mayHaveLanded) return null
  return {
    schemaVersion: CALENDAR_CREATE_SCHEMA_VERSION,
    owner: { userId: owner.userId, householdId: owner.householdId },
    clientId,
    payload: v.payload,
    formValue: v.formValue,
    reminderChoice: v.reminderChoice,
    status: v.status,
    mayHaveLanded: v.mayHaveLanded,
    pageId: v.pageId,
    sentAt: v.sentAt,
    firstAttemptAt: v.firstAttemptAt,
    ...(typeof v.lastError === "string" ? { lastError: v.lastError } : {}),
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    // 消せぬ環境では、読む時の検証と期限で捨てる
  }
}

function notify(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CALENDAR_CREATES_CHANGED_EVENT))
}

function expired(entry: CalendarPendingCreate, nowMs: number): boolean {
  return nowMs - new Date(entry.firstAttemptAt).getTime() > CALENDAR_CREATE_TTL_MS
}

/** 控えを直しかけた入力の下書き（拒まれた作成の「入力に戻る」。scope = その作成の id） */
function reworkDraftTarget(clientId: string) {
  return { kind: "calendar-event-new" as const, scope: clientId }
}

/**
 * 1 件を読む。無い・壊れた・期限切れ・持ち主違いは null（壊れた・期限切れは消す。期限切れは直しかけの
 * 下書きも一緒に消す — 控えが無ければ開く道が無い）。読めねば undefined。
 * この版より**新しい** schemaVersion の控えは消さずに読み飛ばす（更新の途中に古い版のタブが残っても、
 * 新しい版が持つ結果不明の作成の手がかりを消さぬ）
 */
export function readCalendarPendingCreate(
  owner: SaveOwner,
  clientId: string,
  nowMs: number = Date.now(),
): CalendarPendingCreate | null | undefined {
  const key = calendarCreateKey(owner, clientId)
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return undefined
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    safeRemove(key)
    return null
  }
  const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof version === "number" && version > CALENDAR_CREATE_SCHEMA_VERSION) return null
  const entry = parseCalendarPendingCreate(parsed, owner, clientId)
  if (!entry) {
    safeRemove(key)
    return null
  }
  if (expired(entry, nowMs)) {
    safeRemove(key)
    discardDraft(owner, reworkDraftTarget(clientId))
    return null
  }
  return entry
}

function ownedKeys(owner: SaveOwner): string[] {
  const prefix = ownerPrefix(owner)
  const keys: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(prefix)) keys.push(k)
    }
  } catch {
    return []
  }
  return keys
}

/** 今の持ち主の、期限内の控え（最初の押下の古い順）。読めぬ環境では空。 */
export function listCalendarPendingCreates(
  owner: SaveOwner,
  nowMs: number = Date.now(),
): CalendarPendingCreate[] {
  const prefix = ownerPrefix(owner)
  const out: CalendarPendingCreate[] = []
  for (const key of ownedKeys(owner)) {
    const entry = readCalendarPendingCreate(owner, key.slice(prefix.length), nowMs)
    if (entry) out.push(entry)
  }
  return out.sort((a, b) => a.firstAttemptAt.localeCompare(b.firstAttemptAt) || a.clientId.localeCompare(b.clientId))
}

function write(entry: CalendarPendingCreate): boolean {
  try {
    localStorage.setItem(calendarCreateKey(entry.owner, entry.clientId), JSON.stringify(entry))
    notify()
    return true
  } catch (err) {
    console.warn("[calendar-pending-creates] 端末に残せず", {
      name: err instanceof Error ? err.name : typeof err,
    })
    return false
  }
}

/** 送信を始める時の次の控え（純関数）。prev があれば送信内容・入力・通知・最初の押下を保つ（凍結）。 */
export function startCalendarCreateAttempt(
  prev: CalendarPendingCreate | null,
  args: {
    owner: SaveOwner
    clientId: string
    payload: CalendarCreatePayload
    formValue: CalendarEventFormValue
    reminderChoice: ReminderChoice
  },
  nowIso: string,
): CalendarPendingCreate {
  const entry: CalendarPendingCreate = prev
    ? {
        ...prev,
        status: "sending",
        // 先の送信が送信中（別のタブ・再読込の前）・結果不明なら、成立しておりうる
        mayHaveLanded: prev.mayHaveLanded || prev.status !== "rejected",
        pageId: PAGE_LIFE_ID,
        sentAt: nowIso,
      }
    : {
        schemaVersion: CALENDAR_CREATE_SCHEMA_VERSION,
        owner: { userId: args.owner.userId, householdId: args.owner.householdId },
        clientId: args.clientId,
        payload: { ...args.payload, clientId: args.clientId },
        formValue: args.formValue,
        reminderChoice: args.reminderChoice,
        status: "sending",
        mayHaveLanded: false,
        pageId: PAGE_LIFE_ID,
        sentAt: nowIso,
        firstAttemptAt: nowIso,
      }
  // 新しい送信の拒否の理由は、その送信の結果で書き直す
  delete entry.lastError
  return entry
}

/**
 * 送信の結果（成功以外）の後の控え（純関数）。
 * - unknown: 保存されたかもしれぬ（以後は単調）
 * - rejected: 先の送信が成立しておりうる（mayHaveLanded）なら unknown のまま理由だけ残す。
 *   そうでなければ rejected（行は無い）
 */
export function settleCalendarCreateOutcome(
  prev: CalendarPendingCreate,
  outcome: { kind: "unknown" } | { kind: "rejected"; message: string },
): CalendarPendingCreate {
  const base: CalendarPendingCreate = { ...prev, pageId: PAGE_LIFE_ID }
  if (outcome.kind === "unknown") {
    const entry: CalendarPendingCreate = { ...base, status: "unknown", mayHaveLanded: true }
    delete entry.lastError
    return entry
  }
  return base.mayHaveLanded
    ? { ...base, status: "unknown", lastError: outcome.message }
    : { ...base, status: "rejected", lastError: outcome.message }
}

/**
 * 送信を始める**前**に控えを書く（初回も送り直しも）。同じ id の控えが既に在れば、端末の控えを
 * 正本として凍結した内容を保つ（`known` は端末に書けなんだ時の画面の控え）。書けなんだら
 * persisted: false（呼び出し側は「端末に残した」と言わぬ）。
 */
export function beginCalendarCreateAttempt(
  args: {
    owner: SaveOwner
    clientId: string
    payload: CalendarCreatePayload
    formValue: CalendarEventFormValue
    reminderChoice: ReminderChoice
    known?: CalendarPendingCreate | null
  },
  now: Date = new Date(),
): CalendarCreateWrite {
  const stored = readCalendarPendingCreate(args.owner, args.clientId, now.getTime())
  const entry = startCalendarCreateAttempt(stored ?? args.known ?? null, args, now.toISOString())
  if (!isPayload(entry.payload, args.clientId)) return { entry, persisted: false }
  // 端末を読めぬ環境（プライベートブラウズ等）では書かぬ
  if (stored === undefined) return { entry, persisted: false }
  // 新しい控えは上限を越えて書かぬ（他の控えを押し出して消さぬ）
  if (stored === null && ownedKeys(args.owner).length >= CALENDAR_CREATES_MAX) {
    return { entry, persisted: false }
  }
  return { entry, persisted: write(entry) }
}

/**
 * 送信の結果（成功以外）を、端末に書いた控えへ書く。端末の控えを正本にする（別のタブの結果不明を拾う）。
 *
 * 端末を読めて控えが**消えておれば**（superseded）、書き戻さぬ。控えを消すのは、確定（別の送信の成功・
 * replayed・conflict = 行は在る）・利用者の「確認をやめる」・期限・持ち主の交代だけゆえ、どれの後でも
 * 遅れて届いた古い送信の結果で控えを蘇らせてはならぬ（独立レビュー v9rc1 PI-1: 遅れた rejected が
 * 「予定は作られていません」として蘇り、打ち直しで二重になった）。
 * 端末を読めぬ時は `known` から遷移を作り persisted: false（画面の間だけ握る）。
 */
export function settleCalendarCreateAttempt(
  known: CalendarPendingCreate,
  outcome: { kind: "unknown" } | { kind: "rejected"; message: string },
  now: Date = new Date(),
): CalendarCreateWrite & { superseded?: true } {
  const stored = readCalendarPendingCreate(known.owner, known.clientId, now.getTime())
  if (stored === null) return { entry: settleCalendarCreateOutcome(known, outcome), persisted: false, superseded: true }
  const entry = settleCalendarCreateOutcome(stored ?? known, outcome)
  if (stored === undefined) return { entry, persisted: false }
  return { entry, persisted: write(entry) }
}

/**
 * 端末に書けなんだ控え（このページの寿命 = 再読込まで）。持ち主つきで持ち、読む時に持ち主で絞る。
 * 画面（CalendarView）を作り直しても残し、ログアウト・更新の確認（local-work）からも数えられるよう、
 * 境界指令を持たぬこのモジュールに置く（独立レビュー v9rc2 RC2-2: 数えられず、更新の再読込で黙って消えた）
 */
const MEMORY_ONLY = new Map<string, CalendarPendingCreate>()

function sameOwnerAs(entry: CalendarPendingCreate, owner: SaveOwner): boolean {
  return entry.owner.userId === owner.userId && entry.owner.householdId === owner.householdId
}

export function getMemoryOnlyCalendarCreate(clientId: string): CalendarPendingCreate | null {
  return MEMORY_ONLY.get(clientId) ?? null
}
export function putMemoryOnlyCalendarCreate(entry: CalendarPendingCreate): void {
  MEMORY_ONLY.set(entry.clientId, entry)
}
export function dropMemoryOnlyCalendarCreate(clientId: string): void {
  MEMORY_ONLY.delete(clientId)
}
/** 持ち主の、端末に書けなんだ控え（このページの間だけ在る） */
export function listMemoryOnlyCalendarCreates(owner: SaveOwner): CalendarPendingCreate[] {
  return [...MEMORY_ONLY.values()].filter((e) => sameOwnerAs(e, owner))
}
/** 試験だけが使う: 端末に書けなんだ控えを空にする（再読込の模し） */
export function clearMemoryOnlyCalendarCreatesForTest(): void {
  MEMORY_ONLY.clear()
}

/** 確定（成功・replayed・conflict）・明示の取り下げで、その作成の控えだけを消す。 */
export function removeCalendarPendingCreate(owner: SaveOwner, clientId: string): void {
  safeRemove(calendarCreateKey(owner, clientId))
  notify()
}

/** 今の持ち主以外の控えを消す（利用者・世帯の交代。前の利用者の送信内容を見せぬ・送らぬ）。 */
export function purgeCalendarPendingCreatesNotOwnedBy(owner: SaveOwner): number {
  const mine = ownerPrefix(owner)
  const stale: string[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(CALENDAR_CREATE_KEY_PREFIX) && !k.startsWith(mine)) stale.push(k)
    }
  } catch {
    return 0
  }
  for (const k of stale) safeRemove(k)
  return stale.length
}

/** 端末に書けるか（書いて消す）。書けぬ環境で「残ります」と言わぬための確かめ。 */
export function probeLocalStorageWritable(): boolean {
  const key = "irori:probe:write"
  try {
    localStorage.setItem(key, "1")
    localStorage.removeItem(key)
    return true
  } catch {
    return false
  }
}

/**
 * 画面に出す状態。安全の判定（数える・送り直せる）と表示を分ける:
 * - in-flight: このページで今送っておる最中（釦を出さぬ）
 * - other-sending: 別のタブ・画面が直近に送信中（確認では数える。送り直しは同じ id・同じ内容ゆえ、
 *   並んでもサーバが replayed にして二重にならぬ — 画面は釦を出す。送信中に閉じられたタブとも区別できぬ）
 * - unknown: 保存されたかもしれぬ（猶予を過ぎた別のページの送信中を含む）
 * - rejected: 保存されておらぬ（入力を直して送り直せる）
 */
export type CalendarCreateDisplay = "in-flight" | "other-sending" | "unknown" | "rejected"

export function displayOfCalendarCreate(
  entry: CalendarPendingCreate,
  { nowMs = Date.now(), inFlight = false }: { nowMs?: number; inFlight?: boolean } = {},
): CalendarCreateDisplay {
  if (entry.status === "rejected") return "rejected"
  if (entry.status === "unknown") return inFlight ? "in-flight" : "unknown"
  if (inFlight) return "in-flight"
  const sent = new Date(entry.sentAt).getTime()
  if (entry.pageId !== PAGE_LIFE_ID && nowMs - sent < OTHER_TAB_SENDING_GRACE_MS) return "other-sending"
  // このページの sending で送信中でないもの・猶予を過ぎた別のページの sending は、結果不明と同じ
  return "unknown"
}

/** 別の作成を始める前に確かめるべき控えか（行が在りうる = rejected 以外の全て）。 */
export function mayExistOnServer(entry: CalendarPendingCreate): boolean {
  return entry.status !== "rejected"
}
