/**
 * いつものミルク量の Server Action（updateBottleDefault）。
 *
 * - 外部入力（直接 POST でも呼べる）の型・範囲・null を DB に届く前に止める
 * - 世帯は引数で受けず、getAuthContext の利用者の世帯だけを書く（他世帯へ届かぬ）
 * - 楽観的排他は値: 画面が見ていた量のままの時だけ書く。未設定（NULL）との比較は `.is(null)`
 *   （`.eq(col, null)` は `= NULL` となり決して一致せず、初回の設定が永遠に衝突する）
 * - 0 行は読み直して「応答を失った自分の保存の再試行（成功）」「家族の先行変更（衝突）」
 *   「行が読めぬ（失敗）」へ分ける
 * - baby_logs（過去の記録）には触れぬ
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { updateBottleDefault } from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"
import { BOTTLE_DEFAULT_RANGE_ERROR } from "@/lib/domain/bottle-default"
import { STALE_SCREEN_SAVE_ERROR } from "@/lib/domain/timestamptz-text"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

type Result = { data: unknown; error: unknown }

/**
 * households の条件付き update（update().eq().is|eq().select()）と、0 行の時の読み直し
 * （select().eq().maybeSingle()）を持つ fake client。呼ばれた順に calls へ積む。
 */
function makeSupabase(opts: { update: Result; read?: Result }) {
  const calls: unknown[][] = []
  const updateChain = {
    eq: vi.fn((col: string, value: unknown) => {
      calls.push(["update.eq", col, value])
      return updateChain
    }),
    is: vi.fn((col: string, value: unknown) => {
      calls.push(["update.is", col, value])
      return updateChain
    }),
    select: vi.fn(async (cols: string) => {
      calls.push(["update.select", cols])
      return opts.update
    }),
  }
  const readChain = {
    eq: vi.fn((col: string, value: unknown) => {
      calls.push(["read.eq", col, value])
      return readChain
    }),
    maybeSingle: vi.fn(async () => {
      calls.push(["read.maybeSingle"])
      return opts.read ?? { data: null, error: null }
    }),
  }
  const from = vi.fn((table: string) => {
    calls.push(["from", table])
    return {
      update: (body: unknown) => {
        calls.push(["update", body])
        return updateChain
      },
      select: (cols: string) => {
        calls.push(["read.select", cols])
        return readChain
      },
    }
  })
  return { client: { from }, calls, from }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

beforeEach(() => {
  getAuthContext.mockReset()
  mockedLog.mockClear()
  revalidatePath.mockClear()
})

describe("updateBottleDefault の入力検証（DB に届く前に止める）", () => {
  it.each([0, -1, 1000, 12.5, Number.NaN])("範囲外・小数の量 %s は拒む", async (amountMl) => {
    const result = await updateBottleDefault({ amountMl, expectedMl: 120 })
    expect(result).toEqual({ ok: false, error: BOTTLE_DEFAULT_RANGE_ERROR })
    expect(getAuthContext).not.toHaveBeenCalled()
  })

  it("数でない量・入力そのものが無い呼び出しも拒む（直接 POST の想定）", async () => {
    for (const input of [
      { amountMl: "120", expectedMl: null },
      { amountMl: null, expectedMl: null },
      null,
      "120",
    ]) {
      const result = await updateBottleDefault(input as never)
      expect(result).toEqual({ ok: false, error: BOTTLE_DEFAULT_RANGE_ERROR })
    }
    expect(getAuthContext).not.toHaveBeenCalled()
  })

  it("見ていた量が形の合わぬ値なら、無条件の上書きへ倒さず止める", async () => {
    for (const expectedMl of [0, 1000, 1.5, "120", undefined]) {
      const result = await updateBottleDefault({ amountMl: 160, expectedMl } as never)
      expect(result).toEqual({ ok: false, error: STALE_SCREEN_SAVE_ERROR })
    }
    expect(getAuthContext).not.toHaveBeenCalled()
  })

  it("認証できぬ時はその理由をそのまま返し、DB を触らぬ", async () => {
    getAuthContext.mockResolvedValue({ error: "認証されていません", reason: "unauthenticated", context: null })
    const result = await updateBottleDefault({ amountMl: 120, expectedMl: null })
    expect(result).toEqual({ ok: false, error: "認証されていません" })
  })
})

describe("updateBottleDefault の書き込み（自世帯・値の楽観的排他）", () => {
  it("未設定からの初回は `.is(bottle_default_ml, null)` で条件を付ける（.eq(null) ではない）", async () => {
    const { client, calls } = makeSupabase({
      update: { data: [{ bottle_default_ml: 120 }], error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 120, expectedMl: null })
    expect(result).toEqual({ ok: true, amountMl: 120 })
    expect(calls).toEqual([
      ["from", "households"],
      ["update", { bottle_default_ml: 120 }],
      ["update.eq", "id", HOUSEHOLD],
      ["update.is", "bottle_default_ml", null],
      ["update.select", "bottle_default_ml"],
    ])
  })

  it("120 → 160 の変更は、見ていた 120 のままの時だけ書く", async () => {
    const { client, calls } = makeSupabase({
      update: { data: [{ bottle_default_ml: 160 }], error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(result).toEqual({ ok: true, amountMl: 160 })
    expect(calls).toContainEqual(["update.eq", "bottle_default_ml", 120])
    expect(calls).not.toContainEqual(["update.is", "bottle_default_ml", null])
  })

  it("保存できたら /baby の RSC payload を捨てさせる（「戻る」で古い量が釦に出て、そのまま記録されぬ）", async () => {
    const { client } = makeSupabase({
      update: { data: [{ bottle_default_ml: 160 }], error: null },
    })
    setContext(client)
    await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("書くのは households の自世帯の行だけ。baby_logs（過去の記録）には触れぬ", async () => {
    const { client, from, calls } = makeSupabase({
      update: { data: [{ bottle_default_ml: 160 }], error: null },
    })
    setContext(client)
    await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(from.mock.calls.map((c) => c[0])).toEqual(["households"])
    expect(calls).toContainEqual(["update.eq", "id", HOUSEHOLD])
    // 引数に世帯を足しても無視される（型の外から来ても、書く先は context の世帯）
    from.mockClear()
    calls.length = 0
    await updateBottleDefault({ amountMl: 160, expectedMl: 120, householdId: "house-OTHER" } as never)
    expect(calls).toContainEqual(["update.eq", "id", HOUSEHOLD])
    expect(calls).not.toContainEqual(["update.eq", "id", "house-OTHER"])
  })
})

describe("updateBottleDefault の 0 行（読み直して分ける）", () => {
  it("今の量が送った量と同じ = 応答を失った保存の再試行。成功として受ける", async () => {
    const { client, calls } = makeSupabase({
      update: { data: [], error: null },
      read: { data: { bottle_default_ml: 160 }, error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(result).toEqual({ ok: true, amountMl: 160 })
    expect(calls).toContainEqual(["read.eq", "id", HOUSEHOLD])
    // 再試行の成功も保存の成功と同じく /baby を取り直させる
    expect(revalidatePath).toHaveBeenCalledWith("/baby")
  })

  it("家族が先に 140 へ変えていた = 衝突。上書きせず今の量を返す（何も書いておらぬゆえ取り直させぬ）", async () => {
    const { client } = makeSupabase({
      update: { data: [], error: null },
      read: { data: { bottle_default_ml: 140 }, error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ conflict: { currentMl: 140 } })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("初回の設定中に家族が先に決めていた（画面は未設定）も衝突", async () => {
    const { client } = makeSupabase({
      update: { data: [], error: null },
      read: { data: { bottle_default_ml: 100 }, error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 120, expectedMl: null })
    expect(result).toMatchObject({ ok: false, conflict: { currentMl: 100 } })
  })

  it("今は未設定（NULL）に戻っていた時も衝突として null を返す", async () => {
    const { client } = makeSupabase({
      update: { data: [], error: null },
      read: { data: { bottle_default_ml: null }, error: null },
    })
    setContext(client)
    const result = await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
    expect(result).toMatchObject({ ok: false, conflict: { currentMl: null } })
  })

  it("行が読めぬ（RLS で見えぬ・他世帯）・読み直しの失敗は保存の失敗（衝突とも成功とも言わぬ）", async () => {
    for (const read of [
      { data: null, error: null },
      { data: null, error: { message: "boom", code: "XX000" } },
    ]) {
      const { client } = makeSupabase({ update: { data: [], error: null }, read })
      setContext(client)
      const result = await updateBottleDefault({ amountMl: 160, expectedMl: 120 })
      expect(result.ok).toBe(false)
      expect(result).not.toHaveProperty("conflict.currentMl")
      if (!result.ok) expect(result.error).toMatch(/保存できませんでした/)
    }
  })
})

describe("updateBottleDefault の DB エラー", () => {
  it("CHECK 違反（23514）は範囲の文言、それ以外は保存失敗。どちらも構造化ログを残す", async () => {
    const check = makeSupabase({
      update: { data: null, error: { message: "violates check constraint", code: "23514" } },
    })
    setContext(check.client)
    expect(await updateBottleDefault({ amountMl: 120, expectedMl: null })).toEqual({
      ok: false,
      error: BOTTLE_DEFAULT_RANGE_ERROR,
    })

    const other = makeSupabase({
      update: { data: null, error: { message: "column does not exist", code: "42703" } },
    })
    setContext(other.client)
    const result = await updateBottleDefault({ amountMl: 120, expectedMl: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/保存できませんでした/)
    expect(mockedLog).toHaveBeenCalledTimes(2)
    expect(mockedLog.mock.calls[1][3]).toEqual({ userId: "user-1", householdId: HOUSEHOLD })
  })
})
