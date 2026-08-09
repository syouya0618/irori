/**
 * 通知パイプラインの健康診断（B-4）。
 *
 * 縛るのは **runbook の一次監視表と同じ読み方をすること**じゃ
 * （`docs/runbooks/notify-cron.md`）。画面と手順書が違うことを言い出したら、
 * 主はどちらを信じてよいか分からなくなる。
 */

import { describe, it, expect } from "vitest"
import {
  HEARTBEAT_STALE_MS,
  formatRelativeJa,
  summarizeNotificationHealth,
} from "../notification-health"

const NOW = new Date("2026-08-15T12:00:00+09:00")
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()

describe("summarizeNotificationHealth", () => {
  it("心拍の行が無ければ never（まだ一度も走っておらぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: null,
      failedCount: null,
      lastSentAt: null,
      now: NOW,
    })
    expect(view.runState).toBe("never")
    // 古い相対時刻を出さぬ。「止まった」と誤読させぬため。
    expect(view.ranAtLabel).toBeNull()
    expect(view.deliveryState).toBe("never")
  })

  it("ran_at が 10 分以上前なら stale（起動しておらぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(3 * 60 * 60 * 1000),
      failedCount: 0,
      lastSentAt: iso(4 * 60 * 60 * 1000),
      now: NOW,
    })
    expect(view.runState).toBe("stale")
    expect(view.ranAtLabel).toBe("3時間前")
    expect(view.lastSentLabel).toBe("4時間前")
  })

  it("ran_at が新しく failed_count >= 1 なら failing（走ってはおるが壊れておる）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(2 * 60 * 1000),
      failedCount: 3,
      lastSentAt: iso(30 * 60 * 1000),
      now: NOW,
    })
    expect(view.runState).toBe("failing")
    expect(view.failedCount).toBe(3)
  })

  it("ran_at が新しく failed_count = 0 なら healthy（平穏）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(60 * 1000),
      failedCount: 0,
      lastSentAt: iso(10 * 60 * 1000),
      now: NOW,
    })
    expect(view.runState).toBe("healthy")
    expect(view.deliveryState).toBe("sent")
  })

  it("**古い心拍は failed_count より優先する**（本当の症状を隠さぬ）", () => {
    // 止まった cron が最後に書いた failed_count は、今の状態を語らぬ。
    const view = summarizeNotificationHealth({
      ranAt: iso(6 * 60 * 60 * 1000),
      failedCount: 5,
      lastSentAt: null,
      now: NOW,
    })
    expect(view.runState).toBe("stale")
  })

  it("配信が 1 件も無ければ delivery は never（心拍と独立に判る）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(60 * 1000),
      failedCount: 0,
      lastSentAt: null,
      now: NOW,
    })
    // ★ この組み合わせが「平穏」じゃ。走っておるが送るものが無かった。
    expect(view.runState).toBe("healthy")
    expect(view.deliveryState).toBe("never")
    expect(view.lastSentLabel).toBeNull()
  })

  it("閾値は runbook の 10 分ちょうど（境界の両側を対で置く）", () => {
    const base = { failedCount: 0, lastSentAt: null, now: NOW }
    // 10 分ちょうど → stale
    expect(
      summarizeNotificationHealth({ ...base, ranAt: iso(HEARTBEAT_STALE_MS) }).runState,
    ).toBe("stale")
    // 1 ミリ秒手前 → まだ healthy（通る側も必ず置く）
    expect(
      summarizeNotificationHealth({ ...base, ranAt: iso(HEARTBEAT_STALE_MS - 1) })
        .runState,
    ).toBe("healthy")
    expect(HEARTBEAT_STALE_MS).toBe(10 * 60 * 1000)
  })

  it("壊れた ran_at は never へ退化させる（画面を倒さぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: "これは時刻ではない",
      failedCount: 1,
      lastSentAt: null,
      now: NOW,
    })
    expect(view.runState).toBe("never")
  })
})

// ── 「読めなかった」と「まだ走っておらぬ」の弁別（SEC-3）─────────────
// 診断の読み取りが失敗した時（migration 未適用の 42P01・RLS 拒否・一過性の
// DB エラー）も `ranAt` は null で来る。ここで never へ落とすと、画面が
// 「まだ一度も実行されていません」と**断言**し、主は pg_cron を疑って真因
// （読めなかっただけ）へ辿り着けぬ。しかも動いておる基盤を止めに行く。
describe("読み取り失敗を never/never と取り違えぬ", () => {
  it("心拍の error 時は never にならぬ（unknown で、時刻も出さぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: null,
      failedCount: null,
      lastSentAt: null,
      ranAtUnknown: true,
      now: NOW,
    })
    expect(view.runState).toBe("unknown")
    expect(view.runState).not.toBe("never")
    expect(view.ranAtLabel).toBeNull()
  })

  it("最終配信の error 時は never にならぬ（「1 件も送っておらぬ」と言わぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(60 * 1000),
      failedCount: 0,
      lastSentAt: null,
      lastSentUnknown: true,
      now: NOW,
    })
    expect(view.deliveryState).toBe("unknown")
    expect(view.lastSentLabel).toBeNull()
    // 心拍は読めておるゆえ、そちらは平穏のまま（片方の故障で全部を塗り潰さぬ）。
    expect(view.runState).toBe("healthy")
  })

  it("unknown は他の判定より強い（値が在っても読み取り失敗が勝つ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: iso(60 * 1000),
      failedCount: 0,
      lastSentAt: iso(60 * 1000),
      ranAtUnknown: true,
      lastSentUnknown: true,
      now: NOW,
    })
    expect(view.runState).toBe("unknown")
    expect(view.deliveryState).toBe("unknown")
  })

  it("error が無ければ従来どおり（unknown へ倒れぬ）", () => {
    const view = summarizeNotificationHealth({
      ranAt: null,
      failedCount: null,
      lastSentAt: null,
      ranAtUnknown: false,
      lastSentUnknown: false,
      now: NOW,
    })
    expect(view.runState).toBe("never")
    expect(view.deliveryState).toBe("never")
  })
})

describe("formatRelativeJa", () => {
  it.each([
    [0, "たった今"],
    [30 * 1000, "たった今"],
    [60 * 1000, "1分前"],
    [3 * 60 * 1000, "3分前"],
    [59 * 60 * 1000, "59分前"],
    [60 * 60 * 1000, "1時間前"],
    [23 * 60 * 60 * 1000, "23時間前"],
    [24 * 60 * 60 * 1000, "1日前"],
    [3 * 24 * 60 * 60 * 1000, "3日前"],
  ])("%i ms 前 → %s", (msAgo, expected) => {
    expect(formatRelativeJa(iso(msAgo), NOW)).toBe(expected)
  })

  it("未来の時刻は「たった今」へ丸める（端末の時計ずれで負の表記を出さぬ）", () => {
    expect(formatRelativeJa(iso(-5 * 60 * 1000), NOW)).toBe("たった今")
  })

  it("null / 壊れた値は null（呼び出し側が「不明」へ退化させる）", () => {
    expect(formatRelativeJa(null, NOW)).toBeNull()
    expect(formatRelativeJa("not-a-date", NOW)).toBeNull()
  })
})
