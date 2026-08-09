/**
 * 毎朝ダイジェスト（B-5）の判断規則。時刻境界を**決定的な 1 点**で撃つ。
 *
 * ここが守っておるのは 3 つじゃ:
 *   1. **JST 契約**（`digest_time` は TZ を持たぬ TIME ＝ JST の壁時計）。
 *      UTC で解釈すれば 9 時間ずれ、07:00 のまとめが夕方に鳴る。
 *   2. **0 件なら送らぬ**（中身の無い通知は権限を捨てさせる）。
 *   3. **設定の変更に追随する**（朝の時刻を変えた日に、古い時刻で鳴らぬ）。
 */

import { describe, it, expect } from "vitest"
import {
  buildDigestNotification,
  classifyPendingDigest,
  digestScheduledAtForDay,
  type DigestEventSnapshot,
} from "../digest-rules"
import type { PendingDelivery } from "../delivery-rules"

const DAY = "2026-08-10"
/** 2026-08-10 07:00 JST。**UTC では前日の 22:00** — この 9 時間が本機能の急所じゃ。 */
const SEVEN_JST = "2026-08-09T22:00:00.000Z"

function event(overrides: Partial<DigestEventSnapshot> = {}): DigestEventSnapshot {
  return {
    title: "予定",
    is_all_day: false,
    start_date: DAY,
    start_at: "2026-08-10T01:00:00.000Z", // 10:00 JST
    ...overrides,
  }
}

function delivery(overrides: Partial<PendingDelivery> = {}): PendingDelivery {
  return {
    id: "d1",
    scheduled_at: SEVEN_JST,
    dedupe_day: DAY,
    event_key: null,
    subscription_id: "sub-1",
    ...overrides,
  }
}

describe("digestScheduledAtForDay — JST の壁時計として起こす", () => {
  it("07:00 は **前日 22:00 UTC** になる（9 時間ずれを踏まぬ）", () => {
    expect(digestScheduledAtForDay(DAY, "07:00")).toBe(SEVEN_JST)
    // 素朴に UTC で組めばこうなる。そちらでは断じてない。
    expect(digestScheduledAtForDay(DAY, "07:00")).not.toBe(
      "2026-08-10T07:00:00.000Z",
    )
  })

  it("DB の TIME 表記（秒つき）でも同じ瞬間を返す", () => {
    expect(digestScheduledAtForDay(DAY, "07:00:00")).toBe(SEVEN_JST)
  })

  it("JST 0 時台は UTC では前日の 15 時台", () => {
    expect(digestScheduledAtForDay(DAY, "00:30")).toBe("2026-08-09T15:30:00.000Z")
  })

  it("読めぬ時刻は null（fail-closed）", () => {
    expect(digestScheduledAtForDay(DAY, "なし")).toBeNull()
    expect(digestScheduledAtForDay(DAY, "24:00")).toBeNull()
  })
})

