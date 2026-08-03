/**
 * calendar/actions の単体テスト(DB なし・meals actions.test.ts の idiom)。
 * 検証・所有権/source ガード(0 行→編集/削除不可)・silent fail 防止を回帰対象にする。
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

const revalidatePath = vi.fn()
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }))
const logSupabaseError = vi.fn()
vi.mock("@/lib/supabase/log-error", () => ({
  logSupabaseError: (...args: unknown[]) => logSupabaseError(...args),
}))
const getAuthContext = vi.fn()
vi.mock("@/lib/supabase/auth-context", () => ({
  getAuthContext: () => getAuthContext(),
}))

import {
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteCalendarEventSeries,
} from "../actions"
// "24:00" edge の正規化を検証するため formatTimeJst を spy する用の namespace import。
// vi.mock ではなく vi.spyOn を使い、jstWallClockToIso 等の sibling export を実体のまま
// 保つ(mock 化すると undefined 化して series 経路が壊れる)。
import * as dateJst from "@/lib/utils/date-jst"

const HOUSEHOLD = "house-1"

/**
 * create: insert().select().single() / insert([...]).select() /
 * update・delete: ...eq().eq().eq().select()。
 * eqCalls に全 .eq(col, val) を記録し、シリーズ削除の三点 eq を検証できるようにする。
 */
function makeSupabase(opts: {
  single?: { data: unknown; error: unknown }
  mutate?: { data: unknown; error: unknown }
}) {
  const single = vi.fn().mockResolvedValue(opts.single ?? { data: { id: "ev-1" }, error: null })
  const selectTerminal = {
    single,
    then: (f: (v: unknown) => unknown) =>
      Promise.resolve(opts.mutate ?? { data: [{ id: "ev-1" }], error: null }).then(f),
  }
  const eqCalls: [string, unknown][] = []
  const eqChain: Record<string, unknown> = {
    eq: vi.fn((col: string, val: unknown) => {
      eqCalls.push([col, val])
      return eqChain
    }),
    select: () => selectTerminal,
  }
  const insert = vi.fn((_payload: unknown) => ({ select: () => selectTerminal }))
  const from = vi.fn(() => ({
    insert,
    update: () => eqChain,
    delete: () => eqChain,
  }))
  return { client: { from }, from, insert, eqCalls }
}

function setContext(supabase: unknown) {
  getAuthContext.mockResolvedValue({
    error: null,
    reason: null,
    context: { supabase, userId: "user-1", householdId: HOUSEHOLD },
  })
}

const baseInput = {
  title: "検診",
  isAllDay: true,
  startDate: "2026-07-09",
  endDate: "2026-07-09",
}

beforeEach(() => vi.clearAllMocks())

describe("createCalendarEvent", () => {
  it("検証エラー(空 title)で insert を叩かず error を返す", async () => {
    const sb = makeSupabase({})
    setContext(sb.client)
    const r = await createCalendarEvent({ ...baseInput, title: "  " })
    expect(r.error).toBe("タイトルを入力してください")
    expect(sb.insert).not.toHaveBeenCalled()
  })

  it("正常系で eventId を返す", async () => {
    const sb = makeSupabase({ single: { data: { id: "ev-9" }, error: null } })
    setContext(sb.client)
    const r = await createCalendarEvent(baseInput)
    expect(r.error).toBeNull()
    expect((r as { eventId: string }).eventId).toBe("ev-9")
    expect(revalidatePath).toHaveBeenCalledWith("/calendar")
  })

  it("DB error で logSupabaseError を呼びエラーを返す", async () => {
    const sb = makeSupabase({
      single: { data: null, error: { message: "boom", code: "500", details: "", hint: "" } },
    })
    setContext(sb.client)
    const r = await createCalendarEvent(baseInput)
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
  })
})

describe("updateCalendarEvent", () => {
  it("0 行(同期予定/権限なし)で「編集できません」を返す", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    const r = await updateCalendarEvent({ ...baseInput, id: "ev-1" })
    expect(r.error).toMatch(/編集できません/)
  })

  it("1 行更新で成功", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "ev-1" }], error: null } })
    setContext(sb.client)
    const r = await updateCalendarEvent({ ...baseInput, id: "ev-1" })
    expect(r.error).toBeNull()
    expect(revalidatePath).toHaveBeenCalledWith("/calendar")
  })
})

describe("deleteCalendarEvent", () => {
  it("0 行で「削除できません」を返す", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toMatch(/削除できません/)
  })

  it("1 行削除で成功", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "ev-1" }], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toBeNull()
  })
})

