import { describe, expect, it } from "vitest"
import { CHORE_PENDING_LABEL_MAX } from "@/lib/domain/chore-pending"
import {
  attachEventPurposes,
  buildEventPurposeIndex,
  buildGarbageOverview,
  collectionDayRelativeLabel,
  eventKeyOf,
  eventPurposeLoadOf,
  findOrphanPurposes,
  GARBAGE_DEFAULT_REMINDER,
  GARBAGE_EVENT_COLUMNS,
  GARBAGE_KIND_MAX,
  GARBAGE_KIND_PRESETS,
  GARBAGE_SHORT_LABEL_CHARS,
  GARBAGE_MUTE_EFFECT,
  garbageAriaLabel,
  garbageKindVisual,
  garbageMuteLabel,
  garbageOf,
  garbageReminderEffect,
  garbageRequestLabel,
  isGarbageRequest,
  normalizeGarbageKind,
  parseEventPurposeRow,
  parseEventPurposeRows,
  parseGarbageEventRow,
  prevDayReminderPassed,
  purposeLookupKey,
  resolveEventPurpose,
  seriesKeyOf,
  UNCLASSIFIED_PURPOSE,
  upcomingGarbageCollections,
  type EventPurposeRow,
  type GarbageEventRow,
} from "@/lib/domain/garbage"
import { CALENDAR_EVENT_COLUMNS_WITH_KEYS } from "@/lib/domain/calendar-event-columns"

const SERIES = "5e000000-0000-4000-8000-000000000010"
const E1 = SERIES // シリーズの初回の行。id が series_id と同じ値（実際に起きる衝突）
const E2 = "5e000000-0000-4000-8000-000000000011"
const E3 = "5e000000-0000-4000-8000-000000000012"
const SINGLE = "5e000000-0000-4000-8000-000000000020"
const P1 = "9a000000-0000-4000-8000-000000000001"
const P2 = "9a000000-0000-4000-8000-000000000002"
const P3 = "9a000000-0000-4000-8000-000000000003"

const VERSION = "2026-11-11T00:00:00.000000+00:00"
const NOTHING_SEEN = { series: null, event: null }

function purpose(o: Partial<EventPurposeRow> & { id: string; scope: "event" | "series"; targetKey: string }): EventPurposeRow {
  return {
    purpose: "garbage",
    garbageKind: "燃えるごみ",
    remindDefault: o.scope === "series" ? "prev_day_20" : null,
    reminderOptOut: false,
    updatedAt: VERSION,
    ...o,
  }
}

function native(id: string, o: Partial<GarbageEventRow> = {}): GarbageEventRow {
  return {
    id,
    title: "予定",
    is_all_day: true,
    start_date: "2026-11-12",
    end_date: o.start_date ?? "2026-11-12",
    start_at: null,
    source: "native",
    series_id: null,
    event_uid: id,
    ...o,
  }
}

function google(eventId: string, o: Partial<GarbageEventRow> = {}): GarbageEventRow {
  return {
    id: `row-${eventId}`,
    title: "Google の予定",
    is_all_day: true,
    start_date: "2026-11-12",
    end_date: o.start_date ?? "2026-11-12",
    start_at: null,
    source: "google",
    series_id: null,
    event_uid: `cal@example.invalid|${eventId}`,
    google_calendar_id: "cal@example.invalid",
    recurring_event_id: null,
    ...o,
  }
}

describe("seriesKeyOf / eventKeyOf（SQL の event_series_key・event_uid の写し）", () => {
  it("native のシリーズは series_id、単発は null", () => {
    expect(seriesKeyOf(native(E2, { series_id: SERIES }))).toBe(SERIES)
    expect(seriesKeyOf(native(SINGLE))).toBeNull()
  })

  it("google のシリーズは calendarId|recurringEventId、単発は null", () => {
    expect(seriesKeyOf(google("rec_1", { recurring_event_id: "rec" }))).toBe("cal@example.invalid|rec")
    expect(seriesKeyOf(google("single"))).toBeNull()
    // google の行に native 流の series_id が在っても、鍵には使わぬ
    expect(seriesKeyOf(google("single", { series_id: SERIES }))).toBeNull()
  })

  it("1 回の予定の鍵は event_uid。列を持たぬ native は id、列を持たぬ google は推測せぬ", () => {
    expect(eventKeyOf(google("g1"))).toBe("cal@example.invalid|g1")
    expect(eventKeyOf({ id: E2, source: "native" })).toBe(E2)
    expect(eventKeyOf({ id: "row-g1", source: "google" })).toBeNull()
  })
})

