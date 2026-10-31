// @vitest-environment jsdom
import { beforeEach, expect, it } from "vitest"
import { readPersistedTimer, writePersistedTimer, type PersistedTimerState } from "../feeding-timer-storage"
import { listRecordRequests, storeRecordRequest, purgeOtherRecordRequests, unreadableRecordCount, type RecordRequest } from "../record-requests"
import { MEDICAL_SOURCES } from "../medical"

const childId = "e9000000-0000-4000-8000-000000000001"
const id = "e9000000-0000-4000-8000-000000000002"
const owner = { userId: "fixture-user", householdId: "fixture-household", childId }
const at = "2026-10-31T00:00:00.000Z"
const unexpected = "synthetic credential must not be copied"
const medical: RecordRequest = {
  schema: 1, id, owner, kind: "medical",
  payload: { id, childId, version: "2026-10-31T00:00:00.123456+00:00", value: {
    kind: "vaccination", title: "synthetic vaccination", dose: 1, status: "planned",
    scheduled_date: "2026-11-01", completed_date: null, memo: "synthetic note", remind: false,
    source_key: MEDICAL_SOURCES.vaccination.key,
  } },
}
beforeEach(() => localStorage.clear())

it("timer read/write projects only its documented fields, including the frozen submission", () => {
  const timer = {
    ...owner, startedAt: at, feedingType: "breast_left", leftSec: 0, rightSec: 12,
    memo: unexpected, session: { access_token: unexpected },
    submission: { firstAttemptAt: at, phase: "unknown", password: unexpected, payload: {
      childId, feedingType: "breast", breastLeftCount: 0, breastRightCount: 1,
      breastStartSide: "right", durationSec: 12, clientId: id, access_token: unexpected,
    } },
  } as PersistedTimerState
  localStorage.setItem("irori:feeding-timer:" + childId, JSON.stringify(timer))
  const restored = readPersistedTimer(childId)
  expect(restored).not.toHaveProperty("memo")
  expect(restored).not.toHaveProperty("session")
  expect(restored?.submission?.payload).not.toHaveProperty("access_token")
  expect(writePersistedTimer(timer)).toBe(true)
  expect(localStorage.getItem("irori:feeding-timer:" + childId)).not.toContain(unexpected)
  expect(readPersistedTimer(childId)?.submission).toMatchObject({ phase: "unknown", payload: { durationSec: 12, clientId: id } })
  expect(readPersistedTimer(childId)?.submission?.payload).not.toHaveProperty("loggedAt")
})

it("does not turn malformed owner metadata into an ownerless legacy timer", () => {
  const timer = { startedAt: at, feedingType: "breast_left", userId: { token: unexpected } }
  localStorage.setItem("irori:feeding-timer", JSON.stringify(timer))
  expect(readPersistedTimer()).toBeNull()
  expect(writePersistedTimer(timer as unknown as PersistedTimerState)).toBe(false)
})

it("keeps a genuine legacy timer but refuses to acknowledge a damaged frozen submission", () => {
  const timer: PersistedTimerState = { startedAt: at, feedingType: "breast_right" }
  expect(writePersistedTimer(timer)).toBe(true)
  expect(readPersistedTimer()).toEqual(timer)
  expect(writePersistedTimer({ ...timer, submission: { phase: "unknown" } } as PersistedTimerState)).toBe(false)
  expect(readPersistedTimer()).toEqual(timer)
})

it("projects record envelopes, owner and nested medical values without losing the replay body", () => {
  const input = {
    ...medical, password: unexpected, owner: { ...owner, access_token: unexpected },
    payload: { ...medical.payload, session: unexpected, value: { ...medical.payload.value as object, password: unexpected } },
  }
  expect(storeRecordRequest(input)).toBe(true)
  const raw = localStorage.getItem(Object.keys(localStorage)[0])
  expect(raw).not.toContain(unexpected)
  expect(listRecordRequests(owner)).toEqual([medical])
  storeRecordRequest({ ...medical, payload: { ...medical.payload, value: { ...medical.payload.value as object, title: "changed" } } })
  expect(listRecordRequests(owner)).toEqual([medical])
})

