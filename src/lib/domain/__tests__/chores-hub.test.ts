/**
 * 家事ハブ（/chores）の「今日の要約」の文（純関数）。正常と危険の対を置く:
 * - 読めなかった枠は failed（「ありません」「0 件」「未定」と言い換えぬ）
 * - 読めた分しか数えられぬ時は注記を添える（黙って少なく数えぬ）
 * - 数え方は各画面と同じ（ごみ = `buildGarbageOverview`、掃除 = `bucketOf`）
 */
import { describe, expect, it } from "vitest"
import {
  CHORES_HUB_FAILED_TEXT,
  cleaningHubLine,
  countCleaningBuckets,
  failedHubLine,
  garbageHubLine,
  mealsHubLine,
} from "../chores-hub"
import type { CleaningMarks, CleaningRoutine } from "../cleaning-schedule"
import { buildGarbageOverview, type EventPurposeRow, type GarbageEventRow } from "../garbage"
import type { TonightSummary } from "@/lib/meals/server/plan-views"
import type { GarbagePageData } from "@/lib/supabase/garbage-overview-query"

// 2026-11-11 は水曜。週は月曜始まり（11-09）・日曜終わり（11-15）
const TODAY = "2026-11-11"

// ───────────────────────── ごみ ─────────────────────────

let seq = 0
const uuid = () => `e1e1e1e1-0000-4000-8000-${String(++seq).padStart(12, "0")}`

function purpose(targetKey: string, garbageKind: string, o: Partial<EventPurposeRow> = {}): EventPurposeRow {
  return {
    id: uuid(),
    scope: "event",
    targetKey,
    purpose: "garbage",
    garbageKind,
    remindDefault: null,
    reminderOptOut: false,
    updatedAt: "2026-11-01T00:00:00.000000+00:00",
    ...o,
  }
}

function event(id: string, startDate: string, o: Partial<GarbageEventRow> = {}): GarbageEventRow {
  return {
    id,
    title: "収集",
    is_all_day: true,
    start_date: startDate,
    end_date: startDate,
    start_at: null,
    source: "native",
    series_id: null,
    medical_record_id: null,
    event_uid: id,
    google_calendar_id: null,
    recurring_event_id: null,
    ...o,
  }
}

function garbageData(
  rows: EventPurposeRow[],
  windowEvents: GarbageEventRow[],
  o: Partial<GarbagePageData> = {},
): GarbagePageData {
  return {
    today: TODAY,
    windowDays: 62,
    purposes: "ok",
    events: "ok",
    overview: buildGarbageOverview({
      rows,
      windowEvents,
      anchorEvents: [],
      unchecked: new Set(),
      today: TODAY,
      collectionLimit: 20,
    }),
    reminders: { status: "ok", byEventKey: {} },
    ...o,
  }
}