describe("resolveEventPurpose", () => {
  const seriesRow = purpose({ id: P1, scope: "series", targetKey: SERIES, garbageKind: "プラスチック" })

  it("分類を読めなかった時（null）は unknown。未分類と偽らぬ", () => {
    expect(resolveEventPurpose(native(SINGLE), null)).toEqual({ kind: "unknown" })
    // 対照: 読めて 0 行なら「何も分類しておらぬ通常の予定」
    expect(resolveEventPurpose(native(SINGLE), [])).toEqual(UNCLASSIFIED_PURPOSE)
  })

  it("シリーズ既定はどの回にも効く", () => {
    const r = resolveEventPurpose(native(E2, { series_id: SERIES }), [seriesRow])
    expect(r).toMatchObject({ kind: "garbage", label: "プラスチック", scope: "series", purposeId: P1 })
  })

  it("この回だけ別の名称にした例外が、シリーズ既定より優先される", () => {
    const exception = purpose({ id: P2, scope: "event", targetKey: E2, garbageKind: "粗大ごみ" })
    const r = resolveEventPurpose(native(E2, { series_id: SERIES }), [seriesRow, exception])
    expect(r).toMatchObject({ kind: "garbage", label: "粗大ごみ", scope: "event", seriesLabel: "プラスチック" })
    // 対照: 例外の無い回はシリーズ既定のまま
    expect(resolveEventPurpose(native(E3, { series_id: SERIES }), [seriesRow, exception])).toMatchObject({
      label: "プラスチック",
      scope: "series",
    })
  })

  it("この回だけ通常へ戻した例外は normal（exception: true）", () => {
    const back = purpose({ id: P2, scope: "event", targetKey: E2, purpose: "normal", garbageKind: null })
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [seriesRow, back])).toEqual({
      kind: "normal",
      exception: true,
      seriesLabel: "プラスチック",
      seriesRemindDefault: "prev_day_20",
      seen: { series: VERSION, event: VERSION },
    })
  })

  it("画面が見ておった行の版（series / event）を、表記のまま運ぶ（R38）", () => {
    const s = purpose({ id: P1, scope: "series", targetKey: SERIES, updatedAt: "2026-11-11T01:02:03.654321+00:00" })
    const e = purpose({ id: P2, scope: "event", targetKey: E2, garbageKind: "粗大ごみ", updatedAt: "2026-11-11T04:05:06.000001+00:00" })
    // シリーズ既定だけの回: event は null（行が無い）
    expect(resolveEventPurpose(native(E3, { series_id: SERIES }), [s, e])).toMatchObject({
      seen: { series: "2026-11-11T01:02:03.654321+00:00", event: null },
    })
    // 例外の在る回: 両方（マイクロ秒を落とさぬ）
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [s, e])).toMatchObject({
      seen: { series: "2026-11-11T01:02:03.654321+00:00", event: "2026-11-11T04:05:06.000001+00:00" },
    })
    // 用途を持たぬ event 行（通知の明示 OFF だけ）も「見ておった行」
    const optOut = purpose({ id: P3, scope: "event", targetKey: E3, purpose: null, garbageKind: null, reminderOptOut: true, updatedAt: "2026-11-11T07:08:09.123456+00:00" })
    expect(resolveEventPurpose(native(E3, { series_id: SERIES }), [s, optOut])).toMatchObject({
      kind: "garbage",
      scope: "series",
      seen: { series: "2026-11-11T01:02:03.654321+00:00", event: "2026-11-11T07:08:09.123456+00:00" },
    })
    // シリーズ既定が解除された後に残った明示 OFF だけの行: 未分類だが、行は見ておる
    expect(resolveEventPurpose(native(E3, { series_id: SERIES }), [optOut])).toEqual({
      kind: "normal",
      exception: false,
      seriesLabel: null,
      seriesRemindDefault: null,
      seen: { series: null, event: "2026-11-11T07:08:09.123456+00:00" },
    })
    // 対照: 何も無い予定は「行なし」
    expect(resolveEventPurpose(native(SINGLE), [s, e])).toMatchObject({ seen: { series: null, event: null } })
  })

  it("シリーズの通知の既定（前日 20:00 / 止めてある）を運ぶ（R10）", () => {
    const off = purpose({ id: P1, scope: "series", targetKey: SERIES, remindDefault: "none" })
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [off])).toMatchObject({ seriesRemindDefault: "none" })
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [seriesRow])).toMatchObject({
      seriesRemindDefault: "prev_day_20",
    })
    // この回だけ別の名称にした回も、元のシリーズの既定を運ぶ
    const exception = purpose({ id: P2, scope: "event", targetKey: E2, garbageKind: "粗大ごみ" })
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [off, exception])).toMatchObject({
      scope: "event",
      seriesRemindDefault: "none",
    })
    // シリーズ既定の無い予定は null
    expect(resolveEventPurpose(native(SINGLE), [])).toMatchObject({ seriesRemindDefault: null })
  })

  it("series_id == 初回の行 id でも、series 行と event 行を取り違えぬ", () => {
    // 鍵の文字列が同じ 2 行: シリーズ既定（プラ）と、初回の回だけの例外（粗大）
    const exception = purpose({ id: P2, scope: "event", targetKey: E1, garbageKind: "粗大ごみ" })
    const rows = [seriesRow, exception]
    expect(resolveEventPurpose(native(E1, { series_id: SERIES }), rows)).toMatchObject({
      label: "粗大ごみ",
      scope: "event",
    })
    // 2 回目は例外に巻き込まれぬ（event 行の鍵は初回の id だけ）
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), rows)).toMatchObject({
      label: "プラスチック",
      scope: "series",
    })
    // event 行しか無い時、同じ文字列を series_id に持つ別の回へ「シリーズ既定」として漏れぬ
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), [exception])).toEqual(UNCLASSIFIED_PURPOSE)
    // series 行しか無い時、同じ文字列の id を持つ**単発**の予定へ漏れぬ
    expect(resolveEventPurpose(native(E1), [seriesRow])).toEqual(UNCLASSIFIED_PURPOSE)
  })

  it("通知の明示 OFF だけの行（用途なし）は分類を変えず、印だけ運ぶ", () => {
    const optOut = purpose({ id: P2, scope: "event", targetKey: E2, purpose: null, garbageKind: null, reminderOptOut: true })
    const r = resolveEventPurpose(native(E2, { series_id: SERIES }), [seriesRow, optOut])
    expect(r).toMatchObject({ kind: "garbage", scope: "series", reminderOptOut: true })
    expect(resolveEventPurpose(native(E3, { series_id: SERIES }), [seriesRow, optOut])).toMatchObject({
      reminderOptOut: false,
    })
  })

  it("Google の予定も同じ規則で解決する（出どころと用途は別の軸）", () => {
    const gSeries = purpose({ id: P3, scope: "series", targetKey: "cal@example.invalid|rec", garbageKind: "資源" })
    expect(resolveEventPurpose(google("rec_3", { recurring_event_id: "rec" }), [gSeries])).toMatchObject({
      kind: "garbage",
      label: "資源",
    })
    const gSingle = purpose({ id: P2, scope: "event", targetKey: "cal@example.invalid|single", garbageKind: "古紙" })
    expect(resolveEventPurpose(google("single"), [gSingle])).toMatchObject({ label: "古紙", scope: "event" })
  })

  it("鍵の列を持たぬ google の行は unknown（例外の有無を確かめられぬ）", () => {
    expect(resolveEventPurpose({ id: "row", source: "google" }, [])).toEqual({ kind: "unknown" })
  })

  it("このアプリが知らぬ用途は unknown（通常とも ごみ とも言わぬ）", () => {
    const rows = parseEventPurposeRows([
      { id: P1, scope: "series", target_key: SERIES, purpose: "laundry", garbage_kind: null, remind_default: "none", reminder_opt_out: false, updated_at: null },
    ])
    expect(rows?.rows[0].purpose).toBe("other")
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), rows!.rows)).toEqual({ kind: "unknown" })
  })

  it("索引（Map）を渡しても同じ結果になる", () => {
    const index = buildEventPurposeIndex([seriesRow])
    expect(resolveEventPurpose(native(E2, { series_id: SERIES }), index)).toMatchObject({ label: "プラスチック" })
  })
})

