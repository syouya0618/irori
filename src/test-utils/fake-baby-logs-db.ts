/**
 * 再送契約の結合テスト用の、baby_logs だけを持つ小さな in-memory「DB」と supabase client。
 *
 * 目的は「DB に保存した後で応答だけが失われ、時計が進んでから利用者が押し直す」を、本物の
 * クライアント部品（FeedingTimer 等）・本物の Server Action（insertBabyLog / sameRecordedContent）・
 * 主キー重複（23505）と世帯の絞り込みを持つ保存先の 3 つを繋いで再現すること。mock の 2 回目を
 * 成功にするだけの試験では、サーバに保存済みの内容との照合を通らぬゆえ不整合を見逃す
 * （2026-10-27 の監査 F01）。
 *
 * 実 DB の意味論のうち、ここで真似るのは試験が依存する次の点だけ:
 * - 主キー（id）重複の INSERT は 23505 で失敗し、行は増えぬ
 * - 読みは household_id で絞る（RLS の代わり。別世帯の行は見えぬ）
 * - updated_at はマイクロ秒つきの表記で DB が振る（クライアントは作らぬ）
 * - logged_at は送らねば DB の now()
 * RLS・CHECK・トリガそのものは PGlite の pgTAP（supabase/tests）で別に確かめる。
 */

type Row = Record<string, unknown>

export interface FakeBabyLogsDb {
  rows: Row[]
  /** 次の書込みで DB が振る時刻（テストが進める）。 */
  now: () => Date
  client: unknown
}

let seq = 0

function microIso(date: Date): string {
  // 例: 2026-07-19T04:01:30.123456+00:00（PostgREST が返す表記に寄せる）
  seq = (seq + 1) % 1000
  const base = date.toISOString().replace("Z", "")
  return `${base}${String(seq).padStart(3, "0")}+00:00`
}

function project(row: Row, columns: string): Row {
  const cols = columns.split(",").map((c) => c.trim()).filter(Boolean)
  if (cols.length === 1 && cols[0] === "*") return { ...row }
  const out: Row = {}
  for (const c of cols) out[c] = row[c] ?? null
  return out
}

export function createFakeBabyLogsDb(opts: {
  now: () => Date
  householdId: string
}): FakeBabyLogsDb {
  const db: FakeBabyLogsDb = { rows: [], now: opts.now, client: null }

  function from(table: string) {
    if (table !== "baby_logs") throw new Error(`fake db: unexpected table ${table}`)
    const filters: Array<(row: Row) => boolean> = []
    let mode: "select" | "insert" = "select"
    let columns = "*"
    let pendingInsert: Row | null = null

    const run = (): { data: Row[] | null; error: { code: string; message: string } | null } => {
      if (mode === "insert" && pendingInsert) {
        const row = pendingInsert
        pendingInsert = null
        if (row.id !== undefined && db.rows.some((r) => r.id === row.id)) {
          return {
            data: null,
            error: { code: "23505", message: "duplicate key value violates unique constraint" },
          }
        }
        const at = db.now()
        const stored: Row = {
          id: row.id ?? crypto.randomUUID(),
          logged_at: row.logged_at ?? at.toISOString().replace("Z", "+00:00"),
          created_at: microIso(at),
          updated_at: microIso(at),
          ...Object.fromEntries(Object.entries(row).filter(([k]) => k !== "id")),
        }
        if (row.logged_at === undefined) stored.logged_at = at.toISOString().replace("Z", "+00:00")
        db.rows.push(stored)
        return { data: [project(stored, columns)], error: null }
      }
      const visible = db.rows.filter((r) => r.household_id === opts.householdId)
      return {
        data: visible.filter((r) => filters.every((f) => f(r))).map((r) => project(r, columns)),
        error: null,
      }
    }

    const builder = {
      insert(row: Row) {
        mode = "insert"
        pendingInsert = row
        return builder
      },
      select(cols = "*") {
        columns = cols
        return builder
      },
      eq(col: string, value: unknown) {
        filters.push((r) => r[col] === value)
        return builder
      },
      in(col: string, values: unknown[]) {
        filters.push((r) => values.includes(r[col]))
        return builder
      },
      async single() {
        const { data, error } = run()
        if (error) return { data: null, error }
        if (!data || data.length !== 1) {
          return { data: null, error: { code: "PGRST116", message: "not exactly one row" } }
        }
        return { data: data[0], error: null }
      },
      async maybeSingle() {
        const { data, error } = run()
        if (error) return { data: null, error }
        return { data: data?.[0] ?? null, error: null }
      },
      then<T>(resolve: (v: ReturnType<typeof run>) => T, reject?: (e: unknown) => T) {
        try {
          return Promise.resolve(resolve(run()))
        } catch (e) {
          return reject ? Promise.resolve(reject(e)) : Promise.reject(e)
        }
      },
    }
    return builder
  }

  db.client = { from }
  return db
}