describe("buildDigestNotification — 本文", () => {
  it("0 件なら null（＝送らぬ）", () => {
    expect(buildDigestNotification(DAY, [])).toBeNull()
  })

  it("件数と時刻を並べる", () => {
    const payload = buildDigestNotification(DAY, [
      event({ title: "歯医者", start_at: "2026-08-10T01:00:00.000Z" }),
      event({ title: "買い物", start_at: "2026-08-10T05:00:00.000Z" }),
    ])
    expect(payload).toEqual({
      title: "今日の予定 2件",
      body: "歯医者 10:00 / 買い物 14:00",
      // B-6: 着地先は**そのまとめの日**。素の "/calendar" は「開いた時の今日」ゆえ、
      // grace の中で日を跨いで叩かれると本文と違う日を映す。
      url: `/calendar?date=${DAY}`,
      tag: `digest:${DAY}`,
    })
  })

  it("**着地先はまとめの日**（dedupe_day と同じ JST 暦日）", () => {
    const payload = buildDigestNotification("2026-09-01", [
      event({ title: "検診", start_date: "2026-09-01", is_all_day: true, start_at: null }),
    ])
    expect(payload?.url).toBe("/calendar?date=2026-09-01")
  })

  it("終日は先に出し、時刻の代わりに「終日」と書く", () => {
    const payload = buildDigestNotification(DAY, [
      event({ title: "歯医者", start_at: "2026-08-10T01:00:00.000Z" }),
      event({ title: "燃えるゴミ", is_all_day: true, start_at: null }),
    ])
    expect(payload?.body).toBe("燃えるゴミ 終日 / 歯医者 10:00")
  })

  it("**前日から続く予定を「今日 N 時開始」と偽らぬ**", () => {
    // 3 日間の旅行の 2 日目。start_at は初日の時刻ゆえ、そのまま書けば
    // 在りもせぬ「今日 09:00 開始」を報せることになる。
    const payload = buildDigestNotification(DAY, [
      event({
        title: "旅行",
        start_date: "2026-08-09",
        start_at: "2026-08-09T00:00:00.000Z",
      }),
    ])
    expect(payload?.body).toBe("旅行 終日")
  })

  it("件数は**総数**、並ぶのは先頭 3 件（残りは「ほか N 件」）", () => {
    const payload = buildDigestNotification(
      DAY,
      [1, 2, 3, 4, 5].map((i) =>
        event({
          title: `予定${i}`,
          start_at: `2026-08-10T0${i}:00:00.000Z`,
        }),
      ),
    )
    // 表示は 3 件でも、見出しの数は 5 でなければならぬ
    // （切り詰めた数を出すと「今日は 3 件だけ」という嘘になる）。
    expect(payload?.title).toBe("今日の予定 5件")
    expect(payload?.body).toBe("予定1 10:00 / 予定2 11:00 / 予定3 12:00 ほか2件")
  })

  it("長い題名は畳む（push のペイロード上限で 1 通丸ごと落とさぬため）", () => {
    const payload = buildDigestNotification(DAY, [
      event({ title: "あ".repeat(120), is_all_day: true, start_at: null }),
    ])
    expect(payload?.body.length).toBeLessThan(60)
    expect(payload?.body).toContain("…")
  })
})

describe("classifyPendingDigest — 送る直前の裁定", () => {
  const now = new Date(SEVEN_JST)

  it("時刻が来て予定が在れば送る", () => {
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: "07:00",
        eventCount: 2,
        now,
      }),
    ).toEqual({ action: "send" })
  })

  it("まだ時刻が来ておらねば据え置く", () => {
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: "07:00",
        eventCount: 2,
        now: new Date("2026-08-09T20:00:00.000Z"),
      }),
    ).toEqual({ action: "wait" })
  })

  it("grace を過ぎたら送らず畳む（遅れて鳴るまとめは害にしかならぬ）", () => {
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: "07:00",
        eventCount: 2,
        now: new Date("2026-08-09T22:16:00.000Z"), // 16 分遅れ（grace = 15 分）
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })

  it("主が「送らない」に戻したら送らぬ", () => {
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: null,
        eventCount: 2,
        now,
      }),
    ).toEqual({ action: "skip", reason: "rescheduled" })
  })

  it("時刻を動かしたら**行は作り直さず狙いだけ変える**", () => {
    // 07:00 → 08:00 へ変えた日。行を畳んでは、同じ冪等キーの行はもう作れぬゆえ
    // その日のまとめが永久に失われる。
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: "08:00",
        eventCount: 2,
        now,
      }),
    ).toEqual({ action: "reaim", scheduledAt: "2026-08-09T23:00:00.000Z" })
  })

  it("**0 件になっても畳まぬ**（予定が入り直せば送るべき状態へ戻る）", () => {
    // skip にすると skipped_at が立ち、同じ冪等キーの行は二度と作れぬ。
    // 据え置けば grace を過ぎた時点で既存の期限切れ掃除が expired として畳む。
    expect(
      classifyPendingDigest({
        delivery: delivery(),
        digestTime: "07:00",
        eventCount: 0,
        now,
      }),
    ).toEqual({ action: "wait" })
  })

  it("壊れた scheduled_at は送らぬ", () => {
    expect(
      classifyPendingDigest({
        delivery: delivery({ scheduled_at: "いつか" }),
        digestTime: "07:00",
        eventCount: 2,
        now,
      }),
    ).toEqual({ action: "skip", reason: "expired" })
  })
})