describe("分類の行の読み取り", () => {
  const raw = {
    id: P1,
    scope: "event",
    target_key: SINGLE,
    purpose: "garbage",
    garbage_kind: " 古紙 ",
    remind_default: null,
    reminder_opt_out: false,
    updated_at: "2026-11-11T00:00:00.123456+00:00",
  }

  it("正しい行を読み、版は表記のまま運ぶ", () => {
    expect(parseEventPurposeRow(raw)).toEqual({
      id: P1,
      scope: "event",
      targetKey: SINGLE,
      purpose: "garbage",
      garbageKind: "古紙",
      remindDefault: null,
      reminderOptOut: false,
      updatedAt: "2026-11-11T00:00:00.123456+00:00",
    })
  })

  it("未知の scope・鍵なしは読めぬ行として数える（黙って捨てぬ）", () => {
    expect(parseEventPurposeRow({ ...raw, scope: "household" })).toBeNull()
    expect(parseEventPurposeRow({ ...raw, target_key: "" })).toBeNull()
    expect(parseEventPurposeRows([raw, { ...raw, scope: "household" }])).toMatchObject({ unreadable: 1 })
    expect(parseEventPurposeRows("nope")).toBeNull()
  })

  it("ごみなのに名称が無い行は、名称を捏造せず other にする", () => {
    expect(parseEventPurposeRow({ ...raw, garbage_kind: null })?.purpose).toBe("other")
  })

  it("取得の失敗・読めぬ行の混入は failed（空の ok と区別する）", () => {
    expect(eventPurposeLoadOf(null, true)).toEqual({ status: "failed" })
    expect(eventPurposeLoadOf([{ ...raw, scope: "x" }], false)).toEqual({ status: "failed" })
    expect(eventPurposeLoadOf([], false)).toEqual({ status: "ok", rows: [] })
  })

  it("attachEventPurposes: failed なら全件 unknown（ごみの日を通常と偽らぬ）", () => {
    const events = [native(SINGLE)]
    expect(attachEventPurposes(events, { status: "failed" })[0].purpose).toEqual({ kind: "unknown" })
    const ok = attachEventPurposes(events, { status: "ok", rows: [purpose({ id: P1, scope: "event", targetKey: SINGLE })] })
    expect(garbageOf(ok[0])?.label).toBe("燃えるごみ")
    // 対照: 用途の載っておらぬ行・不明・通常は「ごみ」ではない
    expect(garbageOf({})).toBeNull()
    expect(garbageOf({ purpose: { kind: "unknown" } })).toBeNull()
  })
})

