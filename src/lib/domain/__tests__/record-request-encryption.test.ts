// @vitest-environment jsdom
import "./record-request-test-keys"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as keys from "../record-request-key"
import { countRecordRequests, listRecordRequests, readRecordRequests, storeRecordRequest, removeRecordRequest, purgeOtherRecordRequests, RECORD_REQUEST_PREFIX, type RecordRequest } from "../record-requests"
const owner = { userId: "synthetic-encryption-user", householdId: "synthetic-encryption-household", childId: "e9100000-0000-4000-8000-000000000001" }
const entry: RecordRequest = { schema: 1, id: "e9100000-0000-4000-8000-000000000002", owner, kind: "custom", payload: { operation: "record", id: "e9100000-0000-4000-8000-000000000003", childId: owner.childId, version: "2026-10-31T00:00:00.123456+00:00", fieldId: owner.childId, value: false, loggedAt: "2026-10-31T00:00:00Z", memo: "synthetic private replay body", voided: false } }
const storageKey = `${RECORD_REQUEST_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId}:${entry.id}`
beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

const markerKey = "irori:record-request-owner:v1"
it("minimizes the active-owner marker and keeps it stable across children and same-owner relogin", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const marker = localStorage.getItem(markerKey)!
 expect(Object.keys(JSON.parse(marker)).sort()).toEqual(["epoch", "ownerHash", "schema"])
 expect(JSON.parse(marker)).toMatchObject({ schema: 2, ownerHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
 for (const value of [owner.userId, owner.householdId, owner.childId, entry.id, "payload", "memo"]) expect(marker).not.toContain(value)
 await purgeOtherRecordRequests({ ...owner, childId: entry.id })
 expect(localStorage.getItem(markerKey)).toBe(marker)
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 0 })
 removeRecordRequest(entry)
 expect(localStorage.getItem(markerKey)).toBe(marker)
 expect(await storeRecordRequest(entry)).toBe(true)
})
it("rewrites a known legacy owner marker without discarding immutable or future requests", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const raw = localStorage.getItem(storageKey)
 const futureKey = storageKey + "-future"
 localStorage.setItem(futureKey, '{"schema":99,"opaque":"synthetic future"}')
 localStorage.setItem(markerKey, JSON.stringify({ owner: JSON.stringify([owner.userId, owner.householdId]), epoch: crypto.randomUUID() }))
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 1 })
 expect(localStorage.getItem(markerKey)).not.toContain(owner.userId)
 expect(localStorage.getItem(storageKey)).toBe(raw)
 expect(localStorage.getItem(futureKey)).not.toBeNull()
})
it.each(['{"schema":99,"opaque":"future marker"}', '{"schema":2,"ownerHash":"invalid","epoch":"invalid"}', 'broken JSON'])("preserves an unknown or damaged owner marker and fails closed: %s", async marker => {
 localStorage.setItem(markerKey, marker)
 expect(await storeRecordRequest(entry)).toBe(false)
 await purgeOtherRecordRequests(owner)
 expect(localStorage.getItem(markerKey)).toBe(marker)
 expect(localStorage.getItem(storageKey)).toBeNull()
})
it("cancels an in-flight write across A to B to A even when the owner fingerprint returns", async () => {
 const original = keys.recordRequestKey
 let release!: () => void
 const blocked = new Promise<void>(resolve => { release = resolve })
 vi.spyOn(keys, "recordRequestKey").mockImplementation(async (...args) => { await blocked; return original(...args) })
 const pending = storeRecordRequest(entry)
 const first = JSON.parse(localStorage.getItem(markerKey)!)
 await purgeOtherRecordRequests({ ...owner, userId: "another-synthetic-user" })
 await purgeOtherRecordRequests(owner)
 const returned = JSON.parse(localStorage.getItem(markerKey)!)
 expect(returned.ownerHash).toBe(first.ownerHash)
 expect(returned.epoch).not.toBe(first.epoch)
 release()
 expect(await pending).toBe(false)
 expect(localStorage.getItem(storageKey)).toBeNull()
})
it("selects the owner synchronously before async key work and matches standard SHA-256", async () => {
 await purgeOtherRecordRequests(owner)
 const marker = JSON.parse(localStorage.getItem(markerKey)!)
 const expected = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("irori:record-request-owner:v2\0" + JSON.stringify([owner.userId, owner.householdId])))
 expect(marker.ownerHash).toBe(Array.from(new Uint8Array(expected), n => n.toString(16).padStart(2, "0")).join(""))
 const switched = purgeOtherRecordRequests({ ...owner, userId: "another-synthetic-user" })
 expect(JSON.parse(localStorage.getItem(markerKey)!).ownerHash).not.toBe(marker.ownerHash)
 await switched
 expect(await storeRecordRequest(entry)).toBe(false)
})

