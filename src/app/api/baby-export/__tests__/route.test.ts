/**
 * baby-export route（機能 D）の認可・世帯の境界・ページ取得・本文の形。
 *
 * fake は PostgREST の部分集合: 1 要求につき最大 MAX_ROWS 行を**黙って**返す（実 PostgREST の
 * max_rows）。続きは route が送る keyset（`.or()` の cursor / `.gt()`）からのみ導く。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const getAuthContext = vi.fn()
const logSupabaseError = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))

import { GET, maxDuration } from "../route"
import { todayJstString, shiftYmd } from "@/lib/utils/date-jst"

const HOUSEHOLD = "11111111-1111-4111-8111-111111111111"
const MAX_ROWS = 1000
const TODAY = todayJstString()

type Row = Record<string, unknown>
type Call = [method: string, args: unknown[]]

/** 時刻順に並ぶ logged_at（UTC ISO・マイクロ秒つき）と id を持つ行を n 件作る */
function makeLogs(n: number, startDaysAgo = 10): Row[] {
  const base = Date.parse(`${shiftYmd(TODAY, -startDaysAgo)}T00:00:00+09:00`)
  return Array.from({ length: n }, (_, i) => {
    const ms = base + i * 60_000
    const iso = new Date(ms).toISOString().replace("Z", "123456+00:00").replace(/\.\d{3}123456/, ".000123")
    return {
      id: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`,
      household_id: HOUSEHOLD,
      log_type: "diaper",
      logged_at: iso,
      logged_by: "user-1",
      feeding_type: null,
      amount_ml: null,
      breast_left_count: null,
      breast_right_count: null,
      breast_left_sec: null,
      breast_right_sec: null,
      breast_start_side: null,
      diaper_type: "pee",
      poop_amount: null,
      temperature: null,
      weight_g: null,
      height_cm: null,
      duration_min: null,
      duration_sec: null,
      memo: null,
      created_at: iso,
      updated_at: iso,
    }
  })
}

function makeDiaries(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `diary-${i}`,
    household_id: HOUSEHOLD,
    diary_date: shiftYmd(TODAY, -i),
    content: `日記 ${i}`,
    updated_at: `${shiftYmd(TODAY, -i)}T12:00:00+00:00`,
  }))
}

interface Recorded {
  table: string
  calls: Call[]
}

/**
 * 記録する汎用 builder。terminal（await / single / maybeSingle）で `respond` を呼ぶ。
 */
function makeSupabase(opts: {
  logs?: Row[]
  diaries?: Row[]
  household?: { data: Row | null; error: unknown }
  members?: { data: Row[] | null; error: unknown }
  failLogsOnRequest?: number
  failDiaries?: boolean
}) {
  const requests: Recorded[] = []
  let logsRequests = 0
  const logs = opts.logs ?? []
  const diaries = opts.diaries ?? []

  function value(calls: Call[], method: string, column: string): string | null {
    const call = calls.find(([m, a]) => m === method && a[0] === column)
    return call ? String(call[1][1]) : null
  }

  function respondLogs(calls: Call[]): { data: Row[] | null; error: unknown } {
    logsRequests++
    if (opts.failLogsOnRequest === logsRequests) {
      return { data: null, error: { message: "boom", code: "XX000" } }
    }
    const household = value(calls, "eq", "household_id")
    const gte = value(calls, "gte", "logged_at")
    const lt = value(calls, "lt", "logged_at")
    const or = calls.find(([m]) => m === "or")
    let cursorAt: string | null = null
    let cursorId: string | null = null
    if (or) {
      const m = /logged_at\.gt\."([^"]+)",and\(logged_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)/.exec(
        String(or[1][0]),
      )
      if (!m) throw new Error(`fake: cursor を読めぬ: ${String(or[1][0])}`)
      cursorAt = m[1]
      cursorId = m[3]
    }
    const limit = Number(calls.find(([m]) => m === "limit")?.[1][0] ?? Infinity)
    const rows = logs
      .filter((r) => r.household_id === household)
      .filter((r) => (gte ? String(r.logged_at) >= gte : true))
      .filter((r) => (lt ? String(r.logged_at) < lt : true))
      .filter((r) =>
        cursorAt
          ? String(r.logged_at) > cursorAt ||
            (String(r.logged_at) === cursorAt && String(r.id) > String(cursorId))
          : true,
      )
      .sort((a, b) =>
        String(a.logged_at) === String(b.logged_at)
          ? String(a.id).localeCompare(String(b.id))
          : String(a.logged_at).localeCompare(String(b.logged_at)),
      )
      .slice(0, Math.min(limit, MAX_ROWS))
    // household_id は select に無いゆえ返さぬ
    return { data: rows.map(({ household_id: _h, ...rest }) => rest), error: null }
  }

  function respondDiaries(calls: Call[]): { data: Row[] | null; error: unknown } {
    if (opts.failDiaries) return { data: null, error: { message: "boom", code: "XX000" } }
    const household = value(calls, "eq", "household_id")
    const gte = value(calls, "gte", "diary_date")
    const lte = value(calls, "lte", "diary_date")
    const gt = value(calls, "gt", "diary_date")
    const limit = Number(calls.find(([m]) => m === "limit")?.[1][0] ?? Infinity)
    const rows = diaries
      .filter((r) => r.household_id === household)
      .filter((r) => (gte ? String(r.diary_date) >= gte : true))
      .filter((r) => (lte ? String(r.diary_date) <= lte : true))
      .filter((r) => (gt ? String(r.diary_date) > gt : true))
      .sort((a, b) => String(a.diary_date).localeCompare(String(b.diary_date)))
      .slice(0, Math.min(limit, MAX_ROWS))
    return { data: rows.map(({ household_id: _h, ...rest }) => rest), error: null }
  }

  function makeQuery(table: string) {
    const calls: Call[] = []
    const record: Recorded = { table, calls }
    requests.push(record)
    const respond = () => {
      if (table === "baby_logs") return respondLogs(calls)
      if (table === "baby_diaries") return respondDiaries(calls)
      if (table === "households") {
        return opts.household ?? {
          data: { baby_name: "みかん", baby_birth_date: "2026-06-01" },
          error: null,
        }
      }
      if (table === "profiles") {
        return opts.members ?? {
          data: [{ id: "user-1", display_name: "はな" }],
          error: null,
        }
      }
      throw new Error(`fake: 未知の table ${table}`)
    }
    const query: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onF?: (v: unknown) => unknown, onR?: (r: unknown) => unknown) =>
              Promise.resolve(respond()).then(onF, onR)
          }
          if (prop === "single" || prop === "maybeSingle") {
            return () => Promise.resolve(respond())
          }
          return (...args: unknown[]) => {
            calls.push([String(prop), args])
            return query
          }
        },
      },
    )
    return query
  }

  return {
    client: { from: (table: string) => makeQuery(table) },
    requests,
  }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

async function call(period = "1month") {
  return GET(new Request(`http://localhost/api/baby-export?period=${period}`))
}

beforeEach(() => {
  getAuthContext.mockReset()
  logSupabaseError.mockReset()
})

describe("baby-export route / 認可", () => {
  it.each([
    ["unauthenticated", 401],
    ["not-approved", 403],
    ["no-household", 403],
    ["lookup-failed", 503],
  ])("%s → %d", async (reason, status) => {
    getAuthContext.mockResolvedValue({ error: "denied", reason, context: null })
    const res = await call()
    expect(res.status).toBe(status)
  })

  it("不正な period は 400", async () => {
    setContext(makeSupabase({}).client)
    const res = await call("1year")
    expect(res.status).toBe(400)
  })

  it("maxDuration を明示している", () => {
    expect(maxDuration).toBe(30)
  })
})

describe("baby-export route / 本文と境界", () => {
  it("JSON を attachment・no-store で返し、範囲・単位・件数・世帯員・JST 暦日を持つ", async () => {
    const { client, requests } = makeSupabase({ logs: makeLogs(3), diaries: makeDiaries(2) })
    setContext(client)
    const res = await call("1month")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("application/json")
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="uchinolog_${shiftYmd(TODAY, -30)}_${TODAY}.json"`,
    )
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("x-export-truncated")).toBeNull()

    const body = await res.json()
    expect(body.schema_version).toBe(1)
    expect(body.timezone).toBe("Asia/Tokyo")
    expect(body.period).toEqual({ key: "1month", from: shiftYmd(TODAY, -30), to: TODAY })
    expect(body.household).toEqual({ baby_name: "みかん", baby_birth_date: "2026-06-01" })
    expect(body.members).toEqual([{ id: "user-1", display_name: "はな" }])
    expect(body.units.amount_ml).toBe("ml")
    expect(body.counts).toEqual({ logs: 3, diaries: 2 })
    expect(body.complete).toBe(true)
    expect(body.logs[0].logged_at_jst_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(body.logs[0].household_id).toBeUndefined()
    expect(body.diaries.map((d: { diary_date: string }) => d.diary_date)).toEqual([
      shiftYmd(TODAY, -1),
      TODAY,
    ])

    // 世帯の境界: データの問い合わせは全て household_id で絞る（RLS と二重）
    for (const r of requests.filter((r) => r.table !== "households")) {
      expect(r.calls).toContainEqual(["eq", ["household_id", HOUSEHOLD]])
    }
  })

  it("別世帯の行は含まぬ（fake の世帯フィルタで確かめる）", async () => {
    const other = makeLogs(2).map((r) => ({ ...r, household_id: "other", id: `o-${r.id}` }))
    const { client } = makeSupabase({ logs: [...makeLogs(3), ...other] })
    setContext(client)
    const body = await (await call("3months")).json()
    expect(body.counts.logs).toBe(3)
  })

  it("max_rows を跨いで全ページを辿る（2,500 行 → 3 要求 + 終端の 1 要求）", async () => {
    const { client, requests } = makeSupabase({ logs: makeLogs(2500, 80) })
    setContext(client)
    const body = await (await call("3months")).json()
    expect(body.counts.logs).toBe(2500)
    expect(body.complete).toBe(true)
    const logRequests = requests.filter((r) => r.table === "baby_logs")
    expect(logRequests.length).toBeGreaterThanOrEqual(3)
    // 2 要求目以降は keyset の cursor を持つ
    expect(logRequests[1].calls.some(([m]) => m === "or")).toBe(true)
    // id は重複せず、昇順
    const ids = body.logs.map((l: { id: string }) => l.id)
    expect(new Set(ids).size).toBe(2500)
  })

  it("全期間は from を持たず、logged_at の下限を付けぬ", async () => {
    const { client, requests } = makeSupabase({ logs: makeLogs(5, 400) })
    setContext(client)
    const body = await (await call("all")).json()
    expect(body.period).toEqual({ key: "all", from: null, to: TODAY })
    expect(body.counts.logs).toBe(5)
    const first = requests.find((r) => r.table === "baby_logs")!
    expect(first.calls.some(([m, a]) => m === "gte" && a[0] === "logged_at")).toBe(false)
  })

  it("1 週間の窓の外の行は含まぬ", async () => {
    const { client } = makeSupabase({ logs: makeLogs(3, 30) })
    setContext(client)
    const body = await (await call("1week")).json()
    expect(body.counts.logs).toBe(0)
  })

  it("途中のページで失敗したら部分的な書き出しを返さず 500 にし、ログへ残す", async () => {
    const { client } = makeSupabase({ logs: makeLogs(1500, 80), failLogsOnRequest: 2 })
    setContext(client)
    const res = await call("3months")
    expect(res.status).toBe(500)
    expect(logSupabaseError).toHaveBeenCalledWith(
      "baby-export",
      expect.stringContaining("baby_logs"),
      expect.objectContaining({ message: "boom" }),
      expect.objectContaining({ householdId: HOUSEHOLD, page: 2 }),
    )
  })

  it("日記の取得失敗も 500（欠けた書き出しを全件と偽らぬ）", async () => {
    const { client } = makeSupabase({ logs: makeLogs(1), failDiaries: true })
    setContext(client)
    expect((await call()).status).toBe(500)
  })

  it("本文は compact JSON（整形の空白で応答上限を食わぬ）", async () => {
    const { client } = makeSupabase({ logs: makeLogs(2) })
    setContext(client)
    const text = await (await call("1month")).text()
    expect(text).not.toContain("\n")
    expect(JSON.parse(text).counts.logs).toBe(2)
  })

  it("応答本文のバイト予算を超える分は切り詰め、全件と偽らぬ（Vercel の 4.5MB 上限の手前）", async () => {
    // 1 行 ≈ 3.6KB（メモ 1,200 文字 × 3 bytes）× 1,200 行 ≈ 4.3MB > 記録の予算 3.2MB
    const heavy = makeLogs(1200, 80).map((r) => ({ ...r, memo: "あ".repeat(1200) }))
    const { client, requests } = makeSupabase({ logs: heavy, diaries: makeDiaries(2) })
    setContext(client)
    const res = await call("3months")
    expect(res.status).toBe(200)
    expect(res.headers.get("x-export-truncated")).toBe("1")
    const text = await res.text()
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(4_500_000)
    const body = JSON.parse(text)
    expect(body.complete).toBe(false)
    expect(body.counts.logs).toBeGreaterThan(0)
    expect(body.counts.logs).toBeLessThan(1200)
    expect(body.truncated_after).toBe(body.logs.at(-1).logged_at)
    // 日記は全件ゆえ日記側の切り詰めは示さぬ
    expect(body.counts.diaries).toBe(2)
    expect(body.diaries_truncated_after).toBeNull()
    // 予算に当たった後のページは要求せぬ（2 ページ目で止まる）
    expect(requests.filter((r) => r.table === "baby_logs").length).toBe(1)
  })
})

async function get(query: string) {
  return GET(new Request(`http://localhost/api/baby-export?${query}`))
}

/** 応答の続きの位置で次の要求を組む（画面の「続きを書き出す」と同じ規則） */
function continuationQuery(res: Response, base: string, part: number): string | null {
  if (res.headers.get("x-export-truncated") !== "1") return null
  const params = new URLSearchParams(base)
  params.set("from", res.headers.get("x-export-from")!)
  params.set("to", res.headers.get("x-export-to")!)
  params.set("part", String(part))
  const logs = res.headers.get("x-export-next-logs-after")
  const diaries = res.headers.get("x-export-next-diaries-after")
  if (logs !== null) params.set("logs_after", decodeURIComponent(logs))
  if (diaries !== null) params.set("diaries_after", decodeURIComponent(diaries))
  return params.toString()
}

describe("baby-export route / 分割回収（E2・AC22 の integration 層）", () => {
  it("⭐ 予算を超える記録も、続きの位置を辿れば重複・欠落なく全件を回収できる", async () => {
    // 1 行 ≈ 3.6KB × 2,000 行 ≈ 7.2MB（1 回の予算 3.2MB の 2 倍超）
    const heavy = makeLogs(2000, 80).map((r) => ({ ...r, memo: "あ".repeat(1200) }))
    const { client } = makeSupabase({ logs: heavy, diaries: makeDiaries(3) })
    setContext(client)

    const collected: string[] = []
    const diaries: string[] = []
    let query: string | null = "period=3months"
    let part = 1
    let lastBody: { part: { next: unknown; continuation: boolean }; complete: boolean } | null = null
    while (query !== null) {
      const res = await get(query)
      expect(res.status).toBe(200)
      const text = await res.text()
      expect(Buffer.byteLength(text, "utf8")).toBeLessThan(4_500_000)
      const body = JSON.parse(text)
      collected.push(...body.logs.map((l: { id: string }) => l.id))
      diaries.push(...body.diaries.map((d: { diary_date: string }) => d.diary_date))
      // どの部分も、そのファイル単独では全件と名乗らぬ（最後の部分も complete=false）
      expect(body.complete).toBe(false)
      // ファイル名に部の番号（第 1 部も）— CSV ではこれが「一部」の唯一の印
      expect(res.headers.get("content-disposition")).toContain(`_part${part}.json`)
      if (res.headers.get("x-export-truncated") === "1") {
        expect(body.part.next).not.toBeNull()
        expect(body.part.is_last).toBe(false)
      } else {
        expect(body.part.is_last).toBe(true)
      }
      expect(body.part.continuation).toBe(part > 1)
      expect(body.consistency_note).toContain("同じ時点の完全な写しではありません")
      lastBody = body
      part++
      query = continuationQuery(res, "period=3months", part)
      if (part > 10) throw new Error("続きが終わらぬ")
    }
    expect(part - 1).toBeGreaterThanOrEqual(3)
    expect(lastBody!.part.next).toBeNull()
    expect(collected).toHaveLength(2000)
    expect(new Set(collected).size).toBe(2000)
    expect(collected).toEqual(heavy.map((r) => (r as Row).id))
    // 日記は最初の部分で取り終え、続きで重ねて出さぬ
    expect(diaries).toHaveLength(3)
  })

  it("続きのファイル名は番号付き・範囲は最初の値に固定（今日を引き直さぬ）", async () => {
    const { client, requests } = makeSupabase({ logs: makeLogs(3, 5) })
    setContext(client)
    const from = shiftYmd(TODAY, -30)
    const to = shiftYmd(TODAY, -1)
    const res = await get(
      `period=1month&from=${from}&to=${to}&logs_after=end&diaries_after=end&part=3`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="uchinolog_${from}_${to}_part3.json"`,
    )
    const body = await res.json()
    expect(body.period).toMatchObject({ from, to })
    // 続きの部分は単独では全件ではない
    expect(body.complete).toBe(false)
    // 両方取り終えた続きは DB を引かぬ
    expect(requests.filter((r) => r.table === "baby_logs" || r.table === "baby_diaries")).toHaveLength(0)
  })

  it("続きの位置より後だけを引く（keyset の or 条件に cursor をそのまま渡す）", async () => {
    const logs = makeLogs(5, 5)
    const { client, requests } = makeSupabase({ logs })
    setContext(client)
    const cursor = `${logs[1].logged_at}|${logs[1].id}`
    const res = await get(
      `period=1month&from=${shiftYmd(TODAY, -30)}&to=${TODAY}&logs_after=${encodeURIComponent(cursor)}&diaries_after=end&part=2`,
    )
    const body = await res.json()
    expect(body.logs.map((l: { id: string }) => l.id)).toEqual(logs.slice(2).map((l) => l.id))
    expect(body.part.logs_after).toBe(cursor)
    const first = requests.find((r) => r.table === "baby_logs")!
    expect(first.calls.some(([m]) => m === "or")).toBe(true)
  })

  it.each([
    ["形の壊れた cursor", "period=all&from=all&to=TODAY&logs_after=nope"],
    ["引用符を差し込む cursor", "period=all&from=all&to=TODAY&logs_after=2026-10-01T00:00:00Z%22)|x"],
    ["日記の cursor が日付でない", "period=all&from=all&to=TODAY&diaries_after=2026-13-40"],
    ["続きなのに範囲が無い", "period=all&logs_after=end"],
    ["未来の to", "period=all&from=all&to=2999-01-01&logs_after=end"],
    ["from > to", "period=all&from=TODAY&to=2020-01-01&logs_after=end"],
    ["未知の format", "period=all&format=xml"],
    ["CSV の表の指定が無い", "period=all&format=csv"],
  ])("%s は 400（PostgREST の条件へ通さぬ）", async (_label, q) => {
    const { client, requests } = makeSupabase({ logs: makeLogs(1) })
    setContext(client)
    const res = await get(q.replace(/TODAY/g, TODAY))
    expect(res.status).toBe(400)
    expect(requests).toHaveLength(0)
  })

  it("1 件だけで予算を超える行は、同じ位置を返し続けず失敗にする（無限の続きを作らぬ）", async () => {
    const huge = makeLogs(1).map((r) => ({ ...r, memo: "あ".repeat(1_200_000) }))
    const { client } = makeSupabase({ logs: huge })
    setContext(client)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    expect((await get("period=1month")).status).toBe(500)
    errorSpy.mockRestore()
  })
})

describe("baby-export route / CSV（E2・AC23 の integration 層）", () => {
  it("記録の CSV: BOM 付き UTF-8・RFC 4180・式の無効化・数値は数値のまま・no-store", async () => {
    const logs = makeLogs(2).map((r, i) =>
      i === 0
        ? { ...r, log_type: "feeding", feeding_type: "bottle", amount_ml: 160, memo: '=HYPERLINK("http://x")\n2行目, "引用"' }
        : { ...r, memo: "-5ml だけ" },
    )
    const { client, requests } = makeSupabase({ logs, diaries: makeDiaries(2) })
    setContext(client)
    const res = await get("period=1month&format=csv&table=logs")
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
    expect(res.headers.get("cache-control")).toBe("no-store")
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="uchinolog_logs_${shiftYmd(TODAY, -30)}_${TODAY}.csv"`,
    )
    // BOM はバイト列で確かめる（Response.text() の UTF-8 復号は先頭の BOM を取り除く — 画面側も
    // CSV は text() を通さず blob のまま保存せねば BOM が消える）
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const lines = text.slice(1).split("\r\n")
    expect(lines[0]).toContain('"記録ID","日時(JST)"')
    // 式は ' で無効化し、改行・引用符は 1 セルに収まる
    expect(text).toContain(`"'=HYPERLINK(""http://x"")\n2行目, ""引用"""`)
    expect(text).toContain(`"'-5ml だけ"`)
    // 量は数値のまま（引用符も ' も付けぬ）
    expect(text).toMatch(/,"bottle",160,/)
    // 記録した人は名前で出す
    expect(text).toContain('"はな"')
    // 記録の CSV では日記を引かぬ
    expect(requests.some((r) => r.table === "baby_diaries")).toBe(false)
  })

  it("日記の CSV は日記だけ（household の行を引かず、本文の式も無効化する）", async () => {
    const diaries = makeDiaries(1).map((d) => ({ ...d, content: "@SUM(A1)\n今日は寝た" }))
    const { client, requests } = makeSupabase({ diaries })
    setContext(client)
    const res = await get("period=1month&format=csv&table=diaries")
    const text = await res.text()
    expect(text).toContain(`"'@SUM(A1)\n今日は寝た"`)
    expect(requests.some((r) => r.table === "baby_logs" || r.table === "households")).toBe(false)
  })

  it("⭐ 切り詰めた CSV の第 1 部はファイル名に _part1 を付ける（全件の CSV と同じ名前にせぬ）", async () => {
    const heavy = makeLogs(1200, 80).map((r) => ({ ...r, memo: "あ".repeat(1200) }))
    const { client } = makeSupabase({ logs: heavy })
    setContext(client)
    const res = await get("period=3months&format=csv&table=logs")
    expect(res.headers.get("x-export-truncated")).toBe("1")
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="uchinolog_logs_${shiftYmd(TODAY, -90)}_${TODAY}_part1.csv"`,
    )
  })

  it("CSV でも途中の取得失敗は 500（部分を全件と偽らぬ）", async () => {
    const { client } = makeSupabase({ logs: makeLogs(1500, 80), failLogsOnRequest: 2 })
    setContext(client)
    expect((await get("period=3months&format=csv&table=logs")).status).toBe(500)
  })
})