describe("名称と見た目", () => {
  it("プリセットは指定の 8 種で重複が無く、どれも 20 文字以内", () => {
    expect(GARBAGE_KIND_PRESETS.map((p) => p.label)).toEqual([
      "燃えるごみ",
      "燃えないごみ",
      "プラスチック",
      "資源",
      "びん・缶",
      "ペットボトル",
      "古紙",
      "粗大ごみ",
    ])
    expect(new Set(GARBAGE_KIND_PRESETS.map((p) => p.icon)).size).toBe(8)
    for (const preset of GARBAGE_KIND_PRESETS) {
      expect(normalizeGarbageKind(preset.label)).toBe(preset.label)
      // 明暗を対で持つ
      expect(preset.tone.bg).toMatch(/dark:/)
      expect(preset.tone.text).toMatch(/dark:/)
    }
  })

  it("月のマスに出す短い名称は、どの種別も 3 文字以内（狭いマスで切れぬ）", () => {
    for (const preset of GARBAGE_KIND_PRESETS) {
      expect(Array.from(preset.short).length).toBeLessThanOrEqual(GARBAGE_SHORT_LABEL_CHARS)
      expect(preset.short.length).toBeGreaterThan(0)
    }
    // 短い名称どうしが紛れぬ（燃える / 不燃 など）
    expect(new Set(GARBAGE_KIND_PRESETS.map((p) => p.short)).size).toBe(GARBAGE_KIND_PRESETS.length)
  })

  it("プリセットに無い名称は汎用の見た目へ退化し、短い名称は先頭 3 文字", () => {
    expect(garbageKindVisual("乾電池・蛍光灯")).toMatchObject({ icon: "generic", short: "乾電池" })
    expect(garbageKindVisual(null)).toMatchObject({ icon: "generic", short: "ごみ" })
    // 対照: プリセットは自分のアイコン
    expect(garbageKindVisual("古紙")).toMatchObject({ icon: "paper", short: "古紙" })
  })

  it("名称は前後の空白を除いて 1〜20 文字（符号点で数える）", () => {
    expect(normalizeGarbageKind("  古紙 ")).toBe("古紙")
    expect(normalizeGarbageKind("あ".repeat(GARBAGE_KIND_MAX))).toHaveLength(GARBAGE_KIND_MAX)
    expect(normalizeGarbageKind("あ".repeat(GARBAGE_KIND_MAX + 1))).toBeNull()
    // サロゲートペア 20 文字は UTF-16 では 40 単位だが、DB の char_length と同じく 20 と数える
    expect(normalizeGarbageKind("𠮷".repeat(20))).not.toBeNull()
    expect(normalizeGarbageKind("𠮷".repeat(21))).toBeNull()
    expect(normalizeGarbageKind("   ")).toBeNull()
    expect(normalizeGarbageKind("燃える\nごみ")).toBeNull()
    expect(normalizeGarbageKind(42)).toBeNull()
  })

  it("読み上げの文は種別を言い、重複をまとめる", () => {
    expect(garbageAriaLabel(["燃えるごみ", "古紙", "燃えるごみ"])).toBe("ごみ（燃えるごみ、古紙）")
    expect(garbageAriaLabel([])).toBe("ごみ")
  })
})

