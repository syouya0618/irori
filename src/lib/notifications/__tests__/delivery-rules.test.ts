/**
 * 配信の判断規則（B-3）。**時刻の境界だけを決定的に固定する。**
 *
 * `vi.useFakeTimers()` + `setSystemTime` で「今」を 1 点に釘付けにし、そこから
 * ±1ms を撃つ。`waitFor` の類は一切使わぬ — 「いつか成立すれば緑」は、
 * 本数や境界が動く途中で通過した瞬間に緑になり、実装の条件を外しても残る
 * （CLAUDE.md の禁止事項）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  DELIVERY_GRACE_MS,
  buildEventNotification,
  classifyPendingDelivery,
  dedupeDayOf,
  graceStartIso,
  isEventPending,
  isWithinGrace,
  type EventSnapshot,
  type PendingDelivery,
} from "../delivery-rules"

// 2026-08-15T00:50:00Z = **09:50 JST**。予定は 10:00 JST 開始 = 01:00Z とする。
const NOW = "2026-08-15T00:50:00Z"
const EVENT_START = "2026-08-15T01:00:00Z"

function now(): Date {
  return new Date()
}

function delivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: "d1",
    scheduled_at: NOW,
    dedupe_day: "2026-08-15",
    event_key: "e1",
    subscription_id: "s1",
    ...overrides,
  }
}

function event(overrides: Partial<EventSnapshot> = {}): EventSnapshot {
  return {
    event_uid: "e1",
    title: "歯医者",
    is_all_day: false,
    start_date: "2026-08-15",
    start_at: EVENT_START,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

describe("isEventPending — 開始済みの予定には撃たぬ", () => {
  it("開始が未来なら送ってよい", () => {
    expect(isEventPending(EVENT_START, now())).toBe(true)
  })

  it("**開始が 1ms でも過去なら送らぬ**（catch-up が「始まった後に 10 分前です」と鳴るのを止める）", () => {
    const justStarted = new Date(Date.parse(NOW) - 1).toISOString()
    expect(isEventPending(justStarted, now())).toBe(false)
  })

  it("開始ちょうどは送らぬ（境界は「まだ始まっておらぬ」側に閉じる）", () => {
    expect(isEventPending(NOW, now())).toBe(false)
  })

  it("**終日予定（start_at = null）は必ず送る** — ここを塞ぐと prev_day_20 が全滅する", () => {
    expect(isEventPending(null, now())).toBe(true)
  })

  it("壊れた時刻は fail-closed（送らぬ）", () => {
    expect(isEventPending("not-a-time", now())).toBe(false)
  })
})

describe("isWithinGrace — 期限内は送る / 期限切れは送らぬ（対で固定する）", () => {
  it("ちょうど今なら期限内", () => {
    expect(isWithinGrace(NOW, now())).toBe(true)
  })

  it("grace の内側 1ms は期限内（**送る側の対照**）", () => {
    const inside = new Date(Date.parse(NOW) - DELIVERY_GRACE_MS + 1).toISOString()
    expect(isWithinGrace(inside, now())).toBe(true)
  })

  it("grace ちょうどは期限切れ（境界は閉じておる）", () => {
    const edge = new Date(Date.parse(NOW) - DELIVERY_GRACE_MS).toISOString()
    expect(isWithinGrace(edge, now())).toBe(false)
  })

  it("未来の予約はまだ対象ではない", () => {
    const future = new Date(Date.parse(NOW) + 1).toISOString()
    expect(isWithinGrace(future, now())).toBe(false)
  })

  it("graceStartIso は now から 15 分前ちょうど", () => {
    expect(graceStartIso(now())).toBe(
      new Date(Date.parse(NOW) - DELIVERY_GRACE_MS).toISOString(),
    )
  })
})

describe("dedupeDayOf — 冪等キーの日付は scheduled_at 由来（実行日ではない）", () => {
  it("23:58 JST は前日側", () => {
    // 2026-08-14T14:58:00Z = 2026-08-14 23:58 JST
    expect(dedupeDayOf("2026-08-14T14:58:00Z")).toBe("2026-08-14")
  })

  it("00:04 JST は翌日側 — **この差が「実行日から取ると 2 回鳴る」の正体じゃ**", () => {
    // 2026-08-14T15:04:00Z = 2026-08-15 00:04 JST
    expect(dedupeDayOf("2026-08-14T15:04:00Z")).toBe("2026-08-15")
  })
})

describe("classifyPendingDelivery", () => {
  const reminder = { event_uid: "e1", remind_at: NOW }

  it("期限内・予定が未開始なら send", () => {
    expect(
      classifyPendingDelivery({
        delivery: delivery(),
        reminder,
        event: event(),
        now: now(),
      }),
    ).toEqual({ action: "send" })
  })

  it("grace を過ぎた行は expired（送らずに畳む）", () => {
    const old = new Date(Date.parse(NOW) - DELIVERY_GRACE_MS - 1).toISOString()
    expect(
      classifyPendingDelivery({
        delivery: delivery({ scheduled_at: old }),
        reminder: { event_uid: "e1", remind_at: old },
        event: event(),
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })

  it("予定が始まっておれば event_started", () => {
    expect(
      classifyPendingDelivery({
        delivery: delivery(),
        reminder,
        event: event({ start_at: "2026-08-15T00:49:00Z" }),
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "event_started" })
  })

  it("通知設定が消えておれば rescheduled（主が「なし」に戻した）", () => {
    expect(
      classifyPendingDelivery({
        delivery: delivery(),
        reminder: undefined,
        event: event(),
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "rescheduled" })
  })

  it("予定そのものが消えておれば rescheduled（本文を組み立てられぬ）", () => {
    expect(
      classifyPendingDelivery({
        delivery: delivery(),
        reminder,
        event: undefined,
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "rescheduled" })
  })

  it("**同じ日に予定が動いたら reaim**（skip すると冪等キーが埋まったまま通知が消える）", () => {
    const moved = "2026-08-15T00:55:00Z" // 09:55 JST・同じ JST 日
    const decision = classifyPendingDelivery({
      delivery: delivery(),
      reminder: { event_uid: "e1", remind_at: moved },
      event: event({ start_at: "2026-08-15T01:05:00Z" }),
      now: now(),
    })
    // 新しい狙いは **ISO へ正規化して**返す（DB の "+00:00" 表記のまま書き戻すと、
    // 次の実行で自分の書いた値と比べ直すときに表記差の罠を招く）。
    expect(decision).toEqual({
      action: "reaim",
      scheduledAt: new Date(moved).toISOString(),
    })
  })

  it("再照準の直後（まだ時刻が来ておらぬ）は wait", () => {
    const future = "2026-08-15T00:55:00Z"
    expect(
      classifyPendingDelivery({
        delivery: delivery({ scheduled_at: future }),
        reminder: { event_uid: "e1", remind_at: future },
        event: event({ start_at: "2026-08-15T01:05:00Z" }),
        now: now(),
      }),
    ).toEqual({ action: "wait" })
  })

  it("日を跨いで動いたら rescheduled（新しい日の行を作れるゆえ畳んでよい）", () => {
    const nextDay = "2026-08-15T15:30:00Z" // 2026-08-16 00:30 JST
    expect(
      classifyPendingDelivery({
        delivery: delivery(),
        reminder: { event_uid: "e1", remind_at: nextDay },
        event: event(),
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "rescheduled" })
  })

  it("**表記が違うだけの同じ瞬間を「動いた」と誤判定せぬ**（Postgres は +00:00 形式で返す）", () => {
    const decision = classifyPendingDelivery({
      delivery: delivery({ scheduled_at: "2026-08-15T00:50:00+00:00" }),
      reminder,
      event: event(),
      now: now(),
    })
    // ここが文字列比較だと reaim/rescheduled に落ち、**1 通も鳴らなくなる**。
    expect(decision).toEqual({ action: "send" })
  })

  it("壊れた scheduled_at は送らぬ（fail-closed）", () => {
    expect(
      classifyPendingDelivery({
        delivery: delivery({ scheduled_at: "壊れた" }),
        reminder,
        event: event(),
        now: now(),
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })
})

describe("buildEventNotification", () => {
  it("時刻付きは日付 + 開始時刻", () => {
    expect(buildEventNotification(event())).toEqual({
      title: "歯医者",
      body: "8月15日 10:00 開始",
      // B-6: 着地先は**予定の開始日**。素の "/calendar" だと prev_day_20 の通知は
      // 「翌日の予定を報しながら今日」を開く。
      url: "/calendar?date=2026-08-15",
      tag: "event:e1",
    })
  })

  it("**着地先が予定の日を指す**（本文の日付と画面が一致する）", () => {
    // prev_day_20 は前日に鳴るゆえ、ここが今日を指すと必ず外れる。
    expect(buildEventNotification(event({ start_date: "2026-09-01" })).url).toBe(
      "/calendar?date=2026-09-01",
    )
  })

  it("start_date が壊れておれば素の /calendar へ倒す（在りもせぬ日を指さぬ）", () => {
    expect(buildEventNotification(event({ start_date: "2026-02-30" })).url).toBe(
      "/calendar",
    )
  })

  it("終日は「終日」と出す（start_at が無くとも本文が作れる）", () => {
    expect(
      buildEventNotification(
        event({ is_all_day: true, start_at: null, title: "運動会" }),
      ).body,
    ).toBe("8月15日 終日")
  })

  it("**深夜 0 時を 24:00 と出さぬ**（h23 固定・ICU 既定の罠）", () => {
    // 2026-08-14T15:00:00Z = 2026-08-15 00:00 JST
    expect(
      buildEventNotification(
        event({ start_at: "2026-08-14T15:00:00Z", start_date: "2026-08-15" }),
      ).body,
    ).toBe("8月15日 00:00 開始")
  })
})
