// Unit tests use real WebCrypto and an in-memory substitute for IndexedDB only.
// The actual IndexedDB transaction/restart path is covered in browser tests.
import { webcrypto } from "node:crypto"
import { beforeEach, vi } from "vitest"
vi.mock("@/lib/domain/record-request-key", () => {
 const keys = new Map<string, CryptoKey>()
 return {
  recordRequestKey: async (owner: string, create: boolean) => {
   let key = keys.get(owner)
   if (!key && create) { const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); key = keys.get(owner) ?? candidate; keys.set(owner, key) }
   if (!key) throw new Error("synthetic missing key")
   return key
  },
  removeRecordRequestKeys: async (owners: string[], canRemove: (owner: string) => boolean) => { for (const owner of owners) if (canRemove(owner)) keys.delete(owner) },
 }
})
beforeEach(() => vi.stubGlobal("crypto", webcrypto))
