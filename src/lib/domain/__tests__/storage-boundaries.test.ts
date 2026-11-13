// @vitest-environment jsdom
import "./record-request-test-keys"
import { beforeEach, expect, it } from "vitest"
import { readPersistedTimer, writePersistedTimer, type PersistedTimerState } from "../feeding-timer-storage"
import { listRecordRequests, storeRecordRequest, purgeOtherRecordRequests, unreadableRecordCount, type RecordRequest } from "../record-requests"
import { MEDICAL_SOURCES } from "../medical"
import { CHORE_PENDING_PREFIX, listChorePending, putChorePending, type ChorePending } from "../chore-pending"

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

it("timer read/write projects only its documented fields, including the frozen submission", async () => {
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

it("does not turn malformed owner metadata into an ownerless legacy timer", async () => {
  const timer = { startedAt: at, feedingType: "breast_left", userId: { token: unexpected } }
  localStorage.setItem("irori:feeding-timer", JSON.stringify(timer))
  expect(readPersistedTimer()).toBeNull()
  expect(writePersistedTimer(timer as unknown as PersistedTimerState)).toBe(false)
})

it("keeps a genuine legacy timer but refuses to acknowledge a damaged frozen submission", async () => {
  const timer: PersistedTimerState = { startedAt: at, feedingType: "breast_right" }
  expect(writePersistedTimer(timer)).toBe(true)
  expect(readPersistedTimer()).toEqual(timer)
  expect(writePersistedTimer({ ...timer, submission: { phase: "unknown" } } as PersistedTimerState)).toBe(false)
  expect(readPersistedTimer()).toEqual(timer)
})

it("projects record envelopes, owner and nested medical values without losing the replay body", async () => {
  const input = {
    ...medical, password: unexpected, owner: { ...owner, access_token: unexpected },
    payload: { ...medical.payload, session: unexpected, value: { ...medical.payload.value as object, password: unexpected } },
  }
  expect(await storeRecordRequest(input)).toBe(true)
  const raw = localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith("irori:record-request:v1:"))!)
  expect(raw).not.toContain(unexpected)
  expect(await listRecordRequests(owner)).toEqual([medical])
  await storeRecordRequest({ ...medical, payload: { ...medical.payload, value: { ...medical.payload.value as object, title: "changed" } } })
  expect(await listRecordRequests(owner)).toEqual([medical])
})

it("never invokes an extra toJSON hook while persisting a record", async () => {
  const input = { ...medical, toJSON: () => ({ password: unexpected }) }
  expect(await storeRecordRequest(input)).toBe(true)
  expect(await listRecordRequests(owner)).toEqual([medical])
  expect(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith("irori:record-request:v1:"))!)).not.toContain(unexpected)
})

it("rejects an object pretending to be a medical status instead of serializing its contents", async () => {
  const status = { toString: () => "planned", toJSON: () => ({ access_token: unexpected }) }
  const input = { ...medical, payload: { ...medical.payload, value: { ...medical.payload.value as object, status } } }
  expect(await storeRecordRequest(input)).toBe(false)
  expect(Object.keys(localStorage).filter(k=>k.startsWith("irori:record-request:v1:"))).toHaveLength(0)
})

it("removes a previous owner's schema-1 envelope even when its replay body is no longer understood", async () => {
  const key = "irori:record-request:v1:" + owner.userId + ":" + owner.householdId + ":" + childId + ":" + id
  const old = JSON.stringify({ schema: 1, id, owner, kind: "custom", payload: { childId, operation: "unsupported-historical-source" } })
  localStorage.setItem(key, old)
  await purgeOtherRecordRequests(owner)
  expect(localStorage.getItem(key)).toBe(old)
  expect(unreadableRecordCount(owner)).toBe(1)
  await purgeOtherRecordRequests({ ...owner, userId: "another-fixture-user" })
  expect(localStorage.getItem(key)).toBeNull()
  const future = JSON.stringify({ schema: 99, id, owner, kind: "unknown-fixture" })
  localStorage.setItem(key, future)
  await purgeOtherRecordRequests({ ...owner, userId: "another-fixture-user" })
  expect(localStorage.getItem(key)).toBe(future)
})

