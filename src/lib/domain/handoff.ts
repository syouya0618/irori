/**
 * 「前回この端末で見てから」の引き継ぎの要約（2026-10-27 大型更新 テーマ C4）。
 *
 * 既存の育児ログ（読み込み済みの窓）だけから数える。新しいチャット・既読の監視・DB は作らぬ。
 *
 * 断定せぬこと（PRODUCT_SPEC C4）:
 * - `logged_by` は**作成した人**で、最後に直した人ではない（baby_logs に updated_by は無い）。
 *   ゆえに「更新のある記録」は誰が直したかを言わぬ
 * - 削除は窓の外へ消えるだけで検知できぬ。「削除なし」と言わぬ
 * - 家族が読んだか・担当を引き受けたかは記録に無い。言わぬ
 * - 読み込んでいる窓（直近 8 日）しか見ておらぬ。件数に範囲を添え、「全部で」と言わぬ
 *
 * 前回の確認の印は、**最後に取得に成功した時に見えておった最新の版**（DB が書いた updated_at の
 * 最大）を端末へ持ち主ごとに残す（端末の時計で比べると、時計のずれの分だけ数え違える）。
 * 楽観行の `created_at` は端末の時計ゆえ、利用者本人の行（logged_by が自分）として数えから外す。
 */
import type { BabyLogData } from "@/lib/types/baby"
import { shiftYmd } from "@/lib/utils/date-jst"

export const HANDOFF_KEY_PREFIX = "irori:handoff-seen:v1:"

export interface HandoffOwner {
  userId: string
  householdId: string
}

export function handoffStorageKey(owner: HandoffOwner): string {
  return `${HANDOFF_KEY_PREFIX}${owner.userId}:${owner.householdId}`
}

function isIsoText(v: unknown): v is string {
  return typeof v === "string" && v.length >= 10 && !Number.isNaN(new Date(v).getTime())
}

/** 前回の確認の印を読む（無い・壊れた・読めぬ環境は null = 初回扱い） */
export function readLastSeen(owner: HandoffOwner): string | null {
  try {
    const raw = localStorage.getItem(handoffStorageKey(owner))
    return isIsoText(raw) ? raw : null
  } catch {
    return null
  }
}

/** 前回の確認の印を書く（書けなんだら false。次回は初回扱いになるだけ） */
export function writeLastSeen(owner: HandoffOwner, iso: string): boolean {
  if (!isIsoText(iso)) return false
  try {
    localStorage.setItem(handoffStorageKey(owner), iso)
    return true
  } catch {
    return false
  }
}

/**
 * 予定の「この端末で見た」記録（2026-10-28 独立レビュー 2 周）。予定は**見た予定の id と、その時の版**を
 * 持つ — 時刻の閾値（最新の版・閲覧の時刻）で比べると、窓の外で作られて後から今日・明日に入った予定に
 * 「前回の確認後に追加」と時刻の前後を偽って出す。id と版なら時計に頼らず事実だけを言える:
 * - 見たことの無い id → 「この端末で初めて表示」（いつ作られたかは言わぬ）
 * - 見た時の版より新しい版 → 「前回の確認後に更新」（誰が直したかは言わぬ）
 */
export const HANDOFF_EVENTS_KEY_PREFIX = "irori:handoff-events-seen:v2:"
/** 見た予定の記録を残す日数（終わった予定は消す。端末の容量を食わぬ） */
const EVENTS_SEEN_KEEP_DAYS = 14

export type EventsSeen = Record<string, { u: string; d: string }>

function eventsStorageKey(owner: HandoffOwner): string {
  return `${HANDOFF_EVENTS_KEY_PREFIX}${owner.userId}:${owner.householdId}`
}

/** 見た予定の記録を読む（無い・壊れた・読めぬ環境は null = この端末では初めて） */
export function readEventsSeen(owner: HandoffOwner): EventsSeen | null {
  try {
    const raw = localStorage.getItem(eventsStorageKey(owner))
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
    const out: EventsSeen = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      const o = v as { u?: unknown; d?: unknown } | null
      if (o && isIsoText(o.u) && typeof o.d === "string") out[id] = { u: o.u, d: o.d }
    }
    return out
  } catch {
    return null
  }
}

