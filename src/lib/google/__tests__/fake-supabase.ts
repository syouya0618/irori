import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/**
 * 同期エンジンのテスト用 Supabase fake。
 *
 * `token-store.test.ts` の「呼び出しを記録するだけ」の fake より一段強い:
 * `calendar_events` と `google_calendar_subscriptions` を**小さな実データとして
 * 保持し、フィルタを実際に評価する**。構造テスト（「この列で eq しておるか」）は
 * 述語を消しても書き換えれば緑にできてしまうが、実データを持たせれば
 * 「native 行が巻き込まれた」「二重同期が通った」を**結果として**捕まえられる。
 *
 * PostgREST/Postgres の意味論のうち、本テストが依存する 3 点だけを写しておる:
 *  - UNIQUE は NULLS DISTINCT（NULL を含むキーは衝突せぬ）
 *  - `.update()` は述語に合う行だけを更新し、0 行でも error にならぬ
 *  - `.or("a.is.null,a.lt.X")` は行ごとに評価される
 * RLS・列 GRANT は実 DB の話ゆえここでは扱わぬ（pgTAP が担う）。
 */

export interface FakeCalendarEvent {
  household_id: string
  title: string
  source: "native" | "google"
  google_calendar_id: string | null
  google_event_id: string | null
  subscription_id: string | null
  synced_at: string | null
  [key: string]: unknown
}

export interface FakeSubscription {
  id: string
  connection_id: string
  household_id: string
  google_calendar_id: string
  is_selected: boolean
  sync_token: string | null
  sync_lease_until: string | null
  last_synced_at: string | null
}

export interface FakeConnection {
  id: string
  household_id: string
  user_id: string
  connection_status: string
  sync_status: string
  last_error_kind: string | null
  last_synced_at: string | null
}

export interface FakeTokenRow {
  connection_id: string
  refresh_token: string
  access_token: string | null
  access_token_expires_at: string | null
  scope: string | null
}

export interface FakeDb {
  calendar_events: FakeCalendarEvent[]
  google_calendar_subscriptions: FakeSubscription[]
  google_connections: FakeConnection[]
  google_tokens: FakeTokenRow[]
}

type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "in"; column: string; values: unknown[] }
  | { kind: "or"; raw: string }

export interface QueryRecord {
  table: string
  op: "select" | "update" | "upsert" | "delete"
  columns: string | null
  payload: Record<string, unknown> | Record<string, unknown>[] | null
  upsertOptions: unknown
  filters: Filter[]
  limit: number | null
}

/** `sync_lease_until.is.null,sync_lease_until.lt.2026-...Z` を行に対して評価する。 */
function evalOr(raw: string, row: Record<string, unknown>): boolean {
  return raw.split(",").some((clause) => {
    const firstDot = clause.indexOf(".")
    const secondDot = clause.indexOf(".", firstDot + 1)
    const column = clause.slice(0, firstDot)
    const op = clause.slice(firstDot + 1, secondDot)
    const value = clause.slice(secondDot + 1)
    const actual = row[column]
    if (op === "is") return value === "null" ? actual === null : false
    if (op === "lt") return actual !== null && String(actual) < value
    throw new Error(`fake-supabase: 未対応の or 演算子 ${op}`)
  })
}

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.column] === f.value
    if (f.kind === "neq") return row[f.column] !== f.value
    if (f.kind === "in") return f.values.includes(row[f.column])
    return evalOr(f.raw, row)
  })
}

export function emptyDb(): FakeDb {
  return {
    calendar_events: [],
    google_calendar_subscriptions: [],
    google_connections: [],
    google_tokens: [],
  }
}

export interface FakeSupabase {
  client: SupabaseClient<Database>
  db: FakeDb
  records: QueryRecord[]
  /** 特定テーブル・操作の記録だけを抜く（順序を保つ）。 */
  recordsOf: (table: string, op: QueryRecord["op"]) => QueryRecord[]
  /** `records` 内での添字（実行順の契約を assert するため）。 */
  indexOf: (table: string, op: QueryRecord["op"]) => number
  /** 指定テーブルのクエリで強制的に error を返させる。 */
  failOn: (table: string, op: QueryRecord["op"], error: unknown) => void
}

