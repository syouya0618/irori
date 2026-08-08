import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"

/**
 * 配信ジョブのテスト用 Supabase fake。
 *
 * `src/lib/google/__tests__/fake-supabase.ts` と同じ思想じゃ:**小さな実データを
 * 保持し、フィルタを実際に評価する**。構造テスト（「この列で eq しておるか」）は
 * 述語を消しても書き換えれば緑にできてしまうが、実データを持たせれば
 * 「他世帯の予定が混ざった」「同じ通知が 2 行できた」を**結果として**捕まえられる。
 *
 * 本物の Postgres / PostgREST の意味論のうち、テストが依存する 4 点だけを写す:
 *  - `UNIQUE NULLS NOT DISTINCT`（NULL を含むキーも衝突する）
 *  - `.update()` は述語に合う行だけを更新し、**0 行でも error にならぬ**
 *  - `.select()` を付けた書込のみ data を返す（付けねば null）
 *  - `.upsert(..., { ignoreDuplicates: true })` は衝突行を**触らぬ**
 * RLS・列 GRANT・CHECK は実 DB の話ゆえここでは扱わぬ（pgTAP が担う）。
 */

type Row = Record<string, unknown>

export interface FakeNotifyDb {
  profiles: Row[]
  push_subscriptions: Row[]
  calendar_events: Row[]
  event_reminders: Row[]
  /** B-5 の毎朝ダイジェスト（`digest_time` は **JST 壁時計**の TIME）。 */
  notification_preferences: Row[]
  notification_deliveries: Row[]
  notification_heartbeat: Row[]
}

export function emptyNotifyDb(): FakeNotifyDb {
  return {
    profiles: [],
    push_subscriptions: [],
    calendar_events: [],
    event_reminders: [],
    notification_preferences: [],
    notification_deliveries: [],
    notification_heartbeat: [],
  }
}

type Filter =
  | { kind: "eq" | "lt" | "lte" | "gt" | "gte"; column: string; value: unknown }
  | { kind: "isNull"; column: string }
  | { kind: "isNotNull"; column: string }
  | { kind: "in"; column: string; values: unknown[] }

export interface QueryRecord {
  table: keyof FakeNotifyDb
  op: "select" | "update" | "upsert" | "delete"
  columns: string | null
  payload: Row | Row[] | null
  upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } | null
  filters: Filter[]
  returning: boolean
  order: string | null
}

/** ISO 文字列同士は epoch で比べる（表記揺れに引きずられぬため）。 */
function compare(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string") {
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb
    return a < b ? -1 : a > b ? 1 : 0
  }
  return (a as number) - (b as number)
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.column] === f.value
    if (f.kind === "isNull") return row[f.column] === null || row[f.column] === undefined
    if (f.kind === "isNotNull")
      return row[f.column] !== null && row[f.column] !== undefined
    if (f.kind === "in") return f.values.includes(row[f.column])
    const value = row[f.column]
    if (value === null || value === undefined) return false
    const cmp = compare(value, f.value)
    if (f.kind === "lt") return cmp < 0
    if (f.kind === "lte") return cmp <= 0
    if (f.kind === "gte") return cmp >= 0
    return cmp > 0
  })
}

/**
 * 列の既定値。**これが無いと fake は本物より甘くなる。**
 *
 * 実 DB は `id` を `gen_random_uuid()` で、未指定の列を NULL で埋める。fake が
 * それを写さねば挿入行の `id` が `undefined` になり、`.eq("id", undefined)` が
 * **全行に当たって**しまう — 3 台へ配ったつもりが 1 通になる、という嘘の緑が出る
 * （実際にこのテストで踏んだ）。
 */
let sequence = 0
const TABLE_DEFAULTS: Partial<Record<keyof FakeNotifyDb, () => Row>> = {
  notification_deliveries: () => ({
    id: `delivery-${++sequence}`,
    event_key: null,
    subscription_id: null,
    sent_at: null,
    skipped_at: null,
    skip_reason: null,
    created_at: "2000-01-01T00:00:00.000Z",
  }),
}

/**
 * `UNIQUE NULLS NOT DISTINCT` の鍵。**NULL も 1 つの値として扱う** — ここを
 * 既定の NULLS DISTINCT に戻すと、B-5 のダイジェスト行が何行でも共存できる
 * （本番と同じ壊れ方をこの fake でも再現できるようにしておる）。
 */
function conflictKey(row: Row, columns: string[]): string {
  return JSON.stringify(columns.map((c) => (row[c] === undefined ? null : row[c])))
}

export interface FakeNotifySupabase {
  client: SupabaseClient<Database>
  db: FakeNotifyDb
  records: QueryRecord[]
  recordsOf: (table: keyof FakeNotifyDb, op: QueryRecord["op"]) => QueryRecord[]
  /** 指定テーブル・操作でエラーを返させる。 */
  failOn: (table: keyof FakeNotifyDb, op: QueryRecord["op"], error: unknown) => void
  /** クエリ実行の直前に割り込む（別プロセスの競合を再現するため）。 */
  beforeExecute: ((record: QueryRecord, db: FakeNotifyDb) => void) | null
}