describe("garbageHubLine（次の収集日と名称）", () => {
  it("最も近い収集日と、その名称を言う（後の日の収集は混ぜぬ）", () => {
    const a = uuid()
    const b = uuid()
    const line = garbageHubLine(
      garbageData(
        [purpose(a, "プラスチック"), purpose(b, "古紙")],
        [event(b, "2026-11-14"), event(a, "2026-11-12")],
      ),
    )
    expect(line).toEqual({ status: "ok", text: "次の収集日は明日 11月12日（木）、プラスチックです。" })
    expect(line.text).not.toContain("古紙")
  })

  it("同じ日に複数の収集が在れば名称を並べ、多ければ残りを種類の数で言う", () => {
    const ids = [uuid(), uuid(), uuid(), uuid()]
    const kinds = ["燃えるごみ", "プラスチック", "古紙", "びん"]
    const two = garbageHubLine(
      garbageData(
        [purpose(ids[0], kinds[0]), purpose(ids[1], kinds[1])],
        [event(ids[0], TODAY), event(ids[1], TODAY)],
      ),
    )
    expect(two.text).toMatch(/^次の収集日は今日 11月11日（水）、/)
    expect(two.text).toContain("燃えるごみ")
    expect(two.text).toContain("プラスチック")
    expect(two.text).not.toContain("ほか")

    const four = garbageHubLine(
      garbageData(
        ids.map((id, i) => purpose(id, kinds[i])),
        ids.map((id) => event(id, TODAY)),
      ),
    )
    expect(four.text).toContain("ほか1種類")
  })

  it("今日より前に始まった複数日の収集は今日として言い、年が違う日は年を付ける", () => {
    const a = uuid()
    const spanning = garbageHubLine(
      garbageData([purpose(a, "粗大ごみ")], [event(a, "2026-11-10", { end_date: "2026-11-12" })]),
    )
    expect(spanning.text).toBe("次の収集日は今日 11月11日（水）、粗大ごみです。")

    const b = uuid()
    const nextYear = garbageHubLine(
      garbageData([purpose(b, "古紙")], [event(b, "2027-01-04")], { today: "2026-12-30" }),
    )
    // overview は TODAY で組んでおるゆえ、年つきの表記だけを確かめる
    expect(nextYear.text).toContain("2027年1月4日（月）")
  })

  it("分類が 1 つも無い世帯は「まだ登録されていません」。対照: 分類は在るが期間内に回が無い時は別の文", () => {
    expect(garbageHubLine(garbageData([], [event(uuid(), "2026-11-12")]))).toEqual({
      status: "ok",
      text: "ごみの日はまだ登録されていません。",
    })
    const orphan = uuid()
    expect(garbageHubLine(garbageData([purpose(orphan, "古紙")], []))).toEqual({
      status: "ok",
      text: "今日から62日のあいだに、収集日はありません。",
    })
  })

  it("通常の予定へ戻した回・健診の予定は収集日として言わぬ", () => {
    const series = uuid()
    const first = uuid()
    const second = uuid()
    const medical = uuid()
    const line = garbageHubLine(
      garbageData(
        [
          purpose(series, "燃えるごみ", { scope: "series", remindDefault: "prev_day_20" }),
          // 最初の回だけ通常の予定へ戻した
          purpose(first, "", { purpose: "normal", garbageKind: null }),
          purpose(medical, "古紙"),
        ],
        [
          event(first, "2026-11-12", { series_id: series }),
          event(medical, "2026-11-12", { medical_record_id: uuid() }),
          event(second, "2026-11-19", { series_id: series }),
        ],
      ),
    )
    expect(line.text).toBe("次の収集日は8日後 11月19日（木）、燃えるごみです。")
  })

  it("分類か今後の予定を読めねば failed（「ありません」「登録されていません」と言い換えぬ）", () => {
    const a = uuid()
    const rows = [purpose(a, "古紙")]
    const events = [event(a, "2026-11-12")]
    for (const o of [{ purposes: "failed" }, { events: "failed" }] as const) {
      const line = garbageHubLine(garbageData(rows, events, o))
      expect(line).toEqual({ status: "failed", text: CHORES_HUB_FAILED_TEXT.garbage })
      expect(line.text).not.toMatch(/ありません|登録されていません/)
    }
    // 対照: 上限まで読んだだけ（truncated）なら、近い順に読めておるゆえ次の収集日は言える
    expect(garbageHubLine(garbageData(rows, events, { events: "truncated" })).status).toBe("ok")
  })
})

// ───────────────────────── 掃除 ─────────────────────────

function routine(o: Partial<CleaningRoutine> = {}): CleaningRoutine {
  return {
    id: uuid(),
    name: "掃除",
    location: null,
    cadence_unit: "week",
    cadence_interval: 1,
    schedule_mode: "fixed",
    anchor_date: "2026-11-11",
    postponed_occurrence: null,
    postponed_until: null,
    paused_at: null,
    resume_floor: null,
    archived: false,
    updated_at: "2026-11-01T00:00:00.000000+00:00",
    created_at: "2026-11-01T00:00:00.000000+00:00",
    ...o,
  }
}

