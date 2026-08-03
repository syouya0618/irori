import { describe, it, expect, vi, afterEach } from "vitest"
import {
  classifyEvent,
  diffPage,
  normalizeEvent,
  MAX_MEMO_CHARS,
  MAX_TITLE_CHARS,
  UNTITLED_TITLE,
  type GoogleCalendarEventRow,
  type GoogleRawEvent,
  type GoogleSyncContext,
} from "@/lib/domain/google-calendar-sync"

/**
 * `src/lib/domain/google-calendar-sync.ts`（Phase D-2 純関数コア）の実体テスト。
 * Google API は一切呼ばない（`fetch` も stub しない — そもそも呼ばぬ設計ゆえ）。
 *
 * 各テストは **DB CHECK と同じ述語**（`assertSatisfiesDbChecks`）と
 * **期待値そのもの**の両方を assert する。CHECK 述語だけだと、たとえば
 * `shiftYmd(end.date, -1)` の -1 を 0 に壊しても `end_date >= start_date` は
 * 成立したままで緑になり、回帰を検出できぬ。
 */

const CTX: GoogleSyncContext = {
  householdId: "11111111-1111-4111-8111-111111111111",
  googleCalendarId: "family@group.calendar.google.com",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  sourceUserId: "33333333-3333-4333-8333-333333333333",
}

/**
 * `supabase/migrations/20260709000002_calendar_events.sql` の CHECK 制約を
 * テスト側にも書き写したもの。行が「DB に通る形」であることを機械で固定する。
 */
