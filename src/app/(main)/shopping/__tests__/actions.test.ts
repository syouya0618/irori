/**
 * 買い物アクションの「0 行書き込みを成功と偽らない」契約を固定する。
 *
 * `.delete()` は 0 行削除でも `error: null` を返すため、`.select("id")` で削除行を
 * 要求しない限り「消えていないのに success」を返してしまう。ShoppingList の楽観
 * 削除はこの戻り値の error を見て巻き戻すため、silent success は「画面からは
 * 消えたのに DB には残っている」状態を恒久化する（PR #176 レビューで判明）。
 *
 * mock の作りの掟: 中間の `.eq()` を await 可能にしない。await 可能にすると実装が
 * `.select()` を落としても素通りし、この回帰テストが契約を守らせられなくなる。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/supabase/log-error", () => ({ logSupabaseError: vi.fn() }))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import { deleteItem, clearChecked } from "../actions"
import { logSupabaseError } from "@/lib/supabase/log-error"

const mockedLog = vi.mocked(logSupabaseError)
const HOUSEHOLD = "house-1"

type QueryResult = { data: unknown; error: unknown }

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
})

/** delete().eq().eq().select() のみを受け付ける fake client。 */
function makeDeleteClient(result: QueryResult) {
  const select = vi.fn().mockResolvedValue(result)
  const eqHousehold = vi.fn(() => ({ select }))
  const eqId = vi.fn(() => ({ eq: eqHousehold }))
  const del = vi.fn(() => ({ eq: eqId }))
  const from = vi.fn(() => ({ delete: del }))
  return { client: { from }, select, del }
}

describe("deleteItem: 0 行削除を成功と偽らない", () => {
  it("0 行削除ならエラーを返す（楽観削除の巻き戻しが効く条件）", async () => {
    const { client, select } = makeDeleteClient({ data: [], error: null })
    setContext(client)

    const result = await deleteItem("item-1")

    expect(result).toEqual({
      error: "削除に失敗しました（既に削除されている可能性があります）",
    })
    // .select("id") を通っていること = 行数検証が実在すること。
    expect(select).toHaveBeenCalledWith("id")
  })

  it("1 行削除なら成功", async () => {
    const { client } = makeDeleteClient({ data: [{ id: "item-1" }], error: null })
    setContext(client)

    expect(await deleteItem("item-1")).toEqual({ success: true })
  })

  it("ハードエラーはエラー文言 + 構造化ログ", async () => {
    const { client } = makeDeleteClient({
      data: null,
      error: { code: "42501", message: "permission denied" },
    })
    setContext(client)

    expect(await deleteItem("item-1")).toEqual({ error: "削除に失敗しました" })
    expect(mockedLog).toHaveBeenCalledWith(
      "shopping",
      expect.any(String),
      expect.objectContaining({ code: "42501" }),
      expect.objectContaining({ itemId: "item-1", householdId: HOUSEHOLD }),
    )
  })
})

/**
 * clearChecked 用 fake client。
 * shopping_items: select().eq().eq() で読み → delete().eq().eq().select() で削除。
 * purchase_history: insert() を await。
 */
function makeClearCheckedClient(args: {
  checked: QueryResult
  deleted: QueryResult
  historyError?: unknown
}) {
  const deleteSelect = vi.fn().mockResolvedValue(args.deleted)
  const insert = vi.fn().mockResolvedValue({ error: args.historyError ?? null })
  const from = vi.fn((table: string) => {
    if (table === "purchase_history") return { insert }
    return {
      select: () => ({ eq: () => ({ eq: () => Promise.resolve(args.checked) }) }),
      delete: () => ({
        eq: () => ({ eq: () => ({ select: deleteSelect }) }),
      }),
    }
  })
  return { client: { from }, deleteSelect, insert }
}

describe("clearChecked: 削除行数の検証と実績カウント", () => {
  it("0 行削除ならエラー（SELECT で 1 件以上あったのに消えていない = 異常系）", async () => {
    const { client, deleteSelect } = makeClearCheckedClient({
      checked: {
        data: [{ name: "牛乳", category: "other_food", store_type: "supermarket" }],
        error: null,
      },
      deleted: { data: [], error: null },
    })
    setContext(client)

    expect(await clearChecked()).toEqual({
      error: "チェック済みアイテムの削除に失敗しました",
    })
    expect(deleteSelect).toHaveBeenCalledWith("id")
  })

  it("count は事前 SELECT の件数ではなく実際に削除した行数を返す", async () => {
    const { client } = makeClearCheckedClient({
      // 事前 SELECT は 3 件だが、削除できたのは 2 件（他端末が先に 1 件消した等）。
      checked: {
        data: [
          { name: "牛乳", category: "other_food", store_type: "supermarket" },
          { name: "卵", category: "other_food", store_type: "supermarket" },
          { name: "パン", category: "other_food", store_type: "supermarket" },
        ],
        error: null,
      },
      deleted: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(client)

    // removedIds は「サーバが実際に消した id」— 呼び出し側はこれで state から
    // その行だけを落とす（Realtime の DELETE はフィルタ付き購読で届かぬため）。
    expect(await clearChecked()).toEqual({
      success: true,
      count: 2,
      removedIds: ["a", "b"],
    })
  })

  it("履歴 insert の失敗は削除を止めず、構造化ログに残す", async () => {
    const { client } = makeClearCheckedClient({
      checked: {
        data: [{ name: "牛乳", category: "other_food", store_type: "supermarket" }],
        error: null,
      },
      deleted: { data: [{ id: "a" }], error: null },
      historyError: { code: "XX000", message: "boom" },
    })
    setContext(client)

    expect(await clearChecked()).toEqual({
      success: true,
      count: 1,
      removedIds: ["a"],
    })
    expect(mockedLog).toHaveBeenCalledWith(
      "shopping",
      expect.any(String),
      expect.objectContaining({ code: "XX000" }),
      expect.objectContaining({ householdId: HOUSEHOLD }),
    )
  })
})