/**
 * 今見えておる予定を記録に足して書く（前の記録と合わせる — 昨日「明日」で見た予定を今日「初めて」と
 * 言わぬ）。終わってから EVENTS_SEEN_KEEP_DAYS を過ぎた予定は消す。
 */
export function writeEventsSeen(
  owner: HandoffOwner,
  previous: EventsSeen | null,
  visible: readonly { id: string; end_date: string; updated_at?: string | null }[],
  todayYmd: string,
): boolean {
  const next: EventsSeen = {}
  const cutoff = shiftYmd(todayYmd, -EVENTS_SEEN_KEEP_DAYS)
  for (const [id, v] of Object.entries(previous ?? {})) {
    if (v.d >= cutoff) next[id] = v
  }
  for (const e of visible) {
    if (isIsoText(e.updated_at)) next[e.id] = { u: e.updated_at, d: e.end_date }
  }
  try {
    localStorage.setItem(eventsStorageKey(owner), JSON.stringify(next))
    return true
  } catch {
    return false
  }
}

/** 予定の印（記録が無い = この端末で初めての確認なら何も言わぬ） */
export function eventSeenMark(
  e: { id: string; updated_at?: string | null },
  seen: EventsSeen | null,
): "first-shown" | "updated" | null {
  if (!seen) return null
  const prev = seen[e.id]
  if (!prev) return "first-shown"
  const now = ms(e.updated_at)
  const then = ms(prev.u)
  return now !== null && then !== null && now > then ? "updated" : null
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * 今見えておる行の「最新の版」（updated_at の最大）。次回の比較の基準として残す。行が無ければ null
 * （呼び出し側は印を書かぬ — 初回扱いのまま）。
 */
export function latestSeenMark(rows: readonly BabyLogData[]): string | null {
  let best: string | null = null
  let bestMs = -Infinity
  for (const r of rows) {
    const t = ms(r.updated_at)
    if (t !== null && t > bestMs) {
      bestMs = t
      best = r.updated_at ?? null
    }
  }
  return best
}

export type HandoffSummary =
  /** この端末での前回の確認が無い（初回・印を残せぬ環境） */
  | { status: "first" }
  /** 窓の取得に失敗しておる（数えられぬ。0 件と言わぬ） */
  | { status: "failed" }
  | {
      status: "ok"
      /** 前回の確認の印（ISO） */
      since: string
      /** 前回の後に作られた、ほかの方が作成した記録 */
      newByOthers: number
      /** 前回の後に作られた、ご自身が作成した記録（楽観行を含む） */
      newByMe: number
      /** 前回より前に作られ、前回の後に更新された記録（誰が直したかは分からぬ） */
      updated: number
      /** 前回の確認が、読み込んでいる窓より前（窓の外の記録は数えておらぬ） */
      sinceBeforeWindow: boolean
    }

export interface HandoffInput {
  lastSeenAt: string | null
  /** 読み込んでいる窓の行（重複は id で畳む） */
  rows: readonly BabyLogData[]
  userId: string
  /** 窓の始まり（ISO。この時刻以降に記録された行を読み込んでおる） */
  windowStartIso: string
  /** 窓の取得に失敗しておるか */
  failed: boolean
}

export function summarizeHandoff(input: HandoffInput): HandoffSummary {
  if (input.failed) return { status: "failed" }
  const since = ms(input.lastSeenAt)
  if (since === null || input.lastSeenAt === null) return { status: "first" }
  const seen = new Set<string>()
  let newByOthers = 0
  let newByMe = 0
  let updated = 0
  for (const r of input.rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const created = ms(r.created_at)
    const upd = ms(r.updated_at)
    if (created !== null && created > since) {
      if (r.logged_by === input.userId) newByMe++
      else newByOthers++
    } else if (upd !== null && upd > since) {
      updated++
    }
  }
  const windowStart = ms(input.windowStartIso)
  return {
    status: "ok",
    since: input.lastSeenAt,
    newByOthers,
    newByMe,
    updated,
    sinceBeforeWindow: windowStart !== null && since < windowStart,
  }
}