function assertSatisfiesDbChecks(row: GoogleCalendarEventRow): void {
  // chk_calendar_title: char_length(btrim(title)) BETWEEN 1 AND 200
  // Postgres の char_length はコードポイント数ゆえ Array.from で数える。
  const titleChars = Array.from(row.title.trim()).length
  expect(titleChars).toBeGreaterThanOrEqual(1)
  expect(titleChars).toBeLessThanOrEqual(MAX_TITLE_CHARS)

  // chk_calendar_memo: memo IS NULL OR char_length(memo) <= 1000
  if (row.memo !== null) {
    expect(Array.from(row.memo).length).toBeLessThanOrEqual(MAX_MEMO_CHARS)
  }

  // chk_calendar_date_order: end_date >= start_date
  expect(row.end_date >= row.start_date).toBe(true)

  // chk_calendar_all_day
  if (row.is_all_day) {
    expect(row.start_at).toBeNull()
    expect(row.end_at).toBeNull()
  } else {
    expect(row.start_at).not.toBeNull()
  }

  // chk_calendar_time_order: end_at IS NULL OR (start_at IS NOT NULL AND end_at >= start_at)
  if (row.end_at !== null) {
    expect(row.start_at).not.toBeNull()
    expect(new Date(row.end_at).getTime()).toBeGreaterThanOrEqual(
      new Date(row.start_at as string).getTime()
    )
  }

  // chk_calendar_google_meta: google 行は両方 NOT NULL
  expect(row.source).toBe("google")
  expect(row.google_event_id).toBeTruthy()
  expect(row.google_calendar_id).toBeTruthy()

  // 日付バケットの形式（DATE 列）
  expect(row.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  expect(row.end_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)

  // CHECK 化不能な不変条件（AT TIME ZONE が STABLE なため）。書き込み側の義務ゆえ
  // calendar-validation.ts と同じ述語をここでも固定する。
  if (!row.is_all_day) {
    const jst = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    expect(jst.format(new Date(row.start_at as string))).toBe(row.start_date)
    if (row.end_at !== null) {
      expect(jst.format(new Date(row.end_at))).toBe(row.end_date)
    }
  }
}

/** normalizeEvent が成功することを前提に行を取り出す（失敗なら理由付きで落とす）。 */
function expectRow(raw: GoogleRawEvent, ctx = CTX): GoogleCalendarEventRow {
  const result = normalizeEvent(raw, ctx)
  if (!result.ok) {
    throw new Error(`normalizeEvent が失敗した: ${result.reason}`)
  }
  assertSatisfiesDbChecks(result.row)
  return result.row
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("normalizeEvent — all-day", () => {
  it("単日: Google の排他的 end.date を包含的 end_date へ 1 日戻す", () => {
    const row = expectRow({
      id: "evt-single",
      status: "confirmed",
      summary: "保育園 入園式",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" }, // 排他的
    })

    expect(row.is_all_day).toBe(true)
    expect(row.start_date).toBe("2026-07-08")
    // 排他 07-09 → 包含 07-08。ここを 0 日シフトに壊すと 07-09 になり、
    // CHECK は通るがカレンダーに 2 日間の予定として出る。
    expect(row.end_date).toBe("2026-07-08")
    expect(row.start_at).toBeNull()
    expect(row.end_at).toBeNull()
  })

  it("複数日: 3 日間の予定は end_date が最終日（包含）になる", () => {
    const row = expectRow({
      id: "evt-multi",
      summary: "帰省",
      start: { date: "2026-08-10" },
      end: { date: "2026-08-13" }, // 排他的 = 8/10,11,12 の 3 日間
    })

    expect(row.start_date).toBe("2026-08-10")
    expect(row.end_date).toBe("2026-08-12")
  })

  it("月をまたぐ複数日でも文字列演算で正しく戻る（月初 → 前月末）", () => {
    const row = expectRow({
      id: "evt-month-edge",
      summary: "月跨ぎ",
      start: { date: "2026-07-28" },
      end: { date: "2026-08-01" },
    })

    expect(row.end_date).toBe("2026-07-31")
  })

  it("end.date が欠落したら単日へ退化する（捏造しない）", () => {
    const row = expectRow({
      id: "evt-no-end",
      summary: "終了日なし",
      start: { date: "2026-07-08" },
    })

    expect(row.start_date).toBe("2026-07-08")
    expect(row.end_date).toBe("2026-07-08")
  })
})

describe("normalizeEvent — 時刻付き", () => {
  it("JST 表記の dateTime を UTC 正規形で保持し、日付は JST 暦日になる", () => {
    const row = expectRow({
      id: "evt-timed",
      summary: "1 歳児健診",
      start: { dateTime: "2026-07-08T10:00:00+09:00", timeZone: "Asia/Tokyo" },
      end: { dateTime: "2026-07-08T11:30:00+09:00", timeZone: "Asia/Tokyo" },
    })

    expect(row.is_all_day).toBe(false)
    expect(row.start_at).toBe("2026-07-08T01:00:00.000Z")
    expect(row.end_at).toBe("2026-07-08T02:30:00.000Z")
    expect(row.start_date).toBe("2026-07-08")
    expect(row.end_date).toBe("2026-07-08")
  })

  it("UTC 跨ぎ: 2026-07-08T16:30:00Z は JST では 2026-07-09 になる", () => {
    const row = expectRow({
      id: "evt-utc-cross",
      summary: "夜の予定",
      start: { dateTime: "2026-07-08T16:30:00Z" },
      end: { dateTime: "2026-07-08T17:30:00Z" },
    })

    // string slice で日付化すると 2026-07-08 になる（罠2）。
    expect(row.start_date).toBe("2026-07-09")
    expect(row.end_date).toBe("2026-07-09")
    expect(row.start_at).toBe("2026-07-08T16:30:00.000Z")
  })

  it("end.dateTime が欠落したら end_at=null・end_date=start_date へ退化する", () => {
    const row = expectRow({
      id: "evt-open-end",
      summary: "終了未定",
      start: { dateTime: "2026-07-08T10:00:00+09:00" },
    })

    expect(row.end_at).toBeNull()
    expect(row.start_date).toBe("2026-07-08")
    expect(row.end_date).toBe("2026-07-08")
  })

  it("end_at が start_at より前なら null へ落とし、end_date も start_date へ戻す", () => {
    const row = expectRow({
      id: "evt-reversed-time",
      summary: "逆転",
      start: { dateTime: "2026-07-08T10:00:00+09:00" },
      end: { dateTime: "2026-07-08T09:00:00+09:00" },
    })

    // 丸めずに null（0 分の予定という Google に無い事実を作らない）。
    expect(row.end_at).toBeNull()
    expect(row.end_date).toBe("2026-07-08")
  })

  it("翌 00:00 終わりの予定は end_date が翌日になる（native 経路と同一の振る舞い）", () => {
    const row = expectRow({
      id: "evt-midnight",
      summary: "夜更かし",
      start: { dateTime: "2026-07-08T23:00:00+09:00" },
      end: { dateTime: "2026-07-09T00:00:00+09:00" },
    })

    // calendar-validation.ts が native 入力へ課す
    // `toJstDateString(endAt) === endDate` と同じ結論。ここで 1 日引くと
    // 同期と手入力が食い違う。
    expect(row.start_date).toBe("2026-07-08")
    expect(row.end_date).toBe("2026-07-09")
  })
})

describe("normalizeEvent — タイトル（chk_calendar_title）", () => {
  it("summary 欠落は (無題) になる", () => {
    const row = expectRow({
      id: "evt-no-summary",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(row.title).toBe(UNTITLED_TITLE)
  })

  it("summary が空白のみでも (無題) になる（btrim 後で判定）", () => {
    const row = expectRow({
      id: "evt-blank-summary",
      summary: "   \n\t  ",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(row.title).toBe(UNTITLED_TITLE)
  })

  it("200 文字超の summary は 200 文字へ切り詰める", () => {
    const long = "あ".repeat(250)
    const row = expectRow({
      id: "evt-long-summary",
      summary: long,
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    // 切り詰めを外すと 250 のままになる（CHECK 述語だけでは 200 超を検出できる
    // が、境界の 200 ちょうどであることも固定しておく）。
    expect(Array.from(row.title).length).toBe(MAX_TITLE_CHARS)
    expect(row.title).toBe("あ".repeat(MAX_TITLE_CHARS))
  })

  it("200 文字ちょうどは切り詰めない", () => {
    const exact = "い".repeat(MAX_TITLE_CHARS)
    const row = expectRow({
      id: "evt-exact-summary",
      summary: exact,
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(row.title).toBe(exact)
  })

  it("前後の空白は btrim され、境界の絵文字はサロゲートペアを割らない", () => {
    // 199 文字 + 絵文字 1 文字（UTF-16 では 2 コードユニット）+ 余剰。
    // .slice(0, 200) だと孤立サロゲートが残り、Postgres が不正 UTF-8 として拒否する。
    const summary = `  ${"x".repeat(199)}🍎${"y".repeat(50)}  `
    const row = expectRow({
      id: "evt-astral",
      summary,
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(Array.from(row.title).length).toBe(MAX_TITLE_CHARS)
    expect(row.title).toBe(`${"x".repeat(199)}🍎`)
    // 孤立サロゲートが残っていないことを機械で確認する。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(row.title)).toBe(false)
  })
})

describe("normalizeEvent — メモ（chk_calendar_memo）", () => {
  it("description は memo へマップされる", () => {
    const row = expectRow({
      id: "evt-memo",
      summary: "面談",
      description: "  持ち物: 母子手帳  ",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(row.memo).toBe("持ち物: 母子手帳")
  })

  it("1000 文字超の description は 1000 文字へ切り詰める", () => {
    const row = expectRow({
      id: "evt-long-memo",
      summary: "長文メモ",
      description: "う".repeat(1500),
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(Array.from(row.memo as string).length).toBe(MAX_MEMO_CHARS)
    expect(row.memo).toBe("う".repeat(MAX_MEMO_CHARS))
  })

  it("description が空文字・空白のみなら null になる", () => {
    expect(
      expectRow({
        id: "evt-empty-memo",
        summary: "メモ空",
        description: "",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      }).memo
    ).toBeNull()

    expect(
      expectRow({
        id: "evt-blank-memo",
        summary: "メモ空白",
        description: "   ",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      }).memo
    ).toBeNull()
  })
})

describe("normalizeEvent — 日付順序（chk_calendar_date_order）", () => {
  it("end.date === start.date（不正入力）は -1 で逆転するので start_date へ丸める", () => {
    const row = expectRow({
      id: "evt-same-date",
      summary: "不正な終了日",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-08" }, // 排他規約からすると不正
    })

    expect(row.start_date).toBe("2026-07-08")
    expect(row.end_date).toBe("2026-07-08")
  })

  it("end.date が start.date より前なら start_date へ丸める", () => {
    const row = expectRow({
      id: "evt-backwards",
      summary: "逆転",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-01" },
    })

    expect(row.end_date).toBe("2026-07-08")
  })
})

describe("normalizeEvent — メタ列", () => {
  it("Google 由来のメタと ctx の値を行へ焼き込む", () => {
    const row = expectRow({
      id: "evt-meta",
      summary: "打ち合わせ",
      location: "  区役所 3F  ",
      htmlLink: "https://www.google.com/calendar/event?eid=abc",
      recurringEventId: "recurring-parent-1",
      updated: "2026-07-01T12:00:00+09:00",
      etag: '"3456789"',
      iCalUID: "abc@google.com",
      start: { dateTime: "2026-07-08T10:00:00+09:00" },
      end: { dateTime: "2026-07-08T11:00:00+09:00" },
    })

    expect(row.household_id).toBe(CTX.householdId)
    expect(row.google_calendar_id).toBe(CTX.googleCalendarId)
    expect(row.subscription_id).toBe(CTX.subscriptionId)
    expect(row.source_user_id).toBe(CTX.sourceUserId)
    expect(row.source).toBe("google")
    expect(row.location).toBe("区役所 3F")
    expect(row.html_link).toBe("https://www.google.com/calendar/event?eid=abc")
    expect(row.recurring_event_id).toBe("recurring-parent-1")
    expect(row.google_updated).toBe("2026-07-01T03:00:00.000Z")
    expect(row.etag).toBe('"3456789"')
    expect(row.ical_uid).toBe("abc@google.com")
  })

  it("メタが無い/不正でも行は作られ、該当列だけ null へ退化する", () => {
    const row = expectRow({
      id: "evt-meta-missing",
      summary: "メタなし",
      updated: "not-a-timestamp",
      start: { date: "2026-07-08" },
      end: { date: "2026-07-09" },
    })

    expect(row.google_updated).toBeNull()
    expect(row.location).toBeNull()
    expect(row.html_link).toBeNull()
    expect(row.recurring_event_id).toBeNull()
    expect(row.etag).toBeNull()
    expect(row.ical_uid).toBeNull()
  })

  it("ctx を通じて別世帯・別購読の値が混ざらない", () => {
    const other: GoogleSyncContext = {
      householdId: "99999999-9999-4999-8999-999999999999",
      googleCalendarId: "other@group.calendar.google.com",
      subscriptionId: null,
      sourceUserId: null,
    }
    const row = expectRow(
      {
        id: "evt-other",
        summary: "他世帯",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
      other
    )

    expect(row.household_id).toBe(other.householdId)
    expect(row.google_calendar_id).toBe(other.googleCalendarId)
    expect(row.subscription_id).toBeNull()
    expect(row.source_user_id).toBeNull()
  })
})

describe("normalizeEvent — 行を作らない入力（chk_calendar_google_meta ほか）", () => {
  it("id が無い生イベントは行を作らない", () => {
    const result = normalizeEvent(
      { summary: "id なし", start: { date: "2026-07-08" }, end: { date: "2026-07-09" } },
      CTX
    )
    expect(result).toEqual({ ok: false, reason: "missing_google_event_id" })
  })

  it("id が空白のみでも行を作らない", () => {
    const result = normalizeEvent(
      {
        id: "   ",
        summary: "空白 id",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
      CTX
    )
    expect(result).toEqual({ ok: false, reason: "missing_google_event_id" })
  })

  it("ctx.googleCalendarId が空なら行を作らない", () => {
    const result = normalizeEvent(
      { id: "evt-x", summary: "カレンダー不明", start: { date: "2026-07-08" } },
      { ...CTX, googleCalendarId: "" }
    )
    expect(result).toEqual({ ok: false, reason: "missing_google_calendar_id" })
  })

  it("start が無いイベント（cancelled 以外）は行を作らない", () => {
    const result = normalizeEvent({ id: "evt-no-start", summary: "開始なし" }, CTX)
    expect(result).toEqual({ ok: false, reason: "missing_start" })
  })

  it("start.date が壊れていても throw せず skip 理由を返す", () => {
    // shiftYmd / toJstDateString は不正値で RangeError を throw する。
    // 前段ガードが無いと 1 件で同期全体が死ぬ。
    for (const bad of ["garbage", "2026-13-01", "2026-02-30", "20260708", ""]) {
      const result = normalizeEvent(
        { id: `evt-bad-${bad}`, summary: "壊れた日付", start: { date: bad } },
        CTX
      )
      expect(result).toEqual({ ok: false, reason: "invalid_start" })
    }
  })

  it("start.dateTime が壊れていても throw せず skip 理由を返す", () => {
    for (const bad of ["garbage", "2026-07-08", "2026-07-08T99:99:99Z"]) {
      const result = normalizeEvent(
        { id: `evt-bad-dt-${bad}`, summary: "壊れた時刻", start: { dateTime: bad } },
        CTX
      )
      expect(result).toEqual({ ok: false, reason: "invalid_start" })
    }
  })

  it("end.date が壊れていても行は作られ、単日へ退化する", () => {
    const row = expectRow({
      id: "evt-bad-end",
      summary: "終了日が壊れている",
      start: { date: "2026-07-08" },
      end: { date: "garbage" },
    })

    expect(row.end_date).toBe("2026-07-08")
  })
})

describe("classifyEvent", () => {
  it("cancelled は normalizeEvent を呼ばずに delete を返す（start/end が無くても落ちない）", () => {
    const result = classifyEvent({ id: "evt-cancelled", status: "cancelled" }, CTX)
    expect(result).toEqual({ op: "delete", googleEventId: "evt-cancelled" })
  })

  it("cancelled で id が無ければ delete せず skip する（WHERE が壊れるため）", () => {
    const result = classifyEvent({ status: "cancelled" }, CTX)
    expect(result).toEqual({
      op: "skip",
      reason: "missing_google_event_id",
      googleEventId: null,
    })
  })

  it("confirmed は upsert を返す", () => {
    const result = classifyEvent(
      {
        id: "evt-ok",
        status: "confirmed",
        summary: "予定",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
      CTX
    )
    expect(result.op).toBe("upsert")
    if (result.op !== "upsert") throw new Error("upsert のはず")
    assertSatisfiesDbChecks(result.event)
    expect(result.event.end_date).toBe("2026-07-08")
  })

  it("status 未知値でも upsert として扱う（enum drift 防御 = 除外したい値のみ名指し）", () => {
    const result = classifyEvent(
      {
        id: "evt-unknown-status",
        status: "someFutureStatus",
        summary: "未知ステータス",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
      CTX
    )
    expect(result.op).toBe("upsert")
  })

  it("行を作れない生イベントは skip 理由付きで返る", () => {
    const result = classifyEvent({ summary: "id なし", start: { date: "2026-07-08" } }, CTX)
    expect(result).toEqual({
      op: "skip",
      reason: "missing_google_event_id",
      googleEventId: null,
    })
  })
})

describe("diffPage", () => {
  it("upsert / delete / skip が混在するページを振り分ける", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    const page: GoogleRawEvent[] = [
      {
        id: "evt-a",
        status: "confirmed",
        summary: "入園式",
        start: { date: "2026-07-08" },
        end: { date: "2026-07-09" },
      },
      { id: "evt-b", status: "cancelled" },
      {
        id: "evt-c",
        summary: "健診",
        start: { dateTime: "2026-07-08T16:30:00Z" },
        end: { dateTime: "2026-07-08T17:30:00Z" },
      },
      { status: "cancelled" }, // id 無し → skip
      { id: "evt-e", summary: "開始なし" }, // start 無し → skip
    ]

    const diff = diffPage(page, CTX)

    expect(diff.upserts.map((r) => r.google_event_id)).toEqual(["evt-a", "evt-c"])
    expect(diff.deletes).toEqual(["evt-b"])
    expect(diff.skipped).toEqual([
      { googleEventId: null, reason: "missing_google_event_id" },
      { googleEventId: "evt-e", reason: "missing_start" },
    ])

    for (const row of diff.upserts) assertSatisfiesDbChecks(row)
    expect(diff.upserts[0].end_date).toBe("2026-07-08")
    expect(diff.upserts[1].start_date).toBe("2026-07-09") // UTC 跨ぎ

    // 黙って落とさない: skip ごとに構造化ログを出す。
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      "[google-calendar-sync] 生イベントを取り込めず破棄",
      expect.objectContaining({
        reason: "missing_start",
        googleEventId: "evt-e",
        googleCalendarId: CTX.googleCalendarId,
        householdId: CTX.householdId,
      })
    )
  })

  it("壊れた日付が混ざっても throw せず、健全な行だけを返す", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})

    const diff = diffPage(
      [
        { id: "evt-broken", summary: "壊れた", start: { date: "garbage" } },
        {
          id: "evt-good",
          summary: "健全",
          start: { date: "2026-07-08" },
          end: { date: "2026-07-09" },
        },
      ],
      CTX
    )

    expect(diff.upserts).toHaveLength(1)
    expect(diff.upserts[0].google_event_id).toBe("evt-good")
    expect(diff.skipped).toEqual([
      { googleEventId: "evt-broken", reason: "invalid_start" },
    ])
  })

  it("空ページは全て空配列を返し、ログも出さない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(diffPage([], CTX)).toEqual({ upserts: [], deletes: [], skipped: [] })
    expect(warn).not.toHaveBeenCalled()
  })

  it("長い summary が 1 件混ざってもバッチ全体が CHECK 違反にならない", () => {
    const diff = diffPage(
      [
        {
          id: "evt-long",
          summary: "え".repeat(400),
          description: "お".repeat(2000),
          start: { date: "2026-07-08" },
          end: { date: "2026-07-09" },
        },
        {
          id: "evt-normal",
          summary: "普通",
          start: { date: "2026-07-08" },
          end: { date: "2026-07-09" },
        },
      ],
      CTX
    )

    expect(diff.skipped).toEqual([])
    for (const row of diff.upserts) assertSatisfiesDbChecks(row)
    expect(Array.from(diff.upserts[0].title).length).toBe(MAX_TITLE_CHARS)
    expect(Array.from(diff.upserts[0].memo as string).length).toBe(MAX_MEMO_CHARS)
  })
})
