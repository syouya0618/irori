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
  fetchEventReminder,
  setEventReminder,
} from "../actions"
// "24:00" edge の正規化を検証するため formatTimeJst を spy する用の namespace import。
// vi.mock ではなく vi.spyOn を使い、jstWallClockToIso 等の sibling export を実体のまま
// 保つ(mock 化すると undefined 化して series 経路が壊れる)。
import * as dateJst from "@/lib/utils/date-jst"

const HOUSEHOLD = "house-1"

/**
 * create: insert().select().single() / insert([...]).select() /
 * update・delete: ...eq().eq().eq().select() /
 * 通知の掃除: from("event_reminders").delete().eq().in()（select 無しで await）。
 *
 * **`.eq()` はテーブル名つきで記録する。** 記録が平坦だと、後から別テーブルへの
 * クエリが 1 本増えただけで「三点 eq で絞る」の assert が壊れる（= assert が
 * 目的の絞り込みではなく呼び出し総数を見てしまう）。`eqCallsFor(table)` で
 * 対象テーブルぶんだけを取り出す。
 */
function makeSupabase(opts: {
  single?: { data: unknown; error: unknown }
  mutate?: { data: unknown; error: unknown }
  /** select 無しで await される終端（event_reminders の掃除 delete）の戻り。 */
  bare?: { data: unknown; error: unknown }
}) {
  const single = vi.fn().mockResolvedValue(opts.single ?? { data: { id: "ev-1" }, error: null })
  const selectTerminal = {
    single,
    then: (f: (v: unknown) => unknown) =>
      Promise.resolve(opts.mutate ?? { data: [{ id: "ev-1" }], error: null }).then(f),
  }
  const eqCalls: [string, string, unknown][] = []
  const inCalls: [string, string, unknown][] = []

  const chainFor = (table: string) => {
    const chain: Record<string, unknown> = {
      eq: vi.fn((col: string, val: unknown) => {
        eqCalls.push([table, col, val])
        return chain
      }),
      in: vi.fn((col: string, vals: unknown) => {
        inCalls.push([table, col, vals])
        return chain
      }),
      select: () => selectTerminal,
      // `.select()` を挟まず await される経路（掃除の delete）。
      then: (f: (v: unknown) => unknown) =>
        Promise.resolve(opts.bare ?? { data: null, error: null }).then(f),
    }
    return chain
  }

  const insert = vi.fn((_payload: unknown) => ({ select: () => selectTerminal }))
  const from = vi.fn((table: string) => ({
    insert,
    update: () => chainFor(table),
    delete: () => chainFor(table),
  }))
  return {
    client: { from },
    from,
    insert,
    eqCalls,
    inCalls,
    eqCallsFor: (table: string) =>
      eqCalls.filter(([t]) => t === table).map(([, col, val]) => [col, val]),
    inCallsFor: (table: string) =>
      inCalls.filter(([t]) => t === table).map(([, col, val]) => [col, val]),
  }
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
    expect(sb.eqCallsFor("calendar_events")).toEqual([
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

// ============================================================
// B-2: 通知設定（event_reminders）
// ============================================================

/**
 * 通知経路の mock。`calendar_events` の select（uid 解決）と `event_reminders` の
 * upsert / delete をテーブル名で撃ち分ける。
 */
function makeReminderSupabase(
  opts: {
    /** calendar_events の select 結果（uid 解決）。 */
    eventRows?: { data: unknown; error: unknown }
    /** event_reminders の maybeSingle 結果。 */
    reminderRow?: { data: unknown; error: unknown }
    /** upsert / delete の結果。 */
    write?: { data: unknown; error: unknown }
  } = {},
) {
  const eventRows = opts.eventRows ?? { data: [{ event_uid: "uid-1" }], error: null }
  const reminderRow = opts.reminderRow ?? { data: null, error: null }
  const write = opts.write ?? { data: null, error: null }

  const eqCalls: [string, string, unknown][] = []
  const inCalls: [string, unknown][] = []
  const upserts: { rows: unknown; options: unknown }[] = []

  const chain = (table: string, resolved: unknown) => {
    const c: Record<string, unknown> = {
      eq: vi.fn((col: string, val: unknown) => {
        eqCalls.push([table, col, val])
        return c
      }),
      in: vi.fn((col: string, val: unknown) => {
        inCalls.push([col, val])
        return c
      }),
      maybeSingle: vi.fn(() =>
        Promise.resolve(
          table === "calendar_events"
            ? {
                data: Array.isArray(eventRows.data)
                  ? ((eventRows.data as unknown[])[0] ?? null)
                  : eventRows.data,
                error: eventRows.error,
              }
            : reminderRow,
        ),
      ),
      then: (f: (v: unknown) => unknown) => Promise.resolve(resolved).then(f),
    }
    return c
  }

  const from = vi.fn((table: string) => ({
    select: () => chain(table, table === "calendar_events" ? eventRows : reminderRow),
    upsert: vi.fn((rows: unknown, options: unknown) => {
      upserts.push({ rows, options })
      return Promise.resolve(write)
    }),
    delete: () => chain(table, write),
  }))

  return {
    client: { from },
    from,
    eqCalls,
    inCalls,
    upserts,
    eqCallsFor: (table: string) =>
      eqCalls.filter(([t]) => t === table).map(([, col, val]) => [col, val]),
    tables: () => from.mock.calls.map(([t]) => t),
  }
}

describe("setEventReminder", () => {
  it("提示外の選択値は DB を一切叩かず弾く（Server Action の引数は外部入力）", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await setEventReminder(
      { eventId: "ev-1" },
      "m15" as unknown as "m10",
    )
    expect(r.error).toMatch(/不正/)
    expect(sb.from).not.toHaveBeenCalled()
  })

  it("event_uid をサーバ側で解決し、世帯スコープを必ず付ける", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "ev-1" }, "m30")
    expect(r.error).toBeNull()
    expect(sb.eqCallsFor("calendar_events")).toEqual([
      ["household_id", HOUSEHOLD],
      ["id", "ev-1"],
    ])
  })

  it("**google 由来の予定にも通知を付けられる**（本機能の眼目 / uid は cal|ev 形）", async () => {
    const sb = makeReminderSupabase({
      eventRows: { data: [{ event_uid: "cal@g.com|ev1" }], error: null },
    })
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "google-row-id" }, "prev_day_20")
    expect(r.error).toBeNull()
    expect(sb.upserts).toHaveLength(1)
    expect(sb.upserts[0].rows).toEqual([
      {
        event_uid: "cal@g.com|ev1",
        household_id: HOUSEHOLD,
        remind_kind: "prev_day_20",
        remind_minutes_before: null,
      },
    ])
  })

  it("upsert の payload に remind_at を含めぬ（BEFORE トリガの領分・列 GRANT も無い）", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    await setEventReminder({ eventId: "ev-1" }, "m10")
    for (const row of sb.upserts[0].rows as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty("remind_at")
      expect(row).not.toHaveProperty("created_by")
    }
  })

  it("onConflict は (household_id, event_uid)（uq_event_reminders_event を指す）", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    await setEventReminder({ eventId: "ev-1" }, "m60")
    expect(sb.upserts[0].options).toEqual({
      onConflict: "household_id,event_uid",
    })
  })

  it("none は upsert せず delete する", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "ev-1" }, "none")
    expect(r.error).toBeNull()
    expect(sb.upserts).toHaveLength(0)
    expect(sb.inCalls).toEqual([["event_uid", ["uid-1"]]])
    expect(sb.eqCallsFor("event_reminders")).toEqual([["household_id", HOUSEHOLD]])
  })

  it("シリーズは series_id + source=native で解決し、全開催日ぶんを書く", async () => {
    const sb = makeReminderSupabase({
      eventRows: { data: [{ event_uid: "a" }, { event_uid: "b" }], error: null },
    })
    setContext(sb.client)
    const r = await setEventReminder({ seriesId: "ser-1" }, "m30")
    expect(r.error).toBeNull()
    expect((r as { count: number }).count).toBe(2)
    expect(sb.eqCallsFor("calendar_events")).toEqual([
      ["household_id", HOUSEHOLD],
      ["series_id", "ser-1"],
      ["source", "native"],
    ])
    expect((sb.upserts[0].rows as unknown[]).length).toBe(2)
  })

  it("対応する予定が無ければ書かずにエラー（孤児を作らせぬ）", async () => {
    const sb = makeReminderSupabase({ eventRows: { data: [], error: null } })
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "ev-nope" }, "m30")
    expect(r.error).toMatch(/見つかりません/)
    expect(sb.upserts).toHaveLength(0)
  })

  it("uid 解決の DB error は log して書かずに返す（silent fail を作らぬ）", async () => {
    const sb = makeReminderSupabase({
      eventRows: {
        data: null,
        error: { message: "boom", code: "500", details: "", hint: "" },
      },
    })
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "ev-1" }, "m30")
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
    expect(sb.upserts).toHaveLength(0)
  })

  it("upsert の DB error は log してエラーを返す", async () => {
    const sb = makeReminderSupabase({
      write: {
        data: null,
        error: { message: "boom", code: "42501", details: "", hint: "" },
      },
    })
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "ev-1" }, "m30")
    expect(r.error).toMatch(/失敗/)
    expect(logSupabaseError).toHaveBeenCalled()
  })

  it("空の id は DB を叩かず弾く", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await setEventReminder({ eventId: "" }, "m30")
    expect(r.error).toMatch(/指定されていません/)
    expect(sb.from).not.toHaveBeenCalled()
  })
})

