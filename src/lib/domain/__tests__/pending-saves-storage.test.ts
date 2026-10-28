import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import {
  listPendingSaves,
  putPendingSave,
  removePendingSave,
  purgePendingSavesNotOwnedBy,
  PENDING_SAVES_STORAGE_KEY,
  PENDING_SAVES_MAX,
  type PendingSave,
} from "../pending-saves-storage"

class SharedStorage {
  data = new Map<string, string>()
  beforeSet: (() => void) | null = null
  beforeRemove: (() => void) | null = null
  get length() { return this.data.size }
  key(i: number) { return [...this.data.keys()][i] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) {
    const next = this.beforeSet
    this.beforeSet = null
    next?.()
    this.data.set(key, value)
  }
  removeItem(key: string) {
    const next = this.beforeRemove
    this.beforeRemove = null
    next?.()
    this.data.delete(key)
  }
}

const now = Date.parse("2026-10-28T00:00:00.000Z")
const owner = { userId: "user-a", householdId: "house-a" }
let storage: SharedStorage
function pending(n: number, o = owner): PendingSave {
  const clientId = `11111111-0000-4000-8000-${String(n).padStart(12, "0")}`
  return {
    schemaVersion: 1, clientId, owner: o, action: "recordMemo",
    payload: { memo: `本文${n}`, clientId }, summary: "メモ",
    firstAttemptAt: new Date(now).toISOString(), phase: "unknown",
  }
}
beforeEach(() => {
  storage = new SharedStorage()
  vi.stubGlobal("localStorage", storage)
})
afterEach(() => vi.unstubAllGlobals())

describe("育児記録の控え: 別タブの処理が重なっても他の作成を消さぬ", () => {
  it("Aの書込み直前にBが保存を終えても、両方のtrueに対応する控えが残る（V9-PENDING-CROSS-TAB-LOST-UPDATE）", () => {
    let savedB = false
    storage.beforeSet = () => { savedB = putPendingSave(pending(2), now) }
    expect(putPendingSave(pending(1), now)).toBe(true)
    expect(savedB).toBe(true)
    expect(listPendingSaves(owner, now).map((p) => p.clientId).sort()).toEqual([pending(1).clientId, pending(2).clientId])
  })

  it("Aを確定して消す直前にBが保存を終えても、Bの唯一の控えは残る（V9-PENDING-CROSS-TAB-LOST-UPDATE）", () => {
    putPendingSave(pending(1), now)
    let savedB = false
    storage.beforeRemove = () => { savedB = putPendingSave(pending(2), now) }
    removePendingSave(pending(1).clientId, now)
    expect(savedB).toBe(true)
    expect(listPendingSaves(owner, now).map((p) => p.clientId)).toEqual([pending(2).clientId])
  })

  it("上限を超えた作成はfalseを返し、先に残した結果不明の控えを押し出さぬ", () => {
    for (let n = 1; n <= PENDING_SAVES_MAX; n++) expect(putPendingSave(pending(n), now)).toBe(true)
    expect(putPendingSave(pending(PENDING_SAVES_MAX + 1), now)).toBe(false)
    expect(listPendingSaves(owner, now).map((p) => p.clientId).sort()).toEqual(
      Array.from({ length: PENDING_SAVES_MAX }, (_, i) => pending(i + 1).clientId),
    )
  })

  it("同じIDの状態更新でも、最初の送信内容と押下時刻を変えぬ", () => {
    putPendingSave(pending(1), now)
    putPendingSave({ ...pending(1), payload: { memo: "後で直した本文", clientId: pending(1).clientId }, firstAttemptAt: new Date(now + 1000).toISOString(), phase: "conflict" }, now + 1000)
    expect(listPendingSaves(owner, now + 1000)).toEqual([{ ...pending(1), phase: "conflict" }])
  })

  it("v1の配列の控えも読み、確定ではそのIDだけ消して、新しい保存の控えを保つ", () => {
    storage.setItem(PENDING_SAVES_STORAGE_KEY, JSON.stringify([pending(1), pending(2)]))
    expect(listPendingSaves(owner, now)).toHaveLength(2)
    putPendingSave(pending(3), now)
    removePendingSave(pending(1).clientId, now)
    expect(listPendingSaves(owner, now).map((p) => p.clientId).sort()).toEqual([pending(2).clientId, pending(3).clientId])
  })

  it("利用者・世帯で分離し、別の持ち主の控えだけを掃除する", () => {
    const other = { userId: "user-b", householdId: "house-b" }
    putPendingSave(pending(1), now)
    putPendingSave(pending(2, other), now)
    expect(listPendingSaves(owner, now)).toHaveLength(1)
    expect(listPendingSaves(other, now)).toHaveLength(1)
    purgePendingSavesNotOwnedBy(owner)
    expect(listPendingSaves(owner, now)).toEqual([pending(1)])
    expect(listPendingSaves(other, now)).toHaveLength(0)
  })
})