describe("isGarbageRequest（画面・Server Action・端末の控えが通す同じ門）", () => {
  const save = { op: "save", eventId: E2, scope: "event", action: "garbage", garbageKind: "古紙", reminder: "prev_day_20", seen: NOTHING_SEEN }

  it("見ておった版（seen）を持たぬ・形の合わぬ要求は拒む（版なしの保存を通さぬ。R38）", () => {
    const { seen: _seen, ...without } = save
    expect(isGarbageRequest(without)).toBe(false)
    expect(isGarbageRequest({ ...save, seen: null })).toBe(false)
    expect(isGarbageRequest({ ...save, seen: { series: null } })).toBe(false)
    expect(isGarbageRequest({ ...save, seen: { series: null, event: null, household: "x" } })).toBe(false)
    expect(isGarbageRequest({ ...save, seen: { series: "yesterday", event: null } })).toBe(false)
    expect(isGarbageRequest({ ...save, seen: { series: 1731283200000, event: null } })).toBe(false)
    expect(isGarbageRequest({ ...save, seen: { series: "2026-11-11T00:00:00+00:00'; DROP TABLE x;--", event: null } })).toBe(false)
    // 対照: DB の表記（マイクロ秒・オフセットつき）はそのまま通る
    expect(isGarbageRequest({ ...save, seen: { series: "2026-11-11T01:02:03.654321+00:00", event: null } })).toBe(true)
    expect(isGarbageRequest({ ...save, seen: { series: "2026-11-11T01:02:03+00:00", event: "2026-11-11T01:02:03.5Z" } })).toBe(true)
  })

  it("正しい要求を通す", () => {
    expect(isGarbageRequest(save)).toBe(true)
    expect(isGarbageRequest({ ...save, scope: "series" })).toBe(true)
    expect(isGarbageRequest({ ...save, action: "normal", garbageKind: null, reminder: "off" })).toBe(true)
    expect(isGarbageRequest({ ...save, action: "clear", garbageKind: null, reminder: "keep" })).toBe(true)
    expect(isGarbageRequest({ op: "delete-orphan", purposeId: P1 })).toBe(true)
  })

  it("世帯 id などの余分な項目を持つ要求は拒む（黙って捨てて通さぬ）", () => {
    expect(isGarbageRequest({ ...save, householdId: "9a000000-0000-4000-8000-0000000000aa" })).toBe(false)
    expect(isGarbageRequest({ op: "delete-orphan", purposeId: P1, household_id: "x" })).toBe(false)
  })

  it("RPC が拒む組み合わせは手前で拒む", () => {
    expect(isGarbageRequest({ ...save, scope: "series", action: "normal", garbageKind: null })).toBe(false)
    expect(isGarbageRequest({ ...save, action: "clear", garbageKind: null, reminder: "prev_day_20" })).toBe(false)
    expect(isGarbageRequest({ ...save, action: "clear" })).toBe(false) // ごみ以外に名称
    expect(isGarbageRequest({ ...save, garbageKind: null })).toBe(false) // ごみなのに名称なし
    expect(isGarbageRequest({ ...save, garbageKind: " 古紙" })).toBe(false) // 整えておらぬ名称
    expect(isGarbageRequest({ ...save, garbageKind: "あ".repeat(21) })).toBe(false)
    expect(isGarbageRequest({ ...save, reminder: "m10" })).toBe(false)
    expect(isGarbageRequest({ ...save, scope: "household" })).toBe(false)
    expect(isGarbageRequest({ ...save, eventId: "not-a-uuid" })).toBe(false)
    expect(isGarbageRequest({ op: "delete-orphan", purposeId: "1" })).toBe(false)
    expect(isGarbageRequest(null)).toBe(false)
  })

  it("新しくごみに分類する時の通知の初期選択は前日 20:00", () => {
    expect(GARBAGE_DEFAULT_REMINDER).toBe("prev_day_20")
  })
})