it("rejects an arbitrary or mismatched replay body without replacing unreadable bytes", async () => {
  expect(await storeRecordRequest({ ...medical, payload: { childId, password: unexpected } })).toBe(false)
  expect(await storeRecordRequest({ ...medical, payload: { ...medical.payload, childId: id } })).toBe(false)
  const key = "irori:record-request:v1:" + owner.userId + ":" + owner.householdId + ":" + childId + ":" + id
  const future = JSON.stringify({ schema: 99, id, owner, kind: "unknown-fixture" })
  localStorage.setItem(key, future)
  expect(await listRecordRequests(owner)).toEqual([])
  expect(unreadableRecordCount(owner)).toBe(1)
  await storeRecordRequest(medical)
  expect(localStorage.getItem(key)).toBe(future)
})

it("keeps the operation key separate from the existing row id when restoring an edit", async () => {
  const edit = { ...medical, payload: { ...medical.payload, id: childId } }
  expect(await storeRecordRequest(edit)).toBe(true)
  expect(await listRecordRequests(owner)).toEqual([edit])
})

it("preserves each custom scalar, field options and exact child-create strings", async () => {
  for (const value of [0, false, "synthetic text"]) {
    localStorage.clear()
    const r: RecordRequest = { ...medical, kind: "custom", payload: { operation: "record", id, childId, version: null, fieldId: childId, value, loggedAt: at, memo: null, voided: false } }
    expect(await storeRecordRequest(r)).toBe(true)
    expect(await listRecordRequests(owner)).toEqual([r])
  }
  const requests: RecordRequest[] = [
    { ...medical, kind: "custom", payload: { operation: "field", id, childId, version: null, label: "synthetic choice", type: "choice", options: ["A", "B"], archived: false } },
    { ...medical, id: childId, kind: "child", payload: { id: "", version: "", client_id: childId, household_id: owner.householdId, name: " synthetic child ", birth_date: "", sex: "", childId } },
  ]
  for (const r of requests) {
    localStorage.clear()
    expect(await storeRecordRequest(r)).toBe(true)
    expect(await listRecordRequests(owner)).toEqual([r])
  }
})

// 家事（ごみ・掃除・ごはん）の控え（chore-pending。2026-11）。世帯スコープの平文控え。
const chore: ChorePending = {
  schema: 1, id, owner: { userId: owner.userId, householdId: owner.householdId }, kind: "meal",
  label: "synthetic shopping check", payload: { id: childId, version: "2026-10-31T00:00:00.123456+00:00", checked: true },
  phase: "unknown", firstAttemptAt: at,
}

it("projects a chore envelope to its documented fields without losing the replay body", () => {
  const input = {
    ...chore, password: unexpected, session: { access_token: unexpected },
    owner: { ...chore.owner, childId, access_token: unexpected },
  }
  expect(putChorePending(input as ChorePending)).toBe(true)
  const raw = localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith(CHORE_PENDING_PREFIX))!)
  expect(raw).not.toContain(unexpected)
  // 世帯スコープの控えゆえ、持ち主に子どもの ID を残さぬ
  expect(raw).not.toContain('"childId"')
  expect(listChorePending(chore.owner)).toEqual({ items: [chore], unreadable: 0, storageReadable: true })
  // 版（updated_at）は表記のまま運ぶ（丸めぬ）
  expect(listChorePending(chore.owner).items[0].payload.version).toBe("2026-10-31T00:00:00.123456+00:00")
})

it("never invokes a toJSON hook hidden in a chore replay body, and stores nothing for it", () => {
  const hooked = { ...chore, payload: { id: childId, hook: { toJSON: () => ({ password: unexpected }) } } }
  expect(putChorePending(hooked as unknown as ChorePending)).toBe(false)
  expect(Object.keys(localStorage).filter(k=>k.startsWith(CHORE_PENDING_PREFIX))).toHaveLength(0)
})

it("does not read a chore envelope for another owner, and keeps unreadable bytes for explicit recovery", () => {
  expect(putChorePending(chore)).toBe(true)
  expect(listChorePending({ userId: "another-fixture-user", householdId: owner.householdId }).items).toEqual([])
  expect(listChorePending({ userId: owner.userId, householdId: "another-fixture-household" }).items).toEqual([])
  const key = CHORE_PENDING_PREFIX + owner.userId + ":" + owner.householdId + ":meal:" + childId
  const future = JSON.stringify({ ...chore, id: childId, schema: 99 })
  localStorage.setItem(key, future)
  expect(listChorePending(chore.owner)).toEqual({ items: [chore], unreadable: 1, storageReadable: true })
  expect(putChorePending({ ...chore, id: childId })).toBe(false)
  expect(localStorage.getItem(key)).toBe(future)
})
