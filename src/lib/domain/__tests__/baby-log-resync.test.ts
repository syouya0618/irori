import { describe, it, expect } from "vitest"
import {
  reconcileResyncedLogs,
  reconcileResyncedFallback,
} from "../baby-log-resync"
import type { BabyLogData } from "@/lib/types/baby"

function makeLog(
  overrides: Partial<BabyLogData> &
    Pick<BabyLogData, "id" | "log_type" | "logged_at">,
): BabyLogData {
  return {
    logged_by: "user-1",
    feeding_type: null,
    amount_ml: null,
    breast_left_count: null,
    breast_right_count: null,
    breast_left_sec: null,
    breast_right_sec: null,
    breast_start_side: null,
    diaper_type: null,
    poop_amount: null,
    temperature: null,
    weight_g: null,
    height_cm: null,
    duration_min: null,
    duration_sec: null,
    memo: null,
    created_at: "2026-07-18T00:00:00+09:00",
    ...overrides,
  }
}

const anyWindow = () => true
const ids = (logs: BabyLogData[]) => logs.map((l) => l.id).sort()

const a = makeLog({ id: "a", log_type: "feeding", logged_at: "2026-07-18T08:00:00+09:00" })
const b = makeLog({ id: "b", log_type: "diaper", logged_at: "2026-07-18T09:00:00+09:00" })
const c = makeLog({ id: "c", log_type: "diaper", logged_at: "2026-07-18T10:00:00+09:00" })

describe("reconcileResyncedLogs（P1-04: 再取得結果を真値に、取得中の手元変更は手元を真値に）", () => {
  it("取得中に触っていない行は fetched が真値: 他端末で消えた行は消え、増えた行は入る", () => {
    const result = reconcileResyncedLogs([a, b], [a, c], new Set(), anyWindow)
    expect(ids(result)).toEqual(["a", "c"])
  })

  it("取得開始後に手元へ入った行（楽観 append / Realtime INSERT）は fetched に無くても残る", () => {
    const result = reconcileResyncedLogs([c, a], [a], new Set(["c"]), anyWindow)
    expect(ids(result)).toEqual(["a", "c"])
  })

  it("取得開始後に手元で消した行（取り消し / 削除）は fetched に残っていても戻さない", () => {
    const result = reconcileResyncedLogs([a], [a, b], new Set(["b"]), anyWindow)
    expect(ids(result)).toEqual(["a"])
  })

  it("取得開始後に手元で更新した行は手元の版を採る（fetched の古い版で巻き戻さない）", () => {
    const edited = { ...a, memo: "取得中に編集" }
    const stale = { ...a, memo: "取得前の版" }
    const result = reconcileResyncedLogs([edited], [stale], new Set(["a"]), anyWindow)
    expect(result).toEqual([edited])
  })

  it("触っていない行は fetched の版を採る（他端末の編集が反映される）", () => {
    const local = { ...a, memo: "手元の古い版" }
    const server = { ...a, memo: "配偶者が編集" }
    const result = reconcileResyncedLogs([local], [server], new Set(), anyWindow)
    expect(result).toEqual([server])
  })

  it("手元に残す行も窓の外なら落とす（旧選択日の行を持ち込まない）", () => {
    const otherDay = makeLog({
      id: "x",
      log_type: "diaper",
      logged_at: "2026-07-17T22:00:00+09:00",
    })
    const inDate = (l: BabyLogData) => l.logged_at.startsWith("2026-07-18")
    const result = reconcileResyncedLogs([otherDay, a], [a], new Set(["x"]), inDate)
    expect(ids(result)).toEqual(["a"])
  })

  it("対照: 触った集合が空なら結果は fetched と同じ行集合（＝全置換）", () => {
    const result = reconcileResyncedLogs([a, b, c], [b], new Set(), anyWindow)
    expect(result).toEqual([b])
  })
})

describe("reconcileResyncedFallback（今日より前の最後の授乳の取り直し）", () => {
  const older = makeLog({ id: "old", log_type: "feeding", logged_at: "2026-07-17T20:00:00+09:00" })
  const newer = makeLog({ id: "new", log_type: "feeding", logged_at: "2026-07-17T23:00:00+09:00" })

  it("取得中に手元で更新していなければ fetched が真値（配偶者の削除で古い行へ戻れる）", () => {
    expect(reconcileResyncedFallback(newer, older, false)).toBe(older)
    expect(reconcileResyncedFallback(newer, null, false)).toBeNull()
  })

  it("取得中に深夜跨ぎの記録で手元を進めていたら、新しい方を残す", () => {
    expect(reconcileResyncedFallback(newer, older, true)).toBe(newer)
    expect(reconcileResyncedFallback(older, newer, true)).toBe(newer)
    expect(reconcileResyncedFallback(newer, null, true)).toBe(newer)
    expect(reconcileResyncedFallback(null, older, true)).toBe(older)
  })

  it("表記の混在（Z と +09:00）でも epoch で比べる", () => {
    const zForm = makeLog({ id: "z", log_type: "feeding", logged_at: "2026-07-17T14:30:00.000Z" }) // 23:30 JST
    expect(reconcileResyncedFallback(zForm, newer, true)).toBe(zForm)
  })
})
