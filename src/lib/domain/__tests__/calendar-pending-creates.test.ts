/**
 * 予定の作成の控え（v9 / AC28）の端末保存の契約。正常と危険の対を置く:
 * - 状態は単調（一度でも結果が分からなかった作成は、後の拒否で「保存されておらぬ」へ戻らぬ）
 * - 送信内容は凍結（同じ id の控えは最初の内容を保つ）
 * - 作成ごとに別の鍵（1 件の書き・消しが他の控えに触れぬ）
 * - 持ち主・形・鍵の id の検証、期限、上限で他の控えを押し出さぬ
 */
import { describe, it, expect, beforeEach, vi } from "vitest"

// node 環境の localStorage（jsdom を使わぬ）
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

import {
  beginCalendarCreateAttempt,
  calendarCreateKey,
  CALENDAR_CREATE_TTL_MS,
  CALENDAR_CREATES_MAX,
  displayOfCalendarCreate,
  listCalendarPendingCreates,
  mayExistOnServer,
  parseCalendarPendingCreate,
  purgeCalendarPendingCreatesNotOwnedBy,
  readCalendarPendingCreate,
  removeCalendarPendingCreate,
  settleCalendarCreateAttempt,
  settleCalendarCreateOutcome,
  startCalendarCreateAttempt,
  type CalendarCreatePayload,
} from "../calendar-pending-creates"
import { PAGE_LIFE_ID } from "../pending-saves-storage"
import type { CalendarEventFormValue } from "../calendar-form"

const A = { userId: "user-a", householdId: "house-a" }
const B = { userId: "user-b", householdId: "house-b" }
let n = 0
const id = () => `1c1c1c1c-0000-4000-8000-${String(++n).padStart(12, "0")}`

const form = (title: string): CalendarEventFormValue => ({
  title,
  memo: null,
  isAllDay: true,
  startDate: "2026-11-02",
  endDate: "2026-11-02",
  startTime: "09:00",
  endTime: "",
  repeat: "none",
  repeatUntil: "",
})
const payload = (title: string, clientId: string): CalendarCreatePayload => ({
  title,
  memo: null,
  isAllDay: true,
  startDate: "2026-11-02",
  endDate: "2026-11-02",
  startAt: null,
  endAt: null,
  clientId,
})
function begin(owner: typeof A, clientId: string, title = "検診", now = new Date("2026-10-28T00:00:00Z")) {
  return beginCalendarCreateAttempt(
    { owner, clientId, payload: payload(title, clientId), formValue: form(title), reminderChoice: "none" },
    now,
  )
}

beforeEach(() => storage.clear())

describe("状態は単調（T2 の根）", () => {
  it("1 度きりの送信の拒否は rejected（行は無い）。対照: 結果不明の後の拒否は unknown のまま理由だけ残す", () => {
    const x = id()
    const first = begin(A, x).entry
    expect(settleCalendarCreateAttempt(first, { kind: "rejected", message: "認証されていません" }).entry).toMatchObject({
      status: "rejected",
      mayHaveLanded: false,
      lastError: "認証されていません",
    })

    const y = id()
    const sent = begin(A, y).entry
    settleCalendarCreateAttempt(sent, { kind: "unknown" })
    const again = begin(A, y).entry
    expect(again.mayHaveLanded).toBe(true)
    const after = settleCalendarCreateAttempt(again, { kind: "rejected", message: "認証されていません" })
    expect(after.entry).toMatchObject({ status: "unknown", mayHaveLanded: true, lastError: "認証されていません" })
    expect(readCalendarPendingCreate(A, y)).toMatchObject({ status: "unknown", mayHaveLanded: true })
    expect(mayExistOnServer(after.entry)).toBe(true)
  })

  it("送信中のまま画面が落ちた控え（前のページの sending）を送り直して拒まれても、unknown のまま", () => {
    const x = id()
    const sending = begin(A, x).entry
    // 前のページの送信中（pageId が違う）として残っておる
    storage.setItem(calendarCreateKey(A, x), JSON.stringify({ ...sending, pageId: "previous-page" }))
    const resend = begin(A, x).entry
    expect(resend.mayHaveLanded).toBe(true)
    expect(settleCalendarCreateAttempt(resend, { kind: "rejected", message: "x" }).entry.status).toBe("unknown")
  })

  it("rejected でかつ mayHaveLanded の控えは、形として読まぬ（単調の規則を手で弄った値で破らせぬ）", () => {
    const x = id()
    const e = begin(A, x).entry
    expect(parseCalendarPendingCreate({ ...e, status: "rejected", mayHaveLanded: true }, A, x)).toBeNull()
    expect(parseCalendarPendingCreate({ ...e, status: "rejected", mayHaveLanded: false }, A, x)).not.toBeNull()
  })

  it("純関数: unknown は mayHaveLanded を立て理由を消す。拒否された控えの送り直しは mayHaveLanded を立てぬ", () => {
    const x = id()
    const s = startCalendarCreateAttempt(
      null,
      { owner: A, clientId: x, payload: payload("a", x), formValue: form("a"), reminderChoice: "none" },
      "2026-10-28T00:00:00.000Z",
    )
    const rejected = settleCalendarCreateOutcome(s, { kind: "rejected", message: "m" })
    expect(rejected.status).toBe("rejected")
    const retry = startCalendarCreateAttempt(
      rejected,
      { owner: A, clientId: x, payload: payload("a", x), formValue: form("a"), reminderChoice: "none" },
      "2026-10-28T00:01:00.000Z",
    )
    expect(retry.mayHaveLanded).toBe(false)
    expect(retry.lastError).toBeUndefined()
    const unknown = settleCalendarCreateOutcome({ ...retry, lastError: "old" }, { kind: "unknown" })
    expect(unknown).toMatchObject({ status: "unknown", mayHaveLanded: true })
    expect(unknown.lastError).toBeUndefined()
  })
})