it("persists only ciphertext while retaining exact operation, target, microsecond version and false", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const raw = localStorage.getItem(storageKey)!
 expect(JSON.parse(raw)).toMatchObject({ schema: 2, encoding: "aes-gcm-v1" })
 for (const value of ["synthetic private replay body", "2026-10-31", "loggedAt", "version", "payload"]) expect(raw).not.toContain(value)
 expect(await listRecordRequests(owner)).toEqual([entry])
})
it("durably migrates a legacy body before removing its original plaintext", async () => {
 const legacy = JSON.stringify(entry)
 localStorage.setItem(storageKey, legacy)
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 0 })
 expect(localStorage.getItem(storageKey)).not.toContain("synthetic private replay body")
 expect(await listRecordRequests(owner)).toEqual([entry])
})
it("preserves legacy bytes and blocks a new operation when the key store is unavailable", async () => {
 const legacy = JSON.stringify(entry)
 localStorage.setItem(storageKey, legacy)
 vi.spyOn(keys, "recordRequestKey").mockRejectedValue(new Error("synthetic blocked IndexedDB"))
 expect((await readRecordRequests(owner)).unreadable).toBe(1)
 expect(localStorage.getItem(storageKey)).toBe(legacy)
 expect(await storeRecordRequest(entry)).toBe(false)
 expect(countRecordRequests(owner)).toBe(1)
})
it("does not delete ciphertext or call a missing key an empty queue", async () => {
 await storeRecordRequest(entry)
 const raw = localStorage.getItem(storageKey)
 vi.spyOn(keys, "recordRequestKey").mockRejectedValue(new Error("synthetic key lost"))
 expect(await readRecordRequests(owner)).toEqual({ items: [], unreadable: 1 })
 expect(localStorage.getItem(storageKey)).toBe(raw)
 expect(countRecordRequests(owner)).toBe(1)
})
it("binds encrypted bytes to the owner and operation key and preserves tampered bytes", async () => {
 await storeRecordRequest(entry)
 const raw = localStorage.getItem(storageKey)!
 const value = JSON.parse(raw)
 value.ciphertext = (value.ciphertext[0] === "A" ? "B" : "A") + value.ciphertext.slice(1)
 localStorage.setItem(storageKey, JSON.stringify(value))
 const tampered = localStorage.getItem(storageKey)
 expect(await readRecordRequests(owner)).toEqual({ items: [], unreadable: 1 })
 expect(localStorage.getItem(storageKey)).toBe(tampered)
 localStorage.setItem(storageKey, raw)
 const siblingKey = storageKey.slice(0, -36) + "e9100000-0000-4000-8000-000000000009"
 localStorage.setItem(siblingKey, raw)
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 1 })
})
it("freezes the input before async key access and cancels a removed in-flight write", async () => {
 const original = keys.recordRequestKey
 let release!: () => void
 const blocked = new Promise<void>(resolve => { release = resolve })
 vi.spyOn(keys, "recordRequestKey").mockImplementation(async (...args) => { await blocked; return original(...args) })
 const mutable = structuredClone(entry)
 const pending = storeRecordRequest(mutable)
 mutable.payload.memo = "changed during crypto"
 release()
 expect(await pending).toBe(true)
 expect(await listRecordRequests(owner)).toEqual([entry])
 removeRecordRequest(entry)
 let resume!: () => void
 const again = new Promise<void>(resolve => { resume = resolve })
 vi.mocked(keys.recordRequestKey).mockImplementation(async (...args) => { await again; return original(...args) })
 const cancelled = storeRecordRequest(entry)
 removeRecordRequest(entry)
 resume()
 expect(await cancelled).toBe(false)
 expect(localStorage.getItem(storageKey)).toBeNull()
})
it("does not resurrect an old owner's write after account switching", async () => {
 const original = keys.recordRequestKey
 let release!: () => void
 const blocked = new Promise<void>(resolve => { release = resolve })
 vi.spyOn(keys, "recordRequestKey").mockImplementation(async (...args) => { await blocked; return original(...args) })
 const pending = storeRecordRequest(entry)
 await purgeOtherRecordRequests({ ...owner, userId: "another-synthetic-user" })
 release()
 expect(await pending).toBe(false)
 expect(localStorage.getItem(storageKey)).toBeNull()
})
it("never falls back to plaintext on quota failure and retains a prior immutable ciphertext", async () => {
 const write = Storage.prototype.setItem
 const denied = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) { if (key.startsWith(RECORD_REQUEST_PREFIX)) throw new Error("synthetic quota"); write.call(this, key, value) })
 expect(await storeRecordRequest(entry)).toBe(false)
 expect(localStorage.getItem(storageKey)).toBeNull()
 denied.mockRestore()
 expect(await storeRecordRequest(entry)).toBe(true)
 const raw = localStorage.getItem(storageKey)
 await Promise.all([storeRecordRequest({ ...entry, payload: { ...entry.payload, memo: "later body" } }), storeRecordRequest(entry)])
 expect(localStorage.getItem(storageKey)).toBe(raw)
})
it("preserves an older owner's wrapping key when a future envelope in that namespace still needs it", async () => {
 await storeRecordRequest(entry)
 const futureKey = storageKey.slice(0, -36) + "e9100000-0000-4000-8000-000000000009"
 const future = JSON.stringify({ schema: 99, opaque: "synthetic future bytes" })
 localStorage.setItem(futureKey, future)
 const removeKeys = vi.spyOn(keys, "removeRecordRequestKeys")
 await purgeOtherRecordRequests({ ...owner, userId: "another-synthetic-user" })
 expect(localStorage.getItem(storageKey)).toBeNull()
 expect(localStorage.getItem(futureKey)).toBe(future)
 expect(removeKeys.mock.calls[0][0]).toEqual([])
})
it("does not let a delayed account cleanup delete a key used after that owner returns", async () => {
 await storeRecordRequest(entry)
 const original = keys.removeRecordRequestKeys
 let release!: () => void
 const blocked = new Promise<void>(resolve => { release = resolve })
 vi.spyOn(keys, "removeRecordRequestKeys").mockImplementation(async (...args) => { if (args[0].length) await blocked; return original(...args) })
 const staleCleanup = purgeOtherRecordRequests({ ...owner, userId: "another-synthetic-user" })
 await purgeOtherRecordRequests(owner)
 expect(await storeRecordRequest(entry)).toBe(true)
 release(); await staleCleanup
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 0 })
})
it("accepts another reader's completed migration instead of leaving a false unreadable lock", async () => {
 localStorage.setItem(storageKey, JSON.stringify(entry))
 const results = await Promise.all([readRecordRequests(owner), readRecordRequests(owner)])
 expect(results).toEqual([{ items: [entry], unreadable: 0 }, { items: [entry], unreadable: 0 }])
})
// Another tab can (re)initialize the same owner's marker with a new epoch while a read awaits
// crypto (cold start, legacy marker migration). That is not an account switch.
const swapMarkerDuringDecrypt = (next: () => string, times: number) => {
 const original = keys.recordRequestKey
 let swaps = 0
 return vi.spyOn(keys, "recordRequestKey").mockImplementation(async (...args) => {
  if (swaps < times) { swaps++; localStorage.setItem(markerKey, next()) }
  return original(...args)
 })
}
it("reads again instead of silently dropping a request when the same owner's marker gains a new epoch", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const raw = localStorage.getItem(storageKey)
 const marker = JSON.parse(localStorage.getItem(markerKey)!)
 swapMarkerDuringDecrypt(() => JSON.stringify({ ...marker, epoch: crypto.randomUUID() }), 1)
 expect(await readRecordRequests(owner)).toEqual({ items: [entry], unreadable: 0 })
 expect(localStorage.getItem(storageKey)).toBe(raw)
})
it("withholds and blocks, never empties, when another owner becomes active during a read", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const raw = localStorage.getItem(storageKey)
 swapMarkerDuringDecrypt(() => JSON.stringify({ schema: 2, ownerHash: "0".repeat(64), epoch: crypto.randomUUID() }), 1)
 expect(await readRecordRequests(owner)).toEqual({ items: [], unreadable: 1 })
 expect(localStorage.getItem(storageKey)).toBe(raw)
})
it("stops after bounded re-reads and reports the remaining request when the marker keeps changing", async () => {
 expect(await storeRecordRequest(entry)).toBe(true)
 const marker = JSON.parse(localStorage.getItem(markerKey)!)
 const spy = swapMarkerDuringDecrypt(() => JSON.stringify({ ...marker, epoch: crypto.randomUUID() }), Number.POSITIVE_INFINITY)
 expect(await readRecordRequests(owner)).toEqual({ items: [], unreadable: 1 })
 expect(spy.mock.calls.length).toBeLessThanOrEqual(3)
})