const noMarks: Record<string, CleaningMarks> = {}
const cleaning = (routines: CleaningRoutine[], o: { unreadableRoutines?: number; truncated?: boolean } = {}) =>
  cleaningHubLine({ routines, marks: noMarks, today: TODAY, unreadableRoutines: 0, truncated: false, ...o })

describe("cleaningHubLine（今日・今週の件数と期限超過の件数）", () => {
  it("今日・今週のこり・期限超過を、掃除の画面と同じ区分で数える", () => {
    const routines = [
      routine({ anchor_date: "2026-11-11" }), // 毎週水曜 → 今日
      routine({ anchor_date: "2026-11-11" }), // 今日（2 件目）
      routine({ anchor_date: "2026-11-14" }), // 今週の土曜 → 今週のこり
      routine({ anchor_date: "2026-11-15" }), // 今週の日曜（週の末尾）→ 今週のこり
      routine({ anchor_date: "2026-11-16" }), // 来週の月曜 → 数えぬ
      routine({ anchor_date: "2026-11-09" }), // 今週の月曜（過ぎた）→ 期限超過
    ]
    expect(countCleaningBuckets({ routines, marks: noMarks, today: TODAY })).toEqual({
      today: 2,
      thisWeek: 2,
      overdue: 1,
      active: 6,
    })
    expect(cleaning(routines)).toEqual({ status: "ok", text: "今日 2件・今週のこり 2件・期限超過 1件" })
  })

  it("年 1 回の項目でも、期限が今週なら今週に数える（周期の長さで外さぬ）", () => {
    const yearly = routine({ cadence_unit: "year", anchor_date: "2026-11-13" })
    expect(cleaning([yearly]).text).toBe("今日 0件・今週のこり 1件・期限超過 0件")
    // 対照: 期限が来年なら数えぬ
    expect(cleaning([routine({ cadence_unit: "year", anchor_date: "2027-03-01" })]).text).toBe(
      "今日・今週が期限の掃除はありません。",
    )
  })

  it("実施済みの回は数えぬ（履歴の要約を使う）。対照: 要約が無ければ期限超過", () => {
    const done = routine({ anchor_date: "2026-11-09" })
    const marks = { [done.id]: { lastDoneOn: "2026-11-09", maxOccurrence: "2026-11-09", maxSkipOccurrence: null } }
    expect(
      cleaningHubLine({ routines: [done], marks, today: TODAY, unreadableRoutines: 0, truncated: false }).text,
    ).toBe("今日・今週が期限の掃除はありません。")
    expect(cleaning([done]).text).toBe("今日 0件・今週のこり 0件・期限超過 1件")
  })

  it("アーカイブ済み・休止中は数えぬ。延期した回は延期先の期限で数える", () => {
    const routines = [
      routine({ anchor_date: "2026-11-11", archived: true }),
      routine({ anchor_date: "2026-11-11", paused_at: "2026-11-01T00:00:00+00:00" }),
      // 今日の回を今週の金曜へ延期 → 今日ではなく今週のこり
      routine({ anchor_date: "2026-11-11", postponed_occurrence: "2026-11-11", postponed_until: "2026-11-13" }),
    ]
    expect(countCleaningBuckets({ routines, marks: noMarks, today: TODAY })).toEqual({
      today: 0,
      thisWeek: 1,
      overdue: 0,
      active: 1,
    })
  })

  it("項目が無い世帯は「まだありません」。対照: アーカイブ済みだけでも同じ", () => {
    expect(cleaning([])).toEqual({ status: "ok", text: "掃除の項目はまだありません。" })
    expect(cleaning([routine({ archived: true })]).text).toBe("掃除の項目はまだありません。")
  })

  it("読めぬ項目・上限で数えられぬ項目が在れば注記を添える（「まだありません」と言わぬ）", () => {
    const only = cleaning([], { unreadableRoutines: 2 })
    expect(only).toEqual({
      status: "ok",
      text: "表示できる掃除の項目がありません。",
      note: "表示できない項目が2件あります。",
    })
    expect(only.text).not.toContain("まだありません")

    const some = cleaning([routine()], { unreadableRoutines: 1, truncated: true })
    expect(some.text).toBe("今日 1件・今週のこり 0件・期限超過 0件")
    expect(some).toHaveProperty("note", "表示できない項目が1件あります。項目が多いため、一部は数えられていません。")
    // 対照: 何も欠けておらねば注記は無い
    expect(cleaning([routine()])).not.toHaveProperty("note")
  })
})

