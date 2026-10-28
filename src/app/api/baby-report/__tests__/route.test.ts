/**
 * baby-report route の**診断可能性**と**取得の完全性**の検証（I-15b / P1-07）。
 *
 * この route は「小児科の受診当日に PDF が出せずに詰む」導線じゃ。従前は失敗が
 * 三重に握り潰されていた:
 *   1. DB エラーを `logSupabaseError` を通さず 500 に潰していた
 *      → Supabase の error は class Error 非継承の plain object ゆえ、
 *        ログに残さねば真因は**永久に**分からない
 *   2. `.limit(5000)` に達しても無音で切り詰めていた
 *      → 「出せた PDF が実は全件ではない」は受診の判断材料そのものを歪める
 *   3. （P1-07）PostgREST は 1 応答を max_rows（supabase/config.toml と hosted 既定で
 *      1000）で黙って丸める。単発の `.limit(5001)` は実際には 1000 行しか返らず、
 *      昇順ゆえ**受診直前の数週間が欠け**、`length > 5000` の検知も構造上発火せなんだ
 *
 * ## fake の要点（3 を再現できねば赤にならぬ）
 * 旧 fake は要求件数をそのまま返したため max_rows を再現できなんだ。ここでは
 * PostgREST の部分集合をメモリ上で評価する builder を置き、**1 要求あたり
 * MAX_ROWS 行を超えては返さぬ**。ページの続きは route が送る `.or()` の cursor
 * からのみ導く（fake が自前で位置を覚えると、誤った cursor でも緑になる）。
 *
 * ここで固定するのは「壊れたときに気づけるか / 全件を集計へ渡せるか」であり、
 * PDF の中身の正しさ（集計）は baby-log-aggregation の担当じゃ。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getAuthContext = vi.fn()
const logSupabaseError = vi.fn()
const generateBabyReport = vi.fn()

vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))
vi.mock("@/lib/pdf/baby-report", () => ({
  generateBabyReport: (input: unknown) => generateBabyReport(input),
}))

import { GET, maxDuration } from "../route"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

/**
 * 種データの日付は**今日（JST）**を基準に置く。
 *
 * ⚠️ かつてここは `2026-08-01` を直書きしておった。route は period から
 * `shiftYmd(today, -7)` 等の**移動窓**を作って絞るため、実時刻が種から 7 日以上
 * 離れた日に**種が窓の外へ落ち、集計が 0 になって落ちる時限爆弾**じゃった
 * （2026-08-09 に実際に爆ぜ、main が赤くなった）。
 *
 * ゆえに窓の内側に必ず入る値を使い、期限切れを構造的に無くす。
 */
const TODAY_JST = todayJstString()

/** supabase/config.toml の `max_rows` と hosted の既定値。 */
const MAX_ROWS = 1000

type Row = Record<string, unknown>

// ── PostgREST の部分集合（fake）─────────────────────────────────────────

/**
 * timestamptz 文字列 → epoch マイクロ秒。PostgREST は logged_at を
 * `2026-10-02T01:23:45.123456+00:00` のように**マイクロ秒まで**返す。
 * `Date` は ms で丸めるゆえ、cursor を Date に通す実装はここで同値判定を外す。
 */
function toMicros(ts: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts)
  if (!m) throw new Error(`fake: timestamptz として読めぬ値: ${ts}`)
  // 秒までを Date で読み（小数部を外すゆえ ms は 000）、小数部 6 桁をそのまま足す
  const wholeSecondsMs = Date.parse(`${m[1]}${m[3]}`)
  return BigInt(wholeSecondsMs) * BigInt(1000) + BigInt((m[2] ?? "").padEnd(6, "0"))
}

