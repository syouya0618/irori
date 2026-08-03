/**
 * `token-store.ts` の契約テスト。
 *
 * Supabase クライアントは**呼び出し記録を取る fake** に差し替える（DB の
 * 振る舞いではなく「我々がどのテーブルへ、どの列を、どのスコープで撃つか」を
 * 固定するのが目的じゃ）。RLS の実挙動は pgTAP（D-1 の
 * `supabase/tests/google_calendar_sync_grants_rls.sql`）が実 DB で担保しておる。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import type { Database } from "@/lib/types/database"
import {
  loadGoogleTokens,
  saveGoogleTokens,
  updateGoogleAccessToken,
  type GoogleTokenOwner,
} from "../token-store"

const OWNER: GoogleTokenOwner = {
  connectionId: "conn-1",
  householdId: "house-1",
  userId: "user-1",
}

const CONNECTION_FOUND = { data: { id: "conn-1" }, error: null }

interface QueryRecord {
  table: string
  op: "select" | "update" | "upsert"
  columns: string | null
  filters: Record<string, unknown>
  payload: Record<string, unknown> | null
  upsertOptions: unknown
}

interface FakeResult {
  data: unknown
  error: unknown
}

/** 呼び出しを記録するだけの Supabase 互換ビルダー。結果は与えた順に返す。 */
function createFakeSupabase(results: FakeResult[]) {
  const records: QueryRecord[] = []
  let index = 0

  function from(table: string) {
    const record: QueryRecord = {
      table,
      op: "select",
      columns: null,
      filters: {},
      payload: null,
      upsertOptions: null,
    }
    records.push(record)

    const builder = {
      select(columns: string) {
        record.columns = columns
        return builder
      },
      update(payload: Record<string, unknown>) {
        record.op = "update"
        record.payload = payload
        return builder
      },
      upsert(payload: Record<string, unknown>, options: unknown) {
        record.op = "upsert"
        record.payload = payload
        record.upsertOptions = options
        return builder
      },
      eq(column: string, value: unknown) {
        record.filters[column] = value
        return builder
      },
      maybeSingle() {
        const result = results[index] ?? { data: null, error: null }
        index += 1
        return Promise.resolve(result)
      },
    }
    return builder
  }

  return {
    client: { from } as unknown as SupabaseClient<Database>,
    records,
    consumed: () => index,
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================
// スコープ（RLS が無い以上コードが担う）
// ============================================================

describe("世帯・利用者スコープの強制", () => {
  it("読み取り前に connection を id / household_id / user_id で照合する", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      {
        data: {
          connection_id: "conn-1",
          refresh_token: "rt",
          access_token: "at",
          access_token_expires_at: "2026-08-02T01:00:00.000Z",
          scope: "calendar.readonly",
        },
        error: null,
      },
    ])

    await loadGoogleTokens(fake.client, OWNER)

    expect(fake.records[0].table).toBe("google_connections")
    expect(fake.records[0].filters).toEqual({
      id: "conn-1",
      household_id: "house-1",
      user_id: "user-1",
    })
    expect(fake.records[1].table).toBe("google_tokens")
    expect(fake.records[1].filters).toEqual({ connection_id: "conn-1" })
  })

  it("connection が世帯・利用者と一致せねば throw し、トークンには触れぬ", async () => {
    const fake = createFakeSupabase([{ data: null, error: null }])

    await expect(loadGoogleTokens(fake.client, OWNER)).rejects.toThrow(
      /接続が見つかりません/
    )
    // google_tokens へは 1 度も撃っておらぬこと。
    expect(fake.records.map((r) => r.table)).toEqual(["google_connections"])
  })

  it("照合クエリ自体が失敗したら throw する（false で握り潰さぬ）", async () => {
    const fake = createFakeSupabase([
      { data: null, error: { message: "boom", code: "08006" } },
    ])

    await expect(loadGoogleTokens(fake.client, OWNER)).rejects.toThrow()
    expect(fake.records).toHaveLength(1)
  })

  it("保存・更新も同じ照合を通る", async () => {
    const save = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])
    await saveGoogleTokens(save.client, OWNER, {
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: null,
      scope: null,
    })
    expect(save.records[0].table).toBe("google_connections")

    const update = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])
    await updateGoogleAccessToken(update.client, OWNER, {
      accessToken: "at2",
      accessTokenExpiresAt: null,
      scope: null,
    })
    expect(update.records[0].table).toBe("google_connections")
    expect(update.records[0].filters).toEqual({
      id: "conn-1",
      household_id: "house-1",
      user_id: "user-1",
    })
  })
})

// ============================================================
// loadGoogleTokens
// ============================================================

describe("loadGoogleTokens", () => {
  it("行を我々の語彙へ写す", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      {
        data: {
          connection_id: "conn-1",
          refresh_token: "rt",
          access_token: "at",
          access_token_expires_at: "2026-08-02T01:00:00.000Z",
          scope: "openid email calendar.readonly",
        },
        error: null,
      },
    ])

    await expect(loadGoogleTokens(fake.client, OWNER)).resolves.toEqual({
      connectionId: "conn-1",
      refreshToken: "rt",
      accessToken: "at",
      accessTokenExpiresAt: "2026-08-02T01:00:00.000Z",
      scope: "openid email calendar.readonly",
    })
  })

  it("行が無ければ null（初回接続前）", async () => {
    const fake = createFakeSupabase([CONNECTION_FOUND, { data: null, error: null }])

    await expect(loadGoogleTokens(fake.client, OWNER)).resolves.toBeNull()
  })

  it("error は握り潰さず throw し、構造化ログに全フィールドを出す", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      {
        data: null,
        error: {
          message: "permission denied",
          code: "42501",
          details: "d",
          hint: "h",
        },
      },
    ])

    await expect(loadGoogleTokens(fake.client, OWNER)).rejects.toThrow()
    const dumped = JSON.stringify(errorSpy.mock.calls)
    expect(dumped).toContain("42501")
    expect(dumped).toContain("permission denied")
  })

  it("秘密列（sync_token 等）は 1 つも SELECT せぬ", async () => {
    const fake = createFakeSupabase([CONNECTION_FOUND, { data: null, error: null }])

    await loadGoogleTokens(fake.client, OWNER)

    expect(fake.records[1].columns).not.toContain("*")
    expect(fake.records[1].columns).not.toContain("sync_token")
  })
})