export function createFakeSupabase(db: FakeDb = emptyDb()): FakeSupabase {
  const records: QueryRecord[] = []
  const failures: Array<{ table: string; op: QueryRecord["op"]; error: unknown }> =
    []

  function rowsOf(table: string): Record<string, unknown>[] {
    const store = (db as unknown as Record<string, unknown[]>)[table]
    if (store === undefined) {
      throw new Error(`fake-supabase: 未知のテーブル ${table}`)
    }
    return store as Record<string, unknown>[]
  }

  function execute(record: QueryRecord): { data: unknown; error: unknown } {
    const failure = failures.find(
      (f) => f.table === record.table && f.op === record.op,
    )
    if (failure) return { data: null, error: failure.error }

    const store = rowsOf(record.table)

    if (record.op === "select") {
      const hits = store.filter((row) => matches(row, record.filters))
      return {
        data: record.limit === null ? hits : hits.slice(0, record.limit),
        error: null,
      }
    }

    if (record.op === "update") {
      const patch = record.payload as Record<string, unknown>
      const hits = store.filter((row) => matches(row, record.filters))
      for (const row of hits) Object.assign(row, patch)
      return { data: hits, error: null }
    }

    if (record.op === "delete") {
      const survivors: Record<string, unknown>[] = []
      const removed: Record<string, unknown>[] = []
      for (const row of store) {
        if (matches(row, record.filters)) removed.push(row)
        else survivors.push(row)
      }
      store.length = 0
      store.push(...survivors)
      return { data: removed, error: null }
    }

    // upsert: 衝突キーは (household_id, google_calendar_id, google_event_id)。
    // Postgres の NULLS DISTINCT に倣い、キーに NULL を含む行は衝突せぬ。
    const rows = record.payload as Record<string, unknown>[]
    for (const row of rows) {
      const key = [row.household_id, row.google_calendar_id, row.google_event_id]
      const hasNull = key.some((k) => k === null || k === undefined)
      const existing = hasNull
        ? undefined
        : store.find(
            (candidate) =>
              candidate.household_id === key[0] &&
              candidate.google_calendar_id === key[1] &&
              candidate.google_event_id === key[2],
          )
      if (existing) Object.assign(existing, row)
      else store.push({ ...row })
    }
    return { data: rows, error: null }
  }

  function from(table: string) {
    const record: QueryRecord = {
      table,
      op: "select",
      columns: null,
      payload: null,
      upsertOptions: null,
      filters: [],
      limit: null,
    }
    records.push(record)

    const settle = () => Promise.resolve(execute(record))

    const builder = {
      select(columns?: string) {
        record.columns = columns ?? null
        return builder
      },
      update(payload: Record<string, unknown>) {
        record.op = "update"
        record.payload = payload
        return builder
      },
      upsert(payload: Record<string, unknown>[], options?: unknown) {
        record.op = "upsert"
        record.payload = payload
        record.upsertOptions = options ?? null
        return builder
      },
      delete() {
        record.op = "delete"
        return builder
      },
      eq(column: string, value: unknown) {
        record.filters.push({ kind: "eq", column, value })
        return builder
      },
      neq(column: string, value: unknown) {
        record.filters.push({ kind: "neq", column, value })
        return builder
      },
      in(column: string, values: unknown[]) {
        record.filters.push({ kind: "in", column, values })
        return builder
      },
      or(raw: string) {
        record.filters.push({ kind: "or", raw })
        return builder
      },
      order() {
        return builder
      },
      limit(count: number) {
        record.limit = count
        return builder
      },
      maybeSingle() {
        return settle().then((result) => {
          if (result.error) return result
          const rows = (result.data ?? []) as unknown[]
          return { data: rows[0] ?? null, error: null }
        })
      },
      then<TResult1, TResult2>(
        onOk?: (value: { data: unknown; error: unknown }) => TResult1,
        onErr?: (reason: unknown) => TResult2,
      ) {
        return settle().then(onOk, onErr)
      },
    }
    return builder
  }

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    db,
    records,
    recordsOf: (table, op) =>
      records.filter((r) => r.table === table && r.op === op),
    indexOf: (table, op) =>
      records.findIndex((r) => r.table === table && r.op === op),
    failOn: (table, op, error) => failures.push({ table, op, error }),
  }
}