function compare(column: string, a: unknown, b: unknown): number {
  if (column === "logged_at") {
    const x = toMicros(String(a))
    const y = toMicros(String(b))
    return x < y ? -1 : x > y ? 1 : 0
  }
  // uuid の比較は正準形（小文字 hex）の文字列順と一致する
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

type Predicate = (row: Row) => boolean

function opPredicate(column: string, op: string, value: string): Predicate {
  switch (op) {
    case "eq":
      return (r) => compare(column, r[column], value) === 0
    case "gt":
      return (r) => compare(column, r[column], value) > 0
    case "gte":
      return (r) => compare(column, r[column], value) >= 0
    case "lt":
      return (r) => compare(column, r[column], value) < 0
    case "lte":
      return (r) => compare(column, r[column], value) <= 0
    default:
      throw new Error(`fake: 未対応の演算子 ${op}`)
  }
}

/** 括弧の外にあるカンマで分割する（PostgREST の論理木の項）。 */
function splitTopLevel(expr: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let cur = ""
  for (const c of expr) {
    if (c === '"') quoted = !quoted
    if (!quoted && c === "(") depth++
    if (!quoted && c === ")") depth--
    if (!quoted && c === "," && depth === 0) {
      parts.push(cur)
      cur = ""
      continue
    }
    cur += c
  }
  parts.push(cur)
  return parts
}

/** `col.op.value` / `and(...)` / `or(...)` を述語へ。値は `"..."` で囲まれていてもよい。 */
function parseLogic(term: string): Predicate {
  const nested = /^(and|or)\((.*)\)$/.exec(term)
  if (nested) {
    const children = splitTopLevel(nested[2]).map(parseLogic)
    return nested[1] === "and"
      ? (r) => children.every((p) => p(r))
      : (r) => children.some((p) => p(r))
  }
  const m = /^([a-z_]+)\.([a-z]+)\.(.*)$/.exec(term)
  if (!m) throw new Error(`fake: 論理木の項として読めぬ: ${term}`)
  const value = m[3].startsWith('"') && m[3].endsWith('"') ? m[3].slice(1, -1) : m[3]
  return opPredicate(m[1], m[2], value)
}

interface LogsRequest {
  limit: number | null
  or: string | null
  orders: string[]
  returned: number
}

/**
 * baby_logs の builder。thenable で、await された時点で 1 要求として評価する。
 * 返す行数は `min(要求件数, MAX_ROWS)`（max_rows は**黙って**丸める = 実 PostgREST）。
 */
function makeLogsQuery(
  dataset: Row[],
  maxRows: number,
  execute: (evaluate: () => Row[], meta: Omit<LogsRequest, "returned">) => {
    data: Row[] | null
    error: unknown
  },
) {
  let columns: string[] = []
  const filters: Predicate[] = []
  const orders: { column: string; ascending: boolean }[] = []
  let limitN: number | null = null
  let offset = 0
  let orExpr: string | null = null

  const evaluate = () => {
    const matched = dataset.filter((r) => filters.every((p) => p(r)))
    const sorted = [...matched].sort((a, b) => {
      for (const o of orders) {
        const c = compare(o.column, a[o.column], b[o.column])
        if (c !== 0) return o.ascending ? c : -c
      }
      return 0
    })
    const cap = Math.min(limitN ?? Number.POSITIVE_INFINITY, maxRows)
    // select に無い列は返さぬ（cursor 用の id を select し忘れた実装を落とす）。
    return sorted
      .slice(offset, offset + cap)
      .map((r) => Object.fromEntries(columns.map((c) => [c, r[c] ?? null])))
  }

  const builder = {
    select(cols: string) {
      columns = cols.split(",").map((c) => c.trim())
      return builder
    },
    eq(column: string, value: string) {
      filters.push((r) => r[column] === value)
      return builder
    },
    gte(column: string, value: string) {
      filters.push(opPredicate(column, "gte", value))
      return builder
    },
    lt(column: string, value: string) {
      filters.push(opPredicate(column, "lt", value))
      return builder
    },
    or(expr: string) {
      orExpr = expr
      const p = parseLogic(`or(${expr})`)
      filters.push(p)
      return builder
    },
    order(column: string, opts: { ascending?: boolean } = {}) {
      orders.push({ column, ascending: opts.ascending ?? true })
      return builder
    },
    limit(n: number) {
      limitN = n
      return builder
    },
    range(from: number, to: number) {
      offset = from
      limitN = to - from + 1
      return builder
    },
    then<T>(
      onFulfilled: (v: { data: Row[] | null; error: unknown }) => T,
      onRejected?: (e: unknown) => T,
    ) {
      return Promise.resolve()
        .then(() =>
          execute(evaluate, {
            limit: limitN,
            or: orExpr,
            orders: orders.map((o) => `${o.column}.${o.ascending ? "asc" : "desc"}`),
          }),
        )
        .then(onFulfilled, onRejected)
    },
  }
  return builder
}

/**
 * households / baby_logs の 2 系統を返す最小 Supabase モック。
 * `requests` に baby_logs への各要求（limit / or / order / 返却行数）を記録する。
 */
function makeSupabase(opts: {
  household?: { data: Row | null; error: unknown }
  logs?: Row[]
  /** n 回目（1 始まり）の baby_logs 要求を error で返す */
  failLogsOnRequest?: { n: number; error: unknown }
  /** サーバの max_rows（既定 1000）。設定変更・プラン差でページ長より小さい環境を模す */
  maxRows?: number
}) {
  const householdResult = opts.household ?? {
    data: { baby_name: "みかん", baby_birth_date: "2026-01-01" },
    error: null,
  }
  const dataset = opts.logs ?? []
  const requests: LogsRequest[] = []

  const client = {
    requests,
    from(table: string) {
      if (table === "households") {
        return {
          select: () => ({
            eq: () => ({ single: async () => householdResult }),
          }),
        }
      }
      if (table !== "baby_logs") throw new Error(`fake: 未知のテーブル ${table}`)
      return makeLogsQuery(dataset, opts.maxRows ?? MAX_ROWS, (evaluate, meta) => {
        const n = requests.length + 1
        if (opts.failLogsOnRequest?.n === n) {
          requests.push({ ...meta, returned: 0 })
          return { data: null, error: opts.failLogsOnRequest.error }
        }
        const rows = evaluate()
        requests.push({ ...meta, returned: rows.length })
        return { data: rows, error: null }
      })
    },
  }
  return client
}

// ── 種データ ───────────────────────────────────────────────────────────

/** 順序が時刻と無関係な uuid（同時刻の行の並びを id で決めねば崩れるように）。 */
function uuidFor(i: number): string {
  const n = (i * 7919) % 1_000_003
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
}

/** JST の日付 + 分 + マイクロ秒 → PostgREST が返す形の timestamptz 文字列。 */
function pgTimestamp(ymd: string, minuteOfDay: number, micro = 0): string {
  const ms = Date.parse(`${ymd}T00:00:00+09:00`) + minuteOfDay * 60_000
  const iso = new Date(ms).toISOString() // 2026-10-02T01:23:00.000Z
  return `${iso.slice(0, 19)}.${String(micro).padStart(6, "0")}+00:00`
}

/** startDate..TODAY_JST に均等に散らした diaper 行を n 件作る（最終日にも必ず行が在る）。 */
function diaperRowsAcross(startDate: string, days: number, n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const day = Math.floor((i * days) / n)
    const ymd = shiftYmd(startDate, day)
    return {
      id: uuidFor(i),
      household_id: "house-1",
      log_type: "diaper",
      diaper_type: "pee",
      logged_at: pgTimestamp(ymd, (i % 25) * 40, i % 1000),
    }
  })
}