it("never invokes an extra toJSON hook while persisting a record", () => {
  const input = { ...medical, toJSON: () => ({ password: unexpected }) }
  expect(storeRecordRequest(input)).toBe(true)
  expect(listRecordRequests(owner)).toEqual([medical])
  expect(localStorage.getItem(Object.keys(localStorage)[0])).not.toContain(unexpected)
})

it("rejects an object pretending to be a medical status instead of serializing its contents", () => {
  const status = { toString: () => "planned", toJSON: () => ({ access_token: unexpected }) }
  const input = { ...medical, payload: { ...medical.payload, value: { ...medical.payload.value as object, status } } }
  expect(storeRecordRequest(input)).toBe(false)
  expect(localStorage.length).toBe(0)
})

it("removes a previous owner's schema-1 envelope even when its replay body is no longer understood", () => {
  const key = "irori:record-request:v1:" + owner.userId + ":" + owner.householdId + ":" + childId + ":" + id
  const old = JSON.stringify({ ...medical, payload: { ...medical.payload, value: { ...medical.payload.value as object, source_key: "unsupported-historical-source" } } })
  localStorage.setItem(key, old)
  purgeOtherRecordRequests(owner)
  expect(localStorage.getItem(key)).toBe(old)
  expect(unreadableRecordCount(owner)).toBe(1)
  purgeOtherRecordRequests({ ...owner, userId: "another-fixture-user" })
  expect(localStorage.getItem(key)).toBeNull()
  const future = JSON.stringify({ ...medical, schema: 2 })
  localStorage.setItem(key, future)
  purgeOtherRecordRequests({ ...owner, userId: "another-fixture-user" })
  expect(localStorage.getItem(key)).toBe(future)
})

it("rejects an arbitrary or mismatched replay body without replacing unreadable bytes", () => {
  expect(storeRecordRequest({ ...medical, payload: { childId, password: unexpected } })).toBe(false)
  expect(storeRecordRequest({ ...medical, payload: { ...medical.payload, childId: id } })).toBe(false)
  const key = "irori:record-request:v1:" + owner.userId + ":" + owner.householdId + ":" + childId + ":" + id
  const future = JSON.stringify({ ...medical, schema: 2 })
  localStorage.setItem(key, future)
  expect(listRecordRequests(owner)).toEqual([])
  expect(unreadableRecordCount(owner)).toBe(1)
  storeRecordRequest(medical)
  expect(localStorage.getItem(key)).toBe(future)
})

it("keeps the operation key separate from the existing row id when restoring an edit", () => {
  const edit = { ...medical, payload: { ...medical.payload, id: childId } }
  expect(storeRecordRequest(edit)).toBe(true)
  expect(listRecordRequests(owner)).toEqual([edit])
})

it("preserves each custom scalar, field options and exact child-create strings", () => {
  for (const value of [0, false, "synthetic text"]) {
    localStorage.clear()
    const r: RecordRequest = { ...medical, kind: "custom", payload: { operation: "record", id, childId, version: null, fieldId: childId, value, loggedAt: at, memo: null, voided: false } }
    expect(storeRecordRequest(r)).toBe(true)
    expect(listRecordRequests(owner)).toEqual([r])
  }
  const requests: RecordRequest[] = [
    { ...medical, kind: "custom", payload: { operation: "field", id, childId, version: null, label: "synthetic choice", type: "choice", options: ["A", "B"], archived: false } },
    { ...medical, id: childId, kind: "child", payload: { id: "", version: "", client_id: childId, household_id: owner.householdId, name: " synthetic child ", birth_date: "", sex: "", childId } },
  ]
  for (const r of requests) {
    localStorage.clear()
    expect(storeRecordRequest(r)).toBe(true)
    expect(listRecordRequests(owner)).toEqual([r])
  }
})