describe("createCalendarEvent (繰り返し)", () => {
  const weeklyInput = {
    title: "検診",
    isAllDay: true,
    startDate: "2026-07-09",
    endDate: "2026-07-09",
    repeat: "weekly" as const,
    repeatUntil: "2026-07-23", // 07-09 / 07-16 / 07-23 = 3 開催日
  }

  it("単一の insert([...]) で全開催日を一括挿入し series_id で束ねる", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null },
    })
    setContext(sb.client)
    const r = await createCalendarEvent(weeklyInput)

    expect(r.error).toBeNull()
    // insert は 1 回のみ(行ごとのループ insert 禁止)。
    expect(sb.insert).toHaveBeenCalledTimes(1)
    const rows = sb.insert.mock.calls[0][0] as Array<{
      start_date: string
      series_id: string
      source: string
      household_id: string
    }>
    expect(rows).toHaveLength(3)
    expect(rows.map((row) => row.start_date)).toEqual([
      "2026-07-09",
      "2026-07-16",
      "2026-07-23",
    ])
    // 全行が同一 series_id を共有し、source=native / 自世帯に拘束される。
    const seriesId = rows[0].series_id
    expect(seriesId).toBeTruthy()
    expect(rows.every((row) => row.series_id === seriesId)).toBe(true)
    expect(rows.every((row) => row.source === "native")).toBe(true)
    expect(rows.every((row) => row.household_id === HOUSEHOLD)).toBe(true)
    // 返り値は seriesId と件数を運ぶ。
    expect((r as { seriesId: string }).seriesId).toBe(seriesId)
    expect((r as { count: number }).count).toBe(3)
    expect(revalidatePath).toHaveBeenCalledWith("/calendar")
  })

  it("時刻付きは各開催日に元の JST 時刻を再構成する", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(sb.client)
    // 14:00 JST = 05:00Z。startDate と同日。
    const r = await createCalendarEvent({
      title: "面談",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-09T05:00:00Z",
      endAt: "2026-07-09T06:00:00Z",
      repeat: "weekly",
      repeatUntil: "2026-07-16",
    })
    expect(r.error).toBeNull()
    const rows = sb.insert.mock.calls[0][0] as Array<{
      start_date: string
      start_at: string
      end_at: string
    }>
    expect(rows).toHaveLength(2)
    // 2 週目(07-16)も 14:00〜15:00 JST(= 05:00〜06:00Z)で再構成される。
    expect(rows[1].start_date).toBe("2026-07-16")
    expect(rows[1].start_at).toBe("2026-07-16T05:00:00.000Z")
    expect(rows[1].end_at).toBe("2026-07-16T06:00:00.000Z")
  })

  it("JST 深夜0時開始の時刻付き繰り返しは各行 start_at が各開催日の JST 00:00 になる", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(sb.client)
    // 00:00 JST(= 前日 15:00Z)。toJstDateString は 2026-07-09 を返し startDate と一致。
    const r = await createCalendarEvent({
      title: "早朝当番",
      isAllDay: false,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      startAt: "2026-07-08T15:00:00Z",
      repeat: "weekly",
      repeatUntil: "2026-07-16",
    })
    expect(r.error).toBeNull()
    const rows = sb.insert.mock.calls[0][0] as Array<{
      start_date: string
      start_at: string
    }>
    expect(rows).toHaveLength(2)
    // 各開催日の JST 00:00 = 前日 15:00Z。翌日 0 時へ流れず当日 0 時を保つ。
    expect(rows[0].start_at).toBe("2026-07-08T15:00:00.000Z")
    expect(rows[1].start_date).toBe("2026-07-16")
    expect(rows[1].start_at).toBe("2026-07-15T15:00:00.000Z")
  })

  it('formatTimeJst が "24:00" を返す h24 環境でも各行 start_at は当日 JST 00:00 に正規化される', async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(sb.client)
    // ICU h24 既定環境の再現: startTime 抽出の formatTimeJst 1 回だけ "24:00" を返す。
    // sibling(jstWallClockToIso 等)は実体のまま。呼び出しは startAt のみ(endAt なし)ゆえ
    // formatTimeJst は 1 回で自消費する。finally で spy を実体へ確実に戻す。
    const spy = vi
      .spyOn(dateJst, "formatTimeJst")
      .mockReturnValueOnce("24:00")
    try {
      const r = await createCalendarEvent({
        title: "早朝当番",
        isAllDay: false,
        startDate: "2026-07-09",
        endDate: "2026-07-09",
        startAt: "2026-07-08T15:00:00Z",
        repeat: "weekly",
        repeatUntil: "2026-07-16",
      })
      expect(r.error).toBeNull()
      const rows = sb.insert.mock.calls[0][0] as Array<{ start_at: string }>
      expect(rows).toHaveLength(2)
      // "24:00" → "00:00" 正規化 + 各開催日 date で当日 JST 00:00(= 前日 15:00Z)。
      // 正規化が無ければ jstWallClockToIso が翌日 0 時へ流し 16:00Z 等へずれる。
      expect(rows[0].start_at).toBe("2026-07-08T15:00:00.000Z")
      expect(rows[1].start_at).toBe("2026-07-15T15:00:00.000Z")
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      spy.mockRestore()
    }
  })

  it("複数日 span は各開催日で開始↔終了の日数差を維持する", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(sb.client)
    // 2 日間(07-09〜07-10)の終日予定を毎週 07-16 まで = 2 開催。
    const r = await createCalendarEvent({
      title: "合宿",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-10",
      repeat: "weekly",
      repeatUntil: "2026-07-16",
    })
    expect(r.error).toBeNull()
    const rows = sb.insert.mock.calls[0][0] as Array<{
      start_date: string
      end_date: string
    }>
    expect(rows).toHaveLength(2)
    // 2 週目も開始+1日の span(2 日間)を保つ。
    expect(rows[1]).toMatchObject({
      start_date: "2026-07-16",
      end_date: "2026-07-17",
    })
  })

  it("検証エラー(repeatUntil 欠落)で insert を叩かず error を返す", async () => {
    const sb = makeSupabase({})
    setContext(sb.client)
    const r = await createCalendarEvent({
      title: "検診",
      isAllDay: true,
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      repeat: "weekly",
    })
    expect(r.error).toBe("繰り返しの終了日を入力してください")
    expect(sb.insert).not.toHaveBeenCalled()
  })

  it("DB error で logSupabaseError を呼びエラーを返す", async () => {
    const sb = makeSupabase({
      mutate: { data: null, error: { message: "boom", code: "500", details: "", hint: "" } },
    })
    setContext(sb.client)
    const r = await createCalendarEvent(weeklyInput)
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
  })
})

