import { isRecord } from "./child-sharing"
import { sha256 } from "@noble/hashes/sha2.js"
import { isClientId } from "@/lib/utils/client-id"
import type { SaveOwner } from "./save-attempt"
import { isMedicalRequest } from "./medical"
import { isCustomRequest } from "./custom-records"
import { isValidYmd } from "@/lib/utils/date-jst"
import { recordRequestKey, removeRecordRequestKeys } from "./record-request-key"
export const RECORD_REQUEST_PREFIX="irori:record-request:v1:"
export type RecordRequest={schema:1;id:string;owner:SaveOwner&{childId:string};kind:"medical"|"custom"|"child";payload:Record<string,unknown>}
const key=(r:Pick<RecordRequest,"id"|"owner">)=>`${RECORD_REQUEST_PREFIX}${r.owner.userId}:${r.owner.householdId}:${r.owner.childId}:${r.id}`
/** Reconstruct each supported replay body; never persist an arbitrary object graph. */
function snapshot(v: unknown): RecordRequest | null {
 if (!isRecord(v) || v.schema !== 1 || !isClientId(v.id) || !isRecord(v.owner) || !isRecord(v.payload)) return null
 const o = v.owner, p = v.payload
 if (typeof o.userId !== "string" || !o.userId || typeof o.householdId !== "string" || !o.householdId || !isClientId(o.childId) || p.childId !== o.childId) return null
 let payload: Record<string, unknown>
 if (v.kind === "medical") {
  if (!isMedicalRequest(p)) return null
  const x = p.value
  payload = { id: p.id, childId: p.childId, version: p.version, value: {
   kind: x.kind, title: x.title, dose: x.dose, status: x.status,
   scheduled_date: x.scheduled_date, completed_date: x.completed_date,
   memo: x.memo, remind: x.remind, source_key: x.source_key,
  } }
 } else if (v.kind === "custom") {
  if (!isCustomRequest(p)) return null
  payload = p.operation === "field"
   ? { operation: p.operation, id: p.id, childId: p.childId, version: p.version,
       label: p.label, type: p.type, options: [...p.options], archived: p.archived }
   : { operation: p.operation, id: p.id, childId: p.childId, version: p.version,
       fieldId: p.fieldId, value: p.value, loggedAt: p.loggedAt, memo: p.memo, voided: p.voided }
 } else if (v.kind === "child" && p.id === "" && p.version === "" && p.client_id === v.id && p.client_id === o.childId && p.household_id === o.householdId &&
  typeof p.name === "string" && p.name.trim().length > 0 && p.name.length <= 100 &&
  typeof p.birth_date === "string" && (p.birth_date === "" || isValidYmd(p.birth_date)) &&
  (p.sex === "" || p.sex === "female" || p.sex === "male")) {
  // Keep literal text/empty fields: the server, not persistence, normalizes the form.
  payload = { id: p.id, version: p.version, client_id: p.client_id, household_id: p.household_id,
   name: p.name, birth_date: p.birth_date, sex: p.sex, childId: p.childId }
 } else return null
 return { schema: 1, id: v.id, owner: { userId: o.userId, householdId: o.householdId, childId: o.childId },
  kind: v.kind as RecordRequest["kind"], payload }
}
const ACTIVE_OWNER = "irori:record-request-owner:v1"
const FENCE = "irori:record-request-write:v1:"
const ownerKey = (owner: SaveOwner) => JSON.stringify([owner.userId, owner.householdId])
type SealedRequest = Pick<RecordRequest, "id" | "owner"> & { schema: 2; encoding: "aes-gcm-v1"; iv: string; ciphertext: string }
function metadata(r: RecordRequest) { return { schema: 2 as const, id: r.id, owner: r.owner, encoding: "aes-gcm-v1" as const } }
function encrypted(v: unknown): v is SealedRequest {
 if (!isRecord(v) || v.schema !== 2 || v.encoding !== "aes-gcm-v1" || !isClientId(v.id) || !isRecord(v.owner)) return false
 return typeof v.owner.userId === "string" && !!v.owner.userId && typeof v.owner.householdId === "string" && !!v.owner.householdId && isClientId(v.owner.childId) &&
  typeof v.iv === "string" && v.iv.length === 16 && typeof v.ciphertext === "string" && v.ciphertext.length <= 1_000_000
}
function bytes(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)) }
function base64(value: Uint8Array) { return btoa(Array.from(value, n => String.fromCharCode(n)).join("")) }
function epoch(owner: SaveOwner, switchOwner = false): string | null {
 // A stable pseudonym minimizes duplicate raw IDs; this is not authentication,
 // encryption of every identifier, or protection against same-origin script.
 // Keep owner selection synchronous, before crypto/IDB awaits. Async hashing
 // would let a delayed previous-owner transition reactivate that owner.
 const digest = sha256(new TextEncoder().encode("irori:record-request-owner:v2\0" + ownerKey(owner)))
 const ownerHash = Array.from(digest, n => n.toString(16).padStart(2, "0")).join("")
 const current = localStorage.getItem(ACTIVE_OWNER)
 if (current !== null) {
  const parsed: unknown = JSON.parse(current)
  if (!isRecord(parsed) || !isClientId(parsed.epoch)) return null
  if (parsed.schema === 2 && typeof parsed.ownerHash === "string" && /^[a-f0-9]{64}$/.test(parsed.ownerHash)) {
   if (parsed.ownerHash === ownerHash) return current
   if (!switchOwner) return null
  } else if (parsed.schema === undefined && typeof parsed.owner === "string") {
   // Migrate only the known legacy marker. Unknown control schemas stay intact.
   const previous: unknown = JSON.parse(parsed.owner)
   if (!Array.isArray(previous) || previous.length !== 2 || previous.some(v => typeof v !== "string" || !v)) return null
   if (parsed.owner !== ownerKey(owner) && !switchOwner) return null
  } else return null
 }
 const next = JSON.stringify({ schema: 2, ownerHash, epoch: crypto.randomUUID() })
 localStorage.setItem(ACTIVE_OWNER, next)
 return next
}
function scopedKeys(owner: SaveOwner): string[] {
 const prefix = `${RECORD_REQUEST_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId ? `${owner.childId}:` : ""}`
 return Object.keys(localStorage).filter(k => k.startsWith(prefix))
}
async function unseal(value: unknown, k: string): Promise<RecordRequest | null> {
 if (!encrypted(value) || key(value) !== k) return null
 const wrappingKey = await recordRequestKey(ownerKey(value.owner), false)
 const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(value.iv), additionalData: new TextEncoder().encode(k) }, wrappingKey, bytes(value.ciphertext))
 const restored = snapshot(JSON.parse(new TextDecoder().decode(plain)))
 return restored && key(restored) === k ? restored : null
}
async function seal(value: RecordRequest, previous: string | null, started: string): Promise<boolean> {
 const k = key(value), fence = FENCE + k
 const token = localStorage.getItem(fence) ?? crypto.randomUUID()
 localStorage.setItem(fence, token)
 try {
  const wrappingKey = await recordRequestKey(ownerKey(value.owner), true)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(k) }, wrappingKey, new TextEncoder().encode(JSON.stringify(value)))
  // No await between these checks and the commit: first-write wins across tabs.
  // Removal/account switching cancels a late write instead of resurrecting it.
  if (localStorage.getItem(ACTIVE_OWNER) !== started || localStorage.getItem(fence) !== token || localStorage.getItem(k) !== previous) return false
  const encoded = JSON.stringify({ ...metadata(value), iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) })
  localStorage.setItem(k, encoded)
  return localStorage.getItem(k) === encoded
 } finally { if (localStorage.getItem(fence) === token) localStorage.removeItem(fence) }
}
type ReadResult = { items: RecordRequest[]; unreadable: number }
/** One pass under one owner epoch. null = the active-owner marker changed mid-read. */
async function readOnce(owner: SaveOwner, kind?: RecordRequest["kind"]): Promise<ReadResult | null> {
 const items: RecordRequest[] = []; let unreadable = 0
 try {
  const keys = scopedKeys(owner)
  if (!keys.length) return { items, unreadable }
  const started = epoch(owner)
  if (!started) return { items, unreadable: countRecordRequests(owner) }
  for (const k of keys) {
   const raw = localStorage.getItem(k)
   if (raw === null) continue
   try {
    const parsed: unknown = JSON.parse(raw)
    let value = snapshot(parsed)
    if (value && key(value) === k) {
     // Keep legacy bytes until the key transaction and encrypted write succeed.
     if (!await seal(value, raw, started)) {
      if (localStorage.getItem(ACTIVE_OWNER) !== started) return null
      if (localStorage.getItem(k) === null) continue
      // Another tab may have migrated the same immutable body while we awaited
      // crypto. Verify its completed ciphertext instead of reporting corruption.
      value = await unseal(JSON.parse(localStorage.getItem(k) ?? "null"), k)
     }
    } else value = await unseal(parsed, k)
    // A changed marker is never "nothing pending": start over under the new epoch.
    if (localStorage.getItem(ACTIVE_OWNER) !== started) return null
    // Removed by a confirmed operation (any tab) while we awaited: really gone.
    if (localStorage.getItem(k) === null) continue
    if (!value || key(value) !== k) { unreadable++; continue }
    if (!kind || value.kind === kind) items.push(value)
   } catch { unreadable++ }
  }
  return { items, unreadable }
 } catch { return { items: [], unreadable: 1 } }
}
/** Decrypt/migrate before enabling new operations. Failure never means an empty queue. */
export async function readRecordRequests(owner: SaveOwner, kind?: RecordRequest["kind"]): Promise<ReadResult> {
 // Another tab may (re)initialize the same owner's marker with a new epoch while this read
 // awaits crypto (cold start, legacy marker migration). Read again from the start; an
 // account switch makes the next pass report this owner's requests as unreadable (blocked).
 for (let attempt = 0; attempt < 3; attempt++) {
  const result = await readOnce(owner, kind)
  if (result) return result
 }
 // The marker kept changing: block on what remains rather than report an empty queue.
 return { items: [], unreadable: countRecordRequests(owner) }
}
export async function listRecordRequests(owner: SaveOwner, kind?: RecordRequest["kind"]): Promise<RecordRequest[]> { return (await readRecordRequests(owner, kind)).items }
export async function storeRecordRequest(r: RecordRequest): Promise<boolean> {
 try {
  const value = snapshot(r) // Freeze a fresh primitive-only body before the first await.
  if (!value) return false
  const started = epoch(value.owner)
  if (!started) return false
  const raw = localStorage.getItem(key(value))
  if (raw !== null) return !!await unseal(JSON.parse(raw), key(value))
  return await seal(value, null, started)
 } catch { return false }
}
export function removeRecordRequest(r: RecordRequest) { try { localStorage.removeItem(FENCE + key(r)); localStorage.removeItem(key(r)) } catch {} }
/** Owner cleanup must still recognize older schema-1 bodies that cannot be replayed now. */
function envelopeOwner(v:unknown):SaveOwner|null{
 if(!isRecord(v)||v.schema!==1||!isClientId(v.id)||(v.kind!=="medical"&&v.kind!=="custom"&&v.kind!=="child")||!isRecord(v.owner)||typeof v.owner.userId!=="string"||typeof v.owner.householdId!=="string"||!isClientId(v.owner.childId)||!isRecord(v.payload)||v.payload.childId!==v.owner.childId)return null
 return {userId:v.owner.userId,householdId:v.owner.householdId,childId:v.owner.childId}
}
export async function purgeOtherRecordRequests(owner: SaveOwner) {
 try {
  const removedOwners = new Map<string, SaveOwner>()
  const started = epoch(owner, true)
  if (!started) return
  for (const k of Object.keys(localStorage)) {
   if (!k.startsWith(RECORD_REQUEST_PREFIX)) continue
   let value: unknown; try { value = JSON.parse(localStorage.getItem(k) ?? "null") } catch { continue }
   const other = encrypted(value) ? value.owner : envelopeOwner(value)
   if (other && ownerKey(other) !== ownerKey(owner)) { localStorage.removeItem(FENCE + k); localStorage.removeItem(k); removedOwners.set(ownerKey(other), other) }
  }
  // A future envelope may still need the old owner's wrapping key. Preserve it
  // whenever any opaque request remains in that owner/household namespace.
  const removable = [...removedOwners].filter(([, previous]) => scopedKeys({ userId: previous.userId, householdId: previous.householdId }).length === 0).map(([key]) => key)
  await removeRecordRequestKeys(removable, previousKey => {
   const previous = removedOwners.get(previousKey)
   return localStorage.getItem(ACTIVE_OWNER) === started && !!previous && scopedKeys({ userId: previous.userId, householdId: previous.householdId }).length === 0
  })
 } catch { /* Reads remain owner-scoped even when cleanup is unavailable. */ }
}
/** Unknown envelopes remain intact and block another create in their owner scope. */
export function unreadableRecordCount(owner:SaveOwner):number{
 try{let count=0;const prefix=`${RECORD_REQUEST_PREFIX}${owner.userId}:${owner.householdId}:${owner.childId?`${owner.childId}:`:""}`
  for(const k of Object.keys(localStorage)){if(!k.startsWith(prefix))continue;try{const parsed:unknown=JSON.parse(localStorage.getItem(k)??"null");const value=snapshot(parsed);if(encrypted(parsed)){if(key(parsed)!==k)count++}else if(!value||key(value)!==k)count++}catch{count++}}return count
 }catch{return 1}
}
/** Opaque conservative count for update/logout; never requires a usable decryption key. */
export function countRecordRequests(owner: SaveOwner): number { try { return scopedKeys(owner).length } catch { return 1 } }