/** 全行が同一時刻（マイクロ秒まで同じ）の diaper 行。keyset の同値処理を試す。 */
function diaperRowsAtSameInstant(n: number): Row[] {
  const at = pgTimestamp(TODAY_JST, 0, 123456)
  return Array.from({ length: n }, (_, i) => ({
    id: uuidFor(i),
    household_id: "house-1",
    log_type: "diaper",
    diaper_type: "pee",
    logged_at: at,
  }))
}

function req(period = "1week") {
  return new Request(`https://example.test/api/baby-report?period=${period}`)
}

beforeEach(() => {
  getAuthContext.mockReset()
  logSupabaseError.mockReset()
  generateBabyReport.mockReset()
  generateBabyReport.mockResolvedValue(Buffer.from("%PDF-1.4 fake"))
})

/** 認証済み・世帯ありの文脈を返す */
function authOk(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: "house-1" },
  })
}

/** generateBabyReport に渡った diapers の日別行 */
function reportedDiapers(): { date: string; totalCount: number }[] {
  const input = generateBabyReport.mock.calls[0][0] as {
    diapers: { date: string; totalCount: number }[]
  }
  return input.diapers
}

function reportedDiaperTotal(): number {
  return reportedDiapers().reduce((s, d) => s + d.totalCount, 0)
}

describe("baby-report: 失敗時に真因がログへ残る（握り潰さない）", () => {
  it("households の取得失敗を logSupabaseError で構造化ログに残してから 500", async () => {
    const supabase = makeSupabase({
      household: {
        data: null,
        error: { message: "connection reset", code: "08006" },
      },
    })
    authOk(supabase)

    const res = await GET(req())

    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-report",
      "household lookup failed",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({ householdId: "house-1", period: "1week" }),
    )
  })

  it("baby_logs の取得失敗も同様に残す（期間も文脈に含める）", async () => {
    const supabase = makeSupabase({
      failLogsOnRequest: { n: 1, error: { message: "statement timeout", code: "57014" } },
    })
    authOk(supabase)

    const res = await GET(req("3months"))

    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-report",
      "baby_logs lookup failed",
      expect.objectContaining({ message: "statement timeout" }),
      expect.objectContaining({ householdId: "house-1", period: "3months" }),
    )
    expect(generateBabyReport).not.toHaveBeenCalled()
  })

  it("正常時は logSupabaseError を呼ばない（ログを異常だけに保つ）", async () => {
    authOk(makeSupabase({}))
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(logSupabaseError).not.toHaveBeenCalled()
  })
})

