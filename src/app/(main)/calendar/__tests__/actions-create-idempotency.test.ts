/**
 * 予定作成の冪等 id（2026-10-27 大型更新 A4 / 受入 AC28）。
 *
 * DB 保存の後で応答だけが失われ、同じ操作を押し直した時に、単発・繰返しとも二重に作らぬこと。
 * 保存先は主キー重複（23505）と原子的な一括 INSERT と世帯の絞り込みを持つ小さな fake で真似る
 * （本物の calendar_events の主キー・RLS は supabase/tests の pgTAP 側で確かめる）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({ getAuthContext: () => getAuthContext() }))

import { createCalendarEvent } from "../actions"

type Row = Record<string, unknown>
const HOUSEHOLD = "house-1"
const CLIENT_ID = "6f1e2d3c-4b5a-4c6d-8e9f-0a1b2c3d4e5f"

function makeDb() {
  const rows: Row[] = []
  let n = 0
  function from(table: string) {
    if (table !== "calendar_events") throw new Error(table)
    const filters: Array<(r: Row) => boolean> = []
    let pending: { batch: Row[]; isArray: boolean } | null = null
    let head = false
    let limitTo: number | null = null
    const run = () => {
      if (pending) {
        const { batch: sent, isArray } = pending
        pending = null
        // PostgREST の配列 INSERT の意味論（@supabase/postgrest-js 2.110.8 の insert: 配列は**全行の鍵の
        // 和集合**を `columns` に載せ、既定の defaultToNull で `missing=default` を送らぬ）: ある行に無い
        // 鍵は DEFAULT ではなく NULL で入る。行ごとに鍵が揃わぬ一括作成は、id が NULL になって 23502 で
        // 落ちる（v7 の繰返し作成の回帰。この fake が欠けた id を行ごとに採番しておったゆえ緑だった）
        const columns = isArray ? [...new Set(sent.flatMap((r) => Object.keys(r)))] : null
        const batch = columns
          ? sent.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined ? null : r[c]])))
          : sent
        if (batch.some((r) => r.id === null)) {
          return {
            data: null,
            error: { code: "23502", message: 'null value in column "id" violates not-null constraint' },
            count: null,
          }
        }
        // 原子的: 一つでも主キーが重なれば全行を入れぬ
        if (batch.some((r) => r.id !== undefined && rows.some((x) => x.id === r.id))) {
          return { data: null, error: { code: "23505", message: "duplicate key" }, count: null }
        }
        const inserted = batch.map((r) => ({
          id: r.id ?? `auto-${++n}`,
          updated_at: `2026-10-27T03:00:0${n % 10}.123456+00:00`,
          series_id: null,
          ...r,
        }))
        rows.push(...inserted)
        return { data: inserted, error: null, count: null }
      }
      const matched = rows.filter((r) => r.household_id === HOUSEHOLD && filters.every((f) => f(r)))
      const visible = limitTo === null ? matched : matched.slice(0, limitTo)
      return { data: head ? null : visible, error: null, count: visible.length }
    }
    const b = {
      insert(v: Row | Row[]) {
        pending = Array.isArray(v) ? { batch: v, isArray: true } : { batch: [v], isArray: false }
        return b
      },
      limit(count: number) {
        limitTo = count
        return b
      },
      select(_cols?: string, opts?: { head?: boolean }) {
        head = !!opts?.head
        return b
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val)
        return b
      },
      async single() {
        const { data, error } = run()
        return error ? { data: null, error } : { data: data?.[0] ?? null, error: null }
      },
      async maybeSingle() {
        const { data, error } = run()
        return error ? { data: null, error } : { data: data?.[0] ?? null, error: null }
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T) {
        return Promise.resolve(resolve(run()))
      },
    }
    return b
  }
  return { rows, client: { from } }
}

let db: ReturnType<typeof makeDb>
beforeEach(() => {
  db = makeDb()
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase: db.client, userId: "user-1", householdId: HOUSEHOLD },
  })
})

const SINGLE = {
  title: "健診",
  memo: "持ち物: 母子手帳",
  isAllDay: true,
  startDate: "2026-11-02",
  endDate: "2026-11-02",
}

describe("単発の作成", () => {
  it("同じ clientId の再送（応答を失った後）は 1 件のまま replayed で成功する", async () => {
    const first = await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })
    expect(first).toMatchObject({ error: null, eventId: CLIENT_ID })
    const again = await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })
    expect(again).toMatchObject({ error: null, eventId: CLIENT_ID, replayed: true })
    expect(again.error === null && "updatedAt" in again && again.updatedAt).toMatch(/\.123456\+00:00$/)
    expect(db.rows).toHaveLength(1)
  })

  it("同じ clientId で内容が違えば conflict（二重にも上書きにもせぬ）", async () => {
    await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })
    const changed = await createCalendarEvent({ ...SINGLE, title: "健診（変更）", clientId: CLIENT_ID })
    expect(changed).toMatchObject({ failure: "conflict" })
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].title).toBe("健診")
  })

  it("対照: clientId を送らぬ従来の作成は再送で 2 件になる（冪等 id の効き目の対照）", async () => {
    await createCalendarEvent(SINGLE)
    await createCalendarEvent(SINGLE)
    expect(db.rows).toHaveLength(2)
  })

  it("UUID でない clientId は DB に届く前に rejected", async () => {
    const r = await createCalendarEvent({ ...SINGLE, clientId: "nope" })
    expect(r).toMatchObject({ failure: "rejected" })
    expect(db.rows).toHaveLength(0)
  })

  it("通信の失敗（code なし）は unknown、制約違反は rejected", async () => {
    const failing = (error: { code?: string; message: string }) => ({
      from: () => {
        const b = {
          insert: () => b,
          select: () => b,
          single: async () => ({ data: null, error }),
        }
        return b
      },
    })
    getAuthContext.mockResolvedValueOnce({
      error: null,
      reason: null,
      context: { supabase: failing({ message: "fetch failed", code: "" }), userId: "u", householdId: HOUSEHOLD },
    })
    expect(await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })).toMatchObject({ failure: "unknown" })
    getAuthContext.mockResolvedValueOnce({
      error: null,
      reason: null,
      context: { supabase: failing({ message: "check", code: "23514" }), userId: "u", householdId: HOUSEHOLD },
    })
    expect(await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })).toMatchObject({ failure: "rejected" })
  })
})

describe("繰返しの作成（series_id に一意制約が無くても二重にせぬ）", () => {
  const WEEKLY = { ...SINGLE, repeat: "weekly" as const, repeatUntil: "2026-11-30" }

  it("同じ clientId の再送は 1 シリーズのまま replayed（件数は今のシリーズの行数）", async () => {
    const first = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(first).toMatchObject({ error: null, seriesId: CLIENT_ID })
    const count = db.rows.length
    expect(count).toBeGreaterThan(1)
    // 初回の行の主キーが clientId（原子的な一括 INSERT が主キー重複で丸ごと落ちる鍵）
    expect(db.rows[0]).toMatchObject({ id: CLIENT_ID, series_id: CLIENT_ID })
    const again = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(again).toMatchObject({ error: null, seriesId: CLIENT_ID, count, replayed: true })
    expect(db.rows).toHaveLength(count)
  })

  it("同じ clientId で内容が違えば conflict", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const before = db.rows.length
    const changed = await createCalendarEvent({ ...WEEKLY, title: "別", clientId: CLIENT_ID })
    expect(changed).toMatchObject({ failure: "conflict" })
    expect(db.rows).toHaveLength(before)
  })

  it("同じ clientId で終了日だけを延ばした再送は conflict（初回の行が同じでも成功と言わぬ。独立レビュー指摘）", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const before = db.rows.length
    const extended = await createCalendarEvent({ ...WEEKLY, repeatUntil: "2026-12-28", clientId: CLIENT_ID })
    expect(extended).toMatchObject({ failure: "conflict" })
    expect(db.rows).toHaveLength(before)
  })

  it("同じ clientId で頻度を変えた再送（weekly → daily）も conflict", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const changed = await createCalendarEvent({ ...WEEKLY, repeat: "daily", clientId: CLIENT_ID })
    expect(changed).toMatchObject({ failure: "conflict" })
  })

  it("家族が一部の回を消した後の同じ内容の再送も、成功とは言わず conflict（並びが一致せぬ）", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    db.rows.splice(1, 1)
    const again = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(again).toMatchObject({ failure: "conflict" })
  })

  it("対照: clientId を送らぬ繰返しの作成も通る（どの行も id を持たず、鍵の集合が揃う）", async () => {
    const r = await createCalendarEvent(WEEKLY)
    expect(r).toMatchObject({ error: null })
    expect(db.rows.length).toBeGreaterThan(1)
  })

  it("clientId つきの一括作成は全行が同じ鍵の集合で、2 行目以降も id を持つ（PostgREST の列の和集合で NULL にせぬ）", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const keys = db.rows.map((r) => Object.keys(r).sort().join(","))
    expect(new Set(keys).size).toBe(1)
    const ids = db.rows.map((r) => r.id)
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(db.rows.every((r) => r.series_id === CLIENT_ID)).toBe(true)
  })

  it("初回の回を消した後の同じ内容の再送は、残りの回を二重に作らず conflict（独立レビュー F4）", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const firstIndex = db.rows.findIndex((r) => r.id === CLIENT_ID)
    expect(firstIndex).toBeGreaterThanOrEqual(0)
    db.rows.splice(firstIndex, 1)
    const before = db.rows.length
    expect(before).toBeGreaterThan(0)
    const again = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(again).toMatchObject({ failure: "conflict" })
    expect(db.rows).toHaveLength(before)
  })

  it("初回の回が消えた衝突の文言は「別の内容で作成済み」と偽らず、回の並びの違いを言う", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    db.rows.splice(db.rows.findIndex((r) => r.id === CLIENT_ID), 1)
    const again = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(again.error).toContain("今の回の並びが送った内容と違います")
    expect(again.error).not.toContain("別の内容で作成済み")
  })

  it("同じシリーズの先読みが失敗したら何も書かず unknown（同じ id でだけ送り直させる）", async () => {
    const failingRead = {
      from: () => {
        const b = {
          select: () => b,
          eq: () => b,
          limit: async () => ({ data: null, error: { code: "", message: "fetch failed" } }),
          insert: () => {
            throw new Error("先読みに失敗した後に INSERT してはならぬ")
          },
        }
        return b
      },
    }
    getAuthContext.mockResolvedValueOnce({
      error: null,
      reason: null,
      context: { supabase: failingRead, userId: "u", householdId: HOUSEHOLD },
    })
    const r = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(r).toMatchObject({ failure: "unknown" })
  })

  it("全ての回を消した後の再送は作り直す（残る行が無く、二重にはならぬ。明示の送り直し）", async () => {
    await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    const count = db.rows.length
    db.rows.splice(0, db.rows.length)
    const again = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(again).toMatchObject({ error: null, seriesId: CLIENT_ID, count })
    expect(db.rows).toHaveLength(count)
  })

  it("単発の id で繰返しを送り直した（形の違う再送）も conflict", async () => {
    await createCalendarEvent({ ...SINGLE, clientId: CLIENT_ID })
    const r = await createCalendarEvent({ ...WEEKLY, clientId: CLIENT_ID })
    expect(r).toMatchObject({ failure: "conflict" })
    expect(db.rows).toHaveLength(1)
  })
})
