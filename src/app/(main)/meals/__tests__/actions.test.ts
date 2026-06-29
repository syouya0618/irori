import { describe, it, expect, vi, beforeEach } from "vitest"

// next/cache: revalidatePath はリクエストコンテキスト外で投げるためモック
const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

// log-error: 副作用(console)を抑止
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))

// auth-context: getAuthContext をテストごとに差し替える
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { updateMeal } from "../actions"

const HOUSEHOLD = "house-1"

/**
 * updateMeal が呼ぶ Supabase 操作を模した fake client。
 * - from("meals").select().eq().single(): 所有権チェック
 * - from(...).update()/.delete()/.insert(): 旧実装が叩いていた個別操作(回帰検知用)
 * - rpc(): 新実装の単一トランザクション RPC
 */
function makeSupabase(opts: {
  ownership?: { data: unknown; error: unknown }
  rpcError?: unknown
} = {}) {
  const ownership = opts.ownership ?? {
    data: { household_id: HOUSEHOLD },
    error: null,
  }
  const single = vi.fn().mockResolvedValue(ownership)
  const updateEq = vi.fn().mockResolvedValue({ error: null })
  const deleteEq = vi.fn().mockResolvedValue({ error: null })
  const insert = vi.fn().mockResolvedValue({ error: null })

  const from = vi.fn(() => ({
    select: vi.fn(() => ({ eq: vi.fn(() => ({ single })) })),
    update: vi.fn(() => ({ eq: updateEq })),
    delete: vi.fn(() => ({ eq: deleteEq })),
    insert,
  }))
  const rpc = vi.fn().mockResolvedValue({ error: opts.rpcError ?? null })

  return { client: { from, rpc }, from, rpc }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

const baseInput = {
  id: "meal-1",
  date: "2026-06-15",
  mealType: "dinner" as const,
  title: "カレー",
  isEatingOut: false,
  ingredients: [
    { name: "玉ねぎ", quantity: "1個", category: "vegetable" as const },
    { name: "牛肉", quantity: "", category: "meat" as const },
  ],
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("updateMeal", () => {
  it("更新+食材入替を単一トランザクション RPC に畳む(個別 delete/insert を発行しない)", async () => {
    const { client, from, rpc } = makeSupabase()
    setContext(client)

    const res = await updateMeal(baseInput)

    expect(res).toEqual({ error: null })

    // RPC を 1 回だけ正しい引数で呼ぶ
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("update_meal_with_ingredients", {
      p_meal_id: "meal-1",
      p_date: "2026-06-15",
      p_meal_type: "dinner",
      p_title: "カレー",
      p_is_eating_out: false,
      p_ingredients: [
        { name: "玉ねぎ", quantity: "1個", category: "vegetable" },
        // 空文字 quantity は null へ正規化
        { name: "牛肉", quantity: null, category: "meat" },
      ],
    })

    // meal_ingredients への個別 delete/insert は行わない(中間状態の根絶)
    const touchedTables = (from.mock.calls as unknown as string[][]).map(
      (c) => c[0]
    )
    expect(touchedTables).not.toContain("meal_ingredients")

    expect(revalidatePath).toHaveBeenCalledWith("/meals")
  })

  it("RPC が一意制約違反(23505)を返したら重複メッセージを返す", async () => {
    const { client, rpc } = makeSupabase({ rpcError: { code: "23505" } })
    setContext(client)

    const res = await updateMeal(baseInput)

    expect(res).toEqual({ error: "この日時のメニューは既に登録されています。" })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("RPC が一般エラーを返したら更新失敗メッセージを返す", async () => {
    const { client } = makeSupabase({ rpcError: { code: "XXXXX", message: "boom" } })
    setContext(client)

    const res = await updateMeal(baseInput)

    expect(res).toEqual({ error: "献立の更新に失敗しました。" })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it("他世帯の献立は RPC を呼ばず権限エラーを返す", async () => {
    const { client, rpc } = makeSupabase({
      ownership: { data: { household_id: "other-house" }, error: null },
    })
    setContext(client)

    const res = await updateMeal(baseInput)

    expect(res).toEqual({ error: "この献立を編集する権限がありません。" })
    expect(rpc).not.toHaveBeenCalled()
  })
})