describe("baby-report: max_rows=1000 の下でも全件を集計へ渡す（P1-07）", () => {
  it("3ヶ月 2300 行（新生児期の典型量）を全件集計し、最終日（今日）の行を落とさぬ", async () => {
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({ logs: diaperRowsAcross(startDate, 91, 2300) })
    authOk(supabase)

    const res = await GET(req("3months"))

    expect(res.status).toBe(200)
    // 単発の limit では最古の 1000 行で止まり、受診直前の数週間が欠ける
    expect(reportedDiaperTotal()).toBe(2300)
    const diapers = reportedDiapers()
    expect(diapers[diapers.length - 1].date).toBe(TODAY_JST)
    expect(diapers[0].date).toBe(startDate)
    // 全件取れたなら切り詰めではない
    expect(res.headers.get("X-Report-Truncated")).toBeNull()
    expect(generateBabyReport).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: false }),
    )
    // 個人データの PDF は中間・端末のキャッシュに残さぬ（E2: JSON と同じ no-store）
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect(res.headers.get("Content-Type")).toBe("application/pdf")
  })

  it("各要求は max_rows 以下・(logged_at, id) の昇順で、(logged_at, id) の cursor で続きを引く", async () => {
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({ logs: diaperRowsAcross(startDate, 91, 2300) })
    authOk(supabase)

    await GET(req("3months"))

    const { requests } = supabase
    expect(requests.length).toBeGreaterThan(1)
    for (const r of requests) {
      expect(r.limit).not.toBeNull()
      expect(r.limit!).toBeLessThanOrEqual(MAX_ROWS)
      expect(r.orders).toEqual(["logged_at.asc", "id.asc"])
    }
    // 1 枚目に cursor は無く、2 枚目以降は必ず cursor を持つ（offset で引いておらぬ）。
    // 値は PostgREST の docs どおり二重引用符で囲む（timestamptz は予約文字 `.` `:` を含む）。
    expect(requests[0].or).toBeNull()
    for (const r of requests.slice(1)) {
      expect(r.or).toMatch(
        /^logged_at\.gt\."[^"]+",and\(logged_at\.eq\."[^"]+",id\.gt\."[^"]+"\)$/,
      )
    }
  })

  it("999 行はデータページ 1 枚 + 空ページ 1 枚で終わる（短いページを終端と見なさぬ）", async () => {
    const supabase = makeSupabase({ logs: diaperRowsAcross(TODAY_JST, 1, 999) })
    authOk(supabase)

    await GET(req())

    // max_rows がページ長より小さい環境では「短い = 最後」とは限らぬ。終端は 0 件でのみ判定する。
    expect(supabase.requests.map((r) => r.returned)).toEqual([999, 0])
    expect(reportedDiaperTotal()).toBe(999)
  })

  it("max_rows がページ長より小さい環境（300）でも全件を集計する", async () => {
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({
      logs: diaperRowsAcross(startDate, 91, 2300),
      maxRows: 300,
    })
    authOk(supabase)

    await GET(req("3months"))

    // 「短いページ = 最後」と見なす実装は最初の 300 行で止まる
    expect(reportedDiaperTotal()).toBe(2300)
    const diapers = reportedDiapers()
    expect(diapers[diapers.length - 1].date).toBe(TODAY_JST)
  })

  it("同時刻の行がページ境界を跨いでも欠落・重複せぬ（keyset の同値処理・マイクロ秒精度）", async () => {
    const supabase = makeSupabase({ logs: diaperRowsAtSameInstant(2500) })
    authOk(supabase)

    await GET(req())

    // cursor を Date に通す（ms へ丸める）と gt 側が同じ行を再取得して重複する
    expect(reportedDiaperTotal()).toBe(2500)
    expect(supabase.requests.map((r) => r.returned)).toEqual([1000, 1000, 500, 0])
  })

  it("ページ取得の途中で失敗したら構造化ログを残して 500（部分 PDF を作らぬ）", async () => {
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({
      logs: diaperRowsAcross(startDate, 91, 2300),
      failLogsOnRequest: { n: 2, error: { message: "connection reset", code: "08006" } },
    })
    authOk(supabase)

    const res = await GET(req("3months"))

    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-report",
      "baby_logs lookup failed",
      expect.objectContaining({ message: "connection reset" }),
      expect.objectContaining({
        householdId: "house-1",
        period: "3months",
        page: 2,
        fetchedSoFar: 1000,
      }),
    )
    expect(generateBabyReport).not.toHaveBeenCalled()
  })
})