// ============================================================
// saveGoogleTokens（初回接続のみ）
// ============================================================

describe("saveGoogleTokens", () => {
  it("connection_id で upsert し、refresh_token を含む", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])

    await saveGoogleTokens(fake.client, OWNER, {
      refreshToken: "rt-1",
      accessToken: "at-1",
      accessTokenExpiresAt: "2026-08-02T01:00:00.000Z",
      scope: "openid email",
    })

    const write = fake.records[1]
    expect(write.table).toBe("google_tokens")
    expect(write.op).toBe("upsert")
    expect(write.upsertOptions).toEqual({ onConflict: "connection_id" })
    expect(write.payload).toEqual({
      connection_id: "conn-1",
      refresh_token: "rt-1",
      access_token: "at-1",
      access_token_expires_at: "2026-08-02T01:00:00.000Z",
      scope: "openid email",
    })
  })

  it("空の refresh_token は書かずに throw する", async () => {
    const fake = createFakeSupabase([CONNECTION_FOUND])

    await expect(
      saveGoogleTokens(fake.client, OWNER, {
        refreshToken: "   ",
        accessToken: "at",
        accessTokenExpiresAt: null,
        scope: null,
      })
    ).rejects.toThrow(/refresh_token/)
    expect(fake.records.map((r) => r.table)).toEqual(["google_connections"])
  })

  it("0 行なら throw する（upsert は 0 行でも error: null になりうる）", async () => {
    const fake = createFakeSupabase([CONNECTION_FOUND, { data: null, error: null }])

    await expect(
      saveGoogleTokens(fake.client, OWNER, {
        refreshToken: "rt-1",
        accessToken: null,
        accessTokenExpiresAt: null,
        scope: null,
      })
    ).rejects.toThrow(/反映されませんでした/)
  })

  it("失敗ログにトークンの値を出さぬ", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: null, error: { message: "boom", code: "23503" } },
    ])

    await saveGoogleTokens(fake.client, OWNER, {
      refreshToken: "SUPER-SECRET-REFRESH",
      accessToken: "SUPER-SECRET-ACCESS",
      accessTokenExpiresAt: null,
      scope: null,
    }).catch(() => {})

    const dumped = JSON.stringify(errorSpy.mock.calls)
    expect(dumped).not.toContain("SUPER-SECRET-REFRESH")
    expect(dumped).not.toContain("SUPER-SECRET-ACCESS")
  })
})

// ============================================================
// updateGoogleAccessToken（refresh 経路）
// ============================================================

describe("updateGoogleAccessToken", () => {
  it("【重要】payload に refresh_token を絶対に含めぬ", async () => {
    // Google の refresh 応答は refresh_token を返さぬ。共通 upsert に流すと
    // NOT NULL 違反か空値上書き（接続の恒久破壊）になる。
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])

    await updateGoogleAccessToken(fake.client, OWNER, {
      accessToken: "at-2",
      accessTokenExpiresAt: "2026-08-02T02:00:00.000Z",
      scope: "openid email",
    })

    const write = fake.records[1]
    expect(write.op).toBe("update")
    expect(Object.keys(write.payload ?? {})).not.toContain("refresh_token")
    expect(Object.keys(write.payload ?? {}).sort()).toEqual([
      "access_token",
      "access_token_expires_at",
      "scope",
    ])
  })

  it("upsert ではなく UPDATE で撃つ（行が無いときに作らぬ）", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])

    await updateGoogleAccessToken(fake.client, OWNER, {
      accessToken: "at-2",
      accessTokenExpiresAt: null,
      scope: null,
    })

    expect(fake.records[1].op).toBe("update")
    expect(fake.records[1].upsertOptions).toBeNull()
    expect(fake.records[1].filters).toEqual({ connection_id: "conn-1" })
  })

  it("scope が null なら scope 列に触れぬ（既存を消さぬ）", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: { connection_id: "conn-1" }, error: null },
    ])

    await updateGoogleAccessToken(fake.client, OWNER, {
      accessToken: "at-2",
      accessTokenExpiresAt: null,
      scope: null,
    })

    expect(Object.keys(fake.records[1].payload ?? {}).sort()).toEqual([
      "access_token",
      "access_token_expires_at",
    ])
  })

  it("0 行更新なら throw する（error: null の無音 no-op を作らぬ）", async () => {
    const fake = createFakeSupabase([CONNECTION_FOUND, { data: null, error: null }])

    await expect(
      updateGoogleAccessToken(fake.client, OWNER, {
        accessToken: "at-2",
        accessTokenExpiresAt: null,
        scope: null,
      })
    ).rejects.toThrow(/トークン行がありません/)
  })

  it("error は握り潰さず throw する", async () => {
    const fake = createFakeSupabase([
      CONNECTION_FOUND,
      { data: null, error: { message: "boom", code: "42501", hint: "h" } },
    ])

    await expect(
      updateGoogleAccessToken(fake.client, OWNER, {
        accessToken: "at-2",
        accessTokenExpiresAt: null,
        scope: null,
      })
    ).rejects.toThrow()
    expect(JSON.stringify(errorSpy.mock.calls)).toContain("42501")
  })
})