describe("deleteCalendarEventSeries", () => {
  it("household_id / series_id / source=native の三点 eq で絞り込む", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "a" }, { id: "b" }], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEventSeries("series-1")
    expect(r.error).toBeNull()
    expect((r as { count: number }).count).toBe(2)
    expect(sb.eqCalls).toEqual([
      ["household_id", HOUSEHOLD],
      ["series_id", "series-1"],
      ["source", "native"],
    ])
  })

  it("0 行(同期予定/権限なし/存在しない series)で「削除できません」を返す", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEventSeries("series-1")
    expect(r.error).toMatch(/削除できません/)
  })

  it("DB error で logSupabaseError を呼びエラーを返す", async () => {
    const sb = makeSupabase({
      mutate: { data: null, error: { message: "boom", code: "500", details: "", hint: "" } },
    })
    setContext(sb.client)
    const r = await deleteCalendarEventSeries("series-1")
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
  })
})

/**
 * `calendar_events` を書く**全ての**成功経路が、この表を読むページを漏れなく
 * 無効化することを固定する。
 *
 * ## なぜ「/calendar だけ」では足りぬか
 * `/meals` の「今日・明日の予定」カードのデータは `meals/page.tsx` がサーバで
 * `calendar_events` を引いて `initialEvents` として渡す = **`/meals` の RSC
 * ペイロードに乗っておる**。`/meals` を無効化せねば `staleTimes.dynamic: 10`
 * により最大 10 秒、作成前のペイロードが再利用される。しかもカードの復帰時
 * refetch は `visibilitychange`/`focus` 契機ゆえ、BottomNav の遷移
 * （同一ドキュメント内）では発火せず**自己修復もせぬ**。
 *
 * ## toHaveBeenCalledWith ではなく「集合の一致」で書く理由
 * `toHaveBeenCalledWith("/meals")` だけだと **`/calendar` を消しても緑**になる。
 * 集合で固定すれば**足りなくても余っても**赤くなる。将来 `calendar_events` を
 * 読むページが増えたら、ここと `revalidateCalendarConsumers` の両方が同時に
 * 直らねば通らぬ。
 */
describe("calendar_events を書く経路は読者ページを漏れなく無効化する", () => {
  const CONSUMERS = ["/calendar", "/meals"]

  const cases: [string, () => Promise<unknown>][] = [
    ["createCalendarEvent(単発)", () => createCalendarEvent(baseInput)],
    [
      "createCalendarEvent(繰り返し)",
      () =>
        createCalendarEvent({
          ...baseInput,
          repeat: "weekly",
          repeatUntil: "2026-07-30",
        }),
    ],
    ["updateCalendarEvent", () => updateCalendarEvent({ id: "ev-1", ...baseInput })],
    ["deleteCalendarEvent", () => deleteCalendarEvent("ev-1")],
    ["deleteCalendarEventSeries", () => deleteCalendarEventSeries("series-1")],
  ]

  it.each(cases)("%s", async (_name, run) => {
    setContext(makeSupabase({}).client)
    const r = (await run()) as { error: string | null }
    // 前提: 成功経路であること（失敗経路では revalidate せぬのが正しい）
    expect(r.error).toBeNull()
    expect(revalidatePath.mock.calls.map(([p]) => p).sort()).toEqual([...CONSUMERS].sort())
  })

  it("失敗経路（0 行）では 1 つも無効化せぬ", async () => {
    setContext(makeSupabase({ mutate: { data: [], error: null } }).client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toMatch(/削除できません/)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
