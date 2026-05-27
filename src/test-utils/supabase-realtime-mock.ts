/**
 * Supabase Realtime チャンネル mock の共通ヘルパー。
 *
 * 2 つの style に対応した builder を提供する:
 *
 * - **inline reducer style**: `buildInlineReducerSupabaseMock`
 *   Realtime callback 内で setState の reducer を回し、payload.new/old を直接
 *   state に反映する scheme。`supabase.from()` は契約上呼ばれないため throw mock。
 *   採用例: BabyDashboard / ShoppingList / StockList
 *
 * - **refetch style**: `buildRefetchSupabaseMock`
 *   Realtime callback 内で `supabase.from(table).select(...).eq().gte().lte().order()`
 *   を chainable に呼んで全体 refetch する scheme。最後の `.order()` が thenable で
 *   `{ data, error }` を resolve する。chain mock は state に蓄積され、test body から
 *   `state.gteMock.toHaveBeenLastCalledWith(...)` 等で個別 assertion 可能。
 *   採用例: MealWeekView
 *
 * ### vi.mock factory hoisting の制約
 *
 * `vi.mock` factory は hoist されるため、factory 内で同期参照できるのは
 * `vi.hoisted` の戻り値のみ。本モジュールの関数を factory 内で使うには
 * `await import("@/test-utils/supabase-realtime-mock")` で dynamic import する。
 * 既存の `await import("vitest")` パターンと同じ仕組み。
 */

import type { vi as ViNamespace } from "vitest"

/**
 * `ReturnType<typeof vi.fn>` の callable な generic 版。
 * vi.fn() のデフォルト generic は呼び出し可能シグネチャを失うため、
 * `(...args: unknown[]) => unknown` を明示して invoke 可能にする。
 */
export type ViFn = ReturnType<
  typeof import("vitest").vi.fn<(...args: unknown[]) => unknown>
>

/**
 * 各テストファイルが `vi.hoisted` で持つ state の型。
 *
 * factory 内で `vi.fn()` を作成して各フィールドへ代入する。
 * テスト本体では `state.fromMock.mockClear()` などで個別 access する。
 *
 * stock-list のように Realtime 以外の mock フィールド
 * （例: `checkAndAutoAddLowStockMock`）を追加する場合は、
 * この型の **superset** としてテストファイル側でローカル拡張する。
 */
export type InlineReducerRealtimeMockState = {
  listeners: Array<(payload: unknown) => void>
  removeChannelMock: ViFn | undefined
  fromMock: ViFn | undefined
}

/**
 * Supabase Realtime postgres_changes payload の型。
 *
 * - INSERT/UPDATE: `new` に新規/更新後 row、`old` は `{}`
 * - DELETE: `new` は `{}`、`old` に `{ id }` のみ
 */
export type RealtimePayload<TRow> = {
  eventType: "INSERT" | "UPDATE" | "DELETE"
  schema: string
  table: string
  commit_timestamp: string
  errors: string[]
  new: TRow | Record<string, never>
  old: { id: string } | Record<string, never>
}

/**
 * `vi.mock("@/lib/supabase/client", async () => ...)` factory 内で呼び出す。
 *
 * - `state.removeChannelMock` / `state.fromMock` を `vi.fn()` で初期化（mutation）
 * - channel mock は `on()` で callback を `state.listeners` に蓄積し、`subscribe()` で
 *   自身を返す chainable 実装
 * - `from()` は呼ばれた時点で `opts.throwMessage` を throw する guard mock
 *   （inline reducer style は Realtime callback 内で `supabase.from()` を呼ばない契約。
 *   呼ばれた場合は契約違反として即時失敗させる）
 *
 * @returns `vi.mock` factory の戻り値となる `{ createClient }` shape
 */
export function buildInlineReducerSupabaseMock(
  viMod: typeof ViNamespace,
  state: InlineReducerRealtimeMockState,
  opts: { throwMessage: string },
): { createClient: () => unknown } {
  state.removeChannelMock = viMod.fn().mockResolvedValue("ok")
  state.fromMock = viMod.fn().mockImplementation(() => {
    throw new Error(opts.throwMessage)
  })
  return {
    createClient: () => {
      const channel: {
        on: (
          event: string,
          filter: unknown,
          cb: (p: unknown) => void,
        ) => typeof channel
        subscribe: () => typeof channel
      } = {
        on: (_event, _filter, cb) => {
          state.listeners.push(cb)
          return channel
        },
        subscribe: () => channel,
      }
      return {
        channel: () => channel,
        removeChannel: state.removeChannelMock,
        from: state.fromMock,
      }
    },
  }
}

