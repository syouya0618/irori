/**
 * ログアウト・更新の確認の文（local-work）が、予定の作成の控えを「確認中」と「保存できなかった」に
 * 言い分ける（独立レビュー v9rc1 UX-03: 行が無いと確定した作成を「保存を確認中」と数えた）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

class MemoryStorage {
  private map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v))
  }
  removeItem(k: string) {
    this.map.delete(k)
  }
  clear() {
    this.map.clear()
  }
}
const storage = new MemoryStorage()
vi.stubGlobal("localStorage", storage)

import { describeLocalWork, hasLocalWork, summarizeLocalWork } from "../local-work"
import {
  beginCalendarCreateAttempt,
  clearMemoryOnlyCalendarCreatesForTest,
  putMemoryOnlyCalendarCreate,
  settleCalendarCreateAttempt,
  settleCalendarCreateOutcome,
} from "../calendar-pending-creates"

const A = { userId: "user-a", householdId: "house-a" }
const form = {
  title: "検診",
  memo: null,
  isAllDay: true,
  startDate: "2026-11-02",
  endDate: "2026-11-02",
  startTime: "09:00",
  endTime: "",
  repeat: "none" as const,
  repeatUntil: "",
}
function create(clientId: string, outcome: "unknown" | "rejected") {
  const { entry } = beginCalendarCreateAttempt({
    owner: A,
    clientId,
    payload: { title: "検診", memo: null, isAllDay: true, startDate: "2026-11-02", endDate: "2026-11-02", startAt: null, endAt: null, clientId },
    formValue: form,
    reminderChoice: "none",
  })
  settleCalendarCreateAttempt(entry, outcome === "unknown" ? { kind: "unknown" } : { kind: "rejected", message: "認証されていません" })
}

beforeEach(() => {
  storage.clear()
  clearMemoryOnlyCalendarCreatesForTest()
})
afterEach(() => vi.restoreAllMocks())

describe("local-work: 予定の作成の控え", () => {
  it("確認中と保存できなかったものを別々に数えて言う", () => {
    create("2c2c2c2c-0000-4000-8000-000000000001", "unknown")
    create("2c2c2c2c-0000-4000-8000-000000000002", "rejected")
    const s = summarizeLocalWork(A)
    expect(s).toMatchObject({ calendarCreates: 1, calendarCreatesRejected: 1 })
    expect(hasLocalWork(s)).toBe(true)
    const text = describeLocalWork(s)!
    expect(text).toContain("保存を確認中の予定 1件")
    expect(text).toContain("保存できなかった予定 1件")
  })

  it("保存できなかった予定だけなら「保存を確認中」とは言わぬ", () => {
    create("2c2c2c2c-0000-4000-8000-000000000003", "rejected")
    const text = describeLocalWork(summarizeLocalWork(A))!
    expect(text).not.toContain("保存を確認中の予定")
    expect(text).toContain("保存できなかった予定 1件")
  })

  it("対照: 控えが無ければ予定については何も言わぬ", () => {
    const s = summarizeLocalWork(A)
    expect(s).toMatchObject({ calendarCreates: 0, calendarCreatesRejected: 0 })
    expect(describeLocalWork(s)).toBeNull()
  })

  it.each(["unknown", "rejected"] as const)("端末保存が上限でも、この画面だけにある %s の控えを数え、再読込で消えることを伝える（RC2-2）", (kind) => {
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError")
    })
    const clientId = "2c2c2c2c-0000-4000-8000-000000000004"
    const { entry, persisted } = beginCalendarCreateAttempt({
      owner: A,
      clientId,
      payload: { title: "検診", memo: null, isAllDay: true, startDate: "2026-11-02", endDate: "2026-11-02", startAt: null, endAt: null, clientId },
      formValue: form,
      reminderChoice: "none",
    })
    expect(persisted).toBe(false)
    putMemoryOnlyCalendarCreate(settleCalendarCreateOutcome(entry, kind === "unknown" ? { kind } : { kind, message: "認証されていません" }))

    const summary = summarizeLocalWork(A)
    expect(summary).toMatchObject({
      storageReadable: true,
      calendarCreates: kind === "unknown" ? 1 : 0,
      calendarCreatesRejected: kind === "rejected" ? 1 : 0,
    })
    expect(hasLocalWork(summary)).toBe(true)
    expect(describeLocalWork(summary)).toContain("端末に残せていない予定の控えは、読み直すと消えます")
    expect(hasLocalWork(summarizeLocalWork({ userId: "user-b", householdId: "house-b" }))).toBe(false)
  })

  it("同じ id の端末保存と画面の控えは二重に数えず、端末保存の状態を使う", () => {
    const clientId = "2c2c2c2c-0000-4000-8000-000000000005"
    const { entry } = beginCalendarCreateAttempt({
      owner: A,
      clientId,
      payload: { title: "検診", memo: null, isAllDay: true, startDate: "2026-11-02", endDate: "2026-11-02", startAt: null, endAt: null, clientId },
      formValue: form,
      reminderChoice: "none",
    })
    putMemoryOnlyCalendarCreate(settleCalendarCreateOutcome(entry, { kind: "unknown" }))
    settleCalendarCreateAttempt(entry, { kind: "rejected", message: "認証されていません" })
    const summary = summarizeLocalWork(A)
    expect(summary).toMatchObject({ calendarCreates: 0, calendarCreatesRejected: 1 })
    expect(describeLocalWork(summary)).not.toContain("端末に残せていない")
  })
})