describe("fetchEventReminder", () => {
  it("行が無ければ row: null（未設定は正常な状態）", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await fetchEventReminder("ev-1")
    expect(r).toEqual({ error: null, row: null })
  })

  it("行があればそのまま返し、世帯 + uid で絞る", async () => {
    const sb = makeReminderSupabase({
      reminderRow: {
        data: { remind_kind: "minutes", remind_minutes_before: 30 },
        error: null,
      },
    })
    setContext(sb.client)
    const r = await fetchEventReminder("ev-1")
    expect(r.row).toEqual({ remind_kind: "minutes", remind_minutes_before: 30 })
    expect(sb.eqCallsFor("event_reminders")).toEqual([
      ["household_id", HOUSEHOLD],
      ["event_uid", "uid-1"],
    ])
  })

  it("予定が見つからねばエラー（他世帯の id を渡された場合を含む）", async () => {
    const sb = makeReminderSupabase({ eventRows: { data: [], error: null } })
    setContext(sb.client)
    const r = await fetchEventReminder("ev-other-household")
    expect(r.error).toMatch(/見つかりません/)
    expect(r.row).toBeNull()
  })

  it("空の id は DB を叩かず弾く", async () => {
    const sb = makeReminderSupabase()
    setContext(sb.client)
    const r = await fetchEventReminder("")
    expect(r.error).toMatch(/指定されていません/)
    expect(sb.from).not.toHaveBeenCalled()
  })
})

