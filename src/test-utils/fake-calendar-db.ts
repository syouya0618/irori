/**
 * 予定の作成の結合テスト用の、calendar_events だけを持つ小さな in-memory「DB」と supabase client
 * （2026-10-28 v9 / AC28）。
 *
 * 目的は「本物の Server Action（createCalendarEvent）が書いた後で応答だけが失われ、ログインが切れ、
 * 再読込を挟んで利用者が押し直す」を、本物の画面（CalendarView）・本物の Action・主キー重複（23505）と
 * 世帯の絞りを持つ保存先の 3 つを繋いで再現すること。2 回目を成功にするだけの mock では、DB に既に
 * 在る行との照合（replayed / conflict）を通らぬ。
 *
 * 真似るのは試験が依存する次の点だけ（RLS・CHECK・トリガそのものは PGlite の pgTAP と
 * work/v9/pglite-action で別に確かめる）:
 * - 主キー（id）重複の INSERT は 23505 で失敗し、一括 INSERT は原子的（1 行でも重なれば全行を入れぬ）
 * - 配列の INSERT は全行の鍵の和集合を列にし、欠けた鍵は NULL（@supabase/postgrest-js の defaultToNull）
 * - 読みは household_id で絞る（RLS の代わり。別世帯の行は見えぬ）
 * - updated_at はマイクロ秒つきの表記で DB が振る
 * - 月の読み（use-month-events の select…eq…lte…gte…order…abortSignal）にも同じ行を返す
 */

type Row = Record<string, unknown>
type DbError = { code: string; message: string }

export interface FakeCalendarDb {
  rows: Row[]
  /** 本物の Action へ渡す server 側の client（世帯で絞る） */
  serverClient: (householdId: string) => unknown
  /** 画面の月の読み（@/lib/supabase/client の createClient の代わり）。世帯で絞る */
  browserClient: () => unknown
  /** 指定の世帯の行（検証用） */
  rowsOf: (householdId: string) => Row[]
}

let seq = 0
function microNow(): string {
  seq = (seq + 1) % 1_000_000
  return `2026-10-28T03:00:00.${String(seq).padStart(6, "0")}+00:00`
}

export function createFakeCalendarDb(): FakeCalendarDb {
  const rows: Row[] = []

  function builder(scopeHousehold: string | null) {
    const filters: Array<(r: Row) => boolean> = []
    let pending: { batch: Row[]; isArray: boolean } | null = null
    let limitTo: number | null = null

    const run = (): { data: Row[] | null; error: DbError | null } => {
      if (pending) {
        const { batch: sent, isArray } = pending
        pending = null
        const columns = isArray ? [...new Set(sent.flatMap((r) => Object.keys(r)))] : null
        const batch = columns
          ? sent.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined ? null : r[c]])))
          : sent
        if (batch.some((r) => r.id === null)) {
          return { data: null, error: { code: "23502", message: 'null value in column "id"' } }
        }
        if (scopeHousehold !== null && batch.some((r) => r.household_id !== scopeHousehold)) {
          return { data: null, error: { code: "42501", message: "new row violates row-level security policy" } }
        }
        const ids = batch.map((r) => r.id)
        if (
          ids.some((id) => id !== undefined && rows.some((x) => x.id === id)) ||
          new Set(ids.filter((id) => id !== undefined)).size !== ids.filter((id) => id !== undefined).length
        ) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }
        }
        const inserted = batch.map((r) => ({
          id: r.id ?? `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`,
          memo: null,
          start_at: null,
          end_at: null,
          series_id: null,
          ...r,
          updated_at: microNow(),
        }))
        rows.push(...inserted)
        return { data: inserted.map((r) => ({ ...r })), error: null }
      }
      const matched = rows.filter(
        (r) => (scopeHousehold === null || r.household_id === scopeHousehold) && filters.every((f) => f(r)),
      )
      const visible = limitTo === null ? matched : matched.slice(0, limitTo)
      return { data: visible.map((r) => ({ ...r })), error: null }
    }

    const b = {
      insert(v: Row | Row[]) {
        pending = Array.isArray(v) ? { batch: v, isArray: true } : { batch: [v], isArray: false }
        return b
      },
      select() {
        return b
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val)
        return b
      },
      lte(col: string, val: string) {
        filters.push((r) => String(r[col]) <= val)
        return b
      },
      gte(col: string, val: string) {
        filters.push((r) => String(r[col]) >= val)
        return b
      },
      order(col: string) {
        const res = run()
        if (res.data) res.data.sort((a, z) => String(a[col]).localeCompare(String(z[col])))
        return {
          abortSignal: () => Promise.resolve(res),
          then: <T>(resolve: (v: typeof res) => T) => Promise.resolve(resolve(res)),
        }
      },
      limit(count: number) {
        limitTo = count
        return b
      },
      async single() {
        const { data, error } = run()
        if (error) return { data: null, error }
        if (!data || data.length !== 1) return { data: null, error: { code: "PGRST116", message: "not one row" } }
        return { data: data[0], error: null }
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

  const channel = { on: () => channel, subscribe: () => channel }

  return {
    rows,
    serverClient: (householdId) => ({
      from: (table: string) => {
        if (table !== "calendar_events") throw new Error(`fake calendar db: unexpected table ${table}`)
        return builder(householdId)
      },
    }),
    browserClient: () => ({
      channel: () => channel,
      removeChannel: () => {},
      from: (table: string) => {
        if (table !== "calendar_events") throw new Error(`fake calendar db: unexpected table ${table}`)
        // 月の読みは .eq("household_id", …) で世帯を絞る（RLS の代わりは呼び出し側の絞り）
        return builder(null)
      },
    }),
    rowsOf: (householdId) => rows.filter((r) => r.household_id === householdId),
  }
}