describe("操作の文言", () => {
  it("控えの説明は、長い題でも端末の控えの上限に収まる", () => {
    const label = garbageRequestLabel(
      { op: "save", eventId: E2, scope: "series", action: "garbage", garbageKind: "あ".repeat(20), reminder: "keep", seen: NOTHING_SEEN },
      "と".repeat(200),
    )
    expect(Array.from(label).length).toBeLessThanOrEqual(CHORE_PENDING_LABEL_MAX)
    expect(label).toContain("シリーズ全体")
  })

  it("操作ごとに違う説明になる", () => {
    const base = { op: "save" as const, eventId: E2, scope: "event" as const, garbageKind: null, reminder: "keep" as const, seen: NOTHING_SEEN }
    expect(garbageRequestLabel({ ...base, action: "garbage", garbageKind: "古紙" }, "資源の日")).toBe("「資源の日」をごみの日（古紙）にする")
    expect(garbageRequestLabel({ ...base, action: "normal" }, "資源の日")).toBe("「資源の日」をこの回だけ通常の予定に戻す")
    expect(garbageRequestLabel({ ...base, action: "clear" }, null)).toBe("予定のごみの分類を解除")
    expect(garbageRequestLabel({ op: "delete-orphan", purposeId: P1 }, null)).toBe("予定が見つからない分類を整理")
  })

  it("「この回の通知だけ止める」の説明は、分類を解除するとは言わぬ（R12）", () => {
    expect(garbageMuteLabel("資源の日")).toBe("「資源の日」のこの回の通知を止める")
    expect(garbageMuteLabel(null)).toBe("予定のこの回の通知を止める")
    expect(Array.from(garbageMuteLabel("と".repeat(200))).length).toBeLessThanOrEqual(CHORE_PENDING_LABEL_MAX)
    expect(GARBAGE_MUTE_EFFECT).toContain("ごみの日の分類は変えません")
  })

  it("通知の説明は範囲ごとに違い、既存の時刻を変えぬことを言う", () => {
    expect(garbageReminderEffect("prev_day_20", "event")).toContain("その時刻のまま変えません")
    expect(garbageReminderEffect("prev_day_20", "series")).toContain("個別に通知を止めた回は変えません")
    expect(garbageReminderEffect("off", "series")).toContain("今日以降のすべての回")
    expect(garbageReminderEffect("off", "event")).not.toContain("すべての回")
    expect(garbageReminderEffect("keep", "series")).toBe(garbageReminderEffect("keep", "event"))
  })

  it("前日 20:00 を過ぎた回には「通知します」と言わず、届かぬことを言う（R09）", () => {
    const late = garbageReminderEffect("prev_day_20", "event", true)
    expect(late).toContain("すでに過ぎているため、これから通知は届きません")
    expect(late).not.toContain("に通知します")
    // 対照: 過ぎておらねば従来どおり
    expect(garbageReminderEffect("prev_day_20", "event", false)).toContain("前日 20:00 に通知します")
    // シリーズ: 起点の回が過ぎておれば、その回は届かず次の回から届くと言う
    expect(garbageReminderEffect("prev_day_20", "series", true)).toContain("この回の通知は届きません（次の回から届きます）")
    // 起点の回が過ぎておらずとも、過ぎた回には届かぬことは常に言う
    expect(garbageReminderEffect("prev_day_20", "series", false)).toContain("前日 20:00 をすでに過ぎている回には届きません")
    // 止める・変えないの文は、過ぎておるかに左右されぬ
    expect(garbageReminderEffect("off", "event", true)).toBe(garbageReminderEffect("off", "event", false))
    expect(garbageReminderEffect("keep", "series", true)).toBe(garbageReminderEffect("keep", "series", false))
  })

  it("prevDayReminderPassed: 予定日の前日 20:00（JST）を境に判じる。予定のシートの通知の欄と同じ基準", () => {
    // 11/12 の予定 → 境は 11/11 20:00 JST = 11:00 UTC
    expect(prevDayReminderPassed("2026-11-12", new Date("2026-11-11T10:59:59.999Z"))).toBe(false)
    expect(prevDayReminderPassed("2026-11-12", new Date("2026-11-11T11:00:00.000Z"))).toBe(true)
    expect(prevDayReminderPassed("2026-11-12", new Date("2026-11-11T12:00:00.000Z"))).toBe(true)
    // 当日の予定は常に過ぎておる
    expect(prevDayReminderPassed("2026-11-11", new Date("2026-11-10T15:00:01.000Z"))).toBe(true)
    // 先の予定
    expect(prevDayReminderPassed("2026-11-19", new Date("2026-11-11T12:00:00.000Z"))).toBe(false)
    // 不正な日付・不正な時刻はどちらとも言わぬ
    expect(prevDayReminderPassed("2026-02-30", new Date("2026-11-11T12:00:00.000Z"))).toBeNull()
    expect(prevDayReminderPassed("2026-11-12", new Date(Number.NaN))).toBeNull()
  })
})

describe("収集日", () => {
  it("今日からの近さを言う。過去と不正は null", () => {
    expect(collectionDayRelativeLabel("2026-11-11", "2026-11-11")).toBe("今日")
    expect(collectionDayRelativeLabel("2026-11-12", "2026-11-11")).toBe("明日")
    expect(collectionDayRelativeLabel("2026-11-13", "2026-11-11")).toBe("あさって")
    expect(collectionDayRelativeLabel("2026-12-01", "2026-11-11")).toBe("20日後")
    expect(collectionDayRelativeLabel("2026-11-10", "2026-11-11")).toBeNull()
    expect(collectionDayRelativeLabel("2026-02-30", "2026-11-11")).toBeNull()
  })

  it("今日以降のごみだけを近い順に並べる（通常・不明・過去は載せぬ）", () => {
    const rows = [
      purpose({ id: P1, scope: "series", targetKey: SERIES, garbageKind: "プラスチック" }),
      purpose({ id: P2, scope: "event", targetKey: SINGLE, garbageKind: "古紙" }),
    ]
    const events = attachEventPurposes(
      [
        native(E3, { series_id: SERIES, start_date: "2026-11-25" }),
        native(E2, { series_id: SERIES, start_date: "2026-11-18" }),
        native(E1, { series_id: SERIES, start_date: "2026-11-04" }), // 過去
        native(SINGLE, { start_date: "2026-11-18", is_all_day: false, start_at: "2026-11-17T23:00:00.000Z" }),
        native("5e000000-0000-4000-8000-000000000099", { start_date: "2026-11-12" }), // 通常の予定
      ],
      { status: "ok", rows },
    )
    const list = upcomingGarbageCollections(events, "2026-11-11")
    expect(list.map((c) => [c.date, c.label])).toEqual([
      ["2026-11-18", "プラスチック"], // 同じ日は終日が先
      ["2026-11-18", "古紙"],
      ["2026-11-25", "プラスチック"],
    ])
    expect(upcomingGarbageCollections(events, "2026-11-11", 1)).toHaveLength(1)
    // 分類を読めなんだ時は 1 件も「ごみ」と言わぬ
    expect(upcomingGarbageCollections(attachEventPurposes(events, { status: "failed" }), "2026-11-11")).toEqual([])
  })
})