/**
 * `beforeEach` で呼ぶ lifecycle helper。
 *
 * ### 重要な実行順序
 *
 * 呼び出し側で `cleanup()` を **先に** 呼んでから本関数を呼ぶこと。
 * `cleanup()` で前テストの unmount が走ると `removeChannelMock` のカウントが
 * 1 増えるため、その後で `mockClear()` しないとカウントがテスト境界を跨ぐ。
 *
 * ### 実行内容
 *   1. `state.listeners.length = 0`  （前テストの callback 蓄積をクリア）
 *   2. `state.removeChannelMock.mockClear()` / `state.fromMock.mockClear()`
 *
 * factory 未実行（一度もテストが render していない）の場合に呼ばれても
 * 安全になるよう undefined ガードを入れている。
 */
export function resetInlineReducerMockState(
  state: InlineReducerRealtimeMockState,
): void {
  state.listeners.length = 0
  state.removeChannelMock?.mockClear()
  state.fromMock?.mockClear()
}

/**
 * 蓄積された channel listeners 全てに payload を流す。
 *
 * テスト側で `act(() => emitPayload(state, makePayload(...)))` の形で使う。
 */
export function emitPayload<TRow>(
  state: Pick<InlineReducerRealtimeMockState, "listeners">,
  payload: RealtimePayload<TRow>,
): void {
  for (const cb of state.listeners) cb(payload)
}

/**
 * 特定 `table` に bind された `makePayload` ファクトリを返す。
 *
 * テストファイル側では:
 * ```ts
 * const makePayload = makePayloadFor<BabyLogData>("baby_logs")
 * makePayload("INSERT", log) // INSERT/UPDATE には row
 * makePayload("DELETE", id)  // DELETE には id のみ
 * ```
 * のように使う。各テストケースで table 名を毎回書かずに済み、
 * 「`baby_logs` テーブルに対するテスト」という意図がモジュール先頭で 1 度宣言される。
 *
 * `commit_timestamp` は固定値（テストは値自体に依存しない）。
 *
 * INSERT/UPDATE は新規/更新後 row、DELETE は id 文字列のみ
 * （Supabase Realtime の DELETE は `payload.old` に `{ id }` のみが入るため）。
 */
export function makePayloadFor<TRow>(
  table: string,
): {
  (eventType: "INSERT" | "UPDATE", row: TRow): RealtimePayload<TRow>
  (eventType: "DELETE", id: string): RealtimePayload<TRow>
} {
  function fn(
    eventType: "INSERT" | "UPDATE",
    row: TRow,
  ): RealtimePayload<TRow>
  function fn(eventType: "DELETE", id: string): RealtimePayload<TRow>
  function fn(
    eventType: "INSERT" | "UPDATE" | "DELETE",
    rowOrId: TRow | string,
  ): RealtimePayload<TRow> {
    const base = {
      schema: "public",
      table,
      commit_timestamp: "2026-04-16T03:30:00Z",
      errors: [],
    }
    if (eventType === "DELETE") {
      return {
        ...base,
        eventType,
        new: {} as Record<string, never>,
        old: { id: rowOrId as string },
      }
    }
    return {
      ...base,
      eventType,
      new: rowOrId as TRow,
      old: {} as Record<string, never>,
    }
  }
  return fn
}

// ===========================================================================
// Refetch style (MealWeekView 等)
// ===========================================================================