describe("baby-report: 取得上限の fail-loud", () => {
  it("上限を超えたら header・PDF・サーバログの三重で「全件ではない」と分かる（max_rows 下でも）", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({ logs: diaperRowsAcross(startDate, 91, 6000) })
    authOk(supabase)

    const res = await GET(req("3months"))

    expect(res.status).toBe(200)
    // 1. レスポンスヘッダ
    expect(res.headers.get("X-Report-Truncated")).toBe("1")
    // 2. PDF 本体（印刷しても残る）
    expect(generateBabyReport).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: true }),
    )
    // 3. サーバログ
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("取得上限"),
      expect.objectContaining({ limit: 5000, householdId: "house-1" }),
    )

    error.mockRestore()
  })

  it("上限 + 1 件に届いた時点で引くのを止める（無駄に全件を引かぬ・1 要求は max_rows 以下）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const startDate = shiftYmd(TODAY_JST, -90)
    const supabase = makeSupabase({ logs: diaperRowsAcross(startDate, 91, 7000) })
    authOk(supabase)

    await GET(req("3months"))

    const fetched = supabase.requests.reduce((s, r) => s + r.returned, 0)
    // ちょうど上限件数との弁別に「+1 件」が要る（5000 件ちょうどを偽陽性にせぬ）
    expect(fetched).toBe(5001)
    for (const r of supabase.requests) {
      expect(r.limit!).toBeLessThanOrEqual(MAX_ROWS)
    }
    vi.restoreAllMocks()
  })

  it("ちょうど上限件数は切り詰めではない（偽陽性を出さない）", async () => {
    const supabase = makeSupabase({ logs: diaperRowsAtSameInstant(5000) })
    authOk(supabase)

    const res = await GET(req())

    expect(res.headers.get("X-Report-Truncated")).toBeNull()
    expect(generateBabyReport).toHaveBeenCalledWith(
      expect.objectContaining({ truncated: false }),
    )
    expect(reportedDiaperTotal()).toBe(5000)
  })

  it("切り詰め時に集計へ渡すのは上限ちょうど（+1 件目を混ぜない）", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const supabase = makeSupabase({ logs: diaperRowsAtSameInstant(5001) })
    authOk(supabase)

    await GET(req())

    // 集計結果そのものではなく「+1 件目が混ざっていない」ことを見る。
    // 実装が slice を忘れると 5001 件が集計へ流れる。
    expect(reportedDiaperTotal()).toBe(5000)
    vi.restoreAllMocks()
  })
})

describe("baby-report: タイムアウト設定", () => {
  /**
   * PDF 生成は DB クエリ + フォント埋め込み + レイアウトを直列で行う。
   * maxDuration 未設定だとプラットフォーム既定で無言に中断されうる。
   */
  it("maxDuration が明示されている", () => {
    expect(maxDuration).toBe(30)
  })
})

describe("baby-report: 既存の入口ガードを壊していない", () => {
  it("未認証は 401", async () => {
    getAuthContext.mockResolvedValue({
      error: "認証されていません",
      reason: "unauthenticated",
      context: null,
    })
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  /**
   * UX-03: カードは 401 を「セッションが切れました。ログインし直してください」と案内する。
   * ゆえに 401 は**ログインし直せば直る時だけ**に限る。profiles の一過性の取得失敗まで
   * 401 にすると、受診当日に待てば直る障害で利用者をログアウトへ誘導してしまう
   * （組込み SMTP の送信上限の下では、ログインし直すこと自体ができぬことがある）。
   */
  it.each([
    { reason: "lookup-failed", error: "プロフィールの取得に失敗しました", status: 503 },
    { reason: "not-approved", error: "承認待ちです", status: 403 },
    { reason: "no-household", error: "世帯が設定されていません", status: 403 },
  ])("$reason は $status（401 ではない）", async ({ reason, error, status }) => {
    getAuthContext.mockResolvedValue({ error, reason, context: null })
    const res = await GET(req())
    expect(res.status).toBe(status)
    expect(res.status).not.toBe(401)
  })

  it("不正な period は 400", async () => {
    authOk(makeSupabase({}))
    const res = await GET(req("10years"))
    expect(res.status).toBe(400)
  })
})
