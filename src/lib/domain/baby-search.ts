import { isValidYmd } from "@/lib/utils/date-jst"
import { isTimestamptzText } from "@/lib/domain/timestamptz-text"
import type { BabyLogKeysetCursor } from "@/lib/domain/baby-log-keyset"
import type { BabyLogType } from "@/lib/types/database"

/**
 * 記録を探す（機能 B）の純粋な部分: クエリの読み取り・URL の組み立て・ILIKE の escape・
 * ページの cursor。問い合わせ本体は Server Component（baby/search/page.tsx）にある。
 *
 * 「全履歴」を名乗る以上、検索は読み込み済みの一日分ではなく DB 全体（世帯の境界の中）を
 * 対象にし、件数と範囲を示す。全件を毎回クライアントへ取らず、keyset でページを送る。
 */

export const SEARCH_PAGE_SIZE = 50
export const SEARCH_QUERY_MAX_LENGTH = 100

/** 絞り込む種類。`sleep` は廃止済みの旧種別ゆえ選択肢に出さぬ（行が残れば「すべて」で出る） */
export const SEARCH_KINDS = [
  "all",
  "feeding",
  "diaper",
  "temperature",
  "growth",
  "memo",
  "diary",
] as const
export type SearchKind = (typeof SEARCH_KINDS)[number]

export const SEARCH_KIND_LABELS: Record<SearchKind, string> = {
  all: "すべて",
  feeding: "授乳",
  diaper: "おむつ",
  temperature: "体温",
  growth: "成長記録",
  memo: "メモ",
  diary: "日記",
}

/** 記録のページ送り。PDF・JSON 書き出しと同じ (logged_at, id) の keyset（向きだけ降順） */
export type SearchCursor = BabyLogKeysetCursor

export interface BabySearchQuery {
  /** trim 済み・上限で切った検索語（空なら絞らぬ） */
  q: string
  kind: SearchKind
  /** 含む暦日（JST）。null は下限なし */
  from: string | null
  /** 含む暦日（JST）。null は上限なし（今日まで） */
  to: string | null
  /** 記録のページ送り（この行より前 = 古い側） */
  before: SearchCursor | null
  /** 日記のページ送り（この日より前） */
  beforeDate: string | null
}

export type SearchParamsInput = { [key: string]: string | string[] | undefined }

function str(params: SearchParamsInput, key: string): string | null {
  const v = params[key]
  return typeof v === "string" ? v : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isSearchKind(value: string | null): value is SearchKind {
  return value !== null && (SEARCH_KINDS as readonly string[]).includes(value)
}

/** `before=<logged_at>|<id>`。PostgREST が返した表記のまま運ぶ（Date に通すと秒未満が落ちる） */
export function encodeCursor(cursor: SearchCursor): string {
  return `${cursor.loggedAt}|${cursor.id}`
}

export function decodeCursor(raw: string | null): SearchCursor | null {
  if (!raw) return null
  const at = raw.indexOf("|")
  if (at < 0) return null
  const loggedAt = raw.slice(0, at)
  const id = raw.slice(at + 1)
  // URL から来た値は PostgREST の or 条件へ入る。形を確かめて引用符を壊す文字を通さぬ
  if (!isTimestamptzText(loggedAt) || !UUID_RE.test(id)) return null
  return { loggedAt, id }
}

/**
 * 検索条件を読む。不正な値は黙って既定へ倒す（検索は読み取りだけで、間違っても壊れぬ）。
 * from > to なら入れ替える。未来の to は今日へ丸める。
 */
export function parseBabySearchParams(
  params: SearchParamsInput,
  today: string,
): BabySearchQuery {
  const rawQ = str(params, "q") ?? ""
  const q = rawQ.trim().slice(0, SEARCH_QUERY_MAX_LENGTH)
  const kindRaw = str(params, "kind")
  const kind: SearchKind = isSearchKind(kindRaw) ? kindRaw : "all"
  let from = str(params, "from")
  let to = str(params, "to")
  if (!isValidYmd(from)) from = null
  if (!isValidYmd(to)) to = null
  if (to !== null && to > today) to = today
  if (from !== null && to !== null && from > to) [from, to] = [to, from]
  const beforeDateRaw = str(params, "before_date")
  return {
    q,
    kind,
    from,
    to,
    before: decodeCursor(str(params, "before")),
    beforeDate: isValidYmd(beforeDateRaw) ? beforeDateRaw : null,
  }
}

/** 検索結果の URL（ページ送りの cursor は上書きで足す） */
export function searchHref(
  query: Pick<BabySearchQuery, "q" | "kind" | "from" | "to">,
  page: { before?: SearchCursor | null; beforeDate?: string | null } = {},
): string {
  const sp = new URLSearchParams()
  if (query.q) sp.set("q", query.q)
  if (query.kind !== "all") sp.set("kind", query.kind)
  if (query.from) sp.set("from", query.from)
  if (query.to) sp.set("to", query.to)
  if (page.before) sp.set("before", encodeCursor(page.before))
  if (page.beforeDate) sp.set("before_date", page.beforeDate)
  const qs = sp.toString()
  return qs ? `/baby/search?${qs}` : "/baby/search"
}

/**
 * ILIKE のパターン。`%` `_` `\` は文字どおりに探す（利用者の「50%」が任意一致にならぬ）。
 * PostgREST の `ilike` は値をそのまま LIKE パターンとして渡すゆえ、escape はここで行う。
 * `*` は PostgREST が `%` の別名として先に置き換える（escape しても文字どおりにならぬ）
 * ため、検索語からは落とす。
 */
export function toIlikePattern(q: string): string {
  const escaped = q.replace(/\*/g, "").replace(/[\\%_]/g, (c) => `\\${c}`)
  return `%${escaped}%`
}

/** 検索語の表示用の切り出し（本文のどこで当たったかを示す） */
export function excerptAround(text: string, q: string, radius = 24): string {
  if (!q) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text
  const at = text.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return text.length > radius * 2 ? `${text.slice(0, radius * 2)}…` : text
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + q.length + radius)
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`
}

/** 記録の種類の絞り込みに使う log_type（`all` / `diary` は null） */
export function logTypeFor(kind: SearchKind): BabyLogType | null {
  switch (kind) {
    case "feeding":
    case "diaper":
    case "temperature":
    case "growth":
    case "memo":
      return kind
    default:
      return null
  }
}