/**
 * refetch style 用の mock state。
 *
 * inline reducer の 3 フィールドに加え、
 * - `channelNameMock`: `supabase.channel(name)` の引数 assertion 用
 * - chain mocks: `.select().eq().gte().lte().order()` の各 step を蓄積
 * - `currentResolveData`: 次に `.order()` が thenable として resolve する `data`
 *
 * テスト本体は `state.gteMock.toHaveBeenLastCalledWith("date", ...)` のような
 * assertion を書く前提で、各 chain mock を個別 access できる。
 *
 * ### 想定 chain shape
 *   `.from(table).select(cols).eq(col, val).gte(col, val).lte(col, val).order(col)`
 *
 * 別 shape (e.g. `.match()` / `.in()`) を必要とする 2 例目が出たら、本 helper の
 * chain 構造を拡張するか、別 helper を追加すること。
 */
export type RefetchRealtimeMockState<TRow> = {
  listeners: Array<(payload: unknown) => void>
  removeChannelMock: ViFn | undefined
  channelNameMock: ViFn | undefined
  fromMock: ViFn | undefined
  selectMock: ViFn | undefined
  eqMock: ViFn | undefined
  gteMock: ViFn | undefined
  lteMock: ViFn | undefined
  orderMock: ViFn | undefined
  /** 次に `.order()` が resolve する data。テスト側で `setRefetchData(state, rows)` で更新 */
  currentResolveData: TRow[]
}

/**
 * `vi.mock("@/lib/supabase/client", async () => ...)` factory 内で呼び出す。
 *
 * - chain mock を構築: `.from → .select → .eq → .gte → .lte → .order`
 * - 最後の `.order()` は **thenable** (`Promise<{ data, error }>`) を返し、
 *   `state.currentResolveData` を参照する（テスト side が事前にセットする）
 * - `channel(name)` は name を `state.channelNameMock` に記録してから channel を返す
 *
 * @returns `vi.mock` factory の戻り値となる `{ createClient }` shape
 */
export function buildRefetchSupabaseMock<TRow>(
  viMod: typeof ViNamespace,
  state: RefetchRealtimeMockState<TRow>,
): { createClient: () => unknown } {
  state.removeChannelMock = viMod.fn().mockResolvedValue("ok")
  state.channelNameMock = viMod.fn()

  // 最後の .order() が thenable: state.currentResolveData を resolve する
  state.orderMock = viMod
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ data: state.currentResolveData, error: null }),
    )
  state.lteMock = viMod.fn(() => ({ order: state.orderMock }))
  state.gteMock = viMod.fn(() => ({ lte: state.lteMock }))
  state.eqMock = viMod.fn(() => ({ gte: state.gteMock }))
  state.selectMock = viMod.fn(() => ({ eq: state.eqMock }))
  state.fromMock = viMod.fn(() => ({ select: state.selectMock }))

  return {
    createClient: () => {
      const channel: {
        on: (
          event: string,
          filter: unknown,
          cb: (p: unknown) => void,
        ) => typeof channel
        subscribe: () => typeof channel
      } = {
        on: (_event, _filter, cb) => {
          state.listeners.push(cb)
          return channel
        },
        subscribe: () => channel,
      }
      return {
        channel: (name: string) => {
          state.channelNameMock?.(name)
          return channel
        },
        removeChannel: state.removeChannelMock,
        from: state.fromMock,
      }
    },
  }
}

/**
 * refetch style 用の lifecycle helper。
 *
 * inline reducer 版と同じく `cleanup()` → 本関数の順序が load-bearing。
 *
 * `currentResolveData` も空配列にリセットされる（前テストの仕込みが漏れぬよう）。
 */
export function resetRefetchMockState<TRow>(
  state: RefetchRealtimeMockState<TRow>,
): void {
  state.listeners.length = 0
  state.currentResolveData = []
  state.removeChannelMock?.mockClear()
  state.channelNameMock?.mockClear()
  state.fromMock?.mockClear()
  state.selectMock?.mockClear()
  state.eqMock?.mockClear()
  state.gteMock?.mockClear()
  state.lteMock?.mockClear()
  state.orderMock?.mockClear()
}

/**
 * 次回 refetch が走った時に `.order()` から返す data をセットする糖衣。
 *
 * `state.currentResolveData = rows` と同等じゃが、テスト側で `setRefetchData` の
 * 呼び出しを発見しやすく、Realtime emit 直前の仕込みフェーズを意図明示できる。
 */
export function setRefetchData<TRow>(
  state: RefetchRealtimeMockState<TRow>,
  rows: TRow[],
): void {
  state.currentResolveData = rows
}