describe("送信内容の凍結", () => {
  it("同じ id の 2 回目の begin は、引数の内容ではなく最初の内容・最初の押下を保つ", () => {
    const x = id()
    const first = begin(A, x, "最初の内容", new Date("2026-10-28T00:00:00Z")).entry
    const second = begin(A, x, "書き換えた内容", new Date("2026-10-28T01:00:00Z")).entry
    expect(second.payload).toEqual(first.payload)
    expect(second.formValue.title).toBe("最初の内容")
    expect(second.firstAttemptAt).toBe(first.firstAttemptAt)
    expect(second.sentAt).toBe("2026-10-28T01:00:00.000Z")
  })

  it("鍵の id と payload.clientId が食い違う値は読まぬ（別の作成の内容を送らせぬ）", () => {
    const x = id()
    const e = begin(A, x).entry
    expect(parseCalendarPendingCreate({ ...e, payload: { ...e.payload, clientId: id() } }, A, x)).toBeNull()
    expect(parseCalendarPendingCreate(e, A, x)).not.toBeNull()
  })
})

describe("作成ごとに別の鍵（P-B の根）", () => {
  it("2 件の控えは別々に残り、1 件の確定（消す）は他方に触れぬ", () => {
    const x = id()
    const y = id()
    settleCalendarCreateAttempt(begin(A, x, "X").entry, { kind: "unknown" })
    settleCalendarCreateAttempt(begin(A, y, "Y").entry, { kind: "unknown" })
    expect(listCalendarPendingCreates(A).map((e) => e.clientId).sort()).toEqual([x, y].sort())
    removeCalendarPendingCreate(A, y)
    expect(listCalendarPendingCreates(A).map((e) => e.clientId)).toEqual([x])
  })

  it("上限に達したら新しい控えは書かず（persisted: false）、既存の控えを押し出さぬ", () => {
    const ids = Array.from({ length: CALENDAR_CREATES_MAX }, () => id())
    for (const c of ids) expect(begin(A, c).persisted).toBe(true)
    const extra = id()
    expect(begin(A, extra).persisted).toBe(false)
    expect(listCalendarPendingCreates(A).map((e) => e.clientId).sort()).toEqual([...ids].sort())
    // 既存の控えの送り直しは上限に掛からぬ
    expect(begin(A, ids[0]).persisted).toBe(true)
  })
})

describe("持ち主・期限・端末を使えぬ環境", () => {
  it("別の持ち主の控えは読みにも一覧にも出ず、purge で消える。今の持ち主の控えは残る", () => {
    const a = id()
    const b = id()
    begin(A, a)
    begin(B, b)
    expect(listCalendarPendingCreates(B).map((e) => e.clientId)).toEqual([b])
    expect(readCalendarPendingCreate(B, a)).toBeNull()
    // 鍵を B のものへ書き換えても、中身の持ち主が A なら読まぬ
    storage.setItem(calendarCreateKey(B, a), storage.getItem(calendarCreateKey(A, a))!)
    expect(readCalendarPendingCreate(B, a)).toBeNull()
    expect(purgeCalendarPendingCreatesNotOwnedBy(B)).toBe(1)
    expect(listCalendarPendingCreates(A)).toEqual([])
    expect(listCalendarPendingCreates(B).map((e) => e.clientId)).toEqual([b])
  })

  it("最初の押下から 7 日を過ぎた控えは読む時に捨てる（対照: 7 日以内は残る）", () => {
    const x = id()
    begin(A, x, "検診", new Date("2026-10-01T00:00:00Z"))
    const t0 = new Date("2026-10-01T00:00:00Z").getTime()
    expect(readCalendarPendingCreate(A, x, t0 + CALENDAR_CREATE_TTL_MS)).not.toBeNull()
    expect(readCalendarPendingCreate(A, x, t0 + CALENDAR_CREATE_TTL_MS + 1)).toBeNull()
    expect(storage.getItem(calendarCreateKey(A, x))).toBeNull()
  })

  it("localStorage を読めぬ環境では persisted: false（端末に残したと言わせぬ）", () => {
    const x = id()
    const spy = vi.spyOn(storage, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError")
    })
    expect(begin(A, x).persisted).toBe(false)
    spy.mockRestore()
    const spySet = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError")
    })
    expect(begin(A, x).persisted).toBe(false)
    spySet.mockRestore()
  })
})

