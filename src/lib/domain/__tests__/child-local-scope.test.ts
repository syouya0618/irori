// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest"
import { readPersistedTimer, writePersistedTimer, clearPersistedTimer, belongsToOwner } from "../feeding-timer-storage"
import { draftStorageKey } from "../draft-storage"
import { listPendingSaves, putPendingSave, type PendingSave } from "../pending-saves-storage"

const base = { userId: "synthetic-user", householdId: "synthetic-household" }
const a = "d0000000-0000-4000-8000-000000000001"
const b = "d0000000-0000-4000-8000-000000000002"
describe("child ownership survives reload and a sibling switch", () => {
  beforeEach(() => localStorage.clear())
  it("keeps two timers and the pre-migration timer independently", () => {
    const timer = { ...base, startedAt: new Date().toISOString(), feedingType: "breast_left" as const }
    writePersistedTimer(timer)
    writePersistedTimer({ ...timer, childId: a })
    writePersistedTimer({ ...timer, childId: b })
    clearPersistedTimer(a)
    expect(readPersistedTimer(a)).toBeNull()
    expect(readPersistedTimer(b)?.childId).toBe(b)
    expect(readPersistedTimer()?.childId).toBeUndefined()
    expect(belongsToOwner(timer, { ...base, childId: b })).toBe(false)
  })
  it("does not reattribute an unknown save to a sibling", () => {
    const p: PendingSave = { schemaVersion: 1, owner: { ...base, childId: a }, clientId: a, action: "recordFeeding", payload: { childId: a, clientId: a, feedingType: "bottle", amountMl: 50 }, summary: "synthetic", firstAttemptAt: new Date().toISOString(), phase: "unknown" }
    expect(putPendingSave(p)).toBe(true)
    expect(listPendingSaves({ ...base, childId: b })).toEqual([])
    expect(listPendingSaves({ ...base, childId: a })[0].payload.childId).toBe(a)
    expect(listPendingSaves(base)).toEqual([])
  })
  it("separates diary drafts with the same calendar date", () => {
    const target = { kind: "diary" as const, date: "2026-01-01" }
    expect(draftStorageKey({ ...base, childId: a }, target)).not.toBe(draftStorageKey({ ...base, childId: b }, target))
    expect(draftStorageKey(base, target)).not.toBe(draftStorageKey({ ...base, childId: a }, target))
  })
})