export function createFakeNotifySupabase(
  db: FakeNotifyDb = emptyNotifyDb(),
): FakeNotifySupabase {
  const records: QueryRecord[] = []
  const failures: Array<{
    table: keyof FakeNotifyDb
    op: QueryRecord["op"]
    error: unknown
  }> = []
  const state: FakeNotifySupabase = {
    client: null as unknown as SupabaseClient<Database>,
    db,
    records,
    recordsOf: (table, op) =>
      records.filter((r) => r.table === table && r.op === op),
    failOn: (table, op, error) => failures.push({ table, op, error }),
    beforeExecute: null,
  }

  function execute(record: QueryRecord): { data: unknown; error: unknown } {
    state.beforeExecute?.(record, db)

    const failure = failures.find(
      (f) => f.table === record.table && f.op === record.op,
    )
    if (failure) return { data: null, error: failure.error }

    const store = db[record.table]
    if (store === undefined) {
      throw new Error(`fake-notify-db: 未知のテーブル ${record.table}`)
    }

    if (record.op === "select") {
      let hits = store.filter((row) => matches(row, record.filters))
      if (record.order) {
        const key = record.order
        hits = [...hits].sort((a, b) => compare(a[key], b[key]))
      }
      return { data: hits.map((row) => ({ ...row })), error: null }
    }

    if (record.op === "update") {
      const patch = record.payload as Row
      const hits = store.filter((row) => matches(row, record.filters))
      for (const row of hits) Object.assign(row, patch)
      return {
        data: record.returning ? hits.map((row) => ({ ...row })) : null,
        error: null,
      }
    }

    if (record.op === "delete") {
      const removed = store.filter((row) => matches(row, record.filters))
      const survivors = store.filter((row) => !matches(row, record.filters))
      store.length = 0
      store.push(...survivors)
      // 本物の FK は ON DELETE SET NULL じゃ。購読を消したら配信行の
      // subscription_id が NULL になることまで写さねば、「失効後も履歴が残る」
      // 契約をテストで確かめられぬ。
      if (record.table === "push_subscriptions") {
        for (const removedRow of removed) {
          for (const delivery of db.notification_deliveries) {
            if (delivery.subscription_id === removedRow.id) {
              delivery.subscription_id = null
            }
          }
        }
      }
      return {
        data: record.returning ? removed.map((row) => ({ ...row })) : null,
        error: null,
      }
    }

    const rows = (
      Array.isArray(record.payload) ? record.payload : [record.payload]
    ) as Row[]
    const conflictColumns = (record.upsertOptions?.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean)
    if (conflictColumns.length === 0) {
      throw new Error("fake-notify-db: upsert には onConflict が要る")
    }
    for (const row of rows) {
      const key = conflictKey(row, conflictColumns)
      const existing = store.find(
        (candidate) => conflictKey(candidate, conflictColumns) === key,
      )
      if (existing) {
        // ignoreDuplicates = ON CONFLICT DO NOTHING。**触ってはならぬ。**
        if (record.upsertOptions?.ignoreDuplicates !== true) {
          Object.assign(existing, row)
        }
        continue
      }
      store.push({ ...(TABLE_DEFAULTS[record.table]?.() ?? {}), ...row })
    }
    return { data: null, error: null }
  }

  function from(table: keyof FakeNotifyDb) {
    const record: QueryRecord = {
      table,
      op: "select",
      columns: null,
      payload: null,
      upsertOptions: null,
      filters: [],
      returning: false,
      order: null,
    }
    records.push(record)

    const settle = () => Promise.resolve(execute(record))

    const builder = {
      select(columns?: string) {
        record.columns = columns ?? null
        // 書込のあとの `.select()` は RETURNING の意味になる。
        if (record.op !== "select") record.returning = true
        return builder
      },
      update(payload: Row) {
        record.op = "update"
        record.payload = payload
        return builder
      },
      upsert(
        payload: Row | Row[],
        options?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) {
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
      lt(column: string, value: unknown) {
        record.filters.push({ kind: "lt", column, value })
        return builder
      },
      lte(column: string, value: unknown) {
        record.filters.push({ kind: "lte", column, value })
        return builder
      },
      gt(column: string, value: unknown) {
        record.filters.push({ kind: "gt", column, value })
        return builder
      },
      // ダイジェストの「その日にかかる予定」は start_date <= day <= end_date で
      // 引く（またがる予定を落とさぬため）。gte はそのために要る。
      gte(column: string, value: unknown) {
        record.filters.push({ kind: "gte", column, value })
        return builder
      },
      is(column: string, value: unknown) {
        if (value !== null) {
          throw new Error("fake-notify-db: .is() は null のみ対応")
        }
        record.filters.push({ kind: "isNull", column })
        return builder
      },
      not(column: string, operator: string, value: unknown) {
        if (operator !== "is" || value !== null) {
          throw new Error("fake-notify-db: .not() は ('col','is',null) のみ対応")
        }
        record.filters.push({ kind: "isNotNull", column })
        return builder
      },
      in(column: string, values: unknown[]) {
        record.filters.push({ kind: "in", column, values })
        return builder
      },
      order(column: string) {
        record.order = column
        return builder
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

  state.client = { from } as unknown as SupabaseClient<Database>
  return state
}