describe("findOrphanPurposes / buildGarbageOverview", () => {
  const seriesRow = purpose({ id: P1, scope: "series", targetKey: SERIES, garbageKind: "プラスチック" })
  const singleRow = purpose({ id: P2, scope: "event", targetKey: SINGLE, garbageKind: "古紙" })
  const optOutRow = purpose({ id: P3, scope: "event", targetKey: E3, purpose: null, garbageKind: null, reminderOptOut: true })

  it("鍵を持つ予定が 1 つも無い分類だけを孤児とする", () => {
    const events = [native(E2, { series_id: SERIES })]
    expect(findOrphanPurposes([seriesRow, singleRow], events).map((r) => r.id)).toEqual([P2])
    // 対照: 予定が在れば孤児ではない
    expect(findOrphanPurposes([seriesRow, singleRow], [...events, native(SINGLE)])).toEqual([])
    // 用途を持たぬ行（通知の明示 OFF だけ）は対象にせぬ
    expect(findOrphanPurposes([optOutRow], [])).toEqual([])
  })

  it("series_id と同じ文字列の id を持つ単発の予定は、series 行の予定として数えぬ", () => {
    // 単発の予定（id = SERIES、series_id なし）しか無い: series 行は孤児、同じ鍵の event 行は孤児ではない
    const eventRow = purpose({ id: P2, scope: "event", targetKey: SERIES })
    expect(findOrphanPurposes([seriesRow, eventRow], [native(SERIES)]).map((r) => r.id)).toEqual([P1])
  })

  it("画面の中身: 次の収集日・分類の一覧・孤児・確かめられなんだ分類を分ける", () => {
    const gRow = purpose({ id: "9a000000-0000-4000-8000-000000000004", scope: "series", targetKey: "cal@example.invalid|rec", garbageKind: "資源" })
    const overview = buildGarbageOverview({
      rows: [seriesRow, singleRow, optOutRow, gRow],
      windowEvents: [
        native(E2, { series_id: SERIES, start_date: "2026-11-18", title: "プラごみ" }),
        native(E3, { series_id: SERIES, start_date: "2026-11-25", title: "プラごみ" }),
        native("5e000000-0000-4000-8000-000000000098", { start_date: "2026-11-12", title: "歯医者" }),
      ],
      anchorEvents: [],
      unchecked: new Set([purposeLookupKey("series", "cal@example.invalid|rec")]),
      today: "2026-11-11",
      collectionLimit: 1,
    })
    expect(overview.collections.map((c) => [c.date, c.label, c.event.title])).toEqual([
      ["2026-11-18", "プラスチック", "プラごみ"],
    ])
    expect(overview.moreCollections).toBe(1)
    // 用途を持たぬ行は一覧に出さぬ（3 行）
    expect(overview.entries.map((e) => [e.row.id, e.state, e.nextDate, e.upcomingCount])).toEqual([
      [P1, "linked", "2026-11-18", 2],
      // 問い合わせに失敗した分類は「見つからぬ」と言わぬ
      [gRow.id, "unchecked", null, 0],
      [P2, "orphan", null, 0],
    ])
    expect(overview.entries[0].anchor).toMatchObject({ id: E2, isSeries: true })
  })

  it("シリーズ行の「次の収集日」は、この回だけ通常へ戻した回を飛ばす（収集の無い日を告げぬ。R08）", () => {
    // 直近の回（11/12）だけ通常の予定へ戻してある。次の収集日は 11/19
    const back = purpose({ id: P2, scope: "event", targetKey: E2, purpose: "normal", garbageKind: null })
    const overview = buildGarbageOverview({
      rows: [seriesRow, back],
      windowEvents: [
        native(E2, { series_id: SERIES, start_date: "2026-11-12" }),
        native(E3, { series_id: SERIES, start_date: "2026-11-19" }),
      ],
      anchorEvents: [],
      unchecked: new Set(),
      today: "2026-11-11",
      collectionLimit: 10,
    })
    // 上段（次の収集日）と下段（分類した予定のシリーズ行）が同じ日を言う
    expect(overview.collections.map((c) => c.date)).toEqual(["2026-11-19"])
    const series = overview.entries.find((e) => e.row.id === P1)!
    expect(series).toMatchObject({ state: "linked", nextDate: "2026-11-19", upcomingCount: 1 })
    // 操作の起点も、分類が効いておる回
    expect(series.anchor).toMatchObject({ id: E3 })
    expect(series.anchorPurpose).toMatchObject({ kind: "garbage", scope: "series" })
    // 例外の行は自分の日（11/12）を言う
    expect(overview.entries.find((e) => e.row.id === P2)).toMatchObject({ nextDate: "2026-11-12", upcomingCount: 1 })
  })

  it("シリーズ行の「次の収集日」は、この回だけ別の名称にした回も飛ばす（R08）", () => {
    const bulky = purpose({ id: P2, scope: "event", targetKey: E2, garbageKind: "粗大ごみ" })
    const overview = buildGarbageOverview({
      rows: [seriesRow, bulky],
      windowEvents: [
        native(E2, { series_id: SERIES, start_date: "2026-11-12" }),
        native(E3, { series_id: SERIES, start_date: "2026-11-19" }),
      ],
      anchorEvents: [],
      unchecked: new Set(),
      today: "2026-11-11",
      collectionLimit: 10,
    })
    // 11/12 は粗大ごみ（この回だけ）、プラスチック（シリーズ）の次は 11/19
    expect(overview.collections.map((c) => [c.date, c.label])).toEqual([
      ["2026-11-12", "粗大ごみ"],
      ["2026-11-19", "プラスチック"],
    ])
    expect(overview.entries.find((e) => e.row.id === P1)).toMatchObject({ nextDate: "2026-11-19", upcomingCount: 1 })
    expect(overview.entries.find((e) => e.row.id === P2)).toMatchObject({ nextDate: "2026-11-12" })
  })

  it("期間内の回が全て例外でも、シリーズ行は予定の在る分類のまま（孤児にせず、起点は例外の回）", () => {
    const back = purpose({ id: P2, scope: "event", targetKey: E2, purpose: "normal", garbageKind: null })
    const overview = buildGarbageOverview({
      rows: [seriesRow, back],
      windowEvents: [native(E2, { series_id: SERIES, start_date: "2026-11-12" })],
      anchorEvents: [],
      unchecked: new Set(),
      today: "2026-11-11",
      collectionLimit: 10,
    })
    const series = overview.entries.find((e) => e.row.id === P1)!
    expect(series).toMatchObject({ state: "linked", nextDate: null, upcomingCount: 0, anchor: { id: E2 } })
    // 起点の回の今の用途は「この回だけ通常」— フォームはシリーズの名称を seriesLabel から読む
    expect(series.anchorPurpose).toMatchObject({ kind: "normal", exception: true, seriesLabel: "プラスチック" })
  })

  it("期間内に回が無くても、鍵で見つかった予定が在れば孤児にせぬ（起点にする）", () => {
    const overview = buildGarbageOverview({
      rows: [singleRow],
      windowEvents: [],
      anchorEvents: [native(SINGLE, { start_date: "2027-03-01", title: "古紙回収" })],
      unchecked: new Set(),
      today: "2026-11-11",
      collectionLimit: 10,
    })
    expect(overview.entries[0]).toMatchObject({ state: "linked", nextDate: null, anchor: { id: SINGLE, title: "古紙回収" } })
  })

  it("健診・予防接種の予定は収集日にも起点にもせぬ", () => {
    const overview = buildGarbageOverview({
      rows: [singleRow],
      windowEvents: [native(SINGLE, { medical_record_id: SINGLE })],
      anchorEvents: [],
      unchecked: new Set(),
      today: "2026-11-11",
      collectionLimit: 10,
    })
    expect(overview.collections).toEqual([])
    expect(overview.entries[0].state).toBe("orphan")
  })
})

describe("ごみの画面が読む予定の行", () => {
  it("足しておるのは一覧の SELECT と同じ既存の列だけ", () => {
    const shared = new Set(CALENDAR_EVENT_COLUMNS_WITH_KEYS.split(", "))
    for (const column of GARBAGE_EVENT_COLUMNS.split(", ")) expect(shared.has(column)).toBe(true)
  })

  it("行を読む。形が合わねば null（実在せぬ日付も弾く）", () => {
    const raw = { id: SINGLE, title: "古紙", is_all_day: true, start_date: "2026-11-12", end_date: "2026-11-12", start_at: null, source: "native", series_id: null, medical_record_id: null, event_uid: SINGLE, google_calendar_id: null, recurring_event_id: null }
    expect(parseGarbageEventRow(raw)).toMatchObject({ id: SINGLE, event_uid: SINGLE, series_id: null })
    expect(parseGarbageEventRow({ ...raw, start_date: "2026-02-30" })).toBeNull()
    expect(parseGarbageEventRow({ ...raw, title: null })).toBeNull()
  })
})