describe("表示の判定（安全の判定と分ける）", () => {
  it("このページで送信中・別のページの直近の送信中・猶予の後・結果不明・拒否", () => {
    const x = id()
    const e = begin(A, x).entry
    const now = new Date(e.sentAt).getTime()
    expect(displayOfCalendarCreate(e, { nowMs: now, inFlight: true })).toBe("in-flight")
    // このページの sending で送信中でない = 応答を待たずに画面の状態が失われた形。結果不明として出す
    expect(displayOfCalendarCreate(e, { nowMs: now })).toBe("unknown")
    const other = { ...e, pageId: `${PAGE_LIFE_ID}-other` }
    expect(displayOfCalendarCreate(other, { nowMs: now + 1_000 })).toBe("other-sending")
    expect(displayOfCalendarCreate(other, { nowMs: now + 61_000 })).toBe("unknown")
    expect(mayExistOnServer(other)).toBe(true)
    const rejected = settleCalendarCreateOutcome(e, { kind: "rejected", message: "m" })
    expect(displayOfCalendarCreate(rejected, { nowMs: now })).toBe("rejected")
    expect(mayExistOnServer(rejected)).toBe(false)
  })
})

describe("独立レビュー v9rc1 の回帰", () => {
  it("PI-1: 別の送信の成功で消えた控えへ、遅れて届いた古い送信の rejected / unknown を書き戻さぬ（superseded）。対照: 控えが在れば書く", () => {
    const x = id()
    const first = begin(A, x).entry // 送信者 1（mayHaveLanded: false の写し）
    begin(A, x) // 送信者 2 の送り直し
    removeCalendarPendingCreate(A, x) // 送信者 2 が成功して確定
    const late = settleCalendarCreateAttempt(first, { kind: "rejected", message: "プロフィールの取得に失敗しました" })
    expect(late.superseded).toBe(true)
    expect(late.persisted).toBe(false)
    expect(listCalendarPendingCreates(A)).toEqual([])
    expect(settleCalendarCreateAttempt(first, { kind: "unknown" }).superseded).toBe(true)
    expect(listCalendarPendingCreates(A)).toEqual([])

    const y = id()
    const sent = begin(A, y).entry
    const kept = settleCalendarCreateAttempt(sent, { kind: "unknown" })
    expect(kept.superseded).toBeUndefined()
    expect(readCalendarPendingCreate(A, y)).toMatchObject({ status: "unknown" })
  })

  it("UX-04: 期限で捨てる控えは、直しかけの入力（scope = その id の下書き）も一緒に消す。対照: 他の id の下書きは残す", () => {
    const x = id()
    const other = id()
    begin(A, x, "検診", new Date("2026-10-01T00:00:00Z"))
    const draftKey = (cid: string) => `irori:draft:v1:${A.userId}:${A.householdId}:calendar-event-new:${cid}`
    storage.setItem(draftKey(x), "{}")
    storage.setItem(draftKey(other), "{}")
    const t0 = new Date("2026-10-01T00:00:00Z").getTime()
    expect(readCalendarPendingCreate(A, x, t0 + CALENDAR_CREATE_TTL_MS + 1)).toBeNull()
    expect(storage.getItem(draftKey(x))).toBeNull()
    expect(storage.getItem(draftKey(other))).toBe("{}")
  })

  it("PI-3: この版より新しい schemaVersion の控えは消さずに読み飛ばす。対照: 壊れた形の v1 は消す", () => {
    const x = id()
    const e = begin(A, x).entry
    storage.setItem(calendarCreateKey(A, x), JSON.stringify({ ...e, schemaVersion: 2, status: "something-new" }))
    expect(readCalendarPendingCreate(A, x)).toBeNull()
    expect(storage.getItem(calendarCreateKey(A, x))).not.toBeNull()
    storage.setItem(calendarCreateKey(A, x), JSON.stringify({ ...e, status: "something-new" }))
    expect(readCalendarPendingCreate(A, x)).toBeNull()
    expect(storage.getItem(calendarCreateKey(A, x))).toBeNull()
  })
})