describe("予定を消したら通知設定も掃除する", () => {
  it("deleteCalendarEvent は **予定を消した後に** event_reminders を掃除する", async () => {
    const sb = makeSupabase({ mutate: { data: [{ id: "ev-1" }], error: null } })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toBeNull()
    // 順序が逆だと、予定の削除が失敗したときに通知だけ失われる。
    expect(sb.from.mock.calls.map(([t]) => t)).toEqual([
      "calendar_events",
      "event_reminders",
    ])
    // native 行の event_uid は id そのもの。
    expect(sb.inCallsFor("event_reminders")).toEqual([["event_uid", ["ev-1"]]])
    expect(sb.eqCallsFor("event_reminders")).toEqual([["household_id", HOUSEHOLD]])
  })

  it("0 行削除（同期予定・権限なし）では掃除を撃たぬ", async () => {
    const sb = makeSupabase({ mutate: { data: [], error: null } })
    setContext(sb.client)
    await deleteCalendarEvent("ev-1")
    expect(sb.from.mock.calls.map(([t]) => t)).toEqual(["calendar_events"])
  })

  it("deleteCalendarEventSeries は削除できた全 id を掃除対象にする", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "a" }, { id: "b" }], error: null },
    })
    setContext(sb.client)
    const r = await deleteCalendarEventSeries("series-1")
    expect(r.error).toBeNull()
    expect(sb.inCallsFor("event_reminders")).toEqual([["event_uid", ["a", "b"]]])
  })

  it("掃除の失敗は log するが、利用者の削除は成功のまま返す（孤児は不活性ゆえ止めぬ）", async () => {
    const sb = makeSupabase({
      mutate: { data: [{ id: "ev-1" }], error: null },
      bare: {
        data: null,
        error: { message: "boom", code: "500", details: "", hint: "" },
      },
    })
    setContext(sb.client)
    const r = await deleteCalendarEvent("ev-1")
    expect(r.error).toBeNull()
    expect(logSupabaseError).toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalled()
  })
})