// ───────────────────────── ごはん ─────────────────────────

function tonight(o: {
  state?: TonightSummary["dinner"]["state"]
  stateLabel?: string
  dishes?: string[]
  toBuyCount?: number
}): TonightSummary {
  const state = o.state ?? "confirmed"
  return {
    today: TODAY,
    dinner: {
      state,
      stateLabel: o.stateLabel ?? "確定",
      dishes: (o.dishes ?? []).map((title, i) => ({
        id: `dish-${i}`,
        title,
        roleLabel: i === 0 ? "主菜" : "副菜",
        status: state === "none" ? "proposed" : state,
      })),
    },
    toBuyCount: o.toBuyCount ?? 0,
  }
}

describe("mealsHubLine（今夜の献立と、まだ買うものの件数）", () => {
  it("今夜の料理・状態・まだ買うものの件数を言う", () => {
    expect(mealsHubLine(tonight({ dishes: ["鶏の照り焼き", "ほうれん草のおひたし"], toBuyCount: 3 }))).toEqual({
      status: "ok",
      text: "今夜: 鶏の照り焼き、ほうれん草のおひたし（確定）・まだ買うもの 3件",
    })
  })

  it("料理が多ければ残りを品数で言い、提案中は「提案」と言う（確定と偽らぬ）", () => {
    const line = mealsHubLine(
      tonight({ state: "proposed", stateLabel: "提案", dishes: ["カレー", "サラダ", "みそ汁"], toBuyCount: 0 }),
    )
    expect(line.text).toBe("今夜: カレー、サラダ、ほか1品（提案）・まだ買うものはありません")
    expect(line.text).not.toContain("確定")
  })

  it("今日の献立が無ければ「未定」。買うものが無ければ「ありません」", () => {
    expect(mealsHubLine(tonight({ state: "none", stateLabel: "未定" }))).toEqual({
      status: "ok",
      text: "今夜の献立は未定・まだ買うものはありません",
    })
  })

  it("読めぬ献立の行が在る時は「未定」と言わず、件数を注記する。対照: 読めておれば注記は無い", () => {
    const line = mealsHubLine(tonight({ state: "none", stateLabel: "未定", toBuyCount: 1 }), { plan: 2, grocery: 1 })
    expect(line.text).toBe("今夜の献立は表示できません・まだ買うもの 1件")
    expect(line.text).not.toContain("未定")
    expect(line).toHaveProperty(
      "note",
      "表示できない献立の記録が2件あります。表示できない買い物の項目が1件あります。",
    )
    expect(mealsHubLine(tonight({ dishes: ["カレー"] }))).not.toHaveProperty("note")
  })
})

describe("failedHubLine", () => {
  it("枠ごとに「読み込めませんでした」を言い、空・0 件の文と取り違えぬ", () => {
    for (const part of ["garbage", "cleaning", "meals"] as const) {
      const line = failedHubLine(part)
      expect(line.status).toBe("failed")
      expect(line.text).toContain("読み込めませんでした")
      expect(line.text).not.toMatch(/ありません|未定|0件/)
    }
  })
})
